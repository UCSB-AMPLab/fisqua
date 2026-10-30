/**
 * Capture QC — Decisions, Reviewers and the Decisions Endpoint
 *
 * This module deals with capture QC's decisions, in the shape the
 * Captua exchange contract gives them: recording them, choosing who
 * records them, and telling the Captua unit what was decided. Capture
 * QC looks again, in Fisqua, at
 * the openings a unit handed over. Each opening, one Captua record, is
 * approved or rejected for retake with one reason, and a reviewer may
 * correct the rotation of individual images. A rejection of an opening
 * with two images also names the side to retake, as `side`: `left`,
 * `right` or `both`. A volume goes to
 * processing only once every opening is approved (`hold.server.ts`).
 *
 * An image is named by its capture id and its role together. A capture
 * is one trigger of the rig: a dual-camera capture writes a left and a
 * right image under the same capture id, a single-camera capture one
 * image whose role is `single`. A rotation therefore names both, and the
 * two halves of a spread carry their corrections separately. The role
 * comes from the manifest, never from a filename's `_c<n>` suffix:
 * which camera took which side is set per capture.
 *
 * Decisions belong to a delivery, the capture manifest they were made
 * on: the volume's current delivery is the one `registered`, which holds
 * it, whether it came over the link or from a manifest file with the
 * registration command (its `route`); both are decided the same way. A
 * retake arrives as a new manifest that supersedes the older delivery.
 * The new delivery starts with the approvals of the openings whose
 * images it did not change, which its registration carries over
 * (`carry.server.ts`), and with every other opening undecided. The openings
 * of a delivery are its records `in_review` or `approved` in the
 * manifest, the ones that became pages; a decision for any other record
 * is refused.
 *
 * `recordDecisionsAction` is the body of the signed-in route
 * `POST /admin/capture/volumes/:volumeId/decisions`. It reads the
 * volume in the request's tenant (404 `volume_not_found`), then lets
 * through the volume's assigned reviewer, whoever passes the
 * digitization area (`canAdministerArea`: a workspace admin, which a
 * federation steward's grant makes them, a super admin, or the
 * digitization admin) and the federation's stewards (`isFederationSteward`); anyone else gets a
 * bare 403. The JSON body is `{records: [{captuaRecordId, decision,
 * reason?, side?, note?, rotations?: [{captureId, role, quarterTurns}]}],
 * manifestId, expectedRevision?}`, with `role` one of `left`, `right` and `single`,
 * and may decide some openings and leave the rest undecided. Each entry
 * replaces that opening's decision whole, rotations included, so an
 * entry without `rotations` clears the opening's corrections. An entry
 * whose `decision` is null clears the opening's decision and its
 * rotations, and takes no reason, side, note or rotation; the opening
 * is undecided again and leaves the set the unit reads. A decision can
 * be cleared only while the unit has not fetched it: once a fetch of
 * the set answered the decision's revision or a later one
 * (`capture_qc_fetches`), the request is refused whole with 409
 * `decision_sent`, listing the openings in `captua_record_ids`, and the
 * reviewer changes the decision instead.
 * `manifestId` is required and must name the delivery the decisions were
 * made on, which must be the current one: a retake keeps its record ids
 * and brings new images, so decisions made on an earlier handover would
 * otherwise approve images nobody saw (409 `delivery_changed`, naming
 * the current delivery). The checks, in order: the shape (400
 * `invalid_request`, naming each path: a rejection needs a reason, an
 * approval takes none and no side, `other` needs a note, a note is 1 to 2,000
 * characters, quarter-turns are 1 to 3, every rotation has a role, no
 * opening twice and no image, a capture id with its role, twice); a
 * current delivery (409 `no_capture_delivery`); no run started on the
 * volume (409 `run_started`): received, held by no open run and named
 * by no run; every record an opening of the delivery (422
 * `unknown_records`) and every rotated capture id and role one of that
 * record's images in the delivery (422 `unknown_captures`, listing each
 * by record, capture id and role); and a side given exactly for each
 * rejection of an opening with two images in the delivery (400
 * `invalid_request`, naming each `records.<i>.side` that is missing or
 * given on an opening with one image); and no decision being cleared
 * already fetched by the unit (409 `decision_sent`).
 *
 * The write (`buildDecisionStatements`) is one D1 batch, and every
 * statement in it carries the same guard: the delivery is still the
 * volume's registered one and the volume is still in the state just
 * checked. A run that claims the volume, or a retake that supersedes the
 * delivery, between the read and the batch therefore makes every
 * statement a no-op, and the run or the retake wins. The batch creates
 * the delivery's set with its opening count if it has none, deletes the
 * rotations of the openings being decided and the decisions of those
 * being cleared, writes the other decisions and their rotations,
 * recounts the set (decided, approved, rejected, the bytes
 * of its notes) and gives it its state, a new `decisionsId`, `decidedAt`
 * and `revision`, and this request's write id. The batch's last
 * statement reads the set back by that write id, inside the same
 * transaction, so the outcome is settled by the batch itself and a
 * concurrent writer that commits right after cannot change the answer.
 * The answer is 200 `{decisionsId, revision}` when that read finds the
 * set; otherwise the guard failed and the answer says why (`run_started`,
 * then `decision_sent` when the unit fetched a cleared decision after the
 * check, then `delivery_changed` or `revision_changed`). A batch that
 * clears openings carries their record ids in its guard, which checks
 * each one's decision as it stands when the batch runs against the
 * unit's fetches. A decision written by another request after the
 * check, and fetched before the batch, therefore makes every statement
 * a no-op, even on an opening that was undecided at the check.
 *
 * `expectedRevision` makes the write a compare-and-set. It is the set's
 * revision the writer last saw, 0 when the delivery had no set yet, and
 * every statement's guard then also requires the set to be still at
 * that revision (still absent for 0), or to carry this batch's own write
 * id. A write made on an older revision, such as the late commit of a
 * request whose connection was lost and whose retry already landed,
 * writes nothing and answers 409 `revision_changed` with the set's
 * current `revision`, so the writer re-reads and sends again. Two people
 * deciding on one volume at once therefore refuse each other's writes
 * and reconcile. Without `expectedRevision` no revision is checked. A set whose notes would pass 1,000,000 bytes is
 * refused whole by a CHECK, and the answer is 413
 * `decisions_too_large`. Payloads are bound as JSON values of at most
 * `PAYLOAD_CHUNK_BYTES`, so every statement stays within D1's 100 bound
 * parameters and 100 KB, and a volume of thousands of openings is
 * decided in one batch. A caller that writes the statements out as SQL
 * text, where a value counts towards the statement's size and each
 * apostrophe is doubled, passes its own `payload` budget.
 *
 * `assignReviewerAction` is the body of
 * `POST /admin/capture/volumes/:volumeId/reviewer`, `{reviewerId}`, or
 * null to clear it. Only the tenant's admins and the federation's
 * stewards may assign. The reviewer must be a user of the tenant or hold
 * a membership in its federation (422 `reviewer_not_eligible`), and the
 * volume must have come from a capture delivery. One reviewer per
 * volume; the assignment holds across retakes. `readReviewerId` (the
 * volume's assigned reviewer) and `isQcManager` (the tenant's admins
 * and the federation's stewards) are exported so that the review tiles'
 * download authorisation (`review-access.server.ts`) lets through
 * exactly the people these actions do.
 *
 * `handleVolumeDecisions` answers the unit's
 * `GET /api/capture/v1/volumes/<ref>/decisions` with the current
 * delivery's set, in the Captua exchange contract's shape:
 * `{decisionsId, decidedAt, manifestId, records: [{captuaRecordId,
 * decision, reason, side, note, decidedBy, decidedAt, rotations:
 * [{captureId, role, quarterTurns}]}]}`, with
 * `reason` only for a rejection, `side` only for a rejection that names
 * one, and `note` only where there is one. Every write gives the set a
 * new `decisionsId`, so a changed side or a cleared decision changes it
 * as any other change does. A set whose decisions were all cleared is
 * still the set, answered with `records: []`, so the unit learns that
 * nothing is decided any more.
 * `decidedBy` is the decider's display name as it was when they decided,
 * or "Fisqua reviewer" for a user without one; never an email address.
 * It authenticates as the link's other calls do (`authenticate`: the
 * tenant from the host, the scanner's token, the rate limit). A ref with
 * no current delivery, or whose current delivery has no decision set,
 * answers 404 with the problem `no-decisions`. The set, its decisions
 * and its rotations are read in one batch, so the answer is one
 * consistent state of the set. The same batch records that the unit
 * read that set (`capture_qc_fetches`): its `decisionsId`, the set's
 * revision, and when the unit first and last read it. Each decision
 * carries the revision of the write that last wrote it
 * (`set_revision`), so a rejection is known to have reached the unit
 * once a fetch answered that revision or a later one. The record is
 * written whenever the delivery has a set, which is when the answer is
 * the set, and it changes nothing in the answer. The Retakes screen
 * reads it to tell a rejection the unit has from one it has not yet
 * fetched. Its size is bounded by what feeds it:
 * one record per opening of a manifest of at most 5 MiB, at most two
 * rotations each (an opening is one single image or a left and a right),
 * ids and names of at most 256 characters, and notes of at most
 * 1,000,000 bytes together.
 *
 * @version v0.8.0
 */

