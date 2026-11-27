/**
 * Tests — capture manifests at contract version 1.12: calibration shots
 *
 * This suite pins what Fisqua does with the two fields version 1.12 of
 * the Captua exchange contract adds to a volume of a capture manifest
 * (§13): `calibration`, the photographs of a colour reference card each
 * camera takes under the pages' light and settings, and
 * `calibrationStatus`, `present` or `skipped` with an optional
 * `skippedReason`. It drives the checks directly
 * (`checkCaptureManifest`, `planPages`, `applyInventory`) and the whole
 * delivery over the link (`handleManifestDelivery`), with an in-memory
 * S3 server standing in for the masters bucket, then records decisions
 * (`recordDecisionsAction`) and reads what the unit, the hold, the
 * viewer and the file route read. It pins:
 *
 *   - a 1.12 manifest with shots and a status accepted, each field
 *     kept, `settings` as given, a skip's reason kept only with
 *     `skipped`; the shape refusals of a shot (an unreadable
 *     `capturedAt`, `settings` that is not an object, a missing field,
 *     a preview key without its digest) and `field-too-long` for
 *     settings past `MAX_SETTINGS_BYTES`;
 *   - at 1.11 both fields ignored, however they are written, so an
 *     older manifest is read as it always has been;
 *   - a shot is never a page: the pages, the openings, the images
 *     capture QC and the review run read, the counts and the hold are
 *     those of the same volume without shots, and the volume is
 *     approved once its openings are;
 *   - the refusals: an `appliesFromCaptureId` naming no capture of the
 *     volume (`calibration-applies-from`), a shot at any key but
 *     `<stem>/calibration/<filename>` and its preview's
 *     (`calibration-key`), a shot sharing a capture id or object key with
 *     a record image or another shot, which would otherwise register it
 *     as a page too (`calibration-identity`), a shot's `rotateDeg`
 *     outside the four (`rotate-deg`), and a shot's capture or preview missing
 *     from the bucket (`calibration-object`), over the link and in the
 *     file route's inventory;
 *   - storage: the shots under the delivery in
 *     `capture_calibration_shots`, in manifest order, with their keys,
 *     digests and sizes, and the statement on the delivery; a retake's
 *     delivery keeps its own shots; a file delivery of four shots whose
 *     settings sit at the cap, full of apostrophes, registers with every
 *     statement within the file's limit and every setting kept;
 *   - the viewer's data: the statement and the number of shots, and no
 *     opening for a shot.
 *
 * Every value here is a test value: no real tenant, bucket, key, camera
 * or person.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase, seedFederations, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { createTestDescription } from "../helpers/descriptions";
import { createTestRepository } from "../helpers/repositories";
import { createTestUser } from "../helpers/auth";
import { makeUserContext } from "../helpers/context";
import { fakeS3, type FakeS3 } from "../helpers/fake-s3";
import { insertRow, seedTenantDestination, TEST_MASTERS_BUCKET, TEST_SECRET_PREFIX } from "../helpers/media-pipeline";
import { handleManifestDelivery, handleVolumeStatus, type CaptureLinkDeps } from "../../app/lib/capture/link.server";
import { recordDecisionsAction } from "../../app/lib/capture/qc.server";
import { readCaptureQcPending } from "../../app/lib/capture/hold.server";
import { loadCaptureQcVolume } from "../../app/lib/capture/viewer.server";
import { mintScannerToken } from "../../app/lib/capture/token";
import { fileRegistrationSql, MAX_FILE_STATEMENT_BYTES } from "../../app/lib/capture/file-route.server";
import { refusalKey } from "../../app/lib/capture/screens";
import {
  applyInventory,
  checkCaptureManifest,
  MAX_SETTINGS_BYTES,
  openingCount,
  planPages,
  planVolumes,
  type CaptureVolume,
} from "../../app/lib/capture/manifest";
import type { Tenant, User } from "../../app/context";

const HOST = "https://neogranadina.fisqua.test";
const SLUG = "neogranadina";
const ROOT = `${SLUG}/`;
const T0 = 1_800_000_000_000;
const CODE = "co-test-001";

type Json = Record<string, any>;

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

const digest = (label: string) => createHash("sha256").update(label).digest("hex");
const pad = (n: number) => String(n).padStart(4, "0");

function image(stem: string, n: number, c: number, role: string): Json {
  const base = `${stem}-img_${pad(n)}_c${c}`;
  return {
    captureId: `cap-${stem}-${n}`,
    pairId: role === "single" ? null : `pair-${stem}-${n}`,
    filename: `${base}.cr3`,
    role,
    objectKey: `${stem}/captures/${base}.cr3`,
    sha256: digest(`capture ${base}`),
    previewObjectKey: `${stem}/previews/${base}_preview.jpg`,
    previewSha256: digest(`preview ${base}`),
  };
}

function rec(id: number, sequence: number, status: string, images: Json[]): Json {
  return { captuaRecordId: id, sequence, status, rejectionNote: status === "rejected" ? "blurred" : null, images };
}

const spread = (stem: string, n: number) => [image(stem, n, 0, "left"), image(stem, n, 1, "right")];

/** A calibration shot by camera `c`, the `n`th set, applying from the capture of opening `from`. */
function shot(stem: string, n: number, c: number, from: number, extra: Json = {}): Json {
  const base = `${stem}-cal_${pad(n)}_c${c}`;
  return {
    captureId: `cal-${stem}-${n}-${c}`,
    filename: `${base}.cr3`,
    objectKey: `${stem}/calibration/${base}.cr3`,
    sha256: digest(`calibration ${base}`),
    previewObjectKey: `${stem}/calibration/${base}_preview.jpg`,
    previewSha256: digest(`calibration preview ${base}`),
    camera: `c${c}`,
    capturedAt: "2026-11-20T09:15:00-05:00",
    settings: { shutter: "1/60", aperture: 8, iso: 100, whiteBalance: { mode: "manual", kelvin: 5200 }, focalLength: 50 },
    appliesFromCaptureId: `cap-${stem}-${from}`,
    ...extra,
  };
}

