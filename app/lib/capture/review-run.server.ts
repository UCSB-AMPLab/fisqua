/**
 * Capture QC — Starting and Following the Review Run
 *
 * This module deals with the review run: the media pipeline run, of kind
 * `review_run`, that tiles one capture delivery's images as captured
 * into its federation's review-tiles bucket, so capture QC can look at
 * them before anything is processed. Fisqua starts one when it registers
 * a delivery over the link, when a person asks for one on the Volumes
 * screen (Prepare, or Retry after a failure), and from the scheduled
 * sweep in production for a registered delivery that has none (a
 * delivery registered from a file, where no Worker runs). The review run
 * needs no gate and publishes nothing; it holds no volume, so the
 * capture QC hold and the open-run checks never see it, and the volume
 * stays in Received.
 *
 * `startReviewRun` works through a fixed sequence, and every check that
 * can decline comes before anything is written. A declined start writes
 * nothing and answers with its reason:
 *
 *   1. The tenant has the `digitization` capability (`no_capability`).
 *   2. The dispatch settings are those a processing run needs
 *      (`readDispatchSettings`; `dispatch_unconfigured` otherwise), and
 *      the runner's script version is at least `REVIEW_RUNNER_FROM`,
 *      the release that knows review runs (`runner_too_old`).
 *   3. The tenant's storage destination is complete
 *      (`destination_unset`), and its federation has a review-tiles
 *      bucket (`no_review_bucket`).
 *   4. The tenant's open runs whose token has expired are closed, as a
 *      start-run request closes them.
 *   5. The delivery is the `registered` one that holds its volume
 *      (`not_registered`) and has openings (`no_openings`); its volume
 *      is a volume run in Received that no run has named
 *      (`processing_started`) and that is not restricted (`restricted`);
 *      every page names its image and the image's digest, as many pages
 *      as the volume expects (`pages_unready`); and when any page's
 *      image carries `rotate_deg`, the runner's script version is at
 *      least `ROTATE_DEG_FROM`, the release that reads it
 *      (`rotate_deg_unsupported`). Each page's `rotate_deg` is that of
 *      the delivery's image, among its page records' images, with the
 *      page's key and master; a page two such images match is declined
 *      as `spec_invalid` with rule `page_image_ambiguous` at the page's
 *      path, a decline of the delivery's own.
 *   6. The delivery has no review run that is open (`review_open`) or
 *      that finished with its tiles ready (`review_ready`).
 *   7. The review bucket's download address is read with the share key
 *      (`shareKeyImageBaseUrl`; `image_base_unavailable` when it cannot
 *      be).
 *   8. The token is minted, the lifetimes computed for one job of the
 *      volume's pages, and the spec built (`buildReviewRunSpec`) and
 *      validated (`validateAnyRunSpec`; `spec_invalid` with each
 *      problem's path and rule otherwise). Its review prefix is
 *      `{slug}/{delivery id}/`. A page whose image carries a rotation
 *      carries `rotate_deg`, 0 included, and a page without one none.
 *   9. One claim batch inserts the run, its one chunk and its review row,
 *      each conditional on the checks of steps 5 and 6 holding inside
 *      the batch, so of two starts for one delivery only one writes. A
 *      start that wrote nothing reads why and declines with that reason.
 *  10. The spec is published; a failure abandons the run, and its review
 *      row is recorded as aborted.
 *  11. The chunk is dispatched (`postChunkDispatch`). A 204 marks the
 *      chunk and the run dispatched. Any other answer records the review
 *      row as aborted with the dispatch error, counts it as reported,
 *      marks the chunk not sent (GitHub refused it, or no token could be
 *      minted) or failed (it may have started), and closes the run if
 *      nothing is left that might report.
 *
 * A start that reached step 9 answers `started`, whatever became of the
 * dispatch: the review row then says what happened.
 *
 * `readLatestReviewRuns` reads, for each of a set of deliveries, where
 * its review runs leave it, settling on what is true whatever order the
 * runs reported in: `ready` when any run of the delivery reported
 * `review_ready`; otherwise `open` while a run can still report (its run
 * holds, open and its token unexpired, and its row waits, or was
 * recorded aborted when the dispatch request got no answer, since
 * GitHub may have started it); otherwise `failed`, from the newest run
 * (aborted, halted, or closed or expired before it reported), with when
 * it entered that state and the error its row recorded; and `purged`
 * once a purge of the delivery's prefix has been recorded on any of its
 * runs (`purge_status` `purged` or `failed`: a purge that failed may
 * still have deleted some tiles). Step 6 and the
 * claim read runs the same way, so no Retry starts beside a run that
 * may still be writing the same prefix. `federationHasReviewBucket`
 * says whether the tenant's federation has a review-tiles bucket.
 *
 * `startPendingReviewRuns` is the sweep's step. It runs only where
 * `PIPELINE_ENVIRONMENT` is `production`, and only when the dispatch
 * settings pass and the runner knows review runs. It starts the review
 * run of up to `limit` registered deliveries, oldest first. A declined
 * start records nothing, so the candidates are those a start would
 * accept as far as rows can tell: tenants with the capability, a
 * federation with a review-tiles bucket and a secret prefix, openings
 * and no review run at all, and a volume in Received that no run has
 * named, not restricted, with every page's image and digest, and, while
 * the runner is below `ROTATE_DEG_FROM`, no page whose image carries a
 * `rotate_deg`. Only the
 * federations ready for a review run are queried: with a review bucket,
 * a complete destination, the share key's secrets set, a review spec
 * built on a volume entry valid by construction that passes the spec
 * checks (`federationSpecPasses`: the review bucket distinct from the
 * other buckets, the strict endpoint and bucket rules), and the
 * download address readable, each decided once per tick before any
 * delivery is read. A start declined later counts against its delivery
 * only when its reason is the delivery's own (`declineIsPerDelivery`:
 * `PER_DELIVERY_REASONS`, or a refused spec whose problems all lie
 * under the volume entry or its job); any other reason, one added later
 * included, takes the federation out of the rest of the tick. A delivery
 * declined for a reason of its own is recorded
 * (`capture_deliveries.review_declined_at`) and left out of later ticks,
 * except for the reasons that clear up by themselves
 * (`RECONSIDERED_REASONS`), so no number of such deliveries keeps the
 * sweep from the ones behind them. A tick makes at most
 * `REVIEW_ATTEMPTS_PER_TICK` start attempts, starts and declines
 * together, which keeps its D1 queries within
 * `REVIEW_SWEEP_QUERY_CEILING` and leaves the rest of the scheduled
 * handler's budget to the other steps.
 * Each pass reads `PENDING_SCAN_FACTOR` candidates for each start still
 * to make; a declined delivery, and its federation when the reason holds
 * for all its deliveries, is excluded from the next pass, so declined
 * deliveries and federations never keep the ones behind them waiting,
 * and a tick makes at most `PENDING_MAX_PASSES` passes.
 *
 * `reviewRunAction` is the Prepare and Retry route's body. Only those
 * who pass the digitization area (workspace, super and digitization
 * admins) and the stewards of the tenant's federation may start a
 * review run
 * (a bare 403 for anyone else); the volume must be the tenant's and held
 * by a registered delivery (404 `volume_not_found`). It clears the
 * delivery's `review_declined_at` before it starts, so a delivery the
 * sweep declined can always be tried again by hand, and the sweep
 * considers it again on later ticks. A start answers 200
 * with its run id; one declined because a review run is open answers 409
 * `review_run_open`, and any other declined start 409
 * `review_not_applicable` with its reason.
 *
 * The token leaves this module only inside the stored spec. Nothing here
 * logs a token, a key or a download address.
 *
 * @version v0.8.0
 */

