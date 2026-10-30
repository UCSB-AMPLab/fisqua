/**
 * Media Pipeline — Callback Handler
 *
 * This module deals with the per-volume report the media pipeline
 * runner posts after each volume it processes: the only request Fisqua
 * accepts from a machine rather than from a signed-in person. The route
 * that receives it sits outside tenant routing and runs no session
 * middleware, so everything that protects it is here.
 *
 * `requirePipelineOrigin` limits the route to the host named by
 * `PIPELINE_CALLBACK_ORIGIN` (the apex host). On any other host, or
 * with the setting unset, every method gets a bare 404, the answer of a
 * route that does not exist. The tenant never comes from the host: it
 * comes from the run row.
 *
 * `handleVolumeCallback` then works through a fixed sequence, and every
 * early return writes nothing except the expiry close in step 6:
 *
 *   1. Methods other than POST get 405 before the body is read.
 *   2. A body over 1 MB, declared or streamed, is refused.
 *   3. The run is read by the id in the path, from any tenant.
 *   4. The bearer token is checked against the run's stored hash in
 *      constant time; an unknown run costs the same work as a wrong
 *      token and gets the same 401.
 *   5. An exact replay — the stored idempotency key and the same body
 *      hash — gets the stored response, whatever has happened since.
 *   6. An expired token closes the run (`expireRun`) and gets 401
 *      `token_expired`, whatever the request names.
 *   7. A closed run gets 409 `run_closed`; a volume not in the run gets
 *      404. A halted run that is still open keeps recording volumes.
 *   8. The body is validated, and its run, volume and idempotency key
 *      must match the path and the headers.
 *   9. The manifest and report keys must be exactly this volume's
 *      `manifest.json` and `report.json` under the run's working
 *      prefix, and the tile root must be the run volume's own, so the
 *      later publish action and the flag read cannot be steered to
 *      other objects.
 *  10. A new attempt replaces a stored `aborted` or `halted` report and
 *      is refused after `prepared` or `review_pending`; the same key
 *      with a different body is refused.
 *  11. A volume moving to Prepared must still be in Received.
 *  12. One D1 batch writes the report and its effects. Statement a
 *      claims the run-volume row with a fresh `claim_id`, conditional on
 *      the claim and status read in step 10, the run being open and,
 *      where the volume moves, the volume being in Received. Every
 *      later statement is guarded by that claim, so a concurrent
 *      duplicate, a competing attempt or a run that closed in between
 *      makes the whole batch a no-op. `buildCallbackStatements` builds
 *      the batch as a pure function so its statement and parameter
 *      counts can be checked.
 *  13. The row is read back: the winner returns the response the batch
 *      stored; a concurrent identical request returns the same stored
 *      response; anything else gets 409.
 *  14. When the flag list was truncated, the rest of the flags are read
 *      from the run report in the background.
 *
 * A per-volume callback never closes a run; the chunk-complete report
 * and token expiry do.
 *
 * A processing report may carry `review_purge`, what became of the
 * review prefixes the spec asked the runner to delete. Statement a
 * stores it on the run volume as it came, and, unless the purge was not
 * reached, the same batch gives each review row of the volume whose
 * prefix it names its result (`capture_review_runs.purge_status`):
 * `failed` when the report names the prefix among its failures, `purged`
 * with the time otherwise. A row already purged stays purged.
 *
 * A review run (kind `review_run`) reports on the same route. After the
 * token check (step 4) its report goes to `handleReviewCallback`, which
 * runs steps 5 to 13 against the run's review row instead of a run
 * volume: the body is a `reviewCallbackBodySchema` report; its review
 * prefix must be the one the row recorded and its report key the
 * volume's `report.json` under the run's working prefix; a new attempt
 * replaces an `aborted` or `halted` report and is refused after
 * `review_ready`. Its batch (`buildReviewCallbackStatements`) writes the
 * review row, moves the run to running, counts the volume once and
 * halts the run on a systemic error. It writes nothing to the volume or
 * to `pipeline_run_volumes`, so a review run holds no volume and
 * releases no capture QC hold.
 *
 * `handleChunkComplete` receives the report a chunk's completion job
 * posts once every job in its chunk has ended. It shares steps 1 to 4
 * with the per-volume callback, answers an exact replay (the stored
 * key and body hash on one of the run's chunk rows) with the stored
 * response, closes the run on an expired token, and refuses a closed
 * run. It then checks the body, its key and the chunk, and that every
 * listed volume belongs to the chunk. One batch, built by
 * `buildChunkCompleteStatements`, records the report on the chunk row
 * with a fresh claim, conditional on the key read before and the run
 * being open, so a duplicate or a report racing the run's closure
 * changes nothing. Every later statement is guarded by that claim: the
 * listed volumes, and the chunk's unlisted rows still waiting, are
 * recorded as aborted with an internal error and counted once; a halt
 * the runner could not report halts the run, keeping an earlier halt;
 * the run closes if no chunk is left that might report; and the
 * response is stored for replays. A later attempt of the same chunk (a
 * re-run of its workflow) replaces the stored report while the run is
 * open, and adds nothing for rows already recorded. For a review run,
 * whose one chunk holds every review row of the run, the rows marked and
 * counted are its review rows, and the volume records nothing.
 *
 * Nothing here logs the `Authorization` header or the token.
 *
 * @version v0.8.0
 */

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { BatchItem } from "drizzle-orm/batch";
import {
  captureReviewRuns,
  pipelineGatePasses,
  pipelineRunChunks,
  pipelineRunVolumes,
  pipelineRuns,
  pipelineVolumes,
} from "../../db/schema";
import { PIPELINE_ACTIVE_RUN_STATUSES } from "../validation/enums";
import {
  chunkCompleteBodySchema,
  chunkIdempotencyKey,
  reviewCallbackBodySchema,
  volumeCallbackBodySchema,
  type ChunkCompleteBody,
  type ReviewCallbackBody,
  type VolumeCallbackBody,
} from "./callback-body";
import { ingestTruncatedFlags } from "./flags-ingest.server";
import { closeRunIfChunksDone, expireRun } from "./run-state.server";
import { pipelineKey, type MediaObjectReader } from "./store.server";
import { parseBearer, verifyRunToken } from "./token.server";

