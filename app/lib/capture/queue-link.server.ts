/**
 * Capture Link — Operators, Queue and Acknowledgement
 *
 * This module deals with the three calls of contract 1.7 by which a
 * Captua unit keeps the workspace's digitization queue in step with its
 * own: sending its users (`PUT /api/capture/v1/operators`,
 * `handleOperatorsPut`), reading the queue (`GET /api/capture/v1/queue`,
 * `handleQueueGet`) and saying what it did with it (`POST
 * /api/capture/v1/queue/ack`, `handleQueueAck`). Like the link's other
 * calls they run no session and no Origin check, answer on the tenant's
 * host, and are authenticated and rate-limited by `authenticate`
 * (`link.server.ts`): the unit's bearer token, 401, 403 or 404 as there,
 * and 429 with `Retry-After` past 60 calls a minute. On a workspace
 * without the digitization capability every call is a bare 404, as an
 * unknown host is (`admit`). A body is read up
 * to its cap (413 past it), and one that is not JSON or not the shape
 * below is 422 with `{ problems: [{ rule, message, path? }] }`. Unknown
 * fields are ignored.
 *
 * OPERATORS. `{ operators: [{ username, displayName?, role, active }],
 * mode? }`, the unit's whole list (at most `MAX_OPERATORS`), replaces the
 * one held for the calling scanner, in one batch. `mode` (`offline`,
 * `backup` or `fisqua`), when sent, is recorded on the scanner with the
 * time; when absent the last one stands. It refuses nothing: a unit not
 * in `fisqua` mode is only warned about on the queue screen. A username given twice is 422
 * (`duplicate-username`). `displayName` is the username when absent.
 * 204 on success.
 *
 * QUEUE. The items the calling scanner is to see (`servedTo`): every
 * item assigned to it or to no scanner, not withdrawn, with capture work
 * left: queued, on the unit, skipped, or with retakes requested. One
 * captured, in capture QC or approved stays on the queue screen but is
 * not served, since the unit would show it to operators as work to
 * capture; a served one that reaches captured (its handover arrives)
 * drops out under a new revision, as the revision reads every handover
 * and QC change. And each withdrawn one until the unit acknowledges it under a revision
 * stamped at or after its withdrawal, flagged `withdrawn: true`. Items
 * keep the queue's order and are numbered from 1 as `sequence`. Each
 * carries the contract §3 fields (`filenameStem` is the reference code),
 * its job, note, the operator assigned when it is assigned to this
 * scanner, and, on an item whose job is `spot-recapture`, `retakes`: the
 * volume's current rejected openings, each with its Captua record id,
 * pair id (null for a single-image opening) and side (the decision's,
 * or `both` when it gives none), empty when none is outstanding. Other
 * items omit the field. An item's id is its entry's; a volume with
 * retakes and no entry takes its pipeline volume's id, which a row
 * written for it later keeps, so the id is the same in every revision.
 * `listName` is the workspace's name.
 *
 * REVISION. `<stamp>-<digest>`: the largest `changed_at` of the
 * tenant's entries, and 16 hex characters of the SHA-256 of everything a
 * served item can change with, read in one statement (`queueRevision`):
 * the entries' count, stamps and acknowledgements; the latest handover;
 * the capture QC sets' count and revisions; each run table (review runs,
 * pipeline runs, their chunks and volumes, pipeline volumes) as its
 * states' counts and latest times, with the pipeline runs still holding
 * at the time of the call, so a hold that ends by expiry changes it with
 * no write; the latest edit to any of the tenant's descriptions (indexed,
 * `descriptions_tenant_updated_idx`), which covers ancestors' titles in
 * `containerPath`; the workspace's name; the scanner; and
 * `QUEUE_SERVE_VERSION`, the version of the serving rules. Every table
 * is read through an index that leads on the tenant
 * (`revisionInputsSql`; 0112 adds them for descriptions, run chunks and
 * run volumes). An edit
 * elsewhere in the tenant can change the revision with nothing served
 * changed; that costs the unit one full answer, never a stale 304.
 * `If-None-Match` naming it is 304 without reading the queue; otherwise
 * 200 with `ETag: "<revision>"`, and the revision is recorded as served
 * to the scanner with its stamp (`capture_queue_served`, kept
 * `SERVED_KEEP_MS`).
 *
 * ACKNOWLEDGEMENT. `{ revision, applied: [{ itemId, collectionId }],
 * skipped: [{ itemId, reason }] }`, at most `MAX_ACK_ITEMS` of each. A
 * revision Fisqua did not serve to the calling scanner (a fabricated
 * one, another scanner's, or one past its keep) is 422 (`revision`), so
 * a unit cannot acknowledge a withdrawal it never fetched; a served one,
 * however old, is accepted for the items it names, with the stamp it was
 * served at. An item named twice takes its last outcome, skipped after
 * applied. Each applied item is recorded with its collection id, each
 * skipped one with its reason, and each with that stamp when it is later
 * than the one it holds. A retake served without a row gets one under
 * its volume's id. Listed back as unknown, and left unchanged: any other
 * id (a volume id that is not such a retake included), an entry assigned
 * to another scanner, and an entry added again after the revision was
 * served (`revived_stamp`), so a late acknowledgement cannot restore what
 * the revival cleared; the writes carry the scanner and revival guards
 * themselves (`ackWrites`), so a change between the read and the write
 * leaves the entry alone. Reads and writes bind the ids as one JSON
 * value per `ACK_IDS_PER_STATEMENT` and find rows by primary key; a
 * missing id is checked as a retake volume only among the named ids
 * (`readRetakeVolumes` with `volumeIds`), so a full acknowledgement of
 * 5,000 and 5,000 items takes some 50 statements, well inside a
 * Worker's limit.
 * 200 with `{ recorded, unknown }`.
 *
 * Nothing here logs a token, a hash or a body.
 *
 * @version v0.9.0
 */

