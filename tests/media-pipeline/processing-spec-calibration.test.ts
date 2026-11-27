/**
 * Tests — processing specs with calibration shots (contract 1.12)
 *
 * This suite pins how Fisqua names calibration shots in a processing spec,
 * under contract 1.12. A capture volume of contract 1.12 may carry
 * calibration shots, which are never pages. The media pipeline pulls each
 * shot once and verifies its SHA-256, as it does for a page's master, and
 * a mismatch stops the volume with a fixity error; it makes nothing of a
 * shot. Fisqua's part is to name each shot's objects, with their digests,
 * in the volume's entry of the processing spec (`calibration`). The suite
 * drives `startPipelineRun` against the local D1 database and the spec
 * bucket, with a stub GitHub, and pins:
 *
 *   - from runner v1.3.0 (`CALIBRATION_FROM`) each volume whose
 *     registered delivery has shots lists, in the shots' order, the
 *     capture and then the preview of each, by full key and digest; the
 *     pages, their count and their numbering are those of the volume
 *     without shots, and the spec passes the validator;
 *   - a volume with no shots, and an earlier delivery's shots, give no
 *     field;
 *   - below v1.3.0 a volume with shots is refused with
 *     `calibration_unsupported`, naming it, and nothing is claimed,
 *     since an older runner neither reads the field nor verifies the
 *     shots; a volume without shots still starts;
 *   - the page-list check refuses a calibration key outside the
 *     volume's source prefix (`calibration_key_under_prefix`) and the
 *     same key named twice (`calibration_key_unique`).
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase, seedTenants, seedFederations, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { makeUserContext } from "../helpers/context";
import {
  seedReceivedVolumes,
  seedTenantDestination,
  insertRow,
  withTokenExchange,
  githubAppEnv,
  TEST_DESTINATION,
  type ReceivedVolumes,
} from "../helpers/media-pipeline";
import { clearGitHubAppCaches } from "../../app/lib/pipeline/github-app.server";
import {
  startPipelineRun,
  StartRunRefusal,
  CALIBRATION_FROM,
  type PipelineRunConfig,
  type StartRunDeps,
  type StartRunInput,
} from "../../app/lib/pipeline/dispatch.server";
import { getPipelineSpecStore, pipelineKey } from "../../app/lib/pipeline/store.server";
import { TONAL_DEFAULT_PRESET } from "../../app/lib/pipeline/recipe";
import { REVIEW_RUN_LIFETIME_CONSTANTS } from "../../app/lib/pipeline/run-config";
import { checkVolumePages, validateRunSpec, type ManifestResolver } from "../../app/lib/pipeline/run-spec";
import { recordDecisionsAction } from "../../app/lib/capture/qc.server";
import type { Tenant, User } from "../../app/context";

type Json = Record<string, any>;

const B2_HOST = "https://s3.us-west-001.backblazeb2.com";
const ORIGIN = "https://fisqua.test";
const V120 = { PIPELINE_SCRIPT_VERSION: "v1.2.0", PIPELINE_WORKING_S3_ENDPOINT: B2_HOST };
const V130 = { PIPELINE_SCRIPT_VERSION: "v1.3.0", PIPELINE_WORKING_S3_ENDPOINT: B2_HOST };
const hex = (c: string) => c.repeat(64);

const CONFIG: PipelineRunConfig = {
  maxRunVolumes: 2000,
  maxRunPages: 250_000,
  maxSampleVolumes: 2000,
  targetImagesPerJob: 734,
  lifetime: {
    secondsPerImage: 0.95,
    perJobOverheadSeconds: 120,
    lanes: 16,
    chunkSpacingSeconds: 60,
    queueAllowanceSeconds: 600,
    marginFactor: 1.5,
    tokenFloorSeconds: 3600,
    urlFloorSeconds: 1800,
    callbackTailSeconds: 600,
  },
  reviewLifetime: REVIEW_RUN_LIFETIME_CONSTANTS,
  presets: {
    byOutputClass: { tonal: TONAL_DEFAULT_PRESET },
    acceptedKeys: { preprocess: [], render: [] },
  },
};

const testManifest: ManifestResolver = (v) => ({
  id: `https://iiif.example.test/${v.referenceCode}/manifest.json`,
  label: { es: [v.referenceCode] },
  rights: null,
  required_statement: null,
  provider: [],
});

let appEnv: Record<string, string> = {};

const acceptingGitHub = withTokenExchange((async () => new Response(null, { status: 204 })) as typeof fetch, {
  status: 201,
  exchanges: [],
});

function deps(envOverrides: Record<string, unknown>): StartRunDeps {
  const testEnv = { ...env, ...appEnv, ...envOverrides } as any;
  return {
    db: drizzle(env.DB),
    env: testEnv,
    specStore: getPipelineSpecStore(testEnv),
    fetchImpl: acceptingGitHub,
    manifestResolverFor: () => testManifest,
    config: CONFIG,
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
  };
}

interface Setup {
  tenant: Tenant;
  user: User;
  seeded: ReceivedVolumes;
}

async function setup(count = 1): Promise<Setup> {
  await seedTenantDestination(DEFAULT_TEST_TENANT_ID, { ...TEST_DESTINATION, pipelineReviewTilesBucket: null });
  const db = drizzle(env.DB, { schema });
  const row = await db.select().from(schema.tenants).where(eq(schema.tenants.id, DEFAULT_TEST_TENANT_ID)).get();
  const tenant = { ...(row as Tenant), mediaPipelineEnabled: true };
  const admin = await createTestUser({ isAdmin: true });
  const user = makeUserContext({ id: admin.id, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
  const seeded = await seedReceivedVolumes({ userId: admin.id, count, pageCount: 2 });
  return { tenant, user, seeded };
}

function input(s: Setup, ids = s.seeded.volumes.map((v) => v.id)): StartRunInput {
  return { tenant: s.tenant, user: s.user, pipelineVolumeIds: ids, kind: "volume_run", purpose: "sample", maxReviewFrac: 0.1 };
}

async function first<T = Json>(query: string, ...binds: unknown[]): Promise<T> {
  return (await env.DB.prepare(query).bind(...binds).first<T>()) as T;
}

async function storedSpec(runId: string): Promise<Json> {
  const object = await env.SPEC_BUCKET.get(pipelineKey.spec(DEFAULT_TEST_TENANT_ID, runId));
  if (!object) throw new Error(`no spec stored for run ${runId}`);
  return JSON.parse(await object.text());
}

async function clearSpecs(): Promise<void> {
  const listed = await env.SPEC_BUCKET.list({ prefix: `${DEFAULT_TEST_TENANT_ID}/pipeline-runs/` });
  for (const o of listed.objects) await env.SPEC_BUCKET.delete(o.key);
}

/** A delivery of the volume with one opening a spread on its two pages, registered or superseded. */
async function delivery(volumeId: string, code: string, opts: { supersededBy?: string } = {}): Promise<string> {
  const id = crypto.randomUUID();
  await insertRow("capture_deliveries", {
    tenant_id: DEFAULT_TEST_TENANT_ID,
    id,
    route: "file",
    scanner_id: null,
    reference_code: code,
    pipeline_volume_id: volumeId,
    body_sha256: "0".repeat(64),
    state: opts.supersededBy === undefined ? "registered" : "superseded",
    superseded_by: opts.supersededBy ?? null,
    superseded_at: opts.supersededBy === undefined ? null : 1,
    problems: "[]",
    answer_status: 200,
    answer_body: "{}",
    records: JSON.stringify([{ captuaRecordId: 1, sequence: 1, status: "in_review", rejectionNote: null }]),
    openings: 1,
    received_at: Date.now(),
    seq: (await first<{ n: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM capture_deliveries")).n,
  });
  for (const [role, pageKey] of [["left", "p00001"], ["right", "p00002"]] as const) {
    await insertRow("capture_images", {
      id: crypto.randomUUID(),
      tenant_id: DEFAULT_TEST_TENANT_ID,
      delivery_id: id,
      captua_record_id: 1,
      capture_id: "cap-1",
      pair_id: "pair-1",
      role,
      page_key: pageKey,
      capture_key: `masters/${code}/captures/${pageKey}.cr3`,
      capture_sha256: hex("a"),
      record_status: "in_review",
    });
  }
  return id;
}

/** A shot of the delivery, its capture and, unless `jpegOnly`, its preview, under the volume's prefix. */
async function shotOf(deliveryId: string, prefix: string, seq: number, opts: { jpegOnly?: boolean } = {}) {
  const base = `cal_${seq}`;
  await insertRow("capture_calibration_shots", {
    id: crypto.randomUUID(),
    tenant_id: DEFAULT_TEST_TENANT_ID,
    delivery_id: deliveryId,
    seq,
    capture_id: `cal-${seq}`,
    filename: `${base}.${opts.jpegOnly ? "jpg" : "cr3"}`,
    camera: "c0",
    captured_at: "2026-11-20T09:15:00Z",
    settings: "{}",
    applies_from_capture_id: "cap-1",
    capture_key: `${prefix}calibration/${base}.${opts.jpegOnly ? "jpg" : "cr3"}`,
    capture_sha256: hex(String(seq)),
    preview_key: opts.jpegOnly ? null : `${prefix}calibration/${base}_preview.jpg`,
    preview_sha256: opts.jpegOnly ? null : hex("f"),
  });
}

async function approve(s: Setup, volumeId: string): Promise<void> {
  const current = await first<{ id: string }>(
    "SELECT id FROM capture_deliveries WHERE pipeline_volume_id = ? AND state = 'registered'",
    volumeId,
  );
  const request = new Request(`${ORIGIN}/admin/capture/volumes/${volumeId}/decisions`, {
    method: "POST",
    body: JSON.stringify({ manifestId: current.id, records: [{ captuaRecordId: 1, decision: "approved" }] }),
  });
  const res = await recordDecisionsAction(
    { db: drizzle(env.DB), now: () => Date.now(), newId: () => crypto.randomUUID() },
    request,
    volumeId,
    s.tenant,
    s.user,
  );
  expect(res.status).toBe(200);
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

describe("processing specs with calibration shots", () => {
  beforeAll(async () => {
    await applyMigrations();
    appEnv = await githubAppEnv();
  });
  beforeEach(async () => {
    clearGitHubAppCaches();
    await cleanDatabase();
    await seedTenants();
    await seedFederations();
    await clearSpecs();
  });

  it("names the release that reads them", () => {
    expect(CALIBRATION_FROM).toEqual([1, 3, 0]);
  });

  it("lists each shot's capture and preview by key and digest from v1.3.0, and leaves the pages as they were", async () => {
    const s = await setup(2);
    const [a, b] = s.seeded.volumes;
    const prefix = `masters/${a.referenceCode}/`;
    const older = await delivery(a.id, a.referenceCode, { supersededBy: "later" });
    await shotOf(older, prefix, 9);
    const current = await delivery(a.id, a.referenceCode);
    await shotOf(current, prefix, 2, { jpegOnly: true });
    await shotOf(current, prefix, 1);
    await approve(s, a.id);
    await delivery(b.id, b.referenceCode);
    await approve(s, b.id);

    const { runId } = await startPipelineRun(deps(V130), input(s));
    const spec = await storedSpec(runId);
    const byId = Object.fromEntries(spec.volumes.map((v: Json) => [v.volume_id, v]));
    expect(byId[a.id].calibration).toEqual([
      { key: `${prefix}calibration/cal_1.cr3`, sha256: hex("1") },
      { key: `${prefix}calibration/cal_1_preview.jpg`, sha256: hex("f") },
      { key: `${prefix}calibration/cal_2.jpg`, sha256: hex("2") },
    ]);
    expect(byId[a.id].pages.map((p: Json) => [p.seq, p.page_key])).toEqual([
      [1, "p00001"],
      [2, "p00002"],
    ]);
    expect(byId[a.id].expected_count).toBe(2);
    expect("calibration" in byId[b.id]).toBe(false);
    expect(() => validateRunSpec(spec)).not.toThrow();
  });

  it("refuses a volume with shots below v1.3.0, naming it, claims nothing, and starts one without", async () => {
    const s = await setup(2);
    const [a, b] = s.seeded.volumes;
    const current = await delivery(a.id, a.referenceCode);
    await shotOf(current, `masters/${a.referenceCode}/`, 1);
    await approve(s, a.id);
    await delivery(b.id, b.referenceCode);
    await approve(s, b.id);
    const r = await refusal(startPipelineRun(deps(V120), input(s)));
    expect(r.code).toBe("calibration_unsupported");
    expect(r.detail).toEqual({ volume_ids: [a.id], runner_from: "v1.3.0" });
    expect((await first<{ n: number }>("SELECT COUNT(*) AS n FROM pipeline_runs")).n).toBe(0);
    const { runId } = await startPipelineRun(deps(V120), input(s, [b.id]));
    expect(JSON.stringify(await storedSpec(runId))).not.toContain("calibration");
  });

  it("refuses a calibration key outside the source prefix, or named twice, in the page-list check", () => {
    const entry = (calibration: Array<{ key: string; sha256: string }>) => ({
      expected_count: 1,
      pages: [{ seq: 1, page_key: "p00001", master_key: "masters/co-1/p00001.tif" }],
      source: { backend: "b2" as const, endpoint: B2_HOST, bucket: "test-masters", prefix: "masters/co-1/" },
      calibration,
    });
    expect(checkVolumePages("volume_run", entry([{ key: "masters/co-1/calibration/a.cr3", sha256: hex("a") }]))).toEqual([]);
    expect(checkVolumePages("volume_run", entry([{ key: "masters/co-2/calibration/a.cr3", sha256: hex("a") }]))).toEqual([
      { path: "calibration.0.key", rule: "calibration_key_under_prefix" },
    ]);
    const twice = { key: "masters/co-1/calibration/a.cr3", sha256: hex("a") };
    expect(checkVolumePages("volume_run", entry([twice, twice]))).toEqual([{ path: "calibration.1.key", rule: "calibration_key_unique" }]);
  });

  it("applies the runner's key rule: exactly <prefix>calibration/<name>", () => {
    const entry = (key: string) => ({
      expected_count: 1,
      pages: [{ seq: 1, page_key: "p00001", master_key: "masters/co-1/p00001.tif" }],
      source: { backend: "b2" as const, endpoint: B2_HOST, bucket: "test-masters", prefix: "masters/co-1/" },
      calibration: [{ key, sha256: hex("a") }],
    });
    const rules = (key: string) => checkVolumePages("volume_run", entry(key)).map((p) => p.rule);
    const base = "masters/co-1/";
    expect(rules(`${base}calibration/a.cr3`)).toEqual([]);
    expect(rules(`${base}calibration/a b.cr3`)).toEqual([]);
    // The name is at most 200 bytes of UTF-8.
    expect(rules(`${base}calibration/${"\u00e9".repeat(100)}`)).toEqual([]);
    expect(rules(`${base}calibration/${"\u00e9".repeat(100)}a`)).toEqual(["calibration_key_under_prefix"]);
    // An astral character counts 4 bytes; a lone surrogate has no UTF-8 form.
    expect(rules(`${base}calibration/\ud83d\ude00.jpg`)).toEqual([]);
    expect(rules(`${base}calibration/${"\ud83d\ude00".repeat(50)}`)).toEqual([]);
    expect(rules(`${base}calibration/${"\ud83d\ude00".repeat(50)}a`)).toEqual(["calibration_key_under_prefix"]);
    expect(rules(`${base}calibration/\ud800.jpg`)).toEqual(["calibration_key_under_prefix"]);
    expect(rules(`${base}calibration/a\udc00`)).toEqual(["calibration_key_under_prefix"]);
    for (const bad of [
      `${base}calibration/sub/a.cr3`,
      `${base}calibration/..`,
      `${base}calibration/.`,
      `${base}calibration/`,
      `${base}calibration`,
      `${base}calibration/a\\b.cr3`,
      `${base}calibration\\a.cr3`,
      `${base}calibrations/a.cr3`,
      `${base}a.cr3`,
      `${base}calibration/a\u0000b.cr3`,
      `${base}calibration/a\tb.cr3`,
      `${base}calibration/a\nb.cr3`,
      `${base}calibration/a\u001fb.cr3`,
      `${base}calibration/a\u007fb.cr3`,
    ]) {
      expect(rules(bad), bad).toEqual(["calibration_key_under_prefix"]);
    }
  });
});

// @version v0.9.0
