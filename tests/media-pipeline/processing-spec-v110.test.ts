/**
 * Tests — processing specs for runner v1.1.0: rotations and the review purge
 *
 * From runner v1.1.0 a processing run's spec carries two things capture
 * QC recorded: each rotated page's `quarter_turns`, and, when the
 * federation has a review-tiles bucket, the review prefixes the runner
 * deletes once a volume's tiles are verified. This suite drives
 * `startPipelineRun` against the local D1 database and the spec bucket,
 * with a stub GitHub, and pins:
 *
 *   - below v1.1.0 nothing of either is read or written: a spec built
 *     while rotations, unpurged review runs and a review bucket exist is
 *     byte for byte the spec built without them;
 *   - `quarter_turns` comes from the rotation recorded for the image
 *     whose page key the page has, matched by capture id and role, so
 *     one side of a spread can be rotated without the other; a rotation
 *     carried into a retake with its approval is read the same way; a
 *     volume with no rotation, or no capture delivery, gets none;
 *   - from v1.2.0, `rotate_deg` comes from the page's image in the
 *     volume's registered delivery, the image that is the page's master
 *     (its preview, or its capture where it has none), 0 included and
 *     beside the page's `quarter_turns`; a page whose image has none,
 *     an earlier delivery's rotation, and an image that is not the
 *     page's master give none, and neither does a rejected record's
 *     image sharing the page's key and master, in either row order; a
 *     page two page images match is refused as `invalid_page_list`
 *     (`page_image_ambiguous`); below v1.2.0 a volume whose pages carry
 *     one is refused with `rotate_deg_unsupported`, naming it, and
 *     nothing is claimed;
 *   - the claim takes no volume whose decision set was written since its
 *     rotations were read, within D1's 100 bound parameters at the full
 *     claim width, and a start that loses its claim that way is refused
 *     with `volume_pages_changed`;
 *   - with v1.1.0 and a review-tiles bucket, the spec names the bucket in
 *     a `review` block on the federation's delivery endpoint, and each
 *     volume's `review_purge` lists the prefixes of its review runs whose
 *     purge is not recorded, earlier deliveries included; a volume with
 *     none has no field, and without the bucket there is neither; a row
 *     whose delivery belongs to another volume, or whose prefix is not
 *     `{slug}/{delivery id}/`, is left out and logged by its ids;
 *   - a store the strict rules refuse is refused naming what it came
 *     from, never answered with a 500: the working endpoint as
 *     `dispatch_unconfigured`, a tiles bucket that is not a bare name,
 *     and a review bucket shared with the tiles bucket, as
 *     `tenant_destination_unset`, and a volume's masters endpoint as
 *     `volume_source_invalid`, naming the volume and the column, with
 *     nothing claimed or written;
 *   - those specs pass the strict bucket and endpoint rules with
 *     real-form B2 hosts. The test configuration's working endpoint
 *     (`.test.example`) and the seeded volumes' masters endpoint do not,
 *     so the tests that write review fields set real-form values on
 *     those fixtures; the rules are not changed;
 *   - the processing report of a volume whose spec named prefixes marks
 *     them purged or failed, after which no prefix of that volume is
 *     read for purging again.
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
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { makeUserContext } from "../helpers/context";
import {
  seedReceivedVolumes,
  seedReviewRun,
  seedTenantDestination,
  insertRow,
  makeVolumeCallback,
  callbackHeaders,
  withTokenExchange,
  githubAppEnv,
  TEST_DELIVERY_ENDPOINT,
  TEST_DESTINATION,
  TEST_SCRIPT_VERSION,
  type ReceivedVolumes,
  type SeededRun,
  type SeededVolume,
} from "../helpers/media-pipeline";
import { clearGitHubAppCaches } from "../../app/lib/pipeline/github-app.server";
import {
  startPipelineRun,
  buildClaimStatements,
  readPageRotations,
  readReviewPurges,
  CLAIM_ID_CHUNK,
  StartRunRefusal,
  startRunAction,
  type PipelineRunConfig,
  type StartRunDeps,
  type StartRunInput,
} from "../../app/lib/pipeline/dispatch.server";
import { getPipelineSpecStore, pipelineKey } from "../../app/lib/pipeline/store.server";
import { TONAL_DEFAULT_PRESET } from "../../app/lib/pipeline/recipe";
import { validateRunSpec, type ManifestResolver } from "../../app/lib/pipeline/run-spec";
import { recordDecisionsAction } from "../../app/lib/capture/qc.server";
import { buildCarryForwardStatements } from "../../app/lib/capture/carry.server";
import { action as callbackAction } from "../../app/routes/api.pipeline.runs.$runId.volumes.$volumeId.callback";
import type { Tenant, User } from "../../app/context";

type Json = Record<string, any>;

/** A B2 S3 host in the form the strict rules accept, as staging's are. */
const B2_HOST = "https://s3.us-west-001.backblazeb2.com";
const REVIEW_BUCKET = "test-review-tiles";
const ORIGIN = "https://fisqua.test";
/** Either review field as a key of the serialised spec. */
const REVIEW_FIELD = /"review(_purge)?":/;

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

/** A GitHub that answers every token exchange and accepts every dispatch. */
const acceptingGitHub = withTokenExchange((async () => new Response(null, { status: 204 })) as typeof fetch, {
  status: 201,
  exchanges: [],
});

function deps(overrides: Partial<StartRunDeps> & { envOverrides?: Record<string, unknown> } = {}): StartRunDeps {
  const { envOverrides, ...rest } = overrides;
  const testEnv = { ...env, ...appEnv, ...(envOverrides ?? {}) } as any;
  return {
    db: drizzle(env.DB),
    env: testEnv,
    specStore: getPipelineSpecStore(testEnv),
    fetchImpl: acceptingGitHub,
    manifestResolverFor: () => testManifest,
    config: CONFIG,
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    ...rest,
  };
}