import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { BatchItem } from "drizzle-orm/batch";
import {
  captureDeliveries,
  captureReviewRuns,
  federations,
  pipelineRunChunks,
  pipelineRuns,
  pipelineVolumePages,
  pipelineVolumes,
  tenants,
} from "../../db/schema";
import type { Tenant, User } from "../../context";
import { hasCapability } from "../tenant";
import { isFederationSteward } from "../federation.server";
import { canAdministerArea } from "../user-access.server";
import {
  buildAbandonStatements,
  buildDispatchedStatements,
  DEFAULT_RUN_CONFIG,
  postChunkDispatch,
  readDispatchSettings,
  PAGE_IMAGE_STATUSES_SQL,
  ROTATE_DEG_FROM,
  StartRunRefusal,
  type DispatchSettings,
  type PipelineDispatchEnv,
  type PipelineRunConfig,
} from "../pipeline/dispatch.server";
import { rawBatchItem } from "../pipeline/callback.server";
import { runnerKeyStoreName } from "../pipeline/key-store";
import { closeRunIfChunksDone, expireRun } from "../pipeline/run-state.server";
import {
  RunSpecError,
  specSource,
  validateAnyRunSpec,
  type ReviewRunSpec,
  type ReviewRunSpecVolume,
} from "../pipeline/run-spec";
import {
  getPipelineSpecStore,
  pipelineKey,
  publishRunSpec,
  type PipelineSpecStore,
  type PipelineStoreEnv,
} from "../pipeline/store.server";
import {
  destinationFor,
  missingDestinationParts,
  readSecret,
  resolveTenantDestination,
  reviewShareSecretNames,
  TenantDestinationError,
  type FederationDestinationColumns,
  type TenantDestination,
} from "../pipeline/tenant-destination.server";
import { accountFor } from "./review-access.server";
import { isRotateDeg } from "./manifest";
import { mintRunToken, PRESIGN_MAX_SECONDS, runLifetimes } from "../pipeline/token.server";

/** The first runner release that knows review runs. */
export const REVIEW_RUNNER_FROM = [1, 1, 0] as const;

/** Deliveries per `IN (...)` read, under D1's 100 bound parameters. */
const READ_CHUNK = 90;

export interface ReviewRunDeps {
  db: DrizzleD1Database<any>;
  env: PipelineDispatchEnv & object;
  specStore: PipelineSpecStore;
  fetchImpl: typeof fetch;
  config: PipelineRunConfig | null;
  /**
   * The review bucket's download address for the runner's image ids,
   * `{downloadUrl}/file/{bucket}`, read with the federation's share key;
   * null when it cannot be read.
   */
  reviewImageBaseUrl: (
    destination: Pick<TenantDestination, "federationId" | "secretPrefix" | "reviewTilesBucket">,
  ) => Promise<string | null>;
  now: () => number;
  newId: () => string;
}

export type ReviewSkipReason =
  | "no_capability"
  | "dispatch_unconfigured"
  | "runner_too_old"
  | "destination_unset"
  | "no_review_bucket"
  | "not_registered"
  | "no_openings"
  | "processing_started"
  | "restricted"
  | "pages_unready"
  | "rotate_deg_unsupported"
  | "review_open"
  | "review_ready"
  | "image_base_unavailable"
  | "spec_invalid";

export type ReviewRunOutcome =
  | { started: true; runId: string }
  | { started: false; reason: ReviewSkipReason; detail?: Record<string, unknown> };

const declined = (reason: ReviewSkipReason, detail?: Record<string, unknown>): ReviewRunOutcome =>
  detail ? { started: false, reason, detail } : { started: false, reason };

/** Whether `version` (`vX.Y.Z`) is at least `from`. */
export function scriptVersionAtLeast(version: string, from: readonly [number, number, number]): boolean {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) return false;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== from[i]) return parts[i] > from[i];
  }
  return true;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function runBatch(db: DrizzleD1Database<any>, statements: BatchItem<"sqlite">[]): Promise<void> {
  if (statements.length === 0) return;
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The delivery's review run as the screens and the status call weigh it. */
export interface LatestReviewRun {
  runId: string;
  state: "open" | "ready" | "failed";
  /** When the run entered that state, in ms. */
  enteredAt: number;
  /** The error the review row recorded, as JSON text, or null. */
  error: string | null;
  /** A purge of the delivery's review prefix has started, finished or failed: its tiles are gone or going. */
  purged: boolean;
}

/** The latest review run of each of `deliveryIds`, deliveries of the tenant. */
export async function readLatestReviewRuns(
  db: DrizzleD1Database<any>,
  tenantId: string,
  deliveryIds: string[],
  now: number,
): Promise<Map<string, LatestReviewRun>> {
  const out = new Map<string, LatestReviewRun>();
  for (let i = 0; i < deliveryIds.length; i += READ_CHUNK) {
    const rows = await db
      .select({
        deliveryId: captureReviewRuns.deliveryId,
        runId: captureReviewRuns.runId,
        status: captureReviewRuns.status,
        error: captureReviewRuns.error,
        createdAt: captureReviewRuns.createdAt,
        reportedAt: captureReviewRuns.reportedAt,
        holds: sql<number>`CASE WHEN ${pipelineRuns.tokenRevokedAt} IS NULL AND ${pipelineRuns.tokenExpiresAt} > ${now} THEN 1 ELSE 0 END`,
        completedAt: pipelineRuns.completedAt,
        tokenRevokedAt: pipelineRuns.tokenRevokedAt,
        tokenExpiresAt: pipelineRuns.tokenExpiresAt,
        chunkStatus: pipelineRunChunks.status,
        purgeStatus: captureReviewRuns.purgeStatus,
      })
      .from(captureReviewRuns)
      .innerJoin(
        pipelineRuns,
        and(eq(pipelineRuns.id, captureReviewRuns.runId), eq(pipelineRuns.tenantId, tenantId)),
      )
      .leftJoin(
        pipelineRunChunks,
        and(
          eq(pipelineRunChunks.runId, captureReviewRuns.runId),
          eq(pipelineRunChunks.tenantId, tenantId),
          eq(pipelineRunChunks.chunkIndex, 0),
        ),
      )
      .where(
        and(
          eq(captureReviewRuns.tenantId, tenantId),
          inArray(captureReviewRuns.deliveryId, deliveryIds.slice(i, i + READ_CHUNK)),
        ),
      )
      .orderBy(desc(captureReviewRuns.createdAt), desc(captureReviewRuns.runId))
      .all();
    // Rows come newest first. Tiles ready on any run of the delivery
    // win; then a run that can still report; then the newest failure.
    const byDelivery = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byDelivery.get(r.deliveryId) ?? [];
      list.push(r);
      byDelivery.set(r.deliveryId, list);
    }
    for (const [deliveryId, list] of byDelivery) {
      // A purge names the delivery's prefix, which every run of it shares.
      const purged = list.some((r) => r.purgeStatus !== null);
      const ready = list.find((r) => r.status === "review_ready");
      if (ready) {
        out.set(deliveryId, {
          runId: ready.runId,
          state: "ready",
          enteredAt: ready.reportedAt ?? ready.createdAt,
          error: null,
          purged,
        });
        continue;
      }
      const open = list.find((r) => mayStillReport(r.status, Number(r.holds) === 1, r.chunkStatus));
      if (open) {
        out.set(deliveryId, { runId: open.runId, state: "open", enteredAt: open.createdAt, error: null, purged });
        continue;
      }
      const r = list[0];
      out.set(deliveryId, {
        runId: r.runId,
        state: "failed",
        enteredAt: r.reportedAt ?? r.completedAt ?? r.tokenRevokedAt ?? Math.min(r.tokenExpiresAt, now),
        error: r.error,
        purged,
      });
    }
  }
  return out;
}

