/**
 * Tests — recording capture QC rejections in bulk from a list
 *
 * This suite delivers capture manifests over the link exactly as a
 * Captua unit does (`handleManifestDelivery`, with an in-memory S3
 * server standing in for the masters bucket), then runs the bulk
 * command's core, `recordQcDecisions`, against the test D1 binding: its
 * reads go to the binding as `wrangler d1 execute --command` would send
 * them, and its SQL file is applied as one batch. It pins:
 *
 *   - every row outcome: `decide`, `same`, `conflict` (a different
 *     decision recorded, another record id or sequence than Fisqua's, a
 *     side that does not fit the opening's images, a pair id on two
 *     records, two rows reaching one opening), `missing` (no volume, no
 *     such pair id, a record that is not an opening) and `locked` (a run
 *     holds the volume);
 *   - a dry run writing nothing, and `--apply` writing nothing while any
 *     row is a conflict, missing or locked;
 *   - the rows written: the same set, decisions and endpoint answer as
 *     the Capture QC screen's own write (`recordDecisionsAction`) gives
 *     for the same rejections, on a delivery with and without a set;
 *   - a rerun reporting every row `same` and writing nothing;
 *   - the decisions endpoint then answering the rejections to the unit,
 *     with reason, side, note and the decider's display name, and the
 *     set in state `retakes_requested`, which the hold and the status
 *     call read;
 *   - who may decide: a workspace admin and a digitization admin of the
 *     tenant, and a steward of its federation from another tenant, whose
 *     write records one `edit_on_behalf` audit row per volume, and no one
 *     else; the tenant needs the digitization capability;
 *   - a decision recorded on the screen between the read and the write
 *     leaving the command's write a no-op, reported by the re-read;
 *   - D1's limits for 600 rejections with long notes in one volume, and
 *     for notes at the 2,000-character limit made only of apostrophes,
 *     which SQL text doubles, or of two- and four-byte characters;
 *   - a disabled tenant refused before any access check.
 *
 * Every value here is a test value: no real tenant, bucket, key or person.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedFederations,
  DEFAULT_TEST_FEDERATION_ID,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestDescription } from "../helpers/descriptions";
import { createTestRepository } from "../helpers/repositories";
import { createTestUser } from "../helpers/auth";
import { makeUserContext } from "../helpers/context";
import { fakeS3, type FakeS3 } from "../helpers/fake-s3";
import { insertRow, seedDeclaration, seedTenantDestination, TEST_MASTERS_BUCKET, TEST_SECRET_PREFIX } from "../helpers/media-pipeline";
import { handleManifestDelivery, type CaptureLinkDeps } from "../../app/lib/capture/link.server";
import { handleVolumeDecisions, recordDecisionsAction } from "../../app/lib/capture/qc.server";
import { MAX_FILE_STATEMENT_BYTES } from "../../app/lib/capture/file-route.server";
import { mintScannerToken } from "../../app/lib/capture/token";
import {
  parseQcList,
  QcDecisionStop,
  recordQcDecisions,
  reportPath,
  sqlPath,
  type QcDecisionProviders,
  type QcDecisionReport,
} from "../../scripts/lib/qc-decisions";
import type { Tenant, User } from "../../app/context";

const HOST = "https://neogranadina.fisqua.test";
const ROOT = "neogranadina/";
const SLUG = "neogranadina";
const T0 = 1_800_000_000_000;
const A = "co-test-a01";
const B = "co-test-b01";
const C = "co-test-c01";

type Json = Record<string, any>;

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

const digest = (label: string) => createHash("sha256").update(label).digest("hex");
const pad = (n: number) => String(n).padStart(4, "0");

/** One image; its pair id is `<stem>-img_<nnnn>` unless `pairId` says otherwise. */
function image(stem: string, n: number, c: number, role: string, pairId = `${stem}-img_${pad(n)}`): Json {
  const base = `${stem}-img_${pad(n)}_c${c}`;
  return {
    captureId: `cap-${base}`,
    pairId,
    filename: `${base}.cr3`,
    role,
    objectKey: `${stem}/captures/${base}.cr3`,
    sha256: digest(`capture ${base}`),
    previewObjectKey: `${stem}/previews/${base}_preview.jpg`,
    previewSha256: digest(`preview ${base}`),
  };
}

const spread = (stem: string, n: number) => [image(stem, n, 0, "left"), image(stem, n, 1, "right")];