import { and, asc, eq, or, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";
import {
  captureDeliveries,
  captureImages,
  captureQcDecisions,
  captureQcFetches,
  captureQcReviewers,
  captureQcRotations,
  captureQcSets,
  pipelineVolumes,
  users,
} from "../../db/schema";
import type { Tenant, User } from "../../context";
import { isFederationSteward } from "../federation.server";
import { canAdministerArea } from "../user-access.server";
import { rawBatchItem, readCappedBody } from "../pipeline/callback.server";
import { CAPTURE_IMAGE_ROLES, CAPTURE_QC_DECISIONS, CAPTURE_QC_REASONS, CAPTURE_QC_SIDES } from "../validation/enums";
import { authenticate, MAX_NOTE_CHARS, unpackJson, volumeStillOpen, type CaptureLinkDeps } from "./link.server";
import { isOpening, MAX_FIELD_CHARS, type CaptureProblem } from "./manifest";

/** The largest decisions request accepted, in bytes. */
export const MAX_DECISIONS_BODY_BYTES = 4 * 1024 * 1024;
/** The most openings one request may decide. */
export const MAX_DECISIONS_PER_REQUEST = 10_000;
/** The bytes of JSON one statement binds as a single value. */
export const PAYLOAD_CHUNK_BYTES = 60_000;
/** The bytes every note of a set may take together (a CHECK in 0094). */
export const MAX_SET_NOTES_BYTES = 1_000_000;
/** Ids a refusal lists before it counts the rest. */
const LISTED_IDS = 100;

export interface CaptureQcDeps {
  db: DrizzleD1Database<any>;
  now: () => number;
  newId: () => string;
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function refusal(status: number, error: string, detail: Record<string, unknown> = {}): Response {
  return json(status, { error, ...detail });
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;
const chars = (text: string) => Array.from(text).length;

// ---------------------------------------------------------------------------
// Reads shared by the actions
// ---------------------------------------------------------------------------

interface VolumeRow {
  id: string;
  state: string;
}

async function readVolume(db: DrizzleD1Database<any>, tenantId: string, volumeId: string): Promise<VolumeRow | undefined> {
  return db
    .select({ id: pipelineVolumes.id, state: pipelineVolumes.state })
    .from(pipelineVolumes)
    .where(and(eq(pipelineVolumes.tenantId, tenantId), eq(pipelineVolumes.id, volumeId)))
    .get();
}

/** The volume's current delivery: the one `registered`, which holds it. */
async function readCurrentDelivery(
  db: DrizzleD1Database<any>,
  tenantId: string,
  volumeId: string,
): Promise<{ id: string; records: string | null } | undefined> {
  return db
    .select({ id: captureDeliveries.id, records: captureDeliveries.records })
    .from(captureDeliveries)
    .where(
      and(
        eq(captureDeliveries.tenantId, tenantId),
        eq(captureDeliveries.pipelineVolumeId, volumeId),
        eq(captureDeliveries.state, "registered"),
      ),
    )
    .get();
}

export async function readReviewerId(db: DrizzleD1Database<any>, tenantId: string, volumeId: string): Promise<string | null> {
  const row = await db
    .select({ reviewerId: captureQcReviewers.reviewerId })
    .from(captureQcReviewers)
    .where(and(eq(captureQcReviewers.tenantId, tenantId), eq(captureQcReviewers.pipelineVolumeId, volumeId)))
    .get();
  return row?.reviewerId ?? null;
}

/** Whoever passes the digitization area, and the federation's stewards. */
export async function isQcManager(db: DrizzleD1Database<any>, tenant: Tenant, user: User): Promise<boolean> {
  return canAdministerArea(user, "digitization") || (await isFederationSteward(db, user, tenant));
}

/** Whether no run has started on the volume, by the guard the write carries. */
async function stillOpen(db: DrizzleD1Database<any>, tenantId: string, volumeId: string, now: number): Promise<boolean> {
  const row = await db
    .select({ id: pipelineVolumes.id })
    .from(pipelineVolumes)
    .where(and(eq(pipelineVolumes.tenantId, tenantId), eq(pipelineVolumes.id, volumeId), volumeStillOpen(tenantId, volumeId, now)))
    .get();
  return row !== undefined;
}

async function readJsonBody(request: Request, limit: number): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const bytes = await readCappedBody(request, limit);
  if (bytes === null) return { ok: false, response: refusal(413, "too_large") };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false, response: refusal(400, "invalid_request", { detail: "malformed_json" }) };
  }
}

