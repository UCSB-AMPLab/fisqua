/**
 * Capture QC — What the Retakes Screen Reads
 *
 * This module deals with the read behind the Retakes screen: for each
 * volume of the tenant still in capture QC, the openings rejected for
 * retake and not yet approved again, each with where its retake stands
 * (`retakeStateOf` in `retakes.ts`). Every read is scoped to the
 * request's tenant; nothing here writes.
 *
 * A volume is read when its current delivery (the one `registered`)
 * holds a rejection, or when an earlier delivery of it rejected an
 * opening; a volume a pipeline run has named is left out, since its
 * decisions are fixed. A user who is not a manager (`captureAccess`)
 * sees only the volumes assigned to them for review.
 *
 * `readVolumeRetakes` reads one volume: the current delivery's records
 * and decisions, each opening's latest earlier decision when it is a
 * rejection (`readEarlierRejections`), the
 * fetches the unit made of each delivery's decision set, and the images
 * of the openings concerned. An opening rejected earlier and undecided
 * now is compared with the images it had in the delivery that rejected
 * it, counting only the images of each delivery's openings
 * (`record_status` `in_review` or `approved`), each by capture id, role,
 * capture digest and `rotate_deg`: unchanged, its rejection still
 * stands as that delivery's; changed, it was replaced.
 *
 * A row is a retake: its opening's sequence, the page keys of its images
 * (left, right, then a single) in the current delivery, or, for an
 * opening missing from it, in the delivery that rejected it, the
 * rejection's reason, the image it asks to retake (its `side`, for an
 * opening with two images), note, who asked for it (the decider's name as the
 * unit was told it) and when, whole days since, and its state. Rows are
 * ordered by sequence, volumes by reference code.
 *
 * `countUnchangedRejections` gives the queue the openings of a retake
 * that are undecided only because their rejection stands unchanged, so
 * they are not counted among the replaced openings to review again.
 *
 * `readEarlierRejections` reads the volume's earlier (`superseded`)
 * deliveries' decisions, newest delivery first, and keeps each record's
 * latest earlier decision when it is a rejection, with the delivery that
 * made it. The Retakes screen and the capture QC viewer
 * (`viewer.server.ts`, which shows a retaken opening's rejected images)
 * share it, so both read the same rejection as the one that counts; the
 * viewer keeps only the rejections the latest earlier delivery made
 * itself, while Retakes follows a rejection that still stands from an
 * older one.
 *
 * @version v0.8.0
 */

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  captureDeliveries,
  captureImages,
  captureQcDecisions,
  captureQcFetches,
  captureQcReviewers,
  descriptions,
  pipelineVolumes,
} from "../../db/schema";
import type { User } from "../../context";
import type { CaptureQcReason, CaptureQcSide } from "../validation/enums";
import { unpackJson } from "./link.server";
import { isOpening } from "./manifest";
import { retakeStateOf, type DecisionFetch, type RetakeState } from "./retakes";
import { waitingDays } from "./screens";

/** Ids per `IN (...)` read, under D1's 100 bound parameters. */
const READ_CHUNK = 50;

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

export interface RetakeRow {
  captuaRecordId: number;
  /** The opening's sequence in the manifest that holds it. */
  sequence: number;
  pageKeys: string[];
  reason: CaptureQcReason | null;
  side: CaptureQcSide | null;
  note: string | null;
  askedBy: string;
  askedAt: number;
  outstandingDays: number;
  state: RetakeState;
  sentAt: number | null;
  /** Whether the rejection is an earlier delivery's rather than the current one's. */
  fromEarlier: boolean;
}

export interface RetakeVolume {
  volumeId: string;
  referenceCode: string;
  title: string | null;
  /** Openings of the current delivery no one has decided yet. */
  undecided: number;
  /** When the unit last received a rejection of this volume; null while none has reached it. */
  sentAt: number | null;
  rows: RetakeRow[];
}

interface Decision {
  captuaRecordId: number;
  decision: "approved" | "rejected";
  reason: CaptureQcReason | null;
  side: CaptureQcSide | null;
  note: string | null;
  decidedByName: string;
  decidedAt: number;
  setRevision: number;
}

interface Image {
  captureId: string;
  role: string;
  sha256: string;
  /** The image's `rotate_deg`; null follows its EXIF orientation. */
  rotateDeg: number | null;
  pageKey: string;
  opening: boolean;
}