/** Whether the tenant's federation records a review-tiles bucket. */
export async function federationHasReviewBucket(db: DrizzleD1Database<any>, tenantId: string): Promise<boolean> {
  const row = await db
    .select({ bucket: federations.pipelineReviewTilesBucket })
    .from(tenants)
    .innerJoin(federations, eq(federations.id, tenants.federationId))
    .where(eq(tenants.id, tenantId))
    .get();
  return typeof row?.bucket === "string" && row.bucket.trim() !== "";
}

// ---------------------------------------------------------------------------
// Guards shared by the checks and the claim
// ---------------------------------------------------------------------------

/** The delivery holds its volume, has openings, and the volume is ready for a review run. */
function deliveryReadySql(tenantId: string, deliveryId: string, volumeId: string, pagesRevision: number): SQL {
  return sql`EXISTS (SELECT 1 FROM capture_deliveries d WHERE d.tenant_id = ${tenantId} AND d.id = ${deliveryId}
      AND d.state = 'registered' AND d.pipeline_volume_id = ${volumeId} AND d.openings > 0)
    AND EXISTS (SELECT 1 FROM pipeline_volumes v WHERE v.tenant_id = ${tenantId} AND v.id = ${volumeId}
      AND v.state = 'received' AND v.restricted = 0 AND v.pages_revision = ${pagesRevision})
    AND NOT EXISTS (SELECT 1 FROM pipeline_run_volumes rv WHERE rv.tenant_id = ${tenantId} AND rv.pipeline_volume_id = ${volumeId})`;
}

/**
 * Whether a review run can still report: its run holds (open, token
 * unexpired) and its row waits, or its row was recorded aborted when
 * the dispatch request failed without an answer (chunk `failed`), since
 * GitHub may have started it anyway.
 */
function mayStillReport(status: string, holds: boolean, chunkStatus: string | null): boolean {
  return holds && (status === "dispatched" || (status === "aborted" && chunkStatus === "failed"));
}