function pathsOf(issues: z.core.$ZodIssue[]): string {
  return [...new Set(issues.map((i) => i.path.join(".") || "(body)"))].slice(0, LISTED_IDS).join(", ");
}

// ---------------------------------------------------------------------------
// Recording decisions
// ---------------------------------------------------------------------------

const rotationSchema = z
  .object({
    captureId: z.string().min(1).max(MAX_FIELD_CHARS),
    role: z.enum(CAPTURE_IMAGE_ROLES),
    quarterTurns: z.number().int().min(1).max(3),
  })
  .strict();

const decisionSchema = z
  .object({
    captuaRecordId: z.number().int(),
    // Null clears the opening's decision.
    decision: z.enum(CAPTURE_QC_DECISIONS).nullable(),
    reason: z.enum(CAPTURE_QC_REASONS).optional(),
    side: z.enum(CAPTURE_QC_SIDES).optional(),
    note: z.string().optional(),
    rotations: z.array(rotationSchema).max(2).optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.decision === "rejected" && d.reason === undefined) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "a rejection needs a reason" });
    }
    if (d.decision === "approved" && d.reason !== undefined) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "an approval takes no reason" });
    }
    if (d.decision === "approved" && d.side !== undefined) {
      ctx.addIssue({ code: "custom", path: ["side"], message: "an approval takes no side" });
    }
    if (d.decision === null) {
      for (const key of ["reason", "side", "note"] as const) {
        if (d[key] !== undefined) ctx.addIssue({ code: "custom", path: [key], message: `a cleared decision takes no ${key}` });
      }
      if ((d.rotations ?? []).length > 0) {
        ctx.addIssue({ code: "custom", path: ["rotations"], message: "a cleared decision takes no rotations" });
      }
    }
    if (d.note !== undefined && (chars(d.note) < 1 || chars(d.note) > MAX_NOTE_CHARS)) {
      ctx.addIssue({ code: "custom", path: ["note"], message: `a note is 1 to ${MAX_NOTE_CHARS} characters` });
    }
    if (d.reason === "other" && d.note === undefined) {
      ctx.addIssue({ code: "custom", path: ["note"], message: "a rejection for other needs a note" });
    }
    // An image is its capture id and its role together.
    const captures = (d.rotations ?? []).map((r) => `${r.captureId}\u0000${r.role}`);
    if (new Set(captures).size !== captures.length) {
      ctx.addIssue({ code: "custom", path: ["rotations"], message: "an image is rotated twice" });
    }
  });

export const decisionsBodySchema = z
  .object({
    manifestId: z.string().min(1).max(MAX_FIELD_CHARS),
    records: z.array(decisionSchema).min(1).max(MAX_DECISIONS_PER_REQUEST),
    expectedRevision: z.number().int().min(0).optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    const seen = new Set<number>();
    b.records.forEach((r, i) => {
      if (seen.has(r.captuaRecordId)) {
        ctx.addIssue({ code: "custom", path: ["records", i, "captuaRecordId"], message: "an opening is decided twice" });
      }
      seen.add(r.captuaRecordId);
    });
  });

export type DecisionsBody = z.infer<typeof decisionsBodySchema>;

/** One opening's decision, each rotated image named by capture id and role, as the batch writes it. */
export interface PlannedDecision {
  captuaRecordId: number;
  /** Null clears the opening's decision. */
  decision: (typeof CAPTURE_QC_DECISIONS)[number] | null;
  reason: (typeof CAPTURE_QC_REASONS)[number] | null;
  /** The side to retake, for a rejection of an opening with two images; null otherwise. */
  side: (typeof CAPTURE_QC_SIDES)[number] | null;
  note: string | null;
  rotations: Array<{ captureId: string; role: string; quarterTurns: number }>;
}