/** The largest callback body Fisqua reads, in bytes. */
export const MAX_CALLBACK_BODY_BYTES = 1_048_576;

/** The settings this module reads. `Env` is assignable to it. */
export interface PipelineCallbackEnv {
  DB: D1Database;
  PIPELINE_CALLBACK_ORIGIN?: string;
  PIPELINE_WORKING_BUCKET?: string;
}

export interface CallbackDeps {
  db: DrizzleD1Database<any>;
  env: PipelineCallbackEnv;
  reader: MediaObjectReader;
  waitUntil: (p: Promise<unknown>) => void;
  now: () => number;
  newId: () => string;
}

type RunRow = typeof pipelineRuns.$inferSelect;
type RunVolumeRow = typeof pipelineRunVolumes.$inferSelect;
type ReviewRow = typeof captureReviewRuns.$inferSelect;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function stored(body: string): Response {
  return new Response(body, { status: 200, headers: JSON_HEADERS });
}

export function bareNotFound(): Response {
  return new Response(null, { status: 404 });
}

export function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

export const invalidToken = () => json(401, { error: "invalid_token" });
export const tokenExpired = () => json(401, { error: "token_expired" });
export const invalidBody = (detail: string) => json(400, { error: "invalid_body", detail });
export const conflict = (detail: string) => json(409, { error: "conflict", detail });

// ---------------------------------------------------------------------------
// Host, size and the run read shared with the chunk-complete handler
// ---------------------------------------------------------------------------

export function isPipelineOrigin(request: Request, env: PipelineCallbackEnv): boolean {
  const origin = env.PIPELINE_CALLBACK_ORIGIN;
  if (!origin) return false;
  try {
    return new URL(request.url).host === new URL(origin).host;
  } catch {
    return false;
  }
}

/** Throws a bare 404 unless the request is on the callback origin. */
export function requirePipelineOrigin(request: Request, env: PipelineCallbackEnv): void {
  if (!isPipelineOrigin(request, env)) throw bareNotFound();
}

/**
 * The body's bytes, or null when it passes the size limit (the
 * callback's by default; the capture link passes its own).
 */
export async function readCappedBody(
  request: Request,
  limit: number = MAX_CALLBACK_BODY_BYTES,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > limit) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The run named in a machine caller's path, from any tenant. The run row
 * is where a machine caller's tenant comes from, so this read cannot be
 * scoped by one; the token check that follows decides whether the
 * caller may act on it.
 */
export async function loadRunById(
  db: DrizzleD1Database<any>,
  runId: string,
): Promise<RunRow | null> {
  const row = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).get();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// The write batch
// ---------------------------------------------------------------------------

/**
 * A raw statement that can sit in a `db.batch`. Drizzle's D1 batch binds
 * parameters on a prepared statement that its raw-query object does not
 * carry, so a `db.run(sql)` with bound parameters fails inside a batch;
 * the statement is prepared here on the same D1 binding.
 */
export function rawBatchItem(db: DrizzleD1Database<any>, query: SQL): BatchItem<"sqlite"> {
  const item = db.run(query) as unknown as {
    getQuery(): { sql: string };
    stmt?: D1PreparedStatement;
  };
  item.stmt = (db as unknown as { $client: D1Database }).$client.prepare(item.getQuery().sql);
  return item as unknown as BatchItem<"sqlite">;
}

export interface CallbackWrite {
  run: Pick<RunRow, "id" | "tenantId" | "scriptVersion">;
  row: Pick<RunVolumeRow, "id" | "pipelineVolumeId" | "declarationId" | "tileRoot">;
  /** The claim and status read in step 10. */
  observedClaim: string | null;
  observedStatus: RunVolumeRow["status"];
  newClaim: string;
  body: VolumeCallbackBody;
  idempotencyKey: string;
  bodySha256: string;
  /** One id per body flag, for the review items of a `review_pending` report. */
  flagIds: string[];
  now: number;
}

const ACTIVE = [...PIPELINE_ACTIVE_RUN_STATUSES];

