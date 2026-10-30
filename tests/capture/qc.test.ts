/**
 * Tests — capture QC decisions, reviewers and the decisions endpoint
 *
 * This suite delivers capture manifests over the link exactly as a
 * Captua unit does (`handleManifestDelivery`, with an in-memory S3
 * server standing in for the masters bucket), then records capture QC
 * decisions through `recordDecisionsAction`, assigns reviewers through
 * `assignReviewerAction`, and reads what the unit reads: the status call
 * and `GET /api/capture/v1/volumes/<ref>/decisions`. It pins:
 *
 *   - who decides: the assigned reviewer, the tenant's admins and the
 *     federation's stewards, and no one else; only admins and stewards
 *     assign, and only a user of the tenant or of its federation can be
 *     assigned;
 *   - the body's rules: a reason exactly for a rejection, a side exactly
 *     for a rejection of an opening with two images, a note for
 *     `other`, notes of 1 to 2,000 characters, quarter-turns 1 to 3, a
 *     role on every rotation, no opening twice and no image (a capture
 *     id with its role) twice, openings only of the current delivery and
 *     images only of their own opening;
 *   - a spread whose left and right images share a capture id, as a
 *     dual-camera capture writes them, keeping a separate correction for
 *     each half, and migration 0096 keeping the rotations it rekeys;
 *   - the status mapping for every case before processing (no decision,
 *     some approved, any rejected, all approved, which with a record
 *     still rejected on the unit is `retakes_requested`), the processing states
 *     taking over once a run exists, and `decisionsId` and `decidedAt`
 *     changing with every write;
 *   - the endpoint's exact shape, `reason` only on a rejection, `side`
 *     after it only on a spread's rejection (a new `decisionsId` when
 *     only the side changes), `note` only where there is one, rotations with their roles, and 404
 *     `no-decisions` for an unknown ref or one with nothing decided;
 *   - cross-tenant refusals on both sides;
 *   - a decision after a run started refused, and a decision batch
 *     planned before a run claimed the volume writing nothing;
 *   - a retake: the new delivery starts with the approvals of its
 *     unchanged openings only (carry-forward is pinned in
 *     `retakes.test.ts`), and a write that names the older delivery, or
 *     names none, is refused;
 *   - two interleaved writes each answered with their own decisionsId,
 *     the outcome settled inside each batch;
 *   - the revision guard: every 200 answer carries the set's revision; a
 *     write without `expectedRevision` is checked as before; one on an
 *     older revision (or on 0 once a set exists) writes nothing and is
 *     refused with `revision_changed` and the current revision, after
 *     `run_started` and `delivery_changed`; the late commit of a request
 *     whose retry and a newer write already landed cannot win; and two
 *     people deciding at once refuse each other and reconcile;
 *   - "Fisqua reviewer" for a decider without a name, never an email;
 *   - D1's limits for a volume of 1,000 openings decided in one request,
 *     and the cap on a set's notes;
 *   - an assigned reviewer with no role flag, through React Router's
 *     request handler behind the layout's member confinement, opening
 *     the capture QC queue and viewer and saving a decision, where the
 *     same person before assignment is sent to `/no-access`.
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
import {
  insertRow,
  seedDeclaration,
  seedTenantDestination,
  TEST_MASTERS_BUCKET,
  TEST_SECRET_PREFIX,
} from "../helpers/media-pipeline";
import { handleManifestDelivery, handleVolumeStatus, type CaptureLinkDeps } from "../../app/lib/capture/link.server";
import {
  assignReviewerAction,
  buildDecisionStatements,
  handleVolumeDecisions,
  PAYLOAD_CHUNK_BYTES,
  recordDecisionsAction,
} from "../../app/lib/capture/qc.server";
import { mintScannerToken } from "../../app/lib/capture/token";
import { entryFor, initialState, type ViewerOpening } from "../../app/lib/capture/viewer";
import { migrationStatements, runMigrationFile } from "../helpers/migration-file";
import { loader as decisionsLoader } from "../../app/routes/api.capture.v1.volumes.$ref.decisions";
import {
  grantContext,
  impersonationContext,
  tenantContext,
  userContext,
  type Tenant,
  type User,
} from "../../app/context";
import { RouterContextProvider } from "react-router";
import { confineMemberAccess } from "../../app/lib/reader.server";

const HOST = "https://neogranadina.fisqua.test";
const OTHER_HOST = "https://second-tenant.fisqua.test";
const ROOT = "neogranadina/";
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
    captureId: `cap-${base}`,
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

/** Openings 11 (a single), 12 (a spread) and 14 (a single); record 13 was rejected on the unit. */
function volume(code: string, stem = code): Json {
  return {
    externalId: code,
    captuaCollectionId: 7,
    stem,
    title: `Test volume ${stem}`,
    records: [
      rec(12, 2, "approved", [image(stem, 2, 1, "right"), image(stem, 2, 0, "left")]),
      rec(11, 1, "in_review", [image(stem, 1, 0, "single")]),
      rec(13, 3, "rejected", [image(stem, 3, 0, "left"), image(stem, 3, 1, "right")]),
      rec(14, 4, "approved", [image(stem, 5, 0, "single")]),
    ],
  };
}

/**
 * The volume above with its spread, opening 12, as a dual-camera capture
 * writes it: one trigger of the rig, so both images carry one capture id.
 */
function sharedCaptureVolume(code: string): Json {
  const v = volume(code);
  for (const img of v.records[0].images) img.captureId = `cap-${code}-0002`;
  return v;
}