export interface DecisionWrite {
  tenantId: string;
  volumeId: string;
  deliveryId: string;
  openingCount: number;
  decisions: PlannedDecision[];
  userId: string;
  userName: string;
  decisionsId: string;
  writeId: string;
  now: number;
  /** The set's revision the writer last saw (0: no set yet); absent, no revision is checked. */
  expectedRevision?: number;
  /** The openings being cleared; absent or empty when none is. */
  clears?: number[];
  /** How the payloads are measured and capped; absent, `BOUND_PAYLOAD`. */
  payload?: PayloadBudget;
}

/**
 * How a statement's JSON payloads are measured and capped: `cost` gives
 * an item's JSON text its size where the payload ends up, and a payload
 * holds items up to `limit` of it. Bound as a value, as the screen binds
 * it, an item costs its UTF-8 bytes (`BOUND_PAYLOAD`). A caller that
 * writes the payload into SQL text measures it as written there.
 */
export interface PayloadBudget {
  limit: number;
  cost: (json: string) => number;
}

export const BOUND_PAYLOAD: PayloadBudget = { limit: PAYLOAD_CHUNK_BYTES, cost: (text) => byteLength(text) };

/** JSON arrays of `items`, each within `budget` (an item never splits). */
export function payloadChunks(items: unknown[], budget: PayloadBudget = BOUND_PAYLOAD): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let size = 2;
  for (const item of items) {
    const text = JSON.stringify(item);
    const cost = budget.cost(text) + 1;
    if (current.length > 0 && size + cost > budget.limit) {
      out.push(`[${current.join(",")}]`);
      current = [];
      size = 2;
    }
    current.push(text);
    size += cost;
  }
  if (current.length > 0) out.push(`[${current.join(",")}]`);
  return out;
}

/**
 * The guard every statement of a decisions batch carries: the delivery
 * is still the volume's registered one, and no run has started on the
 * volume. With an expected revision, the set is also still at that
 * revision (no set at all for 0), or already carries this batch's own
 * write id, which only an earlier statement of the same batch can have
 * given it. With `clears`, the openings the batch clears, no decision
 * the delivery now holds for any of them has been fetched by the unit: no
 * fetch answered its revision or a later one. The decisions are read
 * inside the statement, so a decision written after the action's own
 * check is judged too.
 */
function decisionGuard(
  t: string,
  volumeId: string,
  deliveryId: string,
  now: number,
  revision?: { expected: number; writeId: string },
  clears?: number[],
  budget: PayloadBudget = BOUND_PAYLOAD,
): SQL {
  const open = sql`EXISTS (SELECT 1 FROM capture_deliveries gd WHERE gd.tenant_id = ${t} AND gd.id = ${deliveryId}
      AND gd.pipeline_volume_id = ${volumeId} AND gd.state = 'registered')
    AND ${volumeStillOpen(t, volumeId, now)}`;
  // No decision held for an opening being cleared has reached the unit.
  const fetchedClears = payloadChunks(clears ?? [], budget).map(
    (ids) => sql`NOT EXISTS (SELECT 1 FROM capture_qc_decisions gc JOIN capture_qc_fetches gf
        ON gf.tenant_id = gc.tenant_id AND gf.delivery_id = gc.delivery_id AND gf.set_revision >= gc.set_revision
      WHERE gc.tenant_id = ${t} AND gc.delivery_id = ${deliveryId}
        AND gc.captua_record_id IN (SELECT value FROM json_each(${ids})))`,
  );
  const base = fetchedClears.length === 0 ? open : sql`${open} AND ${sql.join(fetchedClears, sql` AND `)}`;
  if (revision === undefined) return base;
  const seen =
    revision.expected === 0
      ? sql`NOT EXISTS (SELECT 1 FROM capture_qc_sets rs WHERE rs.tenant_id = ${t} AND rs.delivery_id = ${deliveryId})`
      : sql`EXISTS (SELECT 1 FROM capture_qc_sets rs WHERE rs.tenant_id = ${t} AND rs.delivery_id = ${deliveryId}
          AND rs.revision = ${revision.expected})`;
  return sql`${base} AND (${seen} OR EXISTS (SELECT 1 FROM capture_qc_sets ws WHERE ws.tenant_id = ${t}
      AND ws.delivery_id = ${deliveryId} AND ws.write_id = ${revision.writeId}))`;
}

/** The state a set's counts give it. */
const SET_STATE = sql.raw(
  `CASE WHEN rejected_count > 0 THEN 'retakes_requested' WHEN approved_count = opening_count THEN 'approved' ELSE 'in_capture_qc' END`,
);