const ROLE_ORDER: Record<string, number> = { left: 0, right: 1, single: 2 };

export async function loadRetakes(
  db: DrizzleD1Database<any>,
  tenantId: string,
  user: Pick<User, "id">,
  manager: boolean,
  now: number,
): Promise<RetakeVolume[]> {
  // The current deliveries of volumes with a rejection, now or earlier.
  const candidates = await db
    .select({
      deliveryId: captureDeliveries.id,
      volumeId: pipelineVolumes.id,
      referenceCode: pipelineVolumes.referenceCode,
      title: descriptions.title,
      openings: captureDeliveries.openings,
      decided: sql<number | null>`(SELECT cs.decided_count FROM capture_qc_sets cs WHERE cs.tenant_id = ${tenantId}
        AND cs.delivery_id = ${captureDeliveries.id})`,
      reviewerId: captureQcReviewers.reviewerId,
    })
    .from(captureDeliveries)
    .innerJoin(
      pipelineVolumes,
      and(eq(pipelineVolumes.tenantId, tenantId), eq(pipelineVolumes.id, captureDeliveries.pipelineVolumeId)),
    )
    .leftJoin(
      descriptions,
      and(eq(descriptions.tenantId, tenantId), eq(descriptions.id, pipelineVolumes.descriptionId)),
    )
    .leftJoin(
      captureQcReviewers,
      and(eq(captureQcReviewers.tenantId, tenantId), eq(captureQcReviewers.pipelineVolumeId, pipelineVolumes.id)),
    )
    .where(
      and(
        eq(captureDeliveries.tenantId, tenantId),
        eq(captureDeliveries.state, "registered"),
        sql`NOT EXISTS (SELECT 1 FROM pipeline_run_volumes rv WHERE rv.tenant_id = ${tenantId}
          AND rv.pipeline_volume_id = ${pipelineVolumes.id})`,
        sql`(EXISTS (SELECT 1 FROM capture_qc_sets rs WHERE rs.tenant_id = ${tenantId}
              AND rs.delivery_id = ${captureDeliveries.id} AND rs.rejected_count > 0)
          OR EXISTS (SELECT 1 FROM capture_qc_sets es JOIN capture_deliveries ed ON ed.tenant_id = ${tenantId}
                AND ed.id = es.delivery_id
              WHERE es.tenant_id = ${tenantId} AND es.rejected_count > 0
                AND ed.pipeline_volume_id = ${pipelineVolumes.id} AND ed.state = 'superseded'))`,
      ),
    )
    .orderBy(asc(pipelineVolumes.referenceCode))
    .all();

  const out: RetakeVolume[] = [];
  for (const c of candidates) {
    if (!manager && c.reviewerId !== user.id) continue;
    const rows = await readVolumeRetakes(db, tenantId, c.deliveryId, c.volumeId, now);
    if (rows.length === 0) continue;
    let sent: number | null = null;
    for (const r of rows) if (r.sentAt !== null && (sent === null || r.sentAt > sent)) sent = r.sentAt;
    out.push({
      volumeId: c.volumeId,
      referenceCode: c.referenceCode,
      title: c.title ?? null,
      undecided: Math.max(0, c.openings - Number(c.decided ?? 0)),
      sentAt: sent,
      rows,
    });
  }
  return out;
}

/** The openings of a retake undecided because their earlier rejection stands unchanged. */
export async function countUnchangedRejections(
  db: DrizzleD1Database<any>,
  tenantId: string,
  deliveryId: string,
  volumeId: string,
  now: number,
): Promise<number> {
  const rows = await readVolumeRetakes(db, tenantId, deliveryId, volumeId, now);
  return rows.filter((r) => r.fromEarlier && (r.state === "requested" || r.state === "sent")).length;
}

type RecordRow = { captuaRecordId: number; sequence: number; status: string };

async function readRecords(db: DrizzleD1Database<any>, tenantId: string, deliveryId: string): Promise<RecordRow[]> {
  const row = await db
    .select({ records: captureDeliveries.records })
    .from(captureDeliveries)
    .where(and(eq(captureDeliveries.tenantId, tenantId), eq(captureDeliveries.id, deliveryId)))
    .get();
  return row?.records ? (JSON.parse(await unpackJson(row.records)) as RecordRow[]) : [];
}

