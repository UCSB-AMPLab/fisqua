/**
 * Tests — registering capture volumes from a capture manifest
 *
 * This suite pins the command that registers the volumes of a Captua
 * capture manifest with the media pipeline. The manifests are built
 * here; the tenant, the federation's record and the masters bucket come
 * from the in-memory providers of the storage commands
 * (`tests/import/tenant-storage-fakes.ts`), and the database is an
 * in-memory SQLite built from the real migration files that create the
 * pipeline's volume and page tables (0082), add the page digest
 * (0092), the page revision and the capture link's tables (0093),
 * capture QC's (0094), the delivery route (0095), the retake's
 * carried approvals and fetches (0100), the image's rotation (0109) and
 * the delivery's rejected records (0110), behind stand-ins
 * for the tables they reference. Nothing here
 * reaches D1, B2 or a shell.
 *
 *   - the manifest: a valid one parses, at any version `1.N` from 1.1; a
 *     wrong contract, a version 1.0, of another major or malformed, or a
 *     wrong kind, a malformed digest, a preview key without its digest, and a
 *     repeated stem or reference code refuse the whole file, naming each
 *     problem; an image's `rotateDeg` of 0, 90, 180 or 270 passes, null
 *     is read as absent, and any other value, on an image of any record
 *     status, rejects its volume alone (`rotate-deg`), leaving the
 *     file's other volumes;
 *   - the planner: pages in record `sequence` order, left before right,
 *     a single image alone, `rejected` records left out; the preview is
 *     the master where there is one, with its digest, otherwise the
 *     capture; null and unknown `externalId`, a record still `captured`,
 *     keys outside `{slug}/{stem}/`, bad filenames and record roles, a
 *     volume past `received` or held by an open run are each reported
 *     and not registered;
 *   - the inventory: a missing master rejects the volume; objects the
 *     manifest does not name are reported with their sizes; volume
 *     folders under `{slug}/` that are neither in the manifest nor
 *     registered for the tenant are reported, and nothing else;
 *   - the SQL: every statement names the tenant in each table it reads
 *     or writes; applied to the database, it registers new volumes,
 *     replaces the pages of a `received` volume in one file, leaves a
 *     volume that left `received` untouched, and touches no other
 *     tenant's rows; pages and images go at most 100 to a statement;
 *   - the delivery: each registered volume's manifest is recorded with
 *     route `file` and no scanner, under the manifest's id, or for a
 *     multi-volume file a UUIDv5 of the manifest's id and the stem, with
 *     its records, its openings and rejected records counted, every
 *     image with its `rotate_deg` (null where the manifest gives none)
 *     and the link's answer; a newer manifest
 *     supersedes it; a volume any run has named is left alone; an image
 *     whose capture is missing has no size and a note; a volume with a
 *     statement past what D1 takes is set aside and the others are
 *     written; a 5,000-page volume stays within D1's statement size; a
 *     delivery already recorded is answered first (a replay, or
 *     `id_reused` for another body), before the volume's state or
 *     objects are checked;
 *   - the command: a dry run writes only the report; `--apply` writes
 *     one SQL file, applies it, re-reads the counts and writes the
 *     report; `--apply` needs B2 credentials, and against production
 *     `--confirm-production`; a transfer root other than `{slug}/`
 *     stops it.
 *
 * Every value here is a test value: no real tenant, bucket, endpoint,
 * reference code or digest.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ProvisionStop, type DestinationValues } from "../../scripts/lib/tenant-storage";
import {
  applyInventory,
  parseCaptureManifest,
  planPages,
  planVolumes,
  registerCaptureVolumes,
  registrationSql,
  reportPath,
  sqlPath,
  unlistedVolumes,
  type CaptureManifest,
  type ExistingVolume,
  type PlannedVolume,
  type RegistrationProviders,
} from "../../scripts/lib/capture-registration";
import { parseArgs } from "../../scripts/commands/register-capture-volumes";
import {
  fileDeliveryId,
  FILE_DELIVERY_NAMESPACE,
  MAX_FILE_STATEMENT_BYTES,
  uuidV5,
} from "../../app/lib/capture/file-route.server";
import { fakeWorld, FAKE_B2_S3, FAKE_R2_S3, FAKE_TENANT_ID } from "./tenant-storage-fakes";

const SLUG = "sbmal";
const ROOT = `${SLUG}/`;
const OTHER_TENANT = "22222222-bbbb-4bbb-8bbb-222222222222";
const MANIFEST_ID = "3f0c9a52-7d1e-4b8a-9c3e-5a6b7c8d9e0f";
const NOW = 1_800_000_000_000;

const RECORD: DestinationValues = {
  pipeline_delivery_endpoint: FAKE_B2_S3,
  pipeline_tiles_bucket: "acme-iiif-tiles",
  pipeline_masters_bucket: "acme-masters",
  pipeline_image_base_url: "https://iiif.acme.example.test",
  manifest_endpoint: FAKE_R2_S3,
  manifest_bucket: "acme-manifests",
  manifest_base_url: "https://manifests.acme.example.test",
  storage_secret_prefix: "FEDERATION_ACME",
};
const MASTERS_BUCKET_ID = "bucket-masters";

// ---------------------------------------------------------------------------
// Fixture manifests
// ---------------------------------------------------------------------------

const digest = (label: string) => createHash("sha256").update(label).digest("hex");
const pad = (n: number) => String(n).padStart(4, "0");

type Json = Record<string, any>;

/** One image of a stem: capture number `n`, camera `c`, with a preview unless `jpegOnly`. */
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
  return { captuaRecordId: id, sequence, status, rejectionNote: status === "rejected" ? "out of focus" : null, images };
}

function vol(externalId: string | null, stem: string, records: Json[]): Json {
  return { externalId, captuaCollectionId: records.length + 1, stem, title: `Test volume ${stem}`, records };
}

/**
 * The first volume: a spread opening (sequence 2, listed first, right
 * before left), a single opening (sequence 1), a rejected spread
 * (sequence 3) and a retake approved at sequence 4, JPEG only.
 */
function firstVolume(stem = "co-test-001"): Json {
  return vol("co-test-001", stem, [
    rec(12, 2, "approved", [image(stem, 2, 1, "right"), image(stem, 2, 0, "left")]),
    rec(11, 1, "in_review", [image(stem, 1, 0, "single")]),
    rec(13, 3, "rejected", [image(stem, 3, 0, "left"), image(stem, 3, 1, "right")]),
    rec(14, 4, "approved", [image(stem, 5, 0, "single", { jpegOnly: true })]),
  ]);
}

function manifest(volumes: Json[], overrides: Json = {}): Json {
  return {
    contract: "fisqua-captua-exchange",
    version: "1.1",
    kind: "capture-manifest",
    id: MANIFEST_ID,
    generatedAt: "2026-10-20T12:00:00Z",
    generatedBy: { system: "captua", instance: "rig-1", systemVersion: "0.1.0" },
    inReplyTo: null,
    project: { captuaProjectId: 1, name: "Test project" },
    transfer: { channel: "upload", root: ROOT },
    volumes,
    ...overrides,
  };
}

