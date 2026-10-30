/**
 * Capture QC Viewer — What the Viewer Reads
 *
 * This module deals with the one read behind the capture QC viewer,
 * `loadCaptureQcVolume`: a volume's current Captua delivery, laid out
 * for review. Every read is scoped to the request's tenant; nothing
 * here writes. Decisions are recorded by `recordDecisionsAction`
 * (`qc.server.ts`), which the viewer posts to.
 *
 * Who may open it is who may decide. The volume must be the tenant's
 * (a bare 404 otherwise). The tenant's admins and its federation's
 * stewards may open any volume (`isQcManager`, the decisions route's
 * own check), and the volume's assigned reviewer their own; anyone else
 * gets a bare 403. A volume with no current delivery, the one
 * `registered` that holds it, has nothing to review and answers 404.
 *
 * What it answers (`CaptureQcVolume` in `viewer.ts`): the volume's
 * reference code and its description's title; its reviewer, by name as
 * the queue shows people; the current delivery's id, which the viewer
 * posts back as `manifestId` so a decision is never recorded on a
 * handover nobody saw, when it was received, and which handover of the
 * volume it is (its place among the volume's registered and superseded
 * deliveries, by `seq`), and how many of its records are `rejected`
 * (retakes the unit owes, which are not openings); the delivery's
 * openings, its records `in_review` or `approved` in the manifest, in
 * `sequence` order, each
 * with its images (capture id, role and page key, left, right, then a
 * single), its decision (with the image a rejection asks to retake, its
 * `side`, and `sentAt`, when the unit first fetched a set carrying it,
 * from `capture_qc_fetches` as the Retakes screen reads them) and its
 * rotations, and `earlier` (below); the decision set's counts
 * and `revision` (0 before any decision), which the viewer sends back as
 * `expectedRevision` so a write made on an older state is refused;
 * `locked`, true once a run has started on the volume (the guard the
 * decisions route writes under, `volumeStillOpen`); `canDecide`, for an
 * unlocked volume; and `tiles`, the state of the current delivery's
 * review images, from its review runs as `readLatestReviewRuns` weighs
 * them: `none` when the federation has no review-tiles bucket or the
 * delivery has no review run (a declined start records nothing),
 * `preparing` while a run can still report, `failed` when none can and
 * none reported its tiles ready, `ready` once one reported
 * `review_ready`, and `purged` once a purge of its prefix was recorded,
 * finished or failed, which outranks every other state.
 *
 * `earlier` lets a reviewer compare a retaken opening with the images
 * that were rejected. It is set on an opening of the current delivery
 * that the latest earlier delivery (the volume's last `superseded` one,
 * by `seq`) itself rejected (`readEarlierRejections`, which the Retakes
 * screen uses too, keeping only that delivery's rejections: one an
 * older delivery made, which the latest left undecided or cleared, is
 * not compared with) when the current delivery brought
 * it back with new images (its own images' capture ids, roles, sha256
 * digests or rotations, `rotate_deg`, differ), and only while that earlier delivery's review
 * tiles can be read: one of its review runs reported `review_ready` and
 * no purge of its prefix was recorded. It names that delivery, which
 * handover of the volume it was, the images it rejected and the
 * rejection.
 *
 * Images are read by delivery in one query. The decisions, the
 * rotations, the set's counts and revision and the unit's fetches of
 * the set are read together in one D1 batch, a single transaction, so the revision always names the
 * state the decisions and rotations show: a write landing between
 * separate reads would otherwise pair older decisions with a newer
 * revision, and a later write sent on that revision would post them.
 *
 * @version v0.8.0
 */

import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  captureDeliveries,
  captureImages,
  captureQcDecisions,
  captureQcFetches,
  captureQcReviewers,
  captureQcRotations,
  captureQcSets,
  descriptions,
  pipelineVolumes,
  users,
} from "../../db/schema";
import type { Tenant, User } from "../../context";
import { unpackJson, volumeStillOpen } from "./link.server";
import { isOpening } from "./manifest";
import { isQcManager } from "./qc.server";
import { readEarlierRejections } from "./retakes.server";
import { sentAt, type DecisionFetch } from "./retakes";
import { federationHasReviewBucket, readLatestReviewRuns } from "./review-run.server";
import { personName } from "./screens.server";
import type {
  CaptureQcVolume,
  ImageRole,
  TilesState,
  ViewerEarlier,
  ViewerImage,
  ViewerOpening,
  ViewerRotation,
} from "./viewer";

const ROLE_ORDER: Record<string, number> = { left: 0, right: 1, single: 2 };

