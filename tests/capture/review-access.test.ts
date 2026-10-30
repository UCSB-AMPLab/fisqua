/**
 * Tests — download authorisation for the capture QC review tiles
 *
 * This suite calls `reviewAccessLoader`, and the route that wraps it,
 * with Backblaze B2 replaced at the fetch layer by a scripted fake: no
 * request leaves the test. The fake answers `b2_authorize_account` and
 * `b2_get_download_authorization` in the shapes B2's v4 documentation
 * gives, and records every call. It pins:
 *
 *   - each refusal: the digitization capability off (a bare 404),
 *     another tenant's volume (404 `volume_not_found`), a caller who is
 *     neither the reviewer nor a QC manager (a bare 403), a federation
 *     without the review bucket or the share key's secrets (409
 *     `no_review_bucket`), a volume without readable deliveries (404
 *     `no_review_tiles`: none with a review run that reported
 *     `review_ready` and no purge recorded, finished or failed), and a share key whose `allowed.buckets` does
 *     not name the bucket (503 `review_storage_unavailable`);
 *   - the assigned reviewer, an admin and a steward each getting one
 *     token per delivery, each asked for with the prefix
 *     `{tenant slug}/{deliveryId}/` read from D1, and the answer's shape;
 *   - a query string on the request changing no prefix;
 *   - no token, key id or secret in anything logged;
 *   - a fetch that rejects before B2 answers, on the account
 *     authorisation or on a download authorisation, answered 503 with
 *     no-store and logged only as `transport`;
 *   - `expires` counted from before the first download authorisation;
 *   - `Cache-Control: no-store` on the answer;
 *   - the account token reused from isolate memory, renewed after its
 *     time, dropped on a 401 and the pass retried once;
 *   - POST answered 405.
 *
 * Every value here is a test value: no real tenant, bucket, key or person.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedFederations,
  DEFAULT_TEST_FEDERATION_ID,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { makeUserContext } from "../helpers/context";
import { insertRow, seedReceivedVolumes, seedTenantDestination, TEST_SECRET_PREFIX } from "../helpers/media-pipeline";
import {
  ACCOUNT_TOKEN_TTL_MS,
  clearReviewAccountCache,
  REVIEW_ACCESS_SECONDS,
  reviewAccessLoader,
  type ReviewAccessDeps,
} from "../../app/lib/capture/review-access.server";
import {
  action as reviewAccessAction,
  loader as reviewAccessRouteLoader,
} from "../../app/routes/_auth.admin.capture.volumes.$volumeId.review-access";
import { tenantContext, userContext, type Tenant, type User } from "../../app/context";

const T0 = 1_800_000_000_000;
const HEX = "a".repeat(64);
const REVIEW_BUCKET = "test-review-tiles";
const REVIEW_BUCKET_ID = "test-review-bucket-id";
const KEY_ID = "test-review-share-key-id";
const SECRET_KEY = "test-review-share-secret";
const API_URL = "https://api000.backblazeb2.test.example";
const DOWNLOAD_URL = "https://f000.backblazeb2.test.example";
const SECRETS = {
  [`${TEST_SECRET_PREFIX}_REVIEW_SHARE_KEY_ID`]: KEY_ID,
  [`${TEST_SECRET_PREFIX}_REVIEW_SHARE_SECRET_KEY`]: SECRET_KEY,
};

type Json = Record<string, any>;

// ---------------------------------------------------------------------------
// A scripted B2
// ---------------------------------------------------------------------------

interface B2Call {
  op: "authorize" | "download";
  url: string;
  authorization: string | null;
  body: Json | null;
}

interface FakeB2 {
  calls: B2Call[];
  /** Statuses to answer the next calls of each kind with, before the default 200. */
  authorizeStatuses: number[];
  downloadStatuses: number[];
  /** The buckets `allowed` names. */
  allowed: Array<{ id: string; name: string | null }>;
  /** Every token the fake has issued. */
  issued: string[];
  /** Calls whose fetch rejects, as a DNS or connection failure does, in order. */
  rejections: Array<"authorize" | "download">;
  /** Runs before each call is answered. */
  onCall: () => void;
  fetch: typeof fetch;
}

