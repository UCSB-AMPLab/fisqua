/**
 * Tests — media pipeline per-volume callback
 *
 * This suite drives the callback route the pipeline runner posts to
 * after each volume, through the route module's `action` and `loader`
 * with constructed requests on the test callback origin. It pins:
 *
 *   - authentication: a missing, malformed or wrong token, a token for
 *     another run and an unknown run all get the same 401 and write
 *     nothing; a wrong token never learns that a run has expired; a
 *     session cookie is not a credential here;
 *   - the host and method limits: a bare 404 off the callback origin
 *     for every method, 405 for anything but POST on it;
 *   - the body limits, the run and volume named in the body, the output
 *     keys confined to the run's own working prefix for the volume;
 *   - idempotency: an exact replay gets the stored response with no
 *     write, also after the run has closed or the token expired; the
 *     same key with a different body is refused; a new attempt replaces
 *     an aborted or halted report while the run is open and is refused
 *     after a prepared one; two concurrent copies transition once;
 *   - the effects: Received to Prepared, Ready only with no open review
 *     and a gate pass for the exact declaration row and script version,
 *     review items carrying that recipe, the run running, halted by a
 *     systemic error or by too large a share of review-pending volumes,
 *     and still recording volumes while halted and open; a fixity error
 *     aborts its volume only;
 *   - expiry: the first request after expiry closes the run once —
 *     halted runs keep their halt, runs with every volume reported
 *     complete, others end in error keeping an earlier dispatch error —
 *     and every later request gets 401;
 *   - a per-volume callback never closes a run;
 *   - the token never appears in a log line or a response body.
 *
 * Where a test needs a run whose chunks have all reported, it posts each
 * chunk's completion report through the chunk-complete route.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { applyMigrations, cleanDatabase, seedTenants, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import {
  seedPipelineRun,
  seedGatePass,
  seedDeclaration,
  makeVolumeCallback,
  callbackHeaders,
  callbackIdempotencyKey,
  snapshotPipelineTables,
  type SeededRun,
  type SeededVolume,
  type CallbackBody,
  type CallbackOptions,
} from "../helpers/media-pipeline";
import { action, loader } from "../../app/routes/api.pipeline.runs.$runId.volumes.$volumeId.callback";
import { action as completeAction } from "../../app/routes/api.pipeline.runs.$runId.complete";
import {
  buildCallbackStatements,
  handleVolumeCallback,
  sha256Hex,
} from "../../app/lib/pipeline/callback.server";
import { expireRun } from "../../app/lib/pipeline/run-state.server";
import { mintRunToken } from "../../app/lib/pipeline/token.server";
import { volumeCallbackBodySchema } from "../../app/lib/pipeline/callback-body";
import { createSessionStorage } from "../../app/sessions.server";
import type { MediaObjectReader } from "../../app/lib/pipeline/store.server";

const ORIGIN = "https://fisqua.test";
const OTHER_HOST = "https://ahr.fisqua.test";
const WORKING_BUCKET = "test-working";

// Everything any test wrote to the console and every response body, so
// the leak check can look at all of them.
const logged: string[] = [];
const responseBodies: string[] = [];
const tokens = new Set<string>();

type Json = Record<string, any>;

function testEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: env.DB,
    BUCKET: env.BUCKET,
    PIPELINE_CALLBACK_ORIGIN: ORIGIN,
    PIPELINE_WORKING_BUCKET: WORKING_BUCKET,
    ...overrides,
  };
}

interface Posted {
  status: number;
  text: string;
  json: Json | null;
  waits: Promise<unknown>[];
}

async function settle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

async function record(res: Response, waits: Promise<unknown>[]): Promise<Posted> {
  const text = await res.text();
  responseBodies.push(text);
  let parsed: Json | null = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, text, json: parsed, waits };
}

function url(host: string, runId: string, volumeId: string): string {
  return `${host}/api/pipeline/runs/${runId}/volumes/${volumeId}/callback`;
}

async function post(
  run: SeededRun,
  volume: SeededVolume,
  body: CallbackBody,
  opts: {
    token?: string | null;
    host?: string;
    method?: string;
    headers?: Record<string, string>;
    rawBody?: BodyInit;
    runId?: string;
    volumeId?: string;
    env?: Record<string, unknown>;
  } = {},
): Promise<Posted> {
  const runId = opts.runId ?? run.runId;
  const volumeId = opts.volumeId ?? volume.id;
  const token = opts.token === undefined ? run.token : opts.token;
  const headers = { ...callbackHeaders(token, body), ...(opts.headers ?? {}) };
  const request = new Request(url(opts.host ?? ORIGIN, runId, volumeId), {
    method: opts.method ?? "POST",
    headers,
    body: opts.rawBody ?? JSON.stringify(body),
  });
  const waits: Promise<unknown>[] = [];
  const res = await settle(() =>
    action({
      request,
      params: { runId, volumeId },
      context: {
        cloudflare: { env: testEnv(opts.env), ctx: { waitUntil: (p: Promise<unknown>) => waits.push(p) } },
      },
    } as any) as Promise<Response>,
  );
  return record(res, waits);
}

async function get(host: string, run: SeededRun, volume: SeededVolume): Promise<Posted> {
  const request = new Request(url(host, run.runId, volume.id), {
    method: "GET",
    headers: { Authorization: `Bearer ${run.token}` },
  });
  const res = await settle(() =>
    loader({
      request,
      params: { runId: run.runId, volumeId: volume.id },
      context: { cloudflare: { env: testEnv(), ctx: { waitUntil: () => {} } } },
    } as any) as Promise<Response>,
  );
  return record(res, []);
}

async function seed(opts: Parameters<typeof seedPipelineRun>[0] = {}): Promise<SeededRun> {
  const run = await seedPipelineRun(opts);
  tokens.add(run.token);
  return run;
}

function body(run: SeededRun, volume: SeededVolume, opts: CallbackOptions = {}): CallbackBody {
  return makeVolumeCallback(run, volume, opts);
}

async function first<T = Json>(query: string, ...binds: unknown[]): Promise<T> {
  return (await env.DB.prepare(query).bind(...binds).first<T>()) as T;
}

const runRow = (run: SeededRun) => first("SELECT * FROM pipeline_runs WHERE id = ?", run.runId);
const runVolumeRow = (v: SeededVolume) =>
  first("SELECT * FROM pipeline_run_volumes WHERE id = ?", v.runVolumeId);
const volumeRow = (v: SeededVolume) => first("SELECT * FROM pipeline_volumes WHERE id = ?", v.id);

/** Posts a chunk's completion report, listing no volume. */
async function closeChunk(run: SeededRun, chunkIndex: number, attempt = "11223344.1"): Promise<Response> {
  const report = {
    spec_version: 1,
    run_id: run.runId,
    chunk_index: chunkIndex,
    attempt,
    conclusion: "success",
    unreported_volume_ids: [],
    halted_volume_ids: [],
  };
  const request = new Request(`${ORIGIN}/api/pipeline/runs/${run.runId}/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${run.token}`,
      "Idempotency-Key": `${run.runId}:chunk:${chunkIndex}:${attempt}`,
    },
    body: JSON.stringify(report),
  });
  return settle(() =>
    completeAction({
      request,
      params: { runId: run.runId },
      context: { cloudflare: { env: testEnv(), ctx: { waitUntil: () => {} } } },
    } as any) as Promise<Response>,
  );
}