/** The batch of step 12, in order. Pure: it builds, it does not run. */
export function buildCallbackStatements(
  db: DrizzleD1Database<any>,
  w: CallbackWrite,
): BatchItem<"sqlite">[] {
  const { run, row, body, now } = w;
  const tenantId = run.tenantId;
  const outcome = body.outcome;
  const moves = outcome === "prepared" || outcome === "review_pending";
  const stops = outcome === "aborted" || outcome === "halted";

  // The guard every statement after the first carries: the row holds
  // this request's claim, which only statement a can have written.
  const claimed = (): SQL =>
    sql`EXISTS (SELECT 1 FROM pipeline_run_volumes WHERE id = ${row.id} AND tenant_id = ${tenantId} AND claim_id = ${w.newClaim})`;

  const flags =
    outcome === "review_pending"
      ? JSON.stringify(body.flags.map((f, i) => ({ id: w.flagIds[i], ...f })))
      : null;

  const statements: BatchItem<"sqlite">[] = [];

  // a. The report, claiming the row.
  const claimConditions: SQL[] = [
    eq(pipelineRunVolumes.id, row.id),
    eq(pipelineRunVolumes.tenantId, tenantId),
    sql`${pipelineRunVolumes.claimId} IS ${w.observedClaim}`,
    eq(pipelineRunVolumes.status, w.observedStatus),
    sql`EXISTS (SELECT 1 FROM pipeline_runs WHERE id = ${run.id} AND tenant_id = ${tenantId} AND token_revoked_at IS NULL)`,
  ];
  if (moves) {
    claimConditions.push(
      sql`EXISTS (SELECT 1 FROM pipeline_volumes WHERE id = ${row.pipelineVolumeId} AND tenant_id = ${tenantId} AND state = 'received')`,
    );
  }
  statements.push(
    db
      .update(pipelineRunVolumes)
      .set({
        status: outcome,
        claimId: w.newClaim,
        attempt: body.attempt,
        idempotencyKey: w.idempotencyKey,
        bodySha256: w.bodySha256,
        storedResponse: null,
        runnerVersions: JSON.stringify(body.runner),
        stages: JSON.stringify(body.stages),
        qc: body.qc === null ? null : JSON.stringify(body.qc),
        verification: body.verification === null ? null : JSON.stringify(body.verification),
        flagsCount: body.flags.length,
        flags,
        flagsTruncated: body.flags_truncated,
        flagsIngestedAt: body.flags_truncated ? null : now,
        tilesBytes: body.outputs.tiles_bytes,
        ocrBytes: body.outputs.ocr_bytes,
        elapsedS: body.elapsed_s,
        manifestKey: body.outputs.manifest_key,
        reportKey: body.outputs.report_key,
        error: body.error === null ? null : JSON.stringify(body.error),
        reportedAt: now,
        reviewPurge: body.review_purge === undefined ? null : JSON.stringify(body.review_purge),
      })
      .where(and(...claimConditions)),
  );

  if (body.review_purge !== undefined && body.review_purge.status !== "not_reached") {
    // a2. Each review row of the volume whose prefix the purge named
    // takes its result: failed when the report names it among the
    // failures, purged otherwise. A row already purged stays purged.
    const named = JSON.stringify(body.review_purge.prefixes);
    const failed = JSON.stringify(body.review_purge.failed.map((f) => f.prefix));
    const failedHere = sql`${captureReviewRuns.reviewPrefix} IN (SELECT value FROM json_each(${failed}))`;
    statements.push(
      db
        .update(captureReviewRuns)
        .set({
          purgeStatus: sql`CASE WHEN ${failedHere} THEN 'failed' ELSE 'purged' END`,
          purgedAt: sql`CASE WHEN ${failedHere} THEN NULL ELSE ${now} END`,
        })
        .where(
          and(
            eq(captureReviewRuns.tenantId, tenantId),
            eq(captureReviewRuns.pipelineVolumeId, row.pipelineVolumeId),
            sql`${captureReviewRuns.reviewPrefix} IN (SELECT value FROM json_each(${named}))`,
            sql`${captureReviewRuns.purgeStatus} IS NOT 'purged'`,
            claimed(),
          ),
        ),
    );
  }

  if (moves) {
    // b. Received to Prepared. A review-pending volume is Prepared with
    // an open queue: its tiles and OCR are delivered, its manifest held.
    statements.push(
      db
        .update(pipelineVolumes)
        .set({
          state: "prepared",
          lastRunId: run.id,
          currentTileRoot: row.tileRoot,
          lastError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(pipelineVolumes.id, row.pipelineVolumeId),
            eq(pipelineVolumes.tenantId, tenantId),
            eq(pipelineVolumes.state, "received"),
            claimed(),
          ),
        ),
    );
  }

  if (outcome === "review_pending") {
    // c. The review items, read from the flags statement a stored.
    statements.push(
      rawBatchItem(db, sql`INSERT OR IGNORE INTO pipeline_review_items
        (id, tenant_id, pipeline_volume_id, run_id, page_key, stage, code, summary,
         declaration_id, declaration_version, script_version, created_at)
        SELECT json_extract(j.value, '$.id'), rv.tenant_id, rv.pipeline_volume_id, rv.run_id,
               json_extract(j.value, '$.page_key'), json_extract(j.value, '$.stage'),
               json_extract(j.value, '$.code'), json_extract(j.value, '$.summary'),
               rv.declaration_id,
               json_extract(rv.resolved_recipe, '$.declaration_version'),
               ${run.scriptVersion}, ${now}
        FROM pipeline_run_volumes rv, json_each(rv.flags) j
        WHERE rv.id = ${row.id} AND rv.tenant_id = ${tenantId} AND rv.claim_id = ${w.newClaim}`),
    );
  }

  if (moves) {
    // d. The open review count, from the items themselves.
    statements.push(
      db
        .update(pipelineVolumes)
        .set({
          openReviewCount: sql`(SELECT COUNT(*) FROM pipeline_review_items WHERE pipeline_volume_id = ${row.pipelineVolumeId} AND tenant_id = ${tenantId} AND verdict IS NULL)`,
        })
        .where(
          and(
            eq(pipelineVolumes.id, row.pipelineVolumeId),
            eq(pipelineVolumes.tenantId, tenantId),
            claimed(),
          ),
        ),
    );
  }

  if (outcome === "prepared") {
    // e. Prepared to Ready, when nothing is open and the exact
    // declaration row the run applied has passed its gate with the
    // run's script version.
    statements.push(
      db
        .update(pipelineVolumes)
        .set({ state: "ready", updatedAt: now })
        .where(
          and(
            eq(pipelineVolumes.id, row.pipelineVolumeId),
            eq(pipelineVolumes.tenantId, tenantId),
            eq(pipelineVolumes.state, "prepared"),
            eq(pipelineVolumes.openReviewCount, 0),
            sql`EXISTS (SELECT 1 FROM pipeline_gate_passes WHERE tenant_id = ${tenantId} AND declaration_id = ${row.declarationId} AND script_version = ${run.scriptVersion})`,
            claimed(),
          ),
        ),
    );
  }

  if (stops) {
    // f. The failure is recorded on the volume; its state is unchanged.
    statements.push(
      db
        .update(pipelineVolumes)
        .set({
          lastError: JSON.stringify(body.error),
          lastRunId: run.id,
          updatedAt: now,
        })
        .where(
          and(
            eq(pipelineVolumes.id, row.pipelineVolumeId),
            eq(pipelineVolumes.tenantId, tenantId),
            claimed(),
          ),
        ),
    );
  }

  // g. The run is running once a volume has reported.
  statements.push(
    db
      .update(pipelineRuns)
      .set({ status: "running" })
      .where(
        and(
          eq(pipelineRuns.id, run.id),
          eq(pipelineRuns.tenantId, tenantId),
          inArray(pipelineRuns.status, ["pending", "dispatched"]),
          sql`${pipelineRuns.tokenRevokedAt} IS NULL`,
          claimed(),
        ),
      ),
  );

  if (w.observedStatus === "dispatched") {
    // h. Counted once; a replacement of an aborted or halted row was
    // counted when that row was first reported.
    statements.push(
      db
        .update(pipelineRuns)
        .set({ volumesReported: sql`${pipelineRuns.volumesReported} + 1` })
        .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.tenantId, tenantId), claimed())),
    );
  }

  if (outcome === "halted" && body.error) {
    // i. A systemic error halts the run; the run stays open.
    statements.push(
      db
        .update(pipelineRuns)
        .set({
          status: "halted",
          error: JSON.stringify({
            class: body.error.class,
            volume_id: body.volume_id,
            message: body.error.message,
          }),
        })
        .where(
          and(
            eq(pipelineRuns.id, run.id),
            eq(pipelineRuns.tenantId, tenantId),
            inArray(pipelineRuns.status, ACTIVE),
            sql`${pipelineRuns.tokenRevokedAt} IS NULL`,
            claimed(),
          ),
        ),
    );
  }

  if (outcome === "review_pending") {
    // j. Too large a share of the run's volumes pending review halts it.
    statements.push(
      db
        .update(pipelineRuns)
        .set({
          status: "halted",
          error: sql`json_object('class', 'max_review_frac', 'review_pending', (SELECT COUNT(*) FROM pipeline_run_volumes WHERE run_id = ${run.id} AND tenant_id = ${tenantId} AND status = 'review_pending'), 'volume_count', volume_count)`,
        })
        .where(
          and(
            eq(pipelineRuns.id, run.id),
            eq(pipelineRuns.tenantId, tenantId),
            inArray(pipelineRuns.status, ACTIVE),
            sql`${pipelineRuns.tokenRevokedAt} IS NULL`,
            sql`(SELECT COUNT(*) FROM pipeline_run_volumes WHERE run_id = ${run.id} AND tenant_id = ${tenantId} AND status = 'review_pending') > max_review_frac * volume_count`,
            claimed(),
          ),
        ),
    );
  }

  // k. The response, stored for replays, with the run's status after
  // this batch.
  statements.push(
    db
      .update(pipelineRunVolumes)
      .set({
        storedResponse: sql`json_object('accepted', json('true'), 'run_status', (SELECT status FROM pipeline_runs WHERE id = ${run.id} AND tenant_id = ${tenantId}), 'halted', json(CASE WHEN (SELECT status FROM pipeline_runs WHERE id = ${run.id} AND tenant_id = ${tenantId}) = 'halted' THEN 'true' ELSE 'false' END))`,
      })
      .where(
        and(
          eq(pipelineRunVolumes.id, row.id),
          eq(pipelineRunVolumes.tenantId, tenantId),
          eq(pipelineRunVolumes.claimId, w.newClaim),
        ),
      ),
  );

  return statements;
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

