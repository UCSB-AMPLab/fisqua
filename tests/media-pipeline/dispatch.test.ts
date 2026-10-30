/**
 * Tests — media pipeline dispatch
 *
 * This suite drives `startPipelineRun` against the local D1 database
 * and the R2 binding, with a stub `fetch` standing in for GitHub (its
 * App token exchange and its dispatch endpoint), a GitHub App key
 * generated for the suite, and a test manifest resolver. It pins:
 *
 *   - the refusals and their order: the gate, the settings, the runner
 *     image pin, run size, volumes of another tenant, volume state and
 *     kind, a published volume, holds by open runs, reference codes,
 *     declarations and gate passes, page lists, a description not
 *     found in the tenant, manifest inputs, the presigned URL ceiling and
 *     restricted material, which is checked last and is decided by the
 *     volume's restricted flag, never by the access-conditions text; the
 *     claim takes no volume flagged since it was read;
 *   - what a dispatched run records: the run, its chunks and one
 *     run-volume row per volume with the declaration version it applied,
 *     the spec stored under the tenant-first key with its SHA-256, the
 *     token only inside the stored spec, and lifetimes that end the URL
 *     before the token;
 *   - chunking past 256 jobs, the dispatch requests' shape and size,
 *     and the D1 limits on parameters (the chunk insert included, past
 *     16 chunks), batch sizes and the statement budget;
 *   - the GitHub App: every setting it needs is required and the runner
 *     repository must be `owner/name`; dispatches carry an installation
 *     token minted once for the runner repository alone, which reaches
 *     neither D1, the spec nor the logs; a key that does not import is
 *     refused before anything is claimed; a refused token exchange, a
 *     201 with a null body, and a failure the token module does not
 *     name each close the run unsent and free its volumes, recording
 *     only the step and the status;
 *   - dispatch failures: a refused chunk, a chunk whose fate is unknown,
 *     a ledger failure, and a fast callback or completion report that a
 *     late 204 must not undo;
 *   - concurrent starts for the same volumes: one wins the claim, the
 *     other is refused and leaves a closed run with no ledger rows;
 *   - expiry at start: the tenant's expired open runs are closed before
 *     holds are read, and other tenants' runs are not touched;
 *   - the tenant's storage destination: a tenant whose federation has an
 *     unset column or a missing secret is refused naming what is missing
 *     and no value, and tenants of two federations get specs and
 *     manifest ids that name their own federation's buckets, hosts and
 *     image addresses, under their own slugs, with no key in either;
 *   - the capture QC hold: a volume whose pages came from a Captua
 *     delivery is refused with `capture_qc_pending` until every opening
 *     of its current delivery is approved, then runs, whether the
 *     manifest came over the link or from a file with the registration
 *     command, whose statements record a delivery and whose volume is
 *     decided as a link volume is; a delivery with a record `rejected`
 *     holds with every opening approved, and with no openings at all,
 *     until a newer delivery brings the record back retaken and that
 *     opening is approved; a delivery with no openings and no rejected
 *     record (every record still `captured`) does not hold, and one with
 *     openings and captured records holds until its openings are
 *     approved, records stored packed included, since the hold reads the
 *     delivery's counts; volumes from
 *     elsewhere, and volumes a run has already named, are not held; the
 *     claim takes no volume whose QC a decision reopened since it was
 *     read, nor one whose delivery has a rejected record;
 *   - the runner's key store: the spec names
 *     `fisqua-pipeline-{tenantId}` in production and
 *     `fisqua-pipeline-staging-{tenantId}` on staging, and a deployment
 *     whose `PIPELINE_ENVIRONMENT` is unset or neither name is refused.
 *
 * The run-size limits, lifetime constants, grouping target and presets
 * are passed in; the values here are test values.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedFederations,
  DEFAULT_TEST_FEDERATION_ID,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { makeUserContext } from "../helpers/context";
import {
  seedReceivedVolumes,
  seedPipelineRun,
  seedDeclaration,
  insertRow,
  makeVolumeCallback,
  callbackHeaders,
  seedTenantDestination,
  testSecrets,
  githubAppEnv,
  githubAppTestKeys,
  withTokenExchange,
  TEST_INSTALLATION_TOKEN,
  TEST_SCRIPT_VERSION,
  TEST_MANIFEST_BASE,
  TEST_DESTINATION,
  type ReceivedVolumes,
  type SeededRun,
  type TokenExchange,
} from "../helpers/media-pipeline";
import { clearGitHubAppCaches } from "../../app/lib/pipeline/github-app.server";
import {
  startPipelineRun,
  buildClaimStatements,
  StartRunRefusal,
  RUN_VOLUME_INSERT_PARAMS,
  type PipelineRunConfig,
  type StartRunDeps,
  type StartRunInput,
} from "../../app/lib/pipeline/dispatch.server";
import { handleVolumeCallback } from "../../app/lib/pipeline/callback.server";
import { closeRunIfChunksDone } from "../../app/lib/pipeline/run-state.server";
import { getPipelineSpecStore, pipelineKey } from "../../app/lib/pipeline/store.server";
import { TONAL_DEFAULT_PRESET, ITEM_PDF_DPI } from "../../app/lib/pipeline/recipe";
import {
  ManifestInputsError,
  validateRunSpec,
  type ManifestResolver,
} from "../../app/lib/pipeline/run-spec";
import { manifestResolver } from "../../app/lib/pipeline/manifest-inputs";
import { recordDecisionsAction } from "../../app/lib/capture/qc.server";
import { applyInventory, checkCaptureManifest, planVolumes } from "../../app/lib/capture/manifest";
import { fileRegistrationSql } from "../../app/lib/capture/file-route.server";
import { CARRY_GATE_PASSES_SQL, GATE_PASS_CARRY_NOTE } from "../../scripts/lib/gate-pass-carry";
import type { Tenant, User } from "../../app/context";

type Json = Record<string, any>;

// The GitHub App's private key for this suite, generated once and
// spread into every test environment by `deps`.
let appEnv: Record<string, string> = {};
beforeAll(async () => {
  appEnv = await githubAppEnv();
});
beforeEach(() => clearGitHubAppCaches());

const LIFETIME = {
  secondsPerImage: 0.95,
  perJobOverheadSeconds: 120,
  lanes: 16,
  chunkSpacingSeconds: 60,
  queueAllowanceSeconds: 600,
  marginFactor: 1.5,
  tokenFloorSeconds: 3600,
  urlFloorSeconds: 1800,
  callbackTailSeconds: 600,
};

const CONFIG: PipelineRunConfig = {
  maxRunVolumes: 2000,
  maxRunPages: 250_000,
  maxSampleVolumes: 2000,
  targetImagesPerJob: 734,
  lifetime: LIFETIME,
  presets: {
    byOutputClass: { tonal: TONAL_DEFAULT_PRESET },
    acceptedKeys: { preprocess: [], render: [] },
  },
};

/** One job per volume, so a few hundred small volumes make two chunks. */
const ONE_PER_JOB: PipelineRunConfig = { ...CONFIG, targetImagesPerJob: 1 };

const testManifest: ManifestResolver = (v) => ({
  id: `https://iiif.example.test/${v.referenceCode}/manifest.json`,
  label: { es: [v.referenceCode] },
  homepage: [
    {
      id: `https://catalogue.example.test/${v.referenceCode}`,
      type: "Text",
      format: "text/html",
      label: { es: [v.referenceCode] },
    },
  ],
  rights: null,
  required_statement: null,
  provider: [],
});

/** A resolver that has no inputs to build from. */
const unavailableManifest: ManifestResolver = (v) => {
  throw new ManifestInputsError(`No manifest inputs for volume ${v.id}`);
};

// ---------------------------------------------------------------------------
// Observation: console output, dispatch requests, D1 statements
// ---------------------------------------------------------------------------

const logged: string[] = [];

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
  json: Json;
}

type Reply = number | "network";

/**
 * A stub GitHub: the App's token exchange answers with `exchange`, a
 * status or a response (201 and `TEST_INSTALLATION_TOKEN` by default),
 * and is recorded in
 * `exchanges`; each dispatch is recorded in `sent` and answered by
 * `reply`.
 */
function stubFetch(
  reply: (chunkIndex: number) => Reply | Promise<Reply> = () => 204,
  exchange: number | (() => Response) = 201,
): { fetchImpl: typeof fetch; sent: Sent[]; exchanges: TokenExchange[] } {
  const sent: Sent[] = [];
  const exchanges: TokenExchange[] = [];
  const dispatchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    const json = JSON.parse(body);
    sent.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
      json,
    });
    const r = await reply(json.client_payload.chunk_index);
    if (r === "network") throw new TypeError("network error");
    return new Response(null, { status: r });
  }) as typeof fetch;
  const fetchImpl = withTokenExchange(dispatchImpl, {
    ...(typeof exchange === "number" ? { status: exchange } : { reply: exchange }),
    exchanges,
  });
  return { fetchImpl, sent, exchanges };
}

interface D1Stats {
  statements: number;
  batches: number[];
  maxParams: number;
}

/**
 * A D1 binding that counts every statement it runs (each batch item on
 * its own), records the largest parameter list bound, and can fail a
 * chosen batch or hold batches at a barrier.
 */
function observedD1(
  real: D1Database,
  opts: { failBatch?: (n: number) => boolean; beforeBatch?: (n: number) => Promise<void> } = {},
): { binding: D1Database; stats: D1Stats } {
  const stats: D1Stats = { statements: 0, batches: [], maxParams: 0 };
  const realOf = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") {
          return (...args: unknown[]) => {
            stats.maxParams = Math.max(stats.maxParams, args.length);
            return wrap(target.bind(...args));
          };
        }
        if (prop === "all" || prop === "run" || prop === "first" || prop === "raw") {
          return (...args: unknown[]) => {
            stats.statements++;
            return (target as any)[prop](...args);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    realOf.set(proxy, stmt);
    return proxy;
  };
  let batchNo = 0;
  const binding = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") return (q: string) => wrap(target.prepare(q));
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          batchNo++;
          const n = batchNo;
          stats.statements += stmts.length;
          stats.batches.push(stmts.length);
          if (opts.beforeBatch) await opts.beforeBatch(n);
          if (opts.failBatch?.(n)) throw new Error("injected batch failure");
          return target.batch(stmts.map((s) => realOf.get(s) ?? s));
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { binding, stats };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function leadTenant(mediaPipelineEnabled = true): Promise<Tenant> {
  await seedTenantDestination();
  const db = drizzle(env.DB, { schema });
  const row = await db
    .select()
    .from(schema.tenants)
    .where(eq(schema.tenants.id, DEFAULT_TEST_TENANT_ID))
    .get();
  return { ...(row as Tenant), mediaPipelineEnabled };
}

async function leadAdmin(): Promise<User> {
  const user = await createTestUser({ isAdmin: true });
  return makeUserContext({ id: user.id, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
}

interface Setup {
  tenant: Tenant;
  user: User;
  seeded: ReceivedVolumes;
}

async function setup(opts: Parameters<typeof seedReceivedVolumes>[0] = {}): Promise<Setup> {
  const tenant = await leadTenant();
  const user = await leadAdmin();
  const seeded = await seedReceivedVolumes({ userId: user.id, ...opts });
  return { tenant, user, seeded };
}

function deps(
  overrides: Partial<StartRunDeps> & { envOverrides?: Record<string, unknown> } = {},
): StartRunDeps {
  const { envOverrides, ...rest } = overrides;
  const testEnv = { ...env, ...appEnv, ...(envOverrides ?? {}) } as any;
  return {
    db: drizzle(env.DB),
    env: testEnv,
    specStore: getPipelineSpecStore(testEnv),
    fetchImpl: stubFetch().fetchImpl,
    manifestResolverFor: () => testManifest,
    config: CONFIG,
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    ...rest,
  };
}

function input(s: Setup, overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    tenant: s.tenant,
    user: s.user,
    pipelineVolumeIds: s.seeded.volumes.map((v) => v.id),
    kind: "volume_run",
    purpose: "sample",
    maxReviewFrac: 0.1,
    ...overrides,
  };
}

async function refusal(promise: Promise<unknown>): Promise<StartRunRefusal> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof StartRunRefusal) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

async function thrownStatus(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof Response) return e.status;
    throw e;
  }
  throw new Error("expected a thrown Response");
}

async function all<T = Json>(query: string, ...binds: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(query).bind(...binds).all<T>()).results;
}
async function first<T = Json>(query: string, ...binds: unknown[]): Promise<T> {
  return (await env.DB.prepare(query).bind(...binds).first<T>()) as T;
}

const PLAN_TABLES = [
  "pipeline_recipe_declarations",
  "pipeline_volumes",
  "pipeline_volume_pages",
  "pipeline_runs",
  "pipeline_run_chunks",
  "pipeline_run_volumes",
  "pipeline_review_items",
  "pipeline_gate_passes",
];