async function setRowReported(
  v: SeededVolume,
  status: "aborted" | "halted" | "prepared",
  attempt = "1.1",
  runId?: string,
): Promise<void> {
  const key = `${runId}:${v.id}:${attempt}`;
  await env.DB.prepare(
    "UPDATE pipeline_run_volumes SET status = ?, attempt = ?, idempotency_key = ?, claim_id = ?, " +
      "body_sha256 = ?, stored_response = ?, error = ?, reported_at = ? WHERE id = ?",
  )
    .bind(
      status,
      attempt,
      key,
      crypto.randomUUID(),
      "0".repeat(64),
      '{"accepted":true,"run_status":"running","halted":false}',
      status === "prepared" ? null : '{"class":"image"}',
      Date.now(),
      v.runVolumeId,
    )
    .run();
}

function paramsOf(statement: any): unknown[] {
  return "toSQL" in statement ? statement.toSQL().params : statement.getQuery().params;
}

describe("media pipeline per-volume callback", () => {
  beforeAll(async () => {
    await applyMigrations();
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
  });

  // --- Authentication -----------------------------------------------------

  it("refuses a request with no Authorization header and writes nothing", async () => {
    const run = await seed();
    const v = run.volumes[0];
    const before = await snapshotPipelineTables();
    const res = await post(run, v, body(run, v), { token: null });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "invalid_token" });
    expect(await snapshotPipelineTables()).toEqual(before);
  });

  it("refuses a Basic Authorization header", async () => {
    const run = await seed();
    const v = run.volumes[0];
    const res = await post(run, v, body(run, v), { headers: { Authorization: "Basic abc" } });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "invalid_token" });
  });

  it("refuses a well-formed but wrong token", async () => {
    const run = await seed();
    const v = run.volumes[0];
    const other = (await mintRunToken()).token;
    const res = await post(run, v, body(run, v), { token: other });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "invalid_token" });
  });

  it("refuses one run's token on another run's path and leaves that run alone", async () => {
    const a = await seed();
    const b = await seed();
    const before = await snapshotPipelineTables();
    const v = b.volumes[0];
    const res = await post(b, v, body(b, v), { token: a.token });
    expect(res.status).toBe(401);
    expect(await snapshotPipelineTables()).toEqual(before);
  });

  it("answers an unknown run exactly as a wrong token, after the same comparison", async () => {
    const run = await seed();
    const v = run.volumes[0];
    const wrong = await post(run, v, body(run, v), { token: (await mintRunToken()).token });
    const spy = vi.spyOn(crypto.subtle as any, "timingSafeEqual");
    const unknownId = crypto.randomUUID();
    const b = body(run, v);
    b.run_id = unknownId;
    const unknown = await post(run, v, b, { runId: unknownId });
    expect(unknown.status).toBe(401);
    expect(unknown.text).toBe(wrong.text);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("closes a run at expiry and answers token_expired, leaving its volumes alone", async () => {
    const run = await seed({ volumeCount: 2, tokenExpiresAt: Date.now() - 1000 });
    const v = run.volumes[0];
    const res = await post(run, v, body(run, v));
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "token_expired" });
    const r = await runRow(run);
    expect(r.status).toBe("error");
    expect(JSON.parse(r.error).class).toBe("token_expired");
    expect(r.token_revoked_at).not.toBeNull();
    for (const vol of run.volumes) {
      expect((await runVolumeRow(vol)).status).toBe("dispatched");
      expect((await volumeRow(vol)).state).toBe("received");
    }
  });

  it("does not tell a wrong token that the run has expired", async () => {
    const run = await seed({ tokenExpiresAt: Date.now() - 1000 });
    const v = run.volumes[0];
    const res = await post(run, v, body(run, v), { token: (await mintRunToken()).token });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "invalid_token" });
    expect((await runRow(run)).status).toBe("dispatched");
  });

  it("closes an expired run once however many requests arrive", async () => {
    const run = await seed({ volumeCount: 3, tokenExpiresAt: Date.now() - 1000 });
    const r1 = await post(run, run.volumes[0], body(run, run.volumes[0]));
    const afterFirst = await runRow(run);
    const r2 = await post(run, run.volumes[1], body(run, run.volumes[1]));
    const r3 = await post(run, run.volumes[2], body(run, run.volumes[2]));
    for (const r of [r1, r2, r3]) expect(r.json).toEqual({ error: "token_expired" });
    const afterThird = await runRow(run);
    expect(afterThird.error).toBe(afterFirst.error);
    expect(afterThird.token_revoked_at).toBe(afterFirst.token_revoked_at);
  });

  it("refuses a new attempt on a closed run with run_closed and writes nothing", async () => {
    const run = await seed({ status: "completed", tokenRevokedAt: Date.now() - 10 });
    const v = run.volumes[0];
    await setRowReported(v, "aborted", "1.1", run.runId);
    const before = await snapshotPipelineTables();
    const res = await post(run, v, body(run, v, { attempt: "2.1" }));
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: "conflict", detail: "run_closed" });
    expect(await snapshotPipelineTables()).toEqual(before);
  });

  // --- Body and path ------------------------------------------------------

  it("refuses a body naming another volume than the path", async () => {
    const run = await seed({ volumeCount: 2 });
    const [a, b] = run.volumes;
    const res = await post(run, a, body(run, b));
    expect(res.status).toBe(400);
    expect(res.json?.error).toBe("invalid_body");
  });

  it("answers unknown_volume for a volume not in the run", async () => {
    const run = await seed();
    const v = run.volumes[0];
    const stranger: SeededVolume = { ...v, id: crypto.randomUUID() };
    const res = await post(run, stranger, body(run, stranger));
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "unknown_volume" });
  });

  // --- Accepted reports and replays ---------------------------------------

  it("records a prepared report and moves the volume and the run", async () => {
    const run = await seed();
    const v = run.volumes[0];
    const res = await post(run, v, body(run, v));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ accepted: true, run_status: "running", halted: false });
    expect((await runVolumeRow(v)).status).toBe("prepared");
    const vol = await volumeRow(v);
    expect(vol.state).toBe("prepared");
    expect(vol.last_run_id).toBe(run.runId);
    expect(vol.current_tile_root).toBe(v.referenceCode);
    const r = await runRow(run);
    expect(r.status).toBe("running");
    expect(r.volumes_reported).toBe(1);
  });

  it("answers an exact replay with the stored body and writes nothing", async () => {
    const run = await seed();
    const v = run.volumes[0];
    const b = body(run, v);
    const firstRes = await post(run, v, b);
    const updatedAt = (await volumeRow(v)).updated_at;
    const before = await snapshotPipelineTables();
    const again = await post(run, v, b);
    expect(again.status).toBe(200);
    expect(again.text).toBe(firstRes.text);
    expect((await volumeRow(v)).updated_at).toBe(updatedAt);
    expect((await runRow(run)).volumes_reported).toBe(1);
    expect(await snapshotPipelineTables()).toEqual(before);
  });

  it("refuses the same key with a different body", async () => {
    const run = await seed();
    const v = run.volumes[0];
    const b = body(run, v);
    await post(run, v, b);
    const before = await snapshotPipelineTables();
    const changed = structuredClone(b);
    changed.stages.pull.count = 733;
    const res = await post(run, v, changed);
    expect(res.status).toBe(409);
    expect(res.json?.error).toBe("conflict");
    expect(await snapshotPipelineTables()).toEqual(before);
  });

  it("refuses a tile root other than the run volume's", async () => {
    const run = await seed();
    const v = run.volumes[0];
    const b = body(run, v);
    b.outputs.tile_root = "co-somewhere-else";
    const res = await post(run, v, b);
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "invalid_body", detail: "outputs.tile_root" });
  });

  it("refuses output keys outside the volume's own working prefix", async () => {
    const run = await seed({ volumeCount: 2 });
    const [v, other] = run.volumes;
    const foreign = body(run, v);
    foreign.outputs.manifest_key = foreign.outputs.manifest_key.replace(v.id, other.id);
    expect((await post(run, v, foreign)).json).toEqual({
      error: "invalid_body",
      detail: "outputs.manifest_key",
    });
    const climbing = body(run, v);
    climbing.outputs.report_key = climbing.outputs.report_key.replace(
      "report.json",
      "../../other/report.json",
    );
    expect((await post(run, v, climbing)).json).toEqual({
      error: "invalid_body",
      detail: "outputs.report_key",
    });
  });

  it("refuses output keys that climb out through encoded or backslash dot segments", async () => {
    const run = await seed();
    const v = run.volumes[0];
    const escapes = [
      "%2e%2e/%2E%2e/%2e%2e/%2e%2e/other-tenant/pipeline-runs/r/volumes/x/report.json",
      "..\\..\\..\\..\\..\\other-tenant/x.json",
      ".%2e/.%2e/.%2e/.%2e/other-tenant/report.json",
      "report.json?x=1",
      "report.json#x",
      "other.json",
    ];
    for (const field of ["manifest_key", "report_key"] as const) {
      for (const tail of escapes) {
        const b = body(run, v);
        const own = b.outputs[field];
        b.outputs[field] = own.slice(0, own.lastIndexOf("/") + 1) + tail;
        const before = await snapshotPipelineTables();
        const res = await post(run, v, b);
        expect(res.status).toBe(400);
        expect(res.json).toEqual({ error: "invalid_body", detail: `outputs.${field}` });
        expect(await snapshotPipelineTables()).toEqual(before);
      }
    }
  });

  // --- Host, cookie, size, methods ----------------------------------------

  it("answers only on the callback origin and writes the run's tenant", async () => {
    const run = await seed();
    const v = run.volumes[0];
    const b = body(run, v);
    const before = await snapshotPipelineTables();
    const offHost = await post(run, v, b, { host: OTHER_HOST });
    expect(offHost.status).toBe(404);
    expect(offHost.text).toBe("");
    expect(await snapshotPipelineTables()).toEqual(before);

    const unset = await post(run, v, b, { env: { PIPELINE_CALLBACK_ORIGIN: undefined } });
    expect(unset.status).toBe(404);

    const onHost = await post(run, v, b);
    expect(onHost.status).toBe(200);
    expect((await runVolumeRow(v)).tenant_id).toBe(DEFAULT_TEST_TENANT_ID);
    expect((await volumeRow(v)).tenant_id).toBe(DEFAULT_TEST_TENANT_ID);
  });

  it("does not take a session cookie in place of the token", async () => {
    const run = await seed();
    const v = run.volumes[0];
    const admin = await createTestUser({ isAdmin: true });
    const { getSession, commitSession } = createSessionStorage("test-session-secret");
    const session = await getSession();
    session.set("userId", admin.id);
    const cookie = (await commitSession(session)).split(";")[0];
    const res = await post(run, v, body(run, v), { token: null, headers: { Cookie: cookie } });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "invalid_token" });
  });

  it("refuses a body over 1 MB, declared or streamed", async () => {
    const run = await seed();
    const v = run.volumes[0];
    const declared = await post(run, v, body(run, v), { headers: { "Content-Length": "2000000" } });
    expect(declared.status).toBe(400);
    expect(declared.json).toEqual({ error: "invalid_body", detail: "body_too_large" });

    const chunk = new Uint8Array(64 * 1024).fill(32);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > 1_100_000) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const streamed = await post(run, v, body(run, v), { rawBody: stream });
    expect(streamed.status).toBe(400);
    expect(streamed.json).toEqual({ error: "invalid_body", detail: "body_too_large" });
    expect((await runVolumeRow(v)).status).toBe("dispatched");
  });

  it("answers other methods with 405 on the origin and 404 elsewhere", async () => {
    const run = await seed();
    const v = run.volumes[0];
    const before = await snapshotPipelineTables();
    expect((await get(ORIGIN, run, v)).status).toBe(405);
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await post(run, v, body(run, v), { method });
      expect(res.status).toBe(405);
    }
    expect(await snapshotPipelineTables()).toEqual(before);
    expect((await get(OTHER_HOST, run, v)).status).toBe(404);
    expect((await post(run, v, body(run, v), { method: "PUT", host: OTHER_HOST })).status).toBe(404);
  });

  it("never logs the token or returns it in a response body", () => {
    expect(tokens.size).toBeGreaterThan(0);
    expect(responseBodies.length).toBeGreaterThan(0);
    for (const token of tokens) {
      for (const line of logged) expect(line).not.toContain(token);
      for (const text of responseBodies) expect(text).not.toContain(token);
    }
  });

  // --- Review, re-runs, halts ---------------------------------------------

  it("stores review flags as items carrying the recipe, and leaves the volume Prepared", async () => {
    const run = await seed({ pageCount: 3 });
    const v = run.volumes[0];
    await seedGatePass(run);
    const flags = [
      { page_key: "p0001", stage: "render", code: "edge_overflow", summary: "One." },
      { page_key: "p0002", stage: "preprocess", code: "skew", summary: "Two." },
    ];
    const res = await post(run, v, body(run, v, { outcome: "review_pending", flags }));
    expect(res.status).toBe(200);
    const vol = await volumeRow(v);
    expect(vol.state).toBe("prepared");
    expect(vol.open_review_count).toBe(2);
    const { results } = await env.DB.prepare(
      "SELECT id, page_key, declaration_id, declaration_version, script_version FROM pipeline_review_items ORDER BY page_key",
    ).all<Json>();
    expect(results.map((r) => r.page_key)).toEqual(["p0001", "p0002"]);
    for (const r of results) {
      expect(r.declaration_id).toBe(run.declarationId);
      expect(r.declaration_version).toBe(run.declarationVersion);
      expect(r.script_version).toBe("v1.0.0");
    }
    const storedFlags = JSON.parse((await runVolumeRow(v)).flags) as Json[];
    expect(storedFlags.map((f) => f.id).sort()).toEqual(results.map((r) => r.id).sort());
  });

  it("replaces an aborted report from a re-run while the run is open, without counting it twice", async () => {
    const run = await seed({ volumeCount: 2, chunkCount: 2, chunkOf: (i) => i });
    const [v0] = run.volumes;
    const aborted = await post(run, v0, body(run, v0, { outcome: "aborted", attempt: "100.1" }));
    expect(aborted.status).toBe(200);
    await closeChunk(run, 0);
    expect((await runRow(run)).token_revoked_at).toBeNull();
    const rerun = await post(run, v0, body(run, v0, { attempt: "200.1" }));
    expect(rerun.status).toBe(200);
    expect((await runRow(run)).volumes_reported).toBe(1);
    expect((await runVolumeRow(v0)).status).toBe("prepared");
    expect((await volumeRow(v0)).state).toBe("prepared");
  });

  it("accepts chunk 0's completion report for the re-run attempt and marks nothing", async () => {
    const run = await seed({ volumeCount: 2, chunkCount: 2, chunkOf: (i) => i });
    const [v0] = run.volumes;
    await post(run, v0, body(run, v0, { outcome: "aborted", attempt: "100.1" }));
    expect((await closeChunk(run, 0, "100.1")).status).toBe(200);
    expect((await post(run, v0, body(run, v0, { attempt: "200.1" }))).status).toBe(200);
    const before = await runVolumeRow(v0);
    const res = await closeChunk(run, 0, "200.1");
    expect(res.status).toBe(200);
    const chunk = await first("SELECT * FROM pipeline_run_chunks WHERE run_id = ? AND chunk_index = 0", run.runId);
    expect(chunk.idempotency_key).toBe(`${run.runId}:chunk:0:200.1`);
    expect(await runVolumeRow(v0)).toEqual(before);
    expect((await runRow(run)).volumes_reported).toBe(1);
  });

  it("refuses a new attempt after a prepared report", async () => {
    const run = await seed();
    const v = run.volumes[0];
    await post(run, v, body(run, v, { attempt: "1.1" }));
    const res = await post(run, v, body(run, v, { attempt: "2.1" }));
    expect(res.status).toBe(409);
  });

  it("halts the run on a systemic error and keeps recording in-flight volumes", async () => {
    const run = await seed({ volumeCount: 2 });
    const [v1, v2] = run.volumes;
    const halted = await post(run, v1, body(run, v1, { outcome: "halted", errorClass: "auth" }));
    expect(halted.status).toBe(200);
    expect(halted.json).toEqual({ accepted: true, run_status: "halted", halted: true });
    const r = await runRow(run);
    expect(r.status).toBe("halted");
    expect(JSON.parse(r.error)).toEqual({ class: "auth", volume_id: v1.id, message: "The stage failed." });
    expect(r.token_revoked_at).toBeNull();
    const next = await post(run, v2, body(run, v2));
    expect(next.status).toBe(200);
    expect(next.json?.halted).toBe(true);
    expect((await volumeRow(v2)).state).toBe("prepared");
  });

  it("never closes a run from a callback; the chunk's report does", async () => {
    const run = await seed({ volumeCount: 2 });
    const [v1, v2] = run.volumes;
    await post(run, v1, body(run, v1));
    await post(run, v2, body(run, v2, { outcome: "aborted" }));
    let r = await runRow(run);
    expect(r.status).toBe("running");
    expect(r.token_revoked_at).toBeNull();
    await closeChunk(run, 0);
    r = await runRow(run);
    expect(r.status).toBe("completed");
    expect(r.token_revoked_at).not.toBeNull();
    const before = await snapshotPipelineTables();
    const rerun = await post(run, v2, body(run, v2, { attempt: "9.1" }));
    expect(rerun.status).toBe(409);
    expect(rerun.json).toEqual({ error: "conflict", detail: "run_closed" });
    expect(await snapshotPipelineTables()).toEqual(before);
  });

  it("makes a volume Ready only with a gate pass for the exact declaration row", async () => {
    const withPass = await seed();
    await seedGatePass(withPass);
    await post(withPass, withPass.volumes[0], body(withPass, withPass.volumes[0]));
    expect((await volumeRow(withPass.volumes[0])).state).toBe("ready");

    const without = await seed();
    await post(without, without.volumes[0], body(without, without.volumes[0]));
    expect((await volumeRow(without.volumes[0])).state).toBe("prepared");

    const amended = await seed({ declarationVersion: 2 });
    const earlier = await seedDeclaration({
      tenantId: amended.tenantId,
      scopeDescriptionId: amended.scopeDescriptionId,
      createdBy: amended.userId,
      version: 1,
    });
    await seedGatePass(amended, { declarationId: earlier.id });
    await post(amended, amended.volumes[0], body(amended, amended.volumes[0]));
    expect((await volumeRow(amended.volumes[0])).state).toBe("prepared");
  });

  it("refuses a report for a volume that has left Received", async () => {
    const run = await seed();
    const v = run.volumes[0];
    await env.DB.prepare("UPDATE pipeline_volumes SET state = 'prepared' WHERE id = ?").bind(v.id).run();
    const before = await snapshotPipelineTables();
    const res = await post(run, v, body(run, v));
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: "conflict", detail: "volume_state" });
    expect(await snapshotPipelineTables()).toEqual(before);
  });

  it("stores 500 flags in one small batch", async () => {
    const run = await seed();
    const v = run.volumes[0];
    const flags = Array.from({ length: 500 }, (_, i) => ({
      page_key: `p${String(i + 1).padStart(4, "0")}`,
      stage: "render",
      code: "edge_overflow",
      summary: "A flag.",
    }));
    const b = body(run, v, { outcome: "review_pending", flags });
    const res = await post(run, v, b);
    expect(res.status).toBe(200);
    expect(
      (await first<{ n: number }>("SELECT COUNT(*) AS n FROM pipeline_review_items")).n,
    ).toBe(500);
    expect((await volumeRow(v)).open_review_count).toBe(500);

    const parsed = volumeCallbackBodySchema.parse(b);
    const statements = buildCallbackStatements(drizzle(env.DB), {
      run: { id: run.runId, tenantId: run.tenantId, scriptVersion: "v1.0.0" },
      row: {
        id: v.runVolumeId,
        pipelineVolumeId: v.id,
        declarationId: run.declarationId,
        tileRoot: v.referenceCode,
      },
      observedClaim: null,
      observedStatus: "dispatched",
      newClaim: "claim",
      body: parsed,
      idempotencyKey: callbackIdempotencyKey(b),
      bodySha256: "0".repeat(64),
      flagIds: parsed.flags.map((_, i) => `flag-${i}`),
      now: 1,
    });
    expect(statements.length).toBeLessThanOrEqual(11);
    const counts = statements.map((s) => paramsOf(s).length);
    for (const n of counts) expect(n).toBeLessThanOrEqual(100);
    const raw = statements.filter((s) => !("toSQL" in (s as any)));
    expect(raw).toHaveLength(1);
    expect(paramsOf(raw[0])).toHaveLength(5);
  });

  it("halts the run when too large a share of volumes is pending review", async () => {
    const run = await seed({ volumeCount: 4, maxReviewFrac: 0.25 });
    const [a, b] = run.volumes;
    const r1 = await post(run, a, body(run, a, { outcome: "review_pending" }));
    expect(r1.json?.halted).toBe(false);
    expect((await runRow(run)).status).toBe("running");
    const r2 = await post(run, b, body(run, b, { outcome: "review_pending" }));
    expect(r2.json?.halted).toBe(true);
    const r = await runRow(run);
    expect(r.status).toBe("halted");
    expect(JSON.parse(r.error)).toEqual({ class: "max_review_frac", review_pending: 2, volume_count: 4 });
  });

  it("answers token_expired once the expiry close has run", async () => {
    const run = await seed({ tokenExpiresAt: Date.now() - 1000 });
    await expireRun(drizzle(env.DB), { runId: run.runId, tenantId: run.tenantId }, Date.now());
    expect((await runRow(run)).status).toBe("error");
    const v = run.volumes[0];
    const res = await post(run, v, body(run, v));
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "token_expired" });
  });

  it("answers a lost response retried after the run closed with the stored body", async () => {
    const run = await seed();
    const v = run.volumes[0];
    const b = body(run, v);
    const firstRes = await post(run, v, b);
    await closeChunk(run, 0);
    expect((await runRow(run)).token_revoked_at).not.toBeNull();
    const again = await post(run, v, b);
    expect(again.status).toBe(200);
    expect(again.text).toBe(firstRes.text);
  });

  it("transitions once when two identical first reports arrive together", async () => {
    const run = await seed();
    const v = run.volumes[0];
    const b = body(run, v);
    const [x, y] = await Promise.all([post(run, v, b), post(run, v, b)]);
    expect(x.status).toBe(200);
    expect(y.status).toBe(200);
    expect(x.text).toBe(y.text);
    expect((await runRow(run)).volumes_reported).toBe(1);
    expect((await volumeRow(v)).state).toBe("prepared");

    // A batch built from a stale read changes nothing.
    const before = await snapshotPipelineTables();
    const db = drizzle(env.DB);
    const statements = buildCallbackStatements(db, {
      run: { id: run.runId, tenantId: run.tenantId, scriptVersion: "v1.0.0" },
      row: { id: v.runVolumeId, pipelineVolumeId: v.id, declarationId: run.declarationId, tileRoot: v.referenceCode },
      observedClaim: null,
      observedStatus: "dispatched",
      newClaim: "stale-claim",
      body: volumeCallbackBodySchema.parse(b),
      idempotencyKey: callbackIdempotencyKey(b),
      bodySha256: "0".repeat(64),
      flagIds: [],
      now: Date.now(),
    });
    await db.batch(statements as any);
    expect(await snapshotPipelineTables()).toEqual(before);
  });

  it("accepts a report while the run is still pending", async () => {
    const run = await seed({ status: "pending" });
    const v = run.volumes[0];
    const res = await post(run, v, body(run, v));
    expect(res.status).toBe(200);
    expect((await runRow(run)).status).toBe("running");
    expect((await volumeRow(v)).state).toBe("prepared");
  });

  it("reads the rest of a truncated flag list in the background", async () => {
    const run = await seed();
    const v = run.volumes[0];
    const flags = Array.from({ length: 500 }, (_, i) => ({
      page_key: `p${String(i + 1).padStart(4, "0")}`,
      stage: "render",
      code: "edge_overflow",
      summary: "A flag.",
    }));
    const b = body(run, v, { outcome: "review_pending", flags, flagsTruncated: true });
    const reportFlags = Array.from({ length: 520 }, (_, i) => ({
      page_key: `p${String(i + 1).padStart(4, "0")}`,
      stage: "render",
      code: "edge_overflow",
      summary: "A flag.",
      evidence: {},
      corroboration: null,
    }));
    const reader: MediaObjectReader = {
      async getText(bucket, key) {
        expect(bucket).toBe(WORKING_BUCKET);
        expect(key).toBe(b.outputs.report_key);
        return JSON.stringify({ spec_version: 1, flags: reportFlags, pages: [] });
      },
    };
    const waits: Promise<unknown>[] = [];
    const request = new Request(url(ORIGIN, run.runId, v.id), {
      method: "POST",
      headers: callbackHeaders(run.token, b),
      body: JSON.stringify(b),
    });
    const res = await handleVolumeCallback(
      {
        db: drizzle(env.DB),
        env: testEnv(),
        reader,
        waitUntil: (p) => waits.push(p),
        now: () => Date.now(),
        newId: () => crypto.randomUUID(),
      },
      request,
      { runId: run.runId, volumeId: v.id },
    );
    expect(res.status).toBe(200);
    expect(waits).toHaveLength(1);
    await waits[0];
    expect(
      (await first<{ n: number }>("SELECT COUNT(*) AS n FROM pipeline_review_items")).n,
    ).toBe(520);
    expect((await volumeRow(v)).open_review_count).toBe(520);
    expect((await runVolumeRow(v)).flags_ingested_at).not.toBeNull();
  });

  it("refuses a new attempt on a halted run once its chunk has closed it", async () => {
    const run = await seed({ volumeCount: 2 });
    const [v1, v2] = run.volumes;
    await post(run, v1, body(run, v1, { outcome: "halted", errorClass: "destination" }));
    await post(run, v2, body(run, v2, { outcome: "aborted" }));
    await closeChunk(run, 0);
    const r = await runRow(run);
    expect(r.status).toBe("halted");
    expect(r.token_revoked_at).not.toBeNull();
    const before = await snapshotPipelineTables();
    const res = await post(run, v2, body(run, v2, { attempt: "5.1" }));
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: "conflict", detail: "run_closed" });
    expect(await snapshotPipelineTables()).toEqual(before);
  });

  it("writes nothing when the run closes between the checks and the batch", async () => {
    const run = await seed();
    const v = run.volumes[0];
    const b = body(run, v);
    const real = drizzle(env.DB);
    let snapshot: Record<string, unknown[]> | null = null;
    const db = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async (statements: unknown) => {
            await closeChunk(run, 0);
            snapshot = await snapshotPipelineTables();
            return target.batch(statements as any);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const request = new Request(url(ORIGIN, run.runId, v.id), {
      method: "POST",
      headers: callbackHeaders(run.token, b),
      body: JSON.stringify(b),
    });
    const res = await handleVolumeCallback(
      {
        db,
        env: testEnv(),
        reader: { getText: async () => null },
        waitUntil: () => {},
        now: () => Date.now(),
        newId: () => crypto.randomUUID(),
      },
      request,
      { runId: run.runId, volumeId: v.id },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict", detail: "run_closed" });
    expect(snapshot).not.toBeNull();
    expect(await snapshotPipelineTables()).toEqual(snapshot);
  });

  it("lets exactly one of two competing re-run attempts win", async () => {
    const run = await seed({ pageCount: 4 });
    const v = run.volumes[0];
    await post(run, v, body(run, v, { outcome: "aborted", attempt: "1.1" }));
    const flagsA = [{ page_key: "p0001", stage: "render", code: "a", summary: "A." }];
    const flagsB = [
      { page_key: "p0002", stage: "render", code: "b", summary: "B." },
      { page_key: "p0003", stage: "render", code: "b", summary: "B." },
    ];
    const bodyA = body(run, v, { outcome: "review_pending", attempt: "2.1", flags: flagsA });
    const bodyB = body(run, v, { outcome: "review_pending", attempt: "3.1", flags: flagsB });
    const [a, b] = await Promise.all([post(run, v, bodyA), post(run, v, bodyB)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = a.status === 200 ? bodyA : bodyB;
    const { results } = await env.DB.prepare(
      "SELECT id, page_key, code FROM pipeline_review_items ORDER BY page_key",
    ).all<Json>();
    expect(results.map((r) => r.page_key)).toEqual(winner.flags.map((f: Json) => f.page_key));
    const storedFlags = JSON.parse((await runVolumeRow(v)).flags) as Json[];
    expect(storedFlags.map((f) => f.id).sort()).toEqual(results.map((r) => r.id).sort());
    expect((await runVolumeRow(v)).attempt).toBe(winner.attempt);
  });

  it("keeps a halted run's halt when its token expires", async () => {
    const haltError = { class: "auth", volume_id: "x", message: "m" };
    const run = await seed({
      status: "halted",
      error: haltError,
      tokenExpiresAt: Date.now() - 1000,
    });
    const v = run.volumes[0];
    const res = await post(run, v, body(run, v));
    expect(res.json).toEqual({ error: "token_expired" });
    const r = await runRow(run);
    expect(r.status).toBe("halted");
    expect(JSON.parse(r.error)).toEqual(haltError);
    expect(r.token_revoked_at).not.toBeNull();
  });

  it("answers every non-replay with token_expired after expiry, and replays with the stored body", async () => {
    const run = await seed();
    const v = run.volumes[0];
    const b = body(run, v);
    const accepted = await post(run, v, b);
    expect(accepted.status).toBe(200);
    const past = Date.now() - 1000;
    await env.DB.prepare(
      "UPDATE pipeline_runs SET spec_url_expires_at = ?, token_expires_at = ? WHERE id = ?",
    )
      .bind(past - 1000, past, run.runId)
      .run();

    const stranger: SeededVolume = { ...v, id: crypto.randomUUID() };
    const unknown = await post(run, stranger, body(run, stranger));
    expect(unknown.status).toBe(401);
    expect(unknown.json).toEqual({ error: "token_expired" });

    const changed = structuredClone(b);
    changed.elapsed_s = 5;
    const altered = await post(run, v, changed);
    expect(altered.status).toBe(401);

    const replay = await post(run, v, b);
    expect(replay.status).toBe(200);
    expect(replay.text).toBe(accepted.text);
  });

  it("records an aborted volume without halting the run", async () => {
    const run = await seed({ volumeCount: 2 });
    const [v1, v2] = run.volumes;
    const res = await post(run, v1, body(run, v1, { outcome: "aborted", errorClass: "image" }));
    expect(res.status).toBe(200);
    expect(res.json?.halted).toBe(false);
    const rv = await runVolumeRow(v1);
    expect(rv.status).toBe("aborted");
    expect(JSON.parse(rv.error).class).toBe("image");
    const vol = await volumeRow(v1);
    expect(vol.state).toBe("received");
    expect(JSON.parse(vol.last_error).class).toBe("image");
    expect(vol.last_run_id).toBe(run.runId);
    const r = await runRow(run);
    expect(r.volumes_reported).toBe(1);
    expect(r.status).toBe("running");
    const sibling = await post(run, v2, body(run, v2));
    expect(sibling.status).toBe(200);
    expect((await volumeRow(v2)).state).toBe("prepared");
  });

  it("records a fixity error as an aborted volume, with its page keys, without halting the run", async () => {
    const run = await seed({ volumeCount: 2 });
    const [v1, v2] = run.volumes;
    const report = body(run, v1, { outcome: "aborted", errorClass: "fixity" });
    report.error = { ...report.error, stage: "pull", page_keys: ["p0002", "p0005"] };
    const res = await post(run, v1, report);
    expect(res.status).toBe(200);
    expect(res.json?.halted).toBe(false);
    const rv = await runVolumeRow(v1);
    expect(rv.status).toBe("aborted");
    expect(JSON.parse(rv.error)).toMatchObject({ class: "fixity", page_keys: ["p0002", "p0005"] });
    expect((await volumeRow(v1)).state).toBe("received");
    expect((await runRow(run)).status).toBe("running");
    const sibling = await post(run, v2, body(run, v2));
    expect(sibling.json?.halted).toBe(false);
  });

  it("halts on a source pull error and on a destination error", async () => {
    for (const errorClass of ["source_pull", "destination"]) {
      const run = await seed({ volumeCount: 2 });
      const [v1, v2] = run.volumes;
      await post(run, v1, body(run, v1, { outcome: "halted", errorClass }));
      const r = await runRow(run);
      expect(r.status).toBe("halted");
      expect(JSON.parse(r.error).class).toBe(errorClass);
      expect(r.token_revoked_at).toBeNull();
      const next = await post(run, v2, body(run, v2));
      expect(next.json?.halted).toBe(true);
    }
  });

  it("completes an expired run whose volumes have all reported", async () => {
    const run = await seed({
      status: "running",
      volumesReported: 1,
      tokenExpiresAt: Date.now() - 1000,
    });
    const v = run.volumes[0];
    const res = await post(run, v, body(run, v, { attempt: "7.1" }));
    expect(res.json).toEqual({ error: "token_expired" });
    const r = await runRow(run);
    expect(r.status).toBe("completed");
    expect(r.completed_at).not.toBeNull();
    expect(r.token_revoked_at).not.toBeNull();
    expect(r.error).toBeNull();
  });

  it("keeps a recorded dispatch error when an expired run ends in error", async () => {
    const dispatchError = { class: "dispatch", chunk_index: 0, status: 500 };
    const run = await seed({ error: dispatchError, tokenExpiresAt: Date.now() - 1000 });
    const v = run.volumes[0];
    const res = await post(run, v, body(run, v));
    expect(res.json).toEqual({ error: "token_expired" });
    const r = await runRow(run);
    expect(r.status).toBe("error");
    expect(JSON.parse(r.error)).toEqual(dispatchError);
  });

  it("hashes the raw body bytes for the replay check", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

// @version v0.8.0