const byRole = (a: ViewerImage, b: ViewerImage) =>
  (ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3) || a.pageKey.localeCompare(b.pageKey);

interface ImageRow {
  captuaRecordId: number;
  captureId: string;
  role: string;
  pageKey: string;
  sha256: string;
  recordStatus: string | null;
  rotateDeg: number | null;
}

const imageColumns = {
  captuaRecordId: captureImages.captuaRecordId,
  captureId: captureImages.captureId,
  role: captureImages.role,
  pageKey: captureImages.pageKey,
  sha256: captureImages.captureSha256,
  recordStatus: captureImages.recordStatus,
  rotateDeg: captureImages.rotateDeg,
};

/** An opening's own images as one key, or null when it has none: what tells new images from the same ones. */
function signature(images: ImageRow[] | undefined): string | null {
  const own = (images ?? []).filter((i) => i.recordStatus !== null && isOpening(i.recordStatus));
  if (own.length === 0) return null;
  return own
    .map((i) => `${i.captureId}\u0000${i.role}\u0000${i.sha256}\u0000${i.rotateDeg ?? "exif"}`)
    .sort()
    .join("\u0001");
}

function groupByRecord(rows: ImageRow[]): Map<number, ImageRow[]> {
  const out = new Map<number, ImageRow[]>();
  for (const r of rows) {
    const list = out.get(r.captuaRecordId) ?? [];
    list.push(r);
    out.set(r.captuaRecordId, list);
  }
  return out;
}

const refuse = (status: 403 | 404) => new Response(null, { status });

/** Ids per `IN (...)` read, under D1's 100 bound parameters. */
const READ_CHUNK = 50;

/**
 * The state of a delivery's review images, from its review runs as
 * `readLatestReviewRuns` weighs them: `none` for a federation without a
 * review-tiles bucket or a delivery with no review run (a declined
 * start writes nothing), `preparing` while a run can still report,
 * `failed` when none can and none reported its tiles ready, `ready`
 * once one did, and `purged` once a purge of its prefix was recorded.
 */
async function tilesFor(db: DrizzleD1Database<any>, tenantId: string, deliveryId: string, now: number): Promise<TilesState> {
  if (!(await federationHasReviewBucket(db, tenantId))) return { state: "none" };
  const latest = (await readLatestReviewRuns(db, tenantId, [deliveryId], now)).get(deliveryId);
  if (!latest) return { state: "none" };
  if (latest.purged) return { state: "purged" };
  if (latest.state === "ready") return { state: "ready" };
  if (latest.state === "open") return { state: "preparing" };
  return { state: "failed" };
}

/**
 * One volume's current delivery for the viewer. Throws a bare 404 or
 * 403 Response as the module header describes.
 */