/** The statements of a decisions write, in order. Pure: it builds, it does not run. */
export function buildDecisionStatements(db: DrizzleD1Database<any>, w: DecisionWrite): BatchItem<"sqlite">[] {
  const { tenantId: t, volumeId, deliveryId: d, now } = w;
  const revision = w.expectedRevision === undefined ? undefined : { expected: w.expectedRevision, writeId: w.writeId };
  const budget = w.payload ?? BOUND_PAYLOAD;
  const ok = () => decisionGuard(t, volumeId, d, now, revision, w.clears, budget);
  const out: BatchItem<"sqlite">[] = [];

  // a. The delivery's set, with its first decision.
  out.push(
    rawBatchItem(
      db,
      sql`INSERT INTO capture_qc_sets (tenant_id, delivery_id, pipeline_volume_id, decisions_id, decided_at, revision,
          opening_count, decided_count, approved_count, rejected_count, notes_bytes, state, state_entered_at, write_id)
        SELECT ${t}, ${d}, ${volumeId}, ${w.decisionsId}, ${now}, 1, ${w.openingCount}, 0, 0, 0, 0, 'in_capture_qc', ${now}, ${w.writeId}
        WHERE ${ok()}
          AND NOT EXISTS (SELECT 1 FROM capture_qc_sets es WHERE es.tenant_id = ${t} AND es.delivery_id = ${d})`,
    ),
  );

  // b. The rotations of the openings decided or cleared now: each entry
  // replaces the opening's corrections whole.
  for (const ids of payloadChunks(w.decisions.map((x) => x.captuaRecordId), budget)) {
    out.push(
      rawBatchItem(
        db,
        sql`DELETE FROM capture_qc_rotations WHERE tenant_id = ${t} AND delivery_id = ${d}
          AND captua_record_id IN (SELECT value FROM json_each(${ids}))
          AND ${ok()}`,
      ),
    );
  }

  // b2. The decisions of the openings cleared now.
  const cleared = w.decisions.filter((x) => x.decision === null);
  for (const ids of payloadChunks(cleared.map((x) => x.captuaRecordId), budget)) {
    out.push(
      rawBatchItem(
        db,
        sql`DELETE FROM capture_qc_decisions WHERE tenant_id = ${t} AND delivery_id = ${d}
          AND captua_record_id IN (SELECT value FROM json_each(${ids}))
          AND ${ok()}`,
      ),
    );
  }

  // c. The decisions, replacing any earlier one for the same opening, each
  // stamped with the revision step f gives the set: 1 for a set this
  // batch created, otherwise one past the revision it holds. The batch
  // is one transaction, so revisions follow the order writes commit in.
  const rows = w.decisions
    .filter((x) => x.decision !== null)
    .map((x) => ({ r: x.captuaRecordId, d: x.decision, re: x.reason, s: x.side, n: x.note }));
  for (const chunk of payloadChunks(rows, budget)) {
    out.push(
      rawBatchItem(
        db,
        sql`INSERT INTO capture_qc_decisions (tenant_id, delivery_id, captua_record_id, decision, reason, side, note,
            decided_by, decided_by_name, decided_at, set_revision)
          SELECT s.tenant_id, s.delivery_id, json_extract(j.value, '$.r'), json_extract(j.value, '$.d'),
            json_extract(j.value, '$.re'), json_extract(j.value, '$.s'), json_extract(j.value, '$.n'),
            ${w.userId}, ${w.userName}, ${now},
            CASE WHEN s.write_id = ${w.writeId} THEN s.revision ELSE s.revision + 1 END
          FROM json_each(${chunk}) j
          JOIN capture_qc_sets s ON s.tenant_id = ${t} AND s.delivery_id = ${d}
          WHERE ${ok()}
          ON CONFLICT (tenant_id, delivery_id, captua_record_id) DO UPDATE SET decision = excluded.decision,
            reason = excluded.reason, side = excluded.side, note = excluded.note, decided_by = excluded.decided_by,
            decided_by_name = excluded.decided_by_name, decided_at = excluded.decided_at,
            set_revision = excluded.set_revision`,
      ),
    );
  }

  // d. Their rotations.
  const rotations = w.decisions.flatMap((x) =>
    x.rotations.map((r) => ({ r: x.captuaRecordId, c: r.captureId, ro: r.role, q: r.quarterTurns })),
  );
  for (const chunk of payloadChunks(rotations, budget)) {
    out.push(
      rawBatchItem(
        db,
        sql`INSERT INTO capture_qc_rotations (tenant_id, delivery_id, captua_record_id, capture_id, role, quarter_turns)
          SELECT s.tenant_id, s.delivery_id, json_extract(j.value, '$.r'), json_extract(j.value, '$.c'),
            json_extract(j.value, '$.ro'), json_extract(j.value, '$.q')
          FROM json_each(${chunk}) j
          JOIN capture_qc_sets s ON s.tenant_id = ${t} AND s.delivery_id = ${d}
          WHERE ${ok()}`,
      ),
    );
  }

  // e. The set's counts, from its decisions. A set past its notes cap
  // fails its CHECK here, and the whole batch with it.
  out.push(
    rawBatchItem(
      db,
      sql`UPDATE capture_qc_sets SET
          decided_count = (SELECT COUNT(*) FROM capture_qc_decisions x1 WHERE x1.tenant_id = ${t} AND x1.delivery_id = ${d}),
          approved_count = (SELECT COUNT(*) FROM capture_qc_decisions x2 WHERE x2.tenant_id = ${t} AND x2.delivery_id = ${d}
            AND x2.decision = 'approved'),
          rejected_count = (SELECT COUNT(*) FROM capture_qc_decisions x3 WHERE x3.tenant_id = ${t} AND x3.delivery_id = ${d}
            AND x3.decision = 'rejected'),
          notes_bytes = (SELECT COALESCE(SUM(length(CAST(x4.note AS BLOB))), 0) FROM capture_qc_decisions x4
            WHERE x4.tenant_id = ${t} AND x4.delivery_id = ${d})
        WHERE tenant_id = ${t} AND delivery_id = ${d} AND ${ok()}`,
    ),
  );

  // f. Its state, from the counts, and the new set's names. A set this
  // batch created keeps revision 1.
  out.push(
    rawBatchItem(
      db,
      sql`UPDATE capture_qc_sets SET
          state = ${SET_STATE},
          state_entered_at = CASE WHEN state = ${SET_STATE} THEN state_entered_at ELSE ${now} END,
          decisions_id = ${w.decisionsId}, decided_at = ${now},
          revision = CASE WHEN write_id = ${w.writeId} THEN revision ELSE revision + 1 END,
          write_id = ${w.writeId}
        WHERE tenant_id = ${t} AND delivery_id = ${d} AND ${ok()}`,
    ),
  );

  // g. The outcome, read inside the batch: the set carries this request's
  // write id only if every statement above passed its guard. A later
  // writer cannot change what this returns.
  out.push(
    db
      .select({ decisionsId: captureQcSets.decisionsId, revision: captureQcSets.revision })
      .from(captureQcSets)
      .where(
        and(
          eq(captureQcSets.tenantId, t),
          eq(captureQcSets.deliveryId, d),
          eq(captureQcSets.writeId, w.writeId),
        ),
      ) as unknown as BatchItem<"sqlite">,
  );
  return out;
}