/** Three openings: two spreads and a rejected spread, with two sets of shots (start, and from opening 2). */
function volume(stem = CODE, extra: Json = {}): Json {
  return {
    externalId: stem,
    captuaCollectionId: 7,
    stem,
    title: `Test volume ${stem}`,
    records: [rec(21, 1, "approved", spread(stem, 1)), rec(22, 2, "in_review", spread(stem, 2)), rec(23, 3, "rejected", spread(stem, 3))],
    calibration: [shot(stem, 1, 0, 1), shot(stem, 1, 1, 1), shot(stem, 2, 0, 2, { rotateDeg: 180 }), shot(stem, 2, 1, 2)],
    calibrationStatus: "present",
    ...extra,
  };
}

/** The same volume with neither field. */
function bare(stem = CODE): Json {
  const { calibration: _c, calibrationStatus: _s, ...rest } = volume(stem);
  return rest;
}

function manifest(volumes: Json[], version = "1.12"): Json {
  return {
    contract: "fisqua-captua-exchange",
    version,
    kind: "capture-manifest",
    id: crypto.randomUUID(),
    generatedAt: "2026-11-22T12:00:00Z",
    generatedBy: { system: "captua", instance: "rig-1", systemVersion: "0.3.0" },
    inReplyTo: null,
    project: { captuaProjectId: 1, name: "Test project" },
    transfer: { channel: "upload", root: ROOT },
    volumes,
  };
}

function checked(m: Json): CaptureVolume {
  const c = checkCaptureManifest(m);
  if (!c.ok) throw new Error(JSON.stringify(c.problems));
  return c.manifest.volumes[0];
}