/** The images of `recordIds` in a delivery, by record. */
async function readImages(
  db: DrizzleD1Database<any>,
  tenantId: string,
  deliveryId: string,
  recordIds: number[],
): Promise<Map<number, Image[]>> {
  const out = new Map<number, Image[]>();
  for (const part of chunks(recordIds, READ_CHUNK)) {
    const rows = await db
      .select({
        captuaRecordId: captureImages.captuaRecordId,
        captureId: captureImages.captureId,
        role: captureImages.role,
        sha256: captureImages.captureSha256,
        rotateDeg: captureImages.rotateDeg,
        pageKey: captureImages.pageKey,
        recordStatus: captureImages.recordStatus,
      })
      .from(captureImages)
      .where(
        and(
          eq(captureImages.tenantId, tenantId),
          eq(captureImages.deliveryId, deliveryId),
          inArray(captureImages.captuaRecordId, part),
        ),
      )
      .all();
    for (const r of rows) {
      const list = out.get(r.captuaRecordId) ?? [];
      list.push({
        captureId: r.captureId,
        role: r.role,
        sha256: r.sha256,
        rotateDeg: r.rotateDeg,
        pageKey: r.pageKey,
        opening: r.recordStatus !== null && isOpening(r.recordStatus),
      });
      out.set(r.captuaRecordId, list);
    }
  }
  return out;
}

/** The images of an opening, one key per image; null when it has none. */
function signature(images: Image[] | undefined): string | null {
  const own = (images ?? []).filter((i) => i.opening);
  if (own.length === 0) return null;
  return own
    .map((i) => `${i.captureId}\u0000${i.role}\u0000${i.sha256}\u0000${i.rotateDeg ?? "exif"}`)
    .sort()
    .join("\u0001");
}

/** Page keys, left, right, then a single; an opening's own images where they are told apart. */
function pageKeysOf(images: Image[] | undefined): string[] {
  const all = images ?? [];
  const own = all.filter((i) => i.opening);
  return (own.length > 0 ? own : all)
    .slice()
    .sort((a, b) => (ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3) || a.pageKey.localeCompare(b.pageKey))
    .map((i) => i.pageKey);
}

const DECISION_COLUMNS = {
  captuaRecordId: captureQcDecisions.captuaRecordId,
  decision: captureQcDecisions.decision,
  reason: captureQcDecisions.reason,
  side: captureQcDecisions.side,
  note: captureQcDecisions.note,
  decidedByName: captureQcDecisions.decidedByName,
  decidedAt: captureQcDecisions.decidedAt,
  setRevision: captureQcDecisions.setRevision,
};

/**
 * Each record's latest earlier decision, by record, when it is a
 * rejection: the decisions of the volume's `superseded` deliveries,
 * newest delivery first, so the first seen for a record is its latest.
 * A record whose latest earlier decision approved it is absent.
 */
export async function readEarlierRejections(
  db: DrizzleD1Database<any>,
  tenantId: string,
  volumeId: string,
): Promise<Map<number, Decision & { deliveryId: string }>> {
  const rows = (await db
    .select({ ...DECISION_COLUMNS, deliveryId: captureQcDecisions.deliveryId })
    .from(captureQcDecisions)
    .innerJoin(
      captureDeliveries,
      and(eq(captureDeliveries.tenantId, tenantId), eq(captureDeliveries.id, captureQcDecisions.deliveryId)),
    )
    .where(
      and(
        eq(captureQcDecisions.tenantId, tenantId),
        eq(captureDeliveries.pipelineVolumeId, volumeId),
        eq(captureDeliveries.state, "superseded"),
      ),
    )
    .orderBy(desc(captureDeliveries.seq))
    .all()) as Array<Decision & { deliveryId: string }>;
  const latest = new Map<number, Decision & { deliveryId: string }>();
  for (const d of rows) if (!latest.has(d.captuaRecordId)) latest.set(d.captuaRecordId, d);
  for (const [id, d] of latest) if (d.decision !== "rejected") latest.delete(id);
  return latest;
}