/** The set revision of each decision among `ids` that the delivery holds; an undecided opening is absent. */
async function readClearedRevisions(
  db: DrizzleD1Database<any>,
  tenantId: string,
  deliveryId: string,
  ids: number[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const chunk of payloadChunks(ids)) {
    const rows = (await db
      .select({ captuaRecordId: captureQcDecisions.captuaRecordId, setRevision: captureQcDecisions.setRevision })
      .from(captureQcDecisions)
      .where(
        and(
          eq(captureQcDecisions.tenantId, tenantId),
          eq(captureQcDecisions.deliveryId, deliveryId),
          sql`${captureQcDecisions.captuaRecordId} IN (SELECT value FROM json_each(${chunk}))`,
        ),
      )
      .all()) as Array<{ captuaRecordId: number; setRevision: number }>;
    for (const r of rows) out.set(r.captuaRecordId, r.setRevision);
  }
  return out;
}

/** Of the decisions in `revisions`, those a fetch by the unit has carried, in record order. */
async function sentDecisions(
  db: DrizzleD1Database<any>,
  tenantId: string,
  deliveryId: string,
  revisions: Map<number, number>,
): Promise<number[]> {
  if (revisions.size === 0) return [];
  const row = await db
    .select({ fetched: sql<number | null>`MAX(${captureQcFetches.setRevision})` })
    .from(captureQcFetches)
    .where(and(eq(captureQcFetches.tenantId, tenantId), eq(captureQcFetches.deliveryId, deliveryId)))
    .get();
  const fetched = row?.fetched ?? null;
  if (fetched === null) return [];
  return [...revisions]
    .filter(([, revision]) => revision <= fetched)
    .map(([id]) => id)
    .sort((a, b) => a - b);
}

function decisionSent(ids: number[]): Response {
  return refusal(409, "decision_sent", {
    captua_record_ids: ids.slice(0, LISTED_IDS),
    ...(ids.length > LISTED_IDS ? { omitted: ids.length - LISTED_IDS } : {}),
  });
}

interface DeliveryRecord {
  captuaRecordId: number;
  status: string;
}

/** The delivery's openings: its records `in_review` or `approved`. */
export function openingsOf(records: DeliveryRecord[]): Set<number> {
  return new Set(records.filter((r) => isOpening(r.status)).map((r) => r.captuaRecordId));
}

/** What the unit is told for a decider without a name. */
export const UNNAMED_REVIEWER = "Fisqua reviewer";

/** A display name for the unit: the user's name, at most 256 characters, never their email. */
export function displayName(user: Pick<User, "name">): string {
  const name = (user.name ?? "").trim() || UNNAMED_REVIEWER;
  return Array.from(name).slice(0, MAX_FIELD_CHARS).join("");
}