/** A volume of `n` two-page openings, record ids 1 to n. */
function bigVolume(code: string, n: number): Json {
  const records = Array.from({ length: n }, (_, i) =>
    rec(i + 1, i + 1, "in_review", [image(code, i + 1, 0, "left"), image(code, i + 1, 1, "right")]),
  );
  return { externalId: code, captuaCollectionId: 7, stem: code, title: `Test volume ${code}`, records };
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
          s3.objects.set(`${TEST_MASTERS_BUCKET}/${ROOT}${key}`, {
            bytes: new Uint8Array(10),
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

interface World {
  deps: CaptureLinkDeps;
  s3: FakeS3;
  clock: { now: number };
  token: string;
  repositoryId: string;
  tenant: Tenant;
  admin: User;
  reviewer: User;
  outsider: User;
  steward: User;
}

let world: World;

async function seedScanner(tenantId: string, name = "rig-1") {
  const { token, sha256 } = await mintScannerToken();
  await insertRow("capture_scanners", {
    id: crypto.randomUUID(),
    tenant_id: tenantId,
    name,
    token_sha256: sha256,
    token_created_at: T0,
    created_at: T0,
    updated_at: T0,
  });
  return token;
}

async function tenantRow(id: string): Promise<Tenant> {
  const db = drizzle(env.DB, { schema });
  return (await db.select().from(schema.tenants).where(eq(schema.tenants.id, id)).get()) as Tenant;
}

async function person(opts: { tenantId?: string; isAdmin?: boolean; name?: string } = {}): Promise<User> {
  const row = await createTestUser({ tenantId: opts.tenantId, isAdmin: opts.isAdmin, name: opts.name });
  return makeUserContext({ id: row.id, tenantId: row.tenantId, email: row.email, name: row.name, isAdmin: row.isAdmin });
}

const qcDeps = () => ({ db: drizzle(env.DB), now: () => world.clock.now, newId: () => crypto.randomUUID() });

async function answer(res: Response): Promise<{ status: number; json: Json | null }> {
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** The status thrown as a Response (the gate), or answered. */
async function settle(p: Promise<Response>): Promise<{ status: number; json: Json | null }> {
  try {
    return await answer(await p);
  } catch (thrown) {
    if (thrown instanceof Response) return { status: thrown.status, json: null };
    throw thrown;
  }
}

async function deliver(m: Json, opts: { token?: string; host?: string } = {}) {
  upload(world.s3, m);
  const request = new Request(`${opts.host ?? HOST}/api/capture/v1/manifests`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.token ?? world.token}` },
    body: JSON.stringify(m),
  });
  const res = await answer(await handleManifestDelivery(world.deps, request));
  expect(res.status).toBe(200);
  return res.json as { state: string; manifestId: string; volumeId: string };
}

/** The volume's current delivery, as a decisions page would have loaded it. */
async function currentDelivery(volumeId: string): Promise<string | undefined> {
  const rows = await sqlRows(
    "SELECT id FROM capture_deliveries WHERE pipeline_volume_id = ? AND state = 'registered'",
    volumeId,
  );
  return rows[0]?.id;
}

/**
 * Posts decisions as the viewer would, naming the current delivery unless
 * the body says otherwise (`manifestId: undefined` leaves it out).
 */
async function decide(volumeId: string, body: Json, user: User = world.admin, tenant: Tenant = world.tenant, db = drizzle(env.DB)) {
  const full = typeof body === "string" || "manifestId" in body ? body : { manifestId: await currentDelivery(volumeId), ...body };
  const request = new Request(`${HOST}/admin/capture/volumes/${volumeId}/decisions`, {
    method: "POST",
    body: typeof full === "string" ? full : JSON.stringify(full),
  });
  return settle(
    recordDecisionsAction({ db, now: () => world.clock.now, newId: () => crypto.randomUUID() }, request, volumeId, tenant, user),
  );
}

function assign(volumeId: string, reviewerId: string | null, user: User = world.admin, tenant: Tenant = world.tenant) {
  const request = new Request(`${HOST}/admin/capture/volumes/${volumeId}/reviewer`, {
    method: "POST",
    body: JSON.stringify({ reviewerId }),
  });
  return settle(assignReviewerAction(qcDeps(), request, volumeId, tenant, user));
}

async function status(ref: string) {
  const request = new Request(`${HOST}/api/capture/v1/volumes/status?refs=${encodeURIComponent(ref)}`, {
    headers: { Authorization: `Bearer ${world.token}` },
  });
  const res = await answer(await handleVolumeStatus(world.deps, request));
  return res.json!.volumes[0] as Json;
}

async function decisions(ref: string, opts: { token?: string | null; host?: string } = {}) {
  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? world.token : opts.token;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const request = new Request(`${opts.host ?? HOST}/api/capture/v1/volumes/${encodeURIComponent(ref)}/decisions`, { headers });
  return answer(await handleVolumeDecisions(world.deps, request, ref));
}

const sqlRows = async (query: string, ...binds: unknown[]) =>
  (await env.DB.prepare(query).bind(...binds).all()).results as Array<Record<string, any>>;

/** Puts a pipeline run on a volume, holding it unless `closed`. */
async function runOn(volumeId: string, opts: { closed?: boolean } = {}) {
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
  if (!opts.closed) {
    await env.DB.prepare("UPDATE pipeline_volumes SET held_by_run_id = ? WHERE id = ?").bind(runId, volumeId).run();
  }
  return runId;
}

const APPROVE_ALL = [
  { captuaRecordId: 11, decision: "approved" },
  { captuaRecordId: 12, decision: "approved" },
  { captuaRecordId: 14, decision: "approved" },
];

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
  const token = await seedScanner(DEFAULT_TEST_TENANT_ID);
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
    tenant: await tenantRow(DEFAULT_TEST_TENANT_ID),
    admin: await person({ isAdmin: true, name: "Test Admin" }),
    reviewer: await person({ name: "Test Reviewer" }),
    outsider: await person({ name: "Test Outsider" }),
    steward,
  };
  await createTestDescription({
    tenantId: DEFAULT_TEST_TENANT_ID,
    repositoryId: repo.id,
    descriptionLevel: "volume",
    referenceCode: CODE,
  });
});

// ---------------------------------------------------------------------------
// Who decides
// ---------------------------------------------------------------------------

describe("who decides", () => {
  it("lets the assigned reviewer, an admin and a steward decide, and no one else", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    const one = { records: [{ captuaRecordId: 11, decision: "approved" }] };
    expect((await decide(volumeId, one, world.outsider)).status).toBe(403);
    expect((await decide(volumeId, one, world.reviewer)).status).toBe(403);
    expect((await assign(volumeId, world.reviewer.id)).status).toBe(200);
    expect((await decide(volumeId, one, world.reviewer)).status).toBe(200);
    expect((await decide(volumeId, one, world.admin)).status).toBe(200);
    expect((await decide(volumeId, one, world.steward)).status).toBe(200);
    expect((await decide(volumeId, one, world.outsider)).status).toBe(403);
    // Reassigned: only the new reviewer decides.
    expect((await assign(volumeId, world.outsider.id, world.steward)).status).toBe(200);
    expect((await decide(volumeId, one, world.reviewer)).status).toBe(403);
    expect((await decide(volumeId, one, world.outsider)).status).toBe(200);
  });

  it("lets only admins and stewards assign, and only someone of the tenant or its federation", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    expect((await assign(volumeId, world.reviewer.id, world.reviewer)).status).toBe(403);
    expect((await assign(volumeId, world.reviewer.id, world.outsider)).status).toBe(403);
    const stranger = await person({ tenantId: SECOND_TEST_TENANT_ID });
    const refused = await assign(volumeId, stranger.id);
    expect(refused).toEqual({ status: 422, json: { error: "reviewer_not_eligible", reviewer_id: stranger.id } });
    expect((await assign(volumeId, world.steward.id)).json).toEqual({ reviewerId: world.steward.id });
    expect(await sqlRows("SELECT reviewer_id, assigned_by FROM capture_qc_reviewers")).toEqual([
      { reviewer_id: world.steward.id, assigned_by: world.admin.id },
    ]);
    expect((await assign(volumeId, null, world.steward)).json).toEqual({ reviewerId: null });
    expect(await sqlRows("SELECT * FROM capture_qc_reviewers")).toEqual([]);
  });

  it("refuses another tenant's admin, who cannot see the volume", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    const otherAdmin = await person({ tenantId: SECOND_TEST_TENANT_ID, isAdmin: true });
    const other = await tenantRow(SECOND_TEST_TENANT_ID);
    const body = { records: [{ captuaRecordId: 11, decision: "approved" }] };
    expect(await decide(volumeId, body, otherAdmin, other)).toEqual({
      status: 404,
      json: { error: "volume_not_found" },
    });
    expect((await assign(volumeId, otherAdmin.id, otherAdmin, other)).json).toEqual({ error: "volume_not_found" });
    expect(await sqlRows("SELECT * FROM capture_qc_sets")).toEqual([]);
  });

  it("refuses a volume that did not come from a capture delivery", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    await env.DB.prepare("UPDATE capture_deliveries SET state = 'superseded', superseded_by = 'x' WHERE pipeline_volume_id = ?")
      .bind(volumeId)
      .run();
    expect((await decide(volumeId, { manifestId: "x", records: APPROVE_ALL })).json).toEqual({
      error: "no_capture_delivery",
      volume_id: volumeId,
    });
  });
});

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

describe("the decisions body", () => {
  const invalid = [
    ["a rejection without a reason", { captuaRecordId: 11, decision: "rejected" }, "records.0.reason"],
    ["an approval with a reason", { captuaRecordId: 11, decision: "approved", reason: "blur" }, "records.0.reason"],
    ["other without a note", { captuaRecordId: 11, decision: "rejected", reason: "other" }, "records.0.note"],
    ["an empty note", { captuaRecordId: 11, decision: "approved", note: "" }, "records.0.note"],
    ["a note over 2,000 characters", { captuaRecordId: 11, decision: "approved", note: "x".repeat(2001) }, "records.0.note"],
    ["an unknown reason", { captuaRecordId: 11, decision: "rejected", reason: "smudge" }, "records.0.reason"],
    ["an unknown decision", { captuaRecordId: 11, decision: "approve" }, "records.0.decision"],
    ["four quarter-turns", { captuaRecordId: 11, decision: "approved", rotations: [{ captureId: "c", role: "single", quarterTurns: 4 }] }, "records.0.rotations.0.quarterTurns"],
    ["no quarter-turns", { captuaRecordId: 11, decision: "approved", rotations: [{ captureId: "c", role: "single", quarterTurns: 0 }] }, "records.0.rotations.0.quarterTurns"],
    ["a rotation without a role", { captuaRecordId: 11, decision: "approved", rotations: [{ captureId: "c", quarterTurns: 1 }] }, "records.0.rotations.0.role"],
    ["an unknown role", { captuaRecordId: 11, decision: "approved", rotations: [{ captureId: "c", role: "verso", quarterTurns: 1 }] }, "records.0.rotations.0.role"],
    ["an image rotated twice", { captuaRecordId: 12, decision: "approved", rotations: [{ captureId: "c", role: "left", quarterTurns: 1 }, { captureId: "c", role: "left", quarterTurns: 2 }] }, "records.0.rotations"],
    ["an unknown field", { captuaRecordId: 11, decision: "approved", flag: true }, "records.0"],
    ["an approval with a side", { captuaRecordId: 12, decision: "approved", side: "left" }, "records.0.side"],
    ["an unknown side", { captuaRecordId: 12, decision: "rejected", reason: "blur", side: "single" }, "records.0.side"],
    ["a cleared decision with a reason", { captuaRecordId: 11, decision: null, reason: "blur" }, "records.0.reason"],
    ["a cleared decision with a side", { captuaRecordId: 12, decision: null, side: "left" }, "records.0.side"],
    ["a cleared decision with a note", { captuaRecordId: 11, decision: null, note: "Gone" }, "records.0.note"],
    ["a cleared decision with rotations", { captuaRecordId: 11, decision: null, rotations: [{ captureId: "c", role: "single", quarterTurns: 1 }] }, "records.0.rotations"],
  ] as const;
  for (const [label, record, path] of invalid) {
    it(`refuses ${label} with invalid_request`, async () => {
      const { volumeId } = await deliver(manifest([volume(CODE)]));
      const res = await decide(volumeId, { records: [record] });
      expect(res.status).toBe(400);
      expect(res.json!.error).toBe("invalid_request");
      expect(res.json!.detail).toContain(path);
      expect(await sqlRows("SELECT * FROM capture_qc_sets")).toEqual([]);
    });
  }

  it("refuses an opening decided twice, an empty list and a malformed body", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    const twice = await decide(volumeId, { records: [APPROVE_ALL[0], APPROVE_ALL[0]] });
    expect(twice.json).toEqual({ error: "invalid_request", detail: "records.1.captuaRecordId" });
    expect((await decide(volumeId, { records: [] })).json).toEqual({ error: "invalid_request", detail: "records" });
    expect((await decide(volumeId, "{not json" as unknown as Json)).json).toEqual({
      error: "invalid_request",
      detail: "malformed_json",
    });
  });

  it("refuses a rejection of a spread without a side, and a side on a single image", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    // 12 is a spread, 11 and 14 single images.
    const res = await decide(volumeId, {
      records: [
        { captuaRecordId: 12, decision: "rejected", reason: "blur" },
        { captuaRecordId: 11, decision: "rejected", reason: "glare", side: "left" },
        { captuaRecordId: 14, decision: "rejected", reason: "glare" },
      ],
    });
    expect(res).toEqual({ status: 400, json: { error: "invalid_request", detail: "records.0.side, records.1.side" } });
    expect(await sqlRows("SELECT * FROM capture_qc_sets")).toEqual([]);
  });

  it("records the side of a spread's rejection, and clears it when the opening is approved", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    for (const side of ["left", "right", "both"]) {
      const res = await decide(volumeId, { records: [{ captuaRecordId: 12, decision: "rejected", reason: "blur", side }] });
      expect(res.status).toBe(200);
      expect(await sqlRows("SELECT side FROM capture_qc_decisions WHERE captua_record_id = 12")).toEqual([{ side }]);
    }
    await decide(volumeId, { records: [{ captuaRecordId: 12, decision: "approved" }] });
    expect(await sqlRows("SELECT decision, reason, side FROM capture_qc_decisions WHERE captua_record_id = 12")).toEqual([
      { decision: "approved", reason: null, side: null },
    ]);
  });

  it("takes a spread's rejection recorded without a side back, rotated, as the viewer sends it", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    await decide(volumeId, { records: [{ captuaRecordId: 12, decision: "rejected", reason: "blur", side: "left" }] });
    // As a rejection recorded before rejections named a side stands.
    await env.DB.prepare("UPDATE capture_qc_decisions SET side = NULL WHERE captua_record_id = 12").run();
    const opening: ViewerOpening = {
      captuaRecordId: 12,
      sequence: 2,
      scannerStatus: "approved",
      images: [
        { captureId: `cap-${CODE}-img_0002_c0`, role: "left", pageKey: `${CODE}-img_0002_c0` },
        { captureId: `cap-${CODE}-img_0002_c1`, role: "right", pageKey: `${CODE}-img_0002_c1` },
      ],
      decision: { decision: "rejected", reason: "blur", side: null, note: null, decidedBy: "Test Admin", decidedAt: T0 },
      rotations: [],
      earlier: null,
    };
    const state = initialState(opening);
    const entry = entryFor(opening, { ...state, turns: { [`left:cap-${CODE}-img_0002_c0`]: 1 } })!;
    expect((await decide(volumeId, { records: [entry] })).status).toBe(200);
    expect(await sqlRows("SELECT side FROM capture_qc_decisions WHERE captua_record_id = 12")).toEqual([{ side: "both" }]);
  });

  it("refuses records that are not openings of the delivery, and captures of another opening", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    // 13 was rejected on the unit, so it never became a page; 99 is not in the manifest.
    expect(
      (await decide(volumeId, { records: [...APPROVE_ALL, { captuaRecordId: 13, decision: "approved" }, { captuaRecordId: 99, decision: "approved" }] })).json,
    ).toEqual({ error: "unknown_records", captua_record_ids: [13, 99] });
    const res = await decide(volumeId, {
      records: [
        { captuaRecordId: 11, decision: "approved", rotations: [{ captureId: `cap-${CODE}-img_0002_c0`, role: "left", quarterTurns: 1 }] },
        { captuaRecordId: 12, decision: "approved", rotations: [{ captureId: "cap-nowhere", role: "left", quarterTurns: 2 }] },
      ],
    });
    expect(res).toEqual({
      status: 422,
      json: {
        error: "unknown_captures",
        captures: [
          { captua_record_id: 11, capture_id: `cap-${CODE}-img_0002_c0`, role: "left" },
          { captua_record_id: 12, capture_id: "cap-nowhere", role: "left" },
        ],
      },
    });
    expect(await sqlRows("SELECT * FROM capture_qc_sets")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// What the unit is told
// ---------------------------------------------------------------------------

describe("status and the decisions endpoint", () => {
  it("maps every case before processing, and gives a new decisionsId with every write", async () => {
    const { volumeId, manifestId } = await deliver(manifest([volume(CODE)]));

    // No decision yet.
    let s = await status(CODE);
    expect(s).toEqual({
      ref: CODE,
      volumeId,
      manifestId,
      state: "registered",
      enteredAt: new Date(T0).toISOString(),
      problems: [],
    });
    expect(await decisions(CODE)).toEqual({
      status: 404,
      json: { problems: [{ rule: "no-decisions", message: `No opening of the current delivery of ${CODE} is decided yet`, ref: CODE }] },
    });

    // Some decided, none rejected.
    world.clock.now = T0 + 1000;
    const first = await decide(volumeId, { records: [{ captuaRecordId: 11, decision: "approved" }] });
    expect(first.status).toBe(200);
    expect(Object.keys(first.json!)).toEqual(["decisionsId", "revision"]);
    s = await status(CODE);
    expect(s.state).toBe("in_capture_qc");
    expect(s.enteredAt).toBe(new Date(T0 + 1000).toISOString());
    expect(s.decisionsId).toBe(first.json!.decisionsId);
    expect(s.decidedAt).toBe(new Date(T0 + 1000).toISOString());

    // Another approval: same state, from the same time; a new set id.
    world.clock.now = T0 + 2000;
    const second = await decide(volumeId, { records: [{ captuaRecordId: 14, decision: "approved" }] });
    s = await status(CODE);
    expect(s.state).toBe("in_capture_qc");
    expect(s.enteredAt).toBe(new Date(T0 + 1000).toISOString());
    expect(s.decisionsId).toBe(second.json!.decisionsId);
    expect(s.decisionsId).not.toBe(first.json!.decisionsId);
    expect(s.decidedAt).toBe(new Date(T0 + 2000).toISOString());

    // Any rejected.
    world.clock.now = T0 + 3000;
    const third = await decide(volumeId, { records: [{ captuaRecordId: 12, decision: "rejected", reason: "blur", side: "left" }] });
    s = await status(CODE);
    expect(s.state).toBe("retakes_requested");
    expect(s.enteredAt).toBe(new Date(T0 + 3000).toISOString());
    expect(s.decisionsId).toBe(third.json!.decisionsId);

    // Every opening approved: the set is approved, and the unit is told it
    // still owes the retake of record 13, rejected on the unit.
    world.clock.now = T0 + 4000;
    const fourth = await decide(volumeId, { records: [{ captuaRecordId: 12, decision: "approved" }] });
    s = await status(CODE);
    expect(s.state).toBe("retakes_requested");
    expect(s.enteredAt).toBe(new Date(T0 + 4000).toISOString());
    expect(s.decisionsId).toBe(fourth.json!.decisionsId);
    const set = (await sqlRows("SELECT * FROM capture_qc_sets"))[0];
    expect(set).toMatchObject({
      revision: 4,
      opening_count: 3,
      decided_count: 3,
      approved_count: 3,
      rejected_count: 0,
      state: "approved",
    });

    // Once a run exists, processing takes over; the decisions stay visible.
    world.clock.now = T0 + 5000;
    await runOn(volumeId);
    s = await status(CODE);
    expect(s.state).toBe("queued");
    expect(s.decisionsId).toBe(fourth.json!.decisionsId);
    expect(s.decidedAt).toBe(new Date(T0 + 4000).toISOString());
  });

  it("gives side only on a spread's rejection, and a new decisionsId when only the side changes", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    await decide(volumeId, {
      records: [
        { captuaRecordId: 11, decision: "rejected", reason: "glare" },
        { captuaRecordId: 12, decision: "rejected", reason: "blur", side: "left" },
        { captuaRecordId: 14, decision: "approved" },
      ],
    });
    const before = await decisions(CODE);
    const byId = (res: typeof before, id: number) => res.json!.records.find((r: Json) => r.captuaRecordId === id);
    expect(Object.keys(byId(before, 11))).not.toContain("side");
    expect(byId(before, 12)).toMatchObject({ reason: "blur", side: "left" });
    expect(Object.keys(byId(before, 14))).not.toContain("side");

    await decide(volumeId, { records: [{ captuaRecordId: 12, decision: "rejected", reason: "blur", side: "both" }] });
    const after = await decisions(CODE);
    expect(byId(after, 12)).toMatchObject({ reason: "blur", side: "both" });
    expect(after.json!.decisionsId).not.toBe(before.json!.decisionsId);
    expect((await status(CODE)).decisionsId).toBe(after.json!.decisionsId);
  });

  it("answers the decisions in exactly the contract's shape", async () => {
    const { volumeId, manifestId } = await deliver(manifest([volume(CODE)]));
    world.clock.now = T0 + 1000;
    await decide(volumeId, { records: [{ captuaRecordId: 14, decision: "approved", note: "Checked twice" }] }, world.steward);
    world.clock.now = T0 + 2000;
    const last = await decide(volumeId, {
      manifestId,
      records: [
        { captuaRecordId: 11, decision: "approved", rotations: [{ captureId: `cap-${CODE}-img_0001_c0`, role: "single", quarterTurns: 2 }] },
        {
          captuaRecordId: 12,
          decision: "rejected",
          reason: "other",
          side: "right",
          note: "Torn corner hides the foliation",
          rotations: [
            { captureId: `cap-${CODE}-img_0002_c1`, role: "right", quarterTurns: 3 },
            { captureId: `cap-${CODE}-img_0002_c0`, role: "left", quarterTurns: 1 },
          ],
        },
      ],
    });
    const res = await decisions(CODE);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      decisionsId: last.json!.decisionsId,
      decidedAt: new Date(T0 + 2000).toISOString(),
      manifestId,
      records: [
        {
          captuaRecordId: 11,
          decision: "approved",
          decidedBy: "Test Admin",
          decidedAt: new Date(T0 + 2000).toISOString(),
          rotations: [{ captureId: `cap-${CODE}-img_0001_c0`, role: "single", quarterTurns: 2 }],
        },
        {
          captuaRecordId: 12,
          decision: "rejected",
          reason: "other",
          side: "right",
          note: "Torn corner hides the foliation",
          decidedBy: "Test Admin",
          decidedAt: new Date(T0 + 2000).toISOString(),
          rotations: [
            { captureId: `cap-${CODE}-img_0002_c0`, role: "left", quarterTurns: 1 },
            { captureId: `cap-${CODE}-img_0002_c1`, role: "right", quarterTurns: 3 },
          ],
        },
        {
          captuaRecordId: 14,
          decision: "approved",
          note: "Checked twice",
          decidedBy: "Test Steward",
          decidedAt: new Date(T0 + 1000).toISOString(),
          rotations: [],
        },
      ],
    });
    // Key order as the contract writes it.
    expect(Object.keys(res.json!)).toEqual(["decisionsId", "decidedAt", "manifestId", "records"]);
    expect(Object.keys(res.json!.records[1])).toEqual([
      "captuaRecordId", "decision", "reason", "side", "note", "decidedBy", "decidedAt", "rotations",
    ]);

    // A decision replaces the opening's rotations whole.
    await decide(volumeId, { records: [{ captuaRecordId: 12, decision: "approved" }] });
    const after = await decisions(CODE);
    const twelve = after.json!.records.find((r: Json) => r.captuaRecordId === 12);
    expect(twelve).toEqual({
      captuaRecordId: 12,
      decision: "approved",
      decidedBy: "Test Admin",
      decidedAt: new Date(T0 + 2000).toISOString(),
      rotations: [],
    });
  });

  it("tells the unit Fisqua reviewer for a decider without a name, never an email", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    await decide(volumeId, { records: [{ captuaRecordId: 11, decision: "approved" }] }, { ...world.admin, name: null });
    await decide(volumeId, { records: [{ captuaRecordId: 12, decision: "approved" }] }, { ...world.admin, name: "   " });
    const res = await decisions(CODE);
    expect(res.json!.records.map((r: Json) => r.decidedBy)).toEqual(["Fisqua reviewer", "Fisqua reviewer"]);
    expect(JSON.stringify(res.json)).not.toContain(world.admin.email);
  });

  it("answers 404 no-decisions for an unknown ref, and authenticates as the link does", async () => {
    await deliver(manifest([volume(CODE)]));
    expect(await decisions("co-test-unknown")).toEqual({
      status: 404,
      json: { problems: [{ rule: "no-decisions", message: "Fisqua holds no delivery for co-test-unknown", ref: "co-test-unknown" }] },
    });
    expect((await decisions(CODE, { token: null })).status).toBe(401);
    expect((await decisions(CODE, { token: "0".repeat(64) })).status).toBe(401);
    const otherToken = await seedScanner(SECOND_TEST_TENANT_ID, "rig-2");
    expect((await decisions(CODE, { token: otherToken })).status).toBe(403);
    const post = await handleVolumeDecisions(world.deps, new Request(`${HOST}/api/capture/v1/volumes/${CODE}/decisions`, { method: "POST" }), CODE);
    expect(post.status).toBe(405);
  });

  it("never shows one tenant's decisions to another tenant's unit", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    await decide(volumeId, { records: APPROVE_ALL });
    const otherToken = await seedScanner(SECOND_TEST_TENANT_ID, "rig-2");
    const res = await decisions(CODE, { token: otherToken, host: OTHER_HOST });
    expect(res.status).toBe(404);
    expect(res.json!.problems[0].rule).toBe("no-decisions");
  });

  it("answers through the route module without a session", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    await decide(volumeId, { records: APPROVE_ALL });
    const request = new Request(`${HOST}/api/capture/v1/volumes/${CODE}/decisions`, {
      headers: { Authorization: `Bearer ${world.token}` },
    });
    const res = await decisionsLoader({
      request,
      params: { ref: CODE },
      context: { cloudflare: { env } },
    } as any);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.json() as Json).records).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Runs, races and retakes
// ---------------------------------------------------------------------------

describe("clearing a decision", () => {
  it("drops the cleared opening and its rotations from the set, with a new decisionsId", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    const rot = { captureId: `cap-${CODE}-img_0002_c0`, role: "left", quarterTurns: 1 };
    await decide(volumeId, {
      records: [
        { captuaRecordId: 12, decision: "rejected", reason: "blur", side: "left", rotations: [rot] },
        { captuaRecordId: 14, decision: "approved" },
      ],
    });
    // Read from the status, which the unit asks before it fetches anything.
    const before = (await status(CODE)).decisionsId;
    const res = await decide(volumeId, { records: [{ captuaRecordId: 12, decision: null }] });
    expect(res.status).toBe(200);
    expect(await sqlRows("SELECT captua_record_id FROM capture_qc_decisions")).toEqual([{ captua_record_id: 14 }]);
    expect(await sqlRows("SELECT * FROM capture_qc_rotations")).toEqual([]);
    expect(await sqlRows("SELECT decided_count, approved_count, rejected_count, state FROM capture_qc_sets")).toEqual([
      { decided_count: 1, approved_count: 1, rejected_count: 0, state: "in_capture_qc" },
    ]);
    const after = await decisions(CODE);
    expect(after.json!.decisionsId).not.toBe(before);
    expect(after.json!.records.map((r: Json) => r.captuaRecordId)).toEqual([14]);
    expect((await status(CODE)).decisionsId).toBe(after.json!.decisionsId);
  });

  it("answers a set whose decisions were all cleared with no records, and records the fetch", async () => {
    const { volumeId, manifestId } = await deliver(manifest([volume(CODE)]));
    await decide(volumeId, { records: [{ captuaRecordId: 14, decision: "approved" }] });
    await decide(volumeId, { records: [{ captuaRecordId: 14, decision: null }] });
    const res = await decisions(CODE);
    expect(res.status).toBe(200);
    expect(res.json!.records).toEqual([]);
    expect(res.json!.manifestId).toBe(manifestId);
    expect((await status(CODE)).decisionsId).toBe(res.json!.decisionsId);
    expect(await sqlRows("SELECT decisions_id, set_revision FROM capture_qc_fetches")).toEqual([
      { decisions_id: res.json!.decisionsId, set_revision: 2 },
    ]);
  });

  it("refuses to clear a decision the unit has fetched, and lets it be changed instead", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    await decide(volumeId, {
      records: [
        { captuaRecordId: 12, decision: "rejected", reason: "blur", side: "left" },
        { captuaRecordId: 14, decision: "approved" },
      ],
    });
    await decisions(CODE);
    // 11 is decided after the fetch, so it can still be cleared on its own.
    await decide(volumeId, { records: [{ captuaRecordId: 11, decision: "approved" }] });
    const set = await sqlRows("SELECT revision, decisions_id FROM capture_qc_sets");

    const res = await decide(volumeId, {
      records: [
        { captuaRecordId: 14, decision: null },
        { captuaRecordId: 12, decision: null },
        { captuaRecordId: 11, decision: null },
      ],
    });
    expect(res).toEqual({ status: 409, json: { error: "decision_sent", captua_record_ids: [12, 14] } });
    // Refused whole: nothing changed.
    expect(await sqlRows("SELECT revision, decisions_id FROM capture_qc_sets")).toEqual(set);
    expect((await sqlRows("SELECT captua_record_id FROM capture_qc_decisions ORDER BY 1")).map((r) => r.captua_record_id)).toEqual([
      11, 12, 14,
    ]);

    expect((await decide(volumeId, { records: [{ captuaRecordId: 11, decision: null }] })).status).toBe(200);
    expect((await decide(volumeId, { records: [{ captuaRecordId: 12, decision: "approved" }] })).status).toBe(200);
    // Changed after the fetch, the decision has not reached the unit, and can be cleared.
    expect((await decide(volumeId, { records: [{ captuaRecordId: 12, decision: null }] })).status).toBe(200);
  });

  it("writes nothing when the unit fetches the decision between the check and the batch", async () => {
    const { volumeId, manifestId } = await deliver(manifest([volume(CODE)]));
    await decide(volumeId, { records: [{ captuaRecordId: 14, decision: "approved" }] });
    const db = drizzle(env.DB);
    const racing = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: unknown) => {
            // The unit's fetch lands just before the write.
            await env.DB.prepare(
              `INSERT INTO capture_qc_fetches (tenant_id, delivery_id, decisions_id, set_revision, first_fetched_at, last_fetched_at)
               SELECT tenant_id, delivery_id, decisions_id, revision, 1, 1 FROM capture_qc_sets WHERE delivery_id = ?`,
            )
              .bind(manifestId)
              .run();
            return (target as any).batch(statements);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const res = await decide(volumeId, { manifestId, records: [{ captuaRecordId: 14, decision: null }], expectedRevision: 1 }, world.admin, world.tenant, racing as any);
    expect(res).toEqual({ status: 409, json: { error: "decision_sent", captua_record_ids: [14] } });
    expect(await sqlRows("SELECT captua_record_id FROM capture_qc_decisions")).toEqual([{ captua_record_id: 14 }]);
    expect(await sqlRows("SELECT revision FROM capture_qc_sets")).toEqual([{ revision: 1 }]);
  });

  it("keeps a decision another request wrote and the unit fetched after a clear's check found the opening undecided", async () => {
    const { volumeId, manifestId } = await deliver(manifest([volume(CODE)]));
    await decide(volumeId, { records: [{ captuaRecordId: 11, decision: "approved" }] });
    const db = drizzle(env.DB);
    const racing = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: unknown) => {
            // Another request approves 14 at revision 2, and the unit fetches it.
            await env.DB.batch([
              env.DB.prepare(
                `INSERT INTO capture_qc_decisions (tenant_id, delivery_id, captua_record_id, decision, decided_by, decided_by_name,
                   decided_at, set_revision) SELECT tenant_id, delivery_id, 14, 'approved', ?, 'Test Admin', 1, 2
                 FROM capture_qc_sets WHERE delivery_id = ?`,
              ).bind(world.admin.id, manifestId),
              env.DB.prepare("UPDATE capture_qc_sets SET revision = 2 WHERE delivery_id = ?").bind(manifestId),
              env.DB.prepare(
                `INSERT INTO capture_qc_fetches (tenant_id, delivery_id, decisions_id, set_revision, first_fetched_at, last_fetched_at)
                 SELECT tenant_id, delivery_id, decisions_id, revision, 1, 1 FROM capture_qc_sets WHERE delivery_id = ?`,
              ).bind(manifestId),
            ]);
            return (target as any).batch(statements);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    // No expectedRevision: only the fetch guard can stop it.
    const res = await decide(volumeId, { manifestId, records: [{ captuaRecordId: 14, decision: null }] }, world.admin, world.tenant, racing as any);
    expect(res).toEqual({ status: 409, json: { error: "decision_sent", captua_record_ids: [14] } });
    expect((await sqlRows("SELECT captua_record_id FROM capture_qc_decisions ORDER BY 1")).map((r) => r.captua_record_id)).toEqual([
      11, 14,
    ]);
    expect(await sqlRows("SELECT revision FROM capture_qc_sets")).toEqual([{ revision: 2 }]);
  });
});

describe("runs, races and retakes", () => {
  it("refuses a decision once a run has started, and once one has finished", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    await decide(volumeId, { records: APPROVE_ALL });
    const before = await sqlRows("SELECT * FROM capture_qc_decisions ORDER BY captua_record_id");
    await runOn(volumeId);
    const res = await decide(volumeId, { records: [{ captuaRecordId: 11, decision: "rejected", reason: "blur" }] });
    expect(res).toEqual({ status: 409, json: { error: "run_started", volume_id: volumeId } });
    expect(await sqlRows("SELECT * FROM capture_qc_decisions ORDER BY captua_record_id")).toEqual(before);
  });

  it("refuses a decision on a volume whose run has finished, the volume still received", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    await runOn(volumeId, { closed: true });
    expect(await decide(volumeId, { records: APPROVE_ALL })).toEqual({
      status: 409,
      json: { error: "run_started", volume_id: volumeId },
    });
    expect(await sqlRows("SELECT * FROM capture_qc_sets")).toEqual([]);
  });

  it("writes nothing when a run claims the volume between the read and the batch", async () => {
    const { volumeId, manifestId } = await deliver(manifest([volume(CODE)]));
    const db = drizzle(env.DB);
    const statements = buildDecisionStatements(db, {
      tenantId: DEFAULT_TEST_TENANT_ID,
      volumeId,
      deliveryId: manifestId,
      openingCount: 3,
      decisions: [{ captuaRecordId: 11, decision: "approved", reason: null, side: null, note: null, rotations: [] }],
      userId: world.admin.id,
      userName: "Test Admin",
      decisionsId: crypto.randomUUID(),
      writeId: crypto.randomUUID(),
      now: world.clock.now,
    });
    // The run claims first; the batch planned before it lands after.
    await runOn(volumeId);
    await db.batch(statements as any);
    expect(await sqlRows("SELECT * FROM capture_qc_sets")).toEqual([]);
    expect(await sqlRows("SELECT * FROM capture_qc_decisions")).toEqual([]);
  });

  it("answers run_started when the run claims the volume while the action is writing", async () => {
    const { volumeId, manifestId } = await deliver(manifest([volume(CODE)]));
    const db = drizzle(env.DB);
    let claimed = false;
    // A database whose batch lets a run claim the volume just before it runs.
    const racing = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: unknown) => {
            if (!claimed) {
              claimed = true;
              await runOn(volumeId);
            }
            return (target as any).batch(statements);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const request = new Request(`${HOST}/admin/capture/volumes/${volumeId}/decisions`, {
      method: "POST",
      body: JSON.stringify({ manifestId, records: APPROVE_ALL }),
    });
    const res = await answer(
      await recordDecisionsAction(
        { db: racing as any, now: () => world.clock.now, newId: () => crypto.randomUUID() },
        request,
        volumeId,
        world.tenant,
        world.admin,
      ),
    );
    expect(res).toEqual({ status: 409, json: { error: "run_started", volume_id: volumeId } });
    expect(await sqlRows("SELECT * FROM capture_qc_sets")).toEqual([]);
  });

  it("starts a retake's new delivery with the unchanged approvals only, and refuses a write naming the older one", async () => {
    const first = await deliver(manifest([volume(CODE)]));
    await decide(first.volumeId, { records: [...APPROVE_ALL.slice(0, 2), { captuaRecordId: 14, decision: "rejected", reason: "framing" }] });
    expect((await status(CODE)).state).toBe("retakes_requested");

    world.clock.now = T0 + 10_000;
    const retake = await deliver(manifest([volume(CODE)]));
    expect(retake.volumeId).toBe(first.volumeId);
    const s = await status(CODE);
    expect(s).toMatchObject({
      ref: CODE,
      volumeId: first.volumeId,
      manifestId: retake.manifestId,
      state: "in_capture_qc",
      enteredAt: new Date(T0 + 10_000).toISOString(),
      problems: [],
    });
    // The two approvals came over; the rejected opening waits for review.
    const carried = await decisions(CODE);
    expect(carried.json!.manifestId).toBe(retake.manifestId);
    expect(carried.json!.records.map((r: Json) => [r.captuaRecordId, r.decision])).toEqual([
      [11, "approved"],
      [12, "approved"],
    ]);
    // The earlier delivery's decisions stay where they were made.
    expect(await sqlRows("SELECT delivery_id, COUNT(*) AS n FROM capture_qc_decisions GROUP BY delivery_id ORDER BY n DESC")).toEqual([
      { delivery_id: first.manifestId, n: 3 },
      { delivery_id: retake.manifestId, n: 2 },
    ]);

    // A page opened on the earlier handover cannot decide the retake.
    expect(await decide(first.volumeId, { manifestId: first.manifestId, records: APPROVE_ALL })).toEqual({
      status: 409,
      json: { error: "delivery_changed", manifest_id: retake.manifestId },
    });
    const now = await decide(first.volumeId, { manifestId: retake.manifestId, records: APPROVE_ALL });
    expect(now.status).toBe(200);
    const after = await decisions(CODE);
    expect(after.json!.manifestId).toBe(retake.manifestId);
    expect(after.json!.decisionsId).toBe(now.json!.decisionsId);
    // Every opening approved; record 13 is still rejected on the unit.
    expect((await status(CODE)).state).toBe("retakes_requested");
  });

  it("refuses decisions that do not name the delivery they were made on", async () => {
    const first = await deliver(manifest([volume(CODE)]));
    expect(await decide(first.volumeId, { manifestId: undefined, records: APPROVE_ALL })).toEqual({
      status: 400,
      json: { error: "invalid_request", detail: "manifestId" },
    });
    // Opened on the first handover; a retake with the same record ids and
    // new images arrives before the approvals are sent.
    const retake = await deliver(manifest([volume(CODE)]));
    expect(await decide(first.volumeId, { manifestId: first.manifestId, records: APPROVE_ALL })).toEqual({
      status: 409,
      json: { error: "delivery_changed", manifest_id: retake.manifestId },
    });
    expect(await sqlRows("SELECT * FROM capture_qc_sets")).toEqual([]);
    expect((await status(CODE)).state).toBe("registered");
  });

  it("answers each of two interleaved writes with its own decisionsId", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    const db = drizzle(env.DB);
    let other: { status: number; json: Json | null } | null = null;
    // Request A's batch commits, then request B commits before A reads its outcome.
    const interleaved = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: unknown) => {
            const results = await (target as any).batch(statements);
            if (other === null) {
              other = await decide(volumeId, { records: [{ captuaRecordId: 12, decision: "rejected", reason: "glare", side: "both" }] });
            }
            return results;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const mine = await decide(volumeId, { records: [{ captuaRecordId: 11, decision: "approved" }] }, world.admin, world.tenant, interleaved as any);
    expect(mine.status).toBe(200);
    expect(other!.status).toBe(200);
    expect(mine.json!.decisionsId).not.toBe(other!.json!.decisionsId);
    // The set as it stands is B's, and holds both decisions.
    const set = (await sqlRows("SELECT decisions_id, revision, decided_count FROM capture_qc_sets"))[0];
    expect(set).toEqual({ decisions_id: other!.json!.decisionsId, revision: 2, decided_count: 2 });
  });

  it("writes nothing when a retake supersedes the delivery between the read and the batch", async () => {
    const first = await deliver(manifest([volume(CODE)]));
    const db = drizzle(env.DB);
    const statements = buildDecisionStatements(db, {
      tenantId: DEFAULT_TEST_TENANT_ID,
      volumeId: first.volumeId,
      deliveryId: first.manifestId,
      openingCount: 3,
      decisions: [{ captuaRecordId: 11, decision: "approved", reason: null, side: null, note: null, rotations: [] }],
      userId: world.admin.id,
      userName: "Test Admin",
      decisionsId: crypto.randomUUID(),
      writeId: crypto.randomUUID(),
      now: world.clock.now,
    });
    await deliver(manifest([volume(CODE)]));
    await db.batch(statements as any);
    expect(await sqlRows("SELECT * FROM capture_qc_sets")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D1's limits
// ---------------------------------------------------------------------------

function boundOf(stmt: unknown): { sql: string; params: unknown[] } {
  const s = stmt as { toSQL?: () => { sql: string; params: unknown[] }; getQuery?: () => { sql: string; params: unknown[] } };
  return s.toSQL?.() ?? s.getQuery!();
}

describe("the revision guard", () => {
  const approve11 = { captuaRecordId: 11, decision: "approved" };
  const reject11 = { captuaRecordId: 11, decision: "rejected", reason: "glare" };

  it("answers the set's revision with every write, and checks none without expectedRevision", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    const first = await decide(volumeId, { records: [approve11] });
    expect(first).toEqual({ status: 200, json: { decisionsId: expect.any(String), revision: 1 } });
    const second = await decide(volumeId, { records: [reject11] });
    expect(second.json!.revision).toBe(2);
    const third = await decide(volumeId, { records: [{ captuaRecordId: 12, decision: "approved" }] });
    expect(third.json!.revision).toBe(3);
  });

  it("refuses a write on an older revision, or on 0 once a set exists, and writes nothing", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    expect((await decide(volumeId, { records: [approve11], expectedRevision: 0 })).json!.revision).toBe(1);
    const before = await sqlRows("SELECT decisions_id, revision FROM capture_qc_sets");
    expect(await decide(volumeId, { records: [reject11], expectedRevision: 0 })).toEqual({
      status: 409,
      json: { error: "revision_changed", revision: 1 },
    });
    expect(await decide(volumeId, { records: [reject11], expectedRevision: 5 })).toEqual({
      status: 409,
      json: { error: "revision_changed", revision: 1 },
    });
    expect(await sqlRows("SELECT decisions_id, revision FROM capture_qc_sets")).toEqual(before);
    expect(await sqlRows("SELECT decision FROM capture_qc_decisions WHERE captua_record_id = 11")).toEqual([{ decision: "approved" }]);
    expect((await decide(volumeId, { records: [reject11], expectedRevision: 1 })).json!.revision).toBe(2);
  });

  it("keeps run_started and delivery_changed ahead of revision_changed", async () => {
    const { volumeId, manifestId } = await deliver(manifest([volume(CODE)]));
    await decide(volumeId, { records: [approve11] });
    expect(
      (await decide(volumeId, { manifestId: "an-older-delivery", records: [reject11], expectedRevision: 0 })).json!.error,
    ).toBe("delivery_changed");
    await runOn(volumeId);
    expect((await decide(volumeId, { manifestId, records: [reject11], expectedRevision: 0 })).json!.error).toBe("run_started");
  });

  it("lets no late commit of a lost request win over a newer write", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    // Revision 1: an earlier write.
    await decide(volumeId, { records: [{ captuaRecordId: 12, decision: "approved" }], expectedRevision: 0 });
    const db = drizzle(env.DB);
    let retried: { status: number; json: Json | null } | null = null;
    let newer: { status: number; json: Json | null } | null = null;
    // The approval's handler loses its connection and stalls before its
    // batch; its retry lands, then a newer rejection, then the stalled
    // handler commits last, still expecting revision 1.
    const stalled = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: unknown) => {
            retried = await decide(volumeId, { records: [approve11], expectedRevision: 1 });
            newer = await decide(volumeId, { records: [reject11], expectedRevision: retried.json!.revision });
            return (target as any).batch(statements);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const late = await decide(volumeId, { records: [approve11], expectedRevision: 1 }, world.admin, world.tenant, stalled as any);
    expect(retried!.json!.revision).toBe(2);
    expect(newer!.json!.revision).toBe(3);
    expect(late).toEqual({ status: 409, json: { error: "revision_changed", revision: 3 } });
    expect(await sqlRows("SELECT decision, reason FROM capture_qc_decisions WHERE captua_record_id = 11")).toEqual([
      { decision: "rejected", reason: "glare" },
    ]);
    expect((await sqlRows("SELECT revision FROM capture_qc_sets"))[0].revision).toBe(3);
  });

  it("makes two people deciding at once refuse each other's write and reconcile", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    await decide(volumeId, { records: [approve11], expectedRevision: 0 });
    // Both read revision 1.
    const a = await decide(volumeId, { records: [{ captuaRecordId: 12, decision: "approved" }], expectedRevision: 1 }, world.admin);
    const b = await decide(volumeId, { records: [{ captuaRecordId: 14, decision: "rejected", reason: "blur" }], expectedRevision: 1 }, world.steward);
    expect(a.json!.revision).toBe(2);
    expect(b).toEqual({ status: 409, json: { error: "revision_changed", revision: 2 } });
    // B reads again and sends on the new revision.
    const again = await decide(volumeId, { records: [{ captuaRecordId: 14, decision: "rejected", reason: "blur" }], expectedRevision: 2 }, world.steward);
    expect(again.json!.revision).toBe(3);
    expect(await sqlRows("SELECT captua_record_id AS r, decision FROM capture_qc_decisions ORDER BY captua_record_id")).toEqual([
      { r: 11, decision: "approved" },
      { r: 12, decision: "approved" },
      { r: 14, decision: "rejected" },
    ]);
  });
});

describe("an image is its capture id and its role", () => {
  it("keeps a separate correction for each half of a spread that shares one capture id", async () => {
    const { volumeId } = await deliver(manifest([sharedCaptureVolume(CODE)]));
    const shared = `cap-${CODE}-0002`;
    expect(
      await sqlRows("SELECT capture_id, role FROM capture_images WHERE captua_record_id = 12 ORDER BY role"),
    ).toEqual([
      { capture_id: shared, role: "left" },
      { capture_id: shared, role: "right" },
    ]);
    const res = await decide(volumeId, {
      records: [
        {
          captuaRecordId: 12,
          decision: "approved",
          rotations: [
            { captureId: shared, role: "right", quarterTurns: 3 },
            { captureId: shared, role: "left", quarterTurns: 1 },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(
      await sqlRows("SELECT capture_id, role, quarter_turns FROM capture_qc_rotations ORDER BY role"),
    ).toEqual([
      { capture_id: shared, role: "left", quarter_turns: 1 },
      { capture_id: shared, role: "right", quarter_turns: 3 },
    ]);
    const twelve = (await decisions(CODE)).json!.records.find((r: Json) => r.captuaRecordId === 12);
    expect(twelve.rotations).toEqual([
      { captureId: shared, role: "left", quarterTurns: 1 },
      { captureId: shared, role: "right", quarterTurns: 3 },
    ]);
  });

  it("refuses a rotation whose role the opening does not have, naming the role", async () => {
    const { volumeId } = await deliver(manifest([sharedCaptureVolume(CODE)]));
    const res = await decide(volumeId, {
      records: [
        { captuaRecordId: 12, decision: "approved", rotations: [{ captureId: `cap-${CODE}-0002`, role: "single", quarterTurns: 1 }] },
        { captuaRecordId: 11, decision: "approved", rotations: [{ captureId: `cap-${CODE}-img_0001_c0`, role: "left", quarterTurns: 2 }] },
      ],
    });
    expect(res).toEqual({
      status: 422,
      json: {
        error: "unknown_captures",
        captures: [
          { captua_record_id: 12, capture_id: `cap-${CODE}-0002`, role: "single" },
          { captua_record_id: 11, capture_id: `cap-${CODE}-img_0001_c0`, role: "left" },
        ],
      },
    });
    expect(await sqlRows("SELECT * FROM capture_qc_sets")).toEqual([]);
  });

  it("refuses the same capture id and role twice in one opening", async () => {
    const { volumeId } = await deliver(manifest([sharedCaptureVolume(CODE)]));
    const shared = `cap-${CODE}-0002`;
    const res = await decide(volumeId, {
      records: [
        {
          captuaRecordId: 12,
          decision: "approved",
          rotations: [
            { captureId: shared, role: "left", quarterTurns: 1 },
            { captureId: shared, role: "left", quarterTurns: 3 },
          ],
        },
      ],
    });
    expect(res).toEqual({ status: 400, json: { error: "invalid_request", detail: "records.0.rotations" } });
    expect(await sqlRows("SELECT * FROM capture_qc_sets")).toEqual([]);
  });

  it("keeps every rotation when migration 0096 rekeys the table", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    await decide(volumeId, {
      records: [
        { captuaRecordId: 11, decision: "approved", rotations: [{ captureId: `cap-${CODE}-img_0001_c0`, role: "single", quarterTurns: 2 }] },
        {
          captuaRecordId: 12,
          decision: "approved",
          rotations: [
            { captureId: `cap-${CODE}-img_0002_c0`, role: "left", quarterTurns: 1 },
            { captureId: `cap-${CODE}-img_0002_c1`, role: "right", quarterTurns: 3 },
          ],
        },
      ],
    });
    const before = await sqlRows("SELECT * FROM capture_qc_rotations ORDER BY captua_record_id, capture_id");
    expect(before).toHaveLength(3);

    // The table as 0094 created it and 0095 rebuilt it, holding those rows.
    const createIn = (file: string) => migrationStatements(file).find((s) => s.startsWith("CREATE TABLE capture_qc_rotations ("));
    const create0095 = createIn("0095_capture_delivery_route.sql");
    expect(create0095).toBeDefined();
    expect(create0095).toBe(createIn("0094_capture_qc.sql"));
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE rotations_held AS SELECT * FROM capture_qc_rotations"),
      env.DB.prepare("DROP TABLE capture_qc_rotations"),
      env.DB.prepare(create0095!),
      env.DB.prepare("INSERT INTO capture_qc_rotations SELECT * FROM rotations_held"),
      env.DB.prepare("DROP TABLE rotations_held"),
    ]);
    const keyOf = async () =>
      (await sqlRows("PRAGMA table_info(capture_qc_rotations)"))
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
    expect(await keyOf()).toEqual(["tenant_id", "delivery_id", "captua_record_id", "capture_id"]);

    await runMigrationFile("0096_capture_qc_rotation_role.sql");

    expect(await keyOf()).toEqual(["tenant_id", "delivery_id", "captua_record_id", "capture_id", "role"]);
    expect(await sqlRows("SELECT * FROM capture_qc_rotations ORDER BY captua_record_id, capture_id")).toEqual(before);
    expect(await sqlRows("SELECT name FROM sqlite_master WHERE name LIKE 'capture_qc_rotations%' ORDER BY name")).toEqual([
      { name: "capture_qc_rotations" },
    ]);
    // The rekeyed table still takes both halves of a spread under one capture id.
    expect((await decisions(CODE)).json!.records.find((r: Json) => r.captuaRecordId === 12).rotations).toHaveLength(2);
  });
});

describe("D1's limits", () => {
  it("decides 1,000 openings in one request, every statement within 100 parameters and 100 KB", async () => {
    const code = "co-test-big";
    await createTestDescription({
      tenantId: DEFAULT_TEST_TENANT_ID,
      repositoryId: world.repositoryId,
      descriptionLevel: "volume",
      referenceCode: code,
    });
    const { volumeId, manifestId } = await deliver(manifest([bigVolume(code, 1000)]));
    const records = Array.from({ length: 1000 }, (_, i) => ({
      captuaRecordId: i + 1,
      decision: i % 10 === 0 ? "rejected" : "approved",
      ...(i % 10 === 0 ? { reason: "other", side: "both" } : {}),
      // 900 characters, some of them two bytes: under the set's cap of 1,000,000 bytes.
      note: `ñ${"n".repeat(898)}${i % 10}`,
      rotations: [
        { captureId: `cap-${code}-img_${pad(i + 1)}_c0`, role: "left", quarterTurns: 1 },
        { captureId: `cap-${code}-img_${pad(i + 1)}_c1`, role: "right", quarterTurns: 3 },
      ],
    }));

    // The statements as the action would build them.
    const statements = buildDecisionStatements(drizzle(env.DB), {
      tenantId: DEFAULT_TEST_TENANT_ID,
      volumeId,
      deliveryId: manifestId,
      openingCount: 1000,
      decisions: records.map((r) => ({
        captuaRecordId: r.captuaRecordId,
        decision: r.decision as "approved" | "rejected",
        reason: (r.reason ?? null) as "other" | null,
        side: (r.side ?? null) as "both" | null,
        note: r.note,
        rotations: r.rotations,
      })),
      userId: world.admin.id,
      userName: "Test Admin",
      decisionsId: crypto.randomUUID(),
      writeId: crypto.randomUUID(),
      now: world.clock.now,
    });
    expect(statements.length).toBeLessThanOrEqual(89);
    for (const stmt of statements) {
      const { sql, params } = boundOf(stmt);
      expect(params.length).toBeLessThanOrEqual(100);
      expect(new TextEncoder().encode(sql).length).toBeLessThan(100_000);
      for (const p of params) {
        if (typeof p === "string") expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(PAYLOAD_CHUNK_BYTES);
      }
    }

    // And the action, end to end.
    const res = await decide(volumeId, { records });
    expect(res.status).toBe(200);
    const set = (await sqlRows("SELECT * FROM capture_qc_sets"))[0];
    expect(set).toMatchObject({ opening_count: 1000, decided_count: 1000, approved_count: 900, rejected_count: 100, state: "retakes_requested" });
    expect(set.notes_bytes).toBe(1000 * 901);
    expect((await sqlRows("SELECT COUNT(*) AS n FROM capture_qc_rotations"))[0].n).toBe(2000);
    const answer_ = await decisions(code);
    expect(answer_.json!.records).toHaveLength(1000);
    expect(answer_.json!.records[0]).toMatchObject({ captuaRecordId: 1, decision: "rejected", reason: "other" });
    expect(answer_.json!.records[1].reason).toBeUndefined();
  });

  it("refuses a write that would take a set's notes past 1,000,000 bytes, and keeps the set as it was", async () => {
    const code = "co-test-notes";
    await createTestDescription({
      tenantId: DEFAULT_TEST_TENANT_ID,
      repositoryId: world.repositoryId,
      descriptionLevel: "volume",
      referenceCode: code,
    });
    const { volumeId } = await deliver(manifest([bigVolume(code, 600)]));
    const noted = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => ({ captuaRecordId: from + i + 1, decision: "approved", note: "n".repeat(2000) }));
    const ok = await decide(volumeId, { records: noted(0, 400) });
    expect(ok.status).toBe(200);
    const before = await sqlRows("SELECT * FROM capture_qc_sets");
    const res = await decide(volumeId, { records: noted(400, 600) });
    expect(res).toEqual({ status: 413, json: { error: "decisions_too_large", max_notes_bytes: 1_000_000 } });
    expect(await sqlRows("SELECT * FROM capture_qc_sets")).toEqual(before);
    expect((await sqlRows("SELECT COUNT(*) AS n FROM capture_qc_decisions"))[0].n).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// An assigned reviewer with no role, through the request handler
// ---------------------------------------------------------------------------

describe("an assigned reviewer with no role flag", () => {
  /**
   * A server build with a bare root, a layout carrying the member
   * confinement the authenticated layout runs, and the real capture QC
   * queue, viewer and decisions route modules, driven by React Router's
   * request handler as the user would be.
   */
  async function handle(user: User, path: string, init: { method?: string; body?: string } = {}) {
    const { createRequestHandler } = await import("react-router");
    const queue = await import("../../app/routes/_auth.admin.capture.qc");
    const viewer = await import("../../app/routes/_auth.admin.capture.qc.$volumeId");
    const decisionsRoute = await import("../../app/routes/_auth.admin.capture.volumes.$volumeId.decisions");
    const build: any = {
      entry: {
        module: {
          default: (_request: Request, status: number, headers: Headers) =>
            new Response("document", { status, headers }),
        },
      },
      routes: {
        root: { id: "root", path: "", module: { default: () => null } },
        layout: {
          id: "layout",
          parentId: "root",
          module: { middleware: [confineMemberAccess], default: () => null },
        },
        queue: { id: "queue", parentId: "layout", path: "admin/capture/qc", module: queue },
        viewer: { id: "viewer", parentId: "layout", path: "admin/capture/qc/:volumeId", module: viewer },
        decisions: {
          id: "decisions",
          parentId: "layout",
          path: "admin/capture/volumes/:volumeId/decisions",
          module: decisionsRoute,
        },
      },
      assets: { entry: { module: "/entry.js", imports: [] }, routes: {}, url: "/manifest.js", version: "test" },
      publicPath: "/",
      assetsBuildDirectory: "build/client",
      future: { v8_middleware: true },
      ssr: true,
      isSpaMode: false,
      prerender: [],
      routeDiscovery: { mode: "lazy", manifestPath: "/__manifest" },
    };
    const ctx = new RouterContextProvider();
    ctx.set(userContext, user);
    ctx.set(tenantContext, { ...world.tenant, digitizationEnabled: true });
    ctx.set(grantContext, null);
    ctx.set(impersonationContext, null);
    (ctx as any).cloudflare = { env };
    const method = init.method ?? "GET";
    const headers: Record<string, string> =
      method === "GET"
        ? { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", Accept: "text/html" }
        : { "Content-Type": "application/json", Origin: HOST, "Sec-Fetch-Dest": "empty" };
    const handler = createRequestHandler(build, "production");
    return handler(new Request(`${HOST}${path}`, { method, headers, body: init.body }), ctx);
  }

  it("is sent to /no-access before assignment, and opens the queue and viewer once assigned", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));

    const before = await handle(world.reviewer, "/admin/capture/qc");
    expect(before.status).toBe(302);
    expect(before.headers.get("Location")).toBe("/no-access");

    expect((await assign(volumeId, world.reviewer.id)).status).toBe(200);
    const queue = await handle(world.reviewer, "/admin/capture/qc");
    expect(queue.status).toBe(200);
    const viewer = await handle(world.reviewer, `/admin/capture/qc/${volumeId}`);
    expect(viewer.status).toBe(200);
  });

  it("saves a decision once assigned, and is refused 403 before", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    const body = async () =>
      JSON.stringify({
        manifestId: await currentDelivery(volumeId),
        records: [{ captuaRecordId: 11, decision: "approved" }],
      });

    const before = await handle(world.reviewer, `/admin/capture/volumes/${volumeId}/decisions`, {
      method: "POST",
      body: await body(),
    });
    expect(before.status).toBe(403);

    expect((await assign(volumeId, world.reviewer.id)).status).toBe(200);
    const saved = await handle(world.reviewer, `/admin/capture/volumes/${volumeId}/decisions`, {
      method: "POST",
      body: await body(),
    });
    expect(saved.status).toBe(200);
    expect(
      (await sqlRows("SELECT COUNT(*) AS n FROM capture_qc_decisions WHERE decided_by = ?", world.reviewer.id))[0].n,
    ).toBe(1);
  });
});

// @version v0.8.0