import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod/v4";
import { captureQueueEntries, captureQueueServed, captureScannerOperators, captureScanners } from "../../db/schema";
import { hasCapability } from "../tenant";
import { CAPTURE_OPERATOR_ROLES, CAPTURE_SCANNER_MODES } from "../validation/enums";
import { readCappedBody } from "../pipeline/callback.server";
import { authenticate, type Authenticated, type CaptureLinkDeps } from "./link.server";
import { loadQueueItems, readItemDetails, readRetakeVolumes, type QueueItem } from "./queue.server";
import type { QueueState } from "./queue";

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

export const MAX_OPERATORS = 1000;
export const MAX_ACK_ITEMS = 5000;
const MAX_OPERATORS_BYTES = 256 * 1024;
const MAX_ACK_BYTES = 2 * 1024 * 1024;
const OPERATOR_ROWS_PER_STATEMENT = 10;
/** Item ids per acknowledgement statement, bound as one JSON value. */
const ACK_IDS_PER_STATEMENT = 500;
/** Missing item ids looked up as retake volumes per read. */
const ACK_MISSING_PER_READ = 1000;

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function bare(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

interface Problem {
  rule: string;
  message: string;
  path?: string;
}

const refuse = (problems: Problem[]) => json(422, { problems });

/**
 * The scanner of an authenticated call on a workspace with the
 * digitization capability, or the answer to give instead. The
 * reference-code lookup and the description search
 * (`description-link.server.ts`) admit through it too, so every
 * capability-gated call answers alike.
 */
export async function admit(deps: CaptureLinkDeps, request: Request): Promise<Authenticated | Response> {
  const auth = await authenticate(deps, request);
  if (auth instanceof Response) return auth;
  if (!hasCapability(auth.tenant, "digitization")) return bare(404);
  return auth;
}

/** The body as JSON, or the answer to give instead. */
async function readJson(request: Request, limit: number): Promise<unknown | Response> {
  const bytes = await readCappedBody(request, limit);
  if (bytes === null) return bare(413);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return refuse([{ rule: "malformed", message: "The body is not UTF-8 JSON" }]);
  }
}