function rec(id: number, sequence: number, status: string, images: Json[]): Json {
  return { captuaRecordId: id, sequence, status, rejectionNote: status === "rejected" ? "blurred" : null, images };
}

/**
 * Openings 11 (a single), 12, 14 and 15 (spreads), 16 (a spread whose
 * halves carry different pair ids) and 17 and 18 (spreads sharing one
 * pair id); record 13 was rejected on the unit and is no opening.
 */
function volume(stem: string): Json {
  return {
    externalId: stem,
    captuaCollectionId: 7,
    stem,
    title: `Test volume ${stem}`,
    records: [
      rec(11, 1, "in_review", [image(stem, 1, 0, "single")]),
      rec(12, 2, "approved", spread(stem, 2)),
      rec(13, 3, "rejected", spread(stem, 3)),
      rec(14, 4, "in_review", spread(stem, 4)),
      rec(15, 5, "in_review", spread(stem, 5)),
      rec(16, 6, "in_review", [image(stem, 6, 0, "left"), image(stem, 7, 1, "right")]),
      rec(17, 8, "in_review", [image(stem, 8, 0, "left", `${stem}-shared`), image(stem, 8, 1, "right", `${stem}-shared`)]),
      rec(18, 9, "in_review", [image(stem, 9, 0, "left", `${stem}-shared`), image(stem, 9, 1, "right", `${stem}-shared`)]),
    ],
  };
}

/** A volume of `n` spreads, record ids 1 to n. */
function bigVolume(stem: string, n: number): Json {
  const records = Array.from({ length: n }, (_, i) => rec(i + 1, i + 1, "in_review", spread(stem, i + 1)));
  return { externalId: stem, captuaCollectionId: 7, stem, title: `Test volume ${stem}`, records };
}

function manifest(volumes: Json[]): Json {
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
  deps: CaptureLinkDeps;
  s3: FakeS3;
  clock: { now: number };
  token: string;
  repositoryId: string;
  tenant: Tenant;
  admin: User;
  steward: User;
  volumes: Record<string, string>;
}

let world: World;

const sqlRows = async (query: string, ...binds: unknown[]) =>
  (await env.DB.prepare(query).bind(...binds).all()).results as Array<Record<string, any>>;

async function person(opts: { tenantId?: string; isAdmin?: boolean; name?: string } = {}): Promise<User> {
  const row = await createTestUser({ tenantId: opts.tenantId, isAdmin: opts.isAdmin, name: opts.name });
  return makeUserContext({ id: row.id, tenantId: row.tenantId, email: row.email, name: row.name, isAdmin: row.isAdmin });
}

