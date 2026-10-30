/**
 * Tests — the capture link's manifest delivery and volume status
 *
 * This suite drives the two calls a Captua unit makes over the direct
 * link of the Captua exchange contract through `handleManifestDelivery`
 * and `handleVolumeStatus`, with constructed requests on tenant hosts,
 * the test D1 database, an in-memory S3 server standing in for the
 * federation's masters bucket, and a clock the tests set. It pins:
 *
 *   - authentication: no token and an unknown token are 401, a revoked
 *     token and another tenant's token are 403, an unknown host is 404,
 *     and an authenticated call records when the scanner was last seen;
 *   - the contract's delivery answers: 200 with the state, manifest id
 *     and volume id, the volume and its pages registered from the
 *     manifest; 400 for a body that is not JSON (not recorded) or not a manifest
 *     (recorded); 413 past the size limit; 422 for each content check,
 *     with its rule, a named object missing from the bucket (a RAW capture
 *     included) and a `rotateDeg` other than 0, 90, 180 or 270
 *     (`rotate-deg`) among them; each image's `rotateDeg` kept as given,
 *     null where the manifest gives none or null; any version `1.N`
 *     from 1.1 accepted, and 1.0, another major or a malformed version
 *     refused as `version`; 409 `id-reused` and `run-started`; 503, not
 *     recorded, when the masters bucket cannot be listed;
 *   - idempotency: the same id with the same body, whatever its key
 *     order and spacing, gets the first answer verbatim, even after the
 *     volume moved on; with a different body it is `id-reused`;
 *   - supersede: a newer manifest before any run replaces the page list
 *     and supersedes the older delivery; after a run has started it is
 *     refused, and a refused manifest holds nothing, so a later one with
 *     a new id is accepted;
 *   - status: one entry per ref, `unknown` for one Fisqua holds nothing
 *     for, the states as the pipeline moves the volume, the accepted
 *     manifest reported over a later refused one (whose problems it
 *     carries, naming that manifest), 1 to 100 refs;
 *   - the rate limit: 60 calls a minute per token, then 429 with
 *     `Retry-After`, and a fresh window after the minute turns;
 *   - the routes answer without a session and with no redirect.
 *
 * Every value here is a test value: no real tenant, bucket, key or digest.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { createHash } from "node:crypto";
import {
  applyMigrations,
  cleanDatabase,
  seedFederations,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestDescription } from "../helpers/descriptions";
import { createTestRepository } from "../helpers/repositories";
import { createTestUser } from "../helpers/auth";
import { fakeS3, type FakeS3 } from "../helpers/fake-s3";
import {
  insertRow,
  seedDeclaration,
  seedTenantDestination,
  TEST_MASTERS_BUCKET,
  TEST_SECRET_PREFIX,
} from "../helpers/media-pipeline";
import {
  handleManifestDelivery,
  handleVolumeStatus,
  MAX_MANIFEST_BYTES,
  packJson,
  STATUS_BUDGET_BYTES,
  unpackJson,
  type CaptureLinkDeps,
} from "../../app/lib/capture/link.server";
import { mintScannerToken } from "../../app/lib/capture/token";
import { action as manifestAction, loader as manifestLoader } from "../../app/routes/api.capture.v1.manifests";
import { loader as statusLoader } from "../../app/routes/api.capture.v1.volumes.status";

const HOST = "https://neogranadina.fisqua.test";
const OTHER_HOST = "https://second-tenant.fisqua.test";
const SLUG = "neogranadina";
const ROOT = `${SLUG}/`;
const T0 = 1_800_000_000_000;

type Json = Record<string, any>;

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

const digest = (label: string) => createHash("sha256").update(label).digest("hex");
const pad = (n: number) => String(n).padStart(4, "0");

function image(stem: string, n: number, c: number, role: string, opts: { jpegOnly?: boolean } = {}): Json {
  const base = `${stem}-img_${pad(n)}_c${c}`;
  const filename = `${base}.${opts.jpegOnly ? "jpg" : "cr3"}`;
  return {
    captureId: `cap-${base}`,
    pairId: role === "single" ? null : `pair-${stem}-${n}`,
    filename,
    role,
    objectKey: `${stem}/captures/${filename}`,
    sha256: digest(`capture ${base}`),
    ...(opts.jpegOnly
      ? {}
      : { previewObjectKey: `${stem}/previews/${base}_preview.jpg`, previewSha256: digest(`preview ${base}`) }),
  };
}

function rec(id: number, sequence: number, status: string, images: Json[]): Json {
  return { captuaRecordId: id, sequence, status, rejectionNote: status === "rejected" ? "blurred" : null, images };
}

/** A spread (sequence 2), a single (sequence 1), a rejected spread, a JPEG-only retake. */
function volume(code: string | null, stem = code ?? "co-test-orphan"): Json {
  return {
    externalId: code,
    captuaCollectionId: 7,
    stem,
    title: `Test volume ${stem}`,
    records: [
      rec(12, 2, "approved", [image(stem, 2, 1, "right"), image(stem, 2, 0, "left")]),
      rec(11, 1, "in_review", [image(stem, 1, 0, "single")]),
      rec(13, 3, "rejected", [image(stem, 3, 0, "left"), image(stem, 3, 1, "right")]),
      rec(14, 4, "approved", [image(stem, 5, 0, "single", { jpegOnly: true })]),
    ],
  };
}

function manifest(volumes: Json[], overrides: Json = {}): Json {
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
    volumes,
    ...overrides,
  };
}