function problemsOf(m: Json) {
  const c = checkCaptureManifest(m);
  return c.ok ? [] : c.problems;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

describe("reading a 1.12 manifest", () => {
  it("accepts the shots and the statement, keeping every field and the settings as given", () => {
    const v = checked(manifest([volume()]));
    expect(v.calibrationStatus).toBe("present");
    expect(v.calibration).toHaveLength(4);
    expect(v.calibration![0]).toEqual(shot(CODE, 1, 0, 1));
    expect(v.calibration![2].rotateDeg).toBe(180);
    expect(v.skippedReason).toBeUndefined();
  });

  it("keeps a skip's reason with skipped only, and reads null as absent", () => {
    const skipped = checked(manifest([volume(CODE, { calibration: [], calibrationStatus: "skipped", skippedReason: "Card left at the office" })]));
    expect([skipped.calibrationStatus, skipped.skippedReason, skipped.calibration]).toEqual(["skipped", "Card left at the office", []]);
    const present = checked(manifest([volume(CODE, { skippedReason: "Ignored" })]));
    expect(present.skippedReason).toBeUndefined();
    const silent = checked(manifest([volume(CODE, { calibration: null, calibrationStatus: null, skippedReason: null })]));
    expect([silent.calibrationStatus, silent.calibration, silent.skippedReason]).toEqual([undefined, undefined, undefined]);
  });

  it("refuses a shot of the wrong shape, each with its path", () => {
    const at = (field: Json) => problemsOf(manifest([volume(CODE, { calibration: [shot(CODE, 1, 0, 1, field)] })]));
    expect(at({ capturedAt: "yesterday" })).toEqual([expect.objectContaining({ rule: "shape", path: "volumes.0.calibration.0.capturedAt" })]);
    expect(at({ settings: "1/60 f8" })).toEqual([expect.objectContaining({ rule: "shape", path: "volumes.0.calibration.0.settings" })]);
    expect(at({ settings: [1, 2] })).toEqual([expect.objectContaining({ rule: "shape", path: "volumes.0.calibration.0.settings" })]);
    expect(at({ camera: undefined })).toEqual([expect.objectContaining({ rule: "shape", path: "volumes.0.calibration.0.camera" })]);
    expect(at({ sha256: "ABC" })).toEqual([expect.objectContaining({ rule: "shape", path: "volumes.0.calibration.0.sha256" })]);
    expect(at({ previewSha256: undefined })).toEqual([expect.objectContaining({ rule: "shape", path: "volumes.0.calibration.0" })]);
    expect(problemsOf(manifest([volume(CODE, { calibrationStatus: "maybe" })]))).toEqual([
      expect.objectContaining({ rule: "shape", path: "volumes.0.calibrationStatus" }),
    ]);
    expect(problemsOf(manifest([volume(CODE, { calibration: "none" })]))).toEqual([
      expect.objectContaining({ rule: "shape", path: "volumes.0.calibration" }),
    ]);
  });

  it("accepts a capturedAt without an offset, and refuses settings past their cap as field-too-long", () => {
    expect(problemsOf(manifest([volume(CODE, { calibration: [shot(CODE, 1, 0, 1, { capturedAt: "2026-11-20T09:15:00" })] })]))).toEqual([]);
    const big = { notes: "x".repeat(MAX_SETTINGS_BYTES) };
    expect(problemsOf(manifest([volume(CODE, { calibration: [shot(CODE, 1, 0, 1, { settings: big })] })]))).toEqual([
      expect.objectContaining({ rule: "field-too-long", path: "volumes.0.calibration.0.settings" }),
    ]);
  });

  it("ignores both fields at 1.11, however they are written", () => {
    const v = checked(manifest([volume(CODE, { calibration: "not a list", calibrationStatus: "maybe" })], "1.11"));
    expect([v.calibration, v.calibrationStatus]).toEqual([undefined, undefined]);
    expect(planPages(v, SLUG, ROOT).problems).toEqual([]);
  });

  it("makes no page, opening or object a master of a shot", () => {
    const withShots = checked(manifest([volume()]));
    const without = checked(manifest([bare()]));
    const plan = planPages(withShots, SLUG, ROOT);
    expect(plan.problems).toEqual([]);
    expect(plan.pages).toEqual(planPages(without, SLUG, ROOT).pages);
    expect(openingCount(withShots)).toBe(openingCount(without));
    const shotObjects = plan.objects.filter((o) => o.calibration);
    expect(shotObjects).toHaveLength(8);
    expect(shotObjects.every((o) => !o.master)).toBe(true);
    expect(plan.calibration.map((s) => s.captureId)).toEqual([
      `cal-${CODE}-1-0`,
      `cal-${CODE}-1-1`,
      `cal-${CODE}-2-0`,
      `cal-${CODE}-2-1`,
    ]);
  });

  it("refuses a shot applying from no capture of the volume, whatever its records' status, and a shot's bad rotateDeg", () => {
    // Opening 3 is rejected on the unit: its capture is still a capture of the volume.
    expect(planPages(checked(manifest([volume(CODE, { calibration: [shot(CODE, 1, 0, 3)] })])), SLUG, ROOT).issues).toEqual([]);
    const elsewhere = planPages(
      checked(manifest([volume(CODE, { calibration: [shot(CODE, 1, 0, 1, { appliesFromCaptureId: "cap-co-test-002-1" })] })])),
      SLUG,
      ROOT,
    );
    expect(elsewhere.issues).toEqual([
      expect.objectContaining({
        rule: "calibration-applies-from",
        stem: CODE,
        calibrationIndex: 0,
        captureId: `cal-${CODE}-1-0`,
        appliesFromCaptureId: "cap-co-test-002-1",
      }),
    ]);
    const turned = planPages(checked(manifest([volume(CODE, { calibration: [shot(CODE, 1, 0, 1, { rotateDeg: 45 })] })])), SLUG, ROOT);
    expect(turned.issues).toEqual([expect.objectContaining({ rule: "rotate-deg", calibrationIndex: 0 })]);
  });

  it("refuses in the inventory a volume whose shot objects are missing, as calibration-object", () => {
    const c = checkCaptureManifest(manifest([volume()]));
    if (!c.ok) throw new Error("not ok");
    const [planned] = planVolumes({
      manifest: c.manifest,
      slug: SLUG,
      descriptions: new Map([[CODE, { id: "d-1", referenceCode: CODE }]]),
      existing: [],
      newId: () => "pv-1",
    });
    const listing = new Map<string, number>(planned.objects!.map((o) => [o.key, 10]));
    const gone = `${ROOT}${CODE}/calibration/${CODE}-cal_0002_c1.cr3`;
    listing.delete(gone);
    const [inventoried] = applyInventory([planned], new Map([[planned.mastersPrefix!, listing]]));
    expect(inventoried.action).toBe("skip");
    expect(inventoried.issues).toEqual([
      {
        rule: "calibration-object",
        message: expect.any(String),
        stem: CODE,
        objectKey: `${CODE}/calibration/${CODE}-cal_0002_c1.cr3`,
        captureId: `cal-${CODE}-2-1`,
        kind: "capture",
      },
    ]);
    // Present everywhere, the shots refuse nothing and are no unlisted objects.
    listing.set(gone, 10);
    const [ok] = applyInventory([planned], new Map([[planned.mastersPrefix!, listing]]));
    expect(ok.action).toBe("register");
    expect(ok.inventory).toEqual({ masterBytes: 40, missingMasters: [], missingOthers: [], unlisted: [] });
  });

  it("refuses a shot at any key but its calibration folder's, as calibration-key", () => {
    const keyed = (extra: Json) =>
      planPages(checked(manifest([volume(CODE, { calibration: [shot(CODE, 1, 0, 1, extra)] })])), SLUG, ROOT).issues;
    const base = `${CODE}-cal_0001_c0`;
    // In the pages' folders.
    expect(keyed({ objectKey: `${CODE}/captures/${base}.cr3` })).toEqual([
      expect.objectContaining({ rule: "calibration-key", kind: "capture", objectKey: `${CODE}/captures/${base}.cr3` }),
    ]);
    expect(keyed({ previewObjectKey: `${CODE}/previews/${base}_preview.jpg` })).toEqual([
      expect.objectContaining({ rule: "calibration-key", kind: "preview", objectKey: `${CODE}/previews/${base}_preview.jpg` }),
    ]);
    // Another name than its filename's.
    expect(keyed({ objectKey: `${CODE}/calibration/card.cr3` })).toEqual([expect.objectContaining({ rule: "calibration-key", kind: "capture" })]);
    expect(keyed({ previewObjectKey: `${CODE}/calibration/${base}.jpg` })).toEqual([expect.objectContaining({ rule: "calibration-key", kind: "preview" })]);
    // A filename that is a path.
    expect(keyed({ filename: "sub/card.cr3", objectKey: `${CODE}/calibration/sub/card.cr3`, previewObjectKey: `${CODE}/calibration/sub/card_preview.jpg` })).toEqual([
      expect.objectContaining({ rule: "calibration-key", kind: "capture" }),
    ]);
    // A JPEG-only shot, with no preview, at its key.
    expect(keyed({ filename: `${base}.jpg`, objectKey: `${CODE}/calibration/${base}.jpg`, previewObjectKey: undefined, previewSha256: undefined })).toEqual([]);
  });

  it("refuses a shot whose preview name would pass 200 bytes of UTF-8, as calibration-key", () => {
    const keyed = (filename: string) =>
      planPages(
        checked(manifest([volume(CODE, { calibration: [shot(CODE, 1, 0, 1, { filename, objectKey: `${CODE}/calibration/${filename}`, previewObjectKey: `${CODE}/calibration/${filename.replace(/\.[^.]+$/, "")}_preview.jpg`, previewSha256: digest("p") })] })])),
        SLUG,
        ROOT,
      ).issues.filter((i) => i.rule === "calibration-key");
    // The filename is 200 bytes, its preview 208.
    expect(keyed("a".repeat(196) + ".cr3")).toEqual([expect.objectContaining({ rule: "calibration-key", kind: "preview" })]);
    // A stem of 188 bytes gives a preview of exactly 200.
    expect(keyed("a".repeat(188) + ".cr3")).toEqual([]);
    expect(keyed("a".repeat(189) + ".cr3")).toEqual([expect.objectContaining({ rule: "calibration-key", kind: "preview" })]);
  });

  it("refuses a shot filename that is '.', '..', or holds a slash, a backslash or a control character, as calibration-key", () => {
    const keyed = (filename: string) =>
      planPages(
        checked(manifest([volume(CODE, { calibration: [shot(CODE, 1, 0, 1, { filename, objectKey: `${CODE}/calibration/${filename}`, previewObjectKey: undefined, previewSha256: undefined })] })])),
        SLUG,
        ROOT,
      ).issues.filter((i) => i.rule === "calibration-key");
    for (const bad of [".", "..", "a/b.cr3", "a\\b.cr3", "a\u0000b.cr3", "a\tb.cr3", "a\nb.cr3", "a\u001fb.cr3", "a\u007fb.cr3"]) {
      expect(keyed(bad), JSON.stringify(bad)).toEqual([expect.objectContaining({ rule: "calibration-key", kind: "capture" })]);
    }
    // At most 200 bytes of UTF-8: 100 two-byte letters pass, one byte more is refused.
    expect(keyed("\u00e9".repeat(100))).toEqual([]);
    expect(keyed("\u00e9".repeat(100) + "a")).toEqual([expect.objectContaining({ rule: "calibration-key", kind: "capture" })]);
    // A lone surrogate has no UTF-8 form and is refused; an astral character is 4 bytes and passes.
    expect(keyed("\ud800.jpg")).toEqual([expect.objectContaining({ rule: "calibration-key", kind: "capture" })]);
    expect(keyed("a\udc00")).toEqual([expect.objectContaining({ rule: "calibration-key", kind: "capture" })]);
    expect(keyed("\ud83d\ude00.jpg")).toEqual([]);
    expect(keyed("\ud83d\ude00".repeat(50))).toEqual([]);
    expect(keyed("\ud83d\ude00".repeat(50) + "a")).toEqual([expect.objectContaining({ rule: "calibration-key", kind: "capture" })]);
    // An empty filename is refused earlier, as a shape problem.
    expect(keyed("card 1.cr3")).toEqual([]);
  });

  it("refuses a shot sharing a capture id or object key with a record image or another shot, as calibration-identity", () => {
    const identity = (calibration: Json[]) =>
      planPages(checked(manifest([volume(CODE, { calibration })])), SLUG, ROOT).issues.filter((i) => i.rule === "calibration-identity");
    const page = image(CODE, 2, 1, "right");
    expect(identity([shot(CODE, 1, 0, 1, { captureId: page.captureId })])).toEqual([
      expect.objectContaining({ calibrationIndex: 0, field: "captureId", value: page.captureId }),
    ]);
    // A record image's capture key, also refused as calibration-key.
    expect(identity([shot(CODE, 1, 0, 1, { objectKey: page.objectKey })])).toEqual([
      expect.objectContaining({ field: "objectKey", value: page.objectKey }),
    ]);
    expect(identity([shot(CODE, 1, 0, 1, { previewObjectKey: page.previewObjectKey })])).toEqual([
      expect.objectContaining({ field: "previewObjectKey", value: page.previewObjectKey }),
    ]);
    // Two shots, one capture id; two shots, one file.
    expect(identity([shot(CODE, 1, 0, 1), shot(CODE, 1, 1, 1, { captureId: `cal-${CODE}-1-0` })])).toEqual([
      expect.objectContaining({ calibrationIndex: 1, field: "captureId", value: `cal-${CODE}-1-0` }),
    ]);
    const again = { ...shot(CODE, 1, 0, 1), captureId: "cal-other" };
    expect(identity([shot(CODE, 1, 0, 1), again]).map((i) => i.field)).toEqual(["objectKey", "previewObjectKey"]);
    expect(identity([shot(CODE, 1, 0, 1), shot(CODE, 1, 1, 1)])).toEqual([]);
  });

  it("shows each new rule as a translated sentence, never as an unknown refusal", () => {
    expect(refusalKey("calibration-object")).toBe("problem.calibration_object");
    expect(refusalKey("calibration-applies-from")).toBe("problem.calibration_applies_from");
    expect(refusalKey("calibration-identity")).toBe("problem.calibration_identity");
    expect(refusalKey("calibration-key")).toBe("problem.calibration_key");
    expect(refusalKey("rotate-deg")).toBe("problem.rotate_deg");
    expect(refusalKey("missing-side")).toBe("problem.missing_side");
  });
});

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

interface World {
  deps: CaptureLinkDeps;
  s3: FakeS3;
  clock: { now: number };
  token: string;
  tenant: Tenant;
  admin: User;
}

let world: World;

const sizeOf = (key: string) => 10 + (key.length % 7);

/** Puts every object a manifest names, shots included, into the fake bucket, except `except`. */
function upload(s3: FakeS3, m: Json, except: string[] = []): void {
  for (const v of m.volumes) {
    const keys: string[] = [];
    for (const r of v.records) for (const img of r.images) keys.push(img.objectKey, img.previewObjectKey);
    if (Array.isArray(v.calibration)) for (const s of v.calibration) keys.push(s.objectKey, s.previewObjectKey);
    for (const key of keys.filter(Boolean)) {
      const full = `${ROOT}${key}`;
      if (except.includes(full)) continue;
      s3.objects.set(`${TEST_MASTERS_BUCKET}/${full}`, { bytes: new Uint8Array(sizeOf(full)), etag: "e", contentType: null, meta: {} });
    }
  }
}

async function answer(res: Response): Promise<{ status: number; json: Json | null }> {
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function send(m: Json, except: string[] = []) {
  upload(world.s3, m, except);
  const request = new Request(`${HOST}/api/capture/v1/manifests`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${world.token}` },
    body: JSON.stringify(m),
  });
  return answer(await handleManifestDelivery(world.deps, request));
}

async function deliver(m: Json) {
  const res = await send(m);
  expect(res.status).toBe(200);
  return res.json as { state: string; manifestId: string; volumeId: string };
}

const sqlRows = async (query: string, ...binds: unknown[]) =>
  (await env.DB.prepare(query).bind(...binds).all()).results as Array<Record<string, any>>;

async function decide(volumeId: string, records: Json[]) {
  const [current] = await sqlRows("SELECT id FROM capture_deliveries WHERE pipeline_volume_id = ? AND state = 'registered'", volumeId);
  const request = new Request(`${HOST}/admin/capture/volumes/${volumeId}/decisions`, {
    method: "POST",
    body: JSON.stringify({ manifestId: current.id, records }),
  });
  try {
    return await answer(
      await recordDecisionsAction(
        { db: drizzle(env.DB), now: () => world.clock.now, newId: () => crypto.randomUUID() },
        request,
        volumeId,
        world.tenant,
        world.admin,
      ),
    );
  } catch (thrown) {
    if (thrown instanceof Response) return { status: thrown.status, json: null };
    throw thrown;
  }
}

async function status(ref: string) {
  const request = new Request(`${HOST}/api/capture/v1/volumes/status?refs=${encodeURIComponent(ref)}`, {
    headers: { Authorization: `Bearer ${world.token}` },
  });
  return (await answer(await handleVolumeStatus(world.deps, request))).json!.volumes[0] as Json;
}

const held = async (volumeId: string) =>
  (await readCaptureQcPending(drizzle(env.DB), DEFAULT_TEST_TENANT_ID, [volumeId])).includes(volumeId);

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
  const { token, sha256 } = await mintScannerToken();
  await insertRow("capture_scanners", {
    id: crypto.randomUUID(),
    tenant_id: DEFAULT_TEST_TENANT_ID,
    name: "rig-1",
    token_sha256: sha256,
    token_created_at: T0,
    created_at: T0,
    updated_at: T0,
  });
  const db = drizzle(env.DB, { schema });
  const tenant = (await db.select().from(schema.tenants).where(eq(schema.tenants.id, DEFAULT_TEST_TENANT_ID)).get()) as Tenant;
  const adminRow = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true, name: "Test Admin" });
  world = {
    deps: {
      db: drizzle(env.DB),
      env: {
        [`${TEST_SECRET_PREFIX}_MASTERS_LIST_KEY_ID`]: "test-masters-list-key-id",
        [`${TEST_SECRET_PREFIX}_MASTERS_LIST_SECRET_KEY`]: "test-masters-list-secret",
      },
      fetch: s3.fetch,
      now: () => clock.now,
      newId: () => crypto.randomUUID(),
    },
    s3,
    clock,
    token,
    tenant: { ...tenant, digitizationEnabled: true } as Tenant,
    admin: makeUserContext({ id: adminRow.id, tenantId: adminRow.tenantId, email: adminRow.email, name: adminRow.name, isAdmin: true }),
  };
  await createTestDescription({ tenantId: DEFAULT_TEST_TENANT_ID, repositoryId: repo.id, descriptionLevel: "volume", referenceCode: CODE });
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

describe("delivering a 1.12 manifest", () => {
  it("stores the shots under the delivery, in manifest order, with keys, digests, sizes and settings as given", async () => {
    const m = manifest([volume()]);
    await deliver(m);
    const shots = await sqlRows("SELECT * FROM capture_calibration_shots WHERE delivery_id = ? ORDER BY seq", m.id);
    expect(shots.map((s) => [s.seq, s.capture_id, s.camera, s.applies_from_capture_id, s.rotate_deg])).toEqual([
      [1, `cal-${CODE}-1-0`, "c0", `cap-${CODE}-1`, null],
      [2, `cal-${CODE}-1-1`, "c1", `cap-${CODE}-1`, null],
      [3, `cal-${CODE}-2-0`, "c0", `cap-${CODE}-2`, 180],
      [4, `cal-${CODE}-2-1`, "c1", `cap-${CODE}-2`, null],
    ]);
    const first = shot(CODE, 1, 0, 1);
    const captureKey = `${ROOT}${first.objectKey}`;
    const previewKey = `${ROOT}${first.previewObjectKey}`;
    expect(shots[0]).toMatchObject({
      tenant_id: DEFAULT_TEST_TENANT_ID,
      filename: first.filename,
      captured_at: "2026-11-20T09:15:00-05:00",
      capture_key: captureKey,
      capture_sha256: first.sha256,
      capture_bytes: sizeOf(captureKey),
      preview_key: previewKey,
      preview_sha256: first.previewSha256,
      preview_bytes: sizeOf(previewKey),
    });
    expect(JSON.parse(shots[0].settings)).toEqual(first.settings);
    expect(shots[0].settings).toBe(JSON.stringify(first.settings));
    const [d] = await sqlRows("SELECT calibration_status, calibration_skipped_reason FROM capture_deliveries WHERE id = ?", m.id);
    expect(d).toEqual({ calibration_status: "present", calibration_skipped_reason: null });
  });

  it("registers the same pages, openings and images as the volume without shots", async () => {
    const withShots = manifest([volume()]);
    const a = await deliver(withShots);
    const read = async (volumeId: string, deliveryId: string) => ({
      pages: await sqlRows("SELECT seq, page_key, master_key FROM pipeline_volume_pages WHERE pipeline_volume_id = ? ORDER BY seq", volumeId),
      volume: (await sqlRows("SELECT expected_count FROM pipeline_volumes WHERE id = ?", volumeId))[0],
      delivery: (await sqlRows("SELECT openings, rejected_records, problems FROM capture_deliveries WHERE id = ?", deliveryId))[0],
      images: await sqlRows(
        "SELECT captua_record_id, capture_id, role, page_key, record_status FROM capture_images WHERE delivery_id = ? ORDER BY captua_record_id, role",
        deliveryId,
      ),
    });
    const seen = await read(a.volumeId, withShots.id);
    // No shot is an image of an opening, and the shots are no unlisted objects.
    expect(seen.images.some((i) => String(i.capture_id).startsWith("cal-"))).toBe(false);
    expect(seen.delivery.problems).toBe("[]");

    // The same volume without shots, under another reference code.
    const other = "co-test-002";
    const [repo] = await sqlRows("SELECT id FROM repositories WHERE tenant_id = ?", DEFAULT_TEST_TENANT_ID);
    await createTestDescription({ tenantId: DEFAULT_TEST_TENANT_ID, repositoryId: repo.id, descriptionLevel: "volume", referenceCode: other });
    const without = manifest([bare(other)]);
    const b = await deliver(without);
    const strip = (x: Awaited<ReturnType<typeof read>>) => JSON.parse(JSON.stringify(x).replaceAll(other, CODE));
    expect(seen).toEqual(strip(await read(b.volumeId, without.id)));
    expect(seen.volume.expected_count).toBe(4);
    expect(seen.delivery.openings).toBe(2);
  });

  it("decides the openings only: the volume is approved, and released, once its openings are", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE, { records: [rec(21, 1, "approved", spread(CODE, 1)), rec(22, 2, "in_review", spread(CODE, 2))] })]));
    expect(await held(volumeId)).toBe(true);
    expect(
      (
        await decide(volumeId, [
          { captuaRecordId: 21, decision: "approved" },
          { captuaRecordId: 22, decision: "approved" },
        ])
      ).status,
    ).toBe(200);
    const [set] = await sqlRows("SELECT opening_count, approved_count, state FROM capture_qc_sets");
    expect(set).toEqual({ opening_count: 2, approved_count: 2, state: "approved" });
    expect(await held(volumeId)).toBe(false);
    expect((await status(CODE)).state).toBe("approved");
  });

  it("refuses 422 calibration-applies-from a shot applying from no capture of the volume, recording no shot", async () => {
    const m = manifest([volume(CODE, { calibration: [shot(CODE, 1, 0, 9)] })]);
    const res = await send(m);
    expect(res.status).toBe(422);
    expect(res.json!.problems).toEqual([
      expect.objectContaining({ rule: "calibration-applies-from", appliesFromCaptureId: `cap-${CODE}-9`, captureId: `cal-${CODE}-1-0` }),
    ]);
    expect(await sqlRows("SELECT * FROM capture_calibration_shots")).toEqual([]);
    expect(await sqlRows("SELECT * FROM pipeline_volumes")).toEqual([]);
  });

  it("refuses 422 calibration-object a shot whose capture or preview is not in the bucket, beside any object-missing", async () => {
    const m = manifest([volume()]);
    const capture = `${ROOT}${shot(CODE, 1, 1, 1).objectKey}`;
    const preview = `${ROOT}${shot(CODE, 2, 0, 2).previewObjectKey}`;
    const page = `${ROOT}${image(CODE, 2, 0, "left").objectKey}`;
    const res = await send(m, [capture, preview, page]);
    expect(res.status).toBe(422);
    expect(res.json!.problems).toEqual([
      expect.objectContaining({ rule: "object-missing", objectKey: image(CODE, 2, 0, "left").objectKey }),
      {
        rule: "calibration-object",
        message: expect.any(String),
        stem: CODE,
        objectKey: shot(CODE, 1, 1, 1).objectKey,
        captureId: `cal-${CODE}-1-1`,
        kind: "capture",
      },
      {
        rule: "calibration-object",
        message: expect.any(String),
        stem: CODE,
        objectKey: shot(CODE, 2, 0, 2).previewObjectKey,
        captureId: `cal-${CODE}-2-0`,
        kind: "preview",
      },
    ]);
    const [d] = await sqlRows("SELECT state, answer_status FROM capture_deliveries WHERE id = ?", m.id);
    expect(d).toEqual({ state: "refused", answer_status: 422 });
    expect(await sqlRows("SELECT * FROM capture_calibration_shots")).toEqual([]);
  });

  it("refuses 422 calibration-key a shot outside the volume's calibration folder, before the bucket is listed", async () => {
    const outside = shot(CODE, 1, 0, 1, { objectKey: "co-test-002/calibration/card.cr3" });
    const res = await send(manifest([volume(CODE, { calibration: [outside] })]));
    expect(res.status).toBe(422);
    expect(res.json!.problems).toEqual([
      expect.objectContaining({ rule: "calibration-key", objectKey: "co-test-002/calibration/card.cr3", kind: "capture" }),
    ]);
  });

  it("refuses 422 calibration-identity a shot that is also a record image, registering no page and no shot", async () => {
    // The page image of opening 1, sent again as a shot: same capture id and keys.
    const page = image(CODE, 1, 0, "left");
    const twin = { ...shot(CODE, 1, 0, 1), captureId: page.captureId };
    const m = manifest([volume(CODE, { calibration: [twin] })]);
    const res = await send(m);
    expect(res.status).toBe(422);
    expect(res.json!.problems).toEqual([expect.objectContaining({ rule: "calibration-identity", field: "captureId", value: page.captureId })]);
    expect(await sqlRows("SELECT * FROM pipeline_volumes")).toEqual([]);
    expect(await sqlRows("SELECT * FROM capture_calibration_shots")).toEqual([]);
  });

  it("keeps a skip and its reason on the delivery, and stores no shot", async () => {
    const m = manifest([volume(CODE, { calibration: [], calibrationStatus: "skipped", skippedReason: "Card left at the office" })]);
    await deliver(m);
    const [d] = await sqlRows("SELECT calibration_status, calibration_skipped_reason FROM capture_deliveries WHERE id = ?", m.id);
    expect(d).toEqual({ calibration_status: "skipped", calibration_skipped_reason: "Card left at the office" });
    expect(await sqlRows("SELECT * FROM capture_calibration_shots")).toEqual([]);
  });

  it("gives a retake's delivery its own shots, and leaves the older delivery's in place", async () => {
    const first = manifest([volume()]);
    const { volumeId } = await deliver(first);
    world.clock.now = T0 + 1000;
    const second = manifest([volume(CODE, { calibration: [shot(CODE, 3, 0, 1)] })]);
    expect((await deliver(second)).volumeId).toBe(volumeId);
    const counts = await sqlRows("SELECT delivery_id, COUNT(*) AS n FROM capture_calibration_shots GROUP BY delivery_id ORDER BY n");
    expect(counts).toEqual([
      { delivery_id: second.id, n: 1 },
      { delivery_id: first.id, n: 4 },
    ]);
  });
});

describe("a manifest before 1.12", () => {
  it("is registered as it always was, its calibration fields neither checked nor stored", async () => {
    const v = volume(CODE, { calibration: [shot(CODE, 1, 0, 9, { capturedAt: "whenever" })], calibrationStatus: "skipped", skippedReason: "x" });
    const m = manifest([v], "1.11");
    // Nothing of the shot is uploaded: an older manifest's shots are never looked for.
    const res = await send(m, [
      `${ROOT}${v.calibration[0].objectKey}`,
      `${ROOT}${v.calibration[0].previewObjectKey}`,
    ]);
    expect(res.status).toBe(200);
    const [d] = await sqlRows("SELECT calibration_status, calibration_skipped_reason, problems FROM capture_deliveries WHERE id = ?", m.id);
    expect(d).toEqual({ calibration_status: null, calibration_skipped_reason: null, problems: "[]" });
    expect(await sqlRows("SELECT * FROM capture_calibration_shots")).toEqual([]);
  });

  it("is registered with a null statement when it has no calibration fields at 1.12 either", async () => {
    const m = manifest([bare()]);
    await deliver(m);
    const [d] = await sqlRows("SELECT calibration_status FROM capture_deliveries WHERE id = ?", m.id);
    expect(d.calibration_status).toBeNull();
  });
});

describe("the file route", () => {
  it("writes the shots and the statement as the link does", async () => {
    const parsed = checkCaptureManifest(manifest([volume(CODE, { calibrationStatus: "skipped", skippedReason: "Lamp 'B' out" })]));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
    const [planned] = planVolumes({
      manifest: parsed.manifest,
      slug: SLUG,
      descriptions: new Map([[CODE, { id: "d-1", referenceCode: CODE }]]),
      existing: [],
      newId: () => "pv-1",
    });
    const { statements } = await fileRegistrationSql({
      tenantId: DEFAULT_TEST_TENANT_ID,
      manifest: parsed.manifest,
      volume: planned,
      digest: "0".repeat(64),
      masters: { endpoint: "https://masters.test", bucket: TEST_MASTERS_BUCKET },
      listing: new Map(),
      now: T0,
      newId: () => crypto.randomUUID(),
    });
    const shotStatements = statements.filter((s) => s.startsWith("INSERT INTO capture_calibration_shots"));
    expect(shotStatements).toHaveLength(1);
    expect(shotStatements[0]).toContain(`cal-${CODE}-2-1`);
    const delivery = statements.find((s) => s.startsWith("INSERT INTO capture_deliveries"))!;
    expect(delivery).toContain("'skipped'");
    expect(delivery).toContain("'Lamp ''B'' out'");
  });
});

describe("a file delivery of shots with large settings", () => {
  it("registers four shots of settings at the cap, apostrophes and all, every statement within the file's limit", async () => {
    // Each settings object just under MAX_SETTINGS_BYTES as JSON, full of
    // apostrophes, which SQL text doubles and bound JSON does not.
    const settings = (c: number) => {
      const s: Json = { camera: `c${c}`, note: "" };
      s.note = "o'k ".repeat(Math.floor((MAX_SETTINGS_BYTES - JSON.stringify(s).length) / 4));
      return s;
    };
    const shots = [0, 1, 2, 3].map((c) => shot(CODE, 1, c, 1, { settings: settings(c) }));
    for (const s of shots) expect(JSON.stringify(s.settings).length).toBeLessThanOrEqual(MAX_SETTINGS_BYTES);
    const parsed = checkCaptureManifest(manifest([volume(CODE, { calibration: shots })]));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
    const [description] = await sqlRows("SELECT id FROM descriptions WHERE reference_code = ?", CODE);
    const [planned] = planVolumes({
      manifest: parsed.manifest,
      slug: SLUG,
      descriptions: new Map([[CODE, { id: description.id, referenceCode: CODE }]]),
      existing: [],
      newId: () => crypto.randomUUID(),
    });
    const { statements } = await fileRegistrationSql({
      tenantId: DEFAULT_TEST_TENANT_ID,
      manifest: parsed.manifest,
      volume: planned,
      digest: "0".repeat(64),
      masters: { endpoint: "https://masters.test", bucket: TEST_MASTERS_BUCKET },
      listing: new Map(),
      now: T0,
      newId: () => crypto.randomUUID(),
    });
    for (const s of statements) expect(new TextEncoder().encode(s).length).toBeLessThanOrEqual(MAX_FILE_STATEMENT_BYTES);
    for (const s of statements) await env.DB.prepare(s).run();
    const stored = await sqlRows("SELECT seq, settings FROM capture_calibration_shots ORDER BY seq");
    expect(stored.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    stored.forEach((r, i) => expect(JSON.parse(r.settings)).toEqual(shots[i].settings));
  });
});

describe("what the viewer reads", () => {
  it("gives the statement and the number of shots, and no opening for a shot", async () => {
    const { volumeId } = await deliver(manifest([volume()]));
    const data = await loadCaptureQcVolume(drizzle(env.DB), world.tenant, world.admin, volumeId, T0);
    expect(data.delivery.calibration).toEqual({ status: "present", skippedReason: null, shots: 4 });
    expect(data.openings.map((o) => o.captuaRecordId)).toEqual([21, 22]);
    expect(data.counts).toMatchObject({ openings: 2, images: 4 });
  });

  it("says a skipped volume lacks its shots, with the reason given", async () => {
    const { volumeId } = await deliver(
      manifest([volume(CODE, { calibration: [], calibrationStatus: "skipped", skippedReason: "Card left at the office" })]),
    );
    const data = await loadCaptureQcVolume(drizzle(env.DB), world.tenant, world.admin, volumeId, T0);
    expect(data.delivery.calibration).toEqual({ status: "skipped", skippedReason: "Card left at the office", shots: 0 });
  });

  it("gives no statement for a handover that made none", async () => {
    const { volumeId } = await deliver(manifest([bare()], "1.11"));
    const data = await loadCaptureQcVolume(drizzle(env.DB), world.tenant, world.admin, volumeId, T0);
    expect(data.delivery.calibration).toEqual({ status: null, skippedReason: null, shots: 0 });
  });
});

// @version v0.9.0