export async function loadCaptureQcVolume(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  volumeId: string,
  now: number,
): Promise<CaptureQcVolume> {
  const t = tenant.id;

  const volume = await db
    .select({
      id: pipelineVolumes.id,
      referenceCode: pipelineVolumes.referenceCode,
      title: descriptions.title,
    })
    .from(pipelineVolumes)
    .leftJoin(descriptions, and(eq(descriptions.tenantId, t), eq(descriptions.id, pipelineVolumes.descriptionId)))
    .where(and(eq(pipelineVolumes.tenantId, t), eq(pipelineVolumes.id, volumeId)))
    .get();
  if (!volume) throw refuse(404);

  const reviewer = await db
    .select({ id: captureQcReviewers.reviewerId, name: users.name, email: users.email })
    .from(captureQcReviewers)
    .innerJoin(users, eq(users.id, captureQcReviewers.reviewerId))
    .where(and(eq(captureQcReviewers.tenantId, t), eq(captureQcReviewers.pipelineVolumeId, volumeId)))
    .get();
  if (reviewer?.id !== user.id && !(await isQcManager(db, tenant, user))) throw refuse(403);

  const delivery = await db
    .select({
      id: captureDeliveries.id,
      seq: captureDeliveries.seq,
      records: captureDeliveries.records,
      receivedAt: captureDeliveries.receivedAt,
      rejectedRecords: captureDeliveries.rejectedRecords,
    })
    .from(captureDeliveries)
    .where(
      and(
        eq(captureDeliveries.tenantId, t),
        eq(captureDeliveries.pipelineVolumeId, volumeId),
        eq(captureDeliveries.state, "registered"),
      ),
    )
    .get();
  if (!delivery || delivery.records === null) throw refuse(404);

  const handover = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(captureDeliveries)
    .where(
      and(
        eq(captureDeliveries.tenantId, t),
        eq(captureDeliveries.pipelineVolumeId, volumeId),
        inArray(captureDeliveries.state, ["registered", "superseded"]),
        lte(captureDeliveries.seq, delivery.seq),
      ),
    )
    .get();

  // The openings, in manifest order.
  const records = JSON.parse(await unpackJson(delivery.records)) as Array<{
    captuaRecordId: number;
    sequence: number;
    status: string;
  }>;
  const openingRecords = records
    .filter((r) => isOpening(r.status))
    .sort((a, b) => a.sequence - b.sequence || a.captuaRecordId - b.captuaRecordId);

  const imageRows = groupByRecord(
    await db
      .select(imageColumns)
      .from(captureImages)
      .where(and(eq(captureImages.tenantId, t), eq(captureImages.deliveryId, delivery.id)))
      .all(),
  );

  // The decisions, their rotations, the set's counts and revision and
  // the unit's fetches of it, read in one batch, a single transaction: a
  // write landing between the reads cannot pair older decisions with a
  // newer revision.
  const deliveryId = delivery.id;
  const [decisionRows, rotationRows, setRows, fetchRows] = await db.batch([
    db
      .select({
        captuaRecordId: captureQcDecisions.captuaRecordId,
        decision: captureQcDecisions.decision,
        reason: captureQcDecisions.reason,
        side: captureQcDecisions.side,
        note: captureQcDecisions.note,
        decidedByName: captureQcDecisions.decidedByName,
        decidedAt: captureQcDecisions.decidedAt,
        setRevision: captureQcDecisions.setRevision,
      })
      .from(captureQcDecisions)
      .where(and(eq(captureQcDecisions.tenantId, t), eq(captureQcDecisions.deliveryId, deliveryId))),
    db
      .select({
        captuaRecordId: captureQcRotations.captuaRecordId,
        captureId: captureQcRotations.captureId,
        role: captureQcRotations.role,
        quarterTurns: captureQcRotations.quarterTurns,
      })
      .from(captureQcRotations)
      .where(and(eq(captureQcRotations.tenantId, t), eq(captureQcRotations.deliveryId, deliveryId))),
    db
      .select({
        approved: captureQcSets.approvedCount,
        rejected: captureQcSets.rejectedCount,
        decided: captureQcSets.decidedCount,
        revision: captureQcSets.revision,
      })
      .from(captureQcSets)
      .where(and(eq(captureQcSets.tenantId, t), eq(captureQcSets.deliveryId, deliveryId))),
    db
      .select({ setRevision: captureQcFetches.setRevision, firstFetchedAt: captureQcFetches.firstFetchedAt })
      .from(captureQcFetches)
      .where(and(eq(captureQcFetches.tenantId, t), eq(captureQcFetches.deliveryId, deliveryId))),
  ]);
  const fetches: DecisionFetch[] = fetchRows;
  const decisionOf = new Map(decisionRows.map((d) => [d.captuaRecordId, d]));
  const rotationsOf = new Map<number, ViewerRotation[]>();
  for (const r of rotationRows) {
    const list = rotationsOf.get(r.captuaRecordId) ?? [];
    list.push({ captureId: r.captureId, role: r.role as ImageRole, quarterTurns: r.quarterTurns });
    rotationsOf.set(r.captuaRecordId, list);
  }
  const set = setRows[0];

  const open = await db
    .select({ id: pipelineVolumes.id })
    .from(pipelineVolumes)
    .where(and(eq(pipelineVolumes.tenantId, t), eq(pipelineVolumes.id, volumeId), volumeStillOpen(t, volumeId, now)))
    .get();
  const locked = open === undefined;

  const earlierOf = await readEarlier(db, t, volumeId, openingRecords.map((r) => r.captuaRecordId), imageRows, now);

  const openings: ViewerOpening[] = openingRecords.map((r) => {
    const d = decisionOf.get(r.captuaRecordId);
    const images = viewerImages(imageRows.get(r.captuaRecordId));
    return {
      captuaRecordId: r.captuaRecordId,
      sequence: r.sequence,
      scannerStatus: r.status,
      images,
      decision: d
        ? {
            decision: d.decision,
            reason: d.reason ?? null,
            side: d.side ?? null,
            note: d.note ?? null,
            decidedBy: d.decidedByName,
            decidedAt: d.decidedAt,
            sentAt: sentAt(d.setRevision, fetches),
          }
        : null,
      rotations: rotationsOf.get(r.captuaRecordId) ?? [],
      earlier: earlierOf.get(r.captuaRecordId) ?? null,
    };
  });

  return {
    volume: { id: volume.id, referenceCode: volume.referenceCode, title: volume.title ?? null },
    reviewer: reviewer ? { id: reviewer.id, name: personName(reviewer.name, reviewer.email) } : null,
    delivery: {
      manifestId: delivery.id,
      handover: Number(handover?.n ?? 1),
      receivedAt: delivery.receivedAt,
      rejectedRecords: delivery.rejectedRecords,
    },
    openings,
    counts: {
      openings: openings.length,
      images: openings.reduce((n, o) => n + o.images.length, 0),
      approved: set?.approved ?? 0,
      rejected: set?.rejected ?? 0,
      decided: set?.decided ?? 0,
    },
    revision: set?.revision ?? 0,
    canDecide: !locked,
    locked,
    tiles: await tilesFor(db, t, delivery.id, now),
  };
}