function issuePaths(error: { issues: Array<{ path: PropertyKey[] }> }): string {
  const paths = error.issues.map((i) => i.path.map(String).join(".") || "(body)");
  return [...new Set(paths)].join(", ");
}

async function readRunVolume(
  db: DrizzleD1Database<any>,
  run: RunRow,
  volumeId: string,
): Promise<RunVolumeRow | null> {
  const row = await db
    .select()
    .from(pipelineRunVolumes)
    .where(
      and(
        eq(pipelineRunVolumes.runId, run.id),
        eq(pipelineRunVolumes.pipelineVolumeId, volumeId),
        eq(pipelineRunVolumes.tenantId, run.tenantId),
      ),
    )
    .get();
  return row ?? null;
}

export async function handleVolumeCallback(
  deps: CallbackDeps,
  request: Request,
  params: { runId: string; volumeId: string },
): Promise<Response> {
  const { db } = deps;

  // 1. Host and method.
  if (!isPipelineOrigin(request, deps.env)) return bareNotFound();
  if (request.method !== "POST") return methodNotAllowed();

  // 2. Size.
  const raw = await readCappedBody(request);
  if (raw === null) return invalidBody("body_too_large");
  const bodySha256 = await sha256Hex(raw);
  const now = deps.now();

  // 3 and 4. The run and the token.
  const run = await loadRunById(db, params.runId);
  const check = await verifyRunToken(
    run ? { hash: run.callbackTokenHash, expiresAt: run.tokenExpiresAt } : null,
    parseBearer(request.headers.get("Authorization")),
    now,
  );
  if (check === "invalid" || run === null) return invalidToken();

  // A review run's volumes are recorded in their own table.
  if (run.kind === "review_run") {
    return handleReviewCallback(deps, request, { run, params, raw, bodySha256, check, now });
  }

  // 5. Row and exact replay.
  const row = await readRunVolume(db, run, params.volumeId);
  const key = request.headers.get("Idempotency-Key");
  if (
    row !== null &&
    key !== null &&
    row.idempotencyKey === key &&
    row.bodySha256 === bodySha256 &&
    row.storedResponse !== null
  ) {
    return stored(row.storedResponse);
  }

  // 6. Expiry closes the run.
  if (check === "expired") {
    await expireRun(db, { runId: run.id, tenantId: run.tenantId }, now);
    return tokenExpired();
  }

  // 7. Closed run, unknown volume.
  if (run.tokenRevokedAt !== null) return conflict("run_closed");
  if (row === null) return json(404, { error: "unknown_volume" });

  // 8. Body.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return invalidBody("malformed_json");
  }
  const result = volumeCallbackBodySchema.safeParse(parsed);
  if (!result.success) return invalidBody(issuePaths(result.error));
  const body = result.data;
  if (body.run_id !== params.runId) return invalidBody("run_id");
  if (body.volume_id !== params.volumeId) return invalidBody("volume_id");
  const expectedKey = `${body.run_id}:${body.volume_id}:${body.attempt}`;
  if (key !== expectedKey) return invalidBody("idempotency_key");

  // 9. Output scope.
  if (body.outputs.tile_root !== row.tileRoot) return invalidBody("outputs.tile_root");
  // Each key must equal the one fixed path the runner writes to. A
  // prefix test is not enough: the object reader resolves keys as URLs,
  // where `%2e%2e` and `\` act as dot segments and climb out of the run.
  const volumePrefix = `${pipelineKey.workingPrefix(run.tenantId, row.runId)}volumes/${row.pipelineVolumeId}/`;
  const expectedOutputs = {
    manifest_key: `${volumePrefix}manifest.json`,
    report_key: `${volumePrefix}report.json`,
  } as const;
  for (const field of ["manifest_key", "report_key"] as const) {
    if (body.outputs[field] !== expectedOutputs[field]) {
      return invalidBody(`outputs.${field}`);
    }
  }

  // 10. Idempotency against the stored attempt.
  const observedClaim = row.claimId;
  const observedStatus = row.status;
  if (row.idempotencyKey !== null) {
    if (row.idempotencyKey === expectedKey) return conflict("body_mismatch");
    if (observedStatus === "prepared" || observedStatus === "review_pending") {
      return conflict("already_reported");
    }
  }

  // 11. Volume precondition.
  const moves = body.outcome === "prepared" || body.outcome === "review_pending";
  if (moves) {
    const volume = await db
      .select({ state: pipelineVolumes.state })
      .from(pipelineVolumes)
      .where(
        and(
          eq(pipelineVolumes.id, row.pipelineVolumeId),
          eq(pipelineVolumes.tenantId, run.tenantId),
        ),
      )
      .get();
    if (!volume || volume.state !== "received") return conflict("volume_state");
  }

  // 12. The batch.
  const newClaim = deps.newId();
  const statements = buildCallbackStatements(db, {
    run,
    row,
    observedClaim,
    observedStatus,
    newClaim,
    body,
    idempotencyKey: expectedKey,
    bodySha256,
    flagIds: body.flags.map(() => deps.newId()),
    now,
  });
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

  // 13. Read back.
  const after = await db
    .select()
    .from(pipelineRunVolumes)
    .where(and(eq(pipelineRunVolumes.id, row.id), eq(pipelineRunVolumes.tenantId, run.tenantId)))
    .get();
  if (after && after.claimId === newClaim && after.storedResponse !== null) {
    // 14. The rest of a truncated flag list, in the background.
    if (body.flags_truncated) {
      deps.waitUntil(
        ingestTruncatedFlags(
          {
            db,
            reader: deps.reader,
            now: deps.now,
            workingBucket: deps.env.PIPELINE_WORKING_BUCKET ?? "",
          },
          { tenantId: run.tenantId, runVolumeId: row.id },
        ).catch(() => {
          console.warn(`pipeline flags ingest failed (run ${run.id}, volume ${row.pipelineVolumeId})`);
        }),
      );
    }
    return stored(after.storedResponse);
  }
  if (
    after &&
    after.idempotencyKey === expectedKey &&
    after.bodySha256 === bodySha256 &&
    after.storedResponse !== null
  ) {
    return stored(after.storedResponse);
  }
  const current = await db
    .select({ tokenRevokedAt: pipelineRuns.tokenRevokedAt })
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.tenantId, run.tenantId)))
    .get();
  if (current && current.tokenRevokedAt !== null) return conflict("run_closed");
  return conflict("concurrent_report");
}