/** Every object key the manifest names, as the masters bucket would hold them, 1000 bytes each. */
function objectsOf(m: Json): { fileName: string; contentLength: number }[] {
  const out: { fileName: string; contentLength: number }[] = [];
  for (const v of m.volumes) {
    for (const r of v.records) {
      for (const img of r.images) {
        out.push({ fileName: `${ROOT}${img.objectKey}`, contentLength: 1000 });
        if (img.previewObjectKey) out.push({ fileName: `${ROOT}${img.previewObjectKey}`, contentLength: 1000 });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

const migration = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../drizzle/${name}`, import.meta.url)), "utf8");

/** SQLite with the 0082, 0092 to 0095, 0100, 0109 and 0110 tables, behind stand-ins for the tables they reference. */
function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE tenants (id TEXT PRIMARY KEY NOT NULL)");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL)");
  db.exec(
    "CREATE TABLE descriptions (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id), " +
      "reference_code TEXT NOT NULL, UNIQUE (tenant_id, reference_code))",
  );
  db.exec(
    "CREATE TABLE pipeline_runs (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, " +
      "token_revoked_at INTEGER, token_expires_at INTEGER NOT NULL)",
  );
  db.exec(
    "CREATE TABLE pipeline_run_volumes (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, " +
      "pipeline_volume_id TEXT NOT NULL)",
  );
  db.exec(migration("0082_pipeline_recipes_and_volumes.sql"));
  db.exec(migration("0092_pipeline_page_sha256.sql"));
  db.exec(migration("0093_capture_link.sql"));
  db.exec(migration("0094_capture_qc.sql"));
  db.exec(migration("0095_capture_delivery_route.sql"));
  db.exec(migration("0100_capture_qc_retakes.sql"));
  db.exec(migration("0109_capture_image_rotate_deg.sql"));
  db.exec(migration("0110_capture_rejected_records.sql"));
  for (const t of [FAKE_TENANT_ID, OTHER_TENANT]) db.prepare("INSERT INTO tenants (id) VALUES (?)").run(t);
  const desc = db.prepare("INSERT INTO descriptions (id, tenant_id, reference_code) VALUES (?, ?, ?)");
  desc.run("desc-001", FAKE_TENANT_ID, "co-test-001");
  desc.run("desc-002", FAKE_TENANT_ID, "co-test-002");
  desc.run("desc-003", FAKE_TENANT_ID, "co-test-003");
  desc.run("desc-other", OTHER_TENANT, "co-other-001");
  return db;
}

function seedVolume(
  db: DatabaseSync,
  id: string,
  opts: { tenant?: string; description?: string; code?: string; state?: string; held?: "open" | "closed"; pages?: number } = {},
): void {
  const tenant = opts.tenant ?? FAKE_TENANT_ID;
  const description = opts.description ?? "desc-001";
  const code = opts.code ?? "co-test-001";
  let heldBy: string | null = null;
  if (opts.held) {
    heldBy = `run-${id}`;
    db.prepare("INSERT INTO pipeline_runs (id, tenant_id, token_revoked_at, token_expires_at) VALUES (?, ?, ?, ?)").run(
      heldBy,
      tenant,
      opts.held === "open" ? null : NOW - 1,
      NOW + 3_600_000,
    );
  }
  const count = opts.pages ?? 2;
  db.prepare(
    "INSERT INTO pipeline_volumes (id, tenant_id, description_id, reference_code, kind, state, masters_backend, " +
      "masters_endpoint, masters_bucket, masters_prefix, expected_count, recipe_scope_description_id, held_by_run_id, " +
      "created_at, updated_at) VALUES (?, ?, ?, ?, 'volume_run', ?, 'b2', 'https://old.example.test', 'old-bucket', ?, ?, ?, ?, 1, 1)",
  ).run(id, tenant, description, code, opts.state ?? "received", `old/${code}/`, count, description, heldBy, );
  for (let i = 1; i <= count; i++) {
    db.prepare(
      "INSERT INTO pipeline_volume_pages (id, tenant_id, pipeline_volume_id, seq, page_key, master_key) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(`${id}-old-${i}`, tenant, id, i, `old-${i}`, `old/${code}/old-${i}.tif`);
  }
}

const pagesOf = (db: DatabaseSync, volumeId: string) =>
  db
    .prepare("SELECT seq, page_key, master_key, sha256, tenant_id FROM pipeline_volume_pages WHERE pipeline_volume_id = ? ORDER BY seq")
    .all(volumeId) as Array<Record<string, any>>;

const volumeOf = (db: DatabaseSync, volumeId: string) =>
  db.prepare("SELECT * FROM pipeline_volumes WHERE id = ?").get(volumeId) as Record<string, any> | undefined;

function ids(prefix = "id"): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

const deliveriesOf = (db: DatabaseSync) =>
  db.prepare("SELECT * FROM capture_deliveries ORDER BY seq").all() as Array<Record<string, any>>;

/** What the masters bucket holds under each volume's prefix, as the command lists it. */
function listingsOf(m: Json): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const o of objectsOf(m)) {
    const prefix = o.fileName.split("/").slice(0, 2).join("/") + "/";
    if (!out.has(prefix)) out.set(prefix, new Map());
    out.get(prefix)?.set(o.fileName, o.contentLength);
  }
  return out;
}

const STORE = { backend: "b2", endpoint: FAKE_B2_S3, bucket: "acme-masters" } as const;
const FILE_DIGEST = digest("the manifest file");

/** The command's statements for planned volumes of `m`, each volume's listing applied. */
async function statementsFor(m: Json, planned: PlannedVolume[]): Promise<string[]> {
  const listings = listingsOf(m);
  const { statements } = await registrationSql({
    tenantId: FAKE_TENANT_ID,
    manifest: parseCaptureManifest(m),
    volumes: applyInventory(planned, listings),
    store: STORE,
    digest: FILE_DIGEST,
    listings,
    now: NOW,
    newId: ids(),
  });
  return statements;
}

// ---------------------------------------------------------------------------
// The command's providers
// ---------------------------------------------------------------------------

function world(m: Json, opts: { b2?: boolean; db?: DatabaseSync } = {}) {
  const w = fakeWorld();
  Object.assign(w.world.d1.federations[0], RECORD);
  w.world.b2.buckets.set("acme-masters", {
    bucketId: MASTERS_BUCKET_ID,
    bucketName: "acme-masters",
    bucketType: "allPrivate",
    corsRules: [],
  });
  w.world.b2.files.set(MASTERS_BUCKET_ID, objectsOf(m));
  const db = opts.db ?? database();
  const files = new Map<string, string>();
  const applied: string[] = [];
  const providers: RegistrationProviders = {
    d1: w.providers.d1,
    rows: async (sql) => db.prepare(sql).all() as Record<string, unknown>[],
    b2: opts.b2 === false ? null : w.providers.b2,
    writeFile: (path, text) => {
      files.set(path, text);
    },
    applyFile: (path) => {
      applied.push(path);
      db.exec(files.get(path) as string);
    },
    now: () => NOW,
    newId: ids("new"),
  };
  const lines: string[] = [];
  return { ...w, db, files, applied, providers, lines, log: (l: string) => lines.push(l) };
}

async function stopped(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ProvisionStop) return err.message;
    throw err;
  }
  throw new Error("expected the command to stop");
}

function plan(m: Json, existing: ExistingVolume[] = []): PlannedVolume[] {
  const parsed = parseCaptureManifest(m);
  const descriptions = new Map(
    ["co-test-001", "co-test-002", "co-test-003"].map((code, i) => [code, { id: `desc-00${i + 1}`, referenceCode: code }]),
  );
  return planVolumes({ manifest: parsed, slug: SLUG, descriptions, existing, newId: ids("vol") });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("the capture manifest", () => {
  it.each(["1.1", "1.2", "1.5", "1.10"])("parses version %s, any minor version of major 1 from 1.1", (version) => {
    expect(parseCaptureManifest(manifest([firstVolume()], { version })).version).toBe(version);
  });

  it("parses a valid manifest and ignores fields the contract does not name", () => {
    const m = manifest([firstVolume()], { extra: { note: "ignored" } });
    const parsed: CaptureManifest = parseCaptureManifest(m);
    expect(parsed.volumes).toHaveLength(1);
    expect("extra" in parsed).toBe(false);
  });

  const REFUSED: Array<[string, () => Json, string]> = [
    ["another contract", () => manifest([firstVolume()], { contract: "other" }), "contract"],
    ["version 1.0", () => manifest([firstVolume()], { version: "1.0" }), "version"],
    ["version 2.1", () => manifest([firstVolume()], { version: "2.1" }), "version"],
    ["version 1.5.0", () => manifest([firstVolume()], { version: "1.5.0" }), "version"],
    ["version 1.05", () => manifest([firstVolume()], { version: "1.05" }), "version"],
    ["another kind", () => manifest([firstVolume()], { kind: "qc-decisions" }), "kind"],
    ["an id that is not a uuid", () => manifest([firstVolume()], { id: "../escape" }), "id"],
    [
      "a digest in upper case",
      () => {
        const v = firstVolume();
        v.records[0].images[0].sha256 = v.records[0].images[0].sha256.toUpperCase();
        return manifest([v]);
      },
      "volumes.0.records.0.images.0.sha256",
    ],
    [
      "a preview key without its digest",
      () => {
        const v = firstVolume();
        delete v.records[0].images[0].previewSha256;
        return manifest([v]);
      },
      "volumes.0.records.0.images.0",
    ],
    ["a stem twice", () => manifest([firstVolume(), { ...firstVolume(), externalId: "co-test-002" }]), "volumes.1.stem"],
    [
      "a reference code twice",
      () => manifest([firstVolume(), { ...firstVolume("co-test-002") }]),
      "volumes.1.externalId",
    ],
    ["an unknown record status", () => {
      const v = firstVolume();
      v.records[0].status = "published";
      return manifest([v]);
    }, "volumes.0.records.0.status"],
  ];

  it("refuses the whole file with a transfer root past 1,024 characters, as field-too-long", async () => {
    const m = manifest([firstVolume()], { transfer: { channel: "upload", root: "x".repeat(1_500_000) } });
    let message = "";
    try {
      parseCaptureManifest(m);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("refused whole");
    expect(message).toContain("transfer.root:");
    expect(message.length).toBeLessThan(1000);
    const { checkCaptureManifest } = await import("../../app/lib/capture/manifest");
    const checked = checkCaptureManifest(m);
    expect(checked.ok ? [] : checked.problems.map((p) => p.rule)).toEqual(["field-too-long"]);
  });

  it("keeps at most 100 problems and counts the rest, however many items are invalid", async () => {
    const { checkCaptureManifest, MAX_SHAPE_PROBLEMS } = await import("../../app/lib/capture/manifest");
    // The file route takes several volumes, so 20,000 empty ones are each checked, and bounded.
    const volumes = manifest(Array(20_000).fill({}));
    const v = checkCaptureManifest(volumes);
    expect(v.ok).toBe(false);
    const vp = v.ok ? [] : v.problems;
    expect(vp).toHaveLength(MAX_SHAPE_PROBLEMS + 1);
    // Five missing fields per volume: 100,000 problems, 100 listed.
    expect(vp[MAX_SHAPE_PROBLEMS]).toMatchObject({ rule: "problems-truncated", omitted: 99_900 });
    // On the link, more than one volume is refused before anything else.
    expect(checkCaptureManifest(volumes, { maxVolumes: 1 })).toEqual({
      ok: false,
      problems: [expect.objectContaining({ rule: "volume-count", count: 20_000 })],
    });
    const records = manifest([{ ...firstVolume(), records: Array(200_000).fill({}) }]);
    const r = checkCaptureManifest(records);
    const rp = r.ok ? [] : r.problems;
    expect(rp).toHaveLength(MAX_SHAPE_PROBLEMS + 1);
    expect(rp[0].path).toBe("volumes.0.records.0.captuaRecordId");
    expect(rp[MAX_SHAPE_PROBLEMS]).toMatchObject({ rule: "problems-truncated", omitted: 999_900 });
    let message = "";
    try {
      parseCaptureManifest(records);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.split("\n")).toHaveLength(MAX_SHAPE_PROBLEMS + 2);
  }, 60_000);

  it.each(REFUSED)("refuses the whole file with %s, naming the problem", (_name, make, path) => {
    let message = "";
    try {
      parseCaptureManifest(make());
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("refused whole");
    expect(message).toContain(`${path}:`);
  });
});

describe("an image's rotateDeg", () => {
  it.each([0, 90, 180, 270])("passes %d, on an opening's image or a rejected record's", (degrees) => {
    const v = firstVolume();
    v.records[0].images[0].rotateDeg = degrees;
    v.records[2].images[1].rotateDeg = degrees;
    const parsed = parseCaptureManifest(manifest([v]));
    expect(parsed.volumes[0].records[0].images[0].rotateDeg).toBe(degrees);
    const [planned] = plan(manifest([v]));
    expect(planned.action).toBe("register");
  });

  it("stays absent where the manifest gives none", () => {
    const parsed = parseCaptureManifest(manifest([firstVolume()]));
    expect(parsed.volumes[0].records.flatMap((r) => r.images).some((i) => "rotateDeg" in i)).toBe(false);
  });

  it("reads null as absent, and registers the volume", () => {
    const v = firstVolume();
    v.records[0].images[0].rotateDeg = null;
    v.records[2].images[1].rotateDeg = null;
    const [planned] = plan(manifest([v]));
    expect(planned.action).toBe("register");
  });

  it.each([45, -90, 360, 90.5, "90", true, [90], { deg: 90 }])(
    "rejects the volume alone for %j, on any record status, as rotate-deg",
    (degrees) => {
      const turned = firstVolume();
      // Record 13 is rejected on the unit: its images are kept all the same.
      turned.records[2].images[1].rotateDeg = degrees;
      const m = manifest([turned, firstVolume("co-test-002")]);
      m.volumes[1].externalId = "co-test-002";
      const [rejected, other] = plan(m);
      expect(rejected).toMatchObject({ action: "skip", reason: "rejected" });
      expect(rejected.issues).toEqual([
        expect.objectContaining({
          rule: "rotate-deg",
          stem: "co-test-001",
          captuaRecordId: 13,
          captureId: "cap-co-test-001-img_0003_c1",
          role: "right",
        }),
      ]);
      expect(rejected.detail?.[0]).toMatch(/^the image co-test-001-img_0003_c1\.cr3 has rotateDeg .+, not 0, 90, 180 or 270$/);
      expect(other.action).toBe("register");
    },
  );
});

describe("planning a volume's pages", () => {
  it("orders by record sequence, left before right, singles alone, and leaves rejected records out", () => {
    const parsed = parseCaptureManifest(manifest([firstVolume()]));
    const { pages, problems } = planPages(parsed.volumes[0], SLUG, ROOT);
    expect(problems).toEqual([]);
    expect(pages.map((p) => [p.seq, p.pageKey])).toEqual([
      [1, "co-test-001-img_0001_c0"],
      [2, "co-test-001-img_0002_c0"],
      [3, "co-test-001-img_0002_c1"],
      [4, "co-test-001-img_0005_c0"],
    ]);
  });

  it("takes the preview and its digest as the master where there is one, otherwise the capture", () => {
    const parsed = parseCaptureManifest(manifest([firstVolume()]));
    const { pages } = planPages(parsed.volumes[0], SLUG, ROOT);
    expect(pages[0]).toEqual({
      seq: 1,
      pageKey: "co-test-001-img_0001_c0",
      masterKey: "sbmal/co-test-001/previews/co-test-001-img_0001_c0_preview.jpg",
      sha256: digest("preview co-test-001-img_0001_c0"),
    });
    expect(pages[3]).toEqual({
      seq: 4,
      pageKey: "co-test-001-img_0005_c0",
      masterKey: "sbmal/co-test-001/captures/co-test-001-img_0005_c0.jpg",
      sha256: digest("capture co-test-001-img_0005_c0"),
    });
  });

  it("rejects a volume with a key outside {slug}/{stem}/", () => {
    const v = firstVolume();
    v.records[3].images[0].objectKey = "co-test-999/captures/co-test-001-img_0005_c0.jpg";
    const [planned] = plan(manifest([v]));
    expect(planned).toMatchObject({ action: "skip", reason: "rejected" });
    expect(planned.issues).toEqual([
      expect.objectContaining({
        rule: "capture-key",
        objectKey: "co-test-999/captures/co-test-001-img_0005_c0.jpg",
      }),
    ]);
  });

  it("rejects a capture whose key is not <stem>/captures/<filename>, such as a JPEG filename over a RAW key", () => {
    const v = firstVolume();
    v.records[3].images[0].objectKey = "co-test-001/captures/co-test-001-img_0005_c0.cr3"; // filename .jpg, no preview
    const [planned] = plan(manifest([v]));
    expect(planned).toMatchObject({ action: "skip", reason: "rejected" });
    expect(planned.issues).toEqual([
      expect.objectContaining({
        rule: "capture-key",
        objectKey: "co-test-001/captures/co-test-001-img_0005_c0.cr3",
        captureId: "cap-co-test-001-img_0005_c0",
        role: "single",
      }),
    ]);
  });

  it("rejects a preview at any key but the one the contract names for it, the RAW's own included", () => {
    for (const previewObjectKey of [
      "co-test-001/captures/co-test-001-img_0001_c0.cr3", // the RAW standing as its own preview
      "co-test-001/previews/co-test-001-img_0001_c0_preview.cr3",
      "co-test-001/previews/co-test-001-img_0002_c0_preview.jpg", // another image's
    ]) {
      const v = firstVolume();
      v.records[1].images[0].previewObjectKey = previewObjectKey;
      v.records[1].images[0].previewSha256 = v.records[1].images[0].sha256;
      const [planned] = plan(manifest([v]));
      expect(planned).toMatchObject({ action: "skip", reason: "rejected" });
      expect(planned.issues).toEqual([
        expect.objectContaining({
          rule: "preview-key",
          objectKey: previewObjectKey,
          captureId: "cap-co-test-001-img_0001_c0",
          role: "single",
        }),
      ]);
    }
  });

  it("rejects a RAW capture with no preview: Fisqua never processes a RAW", () => {
    const v = firstVolume();
    delete v.records[1].images[0].previewObjectKey;
    delete v.records[1].images[0].previewSha256;
    const [planned] = plan(manifest([v]));
    expect(planned).toMatchObject({ action: "skip", reason: "rejected" });
    expect(planned.issues).toEqual([
      expect.objectContaining({
        rule: "preview-missing",
        objectKey: "co-test-001/captures/co-test-001-img_0001_c0.cr3",
        captureId: "cap-co-test-001-img_0001_c0",
        role: "single",
      }),
    ]);
    // A JPEG-only capture is its own master.
    const jpeg = firstVolume();
    expect(plan(manifest([jpeg]))[0].action).toBe("register");
  });

  it("rejects a volume whose filename does not follow the stem, or whose record holds two singles", () => {
    const v = firstVolume();
    v.records[1].images[0].filename = "IMG_0001.cr3";
    expect(plan(manifest([v]))[0]).toMatchObject({ action: "skip", reason: "rejected" });

    const w = firstVolume();
    w.records[1].images.push(image("co-test-001", 9, 0, "single"));
    const [planned] = plan(manifest([w]));
    expect(planned.reason).toBe("rejected");
    expect(planned.detail?.[0]).toContain("not one single or a left and right");
  });

  it("rejects a volume with no record under review or approved", () => {
    const v = vol("co-test-001", "co-test-001", [rec(1, 1, "rejected", [image("co-test-001", 1, 0, "single")])]);
    expect(plan(manifest([v]))[0]).toMatchObject({ action: "skip", reason: "rejected" });
  });
});

describe("planning the volumes", () => {
  it("reports a null externalId as unmatched and an unknown one, and registers neither", () => {
    const planned = plan(
      manifest([vol(null, "on-device-1", firstVolume("on-device-1").records), vol("co-elsewhere-9", "co-elsewhere-9", [])]),
    );
    expect(planned.map((p) => [p.action, p.reason])).toEqual([
      ["skip", "unmatched"],
      ["skip", "unknown_description"],
    ]);
  });

  it("reports a volume with a record still captured as not handed over", () => {
    const v = firstVolume();
    v.records.push(rec(15, 5, "captured", [image("co-test-001", 6, 0, "single")]));
    expect(plan(manifest([v]))[0]).toMatchObject({
      action: "skip",
      reason: "not_handed_over",
      detail: ["record 15 is captured"],
    });
  });

  it("with allowCaptured, a staging test, takes captured records' images as pages", () => {
    const v = firstVolume();
    v.records.push(rec(15, 5, "captured", [image("co-test-001", 6, 0, "single")]));
    const parsed = parseCaptureManifest(manifest([v]));
    const descriptions = new Map([["co-test-001", { id: "desc-001", referenceCode: "co-test-001" }]]);
    const [planned] = planVolumes({ manifest: parsed, slug: SLUG, descriptions, existing: [], newId: ids("vol"), allowCaptured: true });
    expect(planned.action).toBe("register");
    expect(planned.pages?.some((p) => p.pageKey === "co-test-001-img_0006_c0")).toBe(true);
  });

  it("registers a new volume with its description's id and reference code", () => {
    const [planned] = plan(manifest([firstVolume()]));
    expect(planned).toMatchObject({
      action: "register",
      volumeId: "vol-1",
      descriptionId: "desc-001",
      referenceCode: "co-test-001",
      mastersPrefix: "sbmal/co-test-001/",
    });
    expect(planned.pages).toHaveLength(4);
  });

  const existing = (over: Partial<ExistingVolume> = {}): ExistingVolume => ({
    id: "pv-1",
    descriptionId: "desc-001",
    referenceCode: "co-test-001",
    kind: "volume_run",
    state: "received",
    held: false,
    ...over,
  });

  it("replaces the page list of a volume already registered and received, keeping its id", () => {
    expect(plan(manifest([firstVolume()]), [existing()])[0]).toMatchObject({ action: "replace", volumeId: "pv-1" });
  });

  it("leaves alone a volume past received, one held by an open run, an item PDF and one registered otherwise", () => {
    const m = manifest([firstVolume()]);
    expect(plan(m, [existing({ state: "prepared" })])[0]).toMatchObject({ action: "skip", reason: "not_received" });
    expect(plan(m, [existing({ held: true })])[0]).toMatchObject({ action: "skip", reason: "held_by_run" });
    expect(plan(m, [existing({ kind: "item_pdf" })])[0]).toMatchObject({ action: "skip", reason: "not_volume_run" });
    expect(plan(m, [existing({ referenceCode: "co-test-old" })])[0]).toMatchObject({
      action: "skip",
      reason: "registered_otherwise",
    });
  });
});

describe("the inventory", () => {
  it("rejects a volume whose master is missing and reports objects the manifest does not name", () => {
    const m = manifest([firstVolume(), { ...firstVolume("co-test-002"), externalId: "co-test-002" }]);
    const planned = plan(m);
    const listing = new Map(objectsOf(m).map((o) => [o.fileName, o.contentLength] as [string, number]));
    const first = new Map([...listing].filter(([k]) => k.startsWith("sbmal/co-test-001/")));
    first.set("sbmal/co-test-001/captures/stray.cr3", 42);
    const second = new Map([...listing].filter(([k]) => k.startsWith("sbmal/co-test-002/")));
    second.delete("sbmal/co-test-002/previews/co-test-002-img_0002_c1_preview.jpg");
    second.delete("sbmal/co-test-002/captures/co-test-002-img_0003_c0.cr3");

    const [a, b] = applyInventory(
      planned,
      new Map([
        ["sbmal/co-test-001/", first],
        ["sbmal/co-test-002/", second],
      ]),
    );
    expect(a.action).toBe("register");
    expect(a.inventory).toMatchObject({
      masterBytes: 4000,
      missingMasters: [],
      missingOthers: [],
      unlisted: [{ key: "sbmal/co-test-001/captures/stray.cr3", size: 42 }],
    });
    expect(b).toMatchObject({ action: "skip", reason: "missing_objects" });
    expect(b.detail).toEqual(["sbmal/co-test-002/previews/co-test-002-img_0002_c1_preview.jpg is not in the masters bucket"]);
    expect(b.inventory?.missingOthers).toEqual(["sbmal/co-test-002/captures/co-test-002-img_0003_c0.cr3"]);
  });
});

describe("volumes not in the manifest", () => {
  it("reports folders under the tenant's prefix that are neither in the manifest nor registered", () => {
    const folders = ["sbmal/co-test-001/", "sbmal/co-extra-009/", "sbmal/co-registered/", "sbmal/co-test-001/"];
    expect(unlistedVolumes(folders, SLUG, ["co-test-001"], ["sbmal/co-registered/"])).toEqual(["sbmal/co-extra-009/"]);
    expect(unlistedVolumes(["other/co-x/"], SLUG, [], [])).toEqual([]);
    expect(unlistedVolumes([`${SLUG}/db-backups/`, `${SLUG}/co-extra-009/`], SLUG, [], [])).toEqual([`${SLUG}/co-extra-009/`]);
  });
});

describe("the registration SQL", () => {
  const TABLE_REFS = /\b(?:FROM|JOIN|UPDATE|DELETE FROM)\s+"?(?:pipeline_\w+|capture_\w+|descriptions)\b/gi;
  const tenantPredicates = (sql: string, tenant: string) =>
    sql.split(new RegExp(`tenant_id"? = '${tenant}'`)).length - 1;

  it("names the tenant in every table each statement reads or writes", async () => {
    const m = manifest([firstVolume(), { ...firstVolume("co-test-002"), externalId: "co-test-002" }]);
    const planned = plan(m, [
      { id: "pv-2", descriptionId: "desc-002", referenceCode: "co-test-002", kind: "volume_run", state: "received", held: false },
    ]);
    const statements = await statementsFor(m, planned);
    // The new volume: its row, its pages, the supersede, the delivery and
    // its images; the received one: update and delete in place of the row,
    // and the six that carry a retake's unchanged approvals.
    expect(statements.length).toBe(5 + 6 + 6);
    for (const sql of statements) {
      const refs = (sql.match(TABLE_REFS) ?? []).length;
      expect(tenantPredicates(sql, FAKE_TENANT_ID), sql).toBeGreaterThanOrEqual(refs);
      expect(sql).not.toContain(OTHER_TENANT);
      if (sql.startsWith("INSERT INTO")) expect(sql).toContain(`'${FAKE_TENANT_ID}'`);
    }
  });

  it("splits long page and image lists into statements of at most 100 rows", async () => {
    const stem = "co-test-001";
    const records = Array.from({ length: 250 }, (_, i) => rec(i + 1, i + 1, "approved", [image(stem, i + 1, 0, "single")]));
    const m = manifest([vol("co-test-001", stem, records)]);
    const statements = await statementsFor(m, plan(m));
    expect(statements.filter((s) => s.startsWith("INSERT INTO pipeline_volume_pages"))).toHaveLength(3);
    expect(statements.filter((s) => s.startsWith("INSERT INTO capture_images"))).toHaveLength(3);
    const db = database();
    db.exec(statements.join("\n"));
    expect(pagesOf(db, "vol-1")).toHaveLength(250);
    expect(db.prepare("SELECT COUNT(*) AS n FROM capture_images").get()).toEqual(expect.objectContaining({ n: 250 }));
  });

  it("touches nothing of a volume id that belongs to another tenant", async () => {
    const db = database();
    seedVolume(db, "pv-other", { tenant: OTHER_TENANT, description: "desc-other", code: "co-other-001" });
    const planned = plan(manifest([firstVolume()]), [
      { id: "pv-other", descriptionId: "desc-001", referenceCode: "co-test-001", kind: "volume_run", state: "received", held: false },
    ]);
    expect(planned[0].action).toBe("replace");
    db.exec((await statementsFor(manifest([firstVolume()]), planned)).join("\n"));
    expect(pagesOf(db, "pv-other").map((p) => p.page_key)).toEqual(["old-1", "old-2"]);
    expect(volumeOf(db, "pv-other")).toMatchObject({ masters_bucket: "old-bucket", expected_count: 2 });
    expect(deliveriesOf(db)).toEqual([]);
  });

  it("leaves a volume that left received, or that an open run took, after planning, and records no delivery", async () => {
    for (const change of ["prepared", "held"] as const) {
      const db = database();
      seedVolume(db, "pv-1");
      const planned = plan(manifest([firstVolume()]), [
        { id: "pv-1", descriptionId: "desc-001", referenceCode: "co-test-001", kind: "volume_run", state: "received", held: false },
      ]);
      if (change === "prepared") db.exec("UPDATE pipeline_volumes SET state = 'prepared' WHERE id = 'pv-1'");
      else {
        db.exec(`INSERT INTO pipeline_runs VALUES ('run-late', '${FAKE_TENANT_ID}', NULL, ${NOW + 1000})`);
        db.exec("UPDATE pipeline_volumes SET held_by_run_id = 'run-late' WHERE id = 'pv-1'");
      }
      db.exec((await statementsFor(manifest([firstVolume()]), planned)).join("\n"));
      expect(pagesOf(db, "pv-1").map((p) => p.page_key), change).toEqual(["old-1", "old-2"]);
      expect(volumeOf(db, "pv-1")?.expected_count).toBe(2);
      expect(deliveriesOf(db), change).toEqual([]);
    }
  });
});

describe("registerCaptureVolumes", () => {
  it("dry run: reads, lists and plans, writes only the report, and writes nothing to the database", async () => {
    const m = manifest([firstVolume(), vol(null, "on-device-1", [])]);
    const w = world(m);
    const report = await registerCaptureVolumes(parseCaptureManifest(m), { slug: SLUG, target: "staging", apply: false }, w.providers, w.log);
    expect(report.applied).toBe(false);
    expect(report.inventory).toBe("checked");
    expect(report.volumes.map((v) => [v.stem, v.action, v.reason])).toEqual([
      ["co-test-001", "register", undefined],
      ["on-device-1", "skip", "unmatched"],
    ]);
    expect([...w.files.keys()]).toEqual([reportPath(MANIFEST_ID)]);
    expect(w.applied).toEqual([]);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM pipeline_volumes").get()).toEqual(expect.objectContaining({ n: 0 }));
    expect(w.world.calls).toContain("b2.listFiles:sbmal/co-test-001/");
    expect(w.lines.join("\n")).toContain("[register] co-test-001 (co-test-001): 4 pages under sbmal/co-test-001/, 4000 bytes of masters");
  });

  it("dry run without B2 credentials prints the inventory as unchecked; --apply refuses", async () => {
    const m = manifest([firstVolume()]);
    const w = world(m, { b2: false });
    const report = await registerCaptureVolumes(parseCaptureManifest(m), { slug: SLUG, target: "staging", apply: false }, w.providers, w.log);
    expect(report.inventory).toBe("unchecked");
    expect(w.lines.join("\n")).toContain("[unchecked] masters bucket");
    const message = await stopped(
      registerCaptureVolumes(parseCaptureManifest(m), { slug: SLUG, target: "staging", apply: true }, w.providers, w.log),
    );
    expect(message).toContain("--apply needs the operator's B2 credentials");
    expect(w.applied).toEqual([]);
  });

  it("reports a volume folder in the masters bucket that is not in the manifest or registered, and changes nothing", async () => {
    const m = manifest([firstVolume(), vol(null, "on-device-1", [])]);
    const w = world(m);
    seedVolume(w.db, "pv-registered", { description: "desc-003", code: "co-test-003" });
    w.db.prepare("UPDATE pipeline_volumes SET masters_prefix = ? WHERE id = ?").run("sbmal/co-registered/", "pv-registered");
    const files = w.world.b2.files.get(MASTERS_BUCKET_ID) ?? [];
    for (const name of [
      "sbmal/co-extra-009/captures/co-extra-009-img_0001_c0.cr3",
      "sbmal/co-registered/previews/co-registered-img_0001_c0.tif",
      "sbmal/on-device-1/captures/on-device-1-img_0001_c0.cr3",
      "sbmal/notes.txt",
      "other/co-elsewhere/captures/x.cr3",
    ]) {
      files.push({ fileName: name, contentLength: 10 });
    }
    w.world.b2.files.set(MASTERS_BUCKET_ID, files);
    const report = await registerCaptureVolumes(parseCaptureManifest(m), { slug: SLUG, target: "staging", apply: true }, w.providers, w.log);
    expect(report.unlistedVolumes).toEqual(["sbmal/co-extra-009/"]);
    expect(w.world.calls).toContain("b2.listFolders:sbmal/");
    const log = w.lines.join("\n");
    expect(log).toContain("  [unlisted] sbmal/co-extra-009/ is in the masters bucket and not in this manifest or registered");
    expect(log).not.toContain("[unlisted] sbmal/co-registered/");
    expect(log).not.toContain("[unlisted] sbmal/co-test-001/");
    expect(log).not.toContain("[unlisted] sbmal/on-device-1/");
    expect(report.volumes.map((v) => [v.stem, v.action])).toEqual([
      ["co-test-001", "register"],
      ["on-device-1", "skip"],
    ]);
    const written = w.files.get(sqlPath(MANIFEST_ID)) as string;
    expect(written).not.toContain("co-extra-009");
    expect(JSON.parse(w.files.get(reportPath(MANIFEST_ID)) as string).unlistedVolumes).toEqual(["sbmal/co-extra-009/"]);
  });

  it("without B2 credentials does not look for volumes outside the manifest", async () => {
    const m = manifest([firstVolume()]);
    const w = world(m, { b2: false });
    w.world.b2.files.get(MASTERS_BUCKET_ID)?.push({ fileName: "sbmal/co-extra-009/x.cr3", contentLength: 10 });
    const report = await registerCaptureVolumes(parseCaptureManifest(m), { slug: SLUG, target: "staging", apply: false }, w.providers, w.log);
    expect(report.unlistedVolumes).toBeUndefined();
    expect("unlistedVolumes" in JSON.parse(w.files.get(reportPath(MANIFEST_ID)) as string)).toBe(false);
    expect(w.world.calls.some((c) => c.startsWith("b2.listFolders"))).toBe(false);
    expect(w.lines.join("\n")).not.toContain("[unlisted]");
  });

  it("stops when the transfer root is not the tenant's slug prefix", async () => {
    const m = manifest([firstVolume()], { transfer: { channel: "upload", root: "other/" } });
    const w = world(m);
    expect(
      await stopped(registerCaptureVolumes(parseCaptureManifest(m), { slug: SLUG, target: "staging", apply: true }, w.providers, w.log)),
    ).toContain("transfer root other/ is not the tenant's prefix sbmal/");
  });

  it("--apply writes one SQL file, applies it, re-reads the counts and writes the report", async () => {
    const m = manifest([firstVolume()]);
    const w = world(m);
    const report = await registerCaptureVolumes(parseCaptureManifest(m), { slug: SLUG, target: "staging", apply: true }, w.providers, w.log);
    expect(w.applied).toEqual([sqlPath(MANIFEST_ID)]);
    expect(report.applied).toBe(true);
    const volumeId = report.volumes[0].volumeId as string;
    expect(report.verification).toEqual([
      { volumeId, state: "received", expectedCount: 4, pages: 4, digests: 4, deliveryId: MANIFEST_ID, ok: true },
    ]);
    expect(volumeOf(w.db, volumeId)).toMatchObject({
      tenant_id: FAKE_TENANT_ID,
      description_id: "desc-001",
      reference_code: "co-test-001",
      kind: "volume_run",
      state: "received",
      masters_backend: "b2",
      masters_endpoint: FAKE_B2_S3,
      masters_bucket: "acme-masters",
      masters_prefix: "sbmal/co-test-001/",
      masters_key: null,
      expected_count: 4,
      recipe_scope_description_id: "desc-001",
    });
    const pages = pagesOf(w.db, volumeId);
    expect(pages.map((p) => p.master_key)).toEqual([
      "sbmal/co-test-001/previews/co-test-001-img_0001_c0_preview.jpg",
      "sbmal/co-test-001/previews/co-test-001-img_0002_c0_preview.jpg",
      "sbmal/co-test-001/previews/co-test-001-img_0002_c1_preview.jpg",
      "sbmal/co-test-001/captures/co-test-001-img_0005_c0.jpg",
    ]);
    expect(pages[3].sha256).toBe(digest("capture co-test-001-img_0005_c0"));
    expect(pages.every((p) => p.tenant_id === FAKE_TENANT_ID)).toBe(true);
    const written = JSON.parse(w.files.get(reportPath(MANIFEST_ID)) as string);
    expect(written).toMatchObject({ manifestId: MANIFEST_ID, applied: true, tenant: SLUG });
    expect(w.lines.join("\n")).toContain(
      `[ok] co-test-001: 4 pages, 4 digests, expected 4, state received, delivery ${MANIFEST_ID}`,
    );
  });

  it("re-registration of a received volume replaces its pages in one file; one past received is left alone", async () => {
    const db = database();
    seedVolume(db, "pv-received", { pages: 3 });
    seedVolume(db, "pv-prepared", { description: "desc-002", code: "co-test-002", state: "prepared" });
    // The retake: the rejected opening recaptured as capture 6 and approved.
    const retaken = firstVolume();
    retaken.records[2] = rec(13, 3, "approved", [image("co-test-001", 6, 0, "left"), image("co-test-001", 6, 1, "right")]);
    const m = manifest([retaken, { ...firstVolume("co-test-002"), externalId: "co-test-002" }]);
    const w = world(m, { db });

    const report = await registerCaptureVolumes(parseCaptureManifest(m), { slug: SLUG, target: "staging", apply: true }, w.providers, w.log);
    expect(report.volumes.map((v) => [v.stem, v.action, v.reason])).toEqual([
      ["co-test-001", "replace", undefined],
      ["co-test-002", "skip", "not_received"],
    ]);
    const sql = w.files.get(sqlPath(MANIFEST_ID)) as string;
    expect(sql.indexOf('update "pipeline_volumes"')).toBeGreaterThanOrEqual(0);
    expect(sql.indexOf('update "pipeline_volumes"')).toBeLessThan(sql.indexOf("DELETE FROM pipeline_volume_pages"));
    expect(sql.indexOf("DELETE FROM pipeline_volume_pages")).toBeLessThan(sql.indexOf("INSERT INTO pipeline_volume_pages"));
    expect(pagesOf(db, "pv-received").map((p) => p.page_key)).toEqual([
      "co-test-001-img_0001_c0",
      "co-test-001-img_0002_c0",
      "co-test-001-img_0002_c1",
      "co-test-001-img_0006_c0",
      "co-test-001-img_0006_c1",
      "co-test-001-img_0005_c0",
    ]);
    expect(volumeOf(db, "pv-received")).toMatchObject({ expected_count: 6, masters_bucket: "acme-masters", state: "received" });
    // The page list was replaced, so dispatch must not claim it at the old revision.
    expect(volumeOf(db, "pv-received")).toMatchObject({ pages_revision: 1 });
    expect(volumeOf(db, "pv-prepared")).toMatchObject({ pages_revision: 0 });
    expect(pagesOf(db, "pv-prepared").map((p) => p.page_key)).toEqual(["old-1", "old-2"]);
    expect(volumeOf(db, "pv-prepared")).toMatchObject({ masters_bucket: "old-bucket", state: "prepared" });
    expect(report.verification?.[0]).toMatchObject({ volumeId: "pv-received", pages: 6, digests: 6, ok: true });
  });

  it("does not take a volume held by an open run; one whose run has closed is replaced", async () => {
    const db = database();
    seedVolume(db, "pv-open", { held: "open" });
    seedVolume(db, "pv-closed", { description: "desc-002", code: "co-test-002", held: "closed" });
    const m = manifest([firstVolume(), { ...firstVolume("co-test-002"), externalId: "co-test-002" }]);
    const w = world(m, { db });
    const report = await registerCaptureVolumes(parseCaptureManifest(m), { slug: SLUG, target: "staging", apply: true }, w.providers, w.log);
    expect(report.volumes.map((v) => [v.stem, v.action, v.reason])).toEqual([
      ["co-test-001", "skip", "held_by_run"],
      ["co-test-002", "replace", undefined],
    ]);
    expect(pagesOf(db, "pv-open")).toHaveLength(2);
    expect(pagesOf(db, "pv-closed")).toHaveLength(4);
  });

  it("writes nothing when no volume passes", async () => {
    const m = manifest([vol(null, "on-device-1", [])]);
    const w = world(m);
    const report = await registerCaptureVolumes(parseCaptureManifest(m), { slug: SLUG, target: "staging", apply: true }, w.providers, w.log);
    expect(report.applied).toBe(false);
    expect(w.applied).toEqual([]);
    expect([...w.files.keys()]).toEqual([reportPath(MANIFEST_ID)]);
  });
});

describe("the capture delivery", () => {
  const apply = (m: Json, w: ReturnType<typeof world>, opts: { bodySha256?: string } = {}) =>
    registerCaptureVolumes(parseCaptureManifest(m), { slug: SLUG, target: "staging", apply: true, ...opts }, w.providers, w.log);

  it("records a file delivery under the manifest's id, with its records, images and answer", async () => {
    const m = manifest([firstVolume()]);
    const w = world(m);
    const report = await apply(m, w, { bodySha256: FILE_DIGEST });
    const volumeId = report.volumes[0].volumeId as string;
    const [d] = deliveriesOf(w.db);
    expect(d).toMatchObject({
      tenant_id: FAKE_TENANT_ID,
      id: MANIFEST_ID,
      route: "file",
      scanner_id: null,
      reference_code: "co-test-001",
      pipeline_volume_id: volumeId,
      body_sha256: FILE_DIGEST,
      state: "registered",
      answer_status: 200,
      superseded_by: null,
      seq: 1,
      // Records 11, 12 and 14 are openings; 13 was rejected on the unit.
      openings: 3,
      rejected_records: 1,
    });
    expect(JSON.parse(d.answer_body)).toEqual({ state: "registered", manifestId: MANIFEST_ID, volumeId });
    expect(JSON.parse(d.problems)).toEqual([]);
    expect(JSON.parse(d.records).map((r: Json) => [r.captuaRecordId, r.status])).toEqual([
      [12, "approved"],
      [11, "in_review"],
      [13, "rejected"],
      [14, "approved"],
    ]);
    const images = w.db
      .prepare("SELECT captua_record_id, capture_id, page_key, capture_bytes, preview_key, preview_bytes FROM capture_images WHERE delivery_id = ? ORDER BY capture_id")
      .all(MANIFEST_ID) as Array<Record<string, any>>;
    // Every image of the manifest, the rejected opening's included.
    expect(images).toHaveLength(6);
    expect(images.every((i) => i.capture_bytes === 1000)).toBe(true);
    expect(images.find((i) => i.capture_id === "cap-co-test-001-img_0005_c0")).toMatchObject({
      captua_record_id: 14,
      preview_key: null,
      preview_bytes: null,
    });
  });

  it("records each image's rotate_deg, null where the manifest gives none", async () => {
    const v = firstVolume();
    v.records[0].images[0].rotateDeg = 270; // record 12, right
    v.records[1].images[0].rotateDeg = 0; // record 11, single
    v.records[2].images[0].rotateDeg = 90; // record 13, rejected
    v.records[2].images[1].rotateDeg = null; // record 13, read as absent
    const m = manifest([v]);
    const w = world(m);
    await apply(m, w, { bodySha256: FILE_DIGEST });
    expect(
      w.db.prepare("SELECT capture_id, rotate_deg FROM capture_images WHERE delivery_id = ? ORDER BY capture_id").all(MANIFEST_ID),
    ).toEqual([
      { capture_id: "cap-co-test-001-img_0001_c0", rotate_deg: 0 },
      { capture_id: "cap-co-test-001-img_0002_c0", rotate_deg: null },
      { capture_id: "cap-co-test-001-img_0002_c1", rotate_deg: 270 },
      { capture_id: "cap-co-test-001-img_0003_c0", rotate_deg: 90 },
      { capture_id: "cap-co-test-001-img_0003_c1", rotate_deg: null },
      { capture_id: "cap-co-test-001-img_0005_c0", rotate_deg: null },
    ]);
  });

  it("takes the body digest of the parsed manifest when the command gives none", async () => {
    const m = manifest([firstVolume()]);
    const w = world(m);
    await apply(m, w);
    expect(deliveriesOf(w.db)[0].body_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives each volume of a multi-volume file a delivery id derived from the manifest's id and its stem", async () => {
    const m = manifest([firstVolume(), { ...firstVolume("co-test-002"), externalId: "co-test-002" }]);
    const w = world(m);
    const report = await apply(m, w);
    const parsed = parseCaptureManifest(m);
    const expected = [
      await uuidV5(FILE_DELIVERY_NAMESPACE, `${MANIFEST_ID}/co-test-001`),
      await uuidV5(FILE_DELIVERY_NAMESPACE, `${MANIFEST_ID}/co-test-002`),
    ];
    expect([await fileDeliveryId(parsed, "co-test-001"), await fileDeliveryId(parsed, "co-test-002")]).toEqual(expected);
    expect(new Set(expected).size).toBe(2);
    expect(expected).not.toContain(MANIFEST_ID);
    expect(deliveriesOf(w.db).map((d) => [d.id, d.pipeline_volume_id, d.reference_code])).toEqual([
      [expected[0], report.volumes[0].volumeId, "co-test-001"],
      [expected[1], report.volumes[1].volumeId, "co-test-002"],
    ]);
    expect(report.verification?.map((v) => v.deliveryId)).toEqual(expected);
    // Each delivery's answer names its own id, the one decisions are made on.
    expect(JSON.parse(deliveriesOf(w.db)[1].answer_body).manifestId).toBe(expected[1]);
  });

  it("applies the same file again as a replay: the volume is already registered and nothing is written", async () => {
    const m = manifest([firstVolume()]);
    const w = world(m);
    await apply(m, w, { bodySha256: FILE_DIGEST });
    const report = await apply(m, w, { bodySha256: FILE_DIGEST });
    expect(report.volumes.map((v) => [v.action, v.reason])).toEqual([["skip", "already_registered"]]);
    expect(report.applied).toBe(false);
    expect(w.applied).toEqual([sqlPath(MANIFEST_ID)]);
    expect(deliveriesOf(w.db).map((d) => [d.id, d.state])).toEqual([[MANIFEST_ID, "registered"]]);
    expect(w.lines.join("\n")).toContain(`already_registered\n      delivery ${MANIFEST_ID} already holds this manifest`);
  });

  it("retries a multi-volume file once a skipped volume is put right, leaving the registered one as it was", async () => {
    const m = manifest([firstVolume(), { ...firstVolume("co-test-004"), externalId: "co-test-004" }]);
    const w = world(m);
    const first = await apply(m, w, { bodySha256: FILE_DIGEST });
    expect(first.volumes.map((v) => [v.stem, v.action, v.reason])).toEqual([
      ["co-test-001", "register", undefined],
      ["co-test-004", "skip", "unknown_description"],
    ]);
    w.db.prepare("INSERT INTO descriptions (id, tenant_id, reference_code) VALUES (?, ?, ?)").run("desc-004", FAKE_TENANT_ID, "co-test-004");
    const retry = await apply(m, w, { bodySha256: FILE_DIGEST });
    expect(retry.volumes.map((v) => [v.stem, v.action, v.reason])).toEqual([
      ["co-test-001", "skip", "already_registered"],
      ["co-test-004", "register", undefined],
    ]);
    expect(retry.verification).toEqual([expect.objectContaining({ ok: true })]);
    const ids = [
      await uuidV5(FILE_DELIVERY_NAMESPACE, `${MANIFEST_ID}/co-test-001`),
      await uuidV5(FILE_DELIVERY_NAMESPACE, `${MANIFEST_ID}/co-test-004`),
    ];
    expect(deliveriesOf(w.db).map((d) => [d.id, d.state, d.reference_code])).toEqual([
      [ids[0], "registered", "co-test-001"],
      [ids[1], "registered", "co-test-004"],
    ]);
  });

  it("refuses a volume whose delivery id was recorded from another body, and registers the file's other volumes", async () => {
    const m = manifest([firstVolume(), { ...firstVolume("co-test-004"), externalId: "co-test-004" }]);
    const w = world(m);
    await apply(m, w, { bodySha256: FILE_DIGEST });
    w.db.prepare("INSERT INTO descriptions (id, tenant_id, reference_code) VALUES (?, ?, ?)").run("desc-004", FAKE_TENANT_ID, "co-test-004");
    const changed = await apply(m, w, { bodySha256: digest("a changed manifest file") });
    expect(changed.volumes.map((v) => [v.stem, v.action, v.reason])).toEqual([
      ["co-test-001", "skip", "id_reused"],
      ["co-test-004", "register", undefined],
    ]);
    expect(w.lines.join("\n")).toContain("was recorded from a different body; a changed manifest needs a new id");
    const rows = deliveriesOf(w.db);
    expect(rows.map((d) => [d.reference_code, d.state, d.body_sha256 === FILE_DIGEST])).toEqual([
      ["co-test-001", "registered", true],
      ["co-test-004", "registered", false],
    ]);
  });

  it("computes UUIDv5 as RFC 9562 does", async () => {
    // The DNS namespace and www.example.com, the RFC's own example name.
    expect(await uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
  });

  it("supersedes the volume's earlier delivery when a newer manifest replaces its pages", async () => {
    const m = manifest([firstVolume()]);
    const w = world(m);
    await apply(m, w);
    const retake = manifest([firstVolume()], { id: "4a1d0b63-8e2f-4c9b-8d4f-6b7c8d9e0f1a" });
    const report = await apply(retake, w);
    expect(report.volumes[0].action).toBe("replace");
    expect(deliveriesOf(w.db).map((d) => [d.id, d.state, d.superseded_by])).toEqual([
      [MANIFEST_ID, "superseded", "4a1d0b63-8e2f-4c9b-8d4f-6b7c8d9e0f1a"],
      ["4a1d0b63-8e2f-4c9b-8d4f-6b7c8d9e0f1a", "registered", null],
    ]);
    expect(report.verification?.[0]).toMatchObject({ deliveryId: "4a1d0b63-8e2f-4c9b-8d4f-6b7c8d9e0f1a", ok: true });
  });

  it("leaves alone a volume any run has named, as the link does, and records nothing", async () => {
    const db = database();
    seedVolume(db, "pv-ran");
    db.exec(`INSERT INTO pipeline_run_volumes VALUES ('rv-1', '${FAKE_TENANT_ID}', 'pv-ran')`);
    const m = manifest([firstVolume()]);
    const w = world(m, { db });
    const report = await apply(m, w);
    expect(report.volumes.map((v) => [v.action, v.reason, v.detail])).toEqual([["skip", "not_received", ["a run has named it"]]]);
    expect(w.applied).toEqual([]);
    expect(pagesOf(db, "pv-ran").map((p) => p.page_key)).toEqual(["old-1", "old-2"]);
    expect(deliveriesOf(db)).toEqual([]);
  });

  it("records an image whose capture is missing from the bucket with no size, and notes it", async () => {
    const m = manifest([firstVolume()]);
    const w = world(m);
    const missing = "sbmal/co-test-001/captures/co-test-001-img_0001_c0.cr3";
    w.world.b2.files.set(
      MASTERS_BUCKET_ID,
      (w.world.b2.files.get(MASTERS_BUCKET_ID) ?? []).filter((f) => f.fileName !== missing),
    );
    await apply(m, w);
    const image = w.db
      .prepare("SELECT capture_bytes, preview_bytes FROM capture_images WHERE capture_key = ?")
      .get(missing) as Record<string, any>;
    expect(image).toEqual({ capture_bytes: null, preview_bytes: 1000 });
    expect(JSON.parse(deliveriesOf(w.db)[0].problems)).toEqual([
      expect.objectContaining({ rule: "missing-object", objectKey: missing }),
    ]);
  });

  it("sets aside a volume with a statement past what D1 takes, and writes the file's other volumes", async () => {
    const stem = "co-test-001";
    // Rejected openings with notes that do not compress: the records
    // column alone outgrows one statement.
    const noise = (n: number) =>
      Array.from({ length: 23 }, (_, k) => createHash("sha512").update(`note ${n} ${k}`).digest("base64"))
        .join("")
        .slice(0, 2000);
    const records = [
      rec(1, 1, "approved", [image(stem, 1, 0, "single")]),
      ...Array.from({ length: 120 }, (_, i) => ({ ...rec(i + 2, i + 2, "rejected", [image(stem, i + 2, 0, "single")]), rejectionNote: noise(i) })),
    ];
    const m = manifest([vol("co-test-001", stem, records), { ...firstVolume("co-test-002"), externalId: "co-test-002" }]);
    const w = world(m);
    const report = await apply(m, w);
    expect(report.volumes.map((v) => [v.stem, v.action, v.reason])).toEqual([
      ["co-test-001", "skip", "too_large"],
      ["co-test-002", "register", undefined],
    ]);
    expect(report.volumes[0].detail?.[0]).toContain(`past the ${MAX_FILE_STATEMENT_BYTES} a file statement may take`);
    expect(w.applied).toEqual([sqlPath(MANIFEST_ID)]);
    expect(report.verification).toEqual([expect.objectContaining({ ok: true })]);
    expect(deliveriesOf(w.db).map((d) => d.reference_code)).toEqual(["co-test-002"]);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM pipeline_volumes WHERE reference_code = 'co-test-001'").get()).toEqual(
      expect.objectContaining({ n: 0 }),
    );
  });

  it("registers a volume of 5,000 pages with every statement within D1's 100 KB", async () => {
    const stem = "co-test-001";
    const records = Array.from({ length: 2500 }, (_, i) =>
      rec(i + 1, i + 1, "approved", [image(stem, 2 * i + 1, 0, "left"), image(stem, 2 * i + 1, 1, "right")]),
    );
    const m = manifest([vol("co-test-001", stem, records)]);
    const w = world(m);
    const report = await apply(m, w);
    expect(report.verification?.[0]).toMatchObject({ pages: 5000, digests: 5000, deliveryId: MANIFEST_ID, ok: true });
    const statements = (w.files.get(sqlPath(MANIFEST_ID)) as string).split(";\n");
    for (const statement of statements) {
      expect(Buffer.byteLength(statement)).toBeLessThanOrEqual(MAX_FILE_STATEMENT_BYTES);
    }
    // The closing guard names the batch's pages by prefix, not one by one.
    const delivery = statements.find((x) => x.startsWith("INSERT INTO capture_deliveries")) as string;
    expect(Buffer.byteLength(delivery)).toBeLessThan(20_000);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM capture_images WHERE delivery_id = ?").get(MANIFEST_ID)).toEqual(
      expect.objectContaining({ n: 5000 }),
    );
  });

  it("answers a recorded delivery before the volume's state or objects are checked", async () => {
    const m = manifest([firstVolume()]);
    const w = world(m);
    const first = await apply(m, w, { bodySha256: FILE_DIGEST });
    const volumeId = first.volumes[0].volumeId as string;
    // Processing has started, and a master has since left the bucket.
    w.db.prepare("UPDATE pipeline_volumes SET state = 'prepared' WHERE id = ?").run(volumeId);
    const master = "sbmal/co-test-001/previews/co-test-001-img_0001_c0_preview.jpg";
    w.world.b2.files.set(
      MASTERS_BUCKET_ID,
      (w.world.b2.files.get(MASTERS_BUCKET_ID) ?? []).filter((f) => f.fileName !== master),
    );
    const again = await apply(m, w, { bodySha256: FILE_DIGEST });
    expect(again.volumes.map((v) => [v.action, v.reason])).toEqual([["skip", "already_registered"]]);
    const changed = await apply(m, w, { bodySha256: digest("a changed manifest file") });
    expect(changed.volumes.map((v) => [v.action, v.reason])).toEqual([["skip", "id_reused"]]);
    expect(w.applied).toEqual([sqlPath(MANIFEST_ID)]);
    expect(w.world.calls.filter((c) => c === "b2.listFiles:sbmal/co-test-001/")).toHaveLength(1);
  });
});

describe("the command's arguments", () => {
  const base = ["--manifest", "m.json", "--tenant", SLUG];

  it("takes a dry run by default and each target", () => {
    for (const target of ["local", "staging", "production"]) {
      expect(parseArgs([...base, "--target", target])).toMatchObject({ target, apply: false });
    }
  });

  it("refuses --apply against production without --confirm-production, and a missing or unknown value", () => {
    expect(() => parseArgs([...base, "--target", "production", "--apply"])).toThrow(/--confirm-production/);
    expect(parseArgs([...base, "--target", "production", "--apply", "--confirm-production"]).apply).toBe(true);
    expect(() => parseArgs(["--tenant", SLUG, "--target", "staging"])).toThrow(/--manifest is required/);
    expect(() => parseArgs([...base, "--target", "remote"])).toThrow(/--target is required/);
    expect(parseArgs([...base, "--target", "staging", "--allow-captured"]).allowCaptured).toBe(true);
    expect(() => parseArgs([...base, "--target", "production", "--allow-captured"])).toThrow(/refused against production/);
    expect(() => parseArgs([...base, "--target", "staging", "--force"])).toThrow(/Unknown argument/);
  });
});

// @version v0.8.0
