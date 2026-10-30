/**
 * Tests — media pipeline chunk-complete report
 *
 * This suite drives the route a chunk's completion job posts to once
 * every job in its chunk has ended, through the route module's `action`
 * and `loader` with constructed requests on the test callback origin.
 * It pins:
 *
 *   - the record of volumes that never reported: listed volumes and the
 *     chunk's unlisted rows still waiting are recorded as aborted with
 *     an internal error, their volumes keep their state and record the
 *     error, and each is counted once;
 *   - closure: the run closes when no chunk is left pending, dispatched
 *     or failed, a halted run stays halted, and a chunk whose dispatch
 *     failed with its fate unknown may still report and close the run;
 *   - a halt the runner could not report halts the run, keeping a halt
 *     recorded earlier;
 *   - idempotency: an exact replay gets the stored response with no
 *     write, also after the run has closed; two concurrent copies write
 *     once; the same key with another body is refused; a later attempt
 *     of the chunk replaces the stored report while the run is open;
 *   - the limits shared with the per-volume callback: host, method,
 *     token, expiry before body checks, and the closed run.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { applyMigrations, cleanDatabase, seedTenants } from "../helpers/db";
import {
  seedPipelineRun,
  makeVolumeCallback,
  callbackHeaders,
  snapshotPipelineTables,
  type SeededRun,
} from "../helpers/media-pipeline";
import { action, loader } from "../../app/routes/api.pipeline.runs.$runId.complete";
import { action as volumeAction } from "../../app/routes/api.pipeline.runs.$runId.volumes.$volumeId.callback";
import { buildChunkCompleteStatements } from "../../app/lib/pipeline/callback.server";
import { mintRunToken } from "../../app/lib/pipeline/token.server";

const ORIGIN = "https://fisqua.test";
const OTHER_HOST = "https://ahr.fisqua.test";

type Json = Record<string, any>;

interface Posted {
  status: number;
  text: string;
  json: Json | null;
}

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

async function record(res: Response): Promise<Posted> {
  const text = await res.text();
  let json: Json | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

interface Report {
  spec_version: 1;
  run_id: string;
  chunk_index: number;
  attempt: string;
  conclusion: "success" | "failure" | "cancelled";
  unreported_volume_ids: string[];
  halted_volume_ids: string[];
}

function report(run: SeededRun, chunkIndex: number, opts: Partial<Report> = {}): Report {
  return {
    spec_version: 1,
    run_id: run.runId,
    chunk_index: chunkIndex,
    attempt: "11223344.1",
    conclusion: "success",
    unreported_volume_ids: [],
    halted_volume_ids: [],
    ...opts,
  };
}

const keyOf = (r: Report) => `${r.run_id}:chunk:${r.chunk_index}:${r.attempt}`;

async function complete(
  run: SeededRun,
  body: Report | Json,
  opts: { token?: string | null; host?: string; method?: string; key?: string | null } = {},
): Promise<Posted> {
  const token = opts.token === undefined ? run.token : opts.token;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = opts.key === undefined ? keyOf(body as Report) : opts.key;
  if (key !== null) headers["Idempotency-Key"] = key;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const method = opts.method ?? "POST";
  const request = new Request(`${opts.host ?? ORIGIN}/api/pipeline/runs/${run.runId}/complete`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
  const args = {
    request,
    params: { runId: run.runId },
    context: { cloudflare: { env: testEnv(), ctx: { waitUntil: () => {} } } },
  } as any;
  return record(await settle(() => (method === "GET" ? loader(args) : action(args))));
}

async function volumeCallback(run: SeededRun, i: number, opts: Parameters<typeof makeVolumeCallback>[2] = {}): Promise<Posted> {
  const v = run.volumes[i];
  const body = makeVolumeCallback(run, v, opts);
  const request = new Request(`${ORIGIN}/api/pipeline/runs/${run.runId}/volumes/${v.id}/callback`, {
    method: "POST",
    headers: callbackHeaders(run.token, body),
    body: JSON.stringify(body),
  });
  return record(
    await settle(() =>
      volumeAction({
        request,
        params: { runId: run.runId, volumeId: v.id },
        context: { cloudflare: { env: testEnv(), ctx: { waitUntil: () => {} } } },
      } as any),
    ),
  );
}

async function first<T = Json>(query: string, ...binds: unknown[]): Promise<T> {
  return (await env.DB.prepare(query).bind(...binds).first<T>()) as T;
}
const runRow = (run: SeededRun) => first("SELECT * FROM pipeline_runs WHERE id = ?", run.runId);
const chunkRow = (run: SeededRun, i: number) =>
  first("SELECT * FROM pipeline_run_chunks WHERE run_id = ? AND chunk_index = ?", run.runId, i);
const rvRow = (run: SeededRun, i: number) =>
  first("SELECT * FROM pipeline_run_volumes WHERE id = ?", run.volumes[i].runVolumeId);
const volRow = (run: SeededRun, i: number) =>
  first("SELECT * FROM pipeline_volumes WHERE id = ?", run.volumes[i].id);

async function snapshotAll() {
  const base = await snapshotPipelineTables();
  const { results } = await env.DB.prepare("SELECT * FROM pipeline_run_chunks ORDER BY id").all();
  return { ...base, pipeline_run_chunks: results };
}

describe("media pipeline chunk-complete report", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
  });

  it("records a listed volume as aborted, counts it, and closes a one-chunk run", async () => {
    const run = await seedPipelineRun({ volumeCount: 3 });
    expect((await volumeCallback(run, 0)).status).toBe(200);
    expect((await volumeCallback(run, 1, { outcome: "aborted" })).status).toBe(200);
    const res = await complete(run, report(run, 0, { unreported_volume_ids: [run.volumes[2].id] }));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ accepted: true, run_status: "completed", halted: false });
    const rv = await rvRow(run, 2);
    expect(rv.status).toBe("aborted");
    expect(JSON.parse(rv.error)).toEqual({
      class: "internal",
      stage: null,
      message: "No callback arrived for this volume.",
      conclusion: "success",
    });
    const vol = await volRow(run, 2);
    expect(vol.state).toBe("received");
    expect(vol.last_error).not.toBeNull();
    expect(vol.last_run_id).toBe(run.runId);
    const r = await runRow(run);
    expect(r.volumes_reported).toBe(3);
    expect(r.status).toBe("completed");
    expect(r.token_revoked_at).not.toBeNull();
    expect(r.completed_at).not.toBeNull();
    expect((await chunkRow(run, 0)).status).toBe("completed");
  });

  it("answers a replay with the same bytes and writes nothing", async () => {
    const run = await seedPipelineRun({ volumeCount: 3 });
    const body = report(run, 0, { unreported_volume_ids: [run.volumes[2].id] });
    const firstPost = await complete(run, body);
    const before = await snapshotAll();
    const again = await complete(run, body);
    expect(again.status).toBe(200);
    expect(again.text).toBe(firstPost.text);
    expect(await snapshotAll()).toEqual(before);
  });

  it("writes once for two concurrent identical reports, and a stale batch changes nothing", async () => {
    // Two chunks, so the run stays open after chunk 0 reports.
    const run = await seedPipelineRun({ volumeCount: 2, chunkCount: 2, chunkOf: (i) => i });
    const body = report(run, 0, { unreported_volume_ids: [run.volumes[0].id] });
    const [a, b] = await Promise.all([complete(run, body), complete(run, body)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.text).toBe(b.text);
    expect((await runRow(run)).volumes_reported).toBe(1);
    expect((await runRow(run)).token_revoked_at).toBeNull();

    const before = await snapshotAll();
    const db = drizzle(env.DB);
    const statements = buildChunkCompleteStatements(db, {
      run: { id: run.runId, tenantId: run.tenantId },
      chunk: { id: (await chunkRow(run, 0)).id, chunkIndex: 0 },
      observedKey: null,
      newClaim: crypto.randomUUID(),
      body: { ...body, attempt: "99.1" },
      idempotencyKey: keyOf({ ...body, attempt: "99.1" }),
      bodySha256: "0".repeat(64),
      now: Date.now(),
    });
    await db.batch(statements as any);
    expect(await snapshotAll()).toEqual(before);
  });

  it("refuses the same key with another body, a header that is not the key, and a body without attempt", async () => {
    const run = await seedPipelineRun({ volumeCount: 2, chunkCount: 2, chunkOf: (i) => i });
    const body = report(run, 0);
    expect((await complete(run, body)).status).toBe(200);
    const before = await snapshotAll();
    const changed = await complete(run, { ...body, conclusion: "failure" });
    expect(changed.status).toBe(409);
    expect(await snapshotAll()).toEqual(before);

    const wrongKey = await complete(run, report(run, 1), { key: `${run.runId}:chunk:1:other` });
    expect(wrongKey.status).toBe(400);
    const { attempt: _attempt, ...noAttempt } = report(run, 1);
    const missing = await complete(run, noAttempt, { key: `${run.runId}:chunk:1:undefined` });
    expect(missing.status).toBe(400);
    expect(await snapshotAll()).toEqual(before);
  });

  it("refuses a listed volume outside the chunk and a chunk index past the last", async () => {
    const run = await seedPipelineRun({ volumeCount: 2, chunkCount: 2, chunkOf: (i) => i });
    const before = await snapshotAll();
    for (const ids of [[run.volumes[1].id], ["not-a-volume"]]) {
      const res = await complete(run, report(run, 0, { unreported_volume_ids: ids }));
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "invalid_body", detail: "volume_not_in_chunk" });
    }
    const past = await complete(run, report(run, 2));
    expect(past.status).toBe(400);
    expect(await snapshotAll()).toEqual(before);
  });

  it("refuses a new report on a closed run and replays the one that closed it", async () => {
    const run = await seedPipelineRun({ volumeCount: 1 });
    const closing = report(run, 0, { unreported_volume_ids: [run.volumes[0].id] });
    const closed = await complete(run, closing);
    expect(closed.json?.run_status).toBe("completed");
    const before = await snapshotAll();
    const later = await complete(run, report(run, 0, { attempt: "55.2" }));
    expect(later.status).toBe(409);
    expect(later.json).toEqual({ error: "conflict", detail: "run_closed" });
    const replay = await complete(run, closing);
    expect(replay.status).toBe(200);
    expect(replay.text).toBe(closed.text);
    expect(await snapshotAll()).toEqual(before);
  });

  it("keeps a two-chunk run open until its second chunk reports", async () => {
    const run = await seedPipelineRun({ volumeCount: 2, chunkCount: 2, chunkOf: (i) => i });
    await volumeCallback(run, 0);
    expect((await complete(run, report(run, 0))).status).toBe(200);
    let r = await runRow(run);
    expect(r.status).toBe("running");
    expect(r.token_revoked_at).toBeNull();
    await volumeCallback(run, 1);
    expect((await complete(run, report(run, 1))).status).toBe(200);
    r = await runRow(run);
    expect(r.status).toBe("completed");
    expect(r.token_revoked_at).not.toBeNull();
  });

  it("closes a halted run as halted, and a later new attempt is refused", async () => {
    const run = await seedPipelineRun({ volumeCount: 2 });
    await volumeCallback(run, 0, { outcome: "halted", errorClass: "auth" });
    const halt = JSON.parse((await runRow(run)).error);
    await complete(run, report(run, 0, { unreported_volume_ids: [run.volumes[1].id] }));
    const r = await runRow(run);
    expect(r.status).toBe("halted");
    expect(JSON.parse(r.error)).toEqual(halt);
    expect(r.token_revoked_at).not.toBeNull();
    const again = await volumeCallback(run, 1, { attempt: "77.1" });
    expect(again.status).toBe(409);
    expect(again.json).toEqual({ error: "conflict", detail: "run_closed" });
  });

  it("records an unlisted row still waiting with its own message, counted once", async () => {
    const run = await seedPipelineRun({ volumeCount: 2 });
    await volumeCallback(run, 0);
    await complete(run, report(run, 0));
    const rv = await rvRow(run, 1);
    expect(rv.status).toBe("aborted");
    expect(JSON.parse(rv.error).message).toBe(
      "No callback was recorded and the completion report did not list this volume.",
    );
    expect((await runRow(run)).volumes_reported).toBe(2);
  });

  it("accepts a later attempt of a chunk while the run is open, re-marking nothing", async () => {
    const run = await seedPipelineRun({ volumeCount: 2, chunkCount: 2, chunkOf: (i) => i });
    const [a] = run.volumes;
    await complete(run, report(run, 0, { unreported_volume_ids: [a.id] }));
    expect((await rvRow(run, 0)).status).toBe("aborted");
    const reported = (await runRow(run)).volumes_reported;
    const rerun = await volumeCallback(run, 0, { attempt: "22334455.1" });
    expect(rerun.status).toBe(200);
    expect((await rvRow(run, 0)).status).toBe("prepared");
    const later = report(run, 0, { attempt: "22334455.1" });
    const res = await complete(run, later);
    expect(res.status).toBe(200);
    const chunk = await chunkRow(run, 0);
    expect(chunk.idempotency_key).toBe(keyOf(later));
    expect((await rvRow(run, 0)).status).toBe("prepared");
    expect((await runRow(run)).volumes_reported).toBe(reported);
  });

  it("answers the host, method, token and expiry limits before reading the body", async () => {
    const run = await seedPipelineRun({ volumeCount: 1 });
    const body = report(run, 0);
    const before = await snapshotAll();
    const wrong = await mintRunToken();
    expect((await complete(run, body, { token: wrong.token })).status).toBe(401);
    for (const method of ["POST", "GET"]) {
      const res = await complete(run, body, { host: OTHER_HOST, method });
      expect(res.status).toBe(404);
      expect(res.text).toBe("");
    }
    expect((await complete(run, body, { method: "GET" })).status).toBe(405);
    expect((await complete(run, body, { method: "PUT" })).status).toBe(405);
    expect(await snapshotAll()).toEqual(before);

    const expired = await seedPipelineRun({ volumeCount: 1, chunkCount: 1, tokenExpiresAt: Date.now() - 1 });
    const res = await complete(expired, report(expired, 0));
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "token_expired" });
    const r = await runRow(expired);
    expect(r.status).toBe("error");
    expect(JSON.parse(r.error)).toEqual({ class: "token_expired" });
    const past = await complete(expired, report(expired, 1));
    expect(past.status).toBe(401);
  });

  it("accepts a report for a chunk whose dispatch failed and closes the run", async () => {
    const run = await seedPipelineRun({ volumeCount: 1 });
    await env.DB.prepare("UPDATE pipeline_run_chunks SET status = 'failed' WHERE run_id = ?").bind(run.runId).run();
    const res = await complete(run, report(run, 0, { unreported_volume_ids: [run.volumes[0].id] }));
    expect(res.status).toBe(200);
    expect((await chunkRow(run, 0)).status).toBe("completed");
    const r = await runRow(run);
    expect(r.token_revoked_at).not.toBeNull();
  });

  it("halts the run on a halt the runner could not report, and closes it as halted later", async () => {
    const run = await seedPipelineRun({ volumeCount: 2, chunkCount: 2, chunkOf: (i) => i });
    const [a] = run.volumes;
    const res = await complete(
      run,
      report(run, 0, { unreported_volume_ids: [a.id], halted_volume_ids: [a.id], conclusion: "cancelled" }),
    );
    expect(res.status).toBe(200);
    expect(res.json?.halted).toBe(true);
    let r = await runRow(run);
    expect(r.status).toBe("halted");
    expect(JSON.parse(r.error)).toEqual({ class: "unreported_halt", chunk_index: 0, volume_ids: [a.id] });
    expect(r.token_revoked_at).toBeNull();
    expect((await rvRow(run, 0)).status).toBe("aborted");
    const later = await volumeCallback(run, 1);
    expect(later.status).toBe(200);
    expect(later.json?.halted).toBe(true);
    await complete(run, report(run, 1));
    r = await runRow(run);
    expect(r.status).toBe("halted");
    expect(JSON.parse(r.error).class).toBe("unreported_halt");
    expect(r.token_revoked_at).not.toBeNull();
  });

  it("keeps the first halt error when a chunk reports a halt on a halted run", async () => {
    const run = await seedPipelineRun({ volumeCount: 3, chunkCount: 2, chunkOf: (i) => (i === 2 ? 1 : 0) });
    await volumeCallback(run, 0, { outcome: "halted", errorClass: "auth" });
    const firstHalt = JSON.parse((await runRow(run)).error);
    const b = run.volumes[1];
    await complete(run, report(run, 0, { unreported_volume_ids: [b.id], halted_volume_ids: [b.id] }));
    expect(JSON.parse((await runRow(run)).error)).toEqual(firstHalt);
  });
});

// @version v0.8.0