// ---------------------------------------------------------------------------
// A review run's volume
// ---------------------------------------------------------------------------

export interface ReviewCallbackWrite {
  run: Pick<RunRow, "id" | "tenantId">;
  row: Pick<ReviewRow, "pipelineVolumeId">;
  /** The claim and status read before the batch. */
  observedClaim: string | null;
  observedStatus: ReviewRow["status"];
  newClaim: string;
  body: ReviewCallbackBody;
  idempotencyKey: string;
  bodySha256: string;
  now: number;
}

/**
 * The batch of a review run's report, in order. It writes the review
 * row and the run, and nothing a processing state reads: the volume is
 * not touched. Pure: it builds, it does not run.
 */
export function buildReviewCallbackStatements(
  db: DrizzleD1Database<any>,
  w: ReviewCallbackWrite,
): BatchItem<"sqlite">[] {
  const { run, row, body, now } = w;
  const tenantId = run.tenantId;
  const rowIs = () => [
    eq(captureReviewRuns.tenantId, tenantId),
    eq(captureReviewRuns.runId, run.id),
    eq(captureReviewRuns.pipelineVolumeId, row.pipelineVolumeId),
  ];
  const claimed = (): SQL =>
    sql`EXISTS (SELECT 1 FROM capture_review_runs WHERE tenant_id = ${tenantId} AND run_id = ${run.id} AND pipeline_volume_id = ${row.pipelineVolumeId} AND claim_id = ${w.newClaim})`;
  const statements: BatchItem<"sqlite">[] = [];

  // a. The report, claiming the row.
  statements.push(
    db
      .update(captureReviewRuns)
      .set({
        status: body.outcome,
        claimId: w.newClaim,
        attempt: body.attempt,
        idempotencyKey: w.idempotencyKey,
        bodySha256: w.bodySha256,
        storedResponse: null,
        error: body.error === null ? null : JSON.stringify(body.error),
        tilesBytes: body.outputs.tiles_bytes,
        reportKey: body.outputs.report_key,
        reportedAt: now,
      })
      .where(
        and(
          ...rowIs(),
          sql`${captureReviewRuns.claimId} IS ${w.observedClaim}`,
          eq(captureReviewRuns.status, w.observedStatus),
          sql`EXISTS (SELECT 1 FROM pipeline_runs WHERE id = ${run.id} AND tenant_id = ${tenantId} AND token_revoked_at IS NULL)`,
        ),
      ),
  );

  // b. The run is running once a volume has reported.
  statements.push(
    db
      .update(pipelineRuns)
      .set({ status: "running" })
      .where(
        and(
          eq(pipelineRuns.id, run.id),
          eq(pipelineRuns.tenantId, tenantId),
          inArray(pipelineRuns.status, ["pending", "dispatched"]),
          sql`${pipelineRuns.tokenRevokedAt} IS NULL`,
          claimed(),
        ),
      ),
  );

  if (w.observedStatus === "dispatched") {
    // c. Counted once, as for a processing run.
    statements.push(
      db
        .update(pipelineRuns)
        .set({ volumesReported: sql`${pipelineRuns.volumesReported} + 1` })
        .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.tenantId, tenantId), claimed())),
    );
  }

  if (body.outcome === "halted" && body.error) {
    // d. A systemic error halts the run; the run stays open.
    statements.push(
      db
        .update(pipelineRuns)
        .set({
          status: "halted",
          error: JSON.stringify({
            class: body.error.class,
            volume_id: body.volume_id,
            message: body.error.message,
          }),
        })
        .where(
          and(
            eq(pipelineRuns.id, run.id),
            eq(pipelineRuns.tenantId, tenantId),
            inArray(pipelineRuns.status, ACTIVE),
            sql`${pipelineRuns.tokenRevokedAt} IS NULL`,
            claimed(),
          ),
        ),
    );
  }

  // e. The response, stored for replays.
  statements.push(
    db
      .update(captureReviewRuns)
      .set({
        storedResponse: sql`json_object('accepted', json('true'), 'run_status', (SELECT status FROM pipeline_runs WHERE id = ${run.id} AND tenant_id = ${tenantId}), 'halted', json(CASE WHEN (SELECT status FROM pipeline_runs WHERE id = ${run.id} AND tenant_id = ${tenantId}) = 'halted' THEN 'true' ELSE 'false' END))`,
      })
      .where(and(...rowIs(), eq(captureReviewRuns.claimId, w.newClaim))),
  );

  return statements;
}