/** The delivery has no review run that is ready or can still report (`mayStillReport`). */
function noLiveReviewSql(tenantId: string, deliveryId: string, now: number): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM capture_review_runs c JOIN pipeline_runs r ON r.id = c.run_id AND r.tenant_id = c.tenant_id
      WHERE c.tenant_id = ${tenantId} AND c.delivery_id = ${deliveryId}
      AND (c.status = 'review_ready'
        OR (r.token_revoked_at IS NULL AND r.token_expires_at > ${now}
          AND (c.status = 'dispatched'
            OR (c.status = 'aborted' AND EXISTS (SELECT 1 FROM pipeline_run_chunks k
              WHERE k.tenant_id = ${tenantId} AND k.run_id = c.run_id AND k.chunk_index = 0 AND k.status = 'failed'))))))`;
}

// ---------------------------------------------------------------------------
// The failure batches
// ---------------------------------------------------------------------------

/** The review row of a run that ended before its runner could report, recorded and counted. */
function abortReviewRowStatements(
  db: DrizzleD1Database<any>,
  args: { runId: string; tenantId: string; error: Record<string, unknown>; now: number },
): BatchItem<"sqlite">[] {
  return [
    db
      .update(pipelineRuns)
      .set({ volumesReported: sql`${pipelineRuns.volumesReported} + 1` })
      .where(
        and(
          eq(pipelineRuns.id, args.runId),
          eq(pipelineRuns.tenantId, args.tenantId),
          sql`EXISTS (SELECT 1 FROM capture_review_runs WHERE tenant_id = ${args.tenantId} AND run_id = ${args.runId} AND status = 'dispatched')`,
        ),
      ),
    db
      .update(captureReviewRuns)
      .set({ status: "aborted", error: JSON.stringify(args.error), reportedAt: args.now })
      .where(
        and(
          eq(captureReviewRuns.tenantId, args.tenantId),
          eq(captureReviewRuns.runId, args.runId),
          eq(captureReviewRuns.status, "dispatched"),
        ),
      ),
  ];
}

/** The batch after the chunk's dispatch failed. */
export function buildReviewDispatchFailureStatements(
  db: DrizzleD1Database<any>,
  f: { runId: string; tenantId: string; httpStatus: number | null; appTokenStep?: string; now: number },
): BatchItem<"sqlite">[] {
  const refused =
    f.appTokenStep !== undefined || (f.httpStatus !== null && f.httpStatus >= 400 && f.httpStatus < 500);
  const tokenFailure = f.appTokenStep === undefined ? {} : { app_token_step: f.appTokenStep };
  const error = { class: "dispatch", ...tokenFailure, chunk_index: 0, status: f.httpStatus };
  const statements: BatchItem<"sqlite">[] = [
    db
      .update(pipelineRunChunks)
      .set({
        status: refused ? "not_sent" : "failed",
        dispatchError: JSON.stringify({ ...tokenFailure, status: f.httpStatus }),
      })
      .where(
        and(
          eq(pipelineRunChunks.runId, f.runId),
          eq(pipelineRunChunks.tenantId, f.tenantId),
          eq(pipelineRunChunks.status, "pending"),
        ),
      ),
    ...abortReviewRowStatements(db, { runId: f.runId, tenantId: f.tenantId, error, now: f.now }),
    db
      .update(pipelineRuns)
      .set({ error: sql`COALESCE(${pipelineRuns.error}, ${JSON.stringify(error)})` })
      .where(and(eq(pipelineRuns.id, f.runId), eq(pipelineRuns.tenantId, f.tenantId), sql`${pipelineRuns.tokenRevokedAt} IS NULL`)),
  ];
  if (refused) {
    statements.push(
      db
        .update(pipelineRuns)
        .set({ status: "error", tokenRevokedAt: f.now })
        .where(
          and(
            eq(pipelineRuns.id, f.runId),
            eq(pipelineRuns.tenantId, f.tenantId),
            eq(pipelineRuns.status, "pending"),
            sql`${pipelineRuns.tokenRevokedAt} IS NULL`,
          ),
        ),
    );
  }
  statements.push(closeRunIfChunksDone(db, { runId: f.runId, tenantId: f.tenantId, now: f.now }));
  return statements;
}

// ---------------------------------------------------------------------------
// Starting a review run
// ---------------------------------------------------------------------------

export async function startReviewRun(
  deps: ReviewRunDeps,
  tenant: Tenant,
  deliveryId: string,
  startedBy: string | null,
): Promise<ReviewRunOutcome> {
  const { db, env } = deps;
  const tenantId = tenant.id;
  const now = deps.now();

  // 1. Capability.
  if (!hasCapability(tenant, "digitization")) return declined("no_capability");

  // 2. Settings and the runner.
  const config = deps.config;
  if (config === null) return declined("dispatch_unconfigured", { missing: ["config"] });
  let settings: Awaited<ReturnType<typeof readDispatchSettings>>;
  try {
    settings = await readDispatchSettings(env);
  } catch (err) {
    if (!(err instanceof StartRunRefusal)) throw err;
    return declined("dispatch_unconfigured", { code: err.code, ...err.detail });
  }
  if (!scriptVersionAtLeast(settings.scriptVersion, REVIEW_RUNNER_FROM)) return declined("runner_too_old");

  // 3. Destination and the review bucket.
  let destination: TenantDestination;
  try {
    destination = await resolveTenantDestination(db, tenant, env);
  } catch (err) {
    if (!(err instanceof TenantDestinationError)) throw err;
    return declined("destination_unset", { missing: err.missing });
  }
  const reviewBucket = destination.reviewTilesBucket;
  if (reviewBucket === null) return declined("no_review_bucket");

  // 4. Expired runs close.
  await expireRun(db, { tenantId }, now);

  // 5. The delivery, its volume and its pages.
  const delivery = await db
    .select({
      state: captureDeliveries.state,
      openings: captureDeliveries.openings,
      volumeId: captureDeliveries.pipelineVolumeId,
    })
    .from(captureDeliveries)
    .where(and(eq(captureDeliveries.tenantId, tenantId), eq(captureDeliveries.id, deliveryId)))
    .get();
  if (!delivery || delivery.state !== "registered" || delivery.volumeId === null) return declined("not_registered");
  if (delivery.openings <= 0) return declined("no_openings");
  const volumeId = delivery.volumeId;
  const volume = await db
    .select()
    .from(pipelineVolumes)
    .where(and(eq(pipelineVolumes.tenantId, tenantId), eq(pipelineVolumes.id, volumeId)))
    .get();
  if (!volume) return declined("not_registered");
  const named = await db.get<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM pipeline_run_volumes WHERE tenant_id = ${tenantId} AND pipeline_volume_id = ${volumeId}`,
  );
  if (volume.state !== "received" || volume.kind !== "volume_run" || Number(named?.n ?? 0) > 0) {
    return declined("processing_started");
  }
  if (volume.restricted) return declined("restricted");
  // Each page with the images of this delivery's page records that
  // match its key and master, counted, and their `rotate_deg`, read in
  // the same query. A rejected record's image is never a page.
  const pageImages = sql`FROM capture_images ci
        WHERE ci.tenant_id = ${tenantId} AND ci.delivery_id = ${deliveryId}
          AND ci.record_status IN ${sql.raw(PAGE_IMAGE_STATUSES_SQL)}
          AND ci.page_key = ${pipelineVolumePages.pageKey}
          AND COALESCE(ci.preview_key, ci.capture_key) = ${pipelineVolumePages.masterKey}`;
  const pages = await db
    .select({
      seq: pipelineVolumePages.seq,
      pageKey: pipelineVolumePages.pageKey,
      masterKey: pipelineVolumePages.masterKey,
      sha256: pipelineVolumePages.sha256,
      images: sql<number>`(SELECT COUNT(*) ${pageImages})`,
      rotateDeg: sql<number | null>`(SELECT MAX(ci.rotate_deg) ${pageImages})`,
    })
    .from(pipelineVolumePages)
    .where(and(eq(pipelineVolumePages.tenantId, tenantId), eq(pipelineVolumePages.pipelineVolumeId, volumeId)))
    .orderBy(asc(pipelineVolumePages.seq))
    .all();
  if (
    pages.length === 0 ||
    pages.length !== volume.expectedCount ||
    pages.some((p) => p.masterKey === null || p.sha256 === null)
  ) {
    return declined("pages_unready");
  }
  // A page two page images match has no one rotation to send.
  const ambiguous = pages.flatMap((p, i) =>
    Number(p.images) > 1 ? [{ path: `volumes.0.pages.${i}`, rule: "page_image_ambiguous" }] : [],
  );
  if (ambiguous.length > 0) return declined("spec_invalid", { problems: ambiguous });
  if (pages.some((p) => p.rotateDeg !== null) && !scriptVersionAtLeast(settings.scriptVersion, ROTATE_DEG_FROM)) {
    return declined("rotate_deg_unsupported");
  }

  // 6. No review run open or ready for the delivery.
  const live = await liveReview(db, tenantId, deliveryId, now);
  if (live) return declined(live);

  // 7. The download address.
  const imageBaseUrl = await deps.reviewImageBaseUrl(destination);
  if (imageBaseUrl === null) return declined("image_base_unavailable");

  // 8. Token, lifetimes, spec.
  const lifetimes = runLifetimes(
    now,
    { totalImages: pages.length, jobImageCounts: [pages.length], chunkCount: 1 },
    config.lifetime,
  );
  if (Math.ceil((lifetimes.specUrlExpiresAt - now) / 1000) > PRESIGN_MAX_SECONDS) {
    return declined("spec_invalid", { problems: [{ path: "volumes.0.pages", rule: "run_too_long" }] });
  }
  const runId = deps.newId();
  const minted = await mintRunToken();
  const reviewPrefix = `${tenant.slug}/${deliveryId}/`;
  const spec = buildReviewRunSpec({
    runId,
    tenantId,
    createdAt: now,
    settings,
    env,
    token: minted.token,
    tokenExpiresAt: lifetimes.tokenExpiresAt,
    destination,
    reviewBucket,
    imageBaseUrl,
    volume: {
      volume_id: volumeId,
      reference_code: volume.referenceCode,
      restricted: false,
      expected_count: volume.expectedCount,
      review_prefix: reviewPrefix,
      pages: pages.map((p) => ({
        seq: p.seq,
        page_key: p.pageKey,
        master_key: p.masterKey as string,
        sha256: p.sha256 as string,
        ...(isRotateDeg(p.rotateDeg) ? { rotate_deg: p.rotateDeg } : {}),
      })),
      source: specSource("volume_run", volume, 0) as ReviewRunSpecVolume["source"],
    },
  });
  try {
    validateAnyRunSpec(spec);
  } catch (err) {
    if (!(err instanceof RunSpecError)) throw err;
    return declined("spec_invalid", { problems: err.problems.map((p) => ({ path: p.path, rule: p.rule })) });
  }
  const specJson = JSON.stringify(spec);
  const specSha256 = await sha256Hex(specJson);

  // 9. The claim.
  const guard = sql`${deliveryReadySql(tenantId, deliveryId, volumeId, volume.pagesRevision)} AND ${noLiveReviewSql(tenantId, deliveryId, now)}`;
  await runBatch(db, [
    rawBatchItem(
      db,
      sql`INSERT INTO pipeline_runs (id, tenant_id, federation_id, user_id, kind, purpose, regenerates_run_id, status,
          runner_image, script_version, arch, max_review_frac, spec_key, spec_sha256, spec_url_expires_at, chunk_count,
          volume_count, volumes_reported, callback_token_hash, token_expires_at, created_at)
        SELECT ${runId}, ${tenantId}, ${tenant.federationId ?? null}, ${startedBy}, 'review_run', NULL, NULL, 'pending',
          ${settings.runnerImage}, ${settings.scriptVersion}, 'x64', 1, ${pipelineKey.spec(tenantId, runId)}, ${specSha256},
          ${lifetimes.specUrlExpiresAt}, 1, 1, 0, ${minted.hash}, ${lifetimes.tokenExpiresAt}, ${now}
        WHERE ${guard} AND NOT EXISTS (SELECT 1 FROM pipeline_runs WHERE tenant_id = ${tenantId} AND id = ${runId})`,
    ),
    rawBatchItem(
      db,
      sql`INSERT INTO pipeline_run_chunks (id, run_id, tenant_id, chunk_index, status, created_at)
        SELECT ${deps.newId()}, ${runId}, ${tenantId}, 0, 'pending', ${now}
        WHERE EXISTS (SELECT 1 FROM pipeline_runs WHERE tenant_id = ${tenantId} AND id = ${runId})`,
    ),
    rawBatchItem(
      db,
      sql`INSERT INTO capture_review_runs (tenant_id, run_id, delivery_id, pipeline_volume_id, review_prefix, status, created_at)
        SELECT ${tenantId}, ${runId}, ${deliveryId}, ${volumeId}, ${reviewPrefix}, 'dispatched', ${now}
        WHERE EXISTS (SELECT 1 FROM pipeline_runs WHERE tenant_id = ${tenantId} AND id = ${runId})`,
    ),
  ]);
  const claimed = await db
    .select({ id: pipelineRuns.id })
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.tenantId, tenantId)))
    .get();
  if (!claimed) return declined(await lostClaimReason(db, tenantId, deliveryId, deps.now()));

  // 10. The spec.
  let specUrl: string;
  try {
    const published = await publishRunSpec(deps.specStore, tenantId, runId, specJson, lifetimes.specUrlExpiresAt, now);
    if (published.sha256 !== specSha256) throw new Error("The stored spec's SHA-256 does not match the spec built");
    specUrl = published.url;
  } catch (err) {
    const at = deps.now();
    await runBatch(db, [
      ...abortReviewRowStatements(db, { runId, tenantId, error: { class: "dispatch", stage: "spec_store" }, now: at }),
      ...buildAbandonStatements(db, { runId, tenantId, stage: "spec_store", now: at }),
    ]);
    console.warn(`review run ${runId}: the spec could not be stored (${err instanceof Error ? err.name : "error"})`);
    return { started: true, runId };
  }

  // 11. The dispatch.
  const result = await postChunkDispatch(env, deps.fetchImpl, deps.now(), { runId, specUrl, chunkIndex: 0, chunkCount: 1 });
  if (result.sent && result.httpStatus === 204) {
    await runBatch(db, buildDispatchedStatements(db, { runId, tenantId, chunkIndex: 0, now: deps.now() }));
  } else {
    await runBatch(
      db,
      buildReviewDispatchFailureStatements(db, {
        runId,
        tenantId,
        httpStatus: result.httpStatus,
        ...(result.sent ? {} : { appTokenStep: result.appTokenStep }),
        now: deps.now(),
      }),
    );
  }
  return { started: true, runId };
}