/** Puts every object a manifest names into the fake masters bucket, 1000 bytes each. */
function upload(s3: FakeS3, m: Json, except: string[] = []): void {
  for (const v of m.volumes) {
    for (const r of v.records) {
      for (const img of r.images) {
        for (const key of [img.objectKey, img.previewObjectKey].filter(Boolean)) {
          const full = `${ROOT}${key}`;
          if (except.includes(full)) continue;
          s3.objects.set(`${TEST_MASTERS_BUCKET}/${full}`, {
            bytes: new Uint8Array(1000),
            etag: "e",
            contentType: null,
            meta: {},
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

const LIST_SECRETS = {
  [`${TEST_SECRET_PREFIX}_MASTERS_LIST_KEY_ID`]: "test-masters-list-key-id",
  [`${TEST_SECRET_PREFIX}_MASTERS_LIST_SECRET_KEY`]: "test-masters-list-secret",
};

interface World {
  deps: CaptureLinkDeps;
  s3: FakeS3;
  clock: { now: number };
  token: string;
  scannerId: string;
  repositoryId: string;
}

let world: World;

async function seedScanner(tenantId: string, opts: { revoked?: boolean; name?: string } = {}) {
  const { token, sha256 } = await mintScannerToken();
  const id = crypto.randomUUID();
  await insertRow("capture_scanners", {
    id,
    tenant_id: tenantId,
    name: opts.name ?? "rig-1",
    token_sha256: sha256,
    token_created_at: T0,
    revoked_at: opts.revoked ? T0 : null,
    created_at: T0,
    updated_at: T0,
  });
  return { id, token };
}

async function describe_(code: string, tenantId = DEFAULT_TEST_TENANT_ID) {
  return createTestDescription({
    tenantId,
    repositoryId: world.repositoryId,
    descriptionLevel: "volume",
    referenceCode: code,
  });
}

function deps(overrides: Partial<CaptureLinkDeps> = {}): CaptureLinkDeps {
  return { ...world.deps, ...overrides };
}

interface Answer {
  status: number;
  text: string;
  json: Json | null;
  headers: Headers;
}

async function answer(res: Response): Promise<Answer> {
  const text = await res.text();
  let json: Json | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json, headers: res.headers };
}

async function deliver(
  body: Json | string,
  opts: { token?: string | null; host?: string; deps?: Partial<CaptureLinkDeps> } = {},
): Promise<Answer> {
  const token = opts.token === undefined ? world.token : opts.token;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const request = new Request(`${opts.host ?? HOST}/api/capture/v1/manifests`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return answer(await handleManifestDelivery(deps(opts.deps), request));
}

async function status(refs: string[] | string, opts: { token?: string | null } = {}): Promise<Answer> {
  const token = opts.token === undefined ? world.token : opts.token;
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const q = typeof refs === "string" ? refs : refs.join(",");
  const request = new Request(`${HOST}/api/capture/v1/volumes/status?refs=${encodeURIComponent(q)}`, { headers });
  return answer(await handleVolumeStatus(deps(), request));
}

const sqlRows = async (query: string, ...binds: unknown[]) =>
  (await env.DB.prepare(query).bind(...binds).all()).results as Array<Record<string, any>>;

const pagesOf = (volumeId: string) =>
  sqlRows(
    "SELECT seq, page_key, master_key, sha256, tenant_id FROM pipeline_volume_pages WHERE pipeline_volume_id = ? ORDER BY seq",
    volumeId,
  );

const deliveryOf = async (id: string) =>
  (await sqlRows("SELECT * FROM capture_deliveries WHERE id = ?", id))[0];

/** Puts a pipeline run on a volume: open and holding it unless `closed`, its run volume `status`. */
async function runOn(volumeId: string, opts: { status?: string; chunk?: string; closed?: boolean; error?: Json } = {}) {
  const user = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID });
  const scope = await createTestDescription({ repositoryId: world.repositoryId, descriptionLevel: "fonds" });
  const declaration = await seedDeclaration({ scopeDescriptionId: scope.id, createdBy: user.id });
  const runId = crypto.randomUUID();
  const now = world.clock.now;
  await insertRow("pipeline_runs", {
    id: runId,
    tenant_id: DEFAULT_TEST_TENANT_ID,
    user_id: user.id,
    kind: "volume_run",
    purpose: "sample",
    status: opts.closed ? "error" : "dispatched",
    runner_image: "ghcr.io/example/runner@sha256:" + "0".repeat(64),
    script_version: "v1.0.0",
    arch: "x64",
    max_review_frac: 1,
    spec_key: `${DEFAULT_TEST_TENANT_ID}/pipeline-runs/${runId}/spec.json`,
    spec_sha256: "0".repeat(64),
    spec_url_expires_at: now + 1_000_000,
    chunk_count: 1,
    volume_count: 1,
    callback_token_hash: "0".repeat(64),
    token_expires_at: now + 3_600_000,
    token_revoked_at: opts.closed ? now : null,
    completed_at: opts.closed ? now : null,
    created_at: now,
    dispatched_at: now,
  });
  await insertRow("pipeline_run_chunks", {
    id: crypto.randomUUID(),
    run_id: runId,
    tenant_id: DEFAULT_TEST_TENANT_ID,
    chunk_index: 0,
    status: opts.chunk ?? "dispatched",
    dispatched_at: opts.chunk === "pending" ? null : now,
    created_at: now,
  });
  await insertRow("pipeline_run_volumes", {
    id: crypto.randomUUID(),
    run_id: runId,
    tenant_id: DEFAULT_TEST_TENANT_ID,
    pipeline_volume_id: volumeId,
    declaration_id: declaration.id,
    job_index: 0,
    chunk_index: 0,
    reference_code: "x",
    tile_root: "x",
    expected_count: 1,
    resolved_recipe: "{}",
    status: opts.status ?? "dispatched",
    error: opts.error ? JSON.stringify(opts.error) : null,
    reported_at: opts.status && opts.status !== "dispatched" ? now : null,
    flags_truncated: 0,
    created_at: now,
  });
  if (!opts.closed) {
    await env.DB.prepare("UPDATE pipeline_volumes SET held_by_run_id = ? WHERE id = ?").bind(runId, volumeId).run();
  }
  return runId;
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDatabase();
  await seedFederations();
  await seedTenantDestination();
  const repo = await createTestRepository({ tenantId: DEFAULT_TEST_TENANT_ID, code: `repo-${crypto.randomUUID().slice(0, 6)}` });
  const s3 = fakeS3([TEST_MASTERS_BUCKET]);
  const clock = { now: T0 };
  const scanner = await seedScanner(DEFAULT_TEST_TENANT_ID);
  world = {
    deps: {
      db: drizzle(env.DB),
      env: LIST_SECRETS,
      fetch: s3.fetch,
      now: () => clock.now,
      newId: () => crypto.randomUUID(),
    },
    s3,
    clock,
    token: scanner.token,
    scannerId: scanner.id,
    repositoryId: repo.id,
  };
  await describe_("co-test-001");
  await describe_("co-test-002");
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe("authentication", () => {
  it("answers 401 with no token, a malformed one, or one no scanner holds", async () => {
    const m = manifest([volume("co-test-001")]);
    expect((await deliver(m, { token: null })).status).toBe(401);
    expect((await deliver(m, { token: "not-a-token" })).status).toBe(401);
    expect((await deliver(m, { token: "A".repeat(64) })).status).toBe(401);
    expect((await deliver(m, { token: (await mintScannerToken()).token })).status).toBe(401);
    expect((await status(["co-test-001"], { token: null })).status).toBe(401);
  });

  it("answers 403 to a revoked token and to another tenant's token", async () => {
    const m = manifest([volume("co-test-001")]);
    const other = await seedScanner(SECOND_TEST_TENANT_ID, { name: "rig-2" });
    expect((await deliver(m, { token: other.token })).status).toBe(403);
    expect((await deliver(m, { host: OTHER_HOST })).status).toBe(403);
    await env.DB.prepare("UPDATE capture_scanners SET revoked_at = ? WHERE id = ?").bind(T0, world.scannerId).run();
    expect((await deliver(m)).status).toBe(403);
    expect((await status(["co-test-001"])).status).toBe(403);
    expect(await sqlRows("SELECT * FROM capture_deliveries")).toEqual([]);
  });

  it("answers 404 on a host that is no tenant's", async () => {
    expect((await deliver(manifest([volume("co-test-001")]), { host: "https://nobody.fisqua.test" })).status).toBe(404);
  });

  it("records when the scanner was last seen", async () => {
    world.clock.now = T0 + 5000;
    await status(["co-test-001"]);
    const [row] = await sqlRows("SELECT last_seen_at FROM capture_scanners WHERE id = ?", world.scannerId);
    expect(row.last_seen_at).toBe(T0 + 5000);
  });
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

describe("delivering a manifest", () => {
  it("registers the volume and its pages and answers 200", async () => {
    const m = manifest([volume("co-test-001")]);
    upload(world.s3, m);
    const a = await deliver(m);
    expect(a.status).toBe(200);
    expect(a.json).toEqual({ state: "registered", manifestId: m.id, volumeId: expect.any(String) });
    const [vol] = await sqlRows("SELECT * FROM pipeline_volumes WHERE id = ?", a.json!.volumeId);
    expect(vol).toMatchObject({
      tenant_id: DEFAULT_TEST_TENANT_ID,
      reference_code: "co-test-001",
      state: "received",
      kind: "volume_run",
      masters_bucket: TEST_MASTERS_BUCKET,
      masters_prefix: "neogranadina/co-test-001/",
      expected_count: 4,
    });
    const pages = await pagesOf(a.json!.volumeId);
    expect(pages.map((p) => [p.seq, p.page_key, p.master_key])).toEqual([
      [1, "co-test-001-img_0001_c0", "neogranadina/co-test-001/previews/co-test-001-img_0001_c0_preview.jpg"],
      [2, "co-test-001-img_0002_c0", "neogranadina/co-test-001/previews/co-test-001-img_0002_c0_preview.jpg"],
      [3, "co-test-001-img_0002_c1", "neogranadina/co-test-001/previews/co-test-001-img_0002_c1_preview.jpg"],
      [4, "co-test-001-img_0005_c0", "neogranadina/co-test-001/captures/co-test-001-img_0005_c0.jpg"],
    ]);
    expect(pages[0].sha256).toBe(digest("preview co-test-001-img_0001_c0"));
    expect(pages[3].sha256).toBe(digest("capture co-test-001-img_0005_c0"));
    expect(pages.every((p) => p.tenant_id === DEFAULT_TEST_TENANT_ID)).toBe(true);
    const row = await deliveryOf(m.id);
    expect(row).toMatchObject({ state: "registered", answer_status: 200, reference_code: "co-test-001", scanner_id: world.scannerId });
    expect(JSON.parse(row.records).map((r: Json) => r.captuaRecordId)).toEqual([12, 11, 13, 14]);
    expect(JSON.parse(row.problems)).toEqual([]);
    // The listing was signed with the list key.
    expect(world.s3.requests.every((r) => r.keyId === "test-masters-list-key-id")).toBe(true);
  });

  it("keeps every object each image names, RAW captures included, with digests and sizes", async () => {
    const m = manifest([volume("co-test-001")]);
    upload(world.s3, m);
    const a = await deliver(m);
    expect(a.status).toBe(200);
    const rows = await sqlRows(
      "SELECT * FROM capture_images WHERE tenant_id = ? AND delivery_id = ? ORDER BY capture_id",
      DEFAULT_TEST_TENANT_ID,
      m.id,
    );
    // Every image of every record, the rejected opening's included.
    expect(rows).toHaveLength(6);
    const raw = rows.find((r) => r.capture_id === "cap-co-test-001-img_0002_c1")!;
    expect(raw).toMatchObject({
      captua_record_id: 12,
      role: "right",
      pair_id: "pair-co-test-001-2",
      page_key: "co-test-001-img_0002_c1",
      capture_key: "neogranadina/co-test-001/captures/co-test-001-img_0002_c1.cr3",
      capture_sha256: digest("capture co-test-001-img_0002_c1"),
      capture_bytes: 1000,
      preview_key: "neogranadina/co-test-001/previews/co-test-001-img_0002_c1_preview.jpg",
      preview_sha256: digest("preview co-test-001-img_0002_c1"),
      preview_bytes: 1000,
    });
    const jpeg = rows.find((r) => r.capture_id === "cap-co-test-001-img_0005_c0")!;
    expect(jpeg).toMatchObject({ preview_key: null, preview_sha256: null, preview_bytes: null, capture_bytes: 1000 });
    expect(JSON.parse((await deliveryOf(m.id)).records)[0]).toEqual({
      captuaRecordId: 12,
      sequence: 2,
      status: "approved",
      rejectionNote: null,
    });
  });

  it("keeps each image's rotateDeg as the manifest gives it, 0 included, and null where it gives none or null", async () => {
    const m = manifest([volume("co-test-001")]);
    m.volumes[0].records[0].images[0].rotateDeg = 90; // record 12, right
    m.volumes[0].records[0].images[1].rotateDeg = 0; // record 12, left
    m.volumes[0].records[1].images[0].rotateDeg = 270; // record 11, single
    m.volumes[0].records[2].images[0].rotateDeg = 180; // record 13, rejected
    m.volumes[0].records[2].images[1].rotateDeg = null; // record 13, read as absent
    upload(world.s3, m);
    const a = await deliver(m);
    expect(a.status).toBe(200);
    const rows = await sqlRows(
      "SELECT capture_id, rotate_deg FROM capture_images WHERE tenant_id = ? AND delivery_id = ? ORDER BY capture_id",
      DEFAULT_TEST_TENANT_ID,
      m.id,
    );
    expect(rows).toEqual([
      { capture_id: "cap-co-test-001-img_0001_c0", rotate_deg: 270 },
      { capture_id: "cap-co-test-001-img_0002_c0", rotate_deg: 0 },
      { capture_id: "cap-co-test-001-img_0002_c1", rotate_deg: 90 },
      { capture_id: "cap-co-test-001-img_0003_c0", rotate_deg: 180 },
      { capture_id: "cap-co-test-001-img_0003_c1", rotate_deg: null },
      { capture_id: "cap-co-test-001-img_0005_c0", rotate_deg: null },
    ]);
  });

  it.each([45, -90, 360, 90.5, "90", true])("refuses 422 rotate-deg an image whose rotateDeg is %j", async (value) => {
    const m = manifest([volume("co-test-001")]);
    m.volumes[0].records[1].images[0].rotateDeg = value;
    upload(world.s3, m);
    const a = await deliver(m);
    expect(a.status).toBe(422);
    expect(a.json!.problems).toEqual([
      expect.objectContaining({
        rule: "rotate-deg",
        stem: "co-test-001",
        captuaRecordId: 11,
        captureId: "cap-co-test-001-img_0001_c0",
        role: "single",
      }),
    ]);
    expect(await deliveryOf(m.id)).toMatchObject({ state: "refused", answer_status: 422, pipeline_volume_id: null });
    expect(await sqlRows("SELECT * FROM capture_images")).toEqual([]);
  });

  it("registers a volume of more pages than one insert takes", async () => {
    const stem = "co-test-002";
    const records = Array.from({ length: 300 }, (_, i) =>
      rec(100 + i, i + 1, "approved", [image(stem, i + 1, 0, "left"), image(stem, i + 1, 1, "right")]),
    );
    const m = manifest([{ ...volume("co-test-002"), records }]);
    upload(world.s3, m);
    const a = await deliver(m);
    expect(a.status).toBe(200);
    const pages = await pagesOf(a.json!.volumeId);
    expect(pages).toHaveLength(600);
    expect(pages[599].page_key).toBe("co-test-002-img_0300_c1");
  });

  it("follows the masters listing across pages", async () => {
    const s3 = fakeS3([TEST_MASTERS_BUCKET], { listPageSize: 2 });
    const m = manifest([volume("co-test-001")]);
    upload(s3, m);
    const a = await deliver(m, { deps: { fetch: s3.fetch } });
    expect(a.status).toBe(200);
    expect(s3.requests.length).toBeGreaterThan(3);
  });

  it("keeps objects the manifest does not name as the delivery's problems, refusing nothing", async () => {
    const m = manifest([volume("co-test-001")]);
    upload(world.s3, m);
    world.s3.objects.set(`${TEST_MASTERS_BUCKET}/neogranadina/co-test-001/captures/stray.cr3`, {
      bytes: new Uint8Array(5),
      etag: "e",
      contentType: null,
      meta: {},
    });
    const a = await deliver(m);
    expect(a.status).toBe(200);
    const problems = JSON.parse((await deliveryOf(m.id)).problems);
    expect(problems.map((p: Json) => [p.rule, p.objectKey])).toEqual([
      ["unlisted-object", "neogranadina/co-test-001/captures/stray.cr3"],
    ]);
    const s = await status(["co-test-001"]);
    expect(s.json!.volumes[0].problems).toHaveLength(1);
  });

  it("refuses 422 a manifest naming a RAW capture that is not in the bucket, though its preview is", async () => {
    const m = manifest([volume("co-test-001")]);
    const raw = "neogranadina/co-test-001/captures/co-test-001-img_0001_c0.cr3";
    const rejectedRaw = "neogranadina/co-test-001/captures/co-test-001-img_0003_c1.cr3";
    upload(world.s3, m, [raw, rejectedRaw]);
    const a = await deliver(m);
    expect(a.status).toBe(422);
    // Exactly the shape agreed with Captua; the key as the manifest writes it.
    expect(a.json!.problems).toEqual([
      {
        rule: "object-missing",
        message: "The capture co-test-001/captures/co-test-001-img_0001_c0.cr3 is named by the manifest and is not in the masters bucket",
        objectKey: "co-test-001/captures/co-test-001-img_0001_c0.cr3",
        captureId: "cap-co-test-001-img_0001_c0",
        role: "single",
        kind: "capture",
      },
      {
        rule: "object-missing",
        message: "The capture co-test-001/captures/co-test-001-img_0003_c1.cr3 is named by the manifest and is not in the masters bucket",
        objectKey: "co-test-001/captures/co-test-001-img_0003_c1.cr3",
        captureId: "cap-co-test-001-img_0003_c1",
        role: "right",
        kind: "capture",
      },
    ]);
    expect(await deliveryOf(m.id)).toMatchObject({ state: "refused", answer_status: 422 });
    expect(await sqlRows("SELECT * FROM pipeline_volumes")).toEqual([]);
  });

  it("answers 400 to a body that is not JSON or not an object, recording nothing", async () => {
    const a = await deliver("{not json");
    expect(a.status).toBe(400);
    expect(a.json!.problems[0].rule).toBe("malformed");
    expect((await deliver("[1, 2]")).status).toBe(400);
    const noId = manifest([volume("co-test-001")], { id: "../escape" });
    expect((await deliver(noId)).json!.problems[0]).toMatchObject({ rule: "shape", path: "id" });
    expect(await sqlRows("SELECT * FROM capture_deliveries")).toEqual([]);
  });

  it("answers 400 with problems to a manifest of the wrong shape, and records it", async () => {
    const m = manifest([volume("co-test-001")], { version: "2.0" });
    m.volumes[0].records[0].images[0].sha256 = "ABC";
    const a = await deliver(m);
    expect(a.status).toBe(400);
    expect(a.json!.problems.map((p: Json) => p.rule).sort()).toEqual(["shape", "version"]);
    expect(await deliveryOf(m.id)).toMatchObject({ state: "refused", answer_status: 400 });
    // Accepted for 1.2, which left the manifest unchanged.
    const v12 = manifest([volume("co-test-001")], { version: "1.2" });
    upload(world.s3, v12);
    expect((await deliver(v12)).status).toBe(200);
  });

  it("accepts any minor version of major 1 from 1.1, and refuses 1.0, another major and a malformed version", async () => {
    for (const version of ["1.5", "1.10"]) {
      const m = manifest([volume("co-test-001")], { version });
      upload(world.s3, m);
      expect((await deliver(m)).status, version).toBe(200);
    }
    for (const version of ["1.0", "2.0", "2.1", "1", "1.5.0", "1.05", "v1.5", " 1.5"]) {
      const a = await deliver(manifest([volume("co-test-001")], { version }));
      expect(a.status, version).toBe(400);
      expect(a.json!.problems, version).toEqual([expect.objectContaining({ rule: "version", path: "version" })]);
    }
  });

  it("refuses 422 volume-count a body of 20,000 empty volumes before checking any of them", async () => {
    const m = manifest([]);
    const body = JSON.stringify(m).replace('"volumes":[]', `"volumes":[${Array(20_000).fill("{}").join(",")}]`);
    expect(body.length).toBeLessThan(70_000);
    const a = await deliver(body);
    expect(a.status).toBe(422);
    expect(a.json!.problems).toEqual([
      {
        rule: "volume-count",
        message: "A manifest delivered over the link names one volume; this one names 20000",
        count: 20000,
      },
    ]);
  });

  it("answers a bounded 400 to a volume of 200,000 empty records", async () => {
    const m = manifest([{ ...volume("co-test-001"), records: [] }]);
    const body = JSON.stringify(m).replace('"records":[]', `"records":[${Array(200_000).fill("{}").join(",")}]`);
    const a = await deliver(body);
    expect(a.status).toBe(400);
    const problems = a.json!.problems as Json[];
    expect(problems).toHaveLength(101);
    expect(problems[0]).toMatchObject({ rule: "shape", path: "volumes.0.records.0.captuaRecordId" });
    // Five fields missing from each record: 1,000,000 problems, 100 listed.
    expect(problems[100]).toEqual({ rule: "problems-truncated", message: expect.any(String), omitted: 999_900 });
    expect(a.text.length).toBeLessThan(20_000);
  });

  it("refuses 400 a body of 1,500,000 empty objects before parsing it, recording nothing", async () => {
    const m = manifest([volume("co-test-001")], { unknownField: "MANY" });
    const body = JSON.stringify(m).replace('"MANY"', `[${Array(1_500_000).fill("{}").join(",")}]`);
    expect(body.length).toBeGreaterThan(4_400_000);
    const a = await deliver(body);
    expect(a.status).toBe(400);
    expect(a.json!.problems).toEqual([
      expect.objectContaining({ rule: "shape", path: "(root)", message: expect.stringMatching(/objects and arrays/) }),
    ]);
    expect(await sqlRows("SELECT * FROM capture_deliveries")).toEqual([]);
  });

  it("registers a manifest nested exactly 64 levels deep in an unknown field", async () => {
    // The body's object and 63 arrays: 64 levels, the scalar adding none.
    const m = manifest([volume("co-test-001")], { unknownField: "AT" });
    upload(world.s3, m);
    const a = await deliver(JSON.stringify(m).replace('"AT"', "[".repeat(63) + "1" + "]".repeat(63)));
    expect(a.status).toBe(200);
    const b = manifest([volume("co-test-002")], { unknownField: "PAST" });
    expect((await deliver(JSON.stringify(b).replace('"PAST"', "[".repeat(64) + "1" + "]".repeat(64)))).status).toBe(400);
  });

  it("answers 400 to a body nested past 64 levels, recording nothing, and leaves a valid manifest alone", async () => {
    // Written as text, as a unit would send it: about 20 KB of brackets.
    const m = manifest([volume("co-test-001")], { unknownField: "DEEP" });
    upload(world.s3, m);
    const a = await deliver(JSON.stringify(m).replace('"DEEP"', "[".repeat(10_000) + "]".repeat(10_000)));
    expect(a.status).toBe(400);
    expect(a.json!.problems).toEqual([expect.objectContaining({ rule: "shape", path: "(root)" })]);
    expect(await sqlRows("SELECT * FROM capture_deliveries")).toEqual([]);
    // Nesting within the limit in an unknown field is ignored as before.
    let shallow: unknown = [];
    for (let i = 0; i < 50; i++) shallow = [shallow];
    const ok = manifest([volume("co-test-001")], { unknownField: shallow });
    expect((await deliver(ok)).status).toBe(200);
  });

  it("answers 413 past the size limit", async () => {
    const m = manifest([volume("co-test-001")], { padding: "x".repeat(MAX_MANIFEST_BYTES) });
    const a = await deliver(m);
    expect(a.status).toBe(413);
    expect(await sqlRows("SELECT * FROM capture_deliveries")).toEqual([]);
  });

  const UNPROCESSABLE: Array<[string, () => Json, string]> = [
    ["no reference code", () => manifest([volume(null)]), "reference-code"],
    ["a reference code that is no description of the tenant", () => manifest([volume("co-test-999")]), "description"],
    ["two volumes", () => manifest([volume("co-test-001"), volume("co-test-002")]), "volume-count"],
    ["another transfer root", () => manifest([volume("co-test-001")], { transfer: { channel: "upload", root: "other/" } }), "transfer-root"],
    [
      "a record still captured",
      () => {
        const v = volume("co-test-001");
        v.records[1].status = "captured";
        return manifest([v]);
      },
      "not-handed-over",
    ],
    [
      "a record of two left images",
      () => {
        const v = volume("co-test-001");
        v.records[0].images[0].role = "left";
        return manifest([v]);
      },
      "roles",
    ],
    [
      "a key outside the volume's prefix",
      () => {
        const v = volume("co-test-001");
        v.records[3].images[0].objectKey = "co-test-999/captures/co-test-001-img_0005_c0.jpg";
        return manifest([v]);
      },
      "capture-key",
    ],
    [
      "a JPEG filename over a RAW capture key",
      () => {
        const v = volume("co-test-001");
        const img = v.records[3].images[0]; // JPEG-only, no preview
        img.objectKey = "co-test-001/captures/co-test-001-img_0005_c0.cr3";
        return manifest([v]);
      },
      "capture-key",
    ],
    [
      "a RAW capture standing as its own preview",
      () => {
        const v = volume("co-test-001");
        const img = v.records[1].images[0];
        img.previewObjectKey = img.objectKey;
        img.previewSha256 = img.sha256;
        return manifest([v]);
      },
      "preview-key",
    ],
  ];

  it.each(UNPROCESSABLE)("answers 422 to %s, with its rule", async (_name, make, rule) => {
    const m = make();
    upload(world.s3, m);
    const a = await deliver(m);
    expect(a.status).toBe(422);
    expect(a.json!.problems.map((p: Json) => p.rule)).toContain(rule);
    expect(await deliveryOf(m.id)).toMatchObject({ state: "refused", answer_status: 422, pipeline_volume_id: null });
    expect(await sqlRows("SELECT * FROM pipeline_volumes")).toEqual([]);
  });

  it("refuses 422 a RAW capture with no preview, never taking the RAW as a page", async () => {
    const m = manifest([volume("co-test-001")]);
    delete m.volumes[0].records[1].images[0].previewObjectKey;
    delete m.volumes[0].records[1].images[0].previewSha256;
    upload(world.s3, m);
    const a = await deliver(m);
    expect(a.status).toBe(422);
    expect(a.json!.problems).toEqual([
      expect.objectContaining({
        rule: "preview-missing",
        objectKey: "co-test-001/captures/co-test-001-img_0001_c0.cr3",
        captureId: "cap-co-test-001-img_0001_c0",
        role: "single",
      }),
    ]);
    expect(await sqlRows("SELECT * FROM pipeline_volume_pages")).toEqual([]);
  });

  it("stores a refusal of thousands of problems once, compressed, under D1's row limit, and replays it byte for byte", async () => {
    const stem = "co-test-002";
    const records = Array.from({ length: 4000 }, (_, i) =>
      rec(1000 + i, i + 1, "approved", [image(stem, i + 1, 0, "single", { jpegOnly: true })]),
    );
    const m = manifest([{ ...volume("co-test-002"), records }]);
    const first = await deliver(m); // nothing uploaded: 4,000 objects missing
    expect(first.status).toBe(422);
    expect(first.json!.problems).toHaveLength(4000);
    expect(first.text.length).toBeGreaterThan(1_000_000);
    const [row] = await sqlRows(
      "SELECT answer_body, problems, length(answer_body) + length(problems) + length(coalesce(records, '')) + 500 AS bytes " +
        "FROM capture_deliveries WHERE id = ?",
      m.id,
    );
    expect(row.answer_body.startsWith('{"$gzip":"')).toBe(true);
    expect(row.problems).toBe("[]");
    expect(row.bytes).toBeLessThan(2_000_000);
    const again = await deliver(m);
    expect(again.status).toBe(422);
    expect(again.text).toBe(first.text);
    const s = (await status(["co-test-002"])).json!.volumes[0];
    expect(s.state).toBe("refused");
    // Status shows the first 100, counting the rest; the stored answer stays whole.
    expect(s.problems.slice(0, 100)).toEqual(first.json!.problems.slice(0, 100));
    expect(s.problems[100]).toEqual({ rule: "problems-truncated", message: expect.any(String), omitted: 3900 });
  });

  it("registers a 4,000-image RAW replacement that leaves 8,000 earlier objects in the bucket, under D1's row limit", async () => {
    const stem = "co-test-002";
    const opening = (n: number, from: number) =>
      rec(1000 + n, n + 1, "approved", [image(stem, from + 2 * n, 0, "left"), image(stem, from + 2 * n, 1, "right")]);
    // The first handover: 2,000 spreads, 4,000 RAWs and 4,000 previews.
    const earlier = manifest([{ ...volume("co-test-002"), records: Array.from({ length: 2000 }, (_, n) => opening(n, 1)) }]);
    upload(world.s3, earlier);
    expect((await deliver(earlier)).status).toBe(200);
    // Taken back and shot again under new capture numbers; the earlier
    // objects stay in the bucket, as the contract requires.
    world.clock.now = T0 + 60_000;
    const retake = manifest([{ ...volume("co-test-002"), records: Array.from({ length: 2000 }, (_, n) => opening(n, 10_001)) }]);
    upload(world.s3, retake);
    const a = await deliver(retake);
    expect(a.status).toBe(200);
    const [row] = await sqlRows(
      "SELECT problems, records, length(answer_body) + length(problems) + length(coalesce(records, '')) + 500 AS bytes " +
        "FROM capture_deliveries WHERE id = ?",
      retake.id,
    );
    expect(row.problems.startsWith('{"$gzip":"')).toBe(true);
    expect(row.bytes).toBeLessThan(2_000_000);
    expect(await pagesOf(a.json!.volumeId)).toHaveLength(4000);
    const s = (await status(["co-test-002"])).json!.volumes[0];
    expect(s).toMatchObject({ state: "registered", manifestId: retake.id });
    // The scan keeps 1,000 notes by name and counts the other 7,000;
    // status shows 100 of them and counts the other 7,900.
    expect(s.problems).toHaveLength(101);
    expect(s.problems.slice(0, 100).every((p: Json) => p.rule === "unlisted-object")).toBe(true);
    expect(s.problems[100]).toEqual({ rule: "problems-truncated", message: expect.any(String), omitted: 7900 });
    expect(s.problems[0]).toEqual({
      rule: "unlisted-object",
      message: "neogranadina/co-test-002/captures/co-test-002-img_0001_c0.cr3 is in the masters bucket and not in the manifest",
      stem: "co-test-002",
      objectKey: "neogranadina/co-test-002/captures/co-test-002-img_0001_c0.cr3",
      size: 1000,
    });
  });

  it("keeps the notes of 3,000 high-entropy stray objects within the row budget, ending in problems-truncated", async () => {
    const m = manifest([volume("co-test-001")]);
    upload(world.s3, m);
    const prefix = "neogranadina/co-test-001/captures/";
    for (let i = 0; i < 3000; i++) {
      const bytes = crypto.getRandomValues(new Uint8Array(470));
      const noise = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 925 - prefix.length);
      world.s3.objects.set(`${TEST_MASTERS_BUCKET}/${prefix}${noise}`, {
        bytes: new Uint8Array(1),
        etag: "e",
        contentType: null,
        meta: {},
      });
    }
    const a = await deliver(m);
    expect(a.status).toBe(200);
    const [row] = await sqlRows(
      "SELECT length(answer_body) + length(problems) + length(coalesce(records, '')) + 500 AS bytes FROM capture_deliveries WHERE id = ?",
      m.id,
    );
    expect(row.bytes).toBeLessThan(2_000_000);
    const s = (await status(["co-test-001"])).json!.volumes[0];
    expect(s.state).toBe("registered");
    const last = s.problems[s.problems.length - 1];
    expect(last).toEqual({ rule: "problems-truncated", message: expect.any(String), omitted: expect.any(Number) });
    expect(s.problems.length - 1 + last.omitted).toBe(3000);
    expect(s.problems).toHaveLength(101);
    expect(s.problems.slice(0, -1).every((p: Json) => p.rule === "unlisted-object")).toBe(true);
  });

  it("registers a volume whose prefix holds 100,000 stray objects, keeping 1,000 notes and counting the rest", async () => {
    const m = manifest([volume("co-test-001")]);
    upload(world.s3, m);
    for (let i = 0; i < 100_000; i++) {
      world.s3.objects.set(`${TEST_MASTERS_BUCKET}/neogranadina/co-test-001/stray/${String(i).padStart(6, "0")}.cr3`, {
        bytes: new Uint8Array(1),
        etag: "e",
        contentType: null,
        meta: {},
      });
    }
    const a = await deliver(m);
    expect(a.status).toBe(200);
    const [row] = await sqlRows("SELECT problems FROM capture_deliveries WHERE id = ?", m.id);
    const text = await unpackJson(row.problems);
    const notes = JSON.parse(text) as Json[];
    expect(notes).toHaveLength(1001);
    expect(notes[1000]).toMatchObject({ rule: "problems-truncated", omitted: 99_000 });
    expect(text.length).toBeLessThan(300_000);
  });

  it("truncates a refusal too large for its row the same way, and replays the stored answer", async () => {
    const stem = "co-test-002";
    const records = Array.from({ length: 2000 }, (_, n) => {
      const img = image(stem, n + 1, 0, "single", { jpegOnly: true });
      const bytes = crypto.getRandomValues(new Uint8Array(500));
      img.objectKey = `${stem}/captures/${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 990)}`;
      return rec(5000 + n, n + 1, "approved", [img]);
    });
    const m = manifest([{ ...volume("co-test-002"), records }]); // nothing uploaded
    const first = await deliver(m);
    expect(first.status).toBe(422);
    const problems = first.json!.problems as Json[];
    const last = problems[problems.length - 1];
    expect(last.rule).toBe("problems-truncated");
    expect(problems.length - 1 + last.omitted).toBe(2000);
    // Each random key is also off the key the contract names for its capture.
    expect(problems.slice(0, -1).every((p) => p.rule === "capture-key")).toBe(true);
    const [row] = await sqlRows(
      "SELECT length(answer_body) + length(problems) + 500 AS bytes FROM capture_deliveries WHERE id = ?",
      m.id,
    );
    expect(row.bytes).toBeLessThan(2_000_000);
    expect((await deliver(m)).text).toBe(first.text);
  });

  it("refuses 422 field-too-long a transfer root past 1,024 characters", async () => {
    const m = manifest([volume("co-test-001")], { transfer: { channel: "upload", root: "x".repeat(1_500_000) } });
    const a = await deliver(m);
    expect(a.status).toBe(422);
    expect(a.json!.problems).toEqual([expect.objectContaining({ rule: "field-too-long", path: "transfer.root" })]);
    expect(a.text.length).toBeLessThan(1000);
    expect(await deliveryOf(m.id)).toMatchObject({ state: "refused", answer_status: 422 });
  });

  it("keeps the operator's rejection note on each record, up to 2,000 characters", async () => {
    const m = manifest([volume("co-test-001")]);
    m.volumes[0].records[2].rejectionNote = "é".repeat(5000);
    upload(world.s3, m);
    expect((await deliver(m)).status).toBe(200);
    const records = JSON.parse((await deliveryOf(m.id)).records) as Json[];
    expect(records.find((r) => r.captuaRecordId === 13)!.rejectionNote).toBe("é".repeat(2000));
    expect(records.find((r) => r.captuaRecordId === 12)!.rejectionNote).toBeNull();
  });

  it("answers 422 when a master object is not in the bucket", async () => {
    const m = manifest([volume("co-test-001")]);
    const missing = "neogranadina/co-test-001/previews/co-test-001-img_0002_c1_preview.jpg";
    upload(world.s3, m, [missing]);
    const a = await deliver(m);
    expect(a.status).toBe(422);
    expect(a.json!.problems).toEqual([
      {
        rule: "object-missing",
        message: "The preview co-test-001/previews/co-test-001-img_0002_c1_preview.jpg is named by the manifest and is not in the masters bucket",
        objectKey: "co-test-001/previews/co-test-001-img_0002_c1_preview.jpg",
        captureId: "cap-co-test-001-img_0002_c1",
        role: "right",
        kind: "preview",
      },
    ]);
  });

  it("answers 503 and records nothing when the masters bucket cannot be listed", async () => {
    const m = manifest([volume("co-test-001")]);
    upload(world.s3, m);
    expect((await deliver(m, { deps: { env: {} } })).status).toBe(503);
    const failing: typeof fetch = async () => new Response("no", { status: 500 });
    expect((await deliver(m, { deps: { fetch: failing } })).status).toBe(503);
    expect(await sqlRows("SELECT * FROM capture_deliveries")).toEqual([]);
    expect((await deliver(m)).status).toBe(200);
  });

  it("answers 405 to any method but POST", async () => {
    const request = new Request(`${HOST}/api/capture/v1/manifests`, { headers: { Authorization: `Bearer ${world.token}` } });
    const res = await handleManifestDelivery(deps(), request);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// Idempotency, supersede, refusal after a run
// ---------------------------------------------------------------------------

describe("a repeated id", () => {
  it("gets the first answer verbatim for the same parsed body, whatever its key order and spacing", async () => {
    const m = manifest([volume("co-test-001")]);
    upload(world.s3, m);
    const first = await deliver(m);
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(m).reverse()), null, 2);
    const again = await deliver(reordered);
    expect(again.status).toBe(200);
    expect(again.text).toBe(first.text);
    expect((await sqlRows("SELECT * FROM pipeline_volumes")).length).toBe(1);
  });

  it("gets the first answer even after the volume moved on", async () => {
    const m = manifest([volume("co-test-001")]);
    upload(world.s3, m);
    const first = await deliver(m);
    await env.DB.prepare("UPDATE pipeline_volumes SET state = 'published'").run();
    const again = await deliver(m);
    expect(again.status).toBe(200);
    expect(again.text).toBe(first.text);
  });

  it("gets a refusal's answer again", async () => {
    const m = manifest([volume("co-test-999")]);
    const first = await deliver(m);
    await describe_("co-test-999");
    upload(world.s3, m);
    const again = await deliver(m);
    expect(again.status).toBe(422);
    expect(again.text).toBe(first.text);
  });

  it("is refused 409 id-reused with a different body, leaving the first delivery as it was", async () => {
    const m = manifest([volume("co-test-001")]);
    upload(world.s3, m);
    await deliver(m);
    const changed = { ...m, project: { captuaProjectId: 2, name: "Another" } };
    const a = await deliver(changed);
    expect(a.status).toBe(409);
    expect(a.json!.problems[0].rule).toBe("id-reused");
    expect(await deliveryOf(m.id)).toMatchObject({ state: "registered" });
  });
});

describe("a newer manifest for the same volume", () => {
  it("replaces the page list before a run and supersedes the older delivery", async () => {
    const a = manifest([volume("co-test-001")]);
    upload(world.s3, a);
    const first = await deliver(a);
    const v = volume("co-test-001");
    v.records = v.records.slice(1, 2); // one single opening
    const b = manifest([v]);
    world.clock.now = T0 + 60_000;
    const second = await deliver(b);
    expect(second.status).toBe(200);
    expect(second.json!.volumeId).toBe(first.json!.volumeId);
    expect((await pagesOf(first.json!.volumeId)).map((p) => p.page_key)).toEqual(["co-test-001-img_0001_c0"]);
    expect(await deliveryOf(a.id)).toMatchObject({ state: "superseded", superseded_by: b.id, superseded_at: T0 + 60_000 });
    expect(await deliveryOf(b.id)).toMatchObject({ state: "registered" });
    // Dispatch claims only at the revision it read the pages at.
    const [vol] = await sqlRows("SELECT pages_revision FROM pipeline_volumes WHERE id = ?", first.json!.volumeId);
    expect(vol.pages_revision).toBe(1);
    // The first id still gets its own first answer.
    expect((await deliver(a)).text).toBe(first.text);
  });

  it("is refused 409 run-started once a run has started, and the older delivery stays", async () => {
    const a = manifest([volume("co-test-001")]);
    upload(world.s3, a);
    const first = await deliver(a);
    await runOn(first.json!.volumeId);
    const b = manifest([volume("co-test-001")]);
    const refused = await deliver(b);
    expect(refused.status).toBe(409);
    expect(refused.json!.problems[0].rule).toBe("run-started");
    expect(await deliveryOf(a.id)).toMatchObject({ state: "registered" });
    expect(await deliveryOf(b.id)).toMatchObject({ state: "refused", answer_status: 409 });
    expect((await deliver(b)).status).toBe(409);
  });

  it("is refused 409 run-started after a run finished, even with the volume still received", async () => {
    const a = manifest([volume("co-test-001")]);
    upload(world.s3, a);
    const first = await deliver(a);
    await runOn(first.json!.volumeId, { status: "aborted", closed: true, error: { class: "image" } });
    const b = manifest([volume("co-test-001")]);
    expect((await deliver(b)).json!.problems[0].rule).toBe("run-started");
  });

  it("writes nothing and answers 409 without problems when the volume changes before the write", async () => {
    const a = manifest([volume("co-test-001")]);
    upload(world.s3, a);
    const first = await deliver(a);
    const raced = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            await target.prepare("UPDATE pipeline_volumes SET state = 'prepared'").run();
            return target.batch(stmts);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const v = volume("co-test-001");
    v.records = v.records.slice(1, 2);
    const b = manifest([v]);
    const answered = await deliver(b, { deps: { db: drizzle(raced) } });
    expect(answered.status).toBe(409);
    expect(answered.json).toEqual({});
    expect(await deliveryOf(b.id)).toBeUndefined();
    expect(await pagesOf(first.json!.volumeId)).toHaveLength(4);
    expect(await deliveryOf(a.id)).toMatchObject({ state: "registered" });
    // Sent again, it meets the volume as it now is.
    expect((await deliver(b)).json!.problems[0].rule).toBe("run-started");
  });

  it("records nothing when a run claims the volume in the same millisecond with the same page count", async () => {
    const a = manifest([volume("co-test-001")]);
    upload(world.s3, a);
    const first = await deliver(a);
    world.clock.now = T0 + 5000;
    const raced = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            // Dispatch claims the volume at this request's own write time.
            await runOn(first.json!.volumeId);
            await target.prepare("UPDATE pipeline_volumes SET updated_at = ?").bind(world.clock.now).run();
            return target.batch(stmts);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const b = manifest([volume("co-test-001")]); // the same four pages
    b.volumes[0].records[1].images[0].previewSha256 = digest("a retake");
    const answered = await deliver(b, { deps: { db: drizzle(raced) } });
    expect(answered.status).toBe(409);
    expect(answered.json).toEqual({});
    expect(await deliveryOf(b.id)).toBeUndefined();
    expect(await deliveryOf(a.id)).toMatchObject({ state: "registered" });
    expect((await pagesOf(first.json!.volumeId))[0].sha256).toBe(digest("preview co-test-001-img_0001_c0"));
  });

  it("orders deliveries by when they were committed, not when they arrived", async () => {
    const z = manifest([volume("co-test-001")]);
    upload(world.s3, z);
    await deliver(z);
    const a = manifest([volume("co-test-001")]);
    const b = manifest([volume("co-test-001")]);
    const c = manifest([volume("co-test-001")], { transfer: { channel: "upload", root: "other/" } });
    let delayed = false;
    // A arrives first; while its listing is out, B is accepted and C refused.
    const slow: typeof fetch = async (input, init) => {
      if (!delayed) {
        delayed = true;
        world.clock.now = T0 + 2000;
        expect((await deliver(b)).status).toBe(200);
        world.clock.now = T0 + 2500;
        expect((await deliver(c)).status).toBe(422);
      }
      return world.s3.fetch(input, init);
    };
    world.clock.now = T0 + 1000;
    expect((await deliver(a, { deps: { fetch: slow } })).status).toBe(200);
    expect(await deliveryOf(b.id)).toMatchObject({ state: "superseded", superseded_by: a.id });
    expect(await deliveryOf(z.id)).toMatchObject({ state: "superseded" });
    const s = (await status(["co-test-001"])).json!.volumes[0];
    expect(s).toMatchObject({ state: "registered", manifestId: a.id });
    // C was refused before A was accepted, so A's entry does not carry it.
    expect(s.problems).toEqual([]);
  });

  describe("two first deliveries of one id planned before either commits", () => {
    /** A database on which `other` is delivered, and committed, just before this request's batch. */
    function interleaved(other: () => Promise<Answer>) {
      let done = false;
      return drizzle(
        new Proxy(env.DB, {
          get(target, prop) {
            if (prop === "batch") {
              return async (stmts: D1PreparedStatement[]) => {
                if (!done) {
                  done = true;
                  expect((await other()).status).toBe(200);
                }
                return target.batch(stmts);
              };
            }
            const v = Reflect.get(target, prop);
            return typeof v === "function" ? v.bind(target) : v;
          },
        }),
      );
    }
    const imagesOf = (id: string) =>
      sqlRows("SELECT capture_id, capture_sha256 FROM capture_images WHERE delivery_id = ? ORDER BY capture_id", id);

    it("adds no image to the winner's delivery when the bodies are the same", async () => {
      const m = manifest([volume("co-test-001")]);
      upload(world.s3, m);
      const answered = await deliver(m, { deps: { db: interleaved(() => deliver(m)) } });
      expect(answered.status).toBe(200);
      const images = await imagesOf(m.id);
      expect(images).toHaveLength(6);
      expect(new Set(images.map((r) => r.capture_id)).size).toBe(6);
      expect(await sqlRows("SELECT * FROM pipeline_volumes")).toHaveLength(1);
    });

    it("adds no image to the winner's delivery when the bodies differ, and answers id-reused", async () => {
      const winner = manifest([volume("co-test-001")]);
      const loser = { ...winner, volumes: [volume("co-test-001")] };
      loser.volumes[0].records = loser.volumes[0].records.slice(1, 2);
      loser.volumes[0].records[0].images[0].sha256 = digest("the loser's capture");
      upload(world.s3, winner);
      const answered = await deliver(loser, { deps: { db: interleaved(() => deliver(winner)) } });
      expect(answered.status).toBe(409);
      expect(answered.json!.problems[0].rule).toBe("id-reused");
      const images = await imagesOf(winner.id);
      expect(images).toHaveLength(6);
      expect(images.some((r) => r.capture_sha256 === digest("the loser's capture"))).toBe(false);
    });
  });

  it("is accepted after a refused one: a refusal holds nothing", async () => {
    const bad = manifest([volume("co-test-001")]);
    upload(world.s3, bad, ["neogranadina/co-test-001/previews/co-test-001-img_0001_c0_preview.jpg"]);
    expect((await deliver(bad)).status).toBe(422);
    upload(world.s3, bad);
    const good = manifest([volume("co-test-001")]);
    const a = await deliver(good);
    expect(a.status).toBe(200);
    expect(await deliveryOf(bad.id)).toMatchObject({ state: "refused", superseded_by: null });
  });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

describe("volume status", () => {
  async function registered(code = "co-test-001") {
    const m = manifest([volume(code)]);
    upload(world.s3, m);
    const a = await deliver(m);
    return { manifestId: m.id, volumeId: a.json!.volumeId as string };
  }

  it("answers one entry per ref, unknown for a ref Fisqua holds nothing for", async () => {
    const r = await registered();
    const s = await status(["co-test-001", "co-test-404", "co-test-001"]);
    expect(s.status).toBe(200);
    expect(s.json).toEqual({
      volumes: [
        {
          ref: "co-test-001",
          volumeId: r.volumeId,
          manifestId: r.manifestId,
          state: "registered",
          enteredAt: new Date(T0).toISOString(),
          problems: [],
        },
        { ref: "co-test-404", volumeId: null, manifestId: null, state: "unknown", enteredAt: null, problems: [] },
      ],
    });
  });

  it("follows the volume through the pipeline", async () => {
    const r = await registered();
    const stateOf = async () => (await status(["co-test-001"])).json!.volumes[0];
    const run = await runOn(r.volumeId, { chunk: "pending" });
    expect((await stateOf()).state).toBe("queued");
    await env.DB.prepare("UPDATE pipeline_run_chunks SET status = 'dispatched', dispatched_at = ? WHERE run_id = ?")
      .bind(T0 + 10, run)
      .run();
    expect(await stateOf()).toMatchObject({ state: "running", enteredAt: new Date(T0 + 10).toISOString() });
    await env.DB.prepare("UPDATE pipeline_run_volumes SET status = 'aborted', error = ?, reported_at = ? WHERE run_id = ?")
      .bind(JSON.stringify({ class: "fixity" }), T0 + 20, run)
      .run();
    const failed = await stateOf();
    expect(failed.state).toBe("failed");
    expect(failed.problems).toEqual([expect.objectContaining({ rule: "pipeline", errorClass: "fixity" })]);
    await env.DB.prepare("UPDATE pipeline_volumes SET state = 'prepared' WHERE id = ?").bind(r.volumeId).run();
    await env.DB.prepare("UPDATE pipeline_run_volumes SET status = 'review_pending', error = NULL WHERE run_id = ?").bind(run).run();
    expect((await stateOf()).state).toBe("review_pending");
    await env.DB.prepare("UPDATE pipeline_volumes SET state = 'ready' WHERE id = ?").bind(r.volumeId).run();
    expect((await stateOf()).state).toBe("review_pending");
    await env.DB.prepare("UPDATE pipeline_volumes SET state = 'published', updated_at = ? WHERE id = ?")
      .bind(T0 + 99, r.volumeId)
      .run();
    expect(await stateOf()).toMatchObject({ state: "published", enteredAt: new Date(T0 + 99).toISOString() });
  });

  it("answers refused with the refusal's problems", async () => {
    await deliver(manifest([volume("co-test-001")])); // nothing uploaded
    const s = (await status(["co-test-001"])).json!.volumes[0];
    expect(s.state).toBe("refused");
    expect(s.problems[0].rule).toBe("object-missing");
  });

  it("follows the accepted manifest, not a later refused one, naming the refusal in its problems", async () => {
    const r = await registered();
    await runOn(r.volumeId);
    world.clock.now = T0 + 1000;
    const late = manifest([volume("co-test-001")]);
    expect((await deliver(late)).status).toBe(409);
    const s = (await status(["co-test-001"])).json!.volumes[0];
    expect(s.state).toBe("running");
    expect(s.manifestId).toBe(r.manifestId);
    expect(s.volumeId).toBe(r.volumeId);
    expect(s.problems).toEqual([expect.objectContaining({ rule: "run-started", manifestId: late.id })]);
  });

  it("stays registered when a later manifest is refused before any run", async () => {
    const r = await registered();
    world.clock.now = T0 + 1000;
    const bad = manifest([volume("co-test-001")], { transfer: { channel: "upload", root: "other/" } });
    expect((await deliver(bad)).status).toBe(422);
    const s = (await status(["co-test-001"])).json!.volumes[0];
    expect(s).toMatchObject({ state: "registered", manifestId: r.manifestId });
    expect(s.problems).toEqual([expect.objectContaining({ rule: "transfer-root", manifestId: bad.id })]);
  });

  it("keeps a status of 100 refs with large stored lists within its budget, each list counting what it leaves out", async () => {
    const problems = Array.from({ length: 4000 }, (_, i) => ({
      rule: "object-missing",
      message: `The capture co-x/captures/${i}${"x".repeat(900)} is named by the manifest and is not in the masters bucket`,
      objectKey: `co-x/captures/${i}${"x".repeat(900)}`,
      captureId: `cap-${i}`,
      role: "single",
      kind: "capture",
    }));
    const answer = JSON.stringify({ problems });
    expect(answer.length).toBeGreaterThan(4_000_000);
    const packed = await packJson(answer);
    const refs: string[] = [];
    for (let i = 0; i < 100; i++) {
      const ref = `co-big-${String(i).padStart(3, "0")}`;
      refs.push(ref);
      await insertRow("capture_deliveries", {
        tenant_id: DEFAULT_TEST_TENANT_ID,
        id: crypto.randomUUID(),
        route: "link",
        scanner_id: world.scannerId,
        reference_code: ref,
        body_sha256: "0".repeat(64),
        state: "refused",
        problems: "[]",
        answer_status: 422,
        answer_body: packed,
        openings: 0,
        received_at: T0,
        seq: i + 1,
      });
    }
    const s = await status(refs);
    expect(s.status).toBe(200);
    expect(s.text.length).toBeLessThanOrEqual(STATUS_BUDGET_BYTES);
    expect(s.json!.volumes).toHaveLength(100);
    for (const v of s.json!.volumes as Json[]) {
      expect(v.state).toBe("refused");
      const last = v.problems[v.problems.length - 1];
      expect(last).toMatchObject({ rule: "problems-truncated" });
      expect(v.problems.length - 1 + last.omitted).toBe(4000);
    }
  });

  it("takes 1 to 100 refs", async () => {
    expect((await status("")).status).toBe(400);
    expect((await status(" , ")).json!.problems[0].rule).toBe("refs");
    const hundred = Array.from({ length: 100 }, (_, i) => `co-test-${1000 + i}`);
    const ok = await status(hundred);
    expect(ok.status).toBe(200);
    expect(ok.json!.volumes).toHaveLength(100);
    expect((await status([...hundred, "co-test-2000"])).status).toBe(400);
  });

  it("answers 405 to any method but GET", async () => {
    const request = new Request(`${HOST}/api/capture/v1/volumes/status?refs=a`, {
      method: "POST",
      headers: { Authorization: `Bearer ${world.token}` },
    });
    expect((await handleVolumeStatus(deps(), request)).status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

describe("the rate limit", () => {
  it("allows 60 calls a minute per token, then answers 429 with Retry-After", async () => {
    world.clock.now = T0 + 15_000; // a quarter into a window
    for (let i = 0; i < 60; i++) expect((await status(["co-test-001"])).status).toBe(200);
    const over = await status(["co-test-001"]);
    expect(over.status).toBe(429);
    expect(over.headers.get("Retry-After")).toBe("45");
    const posted = await deliver(manifest([volume("co-test-001")]));
    expect(posted.status).toBe(429);
    world.clock.now = T0 + 60_000;
    expect((await status(["co-test-001"])).status).toBe(200);
  });

  it("counts each token on its own", async () => {
    const other = await seedScanner(SECOND_TEST_TENANT_ID, { name: "rig-2" });
    for (let i = 0; i < 60; i++) await status(["co-test-001"]);
    expect((await status(["co-test-001"])).status).toBe(429);
    const request = new Request(`${OTHER_HOST}/api/capture/v1/volumes/status?refs=a`, {
      headers: { Authorization: `Bearer ${other.token}` },
    });
    expect((await handleVolumeStatus(deps(), request)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

describe("the routes", () => {
  const context = () => ({ cloudflare: { env: { ...env, ...LIST_SECRETS }, ctx: { waitUntil: () => {} } } }) as any;

  it("answer without a session cookie and never redirect", async () => {
    const status_ = await statusLoader({
      request: new Request(`${HOST}/api/capture/v1/volumes/status?refs=co-test-001`, {
        headers: { Authorization: `Bearer ${world.token}` },
      }),
      params: {},
      context: context(),
    } as any);
    expect(status_.status).toBe(200);
    expect(status_.headers.get("Location")).toBeNull();

    const noToken = await manifestAction({
      request: new Request(`${HOST}/api/capture/v1/manifests`, { method: "POST", body: "{}" }),
      params: {},
      context: context(),
    } as any);
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get("Location")).toBeNull();

    const get = await manifestLoader({
      request: new Request(`${HOST}/api/capture/v1/manifests`),
      params: {},
      context: context(),
    } as any);
    expect(get.status).toBe(405);
  });
});

// @version v0.8.0