async function readReviewRow(
  db: DrizzleD1Database<any>,
  run: RunRow,
  volumeId: string,
): Promise<ReviewRow | null> {
  const row = await db
    .select()
    .from(captureReviewRuns)
    .where(
      and(
        eq(captureReviewRuns.tenantId, run.tenantId),
        eq(captureReviewRuns.runId, run.id),
        eq(captureReviewRuns.pipelineVolumeId, volumeId),
      ),
    )
    .get();
  return row ?? null;
}

/**
 * Steps 5 to 13 for a review run, against its review row: the exact
 * replay, expiry, a closed run or unknown volume, the body
 * (`reviewCallbackBodySchema`), the output scope (the review prefix the
 * row recorded, and the report key under the run's working prefix),
 * the stored attempt (refused after `review_ready`), the batch and the
 * read back.
 */
async function handleReviewCallback(
  deps: CallbackDeps,
  request: Request,
  c: {
    run: RunRow;
    params: { runId: string; volumeId: string };
    raw: Uint8Array<ArrayBuffer>;
    bodySha256: string;
    check: "ok" | "expired";
    now: number;
  },
): Promise<Response> {
  const { db } = deps;
  const { run, params, now } = c;

  // 5. Row and exact replay.
  const row = await readReviewRow(db, run, params.volumeId);
  const key = request.headers.get("Idempotency-Key");
  if (
    row !== null &&
    key !== null &&
    row.idempotencyKey === key &&
    row.bodySha256 === c.bodySha256 &&
    row.storedResponse !== null
  ) {
    return stored(row.storedResponse);
  }

  // 6. Expiry closes the run.
  if (c.check === "expired") {
    await expireRun(db, { runId: run.id, tenantId: run.tenantId }, now);
    return tokenExpired();
  }

  // 7. Closed run, unknown volume.
  if (run.tokenRevokedAt !== null) return conflict("run_closed");
  if (row === null) return json(404, { error: "unknown_volume" });

  // 8. Body.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(c.raw));
  } catch {
    return invalidBody("malformed_json");
  }
  const result = reviewCallbackBodySchema.safeParse(parsed);
  if (!result.success) return invalidBody(issuePaths(result.error));
  const body = result.data;
  if (body.run_id !== params.runId) return invalidBody("run_id");
  if (body.volume_id !== params.volumeId) return invalidBody("volume_id");
  const expectedKey = `${body.run_id}:${body.volume_id}:${body.attempt}`;
  if (key !== expectedKey) return invalidBody("idempotency_key");

  // 9. Output scope: the prefix the spec named, and the one report key.
  if (body.outputs.review_prefix !== row.reviewPrefix) return invalidBody("outputs.review_prefix");
  const reportKey = `${pipelineKey.workingPrefix(run.tenantId, run.id)}volumes/${row.pipelineVolumeId}/report.json`;
  if (body.outputs.report_key !== reportKey) return invalidBody("outputs.report_key");

  // 10. Idempotency against the stored attempt.
  if (row.idempotencyKey !== null) {
    if (row.idempotencyKey === expectedKey) return conflict("body_mismatch");
    if (row.status === "review_ready") return conflict("already_reported");
  }

  // 12. The batch.
  const newClaim = deps.newId();
  const statements = buildReviewCallbackStatements(db, {
    run,
    row,
    observedClaim: row.claimId,
    observedStatus: row.status,
    newClaim,
    body,
    idempotencyKey: expectedKey,
    bodySha256: c.bodySha256,
    now,
  });
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

  // 13. Read back.
  const after = await readReviewRow(db, run, params.volumeId);
  if (after && after.claimId === newClaim && after.storedResponse !== null) {
    return stored(after.storedResponse);
  }
  if (
    after &&
    after.idempotencyKey === expectedKey &&
    after.bodySha256 === c.bodySha256 &&
    after.storedResponse !== null
  ) {
    return stored(after.storedResponse);
  }
  const current = await db
    .select({ tokenRevokedAt: pipelineRuns.tokenRevokedAt })
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.tenantId, run.tenantId)))
    .get();
  if (current && current.tokenRevokedAt !== null) return conflict("run_closed");
  return conflict("concurrent_report");
}

// ---------------------------------------------------------------------------
// The chunk-complete report
// ---------------------------------------------------------------------------

export type ChunkCompleteDeps = Pick<CallbackDeps, "db" | "env" | "now" | "newId">;

type ChunkRow = typeof pipelineRunChunks.$inferSelect;

/** Listed ids per statement, leaving room for the fixed values. */
const LISTED_ID_CHUNK = 85;

const NO_CALLBACK = "No callback arrived for this volume.";
const NOT_LISTED = "No callback was recorded and the completion report did not list this volume.";

export interface ChunkCompleteWrite {
  run: Pick<RunRow, "id" | "tenantId"> & Partial<Pick<RunRow, "kind">>;
  chunk: Pick<ChunkRow, "id" | "chunkIndex">;
  /** The chunk's stored key, read before the batch. */
  observedKey: string | null;
  newClaim: string;
  body: ChunkCompleteBody;
  idempotencyKey: string;
  bodySha256: string;
  now: number;
}