export async function recordDecisionsAction(
  deps: CaptureQcDeps,
  request: Request,
  volumeId: string,
  tenant: Tenant,
  user: User,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const { db } = deps;
  const t = tenant.id;

  // The volume, then who may decide on it.
  const volume = await readVolume(db, t, volumeId);
  if (!volume) return refusal(404, "volume_not_found");
  const reviewerId = await readReviewerId(db, t, volumeId);
  if (reviewerId !== user.id && !(await isQcManager(db, tenant, user))) {
    throw new Response(null, { status: 403 });
  }

  // The body.
  const read = await readJsonBody(request, MAX_DECISIONS_BODY_BYTES);
  if (!read.ok) return read.response;
  const parsed = decisionsBodySchema.safeParse(read.value);
  if (!parsed.success) return refusal(400, "invalid_request", { detail: pathsOf(parsed.error.issues) });
  const body = parsed.data;

  // The current delivery, and no run started.
  const delivery = await readCurrentDelivery(db, t, volumeId);
  if (!delivery || delivery.records === null) return refusal(409, "no_capture_delivery", { volume_id: volumeId });
  if (body.manifestId !== delivery.id) {
    return refusal(409, "delivery_changed", { manifest_id: delivery.id });
  }
  const now = deps.now();
  if (!(await stillOpen(db, t, volumeId, now))) return refusal(409, "run_started", { volume_id: volumeId });

  // Every record an opening, every rotated image one of its images: an
  // image is its capture id and its role, since both images of a spread
  // carry the capture id of the one trigger that wrote them.
  const openings = openingsOf(JSON.parse(await unpackJson(delivery.records)) as DeliveryRecord[]);
  const unknown = body.records.map((r) => r.captuaRecordId).filter((id) => !openings.has(id));
  if (unknown.length > 0) {
    return refusal(422, "unknown_records", {
      captua_record_ids: unknown.slice(0, LISTED_IDS),
      ...(unknown.length > LISTED_IDS ? { omitted: unknown.length - LISTED_IDS } : {}),
    });
  }
  const images = await db
    .select({
      captuaRecordId: captureImages.captuaRecordId,
      captureId: captureImages.captureId,
      role: captureImages.role,
    })
    .from(captureImages)
    .where(and(eq(captureImages.tenantId, t), eq(captureImages.deliveryId, delivery.id)))
    .all();
  const imageKey = (record: number, captureId: string, role: string) => `${record}\u0000${captureId}\u0000${role}`;
  const known = new Set(images.map((i) => imageKey(i.captuaRecordId, i.captureId, i.role)));
  const imageCount = new Map<number, number>();
  for (const i of images) imageCount.set(i.captuaRecordId, (imageCount.get(i.captuaRecordId) ?? 0) + 1);
  const unknownCaptures: Array<{ captua_record_id: number; capture_id: string; role: string }> = [];
  const decisions: PlannedDecision[] = body.records.map((r) => ({
    captuaRecordId: r.captuaRecordId,
    decision: r.decision,
    reason: r.reason ?? null,
    side: r.side ?? null,
    note: r.note ?? null,
    rotations: (r.rotations ?? []).map((rot) => {
      if (!known.has(imageKey(r.captuaRecordId, rot.captureId, rot.role))) {
        unknownCaptures.push({ captua_record_id: r.captuaRecordId, capture_id: rot.captureId, role: rot.role });
      }
      return { captureId: rot.captureId, role: rot.role, quarterTurns: rot.quarterTurns };
    }),
  }));
  if (unknownCaptures.length > 0) {
    return refusal(422, "unknown_captures", {
      captures: unknownCaptures.slice(0, LISTED_IDS),
      ...(unknownCaptures.length > LISTED_IDS ? { omitted: unknownCaptures.length - LISTED_IDS } : {}),
    });
  }

  // A side for every rejection of an opening with two images, and for no
  // other: an opening with one image has nothing to choose between.
  const sidePaths = body.records.flatMap((r, i) => {
    if (r.decision !== "rejected") return [];
    const pair = (imageCount.get(r.captuaRecordId) ?? 0) > 1;
    return pair === (r.side !== undefined) ? [] : [`records.${i}.side`];
  });
  if (sidePaths.length > 0) {
    return refusal(400, "invalid_request", { detail: sidePaths.slice(0, LISTED_IDS).join(", ") });
  }

  // A decision can be cleared only while the unit has not fetched it: no
  // fetch of the set answered the decision's revision or a later one.
  const clearing = body.records.filter((r) => r.decision === null).map((r) => r.captuaRecordId);
  const clearedRevisions = await readClearedRevisions(db, t, delivery.id, clearing);
  const sent = await sentDecisions(db, t, delivery.id, clearedRevisions);
  if (sent.length > 0) return decisionSent(sent);

  // The write.
  const writeId = deps.newId();
  const decisionsId = deps.newId();
  const statements = buildDecisionStatements(db, {
    tenantId: t,
    volumeId,
    deliveryId: delivery.id,
    openingCount: openings.size,
    decisions,
    userId: user.id,
    userName: displayName(user),
    decisionsId,
    writeId,
    now,
    expectedRevision: body.expectedRevision,
    clears: clearing,
  });
  let results: unknown[];
  try {
    results = await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  } catch (err) {
    if (err instanceof Error && /notes_bytes/.test(err.message)) {
      return refusal(413, "decisions_too_large", { max_notes_bytes: MAX_SET_NOTES_BYTES });
    }
    throw err;
  }

  // The batch's own read-back: found only if this request's writes landed.
  const landed = results[results.length - 1] as Array<{ decisionsId: string; revision: number }>;
  if (landed.length === 1) return json(200, { decisionsId: landed[0].decisionsId, revision: landed[0].revision });

  // The guard did not hold: a run started, a newer delivery replaced this
  // one, or (with an expected revision) another write moved the set on.
  if (!(await stillOpen(db, t, volumeId, deps.now()))) return refusal(409, "run_started", { volume_id: volumeId });
  // Read again: another request may have decided an opening being cleared.
  const fetchedSince = await sentDecisions(db, t, delivery.id, await readClearedRevisions(db, t, delivery.id, clearing));
  if (fetchedSince.length > 0) return decisionSent(fetchedSince);
  const current = await readCurrentDelivery(db, t, volumeId);
  if (body.expectedRevision !== undefined && current?.id === delivery.id) {
    const set = await db
      .select({ revision: captureQcSets.revision })
      .from(captureQcSets)
      .where(and(eq(captureQcSets.tenantId, t), eq(captureQcSets.deliveryId, delivery.id)))
      .get();
    return refusal(409, "revision_changed", { revision: set?.revision ?? 0 });
  }
  return refusal(409, "delivery_changed", { manifest_id: current?.id ?? null });
}

// ---------------------------------------------------------------------------
// Assigning the reviewer
// ---------------------------------------------------------------------------

export const reviewerBodySchema = z.object({ reviewerId: z.string().min(1).max(MAX_FIELD_CHARS).nullable() }).strict();

export async function assignReviewerAction(
  deps: CaptureQcDeps,
  request: Request,
  volumeId: string,
  tenant: Tenant,
  user: User,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const { db } = deps;
  const t = tenant.id;
  if (!(await isQcManager(db, tenant, user))) throw new Response(null, { status: 403 });

  const volume = await readVolume(db, t, volumeId);
  if (!volume) return refusal(404, "volume_not_found");
  const read = await readJsonBody(request, 4096);
  if (!read.ok) return read.response;
  const parsed = reviewerBodySchema.safeParse(read.value);
  if (!parsed.success) return refusal(400, "invalid_request", { detail: pathsOf(parsed.error.issues) });
  const { reviewerId } = parsed.data;

  if (!(await readCurrentDelivery(db, t, volumeId))) return refusal(409, "no_capture_delivery", { volume_id: volumeId });

  if (reviewerId === null) {
    await db
      .delete(captureQcReviewers)
      .where(and(eq(captureQcReviewers.tenantId, t), eq(captureQcReviewers.pipelineVolumeId, volumeId)));
    return json(200, { reviewerId: null });
  }

  // A user of the tenant, or one with a membership in its federation.
  const memberOfFederation =
    tenant.federationId === null || tenant.federationId === undefined
      ? sql`0`
      : sql`EXISTS (SELECT 1 FROM federation_memberships m WHERE m.user_id = ${users.id} AND m.federation_id = ${tenant.federationId})`;
  const eligible = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, reviewerId), or(eq(users.tenantId, t), memberOfFederation)))
    .get();
  if (!eligible) return refusal(422, "reviewer_not_eligible", { reviewer_id: reviewerId });

  const now = deps.now();
  await db
    .insert(captureQcReviewers)
    .values({ tenantId: t, pipelineVolumeId: volumeId, reviewerId, assignedBy: user.id, assignedAt: now })
    .onConflictDoUpdate({
      target: [captureQcReviewers.tenantId, captureQcReviewers.pipelineVolumeId],
      set: { reviewerId, assignedBy: user.id, assignedAt: now },
    });
  return json(200, { reviewerId });
}