function fakeB2(): FakeB2 {
  let n = 0;
  const b2: FakeB2 = {
    calls: [],
    authorizeStatuses: [],
    downloadStatuses: [],
    allowed: [{ id: REVIEW_BUCKET_ID, name: REVIEW_BUCKET }],
    issued: [],
    rejections: [],
    onCall: () => {},
    fetch: async (input, init) => {
      b2.onCall();
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      const body = init?.body ? (JSON.parse(String(init.body)) as Json) : null;
      const error = (status: number) =>
        new Response(JSON.stringify({ status, code: "test_error", message: "Test error body" }), { status });
      if (url === "https://api.backblazeb2.com/b2api/v4/b2_authorize_account") {
        b2.calls.push({ op: "authorize", url, authorization: headers.get("Authorization"), body });
        if (b2.rejections[0] === "authorize") {
          b2.rejections.shift();
          throw new TypeError(`fetch failed: ${url} ${headers.get("Authorization")}`);
        }
        const status = b2.authorizeStatuses.shift() ?? 200;
        if (status !== 200) return error(status);
        n += 1;
        const token = `ACCOUNT-TOKEN-${n}`;
        b2.issued.push(token);
        return Response.json({
          accountId: "test-account",
          authorizationToken: token,
          applicationKeyExpirationTimestamp: null,
          apiInfo: {
            storageApi: {
              apiUrl: API_URL,
              downloadUrl: DOWNLOAD_URL,
              s3ApiUrl: "https://s3.us-west-000.backblazeb2.test.example",
              absoluteMinimumPartSize: 5_000_000,
              recommendedPartSize: 100_000_000,
              allowed: { buckets: b2.allowed, capabilities: ["listFiles", "readFiles", "shareFiles"] },
            },
            groupsApi: { groupsApiUrl: "https://groups.test.example", capabilities: [], infoType: "groupsApi" },
          },
        });
      }
      if (url === `${API_URL}/b2api/v4/b2_get_download_authorization`) {
        b2.calls.push({ op: "download", url, authorization: headers.get("Authorization"), body });
        if (b2.rejections[0] === "download") {
          b2.rejections.shift();
          throw new TypeError(`fetch failed: ${url}?Authorization=${headers.get("Authorization")}`);
        }
        const status = b2.downloadStatuses.shift() ?? 200;
        if (status !== 200) return error(status);
        n += 1;
        const token = `DOWNLOAD-TOKEN-${n}`;
        b2.issued.push(token);
        return Response.json({ bucketId: body!.bucketId, fileNamePrefix: body!.fileNamePrefix, authorizationToken: token });
      }
      throw new Error(`Unexpected fetch in the test: ${url}`);
    },
  };
  return b2;
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

let seq = 0;

async function delivery(
  tenantId: string,
  volumeId: string,
  state: "received" | "registered" | "refused" | "superseded",
): Promise<string> {
  const id = crypto.randomUUID();
  seq += 1;
  await insertRow("capture_deliveries", {
    tenant_id: tenantId,
    id,
    route: "file",
    scanner_id: null,
    reference_code: "co-test",
    pipeline_volume_id: volumeId,
    body_sha256: HEX,
    state,
    problems: "[]",
    answer_status: state === "refused" ? 422 : 200,
    answer_body: "{}",
    records: state === "refused" ? null : "[]",
    openings: 4,
    received_at: T0 + seq,
    superseded_by: state === "superseded" ? "later" : null,
    superseded_at: state === "superseded" ? T0 + seq + 1 : null,
    seq,
    write_id: null,
  });
  return id;
}

/** A review run of a delivery, with its row's status and, when given, a recorded purge. */
async function reviewRun(
  deliveryId: string,
  volumeId: string,
  userId: string,
  opts: { status?: string; purge?: "purged" | "failed" } = {},
): Promise<void> {
  const runId = crypto.randomUUID();
  await insertRow("pipeline_runs", {
    id: runId,
    tenant_id: DEFAULT_TEST_TENANT_ID,
    federation_id: DEFAULT_TEST_FEDERATION_ID,
    user_id: userId,
    kind: "review_run",
    purpose: null,
    regenerates_run_id: null,
    status: "completed",
    runner_image: "ghcr.io/test/runner@sha256:" + HEX,
    script_version: "v1.1.0",
    arch: "x64",
    max_review_frac: 1,
    spec_key: `specs/${runId}.json`,
    spec_sha256: HEX,
    spec_url_expires_at: T0 - 1,
    chunk_count: 1,
    volume_count: 1,
    volumes_reported: 1,
    callback_token_hash: HEX,
    token_expires_at: T0,
    token_revoked_at: T0,
    created_at: T0,
  });
  await insertRow("capture_review_runs", {
    tenant_id: DEFAULT_TEST_TENANT_ID,
    run_id: runId,
    delivery_id: deliveryId,
    pipeline_volume_id: volumeId,
    review_prefix: `co-test/${deliveryId}/`,
    status: opts.status ?? "review_ready",
    reported_at: T0,
    created_at: T0,
    purge_status: opts.purge ?? null,
    purged_at: opts.purge === "purged" ? T0 : null,
  });
}

async function person(opts: { tenantId?: string; isAdmin?: boolean; name?: string } = {}): Promise<User> {
  const row = await createTestUser({ tenantId: opts.tenantId, isAdmin: opts.isAdmin, name: opts.name });
  return makeUserContext({ id: row.id, tenantId: row.tenantId, email: row.email, name: row.name, isAdmin: row.isAdmin });
}

async function tenantRow(id: string): Promise<Tenant> {
  const db = drizzle(env.DB, { schema });
  const row = (await db.select().from(schema.tenants).where(eq(schema.tenants.id, id)).get()) as Tenant;
  return { ...row, digitizationEnabled: true };
}

interface World {
  b2: FakeB2;
  clock: { now: number };
  tenant: Tenant;
  otherTenant: Tenant;
  admin: User;
  reviewer: User;
  outsider: User;
  steward: User;
  /** Two superseded deliveries, then the current one; assigned to `reviewer`. */
  volumeId: string;
  older: string[];
  current: string;
  /** Another volume of the tenant, assigned to `outsider`. */
  otherVolumeId: string;
  /** The second tenant's volume, with a current delivery. */
  foreignVolumeId: string;
}

let world: World;

function deps(overrides: Partial<ReviewAccessDeps> = {}): ReviewAccessDeps {
  return { db: drizzle(env.DB), env: SECRETS, fetch: world.b2.fetch, now: () => world.clock.now, ...overrides };
}

async function access(opts: { user?: User; tenant?: Tenant; volumeId?: string; deps?: Partial<ReviewAccessDeps> } = {}) {
  try {
    const res = await reviewAccessLoader(
      deps(opts.deps),
      opts.volumeId ?? world.volumeId,
      opts.tenant ?? world.tenant,
      opts.user ?? world.reviewer,
    );
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? (JSON.parse(text) as Json) : null };
  } catch (thrown) {
    if (thrown instanceof Response) return { status: thrown.status, headers: thrown.headers, json: null };
    throw thrown;
  }
}

