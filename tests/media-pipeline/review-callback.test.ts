/**
 * Tests — the review run's callbacks, and the purge a processing run reports
 *
 * A review run (kind `review_run`) tiles a capture delivery's previews
 * for capture QC and reports each volume on the same callback route as
 * a processing run. Its report is recorded on its review row
 * (`capture_review_runs`), never on a run-volume row, and never moves
 * the volume. This suite drives the routes with constructed requests on
 * the test callback origin and pins:
 *
 *   - a `review_ready` report is accepted only when it names the review
 *     prefix the row recorded and the one report key under the run's
 *     working prefix; it marks the row, counts the volume on the run and
 *     leaves the volume, its hold and the run-volume table as they were;
 *   - an exact replay gets the stored answer; a new attempt after
 *     `review_ready` is refused, and one after an abort replaces it;
 *   - a processing report's shape is refused for a review run, and a
 *     review report's for a processing run;
 *   - the chunk-complete report marks a review row that never reported
 *     as aborted, counts it once and closes the run, without touching
 *     the volume;
 *   - a processing report is accepted with and without `review_purge`;
 *     with one, it is stored on the run volume and each review row of
 *     the volume whose prefix it names takes purged or failed; a report
 *     that reached Prepared cannot say the purge was not reached;
 *   - the capture QC hold still holds a volume whose delivery has a
 *     review run, and the processing-run read the status call makes does
 *     not see the review run.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { applyMigrations, cleanDatabase, seedTenants, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import {
  seedPipelineRun,
  seedReviewRun,
  makeReviewCallback,
  makeVolumeCallback,
  callbackHeaders,
  insertRow,
  type SeededReviewRun,
  type CallbackBody,
} from "../helpers/media-pipeline";
import { action } from "../../app/routes/api.pipeline.runs.$runId.volumes.$volumeId.callback";
import { action as completeAction } from "../../app/routes/api.pipeline.runs.$runId.complete";
import { readCaptureQcPending } from "../../app/lib/capture/hold.server";
import { readLatestRuns } from "../../app/lib/capture/link.server";

const ORIGIN = "https://fisqua.test";

type Json = Record<string, any>;

function testEnv() {
  return {
    DB: env.DB,
    BUCKET: env.BUCKET,
    PIPELINE_CALLBACK_ORIGIN: ORIGIN,
    PIPELINE_WORKING_BUCKET: "test-working",
  };
}

async function settle(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return (await fn()) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

async function answer(res: Response): Promise<{ status: number; json: Json | null }> {
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function post(runId: string, volumeId: string, token: string, body: CallbackBody) {
  const request = new Request(`${ORIGIN}/api/pipeline/runs/${runId}/volumes/${volumeId}/callback`, {
    method: "POST",
    headers: callbackHeaders(token, body),
    body: JSON.stringify(body),
  });
  return answer(
    await settle(() =>
      action({
        request,
        params: { runId, volumeId },
        context: { cloudflare: { env: testEnv(), ctx: { waitUntil: () => {} } } },
      } as any),
    ),
  );
}

const postReview = (run: SeededReviewRun, body: CallbackBody) => post(run.runId, run.volumeId, run.token, body);

async function complete(run: SeededReviewRun, unreported: string[] = []) {
  const report = {
    spec_version: 1,
    run_id: run.runId,
    chunk_index: 0,
    attempt: "11223344.1",
    conclusion: "failure",
    unreported_volume_ids: unreported,
    halted_volume_ids: [],
  };
  const request = new Request(`${ORIGIN}/api/pipeline/runs/${run.runId}/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${run.token}`,
      "Idempotency-Key": `${run.runId}:chunk:0:${report.attempt}`,
    },
    body: JSON.stringify(report),
  });
  return answer(
    await settle(() =>
      completeAction({
        request,
        params: { runId: run.runId },
        context: { cloudflare: { env: testEnv(), ctx: { waitUntil: () => {} } } },
      } as any),
    ),
  );
}

async function first<T = Json>(query: string, ...binds: unknown[]): Promise<T> {
  return (await env.DB.prepare(query).bind(...binds).first<T>()) as T;
}

const reviewRow = (run: SeededReviewRun) =>
  first("SELECT * FROM capture_review_runs WHERE run_id = ? AND pipeline_volume_id = ?", run.runId, run.volumeId);
const runRow = (runId: string) => first("SELECT * FROM pipeline_runs WHERE id = ?", runId);
const volumeRow = (id: string) => first("SELECT * FROM pipeline_volumes WHERE id = ?", id);
const runVolumeCount = async () => (await first<{ n: number }>("SELECT COUNT(*) AS n FROM pipeline_run_volumes")).n;

describe("a review run's report", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
  });

  it("accepts review_ready with the row's prefix and report key, and leaves the volume as it was", async () => {
    const run = await seedReviewRun();
    const volumeBefore = await volumeRow(run.volumeId);
    const res = await postReview(run, makeReviewCallback(run));
    expect(res).toEqual({ status: 200, json: { accepted: true, run_status: "running", halted: false } });
    const row = await reviewRow(run);
    expect(row.status).toBe("review_ready");
    expect(row.tiles_bytes).toBe(100);
    expect(row.reported_at).not.toBeNull();
    expect(row.error).toBeNull();
    const r = await runRow(run.runId);
    expect(r.volumes_reported).toBe(1);
    expect(r.token_revoked_at).toBeNull();
    expect(await volumeRow(run.volumeId)).toEqual(volumeBefore);
    expect(await runVolumeCount()).toBe(0);
  });

  it("refuses a report naming another review prefix or another report key, and writes nothing", async () => {
    const run = await seedReviewRun();
    const before = await reviewRow(run);

    const otherPrefix = makeReviewCallback(run);
    otherPrefix.outputs.review_prefix = "test-tenant/another-delivery/";
    expect(await postReview(run, otherPrefix)).toEqual({
      status: 400,
      json: { error: "invalid_body", detail: "outputs.review_prefix" },
    });

    const otherKey = makeReviewCallback(run);
    otherKey.outputs.report_key = otherKey.outputs.report_key.replace("report.json", "../report.json");
    expect(await postReview(run, otherKey)).toEqual({
      status: 400,
      json: { error: "invalid_body", detail: "outputs.report_key" },
    });

    expect(await reviewRow(run)).toEqual(before);
    expect((await runRow(run.runId)).volumes_reported).toBe(0);
  });

  it("answers an exact replay with the stored answer and refuses a new attempt after review_ready", async () => {
    const run = await seedReviewRun();
    const body = makeReviewCallback(run);
    const firstAnswer = await postReview(run, body);
    expect(firstAnswer.status).toBe(200);
    expect(await postReview(run, body)).toEqual(firstAnswer);
    expect(await postReview(run, makeReviewCallback(run, { attempt: "11223344.2" }))).toEqual({
      status: 409,
      json: { error: "conflict", detail: "already_reported" },
    });
    expect((await runRow(run.runId)).volumes_reported).toBe(1);
  });

  it("records an abort, and a later attempt replaces it without counting the volume twice", async () => {
    const run = await seedReviewRun();
    expect((await postReview(run, makeReviewCallback(run, { outcome: "aborted" }))).status).toBe(200);
    const aborted = await reviewRow(run);
    expect(aborted.status).toBe("aborted");
    expect(JSON.parse(aborted.error).class).toBe("fixity");
    expect((await volumeRow(run.volumeId)).last_error).toBeNull();

    expect((await postReview(run, makeReviewCallback(run, { attempt: "11223344.2" }))).status).toBe(200);
    expect((await reviewRow(run)).status).toBe("review_ready");
    expect((await runRow(run.runId)).volumes_reported).toBe(1);
  });

  it("halts the run on a systemic error", async () => {
    const run = await seedReviewRun();
    const res = await postReview(run, makeReviewCallback(run, { outcome: "halted" }));
    expect(res.json).toEqual({ accepted: true, run_status: "halted", halted: true });
    expect((await reviewRow(run)).status).toBe("halted");
  });

  it("refuses a processing report for a review run, and a review report for a processing run", async () => {
    const run = await seedReviewRun();
    const processing = makeReviewCallback(run) as Json;
    processing.outcome = "prepared";
    const res = await postReview(run, processing);
    expect(res.status).toBe(400);
    expect((await reviewRow(run)).status).toBe("dispatched");

    const processingRun = await seedPipelineRun();
    const v = processingRun.volumes[0];
    const review = makeReviewCallback({ ...run, runId: processingRun.runId, volumeId: v.id });
    expect((await post(processingRun.runId, v.id, processingRun.token, review)).status).toBe(400);
  });

  it("answers 404 for a volume the review run does not name", async () => {
    const run = await seedReviewRun();
    const body = makeReviewCallback(run);
    body.volume_id = crypto.randomUUID();
    expect((await post(run.runId, body.volume_id, run.token, body)).status).toBe(404);
  });
});

describe("a review run's chunk-complete report", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
  });

  it("marks an unreported review row aborted, counts it once and closes the run, leaving the volume alone", async () => {
    const run = await seedReviewRun();
    const volumeBefore = await volumeRow(run.volumeId);
    const res = await complete(run, [run.volumeId]);
    expect(res.status).toBe(200);
    expect(res.json?.run_status).toBe("completed");
    const row = await reviewRow(run);
    expect(row.status).toBe("aborted");
    expect(JSON.parse(row.error)).toEqual({
      class: "internal",
      stage: null,
      message: "No callback arrived for this volume.",
      conclusion: "failure",
    });
    const r = await runRow(run.runId);
    expect(r.volumes_reported).toBe(1);
    expect(r.token_revoked_at).not.toBeNull();
    expect(await volumeRow(run.volumeId)).toEqual(volumeBefore);
  });

  it("marks a review row the report did not list, and keeps a row that had reported", async () => {
    const run = await seedReviewRun();
    expect((await complete(run, [])).json?.run_status).toBe("completed");
    expect((await reviewRow(run)).status).toBe("aborted");

    const ready = await seedReviewRun();
    expect((await postReview(ready, makeReviewCallback(ready))).status).toBe(200);
    expect((await complete(ready, [])).json?.run_status).toBe("completed");
    expect((await reviewRow(ready)).status).toBe("review_ready");
  });

  it("refuses a listed volume that is not the run's", async () => {
    const run = await seedReviewRun();
    expect((await complete(run, [crypto.randomUUID()])).status).toBe(400);
  });
});

describe("a processing report's review purge", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
  });

  /** Two review rows of the processing run's volume, as if two deliveries had review runs. */
  async function reviewRowsFor(volumeId: string, tenantId = DEFAULT_TEST_TENANT_ID) {
    const prefixes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const review = await seedReviewRun({ tenantId });
      const deliveryId = crypto.randomUUID();
      const prefix = `test-tenant/${deliveryId}/`;
      await insertRow("capture_deliveries", {
        tenant_id: tenantId,
        id: deliveryId,
        route: "file",
        scanner_id: null,
        reference_code: review.referenceCode,
        pipeline_volume_id: volumeId,
        body_sha256: "a".repeat(64),
        state: "superseded",
        superseded_by: review.deliveryId,
        superseded_at: 1,
        answer_status: 200,
        answer_body: "{}",
        openings: 2,
        received_at: 1,
        seq: (await first<{ n: number }>("SELECT MAX(seq) + 1 AS n FROM capture_deliveries WHERE tenant_id = ?", tenantId)).n,
      });
      await insertRow("capture_review_runs", {
        tenant_id: tenantId,
        run_id: review.runId,
        delivery_id: deliveryId,
        pipeline_volume_id: volumeId,
        review_prefix: prefix,
        status: "review_ready",
        created_at: 1,
      });
      prefixes.push(prefix);
    }
    return prefixes;
  }

  const purgeRows = (volumeId: string) =>
    env.DB.prepare(
      "SELECT review_prefix, purge_status, purged_at FROM capture_review_runs WHERE pipeline_volume_id = ? ORDER BY review_prefix",
    )
      .bind(volumeId)
      .all<Json>()
      .then((r) => r.results);

  it("accepts a report without review_purge and stores none", async () => {
    const run = await seedPipelineRun();
    const v = run.volumes[0];
    const body = makeVolumeCallback(run, v);
    expect((await post(run.runId, v.id, run.token, body)).status).toBe(200);
    const rv = await first("SELECT review_purge FROM pipeline_run_volumes WHERE id = ?", v.runVolumeId);
    expect(rv.review_purge).toBeNull();
  });

  it("stores the purge and marks each named review row purged or failed", async () => {
    const run = await seedPipelineRun();
    const v = run.volumes[0];
    const [purged, failed] = await reviewRowsFor(v.id);
    const body = makeVolumeCallback(run, v);
    body.review_purge = {
      status: "failed",
      prefixes: [purged, failed],
      failed: [{ prefix: failed, message: "access denied" }],
    };
    expect((await post(run.runId, v.id, run.token, body)).status).toBe(200);
    const rv = await first("SELECT review_purge FROM pipeline_run_volumes WHERE id = ?", v.runVolumeId);
    expect(JSON.parse(rv.review_purge)).toEqual(body.review_purge);
    const rows = await purgeRows(v.id);
    const byPrefix = Object.fromEntries(rows.map((r) => [r.review_prefix, r]));
    expect(byPrefix[purged].purge_status).toBe("purged");
    expect(byPrefix[purged].purged_at).not.toBeNull();
    expect(byPrefix[failed].purge_status).toBe("failed");
    expect(byPrefix[failed].purged_at).toBeNull();
  });

  it("leaves review rows untouched when the purge was not reached", async () => {
    const run = await seedPipelineRun();
    const v = run.volumes[0];
    const prefixes = await reviewRowsFor(v.id);
    const body = makeVolumeCallback(run, v, { outcome: "aborted" });
    body.review_purge = { status: "not_reached", prefixes, failed: [] };
    expect((await post(run.runId, v.id, run.token, body)).status).toBe(200);
    expect((await purgeRows(v.id)).every((r) => r.purge_status === null)).toBe(true);
  });

  it("refuses a Prepared report whose purge was not reached, and a failed purge naming no failure", async () => {
    const run = await seedPipelineRun();
    const v = run.volumes[0];
    const notReached = makeVolumeCallback(run, v);
    notReached.review_purge = { status: "not_reached", prefixes: [], failed: [] };
    expect((await post(run.runId, v.id, run.token, notReached)).status).toBe(400);
    const silent = makeVolumeCallback(run, v);
    silent.review_purge = { status: "failed", prefixes: ["t/d/"], failed: [] };
    expect((await post(run.runId, v.id, run.token, silent)).status).toBe(400);
    expect((await first("SELECT status FROM pipeline_run_volumes WHERE id = ?", v.runVolumeId)).status).toBe("dispatched");
  });
});

describe("the capture QC hold with a review run", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
  });

  it("still holds the volume, before and after the review run reports, and no processing run is seen", async () => {
    const db = drizzle(env.DB);
    const run = await seedReviewRun();
    expect(await readCaptureQcPending(db, run.tenantId, [run.volumeId])).toEqual([run.volumeId]);
    expect((await postReview(run, makeReviewCallback(run))).status).toBe(200);
    expect((await complete(run, [])).status).toBe(200);
    expect(await readCaptureQcPending(db, run.tenantId, [run.volumeId])).toEqual([run.volumeId]);
    expect((await volumeRow(run.volumeId)).held_by_run_id).toBeNull();
    expect((await readLatestRuns(db, run.tenantId, [run.volumeId], Date.now())).size).toBe(0);
  });
});

// @version v0.8.0