function shapeProblems(error: z.ZodError): Problem[] {
  return error.issues.slice(0, 100).map((issue) => ({
    rule: "shape",
    message: issue.message,
    path: issue.path.map(String).join("."),
  }));
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

const operatorsBody = z.object({
  operators: z
    .array(
      z.object({
        username: z.string().min(1).max(256),
        displayName: z.string().max(256).optional(),
        role: z.enum(CAPTURE_OPERATOR_ROLES),
        active: z.boolean(),
      }),
    )
    .max(MAX_OPERATORS),
  mode: z.enum(CAPTURE_SCANNER_MODES).optional(),
});

export async function handleOperatorsPut(deps: CaptureLinkDeps, request: Request): Promise<Response> {
  if (request.method !== "PUT") return bare(405, { Allow: "PUT" });
  const auth = await admit(deps, request);
  if (auth instanceof Response) return auth;
  const body = await readJson(request, MAX_OPERATORS_BYTES);
  if (body instanceof Response) return body;
  const parsed = operatorsBody.safeParse(body);
  if (!parsed.success) return refuse(shapeProblems(parsed.error));
  const seen = new Set<string>();
  const duplicates: Problem[] = [];
  parsed.data.operators.forEach((o, i) => {
    if (seen.has(o.username)) {
      duplicates.push({ rule: "duplicate-username", message: `The username ${o.username} is given twice`, path: `operators.${i}.username` });
    }
    seen.add(o.username);
  });
  if (duplicates.length > 0) return refuse(duplicates);

  const now = deps.now();
  const tenantId = auth.tenant.id;
  const rows = parsed.data.operators.map((o) => ({
    tenantId,
    scannerId: auth.scannerId,
    username: o.username,
    displayName: o.displayName ?? o.username,
    role: o.role,
    active: o.active,
    updatedAt: now,
  }));
  const { db } = deps;
  const statements: any[] = [
    db
      .delete(captureScannerOperators)
      .where(and(eq(captureScannerOperators.tenantId, tenantId), eq(captureScannerOperators.scannerId, auth.scannerId))),
  ];
  for (let i = 0; i < rows.length; i += OPERATOR_ROWS_PER_STATEMENT) {
    statements.push(db.insert(captureScannerOperators).values(rows.slice(i, i + OPERATOR_ROWS_PER_STATEMENT)));
  }
  if (parsed.data.mode !== undefined) {
    statements.push(
      db
        .update(captureScanners)
        .set({ mode: parsed.data.mode, modeReportedAt: now })
        .where(and(eq(captureScanners.tenantId, tenantId), eq(captureScanners.id, auth.scannerId))),
    );
  }
  await db.batch(statements as [any, ...any[]]);
  return bare(204);
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/** Whether the scanner is shown an item (module header). */
export function servedTo(item: QueueItem, scannerId: string): boolean {
  if (item.scannerId !== null && item.scannerId !== scannerId) return false;
  if (item.withdrawnAt !== null) return item.ackedRevision === null || item.ackedRevision < item.withdrawnAt;
  return WORK_LEFT.has(item.state);
}

/** The states of an entry with capture work left on the unit. */
const WORK_LEFT: ReadonlySet<QueueState> = new Set(["queued", "on_unit", "skipped", "retakes_requested"]);

/** How long a served revision can still be acknowledged under. */
export const SERVED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The one statement the revision reads (module header). Every table it
 * reads is searched by an index that leads on the tenant.
 */
export function revisionInputsSql(tenantId: string, now: number): SQL {
  return sql`SELECT
      (SELECT MAX(changed_at) FROM capture_queue_entries WHERE tenant_id = ${tenantId}) AS stamp,
      (SELECT COUNT(*) || ':' || COALESCE(SUM(COALESCE(acked_revision, 0)), 0)
        FROM capture_queue_entries WHERE tenant_id = ${tenantId}) AS entries,
      (SELECT MAX(seq) FROM capture_deliveries WHERE tenant_id = ${tenantId}) AS deliveries,
      (SELECT COUNT(*) || ':' || COALESCE(SUM(revision), 0) FROM capture_qc_sets WHERE tenant_id = ${tenantId}) AS sets,
      (SELECT group_concat(k, ',') FROM (SELECT status || '/' || COALESCE(purge_status, '') || '=' || COUNT(*)
          || '@' || COALESCE(MAX(reported_at), 0) AS k
        FROM capture_review_runs WHERE tenant_id = ${tenantId} GROUP BY status, purge_status ORDER BY 1)) AS reviewRuns,
      (SELECT group_concat(k, ',') FROM (SELECT status || '=' || COUNT(*) || '/' || COUNT(completed_at) || '/'
          || COUNT(token_revoked_at) || '/' || SUM(token_revoked_at IS NULL AND token_expires_at > ${now}) AS k
        FROM pipeline_runs WHERE tenant_id = ${tenantId} GROUP BY status ORDER BY 1)) AS runs,
      (SELECT group_concat(k, ',') FROM (SELECT status || '=' || COUNT(*) AS k
        FROM pipeline_run_chunks WHERE tenant_id = ${tenantId} GROUP BY status ORDER BY 1)) AS chunks,
      (SELECT group_concat(k, ',') FROM (SELECT status || '=' || COUNT(*) || '@' || COALESCE(MAX(reported_at), 0) AS k
        FROM pipeline_run_volumes WHERE tenant_id = ${tenantId} GROUP BY status ORDER BY 1)) AS runVolumes,
      (SELECT group_concat(k, ',') FROM (SELECT state || '=' || COUNT(*) || '/' || COUNT(held_by_run_id)
          || '@' || MAX(updated_at) AS k
        FROM pipeline_volumes WHERE tenant_id = ${tenantId} GROUP BY state ORDER BY 1)) AS volumes,
      (SELECT MAX(updated_at) FROM descriptions WHERE tenant_id = ${tenantId}) AS described`;
}

/**
 * The queue's revision for a scanner, from one read of what the answer
 * depends on (module header), so a 304 costs one statement.
 */
async function queueRevision(deps: CaptureLinkDeps, tenantId: string, scannerId: string, listName: string) {
  const now = deps.now();
  // Each run table as a sorted list of `state=count@latest`, so any
  // transition changes it; a pipeline run's hold also by expiry, which
  // writes nothing, through the count of runs still holding at `now`.
  const row = await deps.db.get<Record<string, number | string | null>>(revisionInputsSql(tenantId, now));
  const stamp = Number(row?.stamp ?? 0);
  return { stamp, revision: await queueRevisionOf(stamp, { scannerId, listName, row }) };
}

/**
 * The version of the rules for what the queue serves. Bump it whenever
 * those rules change (`servedTo`, or any field of a served item), so an
 * ETag a unit holds from before the change no longer matches and it gets
 * the new answer instead of a 304.
 */
export const QUEUE_SERVE_VERSION = 2;

/** A revision from its stamp and the inputs read for it, under a serving-rules version. */
export async function queueRevisionOf(
  stamp: number,
  parts: { scannerId: string; listName: string; row: unknown },
  serveVersion: number = QUEUE_SERVE_VERSION,
): Promise<string> {
  const inputs = JSON.stringify({ serveVersion, ...parts });
  return `${stamp}-${await digest(inputs)}`;
}

async function digest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/** The tags an `If-None-Match` header names, without quotes or weak markers. */
function tagsOf(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((t) => t.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1"))
    .filter((t) => t.length > 0);
}

export async function handleQueueGet(deps: CaptureLinkDeps, request: Request): Promise<Response> {
  if (request.method !== "GET") return bare(405, { Allow: "GET" });
  const auth = await admit(deps, request);
  if (auth instanceof Response) return auth;
  const tenantId = auth.tenant.id;
  const listName = auth.tenant.name;
  const { stamp, revision } = await queueRevision(deps, tenantId, auth.scannerId, listName);
  const etag = `"${revision}"`;
  if (tagsOf(request.headers.get("If-None-Match")).includes(revision)) {
    return bare(304, { ETag: etag });
  }

  const served = (await loadQueueItems(deps.db, tenantId, deps.now())).filter((i) => servedTo(i, auth.scannerId));
  const details = await readItemDetails(deps.db, tenantId, served.map((i) => i.descriptionId));
  const items = served.flatMap((item) => {
    const d = details.get(item.descriptionId);
    if (!d) return [];
    return [
      {
        itemId: item.id,
        referenceCode: d.referenceCode,
        filenameStem: d.referenceCode,
        title: d.title,
        dates: d.dates,
        extent: d.extent,
        containerPath: d.containerPath,
        action: item.action,
        notes: item.note,
        assignee: item.scannerId === auth.scannerId ? item.assignee : null,
        withdrawn: item.withdrawnAt !== null,
        ...(item.action === "spot-recapture" ? { retakes: item.retakes } : {}),
      },
    ];
  });
  const numbered = items.map((item, i) => ({ ...item, sequence: i + 1 }));

  // Recorded before answering, so the unit can acknowledge under it; old ones go.
  const now = deps.now();
  await deps.db.batch([
    deps.db
      .insert(captureQueueServed)
      .values({ tenantId, scannerId: auth.scannerId, revision, stamp, servedAt: now })
      .onConflictDoUpdate({ target: [captureQueueServed.scannerId, captureQueueServed.revision], set: { servedAt: now } }),
    deps.db
      .delete(captureQueueServed)
      .where(
        and(
          eq(captureQueueServed.tenantId, tenantId),
          eq(captureQueueServed.scannerId, auth.scannerId),
          sql`${captureQueueServed.servedAt} < ${now - SERVED_KEEP_MS}`,
        ),
      ),
  ]);
  return json(200, { revision, listName, items: numbered }, { ETag: etag });
}

// ---------------------------------------------------------------------------
// Acknowledgement
// ---------------------------------------------------------------------------

const ackBody = z.object({
  revision: z.string().max(64),
  applied: z
    .array(z.object({ itemId: z.string().min(1).max(64), collectionId: z.union([z.string().max(256), z.number()]) }))
    .max(MAX_ACK_ITEMS)
    .default([]),
  skipped: z
    .array(z.object({ itemId: z.string().min(1).max(64), reason: z.string().min(1).max(2000) }))
    .max(MAX_ACK_ITEMS)
    .default([]),
});

export async function handleQueueAck(deps: CaptureLinkDeps, request: Request): Promise<Response> {
  if (request.method !== "POST") return bare(405, { Allow: "POST" });
  const auth = await admit(deps, request);
  if (auth instanceof Response) return auth;
  const body = await readJson(request, MAX_ACK_BYTES);
  if (body instanceof Response) return body;
  const parsed = ackBody.safeParse(body);
  if (!parsed.success) return refuse(shapeProblems(parsed.error));
  const tenantId = auth.tenant.id;
  // Only a revision served to this scanner counts, with the stamp it was served at.
  const servedRow = await deps.db
    .select({ stamp: captureQueueServed.stamp })
    .from(captureQueueServed)
    .where(
      and(
        eq(captureQueueServed.tenantId, tenantId),
        eq(captureQueueServed.scannerId, auth.scannerId),
        eq(captureQueueServed.revision, parsed.data.revision),
      ),
    )
    .get();
  if (!servedRow) {
    return refuse([{ rule: "revision", message: "The revision is not one Fisqua served to this scanner", path: "revision" }]);
  }
  const ackedStamp = servedRow.stamp;

  const { db } = deps;
  const now = deps.now();

  // One outcome per item id, the last named winning: applied, then skipped.
  const outcome = new Map<string, { collectionId: string } | { reason: string }>();
  for (const a of parsed.data.applied) outcome.set(a.itemId, { collectionId: String(a.collectionId) });
  for (const x of parsed.data.skipped) outcome.set(x.itemId, { reason: x.reason });
  const named = [...outcome.keys()];

  // The named entries, read with the ids bound as one JSON value per chunk.
  const rows = new Map<string, { scannerId: string | null; revivedStamp: number | null }>();
  for (const part of chunks(named, ACK_IDS_PER_STATEMENT)) {
    const found = await db.all<{ id: string; scannerId: string | null; revivedStamp: number | null }>(sql`
      SELECT id, scanner_id AS scannerId, revived_stamp AS revivedStamp FROM capture_queue_entries
      WHERE +tenant_id = ${tenantId} AND id IN (SELECT value FROM json_each(${JSON.stringify(part)}))`);
    for (const r of found) rows.set(r.id, r);
  }

  // A retake served without a row gets one now, under its volume's id:
  // only a named id that is a volume of the tenant with retakes
  // outstanding and whose description has no row, read for the named ids
  // alone.
  const missing = named.filter((id) => !rows.has(id));
  for (const part of chunks(missing, ACK_MISSING_PER_READ)) {
    const volumes = await readRetakeVolumes(db, tenantId, { volumeIds: part, pairs: false });
    if (volumes.length === 0) continue;
    const stored = new Set(
      (
        await db.all<{ descriptionId: string }>(sql`
          SELECT description_id AS descriptionId FROM capture_queue_entries
          WHERE tenant_id = ${tenantId}
            AND description_id IN (SELECT value FROM json_each(${JSON.stringify(volumes.map((v) => v.descriptionId))}))`)
      ).map((r) => r.descriptionId),
    );
    const toWrite = volumes.filter((v) => !stored.has(v.descriptionId)).map((v) => v.volumeId);
    for (const ids of chunks(toWrite, ACK_IDS_PER_STATEMENT)) {
      await db.run(sql`
        INSERT INTO capture_queue_entries
          (id, tenant_id, description_id, position, origin, action, added_at, changed_at)
        SELECT v.id, ${tenantId}, v.description_id,
          (SELECT COALESCE(MAX(p.position), 0) FROM capture_queue_entries p WHERE p.tenant_id = ${tenantId}) + 1,
          'retake', 'spot-recapture', ${now},
          (SELECT MAX(${now}, COALESCE(MAX(s.changed_at), 0) + 1) FROM capture_queue_entries s WHERE s.tenant_id = ${tenantId})
        FROM pipeline_volumes v
        WHERE v.tenant_id = ${tenantId} AND v.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
        ON CONFLICT (tenant_id, description_id) DO NOTHING`);
      const made = await db.all<{ id: string }>(sql`
        SELECT id FROM capture_queue_entries
        WHERE +tenant_id = ${tenantId} AND id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`);
      for (const r of made) rows.set(r.id, { scannerId: null, revivedStamp: null });
    }
  }

  // Counted: the entry exists, is this scanner's or no scanner's, and was
  // not added again after the revision was served.
  const counted = (id: string) => {
    const r = rows.get(id);
    return r !== undefined && (r.scannerId === null || r.scannerId === auth.scannerId) &&
      (r.revivedStamp === null || r.revivedStamp <= ackedStamp);
  };
  const applied = new Map<string, string>();
  const skipped = new Map<string, string>();
  for (const id of named) {
    if (!counted(id)) continue;
    const o = outcome.get(id) as { collectionId: string } | { reason: string };
    if ("collectionId" in o) applied.set(id, o.collectionId);
    else skipped.set(id, o.reason);
  }
  // The writes carry the same guards, so a change between the read and
  // the write leaves the entry alone; only what they changed is recorded.
  const recorded = new Set<string>();
  for (const w of ackWrites({ tenantId, scannerId: auth.scannerId, ackedStamp, now, applied, skipped })) {
    for (const r of await db.all<{ id: string }>(w)) recorded.add(r.id);
  }
  return json(200, { recorded: recorded.size, unknown: named.filter((id) => !recorded.has(id)) });
}

/**
 * The acknowledgement's writes: applied items with their collection ids,
 * skipped ones with their reasons, `ACK_IDS_PER_STATEMENT` per
 * statement. Each finds its rows by primary key (`id IN json_each`), the
 * values in a JSON object keyed by id, and changes a row only when it is
 * this scanner's or no scanner's and was not added again after the
 * acknowledged revision; each returns the ids it changed.
 */
export function ackWrites(a: {
  tenantId: string;
  scannerId: string;
  ackedStamp: number;
  now: number;
  applied: Map<string, string>;
  skipped: Map<string, string>;
}): SQL[] {
  // `+tenant_id` keeps the planner off the tenant's indexes, so the id
  // list drives the lookup by primary key whatever the statistics say.
  const guard = sql`+tenant_id = ${a.tenantId}
    AND (scanner_id IS NULL OR scanner_id = ${a.scannerId})
    AND (revived_stamp IS NULL OR revived_stamp <= ${a.ackedStamp})`;
  const acked = sql`MAX(COALESCE(acked_revision, 0), ${a.ackedStamp})`;
  const out: SQL[] = [];
  for (const part of chunks([...a.applied.keys()], ACK_IDS_PER_STATEMENT)) {
    const values = JSON.stringify(Object.fromEntries(part.map((id) => [id, a.applied.get(id)])));
    out.push(sql`UPDATE capture_queue_entries SET applied_at = ${a.now},
        collection_id = json_extract(${values}, '$."' || id || '"'),
        skipped_at = NULL, skipped_reason = NULL, acked_revision = ${acked}
      WHERE id IN (SELECT value FROM json_each(${JSON.stringify(part)})) AND ${guard}
      RETURNING id`);
  }
  for (const part of chunks([...a.skipped.keys()], ACK_IDS_PER_STATEMENT)) {
    const values = JSON.stringify(Object.fromEntries(part.map((id) => [id, a.skipped.get(id)])));
    out.push(sql`UPDATE capture_queue_entries SET skipped_at = ${a.now},
        skipped_reason = json_extract(${values}, '$."' || id || '"'), acked_revision = ${acked}
      WHERE id IN (SELECT value FROM json_each(${JSON.stringify(part)})) AND ${guard}
      RETURNING id`);
  }
  return out;
}

// @version v0.9.0
