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
 *     page's file name, capture key or preview key holding a control
 *     character (refused as `filename`, ahead of its rotation, or as
 *     `capture-key` or `preview-key`), each refusal quoting the name or key
 *     with every control character written as `\uXXXX`, a calibration
 *     shot's name, the stem, the transfer root, a key outside the prefix
 *     and the inventory's missing and unlisted objects included, and a
 *     manifest with a control character in any one field, a repeated
 *     stem or external id among them, producing no message that holds
 *     one, a
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
 *     and the link's answer, and a 1.12 volume's calibration shots and
 *     statement beside its images, a shot missing from the bucket setting
 *     the volume aside as `calibration-object`; a newer manifest
 *     supersedes it, noting `sequence-reordered` when its records keep
 *     the registered delivery's ids in another relative order; a
 *     replacement whose only record is an open placeholder registered and
 *     verified against the pages and expected count the volume keeps, its
 *     revision raised, and a lost page or an unapplied file still stopping
 *     the command; a volume
 *     any run has named is left alone; an image
 *     whose capture is missing has no size and a note; a volume with a
 *     statement past what D1 takes is set aside and the others are
 *     written; a 5,000-page volume stays within D1's statement size; a
 *     delivery already recorded is answered first (a replay, or
 *     `id_reused` for another body), before the volume's state or
 *     objects are checked;
 *   - the verb, `fisqua capture register`, through which every run here
 *     goes: a plan writes the report and the SQL file and nothing to the
 *     database; an apply writes one SQL file, checks it on disk, applies
 *     it as one unit, re-reads the counts, plans again and writes the
 *     report; an apply needs B2 credentials, and against production
 *     `--confirm-production`, checked before anything is read; each run
 *     names its files on its own; a transfer root other than `{slug}/`
 *     stops it;
 *   - who acts: a digitization admin of the tenant or a staff member of
 *     its federation is accepted; an unknown user, one without capture
 *     rights, a disabled tenant and one without the digitization
 *     capability are refused; the SQL file opens with a guard on the
 *     tenant and one on the actor, each failing when what it guards
 *     changes, and an apply after such a change writes nothing.
 *
 * Every value here is a test value: no real tenant, bucket, endpoint,
 * reference code or digest.
 *
 * @version v0.9.0
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
  registrationSql,
  unlistedVolumes,
  type CaptureManifest,
  type ExistingVolume,
  type PlannedVolume,
} from "../../scripts/lib/capture-registration";
import {
  calibrationProblems,
  checkCaptureManifest,
  inventoryNotes,
  transferRootProblem,
} from "../../app/lib/capture/manifest";
import { runCaptureRegister, type CaptureRegisterProviders, type CaptureRegisterReport } from "../../scripts/lib/capture-cli/register";
import { ACTOR_MESSAGE, CAPTURE_TENANT_MESSAGE } from "../../scripts/lib/cli/access-guards";
import { d1Read } from "./d1-limits";
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
const FEDERATION_ID = "fed-acme";
const ACTOR_ID = "user-operator";
const ACTOR_EMAIL = "operator@example.test";
/** The name every run's report and SQL file share, without the extension. */
const RUN_NAME = /^\.import\/capture-register_(staging|production)_\d{8}T\d{6}Z-[0-9a-f]{8}$/;

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
    for (const shot of Array.isArray(v.calibration) ? v.calibration : []) {
      out.push({ fileName: `${ROOT}${shot.objectKey}`, contentLength: 500 });
      if (shot.previewObjectKey) out.push({ fileName: `${ROOT}${shot.previewObjectKey}`, contentLength: 500 });
    }
  }
  return out;
}