/** Runner v1.1.0, with the working space on a real-form B2 host. */
const V110 = { PIPELINE_SCRIPT_VERSION: "v1.1.0", PIPELINE_WORKING_S3_ENDPOINT: B2_HOST };
/** Runner v1.2.0, the release that reads `rotate_deg`. */
const V120 = { PIPELINE_SCRIPT_VERSION: "v1.2.0", PIPELINE_WORKING_S3_ENDPOINT: B2_HOST };

interface Setup {
  tenant: Tenant;
  user: User;
  seeded: ReceivedVolumes;
}

async function setup(
  opts: { count?: number; pageCount?: number; reviewBucket?: string | null } = {},
): Promise<Setup> {
  await seedTenantDestination(DEFAULT_TEST_TENANT_ID, {
    ...TEST_DESTINATION,
    pipelineReviewTilesBucket: opts.reviewBucket ?? null,
  });
  const db = drizzle(env.DB, { schema });
  const row = await db.select().from(schema.tenants).where(eq(schema.tenants.id, DEFAULT_TEST_TENANT_ID)).get();
  const tenant = { ...(row as Tenant), mediaPipelineEnabled: true };
  const admin = await createTestUser({ isAdmin: true });
  const user = makeUserContext({ id: admin.id, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
  const seeded = await seedReceivedVolumes({ userId: admin.id, count: opts.count ?? 1, pageCount: opts.pageCount ?? 3 });
  return { tenant, user, seeded };
}

/** The seeded volumes' masters on a real-form B2 host, as a federation's are. */
async function realFormMasters(): Promise<void> {
  await env.DB.prepare("UPDATE pipeline_volumes SET masters_endpoint = ?").bind(B2_HOST).run();
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

async function first<T = Json>(query: string, ...binds: unknown[]): Promise<T> {
  return (await env.DB.prepare(query).bind(...binds).first<T>()) as T;
}

async function storedSpec(runId: string): Promise<{ text: string; json: Json }> {
  const object = await env.SPEC_BUCKET.get(pipelineKey.spec(DEFAULT_TEST_TENANT_ID, runId));
  if (!object) throw new Error(`no spec stored for run ${runId}`);
  const text = await object.text();
  return { text, json: JSON.parse(text) };
}

async function clearSpecs(): Promise<void> {
  const listed = await env.SPEC_BUCKET.list({ prefix: `${DEFAULT_TEST_TENANT_ID}/pipeline-runs/` });
  for (const o of listed.objects) await env.SPEC_BUCKET.delete(o.key);
}

// ---------------------------------------------------------------------------
// Capture deliveries, their images and decisions
// ---------------------------------------------------------------------------

interface Image {
  record: number;
  captureId: string;
  role: "left" | "right" | "single";
  pageKey: string;
  sha?: string;
  /** The image's `rotate_deg`; given, its capture key is the page's master key. */
  rotateDeg?: number | null;
}

/**
 * One opening a single image on page 1 (record 1), one a spread whose
 * two images share capture id `cap-2` on pages 2 and 3 (record 2).
 */
const SINGLE_AND_SPREAD: Image[] = [
  { record: 1, captureId: "cap-1", role: "single", pageKey: "p00001" },
  { record: 2, captureId: "cap-2", role: "left", pageKey: "p00002" },
  { record: 2, captureId: "cap-2", role: "right", pageKey: "p00003" },
];

/** A delivery of the volume, with its images: registered, or superseded by `supersededBy`. */
async function delivery(
  volumeId: string,
  code: string,
  images: Image[],
  opts: { id?: string; supersededBy?: string; status?: string; writeId?: string } = {},
): Promise<string> {
  const status = opts.status ?? "in_review";
  const records = [...new Set(images.map((i) => i.record))].map((r) => ({
    captuaRecordId: r,
    sequence: r,
    status,
    rejectionNote: null,
  }));
  const id = opts.id ?? crypto.randomUUID();
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
    records: JSON.stringify(records),
    openings: status === "captured" ? 0 : records.length,
    received_at: Date.now(),
    seq: (await first<{ n: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM capture_deliveries")).n,
    write_id: opts.writeId ?? null,
  });
  for (const image of images) {
    // An image with a rotation is the page's master, as the
    // registration makes it; `readPageRotateDegs` reads only that one.
    const master =
      image.rotateDeg === undefined
        ? null
        : await first<{ master_key: string } | null>(
            "SELECT master_key FROM pipeline_volume_pages WHERE pipeline_volume_id = ? AND page_key = ?",
            volumeId,
            image.pageKey,
          );
    await insertRow("capture_images", {
      id: crypto.randomUUID(),
      tenant_id: DEFAULT_TEST_TENANT_ID,
      delivery_id: id,
      captua_record_id: image.record,
      capture_id: image.captureId,
      pair_id: image.role === "single" ? null : `pair-${image.record}`,
      role: image.role,
      page_key: image.pageKey,
      capture_key: master?.master_key ?? `${code}/captures/${image.captureId}-${image.role}.cr3`,
      capture_sha256: image.sha ?? "a".repeat(64),
      record_status: status === "captured" ? "captured" : "in_review",
      rotate_deg: image.rotateDeg ?? null,
    });
  }
  return id;
}

/**
 * Adds to `deliveryId` an image of a rejected record (3) that shares
 * `pageKey` and its master with the page's own image, with `rotateDeg`.
 * With `rejectedFirst`, the page's own image is written again after it,
 * so the two orders of the rows are both tried.
 */
async function rejectedTwin(deliveryId: string, pageKey: string, rotateDeg: number | null, rejectedFirst: boolean) {
  const live = await first<Json>("SELECT * FROM capture_images WHERE delivery_id = ? AND page_key = ?", deliveryId, pageKey);
  if (rejectedFirst) await env.DB.prepare("DELETE FROM capture_images WHERE id = ?").bind(live.id).run();
  await insertRow("capture_images", {
    ...live,
    id: crypto.randomUUID(),
    captua_record_id: 3,
    capture_id: "cap-3",
    record_status: "rejected",
    rotate_deg: rotateDeg,
  });
  if (rejectedFirst) await insertRow("capture_images", live);
}

async function decide(s: Setup, volumeId: string, records: Json[]): Promise<number> {
  const current = await first<{ id: string }>(
    "SELECT id FROM capture_deliveries WHERE pipeline_volume_id = ? AND state = 'registered'",
    volumeId,
  );
  const request = new Request(`${ORIGIN}/admin/capture/volumes/${volumeId}/decisions`, {
    method: "POST",
    body: JSON.stringify({ manifestId: current.id, records }),
  });
  const res = await recordDecisionsAction(
    { db: drizzle(env.DB), now: () => Date.now(), newId: () => crypto.randomUUID() },
    request,
    volumeId,
    s.tenant,
    s.user,
  );
  return res.status;
}

const turnsOf = (volume: Json): Array<number | undefined> => volume.pages.map((p: Json) => p.quarter_turns);

// ---------------------------------------------------------------------------
// Review runs
// ---------------------------------------------------------------------------

/** A review run row of the volume on `deliveryId`, with its purge as given. */
async function reviewRow(
  volumeId: string,
  deliveryId: string,
  opts: { purgeStatus?: "purged" | "failed" | null; createdAt: number; prefix?: string },
): Promise<string> {
  const review = await seedReviewRun();
  const prefix = opts.prefix ?? `neogranadina/${deliveryId}/`;
  await insertRow("capture_review_runs", {
    tenant_id: DEFAULT_TEST_TENANT_ID,
    run_id: review.runId,
    delivery_id: deliveryId,
    pipeline_volume_id: volumeId,
    review_prefix: prefix,
    status: "review_ready",
    created_at: opts.createdAt,
    purge_status: opts.purgeStatus ?? null,
    purged_at: opts.purgeStatus === "purged" ? 1 : null,
  });
  return prefix;
}

// ---------------------------------------------------------------------------

describe("processing specs for runner v1.1.0", () => {
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

  // --- The version gate ------------------------------------------------------

  it("writes the spec below v1.1.0 byte for byte as without rotations, review runs or a review bucket", async () => {
    expect(TEST_SCRIPT_VERSION).toBe("v1.0.0");
    const s = await setup({ reviewBucket: REVIEW_BUCKET });
    const [a] = s.seeded.volumes;
    const current = await delivery(a.id, a.referenceCode, SINGLE_AND_SPREAD);
    expect(
      await decide(s, a.id, [
        { captuaRecordId: 1, decision: "approved", rotations: [{ captureId: "cap-1", role: "single", quarterTurns: 1 }] },
        { captuaRecordId: 2, decision: "approved", rotations: [{ captureId: "cap-2", role: "left", quarterTurns: 3 }] },
      ]),
    ).toBe(200);
    await reviewRow(a.id, current, { createdAt: 1 });

    const fixed = Date.now();
    const normalised = async (runId: string) => {
      const { text, json } = await storedSpec(runId);
      return text.split(runId).join("RUN").split(json.callback.token).join("TOKEN");
    };

    // With everything v1.1.0 would read in place.
    const withData = await startPipelineRun(deps({ now: () => fixed }), input(s));
    const before = await normalised(withData.runId);
    expect(before).not.toContain("quarter_turns");
    expect(before).not.toMatch(REVIEW_FIELD);

    // Free the volume, take the data away, and start again at the same moment.
    await env.DB.prepare("UPDATE pipeline_runs SET status = 'error', token_revoked_at = ? WHERE id = ?")
      .bind(fixed, withData.runId)
      .run();
    await env.DB.prepare("UPDATE pipeline_volumes SET held_by_run_id = NULL WHERE id = ?").bind(a.id).run();
    await env.DB.prepare("DELETE FROM capture_qc_rotations").run();
    await env.DB.prepare("DELETE FROM capture_review_runs").run();
    await seedTenantDestination(DEFAULT_TEST_TENANT_ID, { ...TEST_DESTINATION, pipelineReviewTilesBucket: null });
    const without = await startPipelineRun(deps({ now: () => fixed }), input(s));
    expect(await normalised(without.runId)).toBe(before);
  });

  // --- Rotations -------------------------------------------------------------

  it("fills quarter_turns from the rotation of each page's image, by capture id and role", async () => {
    const s = await setup({ count: 2 });
    const [a, b] = s.seeded.volumes;
    await delivery(a.id, a.referenceCode, SINGLE_AND_SPREAD);
    // The spread's left image is turned and its right one is not: they
    // share capture id cap-2.
    expect(
      await decide(s, a.id, [
        { captuaRecordId: 1, decision: "approved", rotations: [{ captureId: "cap-1", role: "single", quarterTurns: 2 }] },
        { captuaRecordId: 2, decision: "approved", rotations: [{ captureId: "cap-2", role: "left", quarterTurns: 1 }] },
      ]),
    ).toBe(200);

    const { runId } = await startPipelineRun(deps({ envOverrides: V110 }), input(s));
    const { json } = await storedSpec(runId);
    const byId = Object.fromEntries(json.volumes.map((v: Json) => [v.volume_id, v]));
    expect(turnsOf(byId[a.id])).toEqual([2, 1, undefined]);
    expect("quarter_turns" in byId[a.id].pages[2]).toBe(false);
    // The volume digitised elsewhere has no delivery and no rotation.
    expect(turnsOf(byId[b.id])).toEqual([undefined, undefined, undefined]);
    // No review bucket: no review field.
    expect("review" in json).toBe(false);
    expect(json.volumes.some((v: Json) => "review_purge" in v)).toBe(false);
    expect(() => validateRunSpec(json)).not.toThrow();
  });

  it("reads a rotation carried into a retake with its approval", async () => {
    const s = await setup();
    const [a] = s.seeded.volumes;
    const older = await delivery(a.id, a.referenceCode, SINGLE_AND_SPREAD);
    expect(
      await decide(s, a.id, [
        { captuaRecordId: 1, decision: "approved", rotations: [{ captureId: "cap-1", role: "single", quarterTurns: 3 }] },
        { captuaRecordId: 2, decision: "rejected", reason: "glare", side: "both" },
      ]),
    ).toBe(200);

    // The retake reshoots the spread and keeps the single image.
    const writeId = crypto.randomUUID();
    const newer = crypto.randomUUID();
    const retake = SINGLE_AND_SPREAD.map((i) => (i.record === 2 ? { ...i, sha: "b".repeat(64) } : i));
    await env.DB.prepare(
      "UPDATE capture_deliveries SET state = 'superseded', superseded_by = ?, superseded_at = 1 WHERE id = ?",
    )
      .bind(newer, older)
      .run();
    await delivery(a.id, a.referenceCode, retake, { id: newer, writeId });
    const db = drizzle(env.DB);
    await db.batch(
      buildCarryForwardStatements(db, {
        tenantId: DEFAULT_TEST_TENANT_ID,
        volumeId: a.id,
        deliveryId: newer,
        writeId,
        openings: 2,
        openingIds: [1, 2],
        decisionsId: crypto.randomUUID(),
        now: Date.now(),
      }) as any,
    );
    const carried = await first("SELECT quarter_turns FROM capture_qc_rotations WHERE delivery_id = ?", newer);
    expect(carried.quarter_turns).toBe(3);
    expect(await decide(s, a.id, [{ captuaRecordId: 2, decision: "approved" }])).toBe(200);

    const { runId } = await startPipelineRun(deps({ envOverrides: V110 }), input(s));
    expect(turnsOf((await storedSpec(runId)).json.volumes[0])).toEqual([3, undefined, undefined]);
  });

  it("writes no quarter_turns for an approved volume capture QC rotated nothing", async () => {
    const s = await setup();
    const [a] = s.seeded.volumes;
    await delivery(a.id, a.referenceCode, SINGLE_AND_SPREAD);
    expect(
      await decide(s, a.id, [
        { captuaRecordId: 1, decision: "approved" },
        { captuaRecordId: 2, decision: "approved" },
      ]),
    ).toBe(200);
    expect((await readPageRotations(drizzle(env.DB), DEFAULT_TEST_TENANT_ID, [a.id])).rotations.get(a.id)?.size).toBe(0);
    const { runId } = await startPipelineRun(deps({ envOverrides: V110 }), input(s));
    const { text, json } = await storedSpec(runId);
    expect(text).not.toContain("quarter_turns");
    expect(json.runner.script_version).toBe("v1.1.0");
  });

  // --- rotate_deg -----------------------------------------------------------

  it("fills rotate_deg from v1.2.0 from each page's image, 0 included, beside its quarter_turns", async () => {
    const s = await setup({ count: 2 });
    const [a, b] = s.seeded.volumes;
    await delivery(a.id, a.referenceCode, [
      { ...SINGLE_AND_SPREAD[0], rotateDeg: 90 },
      { ...SINGLE_AND_SPREAD[1], rotateDeg: 0 },
      { ...SINGLE_AND_SPREAD[2], rotateDeg: null },
    ]);
    expect(
      await decide(s, a.id, [
        { captuaRecordId: 1, decision: "approved", rotations: [{ captureId: "cap-1", role: "single", quarterTurns: 1 }] },
        { captuaRecordId: 2, decision: "approved" },
      ]),
    ).toBe(200);
    const { runId } = await startPipelineRun(deps({ envOverrides: V120 }), input(s));
    const { json } = await storedSpec(runId);
    const byId = Object.fromEntries(json.volumes.map((v: Json) => [v.volume_id, v]));
    expect(byId[a.id].pages.map((p: Json) => p.rotate_deg)).toEqual([90, 0, undefined]);
    expect("rotate_deg" in byId[a.id].pages[2]).toBe(false);
    expect(turnsOf(byId[a.id])).toEqual([1, undefined, undefined]);
    // The volume digitised elsewhere has no delivery and no rotation.
    expect(byId[b.id].pages.some((p: Json) => "rotate_deg" in p)).toBe(false);
    expect(() => validateRunSpec(json)).not.toThrow();
  });

  it("reads rotate_deg only from the registered delivery's image that is the page's master", async () => {
    const s = await setup();
    const [a] = s.seeded.volumes;
    const newer = crypto.randomUUID();
    // An earlier delivery turned page 1; the current one does not.
    await delivery(a.id, a.referenceCode, [{ ...SINGLE_AND_SPREAD[0], rotateDeg: 180 }], { supersededBy: newer });
    // The current one turns page 2 on an image that is not its master.
    await delivery(a.id, a.referenceCode, [SINGLE_AND_SPREAD[0], { ...SINGLE_AND_SPREAD[1], rotateDeg: 90 }], { id: newer });
    await env.DB.prepare("UPDATE capture_images SET capture_key = 'elsewhere/p.cr3' WHERE delivery_id = ? AND page_key = 'p00002'")
      .bind(newer)
      .run();
    // Page 3's image is the master and is turned.
    await insertRow("capture_images", {
      id: crypto.randomUUID(),
      tenant_id: DEFAULT_TEST_TENANT_ID,
      delivery_id: newer,
      captua_record_id: 2,
      capture_id: "cap-2",
      pair_id: "pair-2",
      role: "right",
      page_key: "p00003",
      capture_key: "elsewhere/raw.cr3",
      capture_sha256: "a".repeat(64),
      preview_key: (await first<{ master_key: string }>(
        "SELECT master_key FROM pipeline_volume_pages WHERE pipeline_volume_id = ? AND page_key = 'p00003'",
        a.id,
      )).master_key,
      preview_sha256: "c".repeat(64),
      record_status: "in_review",
      rotate_deg: 270,
    });
    expect(
      await decide(s, a.id, [
        { captuaRecordId: 1, decision: "approved" },
        { captuaRecordId: 2, decision: "approved" },
      ]),
    ).toBe(200);
    const { runId } = await startPipelineRun(deps({ envOverrides: V120 }), input(s));
    const { json } = await storedSpec(runId);
    expect(json.volumes[0].pages.map((p: Json) => p.rotate_deg)).toEqual([undefined, undefined, 270]);
  });

  it.each([
    [90, null, false],
    [90, null, true],
    [null, 270, false],
    [null, 270, true],
  ] as const)(
    "takes the page's own rotate_deg %j over a rejected record's image %j sharing its key and master (rejected first: %s)",
    async (own, rejected, rejectedFirst) => {
      const s = await setup();
      const [a] = s.seeded.volumes;
      const current = await delivery(a.id, a.referenceCode, [
        { ...SINGLE_AND_SPREAD[0], rotateDeg: own },
        SINGLE_AND_SPREAD[1],
        SINGLE_AND_SPREAD[2],
      ]);
      await rejectedTwin(current, "p00001", rejected, rejectedFirst);
      expect(
        await decide(s, a.id, [
          { captuaRecordId: 1, decision: "approved" },
          { captuaRecordId: 2, decision: "approved" },
        ]),
      ).toBe(200);
      if (own !== null) {
        // The page's rotation still keeps it from a runner that cannot read it.
        const r = await refusal(startPipelineRun(deps({ envOverrides: V110 }), input(s)));
        expect(r.code).toBe("rotate_deg_unsupported");
      } else {
        // The rejected image's rotation is no page's: v1.1.0 still starts.
        const { runId } = await startPipelineRun(deps({ envOverrides: V110 }), input(s));
        expect((await storedSpec(runId)).text).not.toContain("rotate_deg");
        await env.DB.prepare("UPDATE pipeline_runs SET status = 'error', token_revoked_at = 1 WHERE id = ?").bind(runId).run();
        await env.DB.prepare("UPDATE pipeline_volumes SET held_by_run_id = NULL WHERE id = ?").bind(a.id).run();
      }
      const { runId } = await startPipelineRun(deps({ envOverrides: V120 }), input(s));
      const { json } = await storedSpec(runId);
      expect(json.volumes[0].pages.map((p: Json) => p.rotate_deg)).toEqual([own ?? undefined, undefined, undefined]);
    },
  );

  it("refuses a page that two of the delivery's page images match, rather than choosing one", async () => {
    const s = await setup();
    const [a] = s.seeded.volumes;
    const current = await delivery(a.id, a.referenceCode, [
      { ...SINGLE_AND_SPREAD[0], rotateDeg: 90 },
      SINGLE_AND_SPREAD[1],
      SINGLE_AND_SPREAD[2],
    ]);
    const live = await first<Json>("SELECT * FROM capture_images WHERE delivery_id = ? AND page_key = 'p00001'", current);
    await insertRow("capture_images", { ...live, id: crypto.randomUUID(), capture_id: "cap-1b", rotate_deg: 180 });
    expect(
      await decide(s, a.id, [
        { captuaRecordId: 1, decision: "approved" },
        { captuaRecordId: 2, decision: "approved" },
      ]),
    ).toBe(200);
    const r = await refusal(startPipelineRun(deps({ envOverrides: V120 }), input(s)));
    expect(r.code).toBe("invalid_page_list");
    expect(r.detail).toMatchObject({ volume_id: a.id, rules: ["page_image_ambiguous"], page_keys: ["p00001"] });
    expect((await first<{ n: number }>("SELECT COUNT(*) AS n FROM pipeline_runs")).n).toBe(0);
  });

  it("refuses a volume whose pages carry rotate_deg below v1.2.0, naming it, and claims nothing", async () => {
    const s = await setup({ count: 2 });
    const [a, b] = s.seeded.volumes;
    await delivery(a.id, a.referenceCode, [{ ...SINGLE_AND_SPREAD[0], rotateDeg: 0 }, SINGLE_AND_SPREAD[1], SINGLE_AND_SPREAD[2]]);
    expect(
      await decide(s, a.id, [
        { captuaRecordId: 1, decision: "approved" },
        { captuaRecordId: 2, decision: "approved" },
      ]),
    ).toBe(200);
    for (const envOverrides of [V110, {}]) {
      const r = await refusal(startPipelineRun(deps({ envOverrides }), input(s)));
      expect(r.code).toBe("rotate_deg_unsupported");
      expect(r.detail).toEqual({ volume_ids: [a.id], runner_from: "v1.2.0" });
    }
    expect((await first<{ n: number }>("SELECT COUNT(*) AS n FROM pipeline_runs")).n).toBe(0);
    // The other volume alone still starts on v1.1.0, with no rotate_deg.
    const { runId } = await startPipelineRun(deps({ envOverrides: V110 }), input(s, { pipelineVolumeIds: [b.id] }));
    expect((await storedSpec(runId)).text).not.toContain("rotate_deg");
  });

  // --- The claim -------------------------------------------------------------

  it("takes no volume in the claim whose decision set was written since its rotations were read", async () => {
    const s = await setup();
    const [a] = s.seeded.volumes;
    await delivery(a.id, a.referenceCode, SINGLE_AND_SPREAD);
    await decide(s, a.id, [
      { captuaRecordId: 1, decision: "approved" },
      { captuaRecordId: 2, decision: "approved" },
    ]);
    const db = drizzle(env.DB);
    const read = await readPageRotations(db, DEFAULT_TEST_TENANT_ID, [a.id]);
    expect(read.qcRevisions.get(a.id)).toBeGreaterThan(0);
    const now = Date.now();
    const claim = (volumeIds: string[], runId = crypto.randomUUID(), qcRevisions = read.qcRevisions) =>
      buildClaimStatements(db, {
        run: {
          id: runId,
          tenantId: DEFAULT_TEST_TENANT_ID,
          userId: s.user.id,
          kind: "volume_run",
          purpose: "sample",
          status: "pending",
          runnerImage: env.PIPELINE_RUNNER_IMAGE as string,
          scriptVersion: "v1.1.0",
          arch: "x64",
          maxReviewFrac: 0.1,
          specKey: pipelineKey.spec(DEFAULT_TEST_TENANT_ID, runId),
          specSha256: "0".repeat(64),
          specUrlExpiresAt: now + 1000,
          chunkCount: 1,
          volumeCount: volumeIds.length,
          callbackTokenHash: "0".repeat(64),
          tokenExpiresAt: now + 2000,
          createdAt: now,
        },
        chunkIds: [crypto.randomUUID()],
        volumeIds,
        pagesRevisions: new Map(volumeIds.map((id) => [id, 0])),
        qcRevisions,
        kind: "volume_run",
        now,
      });

    // At the full claim width, with both revision lists, every statement
    // stays within D1's 100 bound parameters.
    const wide = Array.from({ length: CLAIM_ID_CHUNK }, (_, i) => `v-${i}`);
    for (const stmt of claim(wide)) {
      expect((stmt as any).toSQL().params.length).toBeLessThanOrEqual(100);
    }

    // Read while approved; a rotation is added on the approved set first.
    const runId = crypto.randomUUID();
    const statements = claim([a.id], runId);
    expect(
      await decide(s, a.id, [
        { captuaRecordId: 1, decision: "approved", rotations: [{ captureId: "cap-1", role: "single", quarterTurns: 1 }] },
      ]),
    ).toBe(200);
    expect((await first("SELECT state FROM capture_qc_sets WHERE pipeline_volume_id = ?", a.id)).state).toBe("approved");
    await db.batch(statements as any);
    const run = await first("SELECT status, error FROM pipeline_runs WHERE id = ?", runId);
    expect(run.status).toBe("error");
    expect(JSON.parse(run.error)).toEqual({ class: "dispatch", stage: "claim" });
    expect((await first("SELECT held_by_run_id FROM pipeline_volumes WHERE id = ?", a.id)).held_by_run_id).toBeNull();

    // Read again, the claim takes it.
    const fresh = crypto.randomUUID();
    const again = (await readPageRotations(db, DEFAULT_TEST_TENANT_ID, [a.id])).qcRevisions;
    await db.batch(claim([a.id], fresh, again) as any);
    expect((await first("SELECT held_by_run_id FROM pipeline_volumes WHERE id = ?", a.id)).held_by_run_id).toBe(fresh);
  });

  it("refuses a lost claim with volume_pages_changed when a rotation changed after the read", async () => {
    const s = await setup();
    const [a] = s.seeded.volumes;
    await delivery(a.id, a.referenceCode, SINGLE_AND_SPREAD);
    await decide(s, a.id, [
      { captuaRecordId: 1, decision: "approved" },
      { captuaRecordId: 2, decision: "approved" },
    ]);
    // The rotation lands just before the claim batch, the first batch
    // of more than the two statements the rotations read takes.
    let fired = false;
    const binding = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (!fired && stmts.length > 2) {
              fired = true;
              await decide(s, a.id, [
                { captuaRecordId: 2, decision: "approved", rotations: [{ captureId: "cap-2", role: "right", quarterTurns: 2 }] },
              ]);
            }
            return target.batch(stmts);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const r = await refusal(startPipelineRun(deps({ db: drizzle(binding), envOverrides: V110 }), input(s)));
    expect(fired).toBe(true);
    expect(r.code).toBe("volume_pages_changed");
    expect(r.detail).toEqual({ volume_ids: [a.id] });
    expect((await first("SELECT held_by_run_id FROM pipeline_volumes WHERE id = ?", a.id)).held_by_run_id).toBeNull();
    const listed = await env.SPEC_BUCKET.list({ prefix: `${DEFAULT_TEST_TENANT_ID}/pipeline-runs/` });
    expect(listed.objects).toHaveLength(0);

    // Started again, the run reads the new rotation.
    const { runId } = await startPipelineRun(deps({ envOverrides: V110 }), input(s));
    expect(turnsOf((await storedSpec(runId)).json.volumes[0])).toEqual([undefined, undefined, 2]);
  });

  // --- The review purge ------------------------------------------------------

  async function purgeSetup() {
    const s = await setup({ count: 2, reviewBucket: REVIEW_BUCKET });
    await realFormMasters();
    const [a, b] = s.seeded.volumes;
    // An earlier delivery, superseded, and the current one, whose records
    // are all still captured so capture QC does not hold the volume.
    const current = await delivery(a.id, a.referenceCode, SINGLE_AND_SPREAD, { status: "captured" });
    const earlier = await delivery(a.id, a.referenceCode, SINGLE_AND_SPREAD, { supersededBy: current, status: "captured" });
    const earlierPrefix = await reviewRow(a.id, earlier, { createdAt: 1 });
    const currentPrefix = await reviewRow(a.id, current, { createdAt: 2 });
    // A second review run of the current delivery names the same prefix.
    await reviewRow(a.id, current, { createdAt: 3 });
    // A purged row and a failed one, which a purge run retries, are not named.
    const purged = await delivery(a.id, a.referenceCode, SINGLE_AND_SPREAD, { supersededBy: current, status: "captured" });
    await reviewRow(a.id, purged, { createdAt: 0, purgeStatus: "purged" });
    const failed = await delivery(a.id, a.referenceCode, SINGLE_AND_SPREAD, { supersededBy: current, status: "captured" });
    await reviewRow(a.id, failed, { createdAt: 0, purgeStatus: "failed" });
    return { s, a, b, prefixes: [earlierPrefix, currentPrefix] };
  }

  it("names the review bucket and each volume's unpurged review prefixes under v1.1.0", async () => {
    const { s, a, b, prefixes } = await purgeSetup();
    const { runId } = await startPipelineRun(deps({ envOverrides: V110 }), input(s));
    const { json } = await storedSpec(runId);
    expect(json.review).toEqual({ backend: "b2", endpoint: TEST_DELIVERY_ENDPOINT, bucket: REVIEW_BUCKET });
    const byId = Object.fromEntries(json.volumes.map((v: Json) => [v.volume_id, v]));
    expect(byId[a.id].review_purge).toEqual(prefixes);
    expect("review_purge" in byId[b.id]).toBe(false);
    // The strict bucket and endpoint rules hold for every store it names.
    expect(() => validateRunSpec(json)).not.toThrow();
    expect(json.working.endpoint).toBe(B2_HOST);
    expect(json.volumes.every((v: Json) => v.source.endpoint === B2_HOST)).toBe(true);
  });

  it("names neither without a review-tiles bucket, nor below v1.1.0 with one", async () => {
    const { s } = await purgeSetup();
    await seedTenantDestination(DEFAULT_TEST_TENANT_ID, { ...TEST_DESTINATION, pipelineReviewTilesBucket: null });
    const noBucket = await startPipelineRun(deps({ envOverrides: V110 }), input(s));
    const { text: noBucketText } = await storedSpec(noBucket.runId);
    expect(noBucketText).not.toMatch(REVIEW_FIELD);

    await env.DB.prepare("UPDATE pipeline_runs SET status = 'error', token_revoked_at = ? WHERE id = ?")
      .bind(Date.now(), noBucket.runId)
      .run();
    await env.DB.prepare("UPDATE pipeline_volumes SET held_by_run_id = NULL").run();
    await seedTenantDestination(DEFAULT_TEST_TENANT_ID, { ...TEST_DESTINATION, pipelineReviewTilesBucket: REVIEW_BUCKET });
    const old = await startPipelineRun(deps(), input(s));
    const { text: oldText, json } = await storedSpec(old.runId);
    expect(json.runner.script_version).toBe("v1.0.0");
    expect(oldText).not.toMatch(REVIEW_FIELD);
  });

  it("refuses the test configuration's working endpoint under the strict rules as dispatch_unconfigured", async () => {
    const { s } = await purgeSetup();
    // Only the script version: the working endpoint stays `.test.example`.
    const r = await refusal(startPipelineRun(deps({ envOverrides: { PIPELINE_SCRIPT_VERSION: "v1.1.0" } }), input(s)));
    expect(r.code).toBe("dispatch_unconfigured");
    expect(r.detail).toEqual({ invalid: ["PIPELINE_WORKING_S3_ENDPOINT"] });
    expect(await first("SELECT COUNT(*) AS n FROM pipeline_runs WHERE kind = 'volume_run'")).toEqual({ n: 0 });
  });

  it("answers 400 naming the column, not 500, for a destination bucket the strict rules refuse", async () => {
    const { s } = await purgeSetup();
    // Complete as the destination check reads it, but not a bare B2 name.
    await seedTenantDestination(DEFAULT_TEST_TENANT_ID, {
      ...TEST_DESTINATION,
      pipelineTilesBucket: "old_bucket",
      pipelineReviewTilesBucket: REVIEW_BUCKET,
    });
    const request = new Request(`${ORIGIN}/admin/media/runs/start`, {
      method: "POST",
      body: JSON.stringify({
        pipelineVolumeIds: s.seeded.volumes.map((v) => v.id),
        kind: "volume_run",
        purpose: "sample",
        maxReviewFrac: 0.1,
      }),
    });
    const res = await startRunAction(deps({ envOverrides: V110 }), request, s.tenant, s.user);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "tenant_destination_unset", invalid: ["pipeline_tiles_bucket"] });
    expect(await first("SELECT COUNT(*) AS n FROM pipeline_runs WHERE kind = 'volume_run'")).toEqual({ n: 0 });
    const listed = await env.SPEC_BUCKET.list({ prefix: `${DEFAULT_TEST_TENANT_ID}/pipeline-runs/` });
    expect(listed.objects).toHaveLength(0);

    // The same bucket below v1.1.0 is not held to the rules, as before.
    expect((await startPipelineRun(deps({ envOverrides: { PIPELINE_WORKING_S3_ENDPOINT: B2_HOST } }), input(s))).runId).toBeTruthy();
  });

  it("answers 400 with volume_source_invalid for a volume whose masters endpoint breaks the rules", async () => {
    const { s, a, b } = await purgeSetup();
    await env.DB.prepare("UPDATE pipeline_volumes SET masters_endpoint = ? WHERE id = ?")
      .bind("https://s3.example.test", b.id)
      .run();
    const r = await refusal(startPipelineRun(deps({ envOverrides: V110 }), input(s)));
    expect(r.code).toBe("volume_source_invalid");
    expect(r.detail).toEqual({ volume_ids: [b.id], invalid: ["masters_endpoint"] });

    const request = new Request(`${ORIGIN}/admin/media/runs/start`, {
      method: "POST",
      body: JSON.stringify({ pipelineVolumeIds: [a.id, b.id], kind: "volume_run", purpose: "sample", maxReviewFrac: 0.1 }),
    });
    const res = await startRunAction(deps({ envOverrides: V110 }), request, s.tenant, s.user);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "volume_source_invalid", volume_ids: [b.id], invalid: ["masters_endpoint"] });
    expect(JSON.stringify(body)).not.toContain("s3.example.test");

    // Nothing claimed, recorded or stored.
    expect(await first("SELECT COUNT(*) AS n FROM pipeline_runs WHERE kind = 'volume_run'")).toEqual({ n: 0 });
    expect(
      await first("SELECT COUNT(*) AS n FROM pipeline_volumes WHERE held_by_run_id IS NOT NULL AND id IN (?, ?)", a.id, b.id),
    ).toEqual({ n: 0 });
    const listed = await env.SPEC_BUCKET.list({ prefix: `${DEFAULT_TEST_TENANT_ID}/pipeline-runs/` });
    expect(listed.objects).toHaveLength(0);
  });

  it("names a review bucket shared with the tiles bucket before a volume's invalid masters endpoint", async () => {
    const { s, b } = await purgeSetup();
    await env.DB.prepare("UPDATE pipeline_volumes SET masters_endpoint = ? WHERE id = ?")
      .bind("https://s3.example.test", b.id)
      .run();
    await seedTenantDestination(DEFAULT_TEST_TENANT_ID, {
      ...TEST_DESTINATION,
      pipelineReviewTilesBucket: TEST_DESTINATION.pipelineTilesBucket,
    });
    const r = await refusal(startPipelineRun(deps({ envOverrides: V110 }), input(s)));
    expect(r.code).toBe("tenant_destination_unset");
    expect(r.detail).toEqual({ invalid: ["pipeline_review_tiles_bucket"] });
    expect(await first("SELECT COUNT(*) AS n FROM pipeline_runs WHERE kind = 'volume_run'")).toEqual({ n: 0 });
  });

  it("refuses a review bucket that is also the tiles bucket, naming the review column", async () => {
    const { s } = await purgeSetup();
    await seedTenantDestination(DEFAULT_TEST_TENANT_ID, {
      ...TEST_DESTINATION,
      pipelineReviewTilesBucket: TEST_DESTINATION.pipelineTilesBucket,
    });
    const r = await refusal(startPipelineRun(deps({ envOverrides: V110 }), input(s)));
    expect(r.code).toBe("tenant_destination_unset");
    expect(r.detail).toEqual({ invalid: ["pipeline_review_tiles_bucket"] });
  });

  it("purges only rows of the volume's own deliveries under the tenant's own prefix, and logs the rest by id", async () => {
    const { s, a, b, prefixes } = await purgeSetup();
    // Volume b's delivery, and a row that names volume a with it.
    const bDelivery = await delivery(b.id, b.referenceCode, SINGLE_AND_SPREAD, { status: "captured" });
    const crossed = await reviewRow(a.id, bDelivery, { createdAt: 4 });
    // A row of volume a's own current delivery naming another tenant's prefix.
    const aCurrent = await first<{ id: string }>(
      "SELECT id FROM capture_deliveries WHERE pipeline_volume_id = ? AND state = 'registered'",
      a.id,
    );
    const foreign = "other-tenant/other-delivery/";
    await reviewRow(a.id, aCurrent.id, { createdAt: 5, prefix: foreign });
    // A row of volume b's own delivery with its own prefix stays.
    const bOwn = await reviewRow(b.id, bDelivery, { createdAt: 6 });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const read = await readReviewPurges(drizzle(env.DB), s.tenant, [a.id, b.id]);
      expect(read.get(a.id)).toEqual(prefixes);
      expect(read.get(b.id)).toEqual([bOwn]);
      const lines = warn.mock.calls.map((c) => c.join(" "));
      expect(lines).toHaveLength(2);
      expect(lines.every((l) => l.includes(a.id))).toBe(true);
      expect(lines.some((l) => l.includes(bDelivery))).toBe(true);
      expect(lines.some((l) => l.includes(crossed) || l.includes(foreign))).toBe(false);

      const { runId } = await startPipelineRun(deps({ envOverrides: V110 }), input(s));
      const { text, json } = await storedSpec(runId);
      const byId = Object.fromEntries(json.volumes.map((v: Json) => [v.volume_id, v]));
      expect(byId[a.id].review_purge).toEqual(prefixes);
      expect(byId[b.id].review_purge).toEqual([bOwn]);
      expect(text).not.toContain(foreign);
    } finally {
      warn.mockRestore();
    }
  });

  it("records the purge a processing report gives for the prefixes the spec named", async () => {
    const { s, a, prefixes } = await purgeSetup();
    const { runId } = await startPipelineRun(deps({ envOverrides: V110 }), input(s, { pipelineVolumeIds: [a.id] }));
    const { json } = await storedSpec(runId);
    const named: string[] = json.volumes[0].review_purge;
    expect(named).toEqual(prefixes);

    const run = { tenantId: DEFAULT_TEST_TENANT_ID, runId } as SeededRun;
    const volume = { id: a.id, referenceCode: a.referenceCode, pageKeys: a.pageKeys } as SeededVolume;
    const body = makeVolumeCallback(run, volume);
    body.review_purge = {
      status: "failed",
      prefixes: named,
      failed: [{ prefix: named[1], message: "access denied" }],
    };
    const request = new Request(`${ORIGIN}/api/pipeline/runs/${runId}/volumes/${a.id}/callback`, {
      method: "POST",
      headers: callbackHeaders(json.callback.token, body),
      body: JSON.stringify(body),
    });
    const res = (await callbackAction({
      request,
      params: { runId, volumeId: a.id },
      context: {
        cloudflare: {
          env: { DB: env.DB, BUCKET: env.BUCKET, PIPELINE_CALLBACK_ORIGIN: ORIGIN, PIPELINE_WORKING_BUCKET: "test-working" },
          ctx: { waitUntil: () => {} },
        },
      },
    } as any)) as Response;
    expect(res.status, await res.clone().text()).toBe(200);

    const rows = (
      await env.DB.prepare(
        "SELECT review_prefix, purge_status, purged_at FROM capture_review_runs WHERE pipeline_volume_id = ? AND review_prefix IN (?, ?)",
      )
        .bind(a.id, named[0], named[1])
        .all<Json>()
    ).results;
    const byPrefix = Object.fromEntries(rows.map((r) => [`${r.review_prefix}|${r.purge_status}`, r]));
    expect(rows.filter((r) => r.review_prefix === named[0]).every((r) => r.purge_status === "purged" && r.purged_at !== null)).toBe(true);
    expect(rows.filter((r) => r.review_prefix === named[1]).every((r) => r.purge_status === "failed")).toBe(true);
    expect(Object.keys(byPrefix)).toHaveLength(2);
    // Nothing of the volume is left for a processing run to purge.
    expect((await readReviewPurges(drizzle(env.DB), s.tenant, [a.id])).has(a.id)).toBe(false);
  });
});

// @version v0.8.0