/** The inputs of a review run's spec. */
interface ReviewSpecInput {
  runId: string;
  tenantId: string;
  createdAt: number;
  settings: DispatchSettings;
  env: PipelineDispatchEnv;
  token: string;
  tokenExpiresAt: number;
  destination: TenantDestination;
  reviewBucket: string;
  imageBaseUrl: string;
  volume: ReviewRunSpecVolume;
}

/** A review run's spec for one volume entry. Pure: it builds, it does not validate. */
function buildReviewRunSpec(i: ReviewSpecInput): ReviewRunSpec {
  const origin = (i.env.PIPELINE_CALLBACK_ORIGIN as string).replace(/\/+$/, "");
  const runBase = `${origin}/api/pipeline/runs/${i.runId}`;
  return {
    spec_version: 1,
    run_id: i.runId,
    tenant_id: i.tenantId,
    kind: "review_run",
    created_at: new Date(i.createdAt).toISOString(),
    regenerates_run_id: null,
    runner: { image: i.settings.runnerImage, script_version: i.settings.scriptVersion, arch: "x64" },
    callback: {
      url_template: `${runBase}/volumes/{volume_id}/callback`,
      complete_url: `${runBase}/complete`,
      token_expires_at: new Date(i.tokenExpiresAt).toISOString(),
      token: i.token,
    },
    max_review_frac: 1,
    destination: {
      backend: "b2",
      endpoint: i.destination.deliveryEndpoint,
      tiles_bucket: i.destination.tilesBucket,
      tiles_prefix: i.destination.tilesPrefix,
      image_base_url: i.destination.imageBaseUrl,
      ocr_bucket: i.destination.tilesBucket,
      ocr_prefix: i.destination.ocrPrefix,
      credentials_ref: runnerKeyStoreName(i.tenantId, i.settings.environment),
    },
    working: {
      backend: "b2",
      endpoint: i.env.PIPELINE_WORKING_S3_ENDPOINT as string,
      bucket: i.env.PIPELINE_WORKING_BUCKET as string,
      prefix: pipelineKey.workingPrefix(i.tenantId, i.runId),
    },
    review: {
      backend: "b2",
      endpoint: i.destination.deliveryEndpoint,
      bucket: i.reviewBucket,
      image_base_url: i.imageBaseUrl,
    },
    jobs: [{ job_index: 0, volume_ids: [i.volume.volume_id] }],
    volumes: [i.volume],
  };
}