/** One volume's retakes (module header). */
export async function readVolumeRetakes(
  db: DrizzleD1Database<any>,
  tenantId: string,
  deliveryId: string,
  volumeId: string,
  now: number,
): Promise<RetakeRow[]> {
  const records = await readRecords(db, tenantId, deliveryId);
  const openings = new Map(records.filter((r) => isOpening(r.status)).map((r) => [r.captuaRecordId, r.sequence]));
  const sequenceOf = new Map(records.map((r) => [r.captuaRecordId, r.sequence]));

  const current = (await db
    .select(DECISION_COLUMNS)
    .from(captureQcDecisions)
    .where(and(eq(captureQcDecisions.tenantId, tenantId), eq(captureQcDecisions.deliveryId, deliveryId)))
    .all()) as Decision[];
  const currentOf = new Map(current.map((d) => [d.captuaRecordId, d]));

  // Each record's latest earlier decision, when it rejected the record.
  const earlierOf = await readEarlierRejections(db, tenantId, volumeId);

  // The unit's fetches of every delivery of the volume.
  const fetchRows = await db
    .select({
      deliveryId: captureQcFetches.deliveryId,
      setRevision: captureQcFetches.setRevision,
      firstFetchedAt: captureQcFetches.firstFetchedAt,
    })
    .from(captureQcFetches)
    .innerJoin(
      captureDeliveries,
      and(eq(captureDeliveries.tenantId, tenantId), eq(captureDeliveries.id, captureQcFetches.deliveryId)),
    )
    .where(and(eq(captureQcFetches.tenantId, tenantId), eq(captureDeliveries.pipelineVolumeId, volumeId)))
    .all();
  const fetchesOf = new Map<string, DecisionFetch[]>();
  for (const f of fetchRows) {
    const list = fetchesOf.get(f.deliveryId) ?? [];
    list.push({ setRevision: f.setRevision, firstFetchedAt: f.firstFetchedAt });
    fetchesOf.set(f.deliveryId, list);
  }

  // The records concerned: the current delivery's rejections, and every
  // record an earlier delivery last rejected.
  const concerned = new Set<number>();
  for (const d of current) if (d.decision === "rejected") concerned.add(d.captuaRecordId);
  for (const id of earlierOf.keys()) if (!currentOf.has(id)) concerned.add(id);
  if (concerned.size === 0) return [];

  // Their images, now and in each delivery that rejected them earlier.
  const currentImages = await readImages(db, tenantId, deliveryId, [...concerned]);
  const byEarlier = new Map<string, number[]>();
  for (const id of concerned) {
    const e = earlierOf.get(id);
    if (e && !currentOf.has(id)) byEarlier.set(e.deliveryId, [...(byEarlier.get(e.deliveryId) ?? []), id]);
  }
  const earlierImages = new Map<string, Map<number, Image[]>>();
  const earlierSequences = new Map<string, Map<number, number>>();
  for (const [eid, ids] of byEarlier) {
    earlierImages.set(eid, await readImages(db, tenantId, eid, ids));
    if (ids.some((id) => !openings.has(id) && !sequenceOf.has(id))) {
      earlierSequences.set(eid, new Map((await readRecords(db, tenantId, eid)).map((r) => [r.captuaRecordId, r.sequence])));
    }
  }

  const rows: RetakeRow[] = [];
  for (const id of concerned) {
    const cur = currentOf.get(id) ?? null;
    const e = cur === null ? earlierOf.get(id) ?? null : null;
    const inCurrent = openings.has(id);
    const eImages = e ? earlierImages.get(e.deliveryId)?.get(id) : undefined;
    const now_ = signature(currentImages.get(id));
    const standing = retakeStateOf({
      inCurrent,
      current: cur,
      currentFetches: fetchesOf.get(deliveryId) ?? [],
      earlier: e && {
        decision: e.decision,
        setRevision: e.setRevision,
        sameImages: now_ !== null && now_ === signature(eImages),
        fetches: fetchesOf.get(e.deliveryId) ?? [],
      },
    });
    if (standing === null) continue;
    const asked = (cur ?? e) as Decision;
    const sequence =
      openings.get(id) ?? sequenceOf.get(id) ?? (e ? earlierSequences.get(e.deliveryId)?.get(id) : undefined) ?? 0;
    rows.push({
      captuaRecordId: id,
      sequence,
      pageKeys: pageKeysOf(standing.state === "missing" ? eImages : currentImages.get(id)),
      reason: asked.reason,
      side: asked.side,
      note: asked.note,
      askedBy: asked.decidedByName,
      askedAt: asked.decidedAt,
      outstandingDays: waitingDays(asked.decidedAt, now),
      state: standing.state,
      sentAt: standing.sentAt,
      fromEarlier: standing.fromEarlier,
    });
  }
  rows.sort((a, b) => a.sequence - b.sequence || a.captuaRecordId - b.captuaRecordId);
  return rows;
}

// @version v0.8.0
