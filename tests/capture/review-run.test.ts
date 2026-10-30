/**
 * Tests — starting and following the review run
 *
 * This suite registers capture deliveries over the real link handler,
 * against a fake masters bucket, and drives `startReviewRun`, the
 * Prepare and Retry action, the sweep's step and the state the Volumes
 * screen and the status call derive. GitHub is a stub that answers the
 * App's token exchange and each dispatch; the review bucket's download
 * address is a test value. It pins:
 *
 *   - the link hands a delivery it registered to `onRegistered` once,
 *     and a replay of the same manifest not at all;
 *   - a start writes one review run (kind `review_run`, no purpose, the
 *     user who asked or none), its chunk and its review row under
 *     `{slug}/{delivery}/`, publishes a spec the validator accepts, and
 *     dispatches it once;
 *   - starts are idempotent: a second start, two at once, and a Retry
 *     after the hook's start leave one open run; a retake's delivery
 *     gets its own run and prefix;
 *   - a page whose image carries `rotateDeg` has `rotate_deg` in the
 *     spec from runner v1.2.0, 0 included, and a page without one has
 *     none; a rejected record's image sharing the page's key and master
 *     never gives it its rotation, in either row order, and a page two
 *     page images match is declined as the delivery's own spec problem
 *     (`page_image_ambiguous`);
 *   - every reason a start is declined writes nothing, a page with
 *     `rotate_deg` on a runner older than v1.2.0 among them;
 *   - a dispatch GitHub refuses leaves a failed review run, which the
 *     screen shows as review images failed with Retry, and the unit sees
 *     as registered; Retry then starts a new run;
 *   - the states: preparing review images while the run is open, over
 *     a retake's carried approvals too; in capture QC once the tiles are
 *     ready; received with Prepare where the federation has a bucket and
 *     the delivery no run; in capture QC at once where it has no bucket;
 *   - a dispatch that got no answer counts as open while its run holds,
 *     so Retry is refused, and tiles ready on any run of the delivery
 *     win over a later failure;
 *   - the sweep's step starts pending deliveries in production only, and
 *     looks past deliveries and federations a start would decline,
 *     however many of them are older than the one it can start, and
 *     turns away a federation whose settings no review run can pass
 *     before reading its deliveries; a declined start holds for the
 *     whole federation unless its reason is the delivery's own, and a
 *     delivery declined for a reason of its own is recorded and not
 *     tried again until a person retries it; below runner v1.2.0 a
 *     delivery with a page's `rotate_deg` is left pending, unrecorded,
 *     and starts once the runner reads the field;
 *   - the action's permissions and refusals, and the route's refusal of
 *     a post from another origin before anything else;
 *   - the download address is `{downloadUrl}/file/{bucket}`, read with
 *     the share key through the access route's account cache, and null
 *     without the key's secrets or when B2 refuses it.
 *
 * Every value here is a test value.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { createHash } from "node:crypto";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedFederations,
  DEFAULT_TEST_FEDERATION_ID,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_FEDERATION_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestDescription } from "../helpers/descriptions";
import { createTestRepository } from "../helpers/repositories";
import { createTestUser } from "../helpers/auth";
import { makeUserContext } from "../helpers/context";
import { fakeS3, type FakeS3 } from "../helpers/fake-s3";
import {
  githubAppEnv,
  insertRow,
  seedTenantDestination,
  withTokenExchange,
  testSecrets,
  TEST_DELIVERY_ENDPOINT,
  TEST_DESTINATION,
  TEST_MASTERS_BUCKET,
  TEST_SECRET_PREFIX,
} from "../helpers/media-pipeline";
import { clearGitHubAppCaches } from "../../app/lib/pipeline/github-app.server";
import { handleManifestDelivery, handleVolumeStatus, type CaptureLinkDeps } from "../../app/lib/capture/link.server";
import { recordDecisionsAction } from "../../app/lib/capture/qc.server";
import { clearReviewAccountCache } from "../../app/lib/capture/review-access.server";
import {
  declineIsPerDelivery,
  readLatestReviewRuns,
  REVIEW_ATTEMPTS_PER_TICK,
  REVIEW_SWEEP_QUERY_CEILING,
  reviewRunAction,
  shareKeyImageBaseUrl,
  startPendingReviewRuns,
  startReviewRun,
  type ReviewRunDeps,
} from "../../app/lib/capture/review-run.server";
import { loadCaptureVolumes } from "../../app/lib/capture/screens.server";
import { mintScannerToken } from "../../app/lib/capture/token";
import { DEFAULT_RUN_CONFIG } from "../../app/lib/pipeline/dispatch.server";
import { getPipelineSpecStore, pipelineKey } from "../../app/lib/pipeline/store.server";
import { validateAnyRunSpec } from "../../app/lib/pipeline/run-spec";
import { tenantContext, userContext, type Tenant, type User } from "../../app/context";
import { action as reviewRunRoute } from "../../app/routes/_auth.admin.capture.volumes.$volumeId.review-run";

const HOST = "https://neogranadina.fisqua.test";
const ROOT = "neogranadina/";
const CODE = "co-test-001";
const REVIEW_BUCKET = "test-review-tiles";
const IMAGE_BASE = "https://f000.download.test.example/file/test-review-tiles";

type Json = Record<string, any>;

// ---------------------------------------------------------------------------
// Manifests, as the capture QC suite writes them
// ---------------------------------------------------------------------------

const digest = (label: string) => createHash("sha256").update(label).digest("hex");
const pad = (n: number) => String(n).padStart(4, "0");

function image(stem: string, n: number, c: number, role: string, take = ""): Json {
  const base = `${stem}-img_${pad(n)}_c${c}`;
  return {
    captureId: `cap-${base}${take}`,
    pairId: role === "single" ? null : `pair-${stem}-${n}`,
    filename: `${base}.cr3`,
    role,
    objectKey: `${stem}/captures/${base}.cr3`,
    sha256: digest(`capture ${base}${take}`),
    previewObjectKey: `${stem}/previews/${base}_preview.jpg`,
    previewSha256: digest(`preview ${base}${take}`),
  };
}

function volume(code: string, take = ""): Json {
  return {
    externalId: code,
    captuaCollectionId: 7,
    stem: code,
    title: `Test volume ${code}`,
    records: [
      { captuaRecordId: 11, sequence: 1, status: "in_review", rejectionNote: null, images: [image(code, 1, 0, "single")] },
      { captuaRecordId: 12, sequence: 2, status: "approved", rejectionNote: null, images: [image(code, 2, 0, "single", take)] },
    ],
  };
}

function manifest(v: Json): Json {
  return {
    contract: "fisqua-captua-exchange",
    version: "1.1",
    kind: "capture-manifest",
    id: crypto.randomUUID(),
    generatedAt: "2026-10-24T12:00:00Z",
    generatedBy: { system: "captua", instance: "rig-1", systemVersion: "0.1.0" },
    inReplyTo: null,
    project: { captuaProjectId: 1, name: "Test project" },
    transfer: { channel: "upload", root: ROOT },
    volumes: [v],
  };
}

function upload(s3: FakeS3, m: Json): void {
  for (const v of m.volumes) {
    for (const r of v.records) {
      for (const img of r.images) {
        for (const key of [img.objectKey, img.previewObjectKey]) {
          s3.objects.set(`${TEST_MASTERS_BUCKET}/${ROOT}${key}`, { bytes: new Uint8Array(10), etag: "e", contentType: null, meta: {} });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

interface World {
  link: CaptureLinkDeps;
  registered: Array<{ tenantId: string; deliveryId: string }>;
  s3: FakeS3;
  token: string;
  tenant: Tenant;
  admin: User;
  steward: User;
  outsider: User;
  sent: Json[];
  reply: () => number;
  appEnv: Record<string, string>;
}

let world: World;

async function tenantRow(id: string): Promise<Tenant> {
  const db = drizzle(env.DB, { schema });
  return (await db.select().from(schema.tenants).where(eq(schema.tenants.id, id)).get()) as Tenant;
}

async function person(opts: { tenantId?: string; isAdmin?: boolean; name?: string } = {}): Promise<User> {
  const row = await createTestUser({ tenantId: opts.tenantId, isAdmin: opts.isAdmin, name: opts.name });
  return makeUserContext({ id: row.id, tenantId: row.tenantId, email: row.email, name: row.name, isAdmin: row.isAdmin });
}

function reviewEnv(overrides: Record<string, unknown> = {}) {
  return {
    ...env,
    ...world.appEnv,
    PIPELINE_SCRIPT_VERSION: "v1.1.0",
    PIPELINE_WORKING_S3_ENDPOINT: TEST_DELIVERY_ENDPOINT,
    [`${TEST_SECRET_PREFIX}_REVIEW_SHARE_KEY_ID`]: "test-share-key-id",
    [`${TEST_SECRET_PREFIX}_REVIEW_SHARE_SECRET_KEY`]: "test-share-secret",
    ...overrides,
  } as any;
}

function reviewDeps(
  overrides: Partial<ReviewRunDeps> & { envOverrides?: Record<string, unknown> } = {},
): ReviewRunDeps {
  const { envOverrides, ...rest } = overrides;
  const testEnv = reviewEnv(envOverrides);
  const dispatch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    world.sent.push(JSON.parse(String(init?.body ?? "{}")));
    const status = world.reply();
    // 0 stands for a request that got no answer (a timeout or a network error).
    if (status === 0) throw new TypeError("network error");
    return new Response(null, { status });
  }) as typeof fetch;
  return {
    db: drizzle(env.DB),
    env: testEnv,
    specStore: getPipelineSpecStore(testEnv),
    fetchImpl: withTokenExchange(dispatch),
    config: DEFAULT_RUN_CONFIG,
    reviewImageBaseUrl: async () => IMAGE_BASE,
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    ...rest,
  };
}

async function answer(res: Response): Promise<{ status: number; json: Json | null }> {
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function settle(p: Promise<Response>): Promise<{ status: number; json: Json | null }> {
  try {
    return await answer(await p);
  } catch (thrown) {
    if (thrown instanceof Response) return { status: thrown.status, json: null };
    throw thrown;
  }
}

async function deliver(m: Json): Promise<{ manifestId: string; volumeId: string }> {
  upload(world.s3, m);
  const request = new Request(`${HOST}/api/capture/v1/manifests`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${world.token}` },
    body: JSON.stringify(m),
  });
  const res = await answer(await handleManifestDelivery(world.link, request));
  expect(res.status).toBe(200);
  return res.json as { manifestId: string; volumeId: string };
}

async function all<T = Json>(query: string, ...binds: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(query).bind(...binds).all<T>()).results;
}
async function first<T = Json>(query: string, ...binds: unknown[]): Promise<T> {
  return (await env.DB.prepare(query).bind(...binds).first<T>()) as T;
}

const counts = async () => ({
  runs: (await first<{ n: number }>("SELECT COUNT(*) AS n FROM pipeline_runs")).n,
  chunks: (await first<{ n: number }>("SELECT COUNT(*) AS n FROM pipeline_run_chunks")).n,
  reviews: (await first<{ n: number }>("SELECT COUNT(*) AS n FROM capture_review_runs")).n,
});

function retry(volumeId: string, user: User = world.admin, method = "POST", deps = reviewDeps()) {
  const request = new Request(`${HOST}/admin/capture/volumes/${volumeId}/review-run`, { method });
  return settle(reviewRunAction(deps, request, volumeId, world.tenant, user));
}

async function screenRow(volumeId: string) {
  const rows = await loadCaptureVolumes(drizzle(env.DB), DEFAULT_TEST_TENANT_ID, Date.now());
  return rows.find((r) => r.volumeId === volumeId) as (typeof rows)[number];
}

async function unitState(ref: string): Promise<string> {
  const request = new Request(`${HOST}/api/capture/v1/volumes/status?refs=${encodeURIComponent(ref)}`, {
    headers: { Authorization: `Bearer ${world.token}` },
  });
  const res = await answer(await handleVolumeStatus(world.link, request));
  return res.json!.volumes[0].state;
}

async function setReviewBucket(bucket: string | null): Promise<void> {
  await env.DB.prepare("UPDATE federations SET pipeline_review_tiles_bucket = ? WHERE id = ?")
    .bind(bucket, DEFAULT_TEST_FEDERATION_ID)
    .run();
}

/**
 * A D1 binding that counts every statement it runs, each statement of a
 * batch on its own, as D1 counts queries against an invocation's limit.
 */