function routeContext(user: User, tenant: Tenant): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, tenant);
  // The real bindings, with the share key's test secrets on top.
  (ctx as any).cloudflare = { env: Object.assign(Object.create(env), SECRETS) };
  return ctx;
}

const prefixOf = (id: string) => `${world.tenant.slug}/${id}/`;

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  clearReviewAccountCache();
  await cleanDatabase();
  await seedFederations();
  await seedTenantDestination(DEFAULT_TEST_TENANT_ID, { pipelineReviewTilesBucket: REVIEW_BUCKET });
  const admin = await person({ isAdmin: true, name: "Test Admin" });
  const reviewer = await person({ name: "Test Reviewer" });
  const outsider = await person({ name: "Test Outsider" });
  const steward = await person({ tenantId: SECOND_TEST_TENANT_ID, name: "Test Steward" });
  await insertRow("federation_memberships", {
    id: crypto.randomUUID(),
    user_id: steward.id,
    federation_id: DEFAULT_TEST_FEDERATION_ID,
    role: "steward",
    created_at: T0,
  });
  const otherAdmin = await person({ tenantId: SECOND_TEST_TENANT_ID, isAdmin: true, name: "Other Admin" });

  const local = await seedReceivedVolumes({ count: 2, codePrefix: "co-test" });
  const [volume, other] = local.volumes;
  const remote = await seedReceivedVolumes({ tenantId: SECOND_TEST_TENANT_ID, count: 1, codePrefix: "co-other" });

  const older = [await delivery(DEFAULT_TEST_TENANT_ID, volume.id, "superseded")];
  await delivery(DEFAULT_TEST_TENANT_ID, volume.id, "refused");
  older.push(await delivery(DEFAULT_TEST_TENANT_ID, volume.id, "superseded"));
  const current = await delivery(DEFAULT_TEST_TENANT_ID, volume.id, "registered");
  const otherCurrent = await delivery(DEFAULT_TEST_TENANT_ID, other.id, "registered");
  await delivery(SECOND_TEST_TENANT_ID, remote.volumes[0].id, "registered");
  // Every delivery's review tiles are ready, until a test says otherwise.
  for (const id of [...older, current]) await reviewRun(id, volume.id, admin.id);
  await reviewRun(otherCurrent, other.id, admin.id);

  for (const [volumeId, reviewerId] of [
    [volume.id, reviewer.id],
    [other.id, outsider.id],
  ]) {
    await insertRow("capture_qc_reviewers", {
      tenant_id: DEFAULT_TEST_TENANT_ID,
      pipeline_volume_id: volumeId,
      reviewer_id: reviewerId,
      assigned_by: admin.id,
      assigned_at: T0,
    });
  }
  await insertRow("capture_qc_reviewers", {
    tenant_id: SECOND_TEST_TENANT_ID,
    pipeline_volume_id: remote.volumes[0].id,
    reviewer_id: otherAdmin.id,
    assigned_by: otherAdmin.id,
    assigned_at: T0,
  });

  world = {
    b2: fakeB2(),
    clock: { now: T0 },
    tenant: await tenantRow(DEFAULT_TEST_TENANT_ID),
    otherTenant: await tenantRow(SECOND_TEST_TENANT_ID),
    admin,
    reviewer,
    outsider,
    steward,
    volumeId: volume.id,
    older,
    current,
    otherVolumeId: other.id,
    foreignVolumeId: remote.volumes[0].id,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("refusals", () => {
  it("answers a bare 404 without the digitization capability, before anything else", async () => {
    const res = await access({ tenant: { ...world.tenant, digitizationEnabled: false } });
    expect(res).toMatchObject({ status: 404, json: null });
    expect(world.b2.calls).toEqual([]);
  });

  it("refuses another tenant's volume as not found", async () => {
    expect((await access({ user: world.admin, volumeId: world.foreignVolumeId })).json).toEqual({ error: "volume_not_found" });
    expect((await access({ user: world.admin, volumeId: "no-such-volume" })).status).toBe(404);
    expect(world.b2.calls).toEqual([]);
  });

  it("refuses with a bare 403 anyone who is neither the reviewer nor a QC manager", async () => {
    expect(await access({ user: world.outsider })).toMatchObject({ status: 403, json: null });
    // The reviewer of one volume is not the reviewer of another.
    expect((await access({ user: world.reviewer, volumeId: world.otherVolumeId })).status).toBe(403);
    expect(world.b2.calls).toEqual([]);
  });

  it("answers 409 no_review_bucket without the bucket or either secret", async () => {
    expect((await access({ deps: { env: {} } })).json).toEqual({ error: "no_review_bucket" });
    const [keyName, secretName] = Object.keys(SECRETS);
    expect((await access({ deps: { env: { [keyName]: KEY_ID } } })).status).toBe(409);
    expect((await access({ deps: { env: { [secretName]: SECRET_KEY } } })).status).toBe(409);
    await seedTenantDestination(DEFAULT_TEST_TENANT_ID, { pipelineReviewTilesBucket: null });
    const res = await access();
    expect(res).toMatchObject({ status: 409, json: { error: "no_review_bucket" } });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(world.b2.calls).toEqual([]);
  });

  it("answers 404 no_review_tiles when no delivery can be read", async () => {
    // Only a refused and a received delivery: neither has tiles.
    const bare = (await seedReceivedVolumes({ count: 1, codePrefix: "co-bare" })).volumes[0];
    await delivery(DEFAULT_TEST_TENANT_ID, bare.id, "refused");
    await delivery(DEFAULT_TEST_TENANT_ID, bare.id, "received");
    expect(await access({ user: world.admin, volumeId: bare.id })).toMatchObject({
      status: 404,
      json: { error: "no_review_tiles" },
    });
    expect(world.b2.calls).toEqual([]);
  });

  it("leaves out a delivery whose tiles are not ready, or whose purge has started", async () => {
    // The first earlier delivery's tiles were purged; the second's purge failed.
    await env.DB.prepare("UPDATE capture_review_runs SET purge_status = 'purged', purged_at = ? WHERE delivery_id = ?")
      .bind(T0, world.older[0])
      .run();
    await env.DB.prepare("UPDATE capture_review_runs SET purge_status = 'failed' WHERE delivery_id = ?").bind(world.older[1]).run();
    const res = await access({ user: world.admin });
    expect(res.status).toBe(200);
    expect(res.json!.deliveries.map((d: Json) => d.deliveryId)).toEqual([world.current]);

    // A delivery whose only review run is still out has nothing to read.
    await env.DB.prepare("UPDATE capture_review_runs SET status = 'dispatched' WHERE delivery_id = ?").bind(world.current).run();
    expect(await access({ user: world.admin })).toMatchObject({ status: 404, json: { error: "no_review_tiles" } });
  });

  it("answers 503 when the share key's allowed buckets do not name the bucket", async () => {
    world.b2.allowed = [{ id: "another-bucket-id", name: "another-bucket" }];
    expect(await access()).toMatchObject({ status: 503, json: { error: "review_storage_unavailable" } });
    expect(world.b2.calls.map((c) => c.op)).toEqual(["authorize"]);
  });

  it("answers 503 when B2 refuses the share key or a download authorisation", async () => {
    world.b2.authorizeStatuses = [403];
    expect((await access()).json).toEqual({ error: "review_storage_unavailable" });
    world.b2.downloadStatuses = [500];
    expect((await access()).json).toEqual({ error: "review_storage_unavailable" });
  });
});

describe("a fetch that fails before B2 answers", () => {
  function capture(): string[] {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
      });
    }
    return lines;
  }

  it("answers 503 with no-store when the account authorisation's fetch rejects", async () => {
    const lines = capture();
    world.b2.rejections = ["authorize"];
    const res = await access();
    expect(res).toMatchObject({ status: 503, json: { error: "review_storage_unavailable" } });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const logged = lines.join("\n");
    expect(logged).toContain(DEFAULT_TEST_FEDERATION_ID);
    expect(logged).toContain("transport");
    for (const secret of [KEY_ID, SECRET_KEY, btoa(`${KEY_ID}:${SECRET_KEY}`), "fetch failed", "backblazeb2"]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("answers 503 with no-store when a download authorisation's fetch rejects, and logs no token", async () => {
    const lines = capture();
    world.b2.rejections = ["download"];
    const res = await access();
    expect(res).toMatchObject({ status: 503, json: { error: "review_storage_unavailable" } });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(world.b2.calls.map((c) => c.op)).toEqual(["authorize", "download"]);
    const logged = lines.join("\n");
    expect(logged).toContain("transport");
    for (const secret of [...world.b2.issued, "fetch failed", "backblazeb2"]) {
      expect(logged).not.toContain(secret);
    }
  });
});

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

describe("tokens", () => {
  for (const who of ["reviewer", "admin", "steward"] as const) {
    it(`gives the ${who} one token per readable delivery, each for a prefix read from D1`, async () => {
      const res = await access({ user: world[who] });
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");

      const [authorize, ...downloads] = world.b2.calls;
      expect(authorize.op).toBe("authorize");
      expect(authorize.authorization).toBe(`Basic ${btoa(`${KEY_ID}:${SECRET_KEY}`)}`);
      const ordered = [...world.older, world.current];
      expect(downloads.map((c) => c.body)).toEqual(
        ordered.map((id) => ({ bucketId: REVIEW_BUCKET_ID, fileNamePrefix: prefixOf(id), validDurationInSeconds: REVIEW_ACCESS_SECONDS })),
      );
      expect(downloads.every((c) => c.authorization === world.b2.issued[0])).toBe(true);

      expect(res.json).toEqual({
        downloadUrl: DOWNLOAD_URL,
        bucket: REVIEW_BUCKET,
        expires: new Date(T0 + REVIEW_ACCESS_SECONDS * 1000).toISOString(),
        deliveries: ordered.map((id, i) => ({
          deliveryId: id,
          prefix: prefixOf(id),
          authorizationToken: world.b2.issued[i + 1],
          current: id === world.current,
        })),
      });
      for (const d of res.json!.deliveries) expect(d.prefix.endsWith("/")).toBe(true);
    });
  }

  it("counts expires from before the first download authorisation, however long the requests take", async () => {
    // Every B2 call takes ten seconds on the fake clock.
    world.b2.onCall = () => {
      world.clock.now += 10_000;
    };
    const res = await access();
    expect(res.status).toBe(200);
    // Authorising the account took the first ten seconds; the first
    // download authorisation was asked for at T0 + 10s.
    expect(res.json!.expires).toBe(new Date(T0 + 10_000 + REVIEW_ACCESS_SECONDS * 1000).toISOString());
    expect(world.clock.now).toBe(T0 + 40_000);
  });

  it("takes no prefix or delivery from the request's query string", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(world.b2.fetch);
    const url =
      `https://neogranadina.fisqua.test/admin/capture/volumes/${world.volumeId}/review-access` +
      `?prefix=second-tenant/&fileNamePrefix=&deliveryId=${world.foreignVolumeId}&bucketId=x`;
    const res = await reviewAccessRouteLoader({
      request: new Request(url),
      context: routeContext(world.reviewer, world.tenant),
      params: { volumeId: world.volumeId },
    } as any);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const ordered = [...world.older, world.current];
    expect(world.b2.calls.filter((c) => c.op === "download").map((c) => c.body!.fileNamePrefix)).toEqual(ordered.map(prefixOf));
    expect(((await res.json()) as Json).deliveries.map((d: Json) => d.prefix)).toEqual(ordered.map(prefixOf));
  });

  it("logs no token, key id or secret", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
    expect((await access()).status).toBe(200);
    world.b2.downloadStatuses = [500];
    expect((await access()).status).toBe(503);
    expect(lines.length).toBeGreaterThan(0);
    const logged = lines.join("\n");
    expect(logged).toContain(DEFAULT_TEST_FEDERATION_ID);
    for (const secret of [...world.b2.issued, KEY_ID, SECRET_KEY, "Test error body"]) {
      expect(logged).not.toContain(secret);
    }
  });
});