/** The batch of the chunk report, in order. Pure: it builds, it does not run. */
export function buildChunkCompleteStatements(
  db: DrizzleD1Database<any>,
  w: ChunkCompleteWrite,
): BatchItem<"sqlite">[] {
  const { run, chunk, body, now } = w;
  const tenantId = run.tenantId;
  const claimed = (): SQL =>
    sql`EXISTS (SELECT 1 FROM pipeline_run_chunks WHERE id = ${chunk.id} AND tenant_id = ${tenantId} AND claim_id = ${w.newClaim})`;
  const aborted = (message: string) =>
    JSON.stringify({ class: "internal", stage: null, message, conclusion: body.conclusion });
  const statements: BatchItem<"sqlite">[] = [];

  // a. The report, claiming the chunk row.
  statements.push(
    db
      .update(pipelineRunChunks)
      .set({
        status: "completed",
        claimId: w.newClaim,
        idempotencyKey: w.idempotencyKey,
        bodySha256: w.bodySha256,
        attempt: body.attempt,
        conclusion: body.conclusion,
        unreportedVolumeIds: JSON.stringify(body.unreported_volume_ids),
        storedResponse: null,
        reportedAt: now,
      })
      .where(
        and(
          eq(pipelineRunChunks.id, chunk.id),
          eq(pipelineRunChunks.tenantId, tenantId),
          sql`${pipelineRunChunks.idempotencyKey} IS ${w.observedKey}`,
          sql`EXISTS (SELECT 1 FROM pipeline_runs WHERE id = ${run.id} AND tenant_id = ${tenantId} AND token_revoked_at IS NULL)`,
        ),
      ),
  );

  if (run.kind === "review_run") {
    statements.push(...reviewChunkStatements(db, w, claimed, aborted));
  } else {
    statements.push(...processingChunkStatements(db, w, claimed, aborted));
  }

  // f. A halt the runner could not report halts the run.
  if (body.halted_volume_ids.length > 0) {
    statements.push(
      db
        .update(pipelineRuns)
        .set({
          status: "halted",
          error: JSON.stringify({
            class: "unreported_halt",
            chunk_index: chunk.chunkIndex,
            volume_ids: body.halted_volume_ids,
          }),
        })
        .where(
          and(
            eq(pipelineRuns.id, run.id),
            eq(pipelineRuns.tenantId, tenantId),
            inArray(pipelineRuns.status, ACTIVE),
            sql`${pipelineRuns.tokenRevokedAt} IS NULL`,
            claimed(),
          ),
        ),
    );
  }

  // g. Close the run if no chunk is left that might report.
  statements.push(closeRunIfChunksDone(db, { runId: run.id, tenantId, now, guard: claimed() }));

  // h. The response, stored for replays.
  statements.push(
    db
      .update(pipelineRunChunks)
      .set({
        storedResponse: sql`json_object('accepted', json('true'), 'run_status', (SELECT status FROM pipeline_runs WHERE id = ${run.id} AND tenant_id = ${tenantId}), 'halted', json(CASE WHEN (SELECT status FROM pipeline_runs WHERE id = ${run.id} AND tenant_id = ${tenantId}) = 'halted' THEN 'true' ELSE 'false' END))`,
      })
      .where(
        and(
          eq(pipelineRunChunks.id, chunk.id),
          eq(pipelineRunChunks.tenantId, tenantId),
          eq(pipelineRunChunks.claimId, w.newClaim),
        ),
      ),
  );

  return statements;
}

/** Steps b to e of a processing run's chunk report, on its run volumes. */
function processingChunkStatements(
  db: DrizzleD1Database<any>,
  w: ChunkCompleteWrite,
  claimed: () => SQL,
  aborted: (message: string) => string,
): BatchItem<"sqlite">[] {
  const { run, chunk, body, now } = w;
  const tenantId = run.tenantId;
  const statements: BatchItem<"sqlite">[] = [];
  const waiting = () => [
    eq(pipelineRunVolumes.runId, run.id),
    eq(pipelineRunVolumes.tenantId, tenantId),
    eq(pipelineRunVolumes.chunkIndex, chunk.chunkIndex),
    eq(pipelineRunVolumes.status, "dispatched"),
  ];

  // b. The listed volumes whose row holds no report.
  for (let i = 0; i < body.unreported_volume_ids.length; i += LISTED_ID_CHUNK) {
    const ids = body.unreported_volume_ids.slice(i, i + LISTED_ID_CHUNK);
    statements.push(
      db
        .update(pipelineRunVolumes)
        .set({ status: "aborted", error: aborted(NO_CALLBACK), claimId: w.newClaim, reportedAt: now })
        .where(and(...waiting(), inArray(pipelineRunVolumes.pipelineVolumeId, ids), claimed())),
    );
  }

  // c. The chunk's other rows still waiting: no callback can arrive for
  // them in this attempt.
  statements.push(
    db
      .update(pipelineRunVolumes)
      .set({ status: "aborted", error: aborted(NOT_LISTED), claimId: w.newClaim, reportedAt: now })
      .where(and(...waiting(), claimed())),
  );

  // d. Their volumes record the error; their state is unchanged.
  statements.push(
    db
      .update(pipelineVolumes)
      .set({
        lastError: sql`(SELECT rv.error FROM pipeline_run_volumes rv WHERE rv.run_id = ${run.id} AND rv.tenant_id = ${tenantId} AND rv.pipeline_volume_id = pipeline_volumes.id AND rv.claim_id = ${w.newClaim})`,
        lastRunId: run.id,
        updatedAt: now,
      })
      .where(
        and(
          eq(pipelineVolumes.tenantId, tenantId),
          sql`${pipelineVolumes.id} IN (SELECT pipeline_volume_id FROM pipeline_run_volumes WHERE run_id = ${run.id} AND tenant_id = ${tenantId} AND claim_id = ${w.newClaim})`,
          claimed(),
        ),
      ),
  );

  // e. Counted once: only rows this batch changed.
  statements.push(
    db
      .update(pipelineRuns)
      .set({
        volumesReported: sql`${pipelineRuns.volumesReported} + (SELECT COUNT(*) FROM pipeline_run_volumes WHERE run_id = ${run.id} AND tenant_id = ${tenantId} AND claim_id = ${w.newClaim})`,
      })
      .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.tenantId, tenantId), claimed())),
  );

  return statements;
}

/**
 * Steps b, c and e of a review run's chunk report, on its review rows. A
 * review run has one chunk, so every row of the run is in it. The volume
 * records nothing (step d): a review run leaves it as it was.
 */