function countedD1(real: D1Database): { binding: D1Database; count: () => number } {
  let n = 0;
  const realOf = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
        if (prop === "all" || prop === "run" || prop === "first" || prop === "raw") {
          return (...args: unknown[]) => {
            n++;
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
  const binding = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") return (q: string) => wrap(target.prepare(q));
      if (prop === "batch") {
        return (stmts: D1PreparedStatement[]) => {
          n += stmts.length;
          return target.batch(stmts.map((x) => realOf.get(x) ?? x));
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { binding, count: () => n };
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  clearGitHubAppCaches();
  await cleanDatabase();
  await seedFederations();
  await seedTenantDestination();
  await setReviewBucket(REVIEW_BUCKET);
  await env.DB.prepare("UPDATE tenants SET digitization_enabled = 1 WHERE id = ?").bind(DEFAULT_TEST_TENANT_ID).run();
  const repo = await createTestRepository({ tenantId: DEFAULT_TEST_TENANT_ID, code: `repo-${crypto.randomUUID().slice(0, 6)}` });
  const s3 = fakeS3([TEST_MASTERS_BUCKET]);
  const { token, sha256 } = await mintScannerToken();
  await insertRow("capture_scanners", {
    id: crypto.randomUUID(),
    tenant_id: DEFAULT_TEST_TENANT_ID,
    name: "rig-1",
    token_sha256: sha256,
    token_created_at: 1,
    created_at: 1,
    updated_at: 1,
  });
  const steward = await person({ tenantId: SECOND_TEST_TENANT_ID, name: "Test Steward" });
  await insertRow("federation_memberships", {
    id: crypto.randomUUID(),
    user_id: steward.id,
    federation_id: DEFAULT_TEST_FEDERATION_ID,
    role: "steward",
    created_at: 1,
  });
  const registered: World["registered"] = [];
  world = {
    link: {
      db: drizzle(env.DB),
      env: {
        [`${TEST_SECRET_PREFIX}_MASTERS_LIST_KEY_ID`]: "test-masters-list-key-id",
        [`${TEST_SECRET_PREFIX}_MASTERS_LIST_SECRET_KEY`]: "test-masters-list-secret",
      },
      fetch: s3.fetch,
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
      onRegistered: (tenant, deliveryId) => registered.push({ tenantId: tenant.id, deliveryId }),
    },
    registered,
    s3,
    token,
    tenant: await tenantRow(DEFAULT_TEST_TENANT_ID),
    admin: await person({ isAdmin: true, name: "Test Admin" }),
    steward,
    outsider: await person({ name: "Test Outsider" }),
    sent: [],
    reply: () => 204,
    appEnv: await githubAppEnv(),
  };
  await createTestDescription({
    tenantId: DEFAULT_TEST_TENANT_ID,
    repositoryId: repo.id,
    descriptionLevel: "volume",
    referenceCode: CODE,
  });
});

// ---------------------------------------------------------------------------
// The link's hook
// ---------------------------------------------------------------------------

describe("the link's hook", () => {
  it("hands a delivery it registered on once, and a replay not at all", async () => {
    const m = manifest(volume(CODE));
    const { manifestId } = await deliver(m);
    expect(world.registered).toEqual([{ tenantId: DEFAULT_TEST_TENANT_ID, deliveryId: manifestId }]);
    await deliver(m);
    expect(world.registered).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

describe("starting a review run", () => {
  it("writes the run, its chunk and its review row, publishes a valid spec and dispatches it once", async () => {
    const { manifestId, volumeId } = await deliver(manifest(volume(CODE)));
    const outcome = await startReviewRun(reviewDeps(), world.tenant, manifestId, null);
    expect(outcome.started).toBe(true);
    const runId = (outcome as { runId: string }).runId;

    const run = await first("SELECT * FROM pipeline_runs WHERE id = ?", runId);
    expect(run).toMatchObject({
      kind: "review_run",
      purpose: null,
      user_id: null,
      status: "dispatched",
      script_version: "v1.1.0",
      chunk_count: 1,
      volume_count: 1,
    });
    expect((await first("SELECT status FROM pipeline_run_chunks WHERE run_id = ?", runId)).status).toBe("dispatched");
    const row = await first("SELECT * FROM capture_review_runs WHERE run_id = ?", runId);
    expect(row).toMatchObject({
      delivery_id: manifestId,
      pipeline_volume_id: volumeId,
      review_prefix: `neogranadina/${manifestId}/`,
      status: "dispatched",
    });
    expect((await first("SELECT held_by_run_id FROM pipeline_volumes WHERE id = ?", volumeId)).held_by_run_id).toBeNull();
    expect(await all("SELECT id FROM pipeline_run_volumes")).toEqual([]);

    const stored = await env.SPEC_BUCKET.get(pipelineKey.spec(DEFAULT_TEST_TENANT_ID, runId));
    const spec = validateAnyRunSpec(JSON.parse(await stored!.text())) as Json;
    expect(spec.kind).toBe("review_run");
    expect(spec.review).toEqual({ backend: "b2", endpoint: TEST_DELIVERY_ENDPOINT, bucket: REVIEW_BUCKET, image_base_url: IMAGE_BASE });
    expect(spec.volumes[0].review_prefix).toBe(`neogranadina/${manifestId}/`);
    expect(spec.volumes[0].pages.map((p: Json) => p.master_key)).toEqual([
      `${ROOT}${CODE}/previews/${CODE}-img_0001_c0_preview.jpg`,
      `${ROOT}${CODE}/previews/${CODE}-img_0002_c0_preview.jpg`,
    ]);
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0].client_payload).toMatchObject({ run_id: runId, chunk_index: 0, chunk_count: 1 });
  });

  it("carries each page's rotate_deg from v1.2.0, 0 included, and none for an image without it", async () => {
    const v = volume(CODE);
    v.records[0].images[0].rotateDeg = 0;
    const { manifestId } = await deliver(manifest(v));
    const outcome = await startReviewRun(reviewDeps({ envOverrides: { PIPELINE_SCRIPT_VERSION: "v1.2.0" } }), world.tenant, manifestId, null);
    expect(outcome.started).toBe(true);
    const stored = await env.SPEC_BUCKET.get(pipelineKey.spec(DEFAULT_TEST_TENANT_ID, (outcome as { runId: string }).runId));
    const spec = validateAnyRunSpec(JSON.parse(await stored!.text())) as Json;
    expect(spec.volumes[0].pages.map((p: Json) => p.rotate_deg)).toEqual([0, undefined]);
    expect("rotate_deg" in spec.volumes[0].pages[1]).toBe(false);
  });

  /**
   * Adds to the delivery an image of a rejected record (5, numbered
   * below the page's own record 11 so an index on the record id meets it
   * first) sharing page 1's key and master, with `rotateDeg`; with
   * `rejectedFirst` page 1's own image is written again after it.
   */
  async function rejectedTwin(manifestId: string, rotateDeg: number | null, rejectedFirst: boolean) {
    const live = await first<Json>("SELECT * FROM capture_images WHERE delivery_id = ? AND captua_record_id = 11", manifestId);
    if (rejectedFirst) await env.DB.prepare("DELETE FROM capture_images WHERE id = ?").bind(live.id).run();
    await insertRow("capture_images", {
      ...live,
      id: crypto.randomUUID(),
      captua_record_id: 5,
      capture_id: "cap-rejected",
      record_status: "rejected",
      rotate_deg: rotateDeg,
    });
    if (rejectedFirst) await insertRow("capture_images", live);
  }

  it.each([
    [90, null, false],
    [90, null, true],
    [null, 270, false],
    [null, 270, true],
  ] as const)(
    "takes page 1's own rotate_deg %j over a rejected record's image %j sharing its key and master (rejected first: %s)",
    async (own, rejected, rejectedFirst) => {
      const v = volume(CODE);
      if (own !== null) v.records[0].images[0].rotateDeg = own;
      const { manifestId } = await deliver(manifest(v));
      await rejectedTwin(manifestId, rejected, rejectedFirst);
      // On v1.1.0 the page's own rotation declines the start; a rejected
      // image's rotation does not.
      const old = await startReviewRun(reviewDeps(), world.tenant, manifestId, null);
      if (own !== null) {
        expect(old).toEqual({ started: false, reason: "rotate_deg_unsupported" });
        const outcome = await startReviewRun(reviewDeps({ envOverrides: { PIPELINE_SCRIPT_VERSION: "v1.2.0" } }), world.tenant, manifestId, null);
        expect(outcome.started).toBe(true);
        const stored = await env.SPEC_BUCKET.get(pipelineKey.spec(DEFAULT_TEST_TENANT_ID, (outcome as { runId: string }).runId));
        expect(JSON.parse(await stored!.text()).volumes[0].pages.map((p: Json) => p.rotate_deg)).toEqual([own, undefined]);
      } else {
        expect(old.started).toBe(true);
        const stored = await env.SPEC_BUCKET.get(pipelineKey.spec(DEFAULT_TEST_TENANT_ID, (old as { runId: string }).runId));
        expect(await stored!.text()).not.toContain("rotate_deg");
      }
    },
  );

  it("declines a page that two of the delivery's page images match, as the delivery's own spec problem", async () => {
    const v = volume(CODE);
    v.records[0].images[0].rotateDeg = 90;
    const { manifestId } = await deliver(manifest(v));
    const live = await first<Json>("SELECT * FROM capture_images WHERE delivery_id = ? AND captua_record_id = 11", manifestId);
    await insertRow("capture_images", { ...live, id: crypto.randomUUID(), capture_id: "cap-twin", rotate_deg: 180 });
    const before = await counts();
    const outcome = await startReviewRun(reviewDeps({ envOverrides: { PIPELINE_SCRIPT_VERSION: "v1.2.0" } }), world.tenant, manifestId, null);
    expect(outcome).toEqual({
      started: false,
      reason: "spec_invalid",
      detail: { problems: [{ path: "volumes.0.pages.0", rule: "page_image_ambiguous" }] },
    });
    expect(declineIsPerDelivery(outcome as { reason: string; detail?: Record<string, unknown> })).toBe(true);
    expect(await counts()).toEqual(before);
  });

  it("writes no rotate_deg for a delivery whose images carry none", async () => {
    const { manifestId } = await deliver(manifest(volume(CODE)));
    const outcome = await startReviewRun(reviewDeps({ envOverrides: { PIPELINE_SCRIPT_VERSION: "v1.2.0" } }), world.tenant, manifestId, null);
    const stored = await env.SPEC_BUCKET.get(pipelineKey.spec(DEFAULT_TEST_TENANT_ID, (outcome as { runId: string }).runId));
    expect(await stored!.text()).not.toContain("rotate_deg");
  });

  it("records the person who asked", async () => {
    const { volumeId } = await deliver(manifest(volume(CODE)));
    const res = await retry(volumeId);
    expect(res.status).toBe(200);
    expect((await first("SELECT user_id FROM pipeline_runs WHERE id = ?", res.json!.runId)).user_id).toBe(world.admin.id);
  });
});

describe("idempotency", () => {
  it("declines a second start while the first is open", async () => {
    const { manifestId } = await deliver(manifest(volume(CODE)));
    expect((await startReviewRun(reviewDeps(), world.tenant, manifestId, null)).started).toBe(true);
    expect(await startReviewRun(reviewDeps(), world.tenant, manifestId, null)).toEqual({ started: false, reason: "review_open" });
    expect(await counts()).toEqual({ runs: 1, chunks: 1, reviews: 1 });
  });

  it("starts once when two starts arrive together", async () => {
    const { manifestId } = await deliver(manifest(volume(CODE)));
    const outcomes = await Promise.all([
      startReviewRun(reviewDeps(), world.tenant, manifestId, null),
      startReviewRun(reviewDeps(), world.tenant, manifestId, null),
    ]);
    expect(outcomes.filter((o) => o.started)).toHaveLength(1);
    expect(outcomes.find((o) => !o.started)).toEqual({ started: false, reason: "review_open" });
    expect(await counts()).toEqual({ runs: 1, chunks: 1, reviews: 1 });
  });

  it("refuses Retry after the hook's start with review_run_open", async () => {
    const { manifestId, volumeId } = await deliver(manifest(volume(CODE)));
    expect((await startReviewRun(reviewDeps(), world.tenant, manifestId, null)).started).toBe(true);
    expect(await retry(volumeId)).toEqual({ status: 409, json: { error: "review_run_open" } });
    expect(await counts()).toEqual({ runs: 1, chunks: 1, reviews: 1 });
  });

  it("gives a retake's delivery its own run and prefix, and leaves the earlier one as it was", async () => {
    const firstDelivery = await deliver(manifest(volume(CODE)));
    const firstRun = await startReviewRun(reviewDeps(), world.tenant, firstDelivery.manifestId, null);
    const retake = await deliver(manifest(volume(CODE, "-retake")));
    expect(retake.volumeId).toBe(firstDelivery.volumeId);
    expect(retake.manifestId).not.toBe(firstDelivery.manifestId);
    const second = await startReviewRun(reviewDeps(), world.tenant, retake.manifestId, null);
    expect(second.started).toBe(true);
    const rows = await all<{ delivery_id: string; review_prefix: string; status: string }>(
      "SELECT delivery_id, review_prefix, status FROM capture_review_runs ORDER BY created_at, run_id",
    );
    expect(rows.map((r) => r.review_prefix).sort()).toEqual(
      [`neogranadina/${firstDelivery.manifestId}/`, `neogranadina/${retake.manifestId}/`].sort(),
    );
    expect(rows.every((r) => r.status === "dispatched")).toBe(true);
    // A superseded delivery gets no review run.
    expect((firstRun as { started: boolean }).started).toBe(true);
    expect(await startReviewRun(reviewDeps(), world.tenant, firstDelivery.manifestId, null)).toEqual({
      started: false,
      reason: "not_registered",
    });
  });
});

describe("declined starts write nothing", () => {
  async function declinedWith(
    reason: string,
    arrange: (d: { manifestId: string; volumeId: string }) => unknown,
    tenant?: () => Tenant,
  ) {
    const d = await deliver(manifest(volume(CODE)));
    const overrides = ((await arrange(d)) ?? {}) as Partial<ReviewRunDeps> & { envOverrides?: Record<string, unknown> };
    const before = await counts();
    const outcome = await startReviewRun(reviewDeps(overrides), tenant ? tenant() : world.tenant, d.manifestId, null);
    expect(outcome).toMatchObject({ started: false, reason });
    expect(await counts()).toEqual(before);
    expect(world.sent).toEqual([]);
  }

  it("without the digitization capability", () =>
    declinedWith("no_capability", () => {}, () => ({ ...world.tenant, digitizationEnabled: false })));
  it("with a runner older than v1.1.0", () =>
    declinedWith("runner_too_old", () => ({ envOverrides: { PIPELINE_SCRIPT_VERSION: "v1.0.0" } })));
  it("for a page with rotate_deg on a runner older than v1.2.0", async () => {
    const v = volume(CODE);
    v.records[1].images[0].rotateDeg = 180;
    const d = await deliver(manifest(v));
    const before = await counts();
    const outcome = await startReviewRun(reviewDeps(), world.tenant, d.manifestId, null);
    expect(outcome).toEqual({ started: false, reason: "rotate_deg_unsupported" });
    expect(await counts()).toEqual(before);
    expect(world.sent).toEqual([]);
  });
  it("without a dispatch setting", () =>
    declinedWith("dispatch_unconfigured", () => ({ envOverrides: { PIPELINE_DISPATCH_REPO: "" } })));
  it("with an incomplete destination", () =>
    declinedWith("destination_unset", async () => {
      await env.DB.prepare("UPDATE federations SET pipeline_tiles_bucket = NULL WHERE id = ?").bind(DEFAULT_TEST_FEDERATION_ID).run();
    }));
  it("without a review bucket", () => declinedWith("no_review_bucket", () => setReviewBucket(null)));
  it("for a delivery with no openings", () =>
    declinedWith("no_openings", async ({ manifestId }) => {
      await env.DB.prepare("UPDATE capture_deliveries SET openings = 0 WHERE id = ?").bind(manifestId).run();
    }));
  it("for a delivery that no longer holds its volume", () =>
    declinedWith("not_registered", async ({ manifestId }) => {
      await env.DB.prepare("UPDATE capture_deliveries SET state = 'superseded', superseded_by = 'x', superseded_at = 1 WHERE id = ?")
        .bind(manifestId)
        .run();
    }));
  it("for a volume processing has moved on", () =>
    declinedWith("processing_started", async ({ volumeId }) => {
      await env.DB.prepare("UPDATE pipeline_volumes SET state = 'prepared' WHERE id = ?").bind(volumeId).run();
    }));
  it("for a restricted volume", () =>
    declinedWith("restricted", async ({ volumeId }) => {
      await env.DB.prepare("UPDATE pipeline_volumes SET restricted = 1 WHERE id = ?").bind(volumeId).run();
    }));
  it("for a page without its digest", () =>
    declinedWith("pages_unready", async ({ volumeId }) => {
      await env.DB.prepare("UPDATE pipeline_volume_pages SET sha256 = NULL WHERE pipeline_volume_id = ? AND seq = 1").bind(volumeId).run();
    }));
  it("when the download address cannot be read", () =>
    declinedWith("image_base_unavailable", () => ({ reviewImageBaseUrl: async () => null })));
  it("when the review images are ready", async () => {
    const d = await deliver(manifest(volume(CODE)));
    expect((await startReviewRun(reviewDeps(), world.tenant, d.manifestId, null)).started).toBe(true);
    await env.DB.prepare("UPDATE capture_review_runs SET status = 'review_ready', reported_at = ?").bind(Date.now()).run();
    const before = await counts();
    expect(await startReviewRun(reviewDeps(), world.tenant, d.manifestId, null)).toEqual({ started: false, reason: "review_ready" });
    expect(await counts()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// A failed dispatch, and Retry
// ---------------------------------------------------------------------------

describe("a failed review run", () => {
  it("is shown as review images failed with Retry, the unit sees registered, and Retry starts a new run", async () => {
    const { manifestId, volumeId } = await deliver(manifest(volume(CODE)));
    world.reply = () => 422;
    const outcome = await startReviewRun(reviewDeps(), world.tenant, manifestId, null);
    expect(outcome.started).toBe(true);
    const runId = (outcome as { runId: string }).runId;
    expect(await first("SELECT status, token_revoked_at IS NOT NULL AS closed, volumes_reported FROM pipeline_runs WHERE id = ?", runId)).toEqual({
      status: "error",
      closed: 1,
      volumes_reported: 1,
    });
    const row = await first("SELECT status, error FROM capture_review_runs WHERE run_id = ?", runId);
    expect(row.status).toBe("aborted");
    expect(JSON.parse(row.error)).toEqual({ class: "dispatch", chunk_index: 0, status: 422 });

    const screen = await screenRow(volumeId);
    expect(screen.state).toBe("review_failed");
    expect(screen.nextStep).toBe("retry_review");
    expect(screen.problem).toEqual({ kind: "pipeline", message: "dispatch" });
    expect(await unitState(CODE)).toBe("registered");

    world.reply = () => 204;
    const res = await retry(volumeId);
    expect(res.status).toBe(200);
    expect(res.json!.runId).not.toBe(runId);
    expect((await screenRow(volumeId)).state).toBe("preparing_review");
  });

  it("holds Retry while a dispatch that got no answer may still run, and settles on its tiles when they come", async () => {
    const { manifestId, volumeId } = await deliver(manifest(volume(CODE)));
    world.reply = () => 0;
    const a = (await startReviewRun(reviewDeps(), world.tenant, manifestId, null)) as { runId: string };
    expect(await first("SELECT status FROM pipeline_run_chunks WHERE run_id = ?", a.runId)).toEqual({ status: "failed" });
    expect(await first("SELECT status FROM capture_review_runs WHERE run_id = ?", a.runId)).toEqual({ status: "aborted" });
    expect(await first("SELECT token_revoked_at FROM pipeline_runs WHERE id = ?", a.runId)).toEqual({ token_revoked_at: null });

    world.reply = () => 204;
    expect(await retry(volumeId)).toEqual({ status: 409, json: { error: "review_run_open" } });
    expect((await screenRow(volumeId)).state).toBe("preparing_review");
    expect(await counts()).toEqual({ runs: 1, chunks: 1, reviews: 1 });

    // The runner did start, and its tiles are ready.
    await env.DB.prepare("UPDATE capture_review_runs SET status = 'review_ready', reported_at = ? WHERE run_id = ?")
      .bind(Date.now(), a.runId)
      .run();
    expect((await screenRow(volumeId)).state).toBe("in_capture_qc");
    expect(await retry(volumeId)).toEqual({ status: 409, json: { error: "review_not_applicable", reason: "review_ready" } });
  });

  it("settles on tiles ready over a later failed run of the same delivery", async () => {
    const { manifestId, volumeId } = await deliver(manifest(volume(CODE)));
    const a = (await startReviewRun(reviewDeps(), world.tenant, manifestId, null)) as { runId: string };
    await env.DB.prepare("UPDATE capture_review_runs SET status = 'review_ready', reported_at = ? WHERE run_id = ?")
      .bind(Date.now() - 1000, a.runId)
      .run();
    // A later run of the same delivery that failed, as an overlap would leave it.
    const b = crypto.randomUUID();
    const later = Date.now();
    const run = await first("SELECT * FROM pipeline_runs WHERE id = ?", a.runId);
    await insertRow("pipeline_runs", {
      ...run,
      id: b,
      status: "error",
      token_revoked_at: later,
      spec_key: pipelineKey.spec(DEFAULT_TEST_TENANT_ID, b),
      created_at: later,
    });
    await insertRow("capture_review_runs", {
      tenant_id: DEFAULT_TEST_TENANT_ID,
      run_id: b,
      delivery_id: manifestId,
      pipeline_volume_id: volumeId,
      review_prefix: `neogranadina/${manifestId}/`,
      status: "aborted",
      error: JSON.stringify({ class: "dispatch", status: 422 }),
      reported_at: later,
      created_at: later,
    });
    const latest = await readLatestReviewRuns(drizzle(env.DB), DEFAULT_TEST_TENANT_ID, [manifestId], Date.now());
    expect(latest.get(manifestId)).toMatchObject({ runId: a.runId, state: "ready" });
    expect((await screenRow(volumeId)).state).toBe("in_capture_qc");
    expect(await unitState(CODE)).toBe("in_capture_qc");
  });

  it("is failed once its run is closed without the row reporting", async () => {
    const { manifestId } = await deliver(manifest(volume(CODE)));
    const outcome = (await startReviewRun(reviewDeps(), world.tenant, manifestId, null)) as { runId: string };
    await env.DB.prepare("UPDATE pipeline_runs SET status = 'error', token_revoked_at = ? WHERE id = ?").bind(Date.now() - 1, outcome.runId).run();
    const latest = await readLatestReviewRuns(drizzle(env.DB), DEFAULT_TEST_TENANT_ID, [manifestId], Date.now());
    expect(latest.get(manifestId)?.state).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

describe("the states", () => {
  it("is preparing review images while the run is open, for the unit and the screen", async () => {
    const { manifestId, volumeId } = await deliver(manifest(volume(CODE)));
    await startReviewRun(reviewDeps(), world.tenant, manifestId, null);
    expect(await unitState(CODE)).toBe("preparing_review");
    const row = await screenRow(volumeId);
    expect(row.state).toBe("preparing_review");
    expect(row.nextStep).toBe("review_opens");
  });

  it("is in capture QC once the tiles are ready and nothing is decided", async () => {
    const { manifestId, volumeId } = await deliver(manifest(volume(CODE)));
    await startReviewRun(reviewDeps(), world.tenant, manifestId, null);
    await env.DB.prepare("UPDATE capture_review_runs SET status = 'review_ready', reported_at = ?").bind(Date.now()).run();
    expect(await unitState(CODE)).toBe("in_capture_qc");
    expect((await screenRow(volumeId)).state).toBe("in_capture_qc");
  });

  it("is preparing review images over a retake's carried approvals", async () => {
    const firstDelivery = await deliver(manifest(volume(CODE)));
    const request = new Request(`${HOST}/admin/capture/volumes/${firstDelivery.volumeId}/decisions`, {
      method: "POST",
      body: JSON.stringify({
        manifestId: firstDelivery.manifestId,
        records: [
          { captuaRecordId: 11, decision: "approved" },
          { captuaRecordId: 12, decision: "rejected", reason: "glare" },
        ],
      }),
    });
    const decided = await recordDecisionsAction(
      { db: drizzle(env.DB), now: () => Date.now(), newId: () => crypto.randomUUID() },
      request,
      firstDelivery.volumeId,
      world.tenant,
      world.admin,
    );
    expect(decided.status).toBe(200);
    const retake = await deliver(manifest(volume(CODE, "-retake")));
    expect(await first("SELECT carried_from FROM capture_qc_sets WHERE delivery_id = ?", retake.manifestId)).toEqual({
      carried_from: firstDelivery.manifestId,
    });
    expect(await unitState(CODE)).toBe("in_capture_qc");
    await startReviewRun(reviewDeps(), world.tenant, retake.manifestId, null);
    expect(await unitState(CODE)).toBe("preparing_review");
    const row = await screenRow(retake.volumeId);
    expect(row.state).toBe("preparing_review");
    expect(row.nextStep).toBe("retakes_came_back");
  });

  it("is received with Prepare where the federation has a bucket and the delivery no run", async () => {
    const { volumeId } = await deliver(manifest(volume(CODE)));
    const row = await screenRow(volumeId);
    expect(row.state).toBe("received");
    expect(row.nextStep).toBe("prepare_review");
    expect(await unitState(CODE)).toBe("registered");
  });

  it("is in capture QC at once where the federation has no review bucket", async () => {
    await setReviewBucket(null);
    const { volumeId } = await deliver(manifest(volume(CODE)));
    const row = await screenRow(volumeId);
    expect(row.state).toBe("in_capture_qc");
    expect(row.nextStep).toBe("assign_reviewer");
  });
});

// ---------------------------------------------------------------------------
// The hold
// ---------------------------------------------------------------------------

describe("the hold during preparing_review", () => {
  it("still holds the volume from processing", async () => {
    const { manifestId, volumeId } = await deliver(manifest(volume(CODE)));
    await startReviewRun(reviewDeps(), world.tenant, manifestId, null);
    const { readCaptureQcPending } = await import("../../app/lib/capture/hold.server");
    expect(await readCaptureQcPending(drizzle(env.DB), DEFAULT_TEST_TENANT_ID, [volumeId])).toEqual([volumeId]);
  });
});

// ---------------------------------------------------------------------------
// The sweep's step
// ---------------------------------------------------------------------------

describe("the sweep's step", () => {
  it("starts a pending delivery's review run in production", async () => {
    const { manifestId } = await deliver(manifest(volume(CODE)));
    const counted = await startPendingReviewRuns(reviewDeps({ envOverrides: { PIPELINE_ENVIRONMENT: "production" } }));
    expect(counted).toEqual({ started: 1, declined: 0 });
    expect((await first("SELECT delivery_id FROM capture_review_runs")).delivery_id).toBe(manifestId);
    // Nothing is pending any more.
    expect(await startPendingReviewRuns(reviewDeps({ envOverrides: { PIPELINE_ENVIRONMENT: "production" } }))).toEqual({
      started: 0,
      declined: 0,
    });
  });

  it("does nothing on staging", async () => {
    await deliver(manifest(volume(CODE)));
    expect(await startPendingReviewRuns(reviewDeps({ envOverrides: { PIPELINE_ENVIRONMENT: "staging" } }))).toEqual({
      started: 0,
      declined: 0,
    });
    expect(await counts()).toEqual({ runs: 0, chunks: 0, reviews: 0 });
  });

  const production = (overrides: Partial<ReviewRunDeps> = {}) =>
    reviewDeps({ envOverrides: { PIPELINE_ENVIRONMENT: "production" }, ...overrides });

  /** Delivers `n` volumes, oldest first, each with its own description. */
  async function deliverMany(n: number): Promise<Array<{ manifestId: string; volumeId: string; code: string }>> {
    const repo = await createTestRepository({ tenantId: DEFAULT_TEST_TENANT_ID, code: `repo-${crypto.randomUUID().slice(0, 6)}` });
    const out = [];
    for (let i = 0; i < n; i++) {
      const code = `co-test-${pad(100 + i)}`;
      await createTestDescription({ tenantId: DEFAULT_TEST_TENANT_ID, repositoryId: repo.id, descriptionLevel: "volume", referenceCode: code });
      out.push({ ...(await deliver(manifest(volume(code)))), code });
      await env.DB.prepare("UPDATE capture_deliveries SET received_at = ? WHERE id = ?").bind(1000 + i, out[i].manifestId).run();
    }
    return out;
  }

  it("looks past older deliveries a start would decline", async () => {
    const [unready, restricted, eligible] = await deliverMany(3);
    await env.DB.prepare("UPDATE pipeline_volume_pages SET sha256 = NULL WHERE pipeline_volume_id = ? AND seq = 1").bind(unready.volumeId).run();
    await env.DB.prepare("UPDATE pipeline_volumes SET restricted = 1 WHERE id = ?").bind(restricted.volumeId).run();
    expect(await startPendingReviewRuns(production(), { limit: 1 })).toEqual({ started: 1, declined: 0 });
    expect((await first("SELECT delivery_id FROM capture_review_runs")).delivery_id).toBe(eligible.manifestId);
  });

  it("passes over a federation whose share key is not set, or whose download address cannot be read", async () => {
    await deliverMany(3);
    const noKey = reviewDeps({
      envOverrides: {
        PIPELINE_ENVIRONMENT: "production",
        [`${TEST_SECRET_PREFIX}_REVIEW_SHARE_KEY_ID`]: undefined,
      },
    });
    expect(await startPendingReviewRuns(noKey)).toEqual({ started: 0, declined: 0 });

    let asked = 0;
    const refused = production({
      reviewImageBaseUrl: async () => {
        asked++;
        return null;
      },
    });
    // Decided once for the federation, before any delivery is read.
    expect(await startPendingReviewRuns(refused)).toEqual({ started: 0, declined: 0 });
    expect(asked).toBe(1);
    expect(await counts()).toEqual({ runs: 0, chunks: 0, reviews: 0 });
  });

  /**
   * `n` otherwise eligible deliveries of the second test tenant, older
   * than anything delivered over the link, in a federation with a review
   * bucket and a secret prefix whose share key is not set.
   */
  async function unconfiguredFederation(
    n: number,
    at: { tenantId: string; federationId: string; prefix: string; slug: string } = {
      tenantId: SECOND_TEST_TENANT_ID,
      federationId: SECOND_TEST_FEDERATION_ID,
      prefix: "SECOND_UNSET",
      slug: "second-tenant",
    },
    opts: { masterOutsidePrefix?: boolean } = {},
  ): Promise<void> {
    await env.DB.prepare(
      "UPDATE federations SET pipeline_review_tiles_bucket = ?, storage_secret_prefix = ? WHERE id = ?",
    )
      .bind(`${at.slug}-review-tiles`, at.prefix, at.federationId)
      .run();
    await env.DB.prepare("UPDATE tenants SET digitization_enabled = 1 WHERE id = ?").bind(at.tenantId).run();
    const repo = await createTestRepository({ tenantId: at.tenantId, code: `repo-${crypto.randomUUID().slice(0, 6)}` });
    for (let i = 0; i < n; i++) {
      const code = `co-${at.slug}-${pad(i)}`;
      const d = await createTestDescription({ tenantId: at.tenantId, repositoryId: repo.id, descriptionLevel: "volume", referenceCode: code });
      const volumeId = crypto.randomUUID();
      await insertRow("pipeline_volumes", {
        id: volumeId,
        tenant_id: at.tenantId,
        description_id: d.id,
        reference_code: code,
        kind: "volume_run",
        masters_backend: "b2",
        masters_endpoint: TEST_DELIVERY_ENDPOINT,
        masters_bucket: TEST_MASTERS_BUCKET,
        masters_prefix: `${at.slug}/${code}/`,
        expected_count: 1,
        recipe_scope_description_id: d.id,
        created_at: 1,
        updated_at: 1,
      });
      await insertRow("pipeline_volume_pages", {
        id: crypto.randomUUID(),
        tenant_id: at.tenantId,
        pipeline_volume_id: volumeId,
        seq: 1,
        page_key: `${code}-img_0001_c0`,
        master_key: opts.masterOutsidePrefix
          ? `elsewhere/${code}/previews/${code}-img_0001_c0_preview.jpg`
          : `${at.slug}/${code}/previews/${code}-img_0001_c0_preview.jpg`,
        sha256: digest(code),
      });
      await insertRow("capture_deliveries", {
        tenant_id: at.tenantId,
        id: crypto.randomUUID(),
        route: "file",
        scanner_id: null,
        reference_code: code,
        pipeline_volume_id: volumeId,
        body_sha256: digest(`body ${code}`),
        state: "registered",
        answer_status: 200,
        answer_body: "{}",
        openings: 1,
        received_at: i + 1,
        seq: 100_000 + i,
      });
    }
  }

  it("reaches a configured federation behind fifty older deliveries of one whose share key is not set", async () => {
    await unconfiguredFederation(55);
    const [eligible] = await deliverMany(1);
    expect(await startPendingReviewRuns(production())).toEqual({ started: 1, declined: 0 });
    expect((await first("SELECT delivery_id FROM capture_review_runs")).delivery_id).toBe(eligible.manifestId);
  });

  it("reaches a configured federation behind fifty older deliveries of one that keeps declining", async () => {
    await unconfiguredFederation(55);
    const [eligible] = await deliverMany(1);
    // The second federation's share key is set, but its destination is
    // incomplete, so a start there would decline with destination_unset.
    const deps = reviewDeps({
      envOverrides: {
        PIPELINE_ENVIRONMENT: "production",
        SECOND_UNSET_REVIEW_SHARE_KEY_ID: "second-key-id",
        SECOND_UNSET_REVIEW_SHARE_SECRET_KEY: "second-secret",
      },
    });
    // Its destination is decided once, before any delivery is read.
    expect(await startPendingReviewRuns(deps)).toEqual({ started: 1, declined: 0 });
    expect((await first("SELECT delivery_id FROM capture_review_runs")).delivery_id).toBe(eligible.manifestId);
  });

  /** A federation of its own, led by a new tenant cloned from the second test tenant. */
  async function newFederation(i: number) {
    const tenantId = crypto.randomUUID();
    const federationId = crypto.randomUUID();
    const slug = `declining-${i}`;
    const tenant = await first("SELECT * FROM tenants WHERE id = ?", SECOND_TEST_TENANT_ID);
    const federation = await first("SELECT * FROM federations WHERE id = ?", SECOND_TEST_FEDERATION_ID);
    await insertRow("tenants", { ...tenant, id: tenantId, slug, name: `Declining ${i}`, federation_id: null });
    await insertRow("federations", { ...federation, id: federationId, slug, name: `Declining ${i}`, lead_tenant_id: tenantId });
    await env.DB.prepare("UPDATE tenants SET federation_id = ? WHERE id = ?").bind(federationId, tenantId).run();
    return { tenantId, federationId, prefix: `DECLINING_${i}`, slug };
  }

  it("starts a healthy delivery in its first tick behind five declining federations of fifty each", async () => {
    const secrets: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      const at = await newFederation(i);
      await unconfiguredFederation(50, at);
      secrets[`${at.prefix}_REVIEW_SHARE_KEY_ID`] = `declining-${i}-key-id`;
      secrets[`${at.prefix}_REVIEW_SHARE_SECRET_KEY`] = `declining-${i}-secret`;
    }
    const [eligible] = await deliverMany(1);
    // Each declining federation's share key is set, but its destination
    // is incomplete.
    const deps = reviewDeps({ envOverrides: { PIPELINE_ENVIRONMENT: "production", ...secrets } });
    expect(await startPendingReviewRuns(deps)).toEqual({ started: 1, declined: 0 });
    expect((await first("SELECT delivery_id FROM capture_review_runs")).delivery_id).toBe(eligible.manifestId);
  });

  it("starts a healthy delivery in its first tick behind 250 of a federation whose review bucket is its tiles bucket", async () => {
    const at = await newFederation(9);
    await unconfiguredFederation(250, at);
    // Complete in every other way: the test destination, under its own
    // secret prefix, with the review bucket the same as the tiles bucket.
    await seedTenantDestination(at.tenantId, {
      ...TEST_DESTINATION,
      pipelineTilesBucket: "bad-tiles-bucket",
      pipelineMastersBucket: "bad-masters-bucket",
      pipelineImageBaseUrl: "https://bad-tiles.test.example",
      manifestBucket: "bad-manifests",
      manifestBaseUrl: "https://bad-manifests.test.example",
      storageSecretPrefix: at.prefix,
      pipelineReviewTilesBucket: "bad-tiles-bucket",
    });
    const [eligible] = await deliverMany(1);
    let asked = 0;
    const deps = reviewDeps({
      envOverrides: {
        PIPELINE_ENVIRONMENT: "production",
        ...testSecrets(at.prefix),
        [`${at.prefix}_REVIEW_SHARE_KEY_ID`]: "shared-key-id",
        [`${at.prefix}_REVIEW_SHARE_SECRET_KEY`]: "shared-secret",
      },
      reviewImageBaseUrl: async () => {
        asked++;
        return IMAGE_BASE;
      },
    });
    expect(await startPendingReviewRuns(deps)).toEqual({ started: 1, declined: 0 });
    expect((await first("SELECT delivery_id FROM capture_review_runs")).delivery_id).toBe(eligible.manifestId);
    // The bad federation was turned away before its address was read.
    expect(asked).toBe(2);
  });

  it("keeps a delivery whose own pages fail the spec checks from stopping its federation", async () => {
    const [bad, good] = await deliverMany(2);
    await env.DB.prepare("UPDATE pipeline_volume_pages SET master_key = 'elsewhere/p.jpg' WHERE pipeline_volume_id = ? AND seq = 1")
      .bind(bad.volumeId)
      .run();
    expect(await startPendingReviewRuns(production())).toEqual({ started: 1, declined: 1 });
    expect((await first("SELECT delivery_id FROM capture_review_runs")).delivery_id).toBe(good.manifestId);
  });

  it("records deliveries it declined for a reason of their own, tries each once, stays within its budget each tick, and reaches the healthy one", async () => {
    const at = await newFederation(7);
    // 250 older deliveries whose page lies outside its source prefix, in
    // a federation that is otherwise ready for review runs.
    await unconfiguredFederation(250, at, { masterOutsidePrefix: true });
    await seedTenantDestination(at.tenantId, {
      ...TEST_DESTINATION,
      pipelineTilesBucket: "broken-tiles-bucket",
      pipelineMastersBucket: "broken-masters-bucket",
      pipelineImageBaseUrl: "https://broken-tiles.test.example",
      manifestBucket: "broken-manifests",
      manifestBaseUrl: "https://broken-manifests.test.example",
      storageSecretPrefix: at.prefix,
      pipelineReviewTilesBucket: "broken-review-tiles",
    });
    const [eligible] = await deliverMany(1);
    const envOverrides = {
      PIPELINE_ENVIRONMENT: "production",
      ...testSecrets(at.prefix),
      [`${at.prefix}_REVIEW_SHARE_KEY_ID`]: "broken-key-id",
      [`${at.prefix}_REVIEW_SHARE_SECRET_KEY`]: "broken-secret",
    };
    const flagged = async () =>
      (await first<{ n: number }>("SELECT COUNT(*) AS n FROM capture_deliveries WHERE tenant_id = ? AND review_declined_at IS NOT NULL", at.tenantId)).n;

    let declined = 0;
    let ticks = 0;
    let started = 0;
    const maxTicks = Math.ceil(250 / REVIEW_ATTEMPTS_PER_TICK) + 1;
    while (started === 0 && ticks < maxTicks) {
      const counted = countedD1(env.DB);
      const tick = await startPendingReviewRuns(reviewDeps({ db: drizzle(counted.binding), envOverrides }));
      ticks++;
      expect(tick.started + tick.declined).toBeLessThanOrEqual(REVIEW_ATTEMPTS_PER_TICK);
      expect(counted.count()).toBeLessThanOrEqual(REVIEW_SWEEP_QUERY_CEILING);
      declined += tick.declined;
      started += tick.started;
      // Every decline is recorded, so none is tried again.
      expect(await flagged()).toBe(declined);
    }
    expect(started).toBe(1);
    expect(declined).toBe(250);
    expect(ticks).toBe(maxTicks);
    expect((await first("SELECT delivery_id FROM capture_review_runs")).delivery_id).toBe(eligible.manifestId);
    expect(await startPendingReviewRuns(reviewDeps({ envOverrides }))).toEqual({ started: 0, declined: 0 });
  });

  it("stays within its query ceiling when every dispatch fails", async () => {
    await deliverMany(REVIEW_ATTEMPTS_PER_TICK + 2);
    world.reply = () => 422;
    const counted = countedD1(env.DB);
    const tick = await startPendingReviewRuns(reviewDeps({ db: drizzle(counted.binding), envOverrides: { PIPELINE_ENVIRONMENT: "production" } }));
    // A failed dispatch still counts as a start: its review row records the failure.
    expect(tick).toEqual({ started: REVIEW_ATTEMPTS_PER_TICK, declined: 0 });
    expect(counted.count()).toBeLessThanOrEqual(REVIEW_SWEEP_QUERY_CEILING);
    expect(
      (await all("SELECT status FROM capture_review_runs")).every((r: Json) => r.status === "aborted"),
    ).toBe(true);
  });

  it("leaves a delivery with rotate_deg pending below v1.2.0, unrecorded, and starts it once the runner reads it", async () => {
    const repo = await createTestRepository({ tenantId: DEFAULT_TEST_TENANT_ID, code: `repo-${crypto.randomUUID().slice(0, 6)}` });
    await createTestDescription({ tenantId: DEFAULT_TEST_TENANT_ID, repositoryId: repo.id, descriptionLevel: "volume", referenceCode: "co-test-100" });
    const v = volume("co-test-100");
    v.records[0].images[0].rotateDeg = 90;
    const turned = await deliver(manifest(v));
    await env.DB.prepare("UPDATE capture_deliveries SET received_at = 1 WHERE id = ?").bind(turned.manifestId).run();
    const plain = await deliver(manifest(volume(CODE)));

    // v1.1.0: the turned delivery is not a candidate; the plain one starts.
    expect(await startPendingReviewRuns(production())).toEqual({ started: 1, declined: 0 });
    expect(await all("SELECT delivery_id FROM capture_review_runs")).toEqual([{ delivery_id: plain.manifestId }]);
    expect((await first("SELECT review_declined_at FROM capture_deliveries WHERE id = ?", turned.manifestId)).review_declined_at).toBeNull();
    expect(await startPendingReviewRuns(production())).toEqual({ started: 0, declined: 0 });

    // v1.2.0: it starts, with its rotation in the spec.
    const v120 = reviewDeps({ envOverrides: { PIPELINE_ENVIRONMENT: "production", PIPELINE_SCRIPT_VERSION: "v1.2.0" } });
    expect(await startPendingReviewRuns(v120)).toEqual({ started: 1, declined: 0 });
    const run = await first<{ run_id: string }>("SELECT run_id FROM capture_review_runs WHERE delivery_id = ?", turned.manifestId);
    const stored = await env.SPEC_BUCKET.get(pipelineKey.spec(DEFAULT_TEST_TENANT_ID, run.run_id));
    expect(JSON.parse(await stored!.text()).volumes[0].pages.map((p: Json) => p.rotate_deg)).toEqual([90, undefined]);
  });

  it("does nothing with a runner older than v1.1.0", async () => {
    await deliverMany(1);
    const old = reviewDeps({ envOverrides: { PIPELINE_ENVIRONMENT: "production", PIPELINE_SCRIPT_VERSION: "v1.0.0" } });
    expect(await startPendingReviewRuns(old)).toEqual({ started: 0, declined: 0 });
  });

  it("leaves a federation without a review bucket alone", async () => {
    await setReviewBucket(null);
    await deliver(manifest(volume(CODE)));
    expect(await startPendingReviewRuns(reviewDeps({ envOverrides: { PIPELINE_ENVIRONMENT: "production" } }))).toEqual({
      started: 0,
      declined: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// The Prepare and Retry action
// ---------------------------------------------------------------------------

describe("the Prepare and Retry action", () => {
  it("lets admins and stewards start, and refuses anyone else with a bare 403", async () => {
    const { volumeId } = await deliver(manifest(volume(CODE)));
    expect((await retry(volumeId, world.outsider)).status).toBe(403);
    expect(await counts()).toEqual({ runs: 0, chunks: 0, reviews: 0 });
    expect((await retry(volumeId, world.steward)).status).toBe(200);
  });

  it("clears a delivery the sweep declined and starts its run", async () => {
    const { manifestId, volumeId } = await deliver(manifest(volume(CODE)));
    await env.DB.prepare("UPDATE pipeline_volume_pages SET master_key = 'elsewhere/p.jpg' WHERE pipeline_volume_id = ? AND seq = 1")
      .bind(volumeId)
      .run();
    const production = reviewDeps({ envOverrides: { PIPELINE_ENVIRONMENT: "production" } });
    expect(await startPendingReviewRuns(production)).toEqual({ started: 0, declined: 1 });
    expect((await first("SELECT review_declined_at FROM capture_deliveries WHERE id = ?", manifestId)).review_declined_at).not.toBeNull();

    // The page is put right; Retry clears the record and starts the run.
    await env.DB.prepare(
      "UPDATE pipeline_volume_pages SET master_key = ? WHERE pipeline_volume_id = ? AND seq = 1",
    )
      .bind(`${ROOT}${CODE}/previews/${CODE}-img_0001_c0_preview.jpg`, volumeId)
      .run();
    const res = await retry(volumeId);
    expect(res.status).toBe(200);
    expect((await first("SELECT review_declined_at FROM capture_deliveries WHERE id = ?", manifestId)).review_declined_at).toBeNull();
    expect((await first("SELECT delivery_id FROM capture_review_runs WHERE run_id = ?", res.json!.runId)).delivery_id).toBe(manifestId);
  });

  it("refuses a cross-site post to the route before anything else, and takes a same-origin one", async () => {
    const { volumeId } = await deliver(manifest(volume(CODE)));
    const call = async (headers: Record<string, string>) => {
      const ctx = new RouterContextProvider();
      ctx.set(tenantContext, { ...world.tenant, digitizationEnabled: true });
      ctx.set(userContext, world.admin);
      // The test host is a .fisqua.test subdomain; the bound settings carry
      // production's public host suffix.
      (ctx as any).cloudflare = { env: reviewEnv({ PUBLIC_HOST_SUFFIX: ".fisqua.test" }) };
      const request = new Request(`${HOST}/admin/capture/volumes/${volumeId}/review-run`, { method: "POST", headers });
      try {
        return (await reviewRunRoute({ request, context: ctx, params: { volumeId } } as any)) as Response;
      } catch (thrown) {
        if (thrown instanceof Response) return thrown;
        throw thrown;
      }
    };
    expect((await call({ Origin: "https://second-tenant.fisqua.test" })).status).toBe(403);
    expect((await call({})).status).toBe(403);
    expect((await call({ Origin: "https://second-tenant.fisqua.test", "X-Forwarded-Host": "second-tenant.fisqua.test" })).status).toBe(403);
    expect(await counts()).toEqual({ runs: 0, chunks: 0, reviews: 0 });
    expect((await call({ Origin: HOST })).status).not.toBe(403);
  });

  it("answers 405 to GET, 404 for a volume with no registered delivery, and review_not_applicable with its reason", async () => {
    const { volumeId } = await deliver(manifest(volume(CODE)));
    expect((await retry(volumeId, world.admin, "GET")).status).toBe(405);
    expect(await retry(crypto.randomUUID())).toEqual({ status: 404, json: { error: "volume_not_found" } });
    await setReviewBucket(null);
    expect(await retry(volumeId)).toEqual({
      status: 409,
      json: { error: "review_not_applicable", reason: "no_review_bucket" },
    });
  });
});

// ---------------------------------------------------------------------------
// Which declines hold for the whole federation
// ---------------------------------------------------------------------------

describe("classifying a declined start", () => {
  it("keeps the reasons of the delivery or its volume per delivery", () => {
    for (const reason of [
      "not_registered",
      "no_openings",
      "processing_started",
      "restricted",
      "pages_unready",
      "rotate_deg_unsupported",
      "review_open",
      "review_ready",
    ]) {
      expect(declineIsPerDelivery({ reason }), reason).toBe(true);
    }
  });

  it("treats every other reason, one added later included, as federation-wide", () => {
    for (const reason of ["no_capability", "destination_unset", "no_review_bucket", "image_base_unavailable", "a_reason_added_later"]) {
      expect(declineIsPerDelivery({ reason }), reason).toBe(false);
    }
  });

  it("classifies a refused spec by where its problems lie", () => {
    const spec = (paths: string[]) => ({ reason: "spec_invalid", detail: { problems: paths.map((path) => ({ path, rule: "r" })) } });
    expect(declineIsPerDelivery(spec(["volumes.0.pages.2.seq"]))).toBe(true);
    expect(declineIsPerDelivery(spec(["volumes.0.pages", "jobs.0.volume_ids.0"]))).toBe(true);
    expect(declineIsPerDelivery(spec(["working.bucket"]))).toBe(false);
    expect(declineIsPerDelivery(spec(["volumes.0.pages.1.master_key", "review.bucket"]))).toBe(false);
    expect(declineIsPerDelivery(spec(["destination.endpoint"]))).toBe(false);
    expect(declineIsPerDelivery({ reason: "spec_invalid" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The download address
// ---------------------------------------------------------------------------

describe("the review bucket's download address", () => {
  const destination = {
    federationId: DEFAULT_TEST_FEDERATION_ID,
    secretPrefix: TEST_SECRET_PREFIX,
    reviewTilesBucket: REVIEW_BUCKET,
  };
  const keyEnv = {
    [`${TEST_SECRET_PREFIX}_REVIEW_SHARE_KEY_ID`]: "test-share-key-id",
    [`${TEST_SECRET_PREFIX}_REVIEW_SHARE_SECRET_KEY`]: "test-share-secret",
  };

  function b2(status = 200) {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (status !== 200) return new Response(null, { status });
      return Response.json({
        authorizationToken: "test-account-token",
        apiInfo: {
          storageApi: {
            apiUrl: "https://api000.backblazeb2.test.example",
            downloadUrl: "https://f000.backblazeb2.test.example/",
            allowed: { buckets: [{ id: "bucket-id", name: REVIEW_BUCKET }] },
          },
        },
      });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  beforeEach(() => clearReviewAccountCache());

  it("is the account's download URL with the bucket, and reuses the cached account", async () => {
    const { calls, fetchImpl } = b2();
    const deps = { fetch: fetchImpl, now: () => Date.now() };
    expect(await shareKeyImageBaseUrl(keyEnv, deps, destination)).toBe(
      `https://f000.backblazeb2.test.example/file/${REVIEW_BUCKET}`,
    );
    expect(await shareKeyImageBaseUrl(keyEnv, deps, destination)).toBe(
      `https://f000.backblazeb2.test.example/file/${REVIEW_BUCKET}`,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("b2_authorize_account");
  });

  it("is null without the key's secrets, and when B2 refuses the key", async () => {
    const { calls, fetchImpl } = b2(401);
    const deps = { fetch: fetchImpl, now: () => Date.now() };
    expect(await shareKeyImageBaseUrl({}, deps, destination)).toBeNull();
    expect(calls).toEqual([]);
    expect(await shareKeyImageBaseUrl(keyEnv, deps, destination)).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

// @version v0.8.0