// ---------------------------------------------------------------------------
// The account token's cache
// ---------------------------------------------------------------------------

describe("the account token", () => {
  const ops = () => world.b2.calls.map((c) => c.op);

  it("is reused from memory, and renewed once its time has passed", async () => {
    expect((await access()).status).toBe(200);
    expect((await access({ user: world.admin })).status).toBe(200);
    expect(ops().filter((o) => o === "authorize")).toHaveLength(1);
    const downloads = world.b2.calls.filter((c) => c.op === "download");
    expect(downloads.every((c) => c.authorization === "ACCOUNT-TOKEN-1")).toBe(true);
    // Download tokens are not cached: the second request asked for new ones.
    expect(downloads).toHaveLength(6);

    world.clock.now = T0 + ACCOUNT_TOKEN_TTL_MS;
    expect((await access()).status).toBe(200);
    expect(ops().filter((o) => o === "authorize")).toHaveLength(2);
  });

  it("is dropped on a 401, and the request retried once", async () => {
    expect((await access()).status).toBe(200);
    world.b2.calls.length = 0;
    world.b2.downloadStatuses = [200, 401];
    const res = await access();
    expect(res.status).toBe(200);
    expect(ops()).toEqual(["download", "download", "authorize", "download", "download", "download"]);
    const fresh = world.b2.calls[2];
    expect(world.b2.calls.slice(3).every((c) => c.authorization !== "ACCOUNT-TOKEN-1")).toBe(true);
    expect(fresh.op).toBe("authorize");
    expect(res.json!.deliveries).toHaveLength(3);
  });

  it("is retried only once: a second 401 answers 503 and leaves nothing cached", async () => {
    world.b2.downloadStatuses = [401, 401];
    expect((await access()).json).toEqual({ error: "review_storage_unavailable" });
    expect(ops()).toEqual(["authorize", "download", "authorize", "download"]);
    world.b2.calls.length = 0;
    expect((await access()).status).toBe(200);
    expect(ops()[0]).toBe("authorize");
  });
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

describe("the route", () => {
  it("answers POST with 405", async () => {
    const res = await reviewAccessAction();
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });
});

// @version v0.8.0