/**
 * The declines that depend on the delivery or its volume alone. Every
 * other reason, including one added later, holds for the whole
 * federation (`declineIsPerDelivery`).
 */
const PER_DELIVERY_REASONS: ReadonlySet<string> = new Set<ReviewSkipReason>([
  "not_registered",
  "no_openings",
  "processing_started",
  "restricted",
  "pages_unready",
  "rotate_deg_unsupported",
  "review_open",
  "review_ready",
]);

/**
 * Whether a declined start says something about this delivery only, so
 * the sweep can go on to the federation's other deliveries. A spec the
 * checks refused is the delivery's when every problem lies under its
 * volume entry or the job naming it; a problem anywhere else (the
 * review block, the destination, the working space, the top level)
 * comes from the federation's or the deployment's settings.
 */
export function declineIsPerDelivery(outcome: { reason: string; detail?: Record<string, unknown> }): boolean {
  if (PER_DELIVERY_REASONS.has(outcome.reason)) return true;
  if (outcome.reason !== "spec_invalid") return false;
  const problems = outcome.detail?.problems;
  if (!Array.isArray(problems) || problems.length === 0) return false;
  return problems.every((p) => {
    const path = typeof p?.path === "string" ? p.path : "";
    return path === "volumes" || path.startsWith("volumes.") || path === "jobs" || path.startsWith("jobs.");
  });
}

async function liveReview(
  db: DrizzleD1Database<any>,
  tenantId: string,
  deliveryId: string,
  now: number,
): Promise<"review_open" | "review_ready" | null> {
  const latest = (await readLatestReviewRuns(db, tenantId, [deliveryId], now)).get(deliveryId);
  if (latest?.state === "ready") return "review_ready";
  return latest?.state === "open" ? "review_open" : null;
}

/** Why a claim wrote nothing: read again after the batch. */
async function lostClaimReason(
  db: DrizzleD1Database<any>,
  tenantId: string,
  deliveryId: string,
  now: number,
): Promise<ReviewSkipReason> {
  const live = await liveReview(db, tenantId, deliveryId, now);
  if (live) return live;
  const delivery = await db
    .select({ state: captureDeliveries.state, openings: captureDeliveries.openings })
    .from(captureDeliveries)
    .where(and(eq(captureDeliveries.tenantId, tenantId), eq(captureDeliveries.id, deliveryId)))
    .get();
  if (!delivery || delivery.state !== "registered") return "not_registered";
  if (delivery.openings <= 0) return "no_openings";
  return "processing_started";
}

// ---------------------------------------------------------------------------
// The review bucket's download address
// ---------------------------------------------------------------------------

/**
 * `{downloadUrl}/file/{bucket}`: the address B2 serves the review bucket
 * from, read with the federation's share key through the account the
 * capture QC viewer's access route caches (`accountFor`), so an isolate
 * holds one account token per federation. The runner writes each
 * page's info.json `id` as this address, then the delivery's review
 * prefix without its final slash, then the page key, so the id is the
 * page's B2 download URL `{downloadUrl}/file/{bucket}/{slug}/{delivery}/{page}`.
 * Null when the key's secrets are not set or B2 does not authorise it;
 * the address itself is never logged.
 */