/** A calibration shot of camera `c` (contract 1.12), applying from the capture `from`, JPEG only. */
function calibrationShot(stem: string, c: number, from: string): Json {
  const filename = `${stem}-cal_0001_c${c}.jpg`;
  return {
    captureId: `cal-${stem}-${c}`,
    filename,
    objectKey: `${stem}/calibration/${filename}`,
    sha256: digest(`calibration ${filename}`),
    camera: `c${c}`,
    capturedAt: "2026-11-20T09:15:00Z",
    settings: { shutter: "1/60", iso: 100 },
    appliesFromCaptureId: from,
  };
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
  // The tenant, its federation and the acting user, with the columns the capture access check reads.
  db.exec("CREATE TABLE federations (id TEXT PRIMARY KEY NOT NULL, slug TEXT, status TEXT)");
  db.exec(
    "CREATE TABLE tenants (id TEXT PRIMARY KEY NOT NULL, slug TEXT, kind TEXT NOT NULL DEFAULT 'tenant', federation_id TEXT, status TEXT, disabled_at INTEGER, " +
      "digitization_enabled INTEGER DEFAULT 0)",
  );
  db.exec(
    "CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, email TEXT, name TEXT, tenant_id TEXT, is_admin INTEGER DEFAULT 0, " +
      "is_super_admin INTEGER DEFAULT 0, is_records_admin INTEGER DEFAULT 0, is_authorities_admin INTEGER DEFAULT 0, " +
      "is_imports_admin INTEGER DEFAULT 0, is_digitization_admin INTEGER DEFAULT 0, is_platform_admin INTEGER NOT NULL DEFAULT 0)",
  );
  db.exec("CREATE TABLE federation_memberships (id TEXT PRIMARY KEY NOT NULL, user_id TEXT, federation_id TEXT, role TEXT)");
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
  db.exec(migration("0096_capture_qc_rotation_role.sql"));
  db.exec(migration("0100_capture_qc_retakes.sql"));
  db.exec(migration("0106_capture_qc_side.sql"));
  db.exec(migration("0109_capture_image_rotate_deg.sql"));
  db.exec(migration("0110_capture_rejected_records.sql"));
  db.exec(migration("0111_capture_qc_excluded.sql"));
  db.exec(migration("0128_capture_calibration_shots.sql"));
  db.prepare("INSERT INTO federations (id, slug, status) VALUES (?, 'acme', 'active')").run(FEDERATION_ID);
  db.prepare("INSERT INTO tenants (id, slug, federation_id, status, digitization_enabled) VALUES (?, ?, ?, 'active', 1)").run(
    FAKE_TENANT_ID,
    SLUG,
    FEDERATION_ID,
  );
  db.prepare("INSERT INTO tenants (id, slug, federation_id, status, digitization_enabled) VALUES (?, 'other', ?, 'active', 1)").run(
    OTHER_TENANT,
    FEDERATION_ID,
  );
  db.prepare("INSERT INTO users (id, email, name, tenant_id, is_digitization_admin) VALUES (?, ?, 'Test Operator', ?, 1)").run(
    ACTOR_ID,
    ACTOR_EMAIL,
    FAKE_TENANT_ID,
  );
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
  let n = 0;
  const providers: CaptureRegisterProviders = {
    d1: w.providers.d1,
    rows: async (sql) => d1Read(db, sql),
    b2: opts.b2 === false ? null : w.providers.b2,
    writeFile: (path, text) => {
      files.set(path, text);
    },
    createFile: (path, text) => {
      if (files.has(path)) throw new Error(`EEXIST: ${path} already exists`);
      files.set(path, text);
    },
    readFile: (path) => files.get(path) ?? "",
    // As `wrangler d1 execute --file` applies it: every statement, or none.
    applyFile: (path) => {
      applied.push(path);
      db.exec("BEGIN");
      try {
        db.exec(files.get(path) as string);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    now: () => NOW,
    // UUID-shaped, so the run's name takes eight hex characters from the first.
    newId: () => `${(++n).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
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

/** Runs `fisqua capture register` on `m` against the world, acting as the test operator on staging. */
function register(
  m: Json,
  w: ReturnType<typeof world>,
  opts: { apply?: boolean; bodySha256?: string; target?: "staging" | "production"; confirmProduction?: boolean; actorEmail?: string } = {},
): Promise<CaptureRegisterReport> {
  return runCaptureRegister(
    { file: "manifest.json", raw: m, ...(opts.bodySha256 ? { bodySha256: opts.bodySha256 } : {}) },
    {
      target: opts.target ?? "staging",
      tenant: SLUG,
      actorEmail: opts.actorEmail ?? ACTOR_EMAIL,
      apply: opts.apply ?? false,
      confirmProduction: opts.confirmProduction ?? false,
      allowCaptured: false,
    },
    w.providers,
    w.log,
  );
}

/** The paths the world holds with `extension`, in the order they were written. */
const pathsOf = (w: ReturnType<typeof world>, extension: string) => [...w.files.keys()].filter((k) => k.endsWith(extension));
/** The last SQL file written. */
const sqlOf = (w: ReturnType<typeof world>) => w.files.get(pathsOf(w, ".sql").at(-1) as string) as string;
/** The last report written, parsed. */
const reportOf = (w: ReturnType<typeof world>) => JSON.parse(w.files.get(pathsOf(w, ".json").at(-1) as string) as string);
/** Whether every path names one run's file. */
const runFiles = (paths: string[], extension: string) => paths.every((p) => p.endsWith(extension) && RUN_NAME.test(p.slice(0, -extension.length)));

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
      expect(rejected.detail?.[0]).toMatch(/^the image "co-test-001-img_0003_c1\.cr3" has rotateDeg .+, not 0, 90, 180 or 270$/);
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

  it("refuses a page file name holding a control character as filename, and passes a Captua name", () => {
    const stem = "co-test-001";
    const named = (filename: string) => {
      const v = firstVolume();
      const base = filename.replace(/\.[^.]+$/, "");
      Object.assign(v.records[1].images[0], {
        filename,
        objectKey: `${stem}/captures/${filename}`,
        previewObjectKey: `${stem}/previews/${base}_preview.jpg`,
      });
      return planPages(parseCaptureManifest(manifest([v])).volumes[0], SLUG, ROOT).issues;
    };
    // Every control character is written as \uXXXX, so no message carries one.
    for (const [bad, shown] of [
      [`${stem}-img_0001_c0a\nb.cr3`, `"${stem}-img_0001_c0a\\u000ab.cr3"`],
      [`${stem}-img_0001_c0\t.cr3`, `"${stem}-img_0001_c0\\u0009.cr3"`],
      [`${stem}-img_0001_c0.cr3\u007f`, `"${stem}-img_0001_c0.cr3\\u007f"`],
      [`${stem}-img_0001_c0\u0000"\\.cr3`, `"${stem}-img_0001_c0\\u0000\\"\\\\.cr3"`],
    ]) {
      const issues = named(bad);
      expect(issues, JSON.stringify(bad)).toEqual([
        expect.objectContaining({
          rule: "filename",
          message: `the image's file name ${shown} holds a control character`,
          filename: bad,
          captureId: `cap-${stem}-img_0001_c0`,
        }),
      ]);
      expect(issues[0].message).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
    expect(named(`${stem}-img_0001_c0.cr3`)).toEqual([]);
  });

  it("refuses a page's file name holding a control character first, before its rotation, and quotes it escaped there too", () => {
    const v = firstVolume();
    const bad = "co-test-001-img_0001_c0.cr3\u007f";
    Object.assign(v.records[1].images[0], { filename: bad, objectKey: `co-test-001/captures/${bad}`, rotateDeg: 45 });
    const issues = planPages(parseCaptureManifest(manifest([v])).volumes[0], SLUG, ROOT).issues;
    expect(issues.map((i) => i.rule)).toEqual(["filename", "rotate-deg"]);
    expect(issues[1].message).toBe('the image "co-test-001-img_0001_c0.cr3\\u007f" has rotateDeg "45", not 0, 90, 180 or 270');
    for (const i of issues) expect(i.message).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("writes no raw control character in the stem, transfer-root, object-key, missing-object and unlisted-object refusals", () => {
    const raw = /[\u0000-\u001f\u007f]/;
    // A stem holding U+007F, and every file name and key built on it.
    const stem = "co-test-001\u007f";
    const v = vol("co-test-001", stem, [rec(1, 1, "approved", [image(stem, 1, 0, "single")])]);
    const stemIssues = planPages(parseCaptureManifest(manifest([v])).volumes[0], SLUG, ROOT).issues;
    expect(stemIssues).toContainEqual(expect.objectContaining({ rule: "stem", message: 'stem "co-test-001\\u007f" is outside the page-key pattern' }));
    for (const i of stemIssues) expect(i.message, i.rule).not.toMatch(raw);

    // A transfer root holding a newline: the root refusal, and the keys it puts outside the prefix.
    const m = manifest([firstVolume()], { transfer: { channel: "upload", root: "sbmal\n/" } });
    const parsed = parseCaptureManifest(m);
    expect(transferRootProblem(parsed, SLUG)?.message).toBe(`The manifest's transfer root "sbmal\\u000a/" is not the tenant's prefix "sbmal/"`);
    const outside = planPages(parsed.volumes[0], SLUG, "sbmal\n/").issues;
    expect(outside.map((i) => i.rule)).toContain("object-key");
    expect(outside.find((i) => i.rule === "object-key")?.message).toBe(
      '"sbmal\\u000a/co-test-001/captures/co-test-001-img_0001_c0.cr3" and "sbmal\\u000a/co-test-001/previews/co-test-001-img_0001_c0_preview.jpg" lie outside "sbmal/co-test-001/"',
    );
    for (const i of outside) expect(i.message, i.rule).not.toMatch(raw);

    // A master missing from the bucket, and a stray and a missing non-master object, each holding a tab.
    const [planned] = plan(manifest([firstVolume()]));
    planned.pages = planned.pages!.map((pg, i) => (i === 0 ? { ...pg, masterKey: "sbmal/co-test-001/previews/a\tb_preview.jpg" } : pg));
    const listed = listingsOf(manifest([firstVolume()]));
    const [missing] = applyInventory([planned], listed);
    expect(missing.issues).toEqual([
      expect.objectContaining({ rule: "missing-object", message: '"sbmal/co-test-001/previews/a\\u0009b_preview.jpg" is not in the masters bucket' }),
    ]);
    expect(missing.detail).toEqual(['"sbmal/co-test-001/previews/a\\u0009b_preview.jpg" is not in the masters bucket']);
    const notes = inventoryNotes({
      ...planned,
      inventory: { masterBytes: 0, missingMasters: [], missingOthers: ["sbmal/co-test-001/captures/c\td.cr3"], unlisted: [{ key: "sbmal/co-test-001/captures/e\tf.cr3", size: 1 }] },
    });
    expect(notes.map((n) => n.message)).toEqual([
      '"sbmal/co-test-001/captures/e\\u0009f.cr3" is in the masters bucket and not in the manifest',
      '"sbmal/co-test-001/captures/c\\u0009d.cr3" is in the manifest and not in the masters bucket',
    ]);
  });

  it("writes no raw control character in any message, whichever field of the delivery holds one", () => {
    const raw = /[\u0000-\u001f\u007f]/;
    const CTL = "\u007f\n\t\u0000";
    /** A 1.12 manifest of one volume, with a calibration shot and a record carrying a request id. */
    const base = (): Json => {
      const v = firstVolume();
      v.records[1].requestId = "req-1";
      v.calibration = [calibrationShot("co-test-001", 0, "cap-co-test-001-img_0001_c0")];
      v.calibrationStatus = "present";
      return manifest([v], { version: "1.12" });
    };
    /** Every message a delivery of `m` can produce here: the shape check, the plan, the inventory and its notes. */
    const everyMessage = (m: Json): string[] => {
      const out: string[] = [];
      const checked = checkCaptureManifest(m);
      if (!checked.ok) return checked.problems.map((p) => p.message);
      const parsed = checked.manifest;
      const root = transferRootProblem(parsed, SLUG);
      if (root) out.push(root.message);
      const descriptions = new Map(
        parsed.volumes.filter((v) => v.externalId !== null).map((v, i) => [v.externalId as string, { id: `desc-${i}`, referenceCode: v.externalId as string }]),
      );
      const planned = planVolumes({ manifest: parsed, slug: SLUG, descriptions, existing: [], newId: ids("vol") });
      const listing = listingsOf(base());
      listing.get(`${ROOT}co-test-001/`)?.set(`${ROOT}co-test-001/captures/stray${CTL}.cr3`, 1);
      for (const v of [...planned, ...applyInventory(planned, listing)]) {
        out.push(...(v.detail ?? []), ...(v.issues ?? []).map((i) => i.message), ...inventoryNotes(v).map((n) => n.message));
      }
      for (const v of parsed.volumes) {
        out.push(...calibrationProblems(v).map((p) => p.message), ...planPages(v, SLUG, parsed.transfer.root).issues.map((i) => i.message));
      }
      return out;
    };
    const at = (m: Json, path: string): [Json, string] => {
      const parts = path.split(".");
      let o: Json = m;
      for (const k of parts.slice(0, -1)) o = o[k];
      return [o, parts[parts.length - 1]];
    };
    const fields = [
      "contract", "version", "kind", "id", "generatedAt", "generatedBy.system", "generatedBy.instance",
      "generatedBy.systemVersion", "project.name", "transfer.channel", "transfer.root",
      "project.captuaProjectId", "volumes.0.captuaCollectionId", "volumes.0.records.1.captuaRecordId",
      "volumes.0.records.1.sequence",
      "volumes.0.externalId", "volumes.0.stem", "volumes.0.title", "volumes.0.calibrationStatus",
      "volumes.0.records.1.status", "volumes.0.records.1.requestId", "volumes.0.records.2.rejectionNote",
      "volumes.0.records.1.images.0.captureId", "volumes.0.records.1.images.0.filename",
      "volumes.0.records.1.images.0.role", "volumes.0.records.1.images.0.objectKey",
      "volumes.0.records.1.images.0.sha256", "volumes.0.records.1.images.0.previewObjectKey",
      "volumes.0.records.1.images.0.previewSha256", "volumes.0.records.0.images.0.pairId",
      "volumes.0.calibration.0.captureId", "volumes.0.calibration.0.filename", "volumes.0.calibration.0.objectKey",
      "volumes.0.calibration.0.sha256", "volumes.0.calibration.0.camera", "volumes.0.calibration.0.capturedAt",
      "volumes.0.calibration.0.appliesFromCaptureId", "volumes.0.calibration.0.settings.shutter",
    ];
    const cases: Array<[string, Json]> = fields.map((path) => {
      const m = base();
      const [o, k] = at(m, path);
      o[k] = `${o[k]}${CTL}`;
      return [path, m];
    });
    // Values set whole: a rotation that is a string or an object keyed by one, on an image and a shot.
    for (const path of ["volumes.0.records.1.images.0.rotateDeg", "volumes.0.calibration.0.rotateDeg"]) {
      for (const value of [CTL, { [CTL]: 1 }]) {
        const m = base();
        const [o, k] = at(m, path);
        o[k] = value;
        cases.push([`${path} = ${JSON.stringify(value)}`, m]);
      }
    }
    // The stem throughout, every file name and key built on it.
    const stemmed = firstVolume(`co-test-001${CTL}`);
    stemmed.externalId = "co-test-001";
    cases.push(["the stem throughout", manifest([stemmed])]);
    // Two volumes sharing a stem, and two sharing an external id.
    const twin = (field: "stem" | "externalId") => {
      const a = firstVolume();
      const b = firstVolume("co-test-002");
      a[field] = b[field] = `co-test-00${CTL}`;
      return manifest([a, b]);
    };
    cases.push(["a repeated stem", twin("stem")], ["a repeated external id", twin("externalId")]);

    for (const [label, m] of cases) {
      const messages = everyMessage(m);
      for (const message of messages) expect(message, `${label}: ${JSON.stringify(message)}`).not.toMatch(raw);
    }
    // Each repetition is reported, its value escaped.
    expect(everyMessage(twin("stem"))).toContain('volumes.1.stem: stem "co-test-00\\u007f\\u000a\\u0009\\u0000" appears twice');
    expect(everyMessage(twin("externalId"))).toContain('volumes.1.externalId: externalId "co-test-00\\u007f\\u000a\\u0009\\u0000" appears twice');
  });

  it("quotes a calibration shot's file name with its control characters escaped", () => {
    const v = { ...firstVolume(), calibration: [{ ...calibrationShot("co-test-001", 0, "cap-co-test-001-img_0001_c0"), filename: "a\u007f\nb.jpg", objectKey: "co-test-001/calibration/a\u007f\nb.jpg" }] };
    const [problem] = calibrationProblems(parseCaptureManifest(manifest([v], { version: "1.12" })).volumes[0]);
    expect(problem).toMatchObject({
      rule: "calibration-key",
      message: 'the calibration shot\'s file name "a\\u007f\\u000ab.jpg" is not a single path segment of at most 200 bytes without control characters',
    });
  });

  it("refuses a page's capture or preview key holding a control character, quoting the key", () => {
    const v = firstVolume();
    v.records[1].images[0].objectKey = "co-test-001/captures/co-test-001-img_0001_c0.cr3\n";
    const w = firstVolume();
    w.records[1].images[0].previewObjectKey = "co-test-001/previews/co-test-001-img_0001_c0\t_preview.jpg";
    const issuesOf = (m: Json) => planPages(parseCaptureManifest(manifest([m])).volumes[0], SLUG, ROOT).issues;
    expect(issuesOf(v)).toEqual([
      expect.objectContaining({
        rule: "capture-key",
        message: 'the capture "co-test-001-img_0001_c0.cr3" is at "co-test-001/captures/co-test-001-img_0001_c0.cr3\\u000a", which holds a control character',
      }),
    ]);
    expect(issuesOf(w)).toEqual([
      expect.objectContaining({
        rule: "preview-key",
        message: 'the preview of "co-test-001-img_0001_c0.cr3" is "co-test-001/previews/co-test-001-img_0001_c0\\u0009_preview.jpg", which holds a control character',
      }),
    ]);
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
    expect(b.detail).toEqual(['"sbmal/co-test-002/previews/co-test-002-img_0002_c1_preview.jpg" is not in the masters bucket']);
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

describe("fisqua capture register", () => {
  it("a plan reads, lists and plans, writes the report and the SQL file, and writes nothing to the database", async () => {
    const m = manifest([firstVolume(), vol(null, "on-device-1", [])]);
    const w = world(m);
    const report = await register(m, w, { apply: false });
    expect(report.applied).toBe(false);
    expect(report.inventory).toBe("checked");
    expect(report.volumes.map((v) => [v.stem, v.action, v.reason])).toEqual([
      ["co-test-001", "register", undefined],
      ["on-device-1", "skip", "unmatched"],
    ]);
    // A plan creates the SQL file for review beside the report, and applies nothing.
    expect(pathsOf(w, ".sql")).toHaveLength(1);
    expect(runFiles([...w.files.keys()].filter((k) => k.endsWith(".sql")), ".sql")).toBe(true);
    expect(pathsOf(w, ".json")).toHaveLength(1);
    expect(w.applied).toEqual([]);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM pipeline_volumes").get()).toEqual(expect.objectContaining({ n: 0 }));
    expect(w.world.calls).toContain("b2.listFiles:sbmal/co-test-001/");
    expect(w.lines.join("\n")).toContain("[register] co-test-001 (co-test-001): 4 pages under sbmal/co-test-001/, 4000 bytes of masters");
  });

  it("a plan without B2 credentials prints the inventory as unchecked; an apply refuses", async () => {
    const m = manifest([firstVolume()]);
    const w = world(m, { b2: false });
    const report = await register(m, w, { apply: false });
    expect(report.inventory).toBe("unchecked");
    expect(w.lines.join("\n")).toContain("[unchecked] masters bucket");
    const message = await stopped(
      register(m, w, { apply: true }),
    );
    expect(message).toContain("An apply needs the operator's B2 credentials");
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
    const report = await register(m, w, { apply: true });
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
    const written = sqlOf(w);
    expect(written).not.toContain("co-extra-009");
    expect(reportOf(w).unlistedVolumes).toEqual(["sbmal/co-extra-009/"]);
  });

  it("without B2 credentials does not look for volumes outside the manifest", async () => {
    const m = manifest([firstVolume()]);
    const w = world(m, { b2: false });
    w.world.b2.files.get(MASTERS_BUCKET_ID)?.push({ fileName: "sbmal/co-extra-009/x.cr3", contentLength: 10 });
    const report = await register(m, w, { apply: false });
    expect(report.unlistedVolumes).toBeUndefined();
    expect("unlistedVolumes" in reportOf(w)).toBe(false);
    expect(w.world.calls.some((c) => c.startsWith("b2.listFolders"))).toBe(false);
    expect(w.lines.join("\n")).not.toContain("[unlisted]");
  });

  it("stops when the transfer root is not the tenant's slug prefix", async () => {
    const m = manifest([firstVolume()], { transfer: { channel: "upload", root: "other/" } });
    const w = world(m);
    expect(
      await stopped(register(m, w, { apply: true })),
    ).toContain(`transfer root "other/" is not the tenant's prefix "sbmal/"`);
  });

  it("an apply writes one SQL file, applies it, re-reads the counts, plans again and writes the report", async () => {
    const m = manifest([firstVolume()]);
    const w = world(m);
    const report = await register(m, w, { apply: true });
    expect(w.applied).toHaveLength(1);
    expect(runFiles(w.applied, ".sql")).toBe(true);
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
    const written = reportOf(w);
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

    const report = await register(m, w, { apply: true });
    expect(report.volumes.map((v) => [v.stem, v.action, v.reason])).toEqual([
      ["co-test-001", "replace", undefined],
      ["co-test-002", "skip", "not_received"],
    ]);
    const sql = sqlOf(w);
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
    const report = await register(m, w, { apply: true });
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
    const report = await register(m, w, { apply: true });
    expect(report.applied).toBe(false);
    expect(w.applied).toEqual([]);
    expect(pathsOf(w, ".sql")).toEqual([]);
    expect(pathsOf(w, ".json")).toHaveLength(1);
  });
});

describe("the capture delivery", () => {
  const apply = (m: Json, w: ReturnType<typeof world>, opts: { bodySha256?: string } = {}) => register(m, w, { apply: true, ...opts });

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

  it("records a 1.12 volume's calibration shots and statement beside its images, never as images", async () => {
    const v = firstVolume();
    v.calibration = [calibrationShot("co-test-001", 0, "cap-co-test-001-img_0001_c0"), calibrationShot("co-test-001", 1, "cap-co-test-001-img_0001_c0")];
    v.calibrationStatus = "present";
    const m = manifest([v], { version: "1.12" });
    const w = world(m);
    await apply(m, w, { bodySha256: FILE_DIGEST });
    expect(
      w.db.prepare("SELECT seq, capture_id, camera, capture_bytes, settings FROM capture_calibration_shots WHERE delivery_id = ? ORDER BY seq").all(MANIFEST_ID),
    ).toEqual([
      { seq: 1, capture_id: "cal-co-test-001-0", camera: "c0", capture_bytes: 500, settings: '{"shutter":"1/60","iso":100}' },
      { seq: 2, capture_id: "cal-co-test-001-1", camera: "c1", capture_bytes: 500, settings: '{"shutter":"1/60","iso":100}' },
    ]);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM capture_images WHERE delivery_id = ?").get(MANIFEST_ID)).toEqual({ n: 6 });
    expect(deliveriesOf(w.db)[0]).toMatchObject({ openings: 3, calibration_status: "present", problems: "[]" });
  });

  it("sets aside a 1.12 volume whose calibration shot is not in the bucket, as calibration-object", async () => {
    const v = firstVolume();
    v.calibration = [calibrationShot("co-test-001", 0, "cap-co-test-001-img_0001_c0")];
    const m = manifest([v], { version: "1.12" });
    const w = world(m);
    const missing = "sbmal/co-test-001/calibration/co-test-001-cal_0001_c0.jpg";
    w.world.b2.files.set(
      MASTERS_BUCKET_ID,
      (w.world.b2.files.get(MASTERS_BUCKET_ID) ?? []).filter((f) => f.fileName !== missing),
    );
    const [planned] = applyInventory(plan(m), listingsOf({ ...m, volumes: [{ ...v, calibration: [] }] }));
    expect(planned).toMatchObject({ action: "skip", reason: "missing_calibration" });
    expect(planned.issues).toEqual([
      expect.objectContaining({ rule: "calibration-object", objectKey: "co-test-001/calibration/co-test-001-cal_0001_c0.jpg", kind: "capture" }),
    ]);
    await apply(m, w);
    expect(deliveriesOf(w.db)).toEqual([]);
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
    expect(w.applied).toHaveLength(1);
    expect(runFiles(w.applied, ".sql")).toBe(true);
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

  describe("a replacement whose only record is an open placeholder (contract 1.9)", () => {
    const REOPENED_ID = "6c3f2d85-0a4b-4ebd-8f6b-8d9e0f1a2b3c";
    /** The first volume's spread, record 12, handed back missing its left page; the rest gone. */
    const reopened = () =>
      manifest(
        [
          vol("co-test-001", "co-test-001", [
            {
              ...rec(12, 1, "missing", [image("co-test-001", 2, 1, "right")]),
              missingSide: "left",
            },
          ]),
        ],
        { id: REOPENED_ID, version: "1.9" },
      );
    const counts = (w: ReturnType<typeof world>, volumeId: string) =>
      w.db
        .prepare(
          "SELECT expected_count, pages_revision, (SELECT COUNT(*) FROM pipeline_volume_pages p WHERE p.pipeline_volume_id = v.id) AS pages FROM pipeline_volumes v WHERE id = ?",
        )
        .get(volumeId) as Record<string, number>;

    it("registers, verifies against the pages the volume keeps, and does not stop", async () => {
      const m = manifest([firstVolume()]);
      const w = world(m);
      const first = await apply(m, w);
      const volumeId = first.volumes[0].volumeId as string;
      const before = counts(w, volumeId);
      expect(before.pages).toBe(4);

      const report = await apply(reopened(), w);
      expect(report.volumes[0]).toMatchObject({ action: "replace", volumeId, pageCount: 0 });
      expect(report.verification).toEqual([
        { volumeId, state: "received", expectedCount: 4, pages: 4, digests: 4, deliveryId: REOPENED_ID, ok: true },
      ]);
      expect(counts(w, volumeId)).toEqual({ ...before, pages_revision: before.pages_revision + 1 });
      expect(deliveriesOf(w.db).map((d) => [d.id, d.state, d.openings, d.rejected_records])).toEqual([
        [MANIFEST_ID, "superseded", 3, 1],
        [REOPENED_ID, "registered", 0, 1],
      ]);
      expect(w.lines.join("\n")).toContain("[ok] co-test-001: 4 pages, 4 digests, expected 4");
    });

    it("still stops on a real mismatch: a kept page lost, or the write not landed", async () => {
      const m = manifest([firstVolume()]);
      for (const spoil of ["page", "unapplied"] as const) {
        const w = world(m);
        await apply(m, w);
        const applyFile = w.providers.applyFile;
        w.providers.applyFile = (path, statements) => {
          if (spoil === "unapplied") return;
          applyFile(path, statements);
          w.db.exec("DELETE FROM pipeline_volume_pages WHERE id = (SELECT MIN(id) FROM pipeline_volume_pages)");
        };
        expect(await stopped(apply(reopened(), w))).toBe("The re-read does not match what was written; see the report");
      }
    });
  });

  it("notes sequence-reordered on a newer manifest whose records the registered delivery holds in another order", async () => {
    const m = manifest([firstVolume()]);
    const w = world(m);
    await apply(m, w);
    // The same records unmoved: nothing noted.
    const same = manifest([firstVolume()], { id: "4a1d0b63-8e2f-4c9b-8d4f-6b7c8d9e0f1a" });
    await apply(same, w);
    expect(JSON.parse(deliveriesOf(w.db)[1].problems)).toEqual([]);
    // Records 11 and 12 swap places.
    const moved = firstVolume();
    moved.records[0].sequence = 1; // record 12
    moved.records[1].sequence = 2; // record 11
    const reordered = manifest([moved], { id: "5b2e1c74-9f3a-4dac-9e5a-7c8d9e0f1a2b" });
    const report = await apply(reordered, w);
    expect(report.volumes[0].action).toBe("replace");
    const latest = deliveriesOf(w.db)[2];
    expect([latest.id, latest.state]).toEqual(["5b2e1c74-9f3a-4dac-9e5a-7c8d9e0f1a2b", "registered"]);
    expect(JSON.parse(latest.problems)).toEqual([
      {
        rule: "sequence-reordered",
        message: "The volume's records appear in a different order from the delivery Fisqua had registered",
        stem: "co-test-001",
        referenceCode: "co-test-001",
      },
    ]);
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
    expect(w.applied).toHaveLength(1);
    expect(runFiles(w.applied, ".sql")).toBe(true);
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
    const statements = (sqlOf(w)).split(";\n");
    for (const statement of statements) {
      expect(Buffer.byteLength(statement)).toBeLessThanOrEqual(MAX_FILE_STATEMENT_BYTES);
    }
    // The closing guard names the batch's pages by prefix, not one by one:
    // the statement holds the records and a fixed text, about 20 KB here.
    const delivery = statements.find((x) => x.startsWith("INSERT INTO capture_deliveries")) as string;
    expect(Buffer.byteLength(delivery)).toBeLessThan(21_000);
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
    expect(w.applied).toHaveLength(1);
    expect(runFiles(w.applied, ".sql")).toBe(true);
    expect(w.world.calls.filter((c) => c === "b2.listFiles:sbmal/co-test-001/")).toHaveLength(1);
  });
});

describe("who acts, and the guards that open the SQL file", () => {
  /** The opening guards of a plan's SQL file that fail once `change` has run (node:sqlite reports a guard's abort as malformed JSON). */
  async function failingGuards(change: (db: DatabaseSync) => void): Promise<string[]> {
    const m = manifest([firstVolume()]);
    const w = world(m);
    await register(m, w);
    const statements = sqlOf(w).split("\n");
    const opening = statements.slice(0, statements.findIndex((x) => !x.startsWith("SELECT CASE")));
    expect(opening).toHaveLength(2);
    change(w.db);
    return opening
      .filter((x) => {
        try {
          w.db.prepare(x).all();
          return false;
        } catch {
          return true;
        }
      })
      .map((x) => /'ABORT: ((?:[^']|'')*)'/.exec(x)![1].replace(/''/g, "'"));
  }

  it("refuses an apply to production without --confirm-production before anything is read", async () => {
    const m = manifest([firstVolume()]);
    const w = world(m);
    let reads = 0;
    const rows = w.providers.rows;
    w.providers.rows = (sql) => {
      reads++;
      return rows(sql);
    };
    expect(await stopped(register(m, w, { apply: true, target: "production" }))).toBe("Applying to production also needs --confirm-production");
    expect(reads).toBe(0);
    expect(w.world.calls).toEqual([]);
    expect(w.files.size).toBe(0);
  });

  it("acts as a digitization admin of the tenant, and records the actor in the report", async () => {
    const m = manifest([firstVolume()]);
    const w = world(m);
    const report = await register(m, w, { apply: true });
    expect(report.actor).toEqual({ id: ACTOR_ID, email: ACTOR_EMAIL, actedAs: "member" });
    expect(report.problems).toEqual([]);
    expect(reportOf(w)).toMatchObject({ actor: { id: ACTOR_ID, email: ACTOR_EMAIL }, applied: true, problems: [] });
    expect(w.lines.join("\n")).toContain("Planned again: nothing is left to write.");
  });

  it("refuses an unknown actor, one without capture rights, a disabled tenant and one without the digitization capability", async () => {
    const m = manifest([firstVolume()]);
    const cases: Array<[string, (db: DatabaseSync) => void, string]> = [
      ["unknown", () => {}, "No user has the email nobody@example.test"],
      ["no rights", (db) => db.exec(`UPDATE users SET is_digitization_admin = 0 WHERE id = '${ACTOR_ID}'`),
        `${ACTOR_EMAIL} is a user of sbmal without digitization admin rights or a steward membership in its federation`],
      ["disabled", (db) => db.exec(`UPDATE tenants SET disabled_at = 1 WHERE id = '${FAKE_TENANT_ID}'`), "The tenant sbmal is disabled"],
      ["no digitization", (db) => db.exec(`UPDATE tenants SET digitization_enabled = 0 WHERE id = '${FAKE_TENANT_ID}'`),
        "The tenant sbmal does not have the digitization capability"],
    ];
    for (const [label, change, message] of cases) {
      const w = world(m);
      change(w.db);
      const got = await stopped(register(m, w, { apply: true, actorEmail: label === "unknown" ? "nobody@example.test" : ACTOR_EMAIL }));
      expect(got).toBe(message);
      expect(w.applied).toEqual([]);
      expect(w.files.size).toBe(0);
    }
  });

  it("accepts a staff member of the tenant's federation from another tenant", async () => {
    const m = manifest([firstVolume()]);
    const w = world(m);
    w.db.exec(`INSERT INTO users (id, email, tenant_id) VALUES ('user-staff', 'staff@example.test', '${OTHER_TENANT}')`);
    w.db.exec(`INSERT INTO federation_memberships (id, user_id, federation_id, role) VALUES ('m-1', 'user-staff', '${FEDERATION_ID}', 'staff')`);
    const report = await register(m, w, { apply: true, actorEmail: "staff@example.test" });
    expect(report.verification).toEqual([expect.objectContaining({ ok: true })]);
  });

  it("opens the SQL file with a guard on the tenant and one on the actor, each failing when what it guards changes", async () => {
    expect(await failingGuards(() => {})).toEqual([]);
    expect(await failingGuards((db) => db.exec(`UPDATE tenants SET digitization_enabled = 0 WHERE id = '${FAKE_TENANT_ID}'`))).toEqual([
      CAPTURE_TENANT_MESSAGE,
    ]);
    expect(await failingGuards((db) => db.exec(`UPDATE tenants SET disabled_at = 1 WHERE id = '${FAKE_TENANT_ID}'`))).toEqual([
      CAPTURE_TENANT_MESSAGE,
    ]);
    expect(await failingGuards((db) => db.exec(`UPDATE federations SET status = 'suspended' WHERE id = '${FEDERATION_ID}'`))).toEqual([
      CAPTURE_TENANT_MESSAGE,
    ]);
    expect(await failingGuards((db) => db.exec(`UPDATE users SET is_digitization_admin = 0 WHERE id = '${ACTOR_ID}'`))).toEqual([
      ACTOR_MESSAGE,
    ]);
    expect(await failingGuards((db) => db.exec(`UPDATE users SET tenant_id = '${OTHER_TENANT}' WHERE id = '${ACTOR_ID}'`))).toEqual([
      ACTOR_MESSAGE,
    ]);
    expect(
      await failingGuards((db) =>
        db.exec(`INSERT INTO federation_memberships (id, user_id, federation_id, role) VALUES ('m-2', '${ACTOR_ID}', '${FEDERATION_ID}', 'staff')`),
      ),
    ).toEqual([ACTOR_MESSAGE]);
  });

  it("writes nothing when the actor's rights change between the plan and the apply", async () => {
    const m = manifest([firstVolume()]);
    const w = world(m);
    const applyFile = w.providers.applyFile;
    w.providers.applyFile = (path, statements) => {
      w.db.exec(`UPDATE users SET is_digitization_admin = 0 WHERE id = '${ACTOR_ID}'`);
      return applyFile(path, statements);
    };
    await expect(register(m, w, { apply: true })).rejects.toThrow();
    expect(w.applied).toHaveLength(1);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM pipeline_volumes").get()).toEqual(expect.objectContaining({ n: 0 }));
    expect(deliveriesOf(w.db)).toEqual([]);
  });

  it("writes nothing when the tenant's capability changes between the plan and the apply", async () => {
    const m = manifest([firstVolume()]);
    const w = world(m);
    const applyFile = w.providers.applyFile;
    w.providers.applyFile = (path, statements) => {
      w.db.exec(`UPDATE tenants SET digitization_enabled = 0 WHERE id = '${FAKE_TENANT_ID}'`);
      return applyFile(path, statements);
    };
    await expect(register(m, w, { apply: true })).rejects.toThrow();
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM pipeline_volumes").get()).toEqual(expect.objectContaining({ n: 0 }));
    expect(deliveriesOf(w.db)).toEqual([]);
  });

  it("applies nothing when the SQL file on disk is not the one planned", async () => {
    const m = manifest([firstVolume()]);
    const w = world(m);
    const readFile = w.providers.readFile;
    w.providers.readFile = (path) => readFile(path) + "DELETE FROM pipeline_volumes;\n";
    expect(await stopped(register(m, w, { apply: true }))).toMatch(/does not hold the SQL this run planned; nothing was applied$/);
    expect(w.applied).toEqual([]);
  });

  it("gives each run's report and SQL file a name of its own", async () => {
    const m = manifest([firstVolume()]);
    const w = world(m);
    await register(m, w);
    await register(m, w);
    expect(pathsOf(w, ".sql")).toHaveLength(2);
    expect(pathsOf(w, ".json")).toHaveLength(2);
    expect(runFiles(pathsOf(w, ".sql"), ".sql") && runFiles(pathsOf(w, ".json"), ".json")).toBe(true);
  });
});

// @version v0.9.0