/** Image rows as the viewer draws them: left, right, then a single. */
function viewerImages(rows: ImageRow[] | undefined): ViewerImage[] {
  return (rows ?? [])
    .map((i) => ({ captureId: i.captureId, role: i.role as ImageRole, pageKey: i.pageKey }))
    .sort(byRole);
}

/**
 * The earlier rejection of each of `recordIds` that the viewer can show
 * (module header): the latest earlier delivery rejected it, the current
 * delivery's images of it (`current`) are new, and the rejecting
 * delivery's review tiles are ready and not purged.
 */
async function readEarlier(
  db: DrizzleD1Database<any>,
  t: string,
  volumeId: string,
  recordIds: number[],
  current: Map<number, ImageRow[]>,
  now: number,
): Promise<Map<number, ViewerEarlier>> {
  const out = new Map<number, ViewerEarlier>();

  // Which handover of the volume each delivery was, by `seq`, and the
  // latest earlier one: the only one compared with.
  const handovers = await db
    .select({ id: captureDeliveries.id, state: captureDeliveries.state })
    .from(captureDeliveries)
    .where(
      and(
        eq(captureDeliveries.tenantId, t),
        eq(captureDeliveries.pipelineVolumeId, volumeId),
        inArray(captureDeliveries.state, ["registered", "superseded"]),
      ),
    )
    .orderBy(asc(captureDeliveries.seq))
    .all();
  const handoverOf = new Map(handovers.map((h, i) => [h.id, i + 1]));
  const latest = handovers.filter((h) => h.state === "superseded").pop()?.id;
  if (latest === undefined) return out;

  // That delivery's own rejections: a rejection by an older delivery that
  // the latest one left undecided, or cleared, is not compared with.
  const wanted = new Set(recordIds);
  const rejections = [...(await readEarlierRejections(db, t, volumeId))].filter(
    ([id, d]) => wanted.has(id) && d.deliveryId === latest,
  );
  if (rejections.length === 0) return out;

  const run = (await readLatestReviewRuns(db, t, [latest], now)).get(latest);
  if (run === undefined || run.state !== "ready" || run.purged) return out;
  const readable = [latest];

  for (const deliveryId of readable) {
    const ids = rejections.filter(([, d]) => d.deliveryId === deliveryId).map(([id]) => id);
    const earlierImages = new Map<number, ImageRow[]>();
    for (let i = 0; i < ids.length; i += READ_CHUNK) {
      const rows = await db
        .select(imageColumns)
        .from(captureImages)
        .where(
          and(
            eq(captureImages.tenantId, t),
            eq(captureImages.deliveryId, deliveryId),
            inArray(captureImages.captuaRecordId, ids.slice(i, i + READ_CHUNK)),
          ),
        )
        .all();
      for (const [id, list] of groupByRecord(rows)) earlierImages.set(id, list);
    }
    for (const [id, d] of rejections) {
      if (d.deliveryId !== deliveryId) continue;
      const before = signature(earlierImages.get(id));
      if (before === null || before === signature(current.get(id))) continue;
      out.set(id, {
        deliveryId,
        handover: handoverOf.get(deliveryId) ?? 0,
        images: viewerImages(earlierImages.get(id)?.filter((i) => i.recordStatus !== null && isOpening(i.recordStatus))),
        decision: {
          decision: "rejected",
          reason: d.reason ?? null,
          side: d.side ?? null,
          note: d.note ?? null,
          decidedBy: d.decidedByName,
          decidedAt: d.decidedAt,
        },
      });
    }
  }
  return out;
}

// @version v0.8.0