async function deliver(m: Json): Promise<string> {
  upload(world.s3, m);
  const request = new Request(`${HOST}/api/capture/v1/manifests`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${world.token}` },
    body: JSON.stringify(m),
  });
  const res = await handleManifestDelivery(world.deps, request);
  expect(res.status).toBe(200);
  return ((await res.json()) as { volumeId: string }).volumeId;
}

async function currentDelivery(volumeId: string): Promise<string> {
  const rows = await sqlRows("SELECT id FROM capture_deliveries WHERE pipeline_volume_id = ? AND state = 'registered'", volumeId);
  return rows[0].id;
}

/** Decides on the screen, as the viewer posts. */
async function decideOnScreen(volumeId: string, records: Json[], user: User = world.admin, expectedRevision?: number) {
  const body = { manifestId: await currentDelivery(volumeId), records, ...(expectedRevision === undefined ? {} : { expectedRevision }) };
  const request = new Request(`${HOST}/admin/capture/volumes/${volumeId}/decisions`, { method: "POST", body: JSON.stringify(body) });
  const res = await recordDecisionsAction(
    { db: drizzle(env.DB), now: () => world.clock.now, newId: () => crypto.randomUUID() },
    request,
    volumeId,
    world.tenant,
    user,
  );
  expect(res.status).toBe(200);
  return res.json() as Promise<{ decisionsId: string; revision: number }>;
}

async function unitReads(ref: string) {
  const request = new Request(`${HOST}/api/capture/v1/volumes/${encodeURIComponent(ref)}/decisions`, {
    headers: { Authorization: `Bearer ${world.token}` },
  });
  const res = await handleVolumeDecisions(world.deps, request, ref);
  return { status: res.status, json: (await res.json()) as Json };
}

/** Puts an open pipeline run on a volume. */
async function runOn(volumeId: string) {
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
    status: "dispatched",
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
    created_at: now,
    dispatched_at: now,
  });
  await insertRow("pipeline_run_chunks", {
    id: crypto.randomUUID(),
    run_id: runId,
    tenant_id: DEFAULT_TEST_TENANT_ID,
    chunk_index: 0,
    status: "pending",
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
    status: "dispatched",
    flags_truncated: 0,
    created_at: now,
  });
  await env.DB.prepare("UPDATE pipeline_volumes SET held_by_run_id = ? WHERE id = ?").bind(runId, volumeId).run();
}

// ---------------------------------------------------------------------------
// The command against the binding
// ---------------------------------------------------------------------------

interface Run {
  files: Map<string, string>;
  applied: string[][];
}

function providers(run: Run, before?: () => Promise<void>): QcDecisionProviders {
  return {
    rows: async (query) => (await env.DB.prepare(query).all()).results as Record<string, unknown>[],
    writeFile: (path, text) => run.files.set(path, text),
    // As `wrangler d1 execute --file` applies it: every statement, in order, at once.
    applyFile: async (_path, statements) => {
      if (before) await before();
      run.applied.push(statements);
      await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
    },
    now: () => world.clock.now,
    newId: () => crypto.randomUUID(),
  };
}

const HEADER = "stem\tpairId\tsequence\tside\treason\tnote\tcaptua_record_id";

/** A TSV list of rows, each `[stem, pairId, sequence, side, reason, note, recordId]`. */
const tsv = (rows: Array<Array<string | number>>) => [HEADER, ...rows.map((r) => r.join("\t"))].join("\n") + "\n";

async function command(
  text: string,
  opts: { apply?: boolean; decidedBy?: string; before?: () => Promise<void> } = {},
): Promise<{ report: QcDecisionReport; run: Run; lines: string[] }> {
  const run: Run = { files: new Map(), applied: [] };
  const lines: string[] = [];
  const report = await recordQcDecisions(
    parseQcList(text, "tsv"),
    { slug: SLUG, decidedBy: opts.decidedBy ?? world.admin.email, sourceRecord: "staging", apply: opts.apply ?? false, listId: "testlist" },
    providers(run, opts.before),
    (l) => lines.push(l),
  );
  return { report, run, lines };
}

/** Runs the command expecting a stop; returns the stop and what was applied. */
async function refused(text: string, opts: { apply?: boolean; decidedBy?: string; before?: () => Promise<void> } = {}) {
  const run: Run = { files: new Map(), applied: [] };
  let stop: unknown;
  try {
    await recordQcDecisions(
      parseQcList(text, "tsv"),
      { slug: SLUG, decidedBy: opts.decidedBy ?? world.admin.email, sourceRecord: "staging", apply: opts.apply ?? false, listId: "testlist" },
      providers(run, opts.before),
      () => {},
    );
  } catch (err) {
    stop = err;
  }
  expect(stop).toBeInstanceOf(QcDecisionStop);
  return { stop: stop as QcDecisionStop, run };
}

const outcomes = (report: QcDecisionReport) => report.rows.map((r) => [r.line, r.outcome]);

const NOTE_LEFT = "ff. 3v-4r: retake, img_0002 c0";
const NOTE_SINGLE = "f. 1r: retake, img_0001 c0";
const NOTE_BOTH = "ff. 7v-8r: retake both, img_0004 c0 and c1";

/** The three rejections the equivalence tests record on each volume. */
const rejections = (stem: string) =>
  tsv([
    [stem, `${stem}-img_0002`, 2, "left", "other", NOTE_LEFT, 12],
    [stem, `${stem}-img_0001`, 1, "single", "other", NOTE_SINGLE, 11],
    [stem, `${stem}-img_0004`, "", "both", "other", NOTE_BOTH, ""],
  ]);
const SCREEN_REJECTIONS = [
  { captuaRecordId: 12, decision: "rejected", reason: "other", side: "left", note: NOTE_LEFT },
  { captuaRecordId: 11, decision: "rejected", reason: "other", note: NOTE_SINGLE },
  { captuaRecordId: 14, decision: "rejected", reason: "other", side: "both", note: NOTE_BOTH },
];

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDatabase();
  await seedFederations();
  await seedTenantDestination();
  await env.DB.prepare("UPDATE tenants SET digitization_enabled = 1 WHERE id = ?").bind(DEFAULT_TEST_TENANT_ID).run();
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
  // A steward of the default tenant's federation whose home is another tenant.
  const steward = await person({ tenantId: SECOND_TEST_TENANT_ID, name: "Test Steward" });
  await insertRow("federation_memberships", {
    id: crypto.randomUUID(),
    user_id: steward.id,
    federation_id: DEFAULT_TEST_FEDERATION_ID,
    role: "steward",
    created_at: T0,
  });
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
    repositoryId: repo.id,
    tenant: (await drizzle(env.DB, { schema })
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, DEFAULT_TEST_TENANT_ID))
      .get()) as Tenant,
    admin: await person({ isAdmin: true, name: "Test Admin" }),
    steward,
    volumes: {},
  };
  for (const stem of [A, B, C]) {
    await createTestDescription({ tenantId: DEFAULT_TEST_TENANT_ID, repositoryId: repo.id, descriptionLevel: "volume", referenceCode: stem });
    world.volumes[stem] = await deliver(manifest([volume(stem)]));
  }
});

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

describe("row outcomes", () => {
  it("sorts every row into one outcome, and a dry run writes only the report", async () => {
    // B: record 14 approved and record 15 rejected on the screen.
    await decideOnScreen(world.volumes[B], [
      { captuaRecordId: 14, decision: "approved" },
      { captuaRecordId: 15, decision: "rejected", reason: "other", side: "right", note: "f. 9r" },
    ]);
    await runOn(world.volumes[C]);
    const { report, run, lines } = await command(
      tsv([
        [A, `${A}-img_0002`, 2, "left", "other", NOTE_LEFT, 12], // line 2: decide
        [A, `${A}-img_0001`, "", "", "other", NOTE_SINGLE, ""], // 3: decide, a single with no side
        [A, `${A}-img_0004`, "", "both", "other", "x", 99], // 4: another record id
        [A, `${A}-img_0005`, 6, "both", "other", "x", ""], // 5: another sequence
        [A, `${A}-img_0005x`, "", "both", "other", "x", ""], // 6: no such pair id
        [A, `${A}-img_0003`, "", "both", "other", "x", ""], // 7: record 13 is no opening
        [A, `${A}-img_0001x`, "", "", "other", "x", ""], // 8: no such pair id
        ["co-test-none", "co-test-none-img_0001", "", "left", "other", "x", ""], // 9: no volume
        [A, `${A}-shared`, "", "both", "other", "x", ""], // 10: a pair id on records 17 and 18
        [A, `${A}-img_0006`, "", "left", "other", "x", ""], // 11: record 16, left half
        [A, `${A}-img_0007`, "", "right", "other", "x", ""], // 12: record 16 again, right half
        [B, `${B}-img_0004`, "", "both", "other", "x", ""], // 13: approved on the screen
        [B, `${B}-img_0005`, "", "right", "other", "f. 9r", ""], // 14: the same rejection
        [B, `${B}-img_0002`, "", "", "other", "x", ""], // 15: a spread with no side
        [B, `${B}-img_0001`, "", "left", "other", "x", ""], // 16: a single with a side
        [C, `${C}-img_0002`, "", "left", "other", "x", ""], // 17: a run holds C
      ]),
    );
    expect(outcomes(report)).toEqual([
      [2, "decide"],
      [3, "decide"],
      [4, "conflict"],
      [5, "conflict"],
      [6, "missing"],
      [7, "missing"],
      [8, "missing"],
      [9, "missing"],
      [10, "conflict"],
      [11, "conflict"],
      [12, "conflict"],
      [13, "conflict"],
      [14, "same"],
      [15, "conflict"],
      [16, "conflict"],
      [17, "locked"],
    ]);
    expect(report.counts).toEqual({ decide: 2, same: 1, conflict: 8, missing: 4, locked: 1 });
    const detail = (line: number) => report.rows.find((r) => r.line === line)!.detail;
    expect(detail(4)).toBe("the list gives record 99; the pair id is on record 14");
    expect(detail(5)).toBe("the list gives sequence 6; record 15 has sequence 5");
    expect(detail(7)).toMatch(/record 13 is not an opening .* \(it is rejected\)/);
    expect(detail(10)).toBe(`the pair id ${A}-shared is on records 17, 18`);
    expect(detail(11)).toBe("lines 11, 12 name record 16");
    expect(detail(13)).toBe("record 14 is already decided: approved");
    expect(detail(15)).toBe("the opening has 2 images, so the row needs left, right or both");
    expect(detail(16)).toBe("the opening has one image, so the row takes no side");
    expect(report.rows.find((r) => r.line === 2)!.captuaRecordId).toBe(12);
    expect(lines).toContain(`  [decide] line 2 ${A} ${A}-img_0002 (record 12): rejected, other, side left`);

    // Nothing written: A has no set, B's is as the screen left it.
    expect(run.applied).toEqual([]);
    expect([...run.files.keys()]).toEqual([reportPath("testlist")]);
    expect(await sqlRows("SELECT * FROM capture_qc_sets WHERE pipeline_volume_id = ?", world.volumes[A])).toEqual([]);
    expect((await sqlRows("SELECT revision FROM capture_qc_sets WHERE pipeline_volume_id = ?", world.volumes[B]))[0].revision).toBe(1);
  });

  it("writes nothing with --apply while any row is a conflict, missing or locked", async () => {
    await runOn(world.volumes[C]);
    for (const blocking of [
      [A, `${A}-img_0004`, "", "both", "other", "x", 99],
      [A, `${A}-img_0099`, "", "both", "other", "x", ""],
      [C, `${C}-img_0002`, "", "left", "other", "x", ""],
    ]) {
      const { stop, run } = await refused(tsv([[A, `${A}-img_0002`, 2, "left", "other", NOTE_LEFT, 12], blocking]), { apply: true });
      expect(stop.message).toMatch(/^Nothing was written/);
      expect(run.applied).toEqual([]);
      expect(run.files.has(sqlPath("testlist"))).toBe(false);
      expect(run.files.has(reportPath("testlist"))).toBe(true);
    }
    expect(await sqlRows("SELECT * FROM capture_qc_decisions")).toEqual([]);
  });

  it("reports a run's volume locked, and an identical decision on it the same", async () => {
    await decideOnScreen(world.volumes[C], [{ captuaRecordId: 12, decision: "rejected", reason: "other", side: "left", note: "f. 2" }]);
    await runOn(world.volumes[C]);
    const { report } = await command(
      tsv([
        [C, `${C}-img_0002`, "", "left", "other", "f. 2", ""],
        [C, `${C}-img_0004`, "", "left", "other", "f. 4", ""],
      ]),
    );
    expect(outcomes(report)).toEqual([
      [2, "same"],
      [3, "locked"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// What is written
// ---------------------------------------------------------------------------

/** A set and its decisions, without the ids and times that differ between any two writes. */
async function written(volumeId: string) {
  const deliveryId = await currentDelivery(volumeId);
  const [set] = await sqlRows(
    `SELECT opening_count, decided_count, approved_count, rejected_count, notes_bytes, state, revision, carried_from
     FROM capture_qc_sets WHERE delivery_id = ?`,
    deliveryId,
  );
  const decisions = await sqlRows(
    `SELECT captua_record_id, decision, reason, side, note, decided_by, decided_by_name, set_revision
     FROM capture_qc_decisions WHERE delivery_id = ? ORDER BY captua_record_id`,
    deliveryId,
  );
  const rotations = await sqlRows("SELECT * FROM capture_qc_rotations WHERE delivery_id = ?", deliveryId);
  return { set, decisions, rotations };
}

/** The unit's answer without the names that differ between two volumes and two writes. */
async function unitAnswer(ref: string) {
  const { status, json } = await unitReads(ref);
  expect(status).toBe(200);
  return { records: json.records };
}

describe("the rows written", () => {
  it("writes what the screen writes for the same rejections, on a delivery without a set", async () => {
    const { report, run } = await command(rejections(A), { apply: true });
    expect(report.counts).toEqual({ decide: 3, same: 0, conflict: 0, missing: 0, locked: 0 });
    expect(report.applied).toBe(true);
    expect(run.applied).toHaveLength(1);
    expect(run.files.get(sqlPath("testlist"))).toBe(run.applied[0].join("\n") + "\n");
    expect(report.volumes).toEqual([
      expect.objectContaining({ stem: A, decisions: 3, revisionBefore: 0, revisionAfter: 1, verified: true }),
    ]);
    await decideOnScreen(world.volumes[B], SCREEN_REJECTIONS);

    const a = await written(world.volumes[A]);
    const b = await written(world.volumes[B]);
    expect(a).toEqual(b);
    expect(a.set).toEqual({
      opening_count: 7,
      decided_count: 3,
      approved_count: 0,
      rejected_count: 3,
      notes_bytes: NOTE_LEFT.length + NOTE_SINGLE.length + NOTE_BOTH.length,
      state: "retakes_requested",
      revision: 1,
      carried_from: null,
    });
    expect(a.decisions.map((d) => [d.captua_record_id, d.side, d.decided_by, d.decided_by_name])).toEqual([
      [11, null, world.admin.id, "Test Admin"],
      [12, "left", world.admin.id, "Test Admin"],
      [14, "both", world.admin.id, "Test Admin"],
    ]);
    expect(await unitAnswer(A)).toEqual(await unitAnswer(B));
  });

  it("writes what the screen writes on a delivery that already has a set", async () => {
    for (const stem of [A, B]) {
      await decideOnScreen(world.volumes[stem], [
        { captuaRecordId: 15, decision: "approved" },
        { captuaRecordId: 16, decision: "approved", rotations: [{ captureId: `cap-${stem}-img_0006_c0`, role: "left", quarterTurns: 1 }] },
      ]);
    }
    world.clock.now += 1000;
    const { report } = await command(rejections(A), { apply: true });
    expect(report.volumes[0]).toEqual(expect.objectContaining({ revisionBefore: 1, revisionAfter: 2, verified: true }));
    await decideOnScreen(world.volumes[B], SCREEN_REJECTIONS, world.admin, 1);

    const a = await written(world.volumes[A]);
    const b = await written(world.volumes[B]);
    expect(a.set).toEqual(b.set);
    expect(a.decisions).toEqual(b.decisions);
    expect(a.set).toEqual(expect.objectContaining({ decided_count: 5, approved_count: 2, rejected_count: 3, revision: 2 }));
    // The approvals and their rotation are left as they were.
    expect(a.rotations.map((r) => [r.captua_record_id, r.role, r.quarter_turns])).toEqual([[16, "left", 1]]);
    expect(await unitAnswer(A)).toEqual({
      records: (await unitAnswer(B)).records.map((r: Json) => ({
        ...r,
        rotations: r.rotations.map((x: Json) => ({ ...x, captureId: x.captureId.replace(B, A) })),
      })),
    });
  });

  it("reports every row the same on a rerun and writes nothing", async () => {
    await command(rejections(A), { apply: true });
    const [before] = await sqlRows("SELECT decisions_id, revision, write_id FROM capture_qc_sets");
    world.clock.now += 1000;
    const { report, run, lines } = await command(rejections(A), { apply: true });
    expect(report.counts).toEqual({ decide: 0, same: 3, conflict: 0, missing: 0, locked: 0 });
    expect(report.applied).toBe(false);
    expect(run.applied).toEqual([]);
    expect(lines).toContain("Nothing to write: every row is already recorded.");
    expect(await sqlRows("SELECT decisions_id, revision, write_id FROM capture_qc_sets")).toEqual([before]);
  });

  it("answers the rejections to the unit and puts the set in retakes_requested", async () => {
    await command(rejections(A), { apply: true });
    const { status, json } = await unitReads(A);
    expect(status).toBe(200);
    expect(json.manifestId).toBe(await currentDelivery(world.volumes[A]));
    expect(json.records).toEqual([
      { captuaRecordId: 11, decision: "rejected", reason: "other", note: NOTE_SINGLE, decidedBy: "Test Admin", decidedAt: new Date(T0).toISOString(), rotations: [] },
      { captuaRecordId: 12, decision: "rejected", reason: "other", side: "left", note: NOTE_LEFT, decidedBy: "Test Admin", decidedAt: new Date(T0).toISOString(), rotations: [] },
      { captuaRecordId: 14, decision: "rejected", reason: "other", side: "both", note: NOTE_BOTH, decidedBy: "Test Admin", decidedAt: new Date(T0).toISOString(), rotations: [] },
    ]);
    // The unit's read is recorded as for any set.
    expect(await sqlRows("SELECT set_revision FROM capture_qc_fetches")).toEqual([{ set_revision: 1 }]);
    const [set] = await sqlRows("SELECT state FROM capture_qc_sets WHERE pipeline_volume_id = ?", world.volumes[A]);
    expect(set.state).toBe("retakes_requested");
  });

  it("writes one statement set per volume, every statement within D1's limits", async () => {
    const BIG = "co-test-big";
    await createTestDescription({ tenantId: DEFAULT_TEST_TENANT_ID, repositoryId: world.repositoryId, descriptionLevel: "volume", referenceCode: BIG });
    const volumeId = await deliver(manifest([bigVolume(BIG, 600)]));
    const note = (n: number) => `f. ${n}r: ${"retake ".repeat(200)}`.slice(0, 1500);
    const rows = Array.from({ length: 600 }, (_, i) => [BIG, `${BIG}-img_${pad(i + 1)}`, i + 1, "both", "other", note(i + 1), i + 1]);
    rows.push([A, `${A}-img_0002`, 2, "left", "other", NOTE_LEFT, 12]);
    const { report, run } = await command(tsv(rows), { apply: true });
    expect(report.counts.decide).toBe(601);
    expect(report.volumes.map((v) => [v.stem, v.decisions, v.verified])).toEqual([
      [A, 1, true],
      [BIG, 600, true],
    ]);
    const statements = run.applied[0];
    expect(statements.length).toBeGreaterThan(20);
    for (const s of statements) expect(new TextEncoder().encode(s).length).toBeLessThanOrEqual(MAX_FILE_STATEMENT_BYTES);
    const [set] = await sqlRows("SELECT rejected_count, opening_count FROM capture_qc_sets WHERE pipeline_volume_id = ?", volumeId);
    expect(set).toEqual({ rejected_count: 600, opening_count: 600 });
  });

  it("fits notes of apostrophes and of multibyte characters at the longest the list allows", async () => {
    const BIG = "co-test-quotes";
    await createTestDescription({ tenantId: DEFAULT_TEST_TENANT_ID, repositoryId: world.repositoryId, descriptionLevel: "volume", referenceCode: BIG });
    const volumeId = await deliver(manifest([bigVolume(BIG, 90)]));
    // 2,000 characters each: apostrophes, which SQL text doubles; a
    // two-byte letter; and a four-byte character.
    const notes = ["'".repeat(2000), "ñ".repeat(2000), "\u{1D509}".repeat(2000)];
    const noteOf = (i: number) => notes[Math.floor(i / 30)];
    const rows = Array.from({ length: 90 }, (_, i) => [BIG, `${BIG}-img_${pad(i + 1)}`, i + 1, "both", "other", noteOf(i), i + 1]);
    const list = tsv(rows);
    const { report, run } = await command(list, { apply: true });
    expect(report.counts.decide).toBe(90);
    expect(report.volumes[0].verified).toBe(true);
    for (const s of run.applied[0]) expect(new TextEncoder().encode(s).length).toBeLessThanOrEqual(MAX_FILE_STATEMENT_BYTES);
    const stored = await sqlRows(
      "SELECT captua_record_id, note FROM capture_qc_decisions WHERE delivery_id = ? ORDER BY captua_record_id",
      await currentDelivery(volumeId),
    );
    expect(stored.map((r) => r.note)).toEqual(Array.from({ length: 90 }, (_, i) => noteOf(i)));
    // The same list again finds every note the same.
    expect((await command(list, { apply: true })).report.counts.same).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// Who decides, and the audit
// ---------------------------------------------------------------------------

describe("who decides", () => {
  it("records a steward's grant write with one edit_on_behalf row per volume written", async () => {
    const list = tsv([
      [A, `${A}-img_0002`, 2, "left", "other", NOTE_LEFT, 12],
      [B, `${B}-img_0002`, 2, "left", "other", NOTE_LEFT, 12],
    ]);
    const { report } = await command(list, { apply: true, decidedBy: world.steward.email });
    expect(report.decidedBy).toEqual({ id: world.steward.id, email: world.steward.email, name: "Test Steward", access: "grant" });
    const audit = await sqlRows(
      "SELECT actor_user_id, actor_user_id_text, actor_tenant_id, action, target_tenant_id, target_object_kind, target_object_id, details FROM audit_log ORDER BY details",
    );
    expect(audit).toEqual(
      [A, B]
        .map((stem) => ({
          actor_user_id: world.steward.id,
          actor_user_id_text: world.steward.email,
          actor_tenant_id: SECOND_TEST_TENANT_ID,
          action: "edit_on_behalf",
          target_tenant_id: DEFAULT_TEST_TENANT_ID,
          target_object_kind: "grant_write",
          target_object_id: null,
          details: JSON.stringify({ role: "steward", method: "POST", path: `/admin/capture/volumes/${world.volumes[stem]}/decisions` }),
        }))
        .sort((x, y) => x.details.localeCompare(y.details)),
    );
    const decided = await sqlRows("SELECT decided_by, decided_by_name FROM capture_qc_decisions");
    expect(decided).toEqual([
      { decided_by: world.steward.id, decided_by_name: "Test Steward" },
      { decided_by: world.steward.id, decided_by_name: "Test Steward" },
    ]);
    // A rerun writes nothing, and no audit row.
    await command(list, { apply: true, decidedBy: world.steward.email });
    expect(await sqlRows("SELECT id FROM audit_log")).toHaveLength(2);
  });

  it("records no audit row for a user of the tenant, as the screen records none", async () => {
    await command(rejections(A), { apply: true });
    expect(await sqlRows("SELECT id FROM audit_log")).toEqual([]);
  });

  it("accepts a digitization admin of the tenant", async () => {
    const digitizer = await person({ name: "Test Digitizer" });
    await env.DB.prepare("UPDATE users SET is_digitization_admin = 1 WHERE id = ?").bind(digitizer.id).run();
    const { report } = await command(rejections(A), { apply: true, decidedBy: digitizer.email });
    expect(report.decidedBy.access).toBe("member");
    expect((await sqlRows("SELECT DISTINCT decided_by_name FROM capture_qc_decisions"))[0].decided_by_name).toBe("Test Digitizer");
  });

  it("refuses a disabled tenant before any access check, for a member and a steward alike", async () => {
    await env.DB.prepare("UPDATE tenants SET disabled_at = ? WHERE id = ?").bind(T0, DEFAULT_TEST_TENANT_ID).run();
    for (const who of [world.admin.email, world.steward.email]) {
      const { stop, run } = await refused(rejections(A), { apply: true, decidedBy: who });
      expect(stop.message).toBe(`The tenant ${SLUG} is disabled`);
      expect(run.applied).toEqual([]);
    }
    expect(await sqlRows("SELECT * FROM capture_qc_decisions")).toEqual([]);
    expect(await sqlRows("SELECT id FROM audit_log")).toEqual([]);
  });

  it("refuses anyone else, and a tenant without the digitization capability", async () => {
    const outsider = await person({ name: "Test Outsider" });
    expect((await refused(rejections(A), { decidedBy: outsider.email })).stop.message).toMatch(/without digitization admin rights/);
    const elsewhere = await person({ tenantId: SECOND_TEST_TENANT_ID, isAdmin: true });
    expect((await refused(rejections(A), { decidedBy: elsewhere.email })).stop.message).toMatch(/has no steward grant/);
    const staff = await person({ tenantId: SECOND_TEST_TENANT_ID });
    await insertRow("federation_memberships", {
      id: crypto.randomUUID(),
      user_id: staff.id,
      federation_id: DEFAULT_TEST_FEDERATION_ID,
      role: "staff",
      created_at: T0,
    });
    expect((await refused(rejections(A), { decidedBy: staff.email })).stop.message).toMatch(/has no steward grant/);
    expect((await refused(rejections(A), { decidedBy: "nobody@example.com" })).stop.message).toBe("No user has the email nobody@example.com");
    await env.DB.prepare("UPDATE tenants SET digitization_enabled = 0 WHERE id = ?").bind(DEFAULT_TEST_TENANT_ID).run();
    expect((await refused(rejections(A))).stop.message).toMatch(/does not have the digitization capability/);
    expect(await sqlRows("SELECT * FROM capture_qc_decisions")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A write between the read and the file
// ---------------------------------------------------------------------------

describe("a decision recorded between the read and the write", () => {
  it("leaves the volume's statements no-ops and stops on the re-read", async () => {
    const { stop, run } = await refused(rejections(A), {
      apply: true,
      before: async () => {
        await decideOnScreen(world.volumes[A], [{ captuaRecordId: 15, decision: "approved" }]);
      },
    });
    expect(run.applied).toHaveLength(1);
    expect(stop.message).toMatch(/^The re-read does not show every write/);
    const report = JSON.parse(run.files.get(reportPath("testlist"))!) as QcDecisionReport;
    expect(report.volumes[0].verified).toBe(false);
    expect(await sqlRows("SELECT captua_record_id, decision FROM capture_qc_decisions")).toEqual([
      { captua_record_id: 15, decision: "approved" },
    ]);
    // Run again, the list's rejections are recorded on top of the approval.
    const again = await command(rejections(A), { apply: true });
    expect(again.report.volumes[0]).toEqual(expect.objectContaining({ revisionBefore: 1, revisionAfter: 2, verified: true }));
  });
});

// @version v0.8.0