export async function shareKeyImageBaseUrl(
  env: object,
  deps: { fetch: typeof fetch; now: () => number },
  destination: Pick<TenantDestination, "federationId" | "secretPrefix" | "reviewTilesBucket">,
): Promise<string | null> {
  if (destination.reviewTilesBucket === null) return null;
  const names = reviewShareSecretNames(destination.secretPrefix);
  const keyId = readSecret(env, names.keyId);
  const secretKey = readSecret(env, names.secretKey);
  if (!keyId || !secretKey) return null;
  try {
    const account = await accountFor(deps, destination.federationId, { keyId, secretKey }, []);
    if (!account) return null;
    return `${account.downloadUrl.replace(/\/+$/, "")}/file/${destination.reviewTilesBucket}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The dependencies the routes and the sweep build
// ---------------------------------------------------------------------------

/**
 * A start's dependencies from the Worker's environment: the run
 * configuration a processing run uses, the spec store, the global
 * `fetch`, and the review bucket's download address read with the
 * federation's share key (`shareKeyImageBaseUrl`).
 */
export function reviewRunDepsFor(env: PipelineDispatchEnv & PipelineStoreEnv & { DB: D1Database }): ReviewRunDeps {
  const fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  return {
    db: drizzle(env.DB),
    env,
    specStore: {
      putSpec: (key, json) => getPipelineSpecStore(env).putSpec(key, json),
      presignGet: (key, expiresAt, now) => getPipelineSpecStore(env).presignGet(key, expiresAt, now),
    },
    fetchImpl,
    config: DEFAULT_RUN_CONFIG,
    reviewImageBaseUrl: (destination) => shareKeyImageBaseUrl(env, { fetch: fetchImpl, now: () => Date.now() }, destination),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
  };
}

// ---------------------------------------------------------------------------
// The Prepare and Retry route
// ---------------------------------------------------------------------------

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function reviewRunAction(
  deps: ReviewRunDeps,
  request: Request,
  volumeId: string,
  tenant: Tenant,
  user: User,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const { db } = deps;
  if (!(canAdministerArea(user, "digitization") || (await isFederationSteward(db, user, tenant)))) {
    throw new Response(null, { status: 403 });
  }
  const holder = await db
    .select({ id: captureDeliveries.id })
    .from(captureDeliveries)
    .where(
      and(
        eq(captureDeliveries.tenantId, tenant.id),
        eq(captureDeliveries.pipelineVolumeId, volumeId),
        eq(captureDeliveries.state, "registered"),
      ),
    )
    .get();
  if (!holder) return answer(404, { error: "volume_not_found" });
  // A person may always try again a delivery the sweep declined.
  await db
    .update(captureDeliveries)
    .set({ reviewDeclinedAt: null })
    .where(and(eq(captureDeliveries.tenantId, tenant.id), eq(captureDeliveries.id, holder.id)));
  const outcome = await startReviewRun(deps, tenant, holder.id, user.id);
  if (outcome.started) return answer(200, { runId: outcome.runId });
  if (outcome.reason === "review_open") return answer(409, { error: "review_run_open" });
  return answer(409, { error: "review_not_applicable", reason: outcome.reason });
}

// ---------------------------------------------------------------------------
// The sweep's step
// ---------------------------------------------------------------------------

export interface PendingReviewCounts {
  started: number;
  declined: number;
}

/** Starts the review runs of registered deliveries that have none, in production only. */
export async function startPendingReviewRuns(
  deps: ReviewRunDeps,
  opts: { limit?: number; maxAttempts?: number } = {},
): Promise<PendingReviewCounts> {
  const counts: PendingReviewCounts = { started: 0, declined: 0 };
  const { env } = deps;
  if (env.PIPELINE_ENVIRONMENT !== "production") return counts;
  // Settings no start could pass end the step before anything is read.
  let settings: DispatchSettings;
  try {
    settings = await readDispatchSettings(env);
  } catch (err) {
    if (err instanceof StartRunRefusal) return counts;
    throw err;
  }
  if (!scriptVersionAtLeast(settings.scriptVersion, REVIEW_RUNNER_FROM)) return counts;
  const limit = opts.limit ?? 10;

  // Every condition that holds for a whole federation is decided once,
  // on the list of federations, before any delivery is read: a review
  // bucket, a complete destination (`missingDestinationParts`, the check
  // `startReviewRun` makes through `resolveTenantDestination`), the share
  // key's secrets, and a readable download address, one account read per
  // federation through the cached `accountFor`. Only the federations that
  // pass are queried, so a federation that cannot start costs no pass.
  const readyFederations = await federationsReadyForReview(deps, settings);
  if (readyFederations.size === 0) return counts;

  // Each pass reads the oldest candidates of the ready federations
  // outside what earlier passes excluded: any delivery a start declined,
  // and a federation whose start is declined for a reason that holds for
  // all its deliveries (which the check above makes rare). A
  // pass that starts nothing excludes at least one more, so the tick
  // ends when its starts are spent, no candidate is left, or after
  // `PENDING_MAX_PASSES` passes.
  const excludedDeliveries = new Set<string>();
  const maxAttempts = opts.maxAttempts ?? REVIEW_ATTEMPTS_PER_TICK;
  let attempts = 0;
  for (let pass = 0; pass < PENDING_MAX_PASSES && counts.started < limit && attempts < maxAttempts; pass++) {
    const pending = await readPendingDeliveries(
      deps.db,
      [...readyFederations],
      [...excludedDeliveries],
      Math.min(limit - counts.started, maxAttempts - attempts) * PENDING_SCAN_FACTOR,
      scriptVersionAtLeast(settings.scriptVersion, ROTATE_DEG_FROM),
    );
    if (pending.length === 0) break;
    for (const p of pending) {
      if (counts.started >= limit || attempts >= maxAttempts) break;
      if (!readyFederations.has(p.federationId)) continue;
      const tenant = await deps.db.select().from(tenants).where(eq(tenants.id, p.tenantId)).get();
      if (!tenant) {
        excludedDeliveries.add(p.deliveryId);
        continue;
      }
      attempts++;
      const outcome = await startReviewRun(deps, tenant, p.deliveryId, null);
      if (outcome.started) {
        counts.started++;
        continue;
      }
      counts.declined++;
      excludedDeliveries.add(p.deliveryId);
      if (!declineIsPerDelivery(outcome)) {
        readyFederations.delete(p.federationId);
      } else if (!RECONSIDERED_REASONS.has(outcome.reason)) {
        // Declined for good: later ticks leave it out until a person
        // prepares or retries it.
        await deps.db
          .update(captureDeliveries)
          .set({ reviewDeclinedAt: deps.now() })
          .where(
            and(
              eq(captureDeliveries.tenantId, p.tenantId),
              eq(captureDeliveries.id, p.deliveryId),
              eq(captureDeliveries.state, "registered"),
              isNull(captureDeliveries.reviewDeclinedAt),
            ),
          );
      }
    }
  }
  return counts;
}

/**
 * The oldest registered deliveries a start would accept as far as rows
 * can tell (module header), of the federations ready and outside the
 * deliveries excluded. The two lists are bound as one JSON text each, so their
 * length never meets D1's bound-parameter limit. Unless the runner reads
 * `rotate_deg`, a delivery with a page whose image carries one is left
 * out, as `startReviewRun` would decline it.
 */
async function readPendingDeliveries(
  db: DrizzleD1Database<any>,
  readyFederations: string[],
  excludedDeliveries: string[],
  limit: number,
  readsRotateDeg: boolean,
): Promise<Array<{ tenantId: string; deliveryId: string; federationId: string }>> {
  return db
    .select({
      tenantId: captureDeliveries.tenantId,
      deliveryId: captureDeliveries.id,
      federationId: federations.id,
    })
    .from(captureDeliveries)
    .innerJoin(tenants, eq(tenants.id, captureDeliveries.tenantId))
    .innerJoin(federations, eq(federations.id, tenants.federationId))
    .where(
      and(
        eq(captureDeliveries.state, "registered"),
        isNull(captureDeliveries.reviewDeclinedAt),
        sql`${federations.pipelineReviewTilesBucket} IS NOT NULL`,
        sql`${federations.storageSecretPrefix} IS NOT NULL`,
        sql`${federations.id} IN (SELECT value FROM json_each(${JSON.stringify(readyFederations)}))`,
        sql`${captureDeliveries.id} NOT IN (SELECT value FROM json_each(${JSON.stringify(excludedDeliveries)}))`,
        sql`${captureDeliveries.openings} > 0`,
        sql`${captureDeliveries.pipelineVolumeId} IS NOT NULL`,
        eq(tenants.digitizationEnabled, true),
        sql`NOT EXISTS (SELECT 1 FROM capture_review_runs c WHERE c.tenant_id = ${captureDeliveries.tenantId} AND c.delivery_id = ${captureDeliveries.id})`,
        sql`NOT EXISTS (SELECT 1 FROM pipeline_run_volumes rv WHERE rv.tenant_id = ${captureDeliveries.tenantId} AND rv.pipeline_volume_id = ${captureDeliveries.pipelineVolumeId})`,
        sql`EXISTS (SELECT 1 FROM pipeline_volumes v WHERE v.tenant_id = ${captureDeliveries.tenantId} AND v.id = ${captureDeliveries.pipelineVolumeId}
          AND v.state = 'received' AND v.kind = 'volume_run' AND v.restricted = 0
          AND v.expected_count = (SELECT COUNT(*) FROM pipeline_volume_pages p WHERE p.tenant_id = ${captureDeliveries.tenantId} AND p.pipeline_volume_id = v.id))`,
        sql`NOT EXISTS (SELECT 1 FROM pipeline_volume_pages p WHERE p.tenant_id = ${captureDeliveries.tenantId}
          AND p.pipeline_volume_id = ${captureDeliveries.pipelineVolumeId} AND (p.master_key IS NULL OR p.sha256 IS NULL))`,
        readsRotateDeg
          ? undefined
          : sql`NOT EXISTS (SELECT 1 FROM capture_images ci JOIN pipeline_volume_pages p
              ON p.tenant_id = ci.tenant_id AND p.pipeline_volume_id = ${captureDeliveries.pipelineVolumeId}
                AND p.page_key = ci.page_key AND p.master_key = COALESCE(ci.preview_key, ci.capture_key)
              WHERE ci.tenant_id = ${captureDeliveries.tenantId} AND ci.delivery_id = ${captureDeliveries.id}
                AND ci.record_status IN ${sql.raw(PAGE_IMAGE_STATUSES_SQL)} AND ci.rotate_deg IS NOT NULL)`,
      ),
    )
    .orderBy(asc(captureDeliveries.receivedAt), asc(captureDeliveries.id))
    .limit(limit)
    .all();
}

/**
 * The federations whose review runs could start now: a review bucket, a
 * complete destination, the share key's secrets set, and the download
 * address readable with that key.
 */
async function federationsReadyForReview(deps: ReviewRunDeps, settings: DispatchSettings): Promise<Set<string>> {
  const rows = await deps.db
    .select({
      id: federations.id,
      pipelineDeliveryEndpoint: federations.pipelineDeliveryEndpoint,
      pipelineTilesBucket: federations.pipelineTilesBucket,
      pipelineMastersBucket: federations.pipelineMastersBucket,
      pipelineImageBaseUrl: federations.pipelineImageBaseUrl,
      manifestEndpoint: federations.manifestEndpoint,
      manifestBucket: federations.manifestBucket,
      manifestBaseUrl: federations.manifestBaseUrl,
      storageSecretPrefix: federations.storageSecretPrefix,
      pipelineReviewTilesBucket: federations.pipelineReviewTilesBucket,
    })
    .from(federations)
    .where(sql`${federations.pipelineReviewTilesBucket} IS NOT NULL`)
    .all();
  const ready = new Set<string>();
  for (const f of rows) {
    if (missingDestinationParts(f, deps.env).length > 0) continue;
    const prefix = f.storageSecretPrefix as string;
    const names = reviewShareSecretNames(prefix);
    if (!readSecret(deps.env, names.keyId) || !readSecret(deps.env, names.secretKey)) continue;
    if (!federationSpecPasses(f, deps.env, settings)) continue;
    const address = await deps.reviewImageBaseUrl({
      federationId: f.id,
      secretPrefix: prefix,
      reviewTilesBucket: f.pipelineReviewTilesBucket,
    });
    if (address !== null) ready.add(f.id);
  }
  return ready;
}

/**
 * Whether a review run's spec for this federation passes the checks, on
 * a volume entry that is valid by construction: one page under the
 * federation's masters bucket. Any problem then lies in the
 * federation's settings or the deployment's (the review bucket the same
 * as the tiles, working or masters bucket, a destination endpoint or
 * bucket the strict rules refuse), and the federation can start no
 * review run.
 */
function federationSpecPasses(
  f: FederationDestinationColumns,
  env: PipelineDispatchEnv & object,
  settings: DispatchSettings,
): boolean {
  let destination: TenantDestination;
  try {
    destination = destinationFor({ id: PREFLIGHT_ID, slug: PREFLIGHT_ID }, f, env);
  } catch (err) {
    if (err instanceof TenantDestinationError) return false;
    throw err;
  }
  const spec = buildReviewRunSpec({
    runId: PREFLIGHT_ID,
    tenantId: PREFLIGHT_ID,
    createdAt: 0,
    settings,
    env,
    token: PREFLIGHT_ID,
    tokenExpiresAt: 0,
    destination,
    reviewBucket: f.pipelineReviewTilesBucket as string,
    imageBaseUrl: "https://preflight.invalid",
    volume: {
      volume_id: PREFLIGHT_ID,
      reference_code: PREFLIGHT_ID,
      restricted: false,
      expected_count: 1,
      review_prefix: `${PREFLIGHT_ID}/${PREFLIGHT_ID}/`,
      pages: [{ seq: 1, page_key: "p0001", master_key: `${PREFLIGHT_ID}/v/p0001.jpg`, sha256: "0".repeat(64) }],
      source: {
        backend: "b2",
        endpoint: destination.deliveryEndpoint,
        bucket: f.pipelineMastersBucket as string,
        prefix: `${PREFLIGHT_ID}/v/`,
        checksums_key: null,
      },
    },
  });
  try {
    validateAnyRunSpec(spec);
    return true;
  } catch (err) {
    if (err instanceof RunSpecError) return false;
    throw err;
  }
}

/** The ids and keys the preflight spec carries; it is never stored or sent. */
const PREFLIGHT_ID = "preflight";

/**
 * Per-delivery declines the sweep does not record, because they clear
 * up by themselves: a page list still being written (`pages_unready`,
 * which the candidate query's own page check already leaves out), a
 * page rotation the runner does not yet read (`rotate_deg_unsupported`,
 * which the candidate query leaves out while the runner is below
 * `ROTATE_DEG_FROM`, and which clears when the runner is moved), and a
 * review run of the delivery that is open or ready, which the query's
 * "no review run" condition leaves out once it is written.
 */
const RECONSIDERED_REASONS: ReadonlySet<string> = new Set<ReviewSkipReason>([
  "pages_unready",
  "rotate_deg_unsupported",
  "review_open",
  "review_ready",
]);

/** The most passes one tick makes over the candidates. */
const PENDING_MAX_PASSES = 5;

/**
 * The most start attempts, starts and declines together, one tick makes.
 *
 * D1 allows 1,000 queries per Worker invocation, and the scheduled
 * handler's other steps share that budget. Counted against D1 in the
 * tests, a start attempt costs at most 18 queries, on its most expensive
 * path: one whose dispatch fails (the tenant read, the reads of steps 4
 * to 6, the claim batch of 3 and the read back, 12 in all, then the
 * failure batch of 6). A start whose dispatch succeeds costs 14 (the
 * dispatched batch is 2), and a decline that is recorded costs 9. Each
 * pass reads its candidates once, and the federation preflight runs
 * once per tick. Ten attempts therefore cost at most
 * 10 × 18 + 5 (`PENDING_MAX_PASSES`) + 1 = 186 queries
 * (`REVIEW_SWEEP_QUERY_CEILING`). The pipeline sweep before it makes at
 * most about 590 (token expiry 1; flag ingest up to 400 insert
 * statements, plus about 3 reads and 1 update for each of its 20 rows;
 * stalled publications 1 read plus about 6 for each of 20 rows), which
 * leaves the notification sweep after it about 224. Declined deliveries
 * are recorded (`review_declined_at`), so a backlog of them clears at
 * ten a tick.
 */
export const REVIEW_ATTEMPTS_PER_TICK = 10;

/** The most D1 queries one start attempt makes, on its most expensive path (above). */
const REVIEW_ATTEMPT_MAX_QUERIES = 18;

/** The most D1 queries one tick of the review run step makes (above). */
export const REVIEW_SWEEP_QUERY_CEILING = REVIEW_ATTEMPTS_PER_TICK * REVIEW_ATTEMPT_MAX_QUERIES + PENDING_MAX_PASSES + 1;


/** How many candidates a tick reads for each start it may make. */
const PENDING_SCAN_FACTOR = 5;


// @version v0.8.0