// ---------------------------------------------------------------------------
// The decisions endpoint
// ---------------------------------------------------------------------------

export interface DecisionsAnswer {
  decisionsId: string;
  decidedAt: string;
  manifestId: string;
  records: Array<{
    captuaRecordId: number;
    decision: string;
    reason?: string;
    side?: string;
    note?: string;
    decidedBy: string;
    decidedAt: string;
    rotations: Array<{ captureId: string; role: string; quarterTurns: number }>;
  }>;
}

function noDecisions(ref: string, message: string): Response {
  const problem: CaptureProblem = { rule: "no-decisions", message, ref };
  return json(404, { problems: [problem] });
}

const iso = (ms: number) => new Date(ms).toISOString();

export async function handleVolumeDecisions(deps: CaptureLinkDeps, request: Request, ref: string): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET", "Cache-Control": "no-store" } });
  const auth = await authenticate(deps, request);
  if (auth instanceof Response) return auth;
  const t = auth.tenant.id;
  const { db } = deps;

  const delivery =
    ref.length > MAX_FIELD_CHARS
      ? undefined
      : await db
          .select({ id: captureDeliveries.id })
          .from(captureDeliveries)
          .where(
            and(
              eq(captureDeliveries.tenantId, t),
              eq(captureDeliveries.referenceCode, ref),
              eq(captureDeliveries.state, "registered"),
            ),
          )
          .get();
  if (!delivery) return noDecisions(ref, `Fisqua holds no delivery for ${ref.slice(0, MAX_FIELD_CHARS)}`);

  // One batch, so the set, its decisions and its rotations agree, and
  // the fetch recorded is of the set as answered.
  const now = deps.now();
  const [sets, decisions, rotations] = await db.batch([
    db
      .select({ decisionsId: captureQcSets.decisionsId, decidedAt: captureQcSets.decidedAt })
      .from(captureQcSets)
      .where(and(eq(captureQcSets.tenantId, t), eq(captureQcSets.deliveryId, delivery.id))),
    db
      .select({
        captuaRecordId: captureQcDecisions.captuaRecordId,
        decision: captureQcDecisions.decision,
        reason: captureQcDecisions.reason,
        side: captureQcDecisions.side,
        note: captureQcDecisions.note,
        decidedByName: captureQcDecisions.decidedByName,
        decidedAt: captureQcDecisions.decidedAt,
      })
      .from(captureQcDecisions)
      .where(and(eq(captureQcDecisions.tenantId, t), eq(captureQcDecisions.deliveryId, delivery.id)))
      .orderBy(asc(captureQcDecisions.captuaRecordId)),
    db
      .select({
        captuaRecordId: captureQcRotations.captuaRecordId,
        captureId: captureQcRotations.captureId,
        role: captureQcRotations.role,
        quarterTurns: captureQcRotations.quarterTurns,
      })
      .from(captureQcRotations)
      .where(and(eq(captureQcRotations.tenantId, t), eq(captureQcRotations.deliveryId, delivery.id)))
      .orderBy(asc(captureQcRotations.captuaRecordId), asc(captureQcRotations.captureId), asc(captureQcRotations.role)),
    rawBatchItem(
      db,
      sql`INSERT INTO capture_qc_fetches (tenant_id, delivery_id, decisions_id, set_revision, first_fetched_at, last_fetched_at)
        SELECT fs.tenant_id, fs.delivery_id, fs.decisions_id, fs.revision, ${now}, ${now}
        FROM capture_qc_sets fs
        WHERE fs.tenant_id = ${t} AND fs.delivery_id = ${delivery.id}
        ON CONFLICT (tenant_id, decisions_id) DO UPDATE SET
          last_fetched_at = MAX(capture_qc_fetches.last_fetched_at, excluded.last_fetched_at)`,
    ),
  ]);
  // A set whose decisions were all cleared is answered with no records.
  const set = sets[0];
  if (!set) return noDecisions(ref, `No opening of the current delivery of ${ref} is decided yet`);

  const rotationsOf = new Map<number, DecisionsAnswer["records"][number]["rotations"]>();
  for (const r of rotations) {
    const list = rotationsOf.get(r.captuaRecordId) ?? [];
    list.push({ captureId: r.captureId, role: r.role, quarterTurns: r.quarterTurns });
    rotationsOf.set(r.captuaRecordId, list);
  }
  const answer: DecisionsAnswer = {
    decisionsId: set.decisionsId,
    decidedAt: iso(set.decidedAt),
    manifestId: delivery.id,
    records: decisions.map((d) => ({
      captuaRecordId: d.captuaRecordId,
      decision: d.decision,
      ...(d.decision === "rejected" && d.reason !== null ? { reason: d.reason } : {}),
      ...(d.decision === "rejected" && d.side !== null ? { side: d.side } : {}),
      ...(d.note !== null ? { note: d.note } : {}),
      decidedBy: d.decidedByName,
      decidedAt: iso(d.decidedAt),
      rotations: rotationsOf.get(d.captuaRecordId) ?? [],
    })),
  };
  return json(200, answer);
}

// @version v0.8.0