async function snapshot(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of PLAN_TABLES) out[t] = await all(`SELECT * FROM ${t} ORDER BY id`);
  return out;
}

async function storedSpecKeys(tenantId = DEFAULT_TEST_TENANT_ID): Promise<string[]> {
  const listed = await env.SPEC_BUCKET.list({ prefix: `${tenantId}/pipeline-runs/` });
  return listed.objects.map((o) => o.key).filter((k) => k.endsWith("/spec.json"));
}

async function storedSpec(runId: string, tenantId = DEFAULT_TEST_TENANT_ID): Promise<{ text: string; json: Json }> {
  const object = await env.SPEC_BUCKET.get(pipelineKey.spec(tenantId, runId));
  if (!object) throw new Error(`no spec stored for run ${runId}`);
  const text = await object.text();
  return { text, json: JSON.parse(text) };
}

async function sha256(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function clearSpecs(): Promise<void> {
  for (const tenantId of [DEFAULT_TEST_TENANT_ID, SECOND_TEST_TENANT_ID]) {
    const listed = await env.SPEC_BUCKET.list({ prefix: `${tenantId}/pipeline-runs/` });
    for (const o of listed.objects) await env.SPEC_BUCKET.delete(o.key);
  }
}

async function holdVolume(volumeId: string, runId: string): Promise<void> {
  await env.DB.prepare("UPDATE pipeline_volumes SET held_by_run_id = ? WHERE id = ?")
    .bind(runId, volumeId)
    .run();
}

// ---------------------------------------------------------------------------

describe("startPipelineRun", () => {
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
    await seedFederations();
    await clearSpecs();
  });

  // --- Gate, settings, size ------------------------------------------------

  it("answers 404 with the capability off and writes, stores and sends nothing", async () => {
    const s = await setup();
    s.tenant = await leadTenant(false);
    const { fetchImpl, sent } = stubFetch();
    const before = await snapshot();
    expect(await thrownStatus(startPipelineRun(deps({ fetchImpl }), input(s)))).toBe(404);
    expect(sent).toHaveLength(0);
    expect(await storedSpecKeys()).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("answers 404 for a volume of another tenant and writes nothing", async () => {
    const s = await setup();
    const other = await seedReceivedVolumes({ tenantId: SECOND_TEST_TENANT_ID });
    const { fetchImpl, sent } = stubFetch();
    const before = await snapshot();
    const r = await refusal(
      startPipelineRun(
        deps({ fetchImpl }),
        input(s, { pipelineVolumeIds: [s.seeded.volumes[0].id, other.volumes[0].id] }),
      ),
    );
    expect(r.status).toBe(404);
    expect(r.code).toBe("volume_not_found");
    expect(sent).toHaveLength(0);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a prepared volume with volume_state and a published one with regeneration_not_supported", async () => {
    const s = await setup({ count: 2 });
    const [a, b] = s.seeded.volumes;
    await env.DB.prepare("UPDATE pipeline_volumes SET state = 'prepared' WHERE id = ?").bind(a.id).run();
    const before = await snapshot();
    expect((await refusal(startPipelineRun(deps(), input(s, { pipelineVolumeIds: [a.id] })))).code).toBe(
      "volume_state",
    );
    expect(await snapshot()).toEqual(before);
    await env.DB.prepare("UPDATE pipeline_volumes SET state = 'published' WHERE id = ?").bind(b.id).run();
    const before2 = await snapshot();
    expect((await refusal(startPipelineRun(deps(), input(s, { pipelineVolumeIds: [b.id] })))).code).toBe(
      "regeneration_not_supported",
    );
    expect(await snapshot()).toEqual(before2);
  });

  it("refuses volumes held by an open running or halted run and accepts those of a closed run", async () => {
    const s = await setup({ count: 4 });
    const [a, b, c, d] = s.seeded.volumes;
    const running = await seedPipelineRun({ status: "running" });
    const halted = await seedPipelineRun({ status: "halted" });
    const completed = await seedPipelineRun({ status: "completed", tokenRevokedAt: Date.now() });
    const errored = await seedPipelineRun({ status: "error", tokenRevokedAt: Date.now() });
    await holdVolume(a.id, running.runId);
    await holdVolume(b.id, halted.runId);
    await holdVolume(c.id, completed.runId);
    await holdVolume(d.id, errored.runId);

    for (const v of [a, b]) {
      const r = await refusal(startPipelineRun(deps(), input(s, { pipelineVolumeIds: [v.id] })));
      expect(r.code).toBe("volume_in_open_run");
    }
    const ok = await startPipelineRun(deps(), input(s, { pipelineVolumeIds: [c.id, d.id] }));
    const held = await all<{ held_by_run_id: string }>(
      "SELECT held_by_run_id FROM pipeline_volumes WHERE id IN (?, ?)",
      c.id,
      d.id,
    );
    expect(held.map((h) => h.held_by_run_id)).toEqual([ok.runId, ok.runId]);
  });

  it("sends 300 single-volume jobs of 734 images as two chunks within D1's limits", async () => {
    const s = await setup({ count: 300, pageCount: 734 });
    const { fetchImpl, sent } = stubFetch();
    const { binding, stats } = observedD1(env.DB);
    const result = await startPipelineRun(deps({ fetchImpl, db: drizzle(binding) }), input(s));
    expect(result.chunkCount).toBe(2);
    expect(sent.map((r) => r.json.client_payload.chunk_index)).toEqual([0, 1]);
    for (const r of sent) {
      expect(r.url).toBe("https://api.github.com/repos/test-owner/test-runner/dispatches");
      expect(r.headers.accept).toBe("application/vnd.github+json");
      expect(r.headers["x-github-api-version"]).toBe("2022-11-28");
      expect(r.headers["user-agent"]).toBe("fisqua");
      expect(new TextEncoder().encode(r.body).byteLength).toBeLessThan(64 * 1024);
      expect(Object.keys(r.json).sort()).toEqual(["client_payload", "event_type"]);
      expect(r.json.event_type).toBe("fisqua-pipeline-run");
      expect(Object.keys(r.json.client_payload).sort()).toEqual(
        ["chunk_count", "chunk_index", "run_id", "spec_url", "spec_version"].sort(),
      );
      expect(r.json.client_payload.chunk_count).toBe(2);
      expect(r.json.client_payload.run_id).toBe(result.runId);
    }
    const chunks = await all<{ status: string }>(
      "SELECT status FROM pipeline_run_chunks WHERE run_id = ? ORDER BY chunk_index",
      result.runId,
    );
    expect(chunks.map((c) => c.status)).toEqual(["dispatched", "dispatched"]);
    expect(stats.maxParams).toBeLessThanOrEqual(100);
    expect(Math.max(...stats.batches)).toBeLessThanOrEqual(89);
  }, 120_000);

  it("keeps the token out of D1, logs and the dispatch request, and stores it once in the spec", async () => {
    const s = await setup({ count: 2 });
    const { fetchImpl, sent } = stubFetch();
    logged.length = 0;
    const { runId } = await startPipelineRun(deps({ fetchImpl }), input(s));
    const { text, json } = await storedSpec(runId);
    const token: string = json.callback.token;
    expect(token).toMatch(/^fpr_/);
    expect(occurrences(text, token)).toBe(1);

    const rows = JSON.stringify(
      await Promise.all(PLAN_TABLES.map((t) => all(`SELECT * FROM ${t}`))),
    );
    expect(rows).not.toContain(token);
    expect(rows).not.toContain(TEST_INSTALLATION_TOKEN);
    expect(logged.join("\n")).not.toContain(token);
    expect(logged.join("\n")).not.toContain(TEST_INSTALLATION_TOKEN);
    for (const r of sent) expect(r.body).not.toContain(token);
    expect(text).not.toContain(TEST_INSTALLATION_TOKEN);
    expect(sent[0].headers.authorization).toBe(`Bearer ${TEST_INSTALLATION_TOKEN}`);
  });

  it("dispatches with the App's installation token, minted once for the runner repository", async () => {
    const s = await setup({ count: 257, pageCount: 1 });
    const { fetchImpl, sent, exchanges } = stubFetch();
    logged.length = 0;
    const result = await startPipelineRun(deps({ fetchImpl, config: ONE_PER_JOB }), input(s));
    expect(result.chunkCount).toBe(2);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].url).toBe("https://api.github.com/app/installations/7654321/access_tokens");
    expect(exchanges[0].json).toEqual({
      repositories: ["test-runner"],
      permissions: { contents: "write" },
    });
    const jwt = exchanges[0].headers.authorization.replace(/^Bearer /, "");
    const [, claims] = jwt.split(".");
    expect(JSON.parse(atob(claims.replace(/-/g, "+").replace(/_/g, "/"))).iss).toBe("123456");
    expect(sent).toHaveLength(2);
    for (const r of sent) expect(r.headers.authorization).toBe(`Bearer ${TEST_INSTALLATION_TOKEN}`);

    const { pkcs1Pem } = await githubAppTestKeys();
    const rows = JSON.stringify(
      await Promise.all(PLAN_TABLES.map((t) => all(`SELECT * FROM ${t}`))),
    );
    const { text } = await storedSpec(result.runId);
    for (const secret of [jwt, pkcs1Pem, TEST_INSTALLATION_TOKEN]) {
      expect(rows).not.toContain(secret);
      expect(text).not.toContain(secret);
      expect(logged.join("\n")).not.toContain(secret);
    }
  });

  it("closes the run without sending when the token exchange is refused, naming the step and status", async () => {
    const s = await setup({ count: 2 });
    const { fetchImpl, sent, exchanges } = stubFetch(() => 204, 401);
    const { runId } = await startPipelineRun(deps({ fetchImpl }), input(s));
    expect(exchanges).toHaveLength(1);
    expect(sent).toEqual([]);
    const run = await first("SELECT * FROM pipeline_runs WHERE id = ?", runId);
    expect(run.status).toBe("error");
    expect(run.token_revoked_at).not.toBeNull();
    expect(JSON.parse(run.error)).toEqual({
      class: "dispatch",
      app_token_step: "token_exchange",
      chunk_index: 0,
      status: 401,
    });
    const chunk = await first("SELECT status, dispatch_error FROM pipeline_run_chunks WHERE run_id = ?", runId);
    expect(chunk.status).toBe("not_sent");
    expect(JSON.parse(chunk.dispatch_error)).toEqual({ app_token_step: "token_exchange", status: 401 });
    const rows = await all<{ status: string }>("SELECT status FROM pipeline_run_volumes WHERE run_id = ?", runId);
    expect(rows.map((r) => r.status)).toEqual(["aborted", "aborted"]);
    const again = await startPipelineRun(deps(), input(s));
    expect(again.runId).not.toBe(runId);
  });

  it("refuses with dispatch_unconfigured, before claiming anything, when the App's private key does not import", async () => {
    const s = await setup({ count: 1 });
    const before = await snapshot();
    for (const key of ["test-github-app-private-key", "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----"]) {
      const { fetchImpl, sent, exchanges } = stubFetch();
      const r = await refusal(
        startPipelineRun(deps({ fetchImpl, envOverrides: { PIPELINE_GITHUB_APP_PRIVATE_KEY: key } }), input(s)),
      );
      expect(r.code).toBe("dispatch_unconfigured");
      expect(r.detail).toEqual({ invalid: ["PIPELINE_GITHUB_APP_PRIVATE_KEY"] });
      expect(exchanges).toEqual([]);
      expect(sent).toEqual([]);
    }
    expect(await snapshot()).toEqual(before);
    expect(await storedSpecKeys()).toEqual([]);
  });

  it("closes the run without sending when the exchange answers 201 with a null body", async () => {
    const s = await setup({ count: 2 });
    const { fetchImpl, sent } = stubFetch(() => 204, () => new Response("null", { status: 201 }));
    const { runId } = await startPipelineRun(deps({ fetchImpl }), input(s));
    expect(sent).toEqual([]);
    const run = await first("SELECT * FROM pipeline_runs WHERE id = ?", runId);
    expect(run.status).toBe("error");
    expect(JSON.parse(run.error)).toEqual({
      class: "dispatch",
      app_token_step: "token_response",
      chunk_index: 0,
      status: 201,
    });
    const chunk = await first("SELECT status FROM pipeline_run_chunks WHERE run_id = ?", runId);
    expect(chunk.status).toBe("not_sent");
    const again = await startPipelineRun(deps(), input(s));
    expect(again.runId).not.toBe(runId);
  });

  it("closes every chunk unsent and frees the volumes when minting fails in a way the token module does not name", async () => {
    const s = await setup({ count: 257, pageCount: 1 });
    const { fetchImpl, sent, exchanges } = stubFetch();
    // The environment fails to read once the spec is published, so the
    // failure comes from inside token minting and is not a
    // GitHubAppTokenError.
    let published = false;
    const testEnv: Record<string, unknown> = { ...env, ...appEnv };
    const installationId = testEnv.PIPELINE_GITHUB_APP_INSTALLATION_ID;
    Object.defineProperty(testEnv, "PIPELINE_GITHUB_APP_INSTALLATION_ID", {
      get: () => {
        if (published) throw new Error("unexpected-failure-detail");
        return installationId;
      },
    });
    const store = getPipelineSpecStore(testEnv as any);
    const specStore = {
      ...store,
      putSpec: async (key: string, json: string) => {
        const out = await store.putSpec(key, json);
        published = true;
        return out;
      },
    };
    const { runId, chunkCount } = await startPipelineRun(
      { ...deps({ fetchImpl, config: ONE_PER_JOB }), env: testEnv as any, specStore },
      input(s),
    );
    expect(chunkCount).toBe(2);
    expect(exchanges).toEqual([]);
    expect(sent).toEqual([]);
    const run = await first("SELECT * FROM pipeline_runs WHERE id = ?", runId);
    expect(run.status).toBe("error");
    expect(run.token_revoked_at).not.toBeNull();
    expect(JSON.parse(run.error)).toEqual({
      class: "dispatch",
      app_token_step: "unexpected",
      chunk_index: 0,
      status: null,
    });
    const chunks = await all<{ status: string }>(
      "SELECT status FROM pipeline_run_chunks WHERE run_id = ? ORDER BY chunk_index",
      runId,
    );
    expect(chunks.map((c) => c.status)).toEqual(["not_sent", "not_sent"]);
    const rows = JSON.stringify(await Promise.all(PLAN_TABLES.map((t) => all(`SELECT * FROM ${t}`))));
    expect(rows).not.toContain("unexpected-failure-detail");
    const again = await startPipelineRun(deps({ config: ONE_PER_JOB }), input(s));
    expect(again.runId).not.toBe(runId);
  }, 120_000);

  it("refuses a run whose spec URL would outlive seven days and writes nothing", async () => {
    const s = await setup();
    const { fetchImpl, sent } = stubFetch();
    const before = await snapshot();
    const slow = { ...CONFIG, lifetime: { ...LIFETIME, secondsPerImage: 1_000_000 } };
    const r = await refusal(startPipelineRun(deps({ fetchImpl, config: slow }), input(s)));
    expect(r.code).toBe("run_too_long");
    expect(sent).toHaveLength(0);
    expect(await storedSpecKeys()).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("refused on chunk 1 of 2, keeps the run open until chunk 0 reports, then completes it", async () => {
    const s = await setup({ count: 257, pageCount: 1 });
    const { fetchImpl } = stubFetch((i) => (i === 1 ? 422 : 204));
    const { runId } = await startPipelineRun(deps({ fetchImpl, config: ONE_PER_JOB }), input(s));
    const chunks = await all<{ status: string }>(
      "SELECT status FROM pipeline_run_chunks WHERE run_id = ? ORDER BY chunk_index",
      runId,
    );
    expect(chunks.map((c) => c.status)).toEqual(["dispatched", "not_sent"]);
    const run = await first("SELECT * FROM pipeline_runs WHERE id = ?", runId);
    expect(run.status).toBe("dispatched");
    expect(JSON.parse(run.error).class).toBe("dispatch");
    expect(run.token_revoked_at).toBeNull();
    const aborted = await all<{ status: string }>(
      "SELECT status FROM pipeline_run_volumes WHERE run_id = ? AND chunk_index = 1",
      runId,
    );
    expect(aborted).toHaveLength(1);
    expect(aborted[0].status).toBe("aborted");
    expect(run.volumes_reported).toBe(1);

    await env.DB.prepare(
      "UPDATE pipeline_run_chunks SET status = 'completed' WHERE run_id = ? AND chunk_index = 0",
    )
      .bind(runId)
      .run();
    await closeRunIfChunksDone(drizzle(env.DB), { runId, tenantId: DEFAULT_TEST_TENANT_ID, now: Date.now() });
    const closed = await first("SELECT * FROM pipeline_runs WHERE id = ?", runId);
    expect(closed.status).toBe("completed");
    expect(closed.token_revoked_at).not.toBeNull();
  }, 60_000);

  it("stores the spec's SHA-256 on the run under the tenant-first key", async () => {
    const s = await setup();
    const { runId } = await startPipelineRun(deps(), input(s));
    const run = await first("SELECT * FROM pipeline_runs WHERE id = ?", runId);
    expect(run.spec_key).toBe(`${DEFAULT_TEST_TENANT_ID}/pipeline-runs/${runId}/spec.json`);
    const { text } = await storedSpec(runId);
    expect(run.spec_sha256).toBe(await sha256(text));
  });

  it("states the token expiry in the spec as on the run, after the URL's by the longest job and the tail", async () => {
    const s = await setup({ pageCount: 10 });
    const { runId } = await startPipelineRun(deps(), input(s));
    const run = await first("SELECT * FROM pipeline_runs WHERE id = ?", runId);
    const { json } = await storedSpec(runId);
    expect(Date.parse(json.callback.token_expires_at)).toBe(run.token_expires_at);
    expect(new Date(run.token_expires_at).toISOString()).toBe(json.callback.token_expires_at);
    const longestJob = 10 * LIFETIME.secondsPerImage + LIFETIME.perJobOverheadSeconds;
    expect(run.token_expires_at - run.spec_url_expires_at).toBeGreaterThanOrEqual(
      (longestJob + LIFETIME.callbackTailSeconds) * 1000,
    );
  });

  it("leaves the run running when a callback arrives while a later chunk is being sent", async () => {
    const s = await setup({ count: 257, pageCount: 1 });
    let runId = "";
    const reply = async (chunkIndex: number): Promise<Reply> => {
      if (chunkIndex === 1) {
        runId = (await first<{ id: string }>("SELECT id FROM pipeline_runs")).id;
        const { json } = await storedSpec(runId);
        const v = s.seeded.volumes[0];
        const run = { runId, tenantId: DEFAULT_TEST_TENANT_ID } as SeededRun;
        const volume = { id: v.id, runVolumeId: "", referenceCode: v.referenceCode, chunkIndex: 0, pageKeys: v.pageKeys };
        const body = makeVolumeCallback(run, volume);
        const res = await handleVolumeCallback(
          {
            db: drizzle(env.DB),
            env: { DB: env.DB, PIPELINE_CALLBACK_ORIGIN: "https://fisqua.test", PIPELINE_WORKING_BUCKET: "w" },
            reader: { getText: async () => null },
            waitUntil: () => {},
            now: () => Date.now(),
            newId: () => crypto.randomUUID(),
          },
          new Request(`https://fisqua.test/api/pipeline/runs/${runId}/volumes/${v.id}/callback`, {
            method: "POST",
            headers: callbackHeaders(json.callback.token, body),
            body: JSON.stringify(body),
          }),
          { runId, volumeId: v.id },
        );
        expect(res.status).toBe(200);
      }
      return 204;
    };
    const { fetchImpl } = stubFetch(reply);
    const result = await startPipelineRun(deps({ fetchImpl, config: ONE_PER_JOB }), input(s));
    expect(result.runId).toBe(runId);
    const run = await first("SELECT * FROM pipeline_runs WHERE id = ?", runId);
    expect(run.status).toBe("running");
  }, 60_000);

  it("refuses more than the run-size limit with run_too_large and writes nothing", async () => {
    const s = await setup({ count: 3 });
    const before = await snapshot();
    const r = await refusal(startPipelineRun(deps({ config: { ...CONFIG, maxRunVolumes: 2 } }), input(s)));
    expect(r.code).toBe("run_too_large");
    expect(await snapshot()).toEqual(before);
  });

  it("abandons the run when a ledger batch fails, sends nothing, and frees the volumes", async () => {
    const s = await setup({ count: 700, pageCount: 1 });
    const { fetchImpl, sent } = stubFetch();
    // Batch 1 is the claim; batches 2 and 3 write the run-volume rows.
    const { binding, stats } = observedD1(env.DB, { failBatch: (n) => n === 3 });
    await expect(startPipelineRun(deps({ fetchImpl, db: drizzle(binding) }), input(s))).rejects.toThrow(
      "injected batch failure",
    );
    expect(stats.batches.slice(0, 3)).toEqual([expect.any(Number), 89, expect.any(Number)]);
    expect(sent).toHaveLength(0);
    const run = await first("SELECT * FROM pipeline_runs");
    expect(run.status).toBe("error");
    expect(JSON.parse(run.error)).toEqual({ class: "dispatch", stage: "ledger" });
    expect(run.token_revoked_at).not.toBeNull();
    const chunks = await all<{ status: string }>("SELECT status FROM pipeline_run_chunks WHERE run_id = ?", run.id);
    expect(chunks.map((c) => c.status)).toEqual(["not_sent"]);

    const again = await startPipelineRun(deps({ fetchImpl }), input(s));
    expect(again.runId).not.toBe(run.id);
  }, 120_000);

  it("refuses a volume flagged restricted and writes nothing", async () => {
    const s = await setup({ count: 3 });
    const [a] = s.seeded.volumes;
    await env.DB.prepare("UPDATE pipeline_volumes SET restricted = 1 WHERE id = ?").bind(a.id).run();
    const { fetchImpl, sent } = stubFetch();
    const before = await snapshot();
    const r = await refusal(startPipelineRun(deps({ fetchImpl }), input(s)));
    expect(r.code).toBe("restricted_material");
    expect(r.detail.reference_codes).toEqual([a.referenceCode]);
    expect(await snapshot()).toEqual(before);
    expect(await storedSpecKeys()).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("does not read the access conditions to decide restriction", async () => {
    const s = await setup({ count: 2 });
    const [a] = s.seeded.volumes;
    await env.DB.prepare("UPDATE descriptions SET access_conditions = 'Libre acceso' WHERE id = ?")
      .bind(a.descriptionId)
      .run();
    const { runId } = await startPipelineRun(deps(), input(s));
    const v = await first("SELECT restricted, held_by_run_id FROM pipeline_volumes WHERE id = ?", a.id);
    expect(v).toEqual({ restricted: 0, held_by_run_id: runId });
  });

  it("does not claim a volume whose page list was replaced after its pages were read", async () => {
    const s = await setup({ count: 1 });
    const [a] = s.seeded.volumes;
    // A capture manifest replaces the pages just before the claim batch:
    // the revision moves on and a page points at a new master.
    const texts = new WeakMap<object, string>();
    let replaced = false;
    const wrapStmt = (stmt: D1PreparedStatement, text: string): D1PreparedStatement => {
      const proxy = new Proxy(stmt, {
        get(target, prop) {
          if (prop === "__real") return target;
          if (prop === "bind") return (...args: unknown[]) => wrapStmt(target.bind(...args), text);
          const v = Reflect.get(target, prop);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      texts.set(proxy, text);
      return proxy;
    };
    const raced = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") return (text: string) => wrapStmt(target.prepare(text), text);
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (!replaced && stmts.some((x) => /insert into "pipeline_runs"/i.test(texts.get(x) ?? ""))) {
              replaced = true;
              await target.prepare("UPDATE pipeline_volumes SET pages_revision = pages_revision + 1 WHERE id = ?").bind(a.id).run();
              await target.prepare("UPDATE pipeline_volume_pages SET master_key = master_key || '.retake' WHERE pipeline_volume_id = ?")
                .bind(a.id)
                .run();
            }
            return target.batch(stmts.map((x: any) => x.__real ?? x));
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const r = await refusal(startPipelineRun(deps({ db: drizzle(raced) }), input(s)));
    expect(replaced).toBe(true);
    expect(r.code).toBe("volume_pages_changed");
    expect(r.detail.volume_ids).toEqual([a.id]);
    const v = await first("SELECT held_by_run_id FROM pipeline_volumes WHERE id = ?", a.id);
    expect(v.held_by_run_id).toBeNull();
    const run = await first("SELECT status, token_revoked_at FROM pipeline_runs ORDER BY created_at DESC LIMIT 1");
    expect(run.status).toBe("error");
    expect(run.token_revoked_at).not.toBeNull();
    // Started again, the run reads the replaced pages and claims the volume.
    const { runId } = await startPipelineRun(deps(), input(s));
    expect((await first("SELECT held_by_run_id FROM pipeline_volumes WHERE id = ?", a.id)).held_by_run_id).toBe(runId);
  });

  it("the claim batch takes no volume flagged restricted since it was read", async () => {
    const s = await setup({ count: 1 });
    const [a] = s.seeded.volumes;
    await env.DB.prepare("UPDATE pipeline_volumes SET restricted = 1 WHERE id = ?").bind(a.id).run();
    const db = drizzle(env.DB);
    const now = Date.now();
    const runId = crypto.randomUUID();
    const statements = buildClaimStatements(db, {
      run: {
        id: runId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        userId: s.user.id,
        kind: "volume_run",
        purpose: "sample",
        status: "pending",
        runnerImage: env.PIPELINE_RUNNER_IMAGE as string,
        scriptVersion: TEST_SCRIPT_VERSION,
        arch: "x64",
        maxReviewFrac: 0.1,
        specKey: pipelineKey.spec(DEFAULT_TEST_TENANT_ID, runId),
        specSha256: "0".repeat(64),
        specUrlExpiresAt: now + 1000,
        chunkCount: 1,
        volumeCount: 1,
        callbackTokenHash: "0".repeat(64),
        tokenExpiresAt: now + 2000,
        createdAt: now,
      },
      chunkIds: [crypto.randomUUID()],
      volumeIds: [a.id],
      kind: "volume_run",
      now,
    });
    await db.batch(statements as any);
    const run = await first("SELECT * FROM pipeline_runs WHERE id = ?", runId);
    expect(run.status).toBe("error");
    expect(JSON.parse(run.error)).toEqual({ class: "dispatch", stage: "claim" });
    const v = await first("SELECT restricted, held_by_run_id FROM pipeline_volumes WHERE id = ?", a.id);
    expect(v).toEqual({ restricted: 1, held_by_run_id: null });
  });

  it("refuses a volume whose description is not in the tenant, and writes nothing", async () => {
    const s = await setup({ count: 2 });
    const [a] = s.seeded.volumes;
    // The description exists, but in another tenant: the restriction
    // check cannot read its access conditions, so the run is refused.
    await env.DB.prepare("UPDATE descriptions SET tenant_id = ? WHERE id = ?")
      .bind(SECOND_TEST_TENANT_ID, a.descriptionId)
      .run();
    const { fetchImpl, sent } = stubFetch();
    const before = await snapshot();
    const r = await refusal(startPipelineRun(deps({ fetchImpl }), input(s)));
    expect(r.code).toBe("description_not_found");
    expect(r.detail.reference_codes).toEqual([a.referenceCode]);
    expect(await snapshot()).toEqual(before);
    expect(await storedSpecKeys()).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("splits the chunk insert so no claim statement binds more than 100 parameters", async () => {
    const s = await setup({ count: 1 });
    const db = drizzle(env.DB);
    const now = Date.now();
    const runId = crypto.randomUUID();
    const chunkIds = Array.from({ length: 40 }, () => crypto.randomUUID());
    const statements = buildClaimStatements(db, {
      run: {
        id: runId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        userId: s.user.id,
        kind: "volume_run",
        purpose: "sample",
        status: "pending",
        runnerImage: env.PIPELINE_RUNNER_IMAGE as string,
        scriptVersion: TEST_SCRIPT_VERSION,
        arch: "x64",
        maxReviewFrac: 0.1,
        specKey: pipelineKey.spec(DEFAULT_TEST_TENANT_ID, runId),
        specSha256: "0".repeat(64),
        specUrlExpiresAt: now + 1000,
        chunkCount: chunkIds.length,
        volumeCount: 1,
        callbackTokenHash: "0".repeat(64),
        tokenExpiresAt: now + 2000,
        createdAt: now,
      },
      chunkIds,
      volumeIds: [s.seeded.volumes[0].id],
      kind: "volume_run",
      now,
    });
    for (const stmt of statements) {
      expect((stmt as any).toSQL().params.length).toBeLessThanOrEqual(100);
    }
    expect(statements.length).toBeLessThanOrEqual(89);
    await db.batch(statements as any);
    const rows = await all<{ id: string; chunk_index: number; status: string }>(
      "SELECT id, chunk_index, status FROM pipeline_run_chunks WHERE run_id = ? ORDER BY chunk_index",
      runId,
    );
    expect(rows.map((r) => r.chunk_index)).toEqual(chunkIds.map((_, i) => i));
    expect(rows.map((r) => r.id)).toEqual(chunkIds);
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(["pending"]));
  });

  it("writes restricted: false on every spec entry and records the check on every volume", async () => {
    const s = await setup({ count: 3 });
    const { runId } = await startPipelineRun(deps(), input(s));
    const { json } = await storedSpec(runId);
    expect(json.volumes.map((v: Json) => v.restricted)).toEqual([false, false, false]);
    const rows = await all<{ restricted: number; restriction_checked_at: number | null }>(
      "SELECT restricted, restriction_checked_at FROM pipeline_volumes WHERE held_by_run_id = ?",
      runId,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.restricted).toBe(0);
      expect(r.restriction_checked_at).not.toBeNull();
    }
  });

  it("needs a gate pass for the latest declaration version for a wave, and none for a sample", async () => {
    const s = await setup({ count: 1, declarationVersions: [1, 2] });
    const [v1, v2] = s.seeded.declarations;
    const before = await snapshot();
    const wave = { purpose: "wave" as const };
    expect((await refusal(startPipelineRun(deps(), input(s, wave)))).code).toBe("gate_not_passed");
    expect(await snapshot()).toEqual(before);

    const pass = async (declarationId: string) =>
      insertRow("pipeline_gate_passes", {
        id: crypto.randomUUID(),
        tenant_id: DEFAULT_TEST_TENANT_ID,
        declaration_id: declarationId,
        script_version: TEST_SCRIPT_VERSION,
        passed_by: s.user.id,
        passed_at: Date.now(),
      });
    await pass(v1.id);
    const r = await refusal(startPipelineRun(deps(), input(s, wave)));
    expect(r.code).toBe("gate_not_passed");
    expect(r.detail.declaration_ids).toEqual([v2.id]);

    const sample = await startPipelineRun(deps(), input(s));
    expect(sample.runId).toBeTruthy();

    const s2 = await setup({ count: 1, declarationVersions: [1, 2] });
    await pass(s2.seeded.declarations[1].id);
    const waved = await startPipelineRun(deps(), input(s2, wave));
    expect((await first("SELECT status FROM pipeline_runs WHERE id = ?", waved.runId)).status).toBe(
      "dispatched",
    );
  });

  it("accepts a wave under runner v1.1.0 on a pass won on v1.0.0 and carried forward", async () => {
    const s = await setup({ count: 1 });
    const [declaration] = s.seeded.declarations;
    await insertRow("pipeline_gate_passes", {
      id: crypto.randomUUID(),
      tenant_id: DEFAULT_TEST_TENANT_ID,
      declaration_id: declaration.id,
      script_version: "v1.0.0",
      passed_by: s.user.id,
      passed_at: Date.now(),
    });
    const v110 = deps({ envOverrides: { PIPELINE_SCRIPT_VERSION: "v1.1.0" } });
    const wave = { purpose: "wave" as const };
    expect((await refusal(startPipelineRun(v110, input(s, wave)))).code).toBe("gate_not_passed");

    await env.DB.prepare(CARRY_GATE_PASSES_SQL).run();
    const carried = await first("SELECT * FROM pipeline_gate_passes WHERE script_version = 'v1.1.0'");
    expect(carried).toMatchObject({ declaration_id: declaration.id, passed_by: s.user.id, note: GATE_PASS_CARRY_NOTE });
    const waved = await startPipelineRun(v110, input(s, wave));
    expect((await first("SELECT status, script_version FROM pipeline_runs WHERE id = ?", waved.runId))).toEqual({
      status: "dispatched",
      script_version: "v1.1.0",
    });
  });

  it("refuses with dispatch_unconfigured when a GitHub App setting is unset", async () => {
    const s = await setup();
    const before = await snapshot();
    for (const name of [
      "PIPELINE_GITHUB_APP_ID",
      "PIPELINE_GITHUB_APP_INSTALLATION_ID",
      "PIPELINE_GITHUB_APP_PRIVATE_KEY",
    ]) {
      for (const value of [undefined, " "]) {
        const { fetchImpl, sent, exchanges } = stubFetch();
        const r = await refusal(startPipelineRun(deps({ fetchImpl, envOverrides: { [name]: value } }), input(s)));
        expect(r.code).toBe("dispatch_unconfigured");
        expect(r.detail).toEqual({ missing: [name] });
        expect(exchanges).toEqual([]);
        expect(sent).toEqual([]);
      }
    }
    expect(await snapshot()).toEqual(before);
  });

  it("refuses with dispatch_unconfigured when the runner repository is not owner/name", async () => {
    const s = await setup();
    const before = await snapshot();
    for (const value of ["test-runner", "a/b/c", "test owner/test-runner"]) {
      const r = await refusal(
        startPipelineRun(deps({ envOverrides: { PIPELINE_DISPATCH_REPO: value } }), input(s)),
      );
      expect(r.code).toBe("dispatch_unconfigured");
      expect(r.detail).toEqual({ invalid: ["PIPELINE_DISPATCH_REPO"] });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("refuses with dispatch_unconfigured when the environment is unset or not one of the two", async () => {
    const s = await setup();
    const before = await snapshot();
    const unset = await refusal(
      startPipelineRun(deps({ envOverrides: { PIPELINE_ENVIRONMENT: undefined } }), input(s)),
    );
    expect(unset.code).toBe("dispatch_unconfigured");
    expect(unset.detail).toEqual({ missing: ["PIPELINE_ENVIRONMENT"] });
    for (const value of ["local", "Staging", "prod"]) {
      const r = await refusal(startPipelineRun(deps({ envOverrides: { PIPELINE_ENVIRONMENT: value } }), input(s)));
      expect(r.code).toBe("dispatch_unconfigured");
      expect(r.detail).toEqual({ invalid: ["PIPELINE_ENVIRONMENT"] });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("names the runner's key store for the deployment's environment", async () => {
    const s = await setup();
    const prod = await startPipelineRun(deps(), input(s));
    expect((await storedSpec(prod.runId)).json.destination.credentials_ref).toBe(
      `fisqua-pipeline-${DEFAULT_TEST_TENANT_ID}`,
    );
    const s2 = await setup();
    const staging = await startPipelineRun(deps({ envOverrides: { PIPELINE_ENVIRONMENT: "staging" } }), input(s2));
    expect((await storedSpec(staging.runId)).json.destination.credentials_ref).toBe(
      `fisqua-pipeline-staging-${DEFAULT_TEST_TENANT_ID}`,
    );
  });

  it("refuses with pipeline_config_unset when no run configuration is given", async () => {
    const s = await setup();
    const before = await snapshot();
    const r = await refusal(startPipelineRun(deps({ config: null }), input(s)));
    expect(r.code).toBe("pipeline_config_unset");
    expect(await snapshot()).toEqual(before);
  });

  it("keeps the run open after a 5xx on its only chunk, and frees the volumes at expiry", async () => {
    const s = await setup({ count: 2 });
    const { fetchImpl } = stubFetch(() => 500);
    const { runId } = await startPipelineRun(deps({ fetchImpl }), input(s));
    const run = await first("SELECT * FROM pipeline_runs WHERE id = ?", runId);
    expect(run.token_revoked_at).toBeNull();
    expect(JSON.parse(run.error).class).toBe("dispatch");
    expect((await first("SELECT status FROM pipeline_run_chunks WHERE run_id = ?", runId)).status).toBe("failed");
    const rows = await all<{ status: string }>("SELECT status FROM pipeline_run_volumes WHERE run_id = ?", runId);
    expect(rows.map((r) => r.status)).toEqual(["aborted", "aborted"]);

    const r = await refusal(startPipelineRun(deps(), input(s)));
    expect(r.code).toBe("volume_in_open_run");

    const later = run.token_expires_at + 1;
    const second = await startPipelineRun(deps({ now: () => later }), input(s));
    const first1 = await first("SELECT * FROM pipeline_runs WHERE id = ?", runId);
    expect(first1.status).toBe("error");
    expect(JSON.parse(first1.error)).toEqual({ class: "dispatch", chunk_index: 0, status: 500 });
    expect(first1.token_revoked_at).toBe(later);
    expect(second.runId).not.toBe(runId);
  });

  it("closes the run at once when GitHub refuses its only chunk, and frees the volumes", async () => {
    const s = await setup({ count: 2 });
    const { fetchImpl } = stubFetch(() => 422);
    const { runId } = await startPipelineRun(deps({ fetchImpl }), input(s));
    const run = await first("SELECT * FROM pipeline_runs WHERE id = ?", runId);
    expect(run.status).toBe("error");
    expect(run.token_revoked_at).not.toBeNull();
    expect((await first("SELECT status FROM pipeline_run_chunks WHERE run_id = ?", runId)).status).toBe("not_sent");
    const again = await startPipelineRun(deps(), input(s));
    expect(again.runId).not.toBe(runId);
  });

  it("with chunk 0 reported during chunk 1's request, a 5xx keeps the run open and a 4xx closes it", async () => {
    for (const status of [500, 422]) {
      const s = await setup({ count: 257, pageCount: 1 });
      const { fetchImpl } = stubFetch(async (i) => {
        if (i === 1) {
          await env.DB.prepare(
            "UPDATE pipeline_run_chunks SET status = 'completed' WHERE chunk_index = 0 AND status = 'dispatched'",
          ).run();
          return status;
        }
        return 204;
      });
      const { runId } = await startPipelineRun(deps({ fetchImpl, config: ONE_PER_JOB }), input(s));
      const run = await first("SELECT * FROM pipeline_runs WHERE id = ?", runId);
      expect(JSON.parse(run.error).class).toBe("dispatch");
      if (status === 500) {
        expect(run.token_revoked_at).toBeNull();
      } else {
        expect(run.status).toBe("completed");
        expect(run.token_revoked_at).not.toBeNull();
      }
    }
  }, 120_000);

  it("lets only one of two concurrent starts claim overlapping volumes", async () => {
    const s = await setup({ count: 3 });
    const [a, b, c] = s.seeded.volumes;
    // Both requests reach their claim batch before either runs it.
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const barrier = async (n: number) => {
      if (n !== 1) return;
      arrived++;
      if (arrived === 2) release();
      await gate;
    };
    const one = observedD1(env.DB, { beforeBatch: barrier });
    const two = observedD1(env.DB, { beforeBatch: barrier });
    const f1 = stubFetch();
    const f2 = stubFetch();
    const results = await Promise.allSettled([
      startPipelineRun(deps({ db: drizzle(one.binding), fetchImpl: f1.fetchImpl }), input(s, { pipelineVolumeIds: [a.id, b.id] })),
      startPipelineRun(deps({ db: drizzle(two.binding), fetchImpl: f2.fetchImpl }), input(s, { pipelineVolumeIds: [b.id, c.id] })),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(StartRunRefusal);
    expect(lost[0].reason.code).toBe("volume_in_open_run");
    const winnerId = (won[0] as PromiseFulfilledResult<{ runId: string }>).value.runId;
    expect((await first("SELECT held_by_run_id FROM pipeline_volumes WHERE id = ?", b.id)).held_by_run_id).toBe(
      winnerId,
    );
    expect(await storedSpecKeys()).toHaveLength(1);
    expect(f1.sent.length + f2.sent.length).toBe(1);
    const loser = await first("SELECT * FROM pipeline_runs WHERE id <> ?", winnerId);
    expect(loser.status).toBe("error");
    expect(JSON.parse(loser.error)).toEqual({ class: "dispatch", stage: "claim" });
    expect((await first("SELECT status FROM pipeline_run_chunks WHERE run_id = ?", loser.id)).status).toBe("not_sent");
    expect(await all("SELECT id FROM pipeline_run_volumes WHERE run_id = ?", loser.id)).toEqual([]);
  });

  it("answers restricted_material, naming the reference code, when a volume is flagged between the read and the claim", async () => {
    const s = await setup({ count: 2 });
    const [a] = s.seeded.volumes;
    const flagged = observedD1(env.DB, {
      beforeBatch: async (n: number) => {
        if (n !== 1) return;
        await env.DB.prepare("UPDATE pipeline_volumes SET restricted = 1 WHERE id = ?").bind(a.id).run();
      },
    });
    const { fetchImpl, sent } = stubFetch();
    const r = await refusal(
      startPipelineRun(deps({ db: drizzle(flagged.binding), fetchImpl }), input(s)),
    );
    expect(r.code).toBe("restricted_material");
    expect(r.detail.reference_codes).toEqual([a.referenceCode]);
    expect((await first("SELECT held_by_run_id FROM pipeline_volumes WHERE id = ?", a.id)).held_by_run_id).toBeNull();
    expect(await storedSpecKeys()).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("dispatches a one-volume, two-image sample run whose URL ends before its token", async () => {
    const s = await setup({ count: 1, pageCount: 2 });
    const { runId } = await startPipelineRun(deps(), input(s));
    const run = await first("SELECT * FROM pipeline_runs WHERE id = ?", runId);
    expect(run.status).toBe("dispatched");
    expect(run.spec_url_expires_at).toBeLessThan(run.token_expires_at);
  });

  it("the claim batch takes nothing held by another open run and closes its own run", async () => {
    const s = await setup({ count: 1 });
    const { runId: holder } = await startPipelineRun(deps(), input(s));
    const db = drizzle(env.DB);
    const now = Date.now();
    const newRun = crypto.randomUUID();
    const statements = buildClaimStatements(db, {
      run: {
        id: newRun,
        tenantId: DEFAULT_TEST_TENANT_ID,
        userId: s.user.id,
        kind: "volume_run",
        purpose: "sample",
        status: "pending",
        runnerImage: env.PIPELINE_RUNNER_IMAGE as string,
        scriptVersion: TEST_SCRIPT_VERSION,
        arch: "x64",
        maxReviewFrac: 0.1,
        specKey: pipelineKey.spec(DEFAULT_TEST_TENANT_ID, newRun),
        specSha256: "0".repeat(64),
        specUrlExpiresAt: now + 1000,
        chunkCount: 1,
        volumeCount: 1,
        callbackTokenHash: "0".repeat(64),
        tokenExpiresAt: now + 2000,
        createdAt: now,
      },
      chunkIds: [crypto.randomUUID()],
      volumeIds: [s.seeded.volumes[0].id],
      kind: "volume_run",
      now,
    });
    await db.batch(statements as any);
    const run = await first("SELECT * FROM pipeline_runs WHERE id = ?", newRun);
    expect(run.status).toBe("error");
    expect(JSON.parse(run.error)).toEqual({ class: "dispatch", stage: "claim" });
    expect((await first("SELECT held_by_run_id FROM pipeline_volumes WHERE id = ?", s.seeded.volumes[0].id)).held_by_run_id).toBe(holder);
  });

  it("checks restriction last: every earlier refusal leaves the volume rows unchanged", async () => {
    type Case = { code: string; arrange: (s: Setup) => Promise<Partial<StartRunInput>>; deps?: Partial<StartRunDeps> & { envOverrides?: Record<string, unknown> } };
    const cases: Case[] = [
      { code: "gate_not_passed", arrange: async () => ({ purpose: "wave" }) },
      {
        code: "run_too_long",
        arrange: async () => ({}),
        deps: { config: { ...CONFIG, lifetime: { ...LIFETIME, secondsPerImage: 1_000_000 } } },
      },
      {
        code: "volume_state",
        arrange: async (s) => {
          await env.DB.prepare("UPDATE pipeline_volumes SET state = 'prepared' WHERE id = ?").bind(s.seeded.volumes[1].id).run();
          return {};
        },
      },
      {
        code: "invalid_reference_code",
        arrange: async (s) => {
          await env.DB.prepare("UPDATE pipeline_volumes SET reference_code = 'Co-UPPER' WHERE id = ?").bind(s.seeded.volumes[1].id).run();
          return {};
        },
      },
      {
        code: "invalid_page_list",
        arrange: async (s) => {
          await env.DB.prepare("DELETE FROM pipeline_volume_pages WHERE pipeline_volume_id = ? AND seq = 2").bind(s.seeded.volumes[1].id).run();
          return {};
        },
      },
      {
        code: "no_declaration",
        arrange: async (s) => {
          await env.DB.prepare("DELETE FROM pipeline_recipe_declarations WHERE scope_description_id = ?").bind(s.seeded.scopeDescriptionId).run();
          return {};
        },
      },
      { code: "manifest_inputs_unavailable", arrange: async () => ({}), deps: { manifestResolverFor: () => unavailableManifest } },
      { code: "runner_image_invalid", arrange: async () => ({}), deps: { envOverrides: { PIPELINE_RUNNER_IMAGE: "ghcr.io/x/runner:latest" } } },
    ];
    for (const c of cases) {
      await cleanDatabase();
      await seedTenants();
      await seedFederations();
      const s = await setup({ count: 2 });
      await env.DB.prepare("UPDATE pipeline_volumes SET restricted = 1 WHERE id = ?")
        .bind(s.seeded.volumes[0].id)
        .run();
      const overrides = await c.arrange(s);
      const before = await all("SELECT * FROM pipeline_volumes ORDER BY id");
      const r = await refusal(startPipelineRun(deps(c.deps ?? {}), input(s, overrides)));
      expect(r.code, c.code).toBe(c.code);
      expect(await all("SELECT * FROM pipeline_volumes ORDER BY id"), c.code).toEqual(before);
    }
  }, 60_000);

  it("refuses a reference code with an upper-case letter, naming it, and writes nothing", async () => {
    const s = await setup();
    await env.DB.prepare("UPDATE pipeline_volumes SET reference_code = 'co-Abc-1' WHERE id = ?")
      .bind(s.seeded.volumes[0].id)
      .run();
    const before = await snapshot();
    const r = await refusal(startPipelineRun(deps(), input(s)));
    expect(r.code).toBe("invalid_reference_code");
    expect(r.detail.reference_codes).toEqual(["co-Abc-1"]);
    expect(await snapshot()).toEqual(before);
  });

  it("starts a run of the largest size within the statement budget and D1's limits", async () => {
    const s = await setup({ count: CONFIG.maxRunVolumes, pageCount: 1 });
    const { binding, stats } = observedD1(env.DB);
    await startPipelineRun(deps({ db: drizzle(binding) }), input(s));
    expect(stats.statements).toBeLessThan(1000);
    expect(Math.max(...stats.batches)).toBeLessThanOrEqual(89);
    expect(stats.maxParams).toBeLessThanOrEqual(100);
    // Every column is bound, defaults included: 13 values plus the tenant
    // and the flag-ingest attempt count.
    expect(RUN_VOLUME_INSERT_PARAMS).toBe(15);
  }, 120_000);

  it("closes the tenant's expired open run before reading holds, and leaves other tenants' alone", async () => {
    const s = await setup();
    const past = Date.now() - 1000;
    const stale = await seedPipelineRun({ status: "running", tokenExpiresAt: past });
    await holdVolume(s.seeded.volumes[0].id, stale.runId);
    const foreign = await seedPipelineRun({ tenantId: SECOND_TEST_TENANT_ID, status: "running", tokenExpiresAt: past });
    const { runId } = await startPipelineRun(deps(), input(s));
    const closed = await first("SELECT * FROM pipeline_runs WHERE id = ?", stale.runId);
    expect(closed.status).toBe("error");
    expect(JSON.parse(closed.error)).toEqual({ class: "token_expired" });
    expect(closed.token_revoked_at).not.toBeNull();
    const untouched = await first("SELECT * FROM pipeline_runs WHERE id = ?", foreign.runId);
    expect(untouched.status).toBe("running");
    expect(untouched.token_revoked_at).toBeNull();
    expect((await first("SELECT held_by_run_id FROM pipeline_volumes WHERE id = ?", s.seeded.volumes[0].id)).held_by_run_id).toBe(runId);
  });

  it("never moves a chunk that reported before its 204 arrived", async () => {
    const s = await setup();
    const { fetchImpl } = stubFetch(async () => {
      await env.DB.prepare("UPDATE pipeline_run_chunks SET status = 'completed' WHERE chunk_index = 0").run();
      return 204;
    });
    const { runId } = await startPipelineRun(deps({ fetchImpl }), input(s));
    const chunk = await first("SELECT * FROM pipeline_run_chunks WHERE run_id = ?", runId);
    expect(chunk.status).toBe("completed");
    expect(chunk.dispatched_at).toBeNull();
  });

  it("refuses a page list that breaks a cross-field rule, naming the volume and the rule", async () => {
    type Case = { rule: string; arrange: (v: { id: string }) => Promise<void>; kind?: "item_pdf" };
    const cases: Case[] = [
      {
        rule: "page_count",
        arrange: async (v) => {
          await env.DB.prepare("DELETE FROM pipeline_volume_pages WHERE pipeline_volume_id = ? AND seq = 3").bind(v.id).run();
        },
      },
      {
        rule: "seq_contiguous",
        arrange: async (v) => {
          await env.DB.prepare("UPDATE pipeline_volume_pages SET seq = 4 WHERE pipeline_volume_id = ? AND seq = 3").bind(v.id).run();
        },
      },
      {
        rule: "master_key_under_prefix",
        arrange: async (v) => {
          await env.DB.prepare("UPDATE pipeline_volume_pages SET master_key = 'elsewhere/p.tif' WHERE pipeline_volume_id = ? AND seq = 2").bind(v.id).run();
        },
      },
      {
        rule: "pdf_page_required",
        kind: "item_pdf",
        arrange: async (v) => {
          await env.DB.prepare("UPDATE pipeline_volume_pages SET pdf_page = NULL, master_key = 'masters/x.tif' WHERE pipeline_volume_id = ? AND seq = 1").bind(v.id).run();
        },
      },
    ];
    for (const c of cases) {
      await cleanDatabase();
      await seedTenants();
      await seedFederations();
      const s = await setup({ count: 1, pageCount: 3, kind: c.kind ?? "volume_run" });
      const v = s.seeded.volumes[0];
      await c.arrange(v);
      const before = await snapshot();
      const r = await refusal(startPipelineRun(deps(), input(s, { kind: c.kind ?? "volume_run" })));
      expect(r.code, c.rule).toBe("invalid_page_list");
      expect(r.detail.volume_id, c.rule).toBe(v.id);
      expect(r.detail.rules, c.rule).toContain(c.rule);
      expect(await snapshot(), c.rule).toEqual(before);
    }
  });

  it("refuses a runner image with no repository or pinned by tag", async () => {
    for (const image of ["@sha256:" + "a".repeat(64), "ghcr.io/example/runner:v1"]) {
      const s = await setup();
      const before = await snapshot();
      const r = await refusal(
        startPipelineRun(deps({ envOverrides: { PIPELINE_RUNNER_IMAGE: image } }), input(s)),
      );
      expect(r.code).toBe("runner_image_invalid");
      expect(await snapshot()).toEqual(before);
    }
  });

  it("applies the family's latest declaration version at dispatch and never rewrites rows after", async () => {
    const s = await setup({ count: 2, declarationVersions: [1, 2] });
    const [a, b] = s.seeded.volumes;
    const v2 = s.seeded.declarations[1];
    const volumeBefore = await first("SELECT recipe_scope_description_id FROM pipeline_volumes WHERE id = ?", a.id);
    const { runId } = await startPipelineRun(deps(), input(s, { pipelineVolumeIds: [a.id] }));
    const rv = await first("SELECT * FROM pipeline_run_volumes WHERE run_id = ?", runId);
    expect(rv.declaration_id).toBe(v2.id);
    const { json } = await storedSpec(runId);
    expect(json.volumes[0].recipe.declaration_version).toBe(2);
    expect(await first("SELECT recipe_scope_description_id FROM pipeline_volumes WHERE id = ?", a.id)).toEqual(volumeBefore);

    const snapshotRv = await all("SELECT * FROM pipeline_run_volumes ORDER BY id");
    const snapshotVol = await all("SELECT * FROM pipeline_volumes ORDER BY id");
    const v3 = await seedDeclaration({ scopeDescriptionId: s.seeded.scopeDescriptionId, createdBy: s.user.id, version: 3 });
    expect(await all("SELECT * FROM pipeline_run_volumes ORDER BY id")).toEqual(snapshotRv);
    expect(await all("SELECT * FROM pipeline_volumes ORDER BY id")).toEqual(snapshotVol);

    const next = await startPipelineRun(deps(), input(s, { pipelineVolumeIds: [b.id] }));
    const rv3 = await first("SELECT * FROM pipeline_run_volumes WHERE run_id = ?", next.runId);
    expect(rv3.declaration_id).toBe(v3.id);

    const lone = await setup({ count: 1, declarationVersions: [] });
    const r = await refusal(startPipelineRun(deps(), input(lone)));
    expect(r.code).toBe("no_declaration");
  });

  // --- The tenant's storage destination -----------------------------------

  it("refuses a tenant whose destination is incomplete, naming what is missing, and sends nothing", async () => {
    const s = await setup();
    await env.DB.prepare("UPDATE federations SET manifest_bucket = NULL, pipeline_image_base_url = NULL WHERE id = ?")
      .bind(DEFAULT_TEST_FEDERATION_ID)
      .run();
    s.tenant = await drizzle(env.DB, { schema })
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, DEFAULT_TEST_TENANT_ID))
      .get() as Tenant;
    s.tenant = { ...s.tenant, mediaPipelineEnabled: true };
    const before = await snapshot();
    const { fetchImpl, sent } = stubFetch();
    const r = await refusal(startPipelineRun(deps({ fetchImpl }), input(s)));
    expect(r.code).toBe("tenant_destination_unset");
    expect(r.detail).toEqual({ missing: ["pipeline_image_base_url", "manifest_bucket"] });
    expect(sent).toEqual([]);
    expect(await storedSpecKeys()).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a tenant one of whose secrets is missing, and names the secret but no value", async () => {
    const s = await setup();
    const before = await snapshot();
    const r = await refusal(
      startPipelineRun(deps({ envOverrides: { TEST_TENANT_MANIFEST_WRITE_SECRET_KEY: undefined } }), input(s)),
    );
    expect(r.code).toBe("tenant_destination_unset");
    expect(r.detail).toEqual({ missing: ["secret:MANIFEST_WRITE_SECRET_KEY"] });
    expect(JSON.stringify(r.detail)).not.toContain("test_tenant");
    expect(await snapshot()).toEqual(before);
  });

  it("builds each tenant's spec and manifest ids from its federation's destination under its slug", async () => {
    const first = await setup({ count: 1 });
    const second = {
      tenantPipelineEndpoint: "https://s3.eu-central-003.backblazeb2.com",
      tilesBucket: "second-iiif-tiles",
      imageBase: "https://iiif.second.example.test",
      manifestBase: "https://manifests.second.example.test",
    };
    await seedTenantDestination(SECOND_TEST_TENANT_ID, {
      pipelineDeliveryEndpoint: second.tenantPipelineEndpoint,
      pipelineTilesBucket: second.tilesBucket,
      pipelineMastersBucket: "second-masters",
      pipelineImageBaseUrl: second.imageBase,
      manifestEndpoint: "https://second-account.r2.cloudflarestorage.com",
      manifestBucket: "second-manifests",
      manifestBaseUrl: second.manifestBase,
      storageSecretPrefix: "SECOND",
    });
    const secondTenant = {
      ...((await drizzle(env.DB, { schema })
        .select()
        .from(schema.tenants)
        .where(eq(schema.tenants.id, SECOND_TEST_TENANT_ID))
        .get()) as Tenant),
      mediaPipelineEnabled: true,
    };
    const secondAdmin = await createTestUser({ tenantId: SECOND_TEST_TENANT_ID, isAdmin: true });
    const secondUser = makeUserContext({ id: secondAdmin.id, tenantId: SECOND_TEST_TENANT_ID, isAdmin: true });
    const secondSetup = {
      tenant: secondTenant,
      user: secondUser,
      seeded: await seedReceivedVolumes({ tenantId: SECOND_TEST_TENANT_ID, userId: secondUser.id }),
    };

    const bases: string[] = [];
    const d = deps({
      envOverrides: testSecrets("SECOND"),
      manifestResolverFor: (base) => {
        bases.push(base);
        return (v, ...rest) => ({ ...testManifest(v, ...rest), id: `${base}/iiif/${v.referenceCode}/manifest.json` });
      },
    });
    const a = await startPipelineRun(d, input(first));
    const b = await startPipelineRun(d, input(secondSetup));
    expect(bases).toEqual([`${TEST_MANIFEST_BASE}/neogranadina`, `${second.manifestBase}/second-tenant`]);

    const specA = (await storedSpec(a.runId)).json;
    const specB = (await storedSpec(b.runId, SECOND_TEST_TENANT_ID)).json;
    expect(specA.destination).toMatchObject({
      endpoint: TEST_DESTINATION.pipelineDeliveryEndpoint,
      tiles_bucket: TEST_DESTINATION.pipelineTilesBucket,
      tiles_prefix: "neogranadina/",
      ocr_bucket: TEST_DESTINATION.pipelineTilesBucket,
      ocr_prefix: "neogranadina/ocr/",
      image_base_url: `${TEST_DESTINATION.pipelineImageBaseUrl}/neogranadina`,
      credentials_ref: `fisqua-pipeline-${DEFAULT_TEST_TENANT_ID}`,
    });
    expect(specB.destination).toMatchObject({
      endpoint: second.tenantPipelineEndpoint,
      tiles_bucket: second.tilesBucket,
      tiles_prefix: "second-tenant/",
      ocr_bucket: second.tilesBucket,
      ocr_prefix: "second-tenant/ocr/",
      image_base_url: `${second.imageBase}/second-tenant`,
      credentials_ref: `fisqua-pipeline-${SECOND_TEST_TENANT_ID}`,
    });
    expect(specA.volumes[0].manifest.id.startsWith(`${TEST_MANIFEST_BASE}/neogranadina/iiif/`)).toBe(true);
    expect(specB.volumes[0].manifest.id.startsWith(`${second.manifestBase}/second-tenant/iiif/`)).toBe(true);
    // No key reaches a spec.
    for (const text of [JSON.stringify(specA), JSON.stringify(specB)]) {
      for (const value of [...Object.values(testSecrets("SECOND")), ...Object.values(testSecrets("TEST_TENANT"))]) {
        expect(text).not.toContain(value);
      }
    }
  });

  it("refuses with manifest_inputs_unavailable when the resolver has no inputs", async () => {
    const s = await setup();
    const before = await snapshot();
    const r = await refusal(startPipelineRun(deps({ manifestResolverFor: () => unavailableManifest }), input(s)));
    expect(r.code).toBe("manifest_inputs_unavailable");
    expect(await snapshot()).toEqual(before);
  });

  async function setRepository(id: string, fields: Record<string, string | null>): Promise<void> {
    const cols = Object.keys(fields);
    await env.DB.prepare(
      `UPDATE repositories SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND tenant_id = ?`,
    )
      .bind(...cols.map((c) => fields[c]), id, DEFAULT_TEST_TENANT_ID)
      .run();
  }

  async function repositoryCode(id: string): Promise<string> {
    const row = await env.DB.prepare("SELECT code FROM repositories WHERE id = ?").bind(id).first<{ code: string }>();
    return row!.code;
  }

  it("refuses a repository without manifest rights under the real resolver, naming it", async () => {
    const s = await setup();
    const before = await snapshot();
    const r = await refusal(
      startPipelineRun(deps({ manifestResolverFor: manifestResolver }), input(s)),
    );
    expect(r.code).toBe("repository_rights_unset");
    expect(r.detail).toMatchObject({
      repository_id: s.seeded.repositoryId,
      repository_code: await repositoryCode(s.seeded.repositoryId),
    });
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a repository with an attribution in one language only, naming it", async () => {
    const s = await setup();
    await setRepository(s.seeded.repositoryId, {
      manifest_rights: "https://rights.example.test/",
      attribution_en: "English only",
    });
    const before = await snapshot();
    const r = await refusal(
      startPipelineRun(deps({ manifestResolverFor: manifestResolver }), input(s)),
    );
    expect(r.code).toBe("repository_attribution_incomplete");
    expect(r.detail).toMatchObject({ repository_id: s.seeded.repositoryId });
    expect(await snapshot()).toEqual(before);
  });

  it("dispatches with the real resolver once the repository has rights, and the spec carries them", async () => {
    const s = await setup({ count: 1 });
    await setRepository(s.seeded.repositoryId, {
      manifest_rights: "https://rights.example.test/",
      attribution_en: "English attribution",
      attribution_es: "Atribución en español",
    });
    const { runId } = await startPipelineRun(
      deps({ manifestResolverFor: manifestResolver }),
      input(s),
    );
    const { json } = await storedSpec(runId);
    expect(() => validateRunSpec(json)).not.toThrow();
    const m = json.volumes[0].manifest;
    expect(m.id).toBe(`${TEST_MANIFEST_BASE}/neogranadina/iiif/${json.volumes[0].reference_code}/manifest.json`);
    expect(m.rights).toBe("https://rights.example.test/");
    expect(m.required_statement.value).toEqual({ en: ["English attribution"], es: ["Atribución en español"] });
    expect(m.provider).toEqual([]);
    expect("homepage" in m).toBe(false);
    expect("see_also" in m).toBe(false);
  });

  it("dispatches an item-PDF run whose stored spec carries the source key, PDF pages and the fixed recipe", async () => {
    const s = await setup({ count: 2, kind: "item_pdf", pageCount: 3 });
    const { runId } = await startPipelineRun(deps(), input(s, { kind: "item_pdf" }));
    const { json } = await storedSpec(runId);
    expect(() => validateRunSpec(json)).not.toThrow();
    for (const v of json.volumes) {
      expect(v.source.key).toMatch(/\.pdf$/);
      expect(v.pages.every((p: Json) => typeof p.pdf_page === "number" && !("master_key" in p))).toBe(true);
      expect(v.recipe.output_class).toBe("tonal");
      expect(v.recipe.stages.render).toEqual({ run: true, params: { dpi: ITEM_PDF_DPI } });
      expect(v.recipe.stages.ocr).toEqual({ run: true, params: { engine: "pdf_text_layer" } });
      expect(v.recipe.stages.preprocess.run).toBe(false);
    }
  });

  // --- The capture QC hold -------------------------------------------------

  /**
   * Makes a seeded volume a Captua delivery's, with openings 1 and 2 and
   * no rejected record unless `records` gives one; the openings and the
   * rejected records are counted as registration counts them.
   */
  async function captureDelivery(
    volumeId: string,
    code: string,
    records: Json[] = [
      { captuaRecordId: 1, sequence: 1, status: "approved", rejectionNote: null },
      { captuaRecordId: 2, sequence: 2, status: "in_review", rejectionNote: null },
    ],
  ): Promise<string> {
    const scannerId = crypto.randomUUID();
    await insertRow("capture_scanners", {
      id: scannerId,
      tenant_id: DEFAULT_TEST_TENANT_ID,
      name: `rig-${scannerId.slice(0, 6)}`,
      created_at: 1,
      updated_at: 1,
    });
    const id = crypto.randomUUID();
    await insertRow("capture_deliveries", {
      tenant_id: DEFAULT_TEST_TENANT_ID,
      id,
      route: "link",
      scanner_id: scannerId,
      reference_code: code,
      pipeline_volume_id: volumeId,
      body_sha256: "0".repeat(64),
      state: "registered",
      problems: "[]",
      answer_status: 200,
      answer_body: "{}",
      records: JSON.stringify(records),
      openings: records.filter((r) => r.status === "in_review" || r.status === "approved").length,
      rejected_records: records.filter((r) => r.status === "rejected").length,
      received_at: 1,
      seq: (await first<{ n: number }>("SELECT COUNT(*) AS n FROM capture_deliveries")).n + 1,
    });
    return id;
  }

  async function decide(s: Setup, volumeId: string, records: Json[]): Promise<Response> {
    const delivery = await first<{ id: string }>(
      "SELECT id FROM capture_deliveries WHERE pipeline_volume_id = ? AND state = 'registered'",
      volumeId,
    );
    const request = new Request(`https://fisqua.test/admin/capture/volumes/${volumeId}/decisions`, {
      method: "POST",
      body: JSON.stringify({ manifestId: delivery.id, records }),
    });
    return recordDecisionsAction(
      { db: drizzle(env.DB), now: () => Date.now(), newId: () => crypto.randomUUID() },
      request,
      volumeId,
      s.tenant,
      s.user,
    );
  }

  it("holds a Captua volume with capture_qc_pending while its review run is open", async () => {
    const s = await setup({ count: 1 });
    const [a] = s.seeded.volumes;
    const deliveryId = await captureDelivery(a.id, a.referenceCode);
    const runId = crypto.randomUUID();
    const now = Date.now();
    await insertRow("pipeline_runs", {
      id: runId,
      tenant_id: DEFAULT_TEST_TENANT_ID,
      user_id: null,
      kind: "review_run",
      purpose: null,
      status: "dispatched",
      runner_image: `ghcr.io/example/runner@sha256:${"0".repeat(64)}`,
      script_version: "v1.1.0",
      arch: "x64",
      max_review_frac: 1,
      spec_key: `${DEFAULT_TEST_TENANT_ID}/pipeline-runs/${runId}/spec.json`,
      spec_sha256: "0".repeat(64),
      spec_url_expires_at: now + 1_800_000,
      chunk_count: 1,
      volume_count: 1,
      callback_token_hash: "0".repeat(64),
      token_expires_at: now + 3_600_000,
      created_at: now,
    });
    await insertRow("capture_review_runs", {
      tenant_id: DEFAULT_TEST_TENANT_ID,
      run_id: runId,
      delivery_id: deliveryId,
      pipeline_volume_id: a.id,
      review_prefix: `test/${deliveryId}/`,
      status: "dispatched",
      created_at: now,
    });
    const before = await snapshot();
    const r = await refusal(startPipelineRun(deps(), input(s)));
    expect(r.code).toBe("capture_qc_pending");
    expect(r.detail).toEqual({ volume_ids: [a.id] });
    expect(await snapshot()).toEqual(before);
  });

  it("holds a Captua volume with capture_qc_pending until every opening is approved, then runs it", async () => {
    const s = await setup({ count: 2 });
    const [a, b] = s.seeded.volumes;
    await captureDelivery(a.id, a.referenceCode);
    const before = await snapshot();

    // No decision yet: held; the volume from elsewhere beside it is not.
    let r = await refusal(startPipelineRun(deps(), input(s)));
    expect(r.code).toBe("capture_qc_pending");
    expect(r.detail).toEqual({ volume_ids: [a.id] });
    expect(await snapshot()).toEqual(before);

    // One opening approved, the other rejected: still held.
    expect((await decide(s, a.id, [{ captuaRecordId: 1, decision: "approved" }])).status).toBe(200);
    r = await refusal(startPipelineRun(deps(), input(s, { pipelineVolumeIds: [a.id] })));
    expect(r.code).toBe("capture_qc_pending");
    expect((await decide(s, a.id, [{ captuaRecordId: 2, decision: "rejected", reason: "glare" }])).status).toBe(200);
    r = await refusal(startPipelineRun(deps(), input(s, { pipelineVolumeIds: [a.id] })));
    expect(r.code).toBe("capture_qc_pending");

    // Every opening approved: it runs, with the other volume.
    expect((await decide(s, a.id, [{ captuaRecordId: 2, decision: "approved" }])).status).toBe(200);
    const ok = await startPipelineRun(deps(), input(s));
    const held = await all<{ held_by_run_id: string }>(
      "SELECT held_by_run_id FROM pipeline_volumes WHERE id IN (?, ?)",
      a.id,
      b.id,
    );
    expect(held.map((h) => h.held_by_run_id)).toEqual([ok.runId, ok.runId]);

    // Decisions are fixed once the run has started.
    expect((await decide(s, a.id, [{ captuaRecordId: 2, decision: "rejected", reason: "blur" }])).status).toBe(409);
  });

  /** Openings 1 and 2, and record 3 rejected on the unit. */
  const WITH_REJECTED: Json[] = [
    { captuaRecordId: 1, sequence: 1, status: "approved", rejectionNote: null },
    { captuaRecordId: 2, sequence: 2, status: "in_review", rejectionNote: null },
    { captuaRecordId: 3, sequence: 3, status: "rejected", rejectionNote: "blurred" },
  ];

  it("holds a volume whose delivery has a rejected record, even with every opening approved", async () => {
    const s = await setup({ count: 2 });
    const [a, b] = s.seeded.volumes;
    await captureDelivery(a.id, a.referenceCode, WITH_REJECTED);
    expect(
      (
        await decide(s, a.id, [
          { captuaRecordId: 1, decision: "approved" },
          { captuaRecordId: 2, decision: "approved" },
        ])
      ).status,
    ).toBe(200);
    // The decision set has every opening approved; the rejected record is not one of them.
    expect(await first("SELECT state, opening_count, approved_count FROM capture_qc_sets WHERE pipeline_volume_id = ?", a.id)).toEqual({
      state: "approved",
      opening_count: 2,
      approved_count: 2,
    });
    // A record that is not an opening of the delivery cannot be decided.
    expect((await decide(s, a.id, [{ captuaRecordId: 3, decision: "approved" }])).status).toBe(422);

    const before = await snapshot();
    const r = await refusal(startPipelineRun(deps(), input(s)));
    expect(r.code).toBe("capture_qc_pending");
    expect(r.detail).toEqual({ volume_ids: [a.id] });
    expect(await snapshot()).toEqual(before);

    // The volume from elsewhere beside it runs alone.
    await expect(startPipelineRun(deps(), input(s, { pipelineVolumeIds: [b.id] }))).resolves.toMatchObject({ chunkCount: 1 });
  });

  it("holds a volume whose delivery has rejected records and no openings", async () => {
    const s = await setup({ count: 1 });
    const [a] = s.seeded.volumes;
    await captureDelivery(a.id, a.referenceCode, [
      { captuaRecordId: 1, sequence: 1, status: "rejected", rejectionNote: "blurred" },
      { captuaRecordId: 2, sequence: 2, status: "rejected", rejectionNote: null },
    ]);
    const r = await refusal(startPipelineRun(deps(), input(s)));
    expect(r.code).toBe("capture_qc_pending");
    expect(r.detail).toEqual({ volume_ids: [a.id] });
  });

  it("takes no volume in the claim whose delivery has a rejected record", async () => {
    const s = await setup({ count: 1 });
    const [a] = s.seeded.volumes;
    await captureDelivery(a.id, a.referenceCode, WITH_REJECTED);
    await decide(s, a.id, [
      { captuaRecordId: 1, decision: "approved" },
      { captuaRecordId: 2, decision: "approved" },
    ]);
    const db = drizzle(env.DB);
    const now = Date.now();
    const runId = crypto.randomUUID();
    // The claim alone, as if the step-4 read had let the volume through.
    const statements = buildClaimStatements(db, {
      run: {
        id: runId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        userId: s.user.id,
        kind: "volume_run",
        purpose: "sample",
        status: "pending",
        runnerImage: env.PIPELINE_RUNNER_IMAGE as string,
        scriptVersion: TEST_SCRIPT_VERSION,
        arch: "x64",
        maxReviewFrac: 0.1,
        specKey: pipelineKey.spec(DEFAULT_TEST_TENANT_ID, runId),
        specSha256: "0".repeat(64),
        specUrlExpiresAt: now + 1000,
        chunkCount: 1,
        volumeCount: 1,
        callbackTokenHash: "0".repeat(64),
        tokenExpiresAt: now + 2000,
        createdAt: now,
      },
      chunkIds: [crypto.randomUUID()],
      volumeIds: [a.id],
      kind: "volume_run",
      now,
    });
    for (const stmt of statements) {
      expect((stmt as any).toSQL().params.length).toBeLessThanOrEqual(100);
    }
    await db.batch(statements as any);
    const run = await first("SELECT status, error FROM pipeline_runs WHERE id = ?", runId);
    expect(run.status).toBe("error");
    expect(JSON.parse(run.error)).toEqual({ class: "dispatch", stage: "claim" });
    expect((await first("SELECT held_by_run_id FROM pipeline_volumes WHERE id = ?", a.id)).held_by_run_id).toBeNull();
    expect(await first<{ n: number }>("SELECT COUNT(*) AS n FROM pipeline_run_volumes WHERE run_id = ?", runId)).toEqual({ n: 0 });
  });

  /**
   * Registers a seeded volume's capture manifest as the registration
   * command does from a file: openings 1 (a single image) and 2 (a
   * spread), record 3 rejected on the unit, or with `retaken`, record 3
   * back in review with a new image, as the retake's handover brings it.
   * The statements are the command's own, run one by one as
   * `wrangler d1 execute --file` runs them.
   */
  async function fileRegistration(
    s: Setup,
    volume: { id: string; referenceCode: string; descriptionId: string },
    manifestId: string,
    opts: { statuses?: string[]; retaken?: boolean } = {},
  ) {
    const code = volume.referenceCode;
    const root = `${s.tenant.slug}/`;
    const hex = (label: string) => Array.from(label.padEnd(64, "0").slice(0, 64), (c) => (c.charCodeAt(0) % 16).toString(16)).join("");
    const image = (n: number, c: number, role: string) => {
      const filename = `${code}-img_${String(n).padStart(4, "0")}_c${c}.jpg`;
      return {
        captureId: `cap-${n}-${c}`,
        pairId: role === "single" ? null : `pair-${n}`,
        filename,
        role,
        objectKey: `${code}/captures/${filename}`,
        sha256: hex(`${n}-${c}`),
      };
    };
    const record = (id: number, status: string, images: Json[]) => ({
      captuaRecordId: id,
      sequence: id,
      status,
      rejectionNote: status === "rejected" ? "blurred" : null,
      images,
    });
    const checked = checkCaptureManifest({
      contract: "fisqua-captua-exchange",
      version: "1.1",
      kind: "capture-manifest",
      id: manifestId,
      generatedAt: "2026-10-20T12:00:00Z",
      generatedBy: { system: "captua", instance: "rig-1", systemVersion: "0.1.0" },
      inReplyTo: null,
      project: { captuaProjectId: 1, name: "Test project" },
      transfer: { channel: "upload", root },
      volumes: [
        {
          externalId: code,
          captuaCollectionId: 1,
          stem: code,
          title: "Test volume",
          // Given statuses: one single image per record, in that order.
          records: opts.statuses
            ? opts.statuses.map((status, i) => record(i + 1, status, [image(i + 1, 0, "single")]))
            : [
                record(1, "approved", [image(1, 0, "single")]),
                record(2, "in_review", [image(2, 0, "left"), image(2, 1, "right")]),
                opts.retaken
                  ? record(3, "in_review", [image(4, 0, "single")])
                  : record(3, "rejected", [image(3, 0, "single")]),
              ],
        },
      ],
    });
    if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
    const manifest = checked.manifest;
    const listing = new Map(
      manifest.volumes[0].records.flatMap((r) => r.images.map((i) => [`${root}${i.objectKey}`, 1000] as [string, number])),
    );
    const [planned] = applyInventory(
      planVolumes({
        manifest,
        slug: s.tenant.slug,
        descriptions: new Map([[code, { id: volume.descriptionId, referenceCode: code }]]),
        existing: [
          { id: volume.id, descriptionId: volume.descriptionId, referenceCode: code, kind: "volume_run", state: "received", held: false, ran: false },
        ],
        newId: () => crypto.randomUUID(),
        // A staging test's captured records, as `--allow-captured` takes them.
        allowCaptured: opts.statuses !== undefined,
      }),
      new Map([[`${root}${code}/`, listing]]),
    );
    expect(planned.action).toBe("replace");
    const { statements } = await fileRegistrationSql({
      tenantId: DEFAULT_TEST_TENANT_ID,
      manifest,
      volume: planned,
      digest: "b".repeat(64),
      masters: { endpoint: "https://s3.example.test", bucket: "test-masters" },
      listing,
      now: Date.now(),
      newId: () => crypto.randomUUID(),
    });
    for (const statement of statements) await env.DB.prepare(statement).run();
  }

  it("holds a volume registered from a manifest file until every opening is approved, and decides it as a link volume", async () => {
    const s = await setup({ count: 2 });
    const [a, b] = s.seeded.volumes;
    const manifestId = crypto.randomUUID();
    await fileRegistration(s, a, manifestId);

    // The command recorded a delivery, which holds the volume.
    const delivery = await first(
      "SELECT id, route, scanner_id, state, pipeline_volume_id, openings, rejected_records FROM capture_deliveries WHERE pipeline_volume_id = ?",
      a.id,
    );
    expect(delivery).toEqual({
      id: manifestId,
      route: "file",
      scanner_id: null,
      state: "registered",
      pipeline_volume_id: a.id,
      openings: 2,
      rejected_records: 1,
    });
    expect((await first<{ n: number }>("SELECT COUNT(*) AS n FROM pipeline_volume_pages WHERE pipeline_volume_id = ?", a.id)).n).toBe(3);
    expect((await first<{ n: number }>("SELECT COUNT(*) AS n FROM capture_images WHERE delivery_id = ?", manifestId)).n).toBe(4);

    let r = await refusal(startPipelineRun(deps(), input(s)));
    expect(r.code).toBe("capture_qc_pending");
    expect(r.detail).toEqual({ volume_ids: [a.id] });

    // Decided as a link volume is: a rejection keeps it held.
    expect((await decide(s, a.id, [{ captuaRecordId: 1, decision: "approved" }])).status).toBe(200);
    expect((await decide(s, a.id, [{ captuaRecordId: 2, decision: "rejected", reason: "glare", side: "right" }])).status).toBe(200);
    expect(await first("SELECT delivery_id, state FROM capture_qc_sets WHERE pipeline_volume_id = ?", a.id)).toEqual({
      delivery_id: manifestId,
      state: "retakes_requested",
    });
    // A record that is not an opening of the delivery is refused.
    expect((await decide(s, a.id, [{ captuaRecordId: 3, decision: "approved" }])).status).toBe(422);
    r = await refusal(startPipelineRun(deps(), input(s, { pipelineVolumeIds: [a.id] })));
    expect(r.code).toBe("capture_qc_pending");

    // Every opening approved, and record 3 still rejected on the unit: held.
    expect((await decide(s, a.id, [{ captuaRecordId: 2, decision: "approved" }])).status).toBe(200);
    expect((await first<{ state: string }>("SELECT state FROM capture_qc_sets WHERE delivery_id = ?", manifestId)).state).toBe(
      "approved",
    );
    r = await refusal(startPipelineRun(deps(), input(s)));
    expect(r.code).toBe("capture_qc_pending");
    expect(r.detail).toEqual({ volume_ids: [a.id] });

    // The retake's handover: record 3 back in review with a new image. The
    // approvals of 1 and 2 come over; 3 waits for its own.
    const retakeId = crypto.randomUUID();
    await fileRegistration(s, a, retakeId, { retaken: true });
    expect(
      await all("SELECT id, state, openings, rejected_records FROM capture_deliveries WHERE pipeline_volume_id = ? ORDER BY seq", a.id),
    ).toEqual([
      { id: manifestId, state: "superseded", openings: 2, rejected_records: 1 },
      { id: retakeId, state: "registered", openings: 3, rejected_records: 0 },
    ]);
    expect(await first("SELECT state, opening_count, approved_count FROM capture_qc_sets WHERE delivery_id = ?", retakeId)).toEqual({
      state: "in_capture_qc",
      opening_count: 3,
      approved_count: 2,
    });
    r = await refusal(startPipelineRun(deps(), input(s, { pipelineVolumeIds: [a.id] })));
    expect(r.code).toBe("capture_qc_pending");

    // The retaken opening approved: it runs, with the other volume.
    expect((await decide(s, a.id, [{ captuaRecordId: 3, decision: "approved" }])).status).toBe(200);
    expect((await first<{ state: string }>("SELECT state FROM capture_qc_sets WHERE delivery_id = ?", retakeId)).state).toBe(
      "approved",
    );
    const ok = await startPipelineRun(deps(), input(s));
    const held = await all<{ held_by_run_id: string }>(
      "SELECT held_by_run_id FROM pipeline_volumes WHERE id IN (?, ?)",
      a.id,
      b.id,
    );
    expect(held.map((h) => h.held_by_run_id)).toEqual([ok.runId, ok.runId]);
  });

  it("does not hold a volume whose delivery has no openings, every record still captured", async () => {
    const s = await setup({ count: 1 });
    const [a] = s.seeded.volumes;
    await captureDelivery(a.id, a.referenceCode, [
      { captuaRecordId: 1, sequence: 1, status: "captured", rejectionNote: null },
      { captuaRecordId: 2, sequence: 2, status: "captured", rejectionNote: null },
    ]);
    await expect(startPipelineRun(deps(), input(s))).resolves.toMatchObject({ chunkCount: 1 });
  });

  it("holds a volume with openings and captured records until its openings are approved", async () => {
    const s = await setup({ count: 1 });
    const [a] = s.seeded.volumes;
    await captureDelivery(a.id, a.referenceCode, [
      { captuaRecordId: 1, sequence: 1, status: "approved", rejectionNote: null },
      { captuaRecordId: 2, sequence: 2, status: "captured", rejectionNote: null },
    ]);
    const r = await refusal(startPipelineRun(deps(), input(s)));
    expect(r.code).toBe("capture_qc_pending");
    // A captured record is not an opening and cannot be decided.
    expect((await decide(s, a.id, [{ captuaRecordId: 2, decision: "approved" }])).status).toBe(422);
    expect((await decide(s, a.id, [{ captuaRecordId: 1, decision: "approved" }])).status).toBe(200);
    await expect(startPipelineRun(deps(), input(s))).resolves.toMatchObject({ chunkCount: 1 });
  });

  it("does not hold a delivery whose packed records are all captured", async () => {
    const s = await setup({ count: 1 });
    const [a] = s.seeded.volumes;
    const manifestId = crypto.randomUUID();
    await fileRegistration(s, a, manifestId, { statuses: Array.from({ length: 1000 }, () => "captured") });
    const d = await first<{ records: string; openings: number }>(
      "SELECT records, openings FROM capture_deliveries WHERE id = ?",
      manifestId,
    );
    expect(d.records.startsWith('{"$gzip"')).toBe(true);
    expect(d.openings).toBe(0);
    await expect(startPipelineRun(deps(), input(s))).resolves.toMatchObject({ chunkCount: 1 });
  });

  it("holds a delivery with packed records and one opening until it is approved", async () => {
    const s = await setup({ count: 1 });
    const [a] = s.seeded.volumes;
    const manifestId = crypto.randomUUID();
    await fileRegistration(s, a, manifestId, {
      statuses: ["approved", ...Array.from({ length: 999 }, () => "captured")],
    });
    const d = await first<{ records: string; openings: number }>(
      "SELECT records, openings FROM capture_deliveries WHERE id = ?",
      manifestId,
    );
    expect(d.records.startsWith('{"$gzip"')).toBe(true);
    expect(d.openings).toBe(1);
    const r = await refusal(startPipelineRun(deps(), input(s)));
    expect(r.code).toBe("capture_qc_pending");
    expect((await decide(s, a.id, [{ captuaRecordId: 1, decision: "approved" }])).status).toBe(200);
    await expect(startPipelineRun(deps(), input(s))).resolves.toMatchObject({ chunkCount: 1 });
  });

  it("does not hold a Captua volume a run has already named", async () => {
    const s = await setup({ count: 1 });
    const [a] = s.seeded.volumes;
    await captureDelivery(a.id, a.referenceCode);
    const earlier = await seedPipelineRun({ status: "error", tokenRevokedAt: Date.now() });
    await insertRow("pipeline_run_volumes", {
      id: crypto.randomUUID(),
      run_id: earlier.runId,
      tenant_id: DEFAULT_TEST_TENANT_ID,
      pipeline_volume_id: a.id,
      declaration_id: s.seeded.declarations[0].id,
      job_index: 0,
      chunk_index: 0,
      reference_code: a.referenceCode,
      tile_root: a.referenceCode,
      expected_count: 2,
      resolved_recipe: "{}",
      status: "aborted",
      flags_truncated: 0,
      created_at: 1,
    });
    await expect(startPipelineRun(deps(), input(s))).resolves.toMatchObject({ chunkCount: 1 });
  });

  it("takes no volume in the claim whose capture QC a decision reopened since it was read", async () => {
    const s = await setup({ count: 1 });
    const [a] = s.seeded.volumes;
    await captureDelivery(a.id, a.referenceCode);
    await decide(s, a.id, [
      { captuaRecordId: 1, decision: "approved" },
      { captuaRecordId: 2, decision: "approved" },
    ]);
    const db = drizzle(env.DB);
    const now = Date.now();
    const runId = crypto.randomUUID();
    // Planned while every opening was approved; a rejection lands first.
    const statements = buildClaimStatements(db, {
      run: {
        id: runId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        userId: s.user.id,
        kind: "volume_run",
        purpose: "sample",
        status: "pending",
        runnerImage: env.PIPELINE_RUNNER_IMAGE as string,
        scriptVersion: TEST_SCRIPT_VERSION,
        arch: "x64",
        maxReviewFrac: 0.1,
        specKey: pipelineKey.spec(DEFAULT_TEST_TENANT_ID, runId),
        specSha256: "0".repeat(64),
        specUrlExpiresAt: now + 1000,
        chunkCount: 1,
        volumeCount: 1,
        callbackTokenHash: "0".repeat(64),
        tokenExpiresAt: now + 2000,
        createdAt: now,
      },
      chunkIds: [crypto.randomUUID()],
      volumeIds: [a.id],
      kind: "volume_run",
      now,
    });
    for (const stmt of statements) {
      expect((stmt as any).toSQL().params.length).toBeLessThanOrEqual(100);
    }
    expect((await decide(s, a.id, [{ captuaRecordId: 2, decision: "rejected", reason: "focus" }])).status).toBe(200);
    await db.batch(statements as any);
    const run = await first("SELECT status, error FROM pipeline_runs WHERE id = ?", runId);
    expect(run.status).toBe("error");
    expect(JSON.parse(run.error)).toEqual({ class: "dispatch", stage: "claim" });
    const v = await first("SELECT held_by_run_id FROM pipeline_volumes WHERE id = ?", a.id);
    expect(v.held_by_run_id).toBeNull();
  });

  it("refuses a lost claim with capture_qc_pending when a decision reopened QC after step 4", async () => {
    const s = await setup({ count: 1 });
    const [a] = s.seeded.volumes;
    await captureDelivery(a.id, a.referenceCode);
    await decide(s, a.id, [
      { captuaRecordId: 1, decision: "approved" },
      { captuaRecordId: 2, decision: "approved" },
    ]);
    // The claim batch is the first batch of the start; the rejection lands just before it.
    const { binding } = observedD1(env.DB, {
      beforeBatch: async (n) => {
        if (n === 1) await decide(s, a.id, [{ captuaRecordId: 1, decision: "rejected", reason: "dirt" }]);
      },
    });
    const r = await refusal(startPipelineRun(deps({ db: drizzle(binding) }), input(s)));
    expect(r.code).toBe("capture_qc_pending");
    expect(r.detail).toEqual({ volume_ids: [a.id] });
  });
});

// @version v0.8.0