function reviewChunkStatements(
  db: DrizzleD1Database<any>,
  w: ChunkCompleteWrite,
  claimed: () => SQL,
  aborted: (message: string) => string,
): BatchItem<"sqlite">[] {
  const { run, body, now } = w;
  const tenantId = run.tenantId;
  const statements: BatchItem<"sqlite">[] = [];
  const waiting = () => [
    eq(captureReviewRuns.tenantId, tenantId),
    eq(captureReviewRuns.runId, run.id),
    eq(captureReviewRuns.status, "dispatched"),
  ];

  for (let i = 0; i < body.unreported_volume_ids.length; i += LISTED_ID_CHUNK) {
    const ids = body.unreported_volume_ids.slice(i, i + LISTED_ID_CHUNK);
    statements.push(
      db
        .update(captureReviewRuns)
        .set({ status: "aborted", error: aborted(NO_CALLBACK), claimId: w.newClaim, reportedAt: now })
        .where(and(...waiting(), inArray(captureReviewRuns.pipelineVolumeId, ids), claimed())),
    );
  }
  statements.push(
    db
      .update(captureReviewRuns)
      .set({ status: "aborted", error: aborted(NOT_LISTED), claimId: w.newClaim, reportedAt: now })
      .where(and(...waiting(), claimed())),
  );
  statements.push(
    db
      .update(pipelineRuns)
      .set({
        volumesReported: sql`${pipelineRuns.volumesReported} + (SELECT COUNT(*) FROM capture_review_runs WHERE run_id = ${run.id} AND tenant_id = ${tenantId} AND claim_id = ${w.newClaim})`,
      })
      .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.tenantId, tenantId), claimed())),
  );
  return statements;
}

export async function handleChunkComplete(
  deps: ChunkCompleteDeps,
  request: Request,
  params: { runId: string },
): Promise<Response> {
  const { db } = deps;

  // 1. Host, method, size, run and token, as for a volume callback.
  if (!isPipelineOrigin(request, deps.env)) return bareNotFound();
  if (request.method !== "POST") return methodNotAllowed();
  const raw = await readCappedBody(request);
  if (raw === null) return invalidBody("body_too_large");
  const bodySha256 = await sha256Hex(raw);
  const now = deps.now();
  const run = await loadRunById(db, params.runId);
  const check = await verifyRunToken(
    run ? { hash: run.callbackTokenHash, expiresAt: run.tokenExpiresAt } : null,
    parseBearer(request.headers.get("Authorization")),
    now,
  );
  if (check === "invalid" || run === null) return invalidToken();

  // 2. Exact replay.
  const key = request.headers.get("Idempotency-Key");
  if (key !== null) {
    const replay = await db
      .select({ bodySha256: pipelineRunChunks.bodySha256, storedResponse: pipelineRunChunks.storedResponse })
      .from(pipelineRunChunks)
      .where(
        and(
          eq(pipelineRunChunks.runId, run.id),
          eq(pipelineRunChunks.tenantId, run.tenantId),
          eq(pipelineRunChunks.idempotencyKey, key),
        ),
      )
      .get();
    if (replay && replay.bodySha256 === bodySha256 && replay.storedResponse !== null) {
      return stored(replay.storedResponse);
    }
  }

  // 3. Expiry closes the run.
  if (check === "expired") {
    await expireRun(db, { runId: run.id, tenantId: run.tenantId }, now);
    return tokenExpired();
  }

  // 4. Closed run.
  if (run.tokenRevokedAt !== null) return conflict("run_closed");

  // 5. Body, key and chunk.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return invalidBody("malformed_json");
  }
  const result = chunkCompleteBodySchema.safeParse(parsed);
  if (!result.success) return invalidBody(issuePaths(result.error));
  const body = result.data;
  if (body.run_id !== params.runId) return invalidBody("run_id");
  const expectedKey = chunkIdempotencyKey(body);
  if (key !== expectedKey) return invalidBody("idempotency_key");
  const chunk = await db
    .select()
    .from(pipelineRunChunks)
    .where(
      and(
        eq(pipelineRunChunks.runId, run.id),
        eq(pipelineRunChunks.tenantId, run.tenantId),
        eq(pipelineRunChunks.chunkIndex, body.chunk_index),
      ),
    )
    .get();
  if (!chunk) return invalidBody("chunk_index");
  if (chunk.idempotencyKey === expectedKey) return conflict("body_mismatch");

  // 6. Every listed volume belongs to this chunk; a review run's one
  // chunk holds every review row of the run.
  const rows =
    run.kind === "review_run"
      ? await db
          .select({ pipelineVolumeId: captureReviewRuns.pipelineVolumeId })
          .from(captureReviewRuns)
          .where(and(eq(captureReviewRuns.runId, run.id), eq(captureReviewRuns.tenantId, run.tenantId)))
          .all()
      : await db
          .select({ pipelineVolumeId: pipelineRunVolumes.pipelineVolumeId })
          .from(pipelineRunVolumes)
          .where(
            and(
              eq(pipelineRunVolumes.runId, run.id),
              eq(pipelineRunVolumes.tenantId, run.tenantId),
              eq(pipelineRunVolumes.chunkIndex, body.chunk_index),
            ),
          )
          .all();
  const inChunk = new Set(rows.map((r) => r.pipelineVolumeId));
  if (body.unreported_volume_ids.some((id) => !inChunk.has(id))) {
    return invalidBody("volume_not_in_chunk");
  }

  // 7 and 8. The batch, against the key read now.
  const newClaim = deps.newId();
  const statements = buildChunkCompleteStatements(db, {
    run,
    chunk,
    observedKey: chunk.idempotencyKey,
    newClaim,
    body,
    idempotencyKey: expectedKey,
    bodySha256,
    now,
  });
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

  // 9. Read back.
  const after = await db
    .select()
    .from(pipelineRunChunks)
    .where(and(eq(pipelineRunChunks.id, chunk.id), eq(pipelineRunChunks.tenantId, run.tenantId)))
    .get();
  if (after && after.claimId === newClaim && after.storedResponse !== null) {
    return stored(after.storedResponse);
  }
  if (
    after &&
    after.idempotencyKey === expectedKey &&
    after.bodySha256 === bodySha256 &&
    after.storedResponse !== null
  ) {
    return stored(after.storedResponse);
  }
  const current = await db
    .select({ tokenRevokedAt: pipelineRuns.tokenRevokedAt })
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.tenantId, run.tenantId)))
    .get();
  if (current && current.tokenRevokedAt !== null) return conflict("run_closed");
  return conflict("concurrent_report");
}

// @version v0.8.0
