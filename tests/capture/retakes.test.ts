/**
 * Tests — retakes: approvals carried over, the unit's fetches, and the
 * Retakes screen
 *
 * This suite delivers capture manifests over the link exactly as a
 * Captua unit does (`handleManifestDelivery`, with an in-memory S3
 * server standing in for the masters bucket), and through the
 * registration command's statements (`fileRegistrationSql`), records
 * decisions through `recordDecisionsAction`, reads the decisions as the
 * unit does, and reads the Retakes screen through its loader. It pins:
 *
 *   - carrying approvals over on a retake: an opening whose images are
 *     unchanged (capture id, role, sha256 and rotateDeg) keeps its
 *     approval, note, decider, time and rotations under a new
 *     decisionsId; an opening with a changed digest, capture id, role,
 *     rotateDeg (given, dropped or another value) or number of images,
 *     and every rejected opening, starts undecided; nothing qualifying
 *     leaves the retake with no set; the hold is released once the
 *     replaced openings are approved again, or at registration when
 *     every opening came over; a handover that still carries a record
 *     `rejected` stays held with every opening approved, and the status
 *     call tells the unit `retakes_requested`, until the retake brings
 *     the record back and it is approved; the file route
 *     carries as the link does;
 *     a volume of 1,000 openings carries within D1's limits on both
 *     routes;
 *   - the fetch record: each decisionsId the unit reads, first and last,
 *     only when the answer is the set, with the answer unchanged;
 *   - each retake state, from the pure rule and from the loader:
 *     requested, sent to scanner from the first fetch carrying the
 *     rejection, requested again once the rejection changes, replaced
 *     once a new delivery brings the opening back, reshot or turned
 *     another way, and gone once it is approved there;
 *   - the screen: the capability's bare 404, who sees it (managers,
 *     a volume's assigned reviewer for their own volumes only, a bare
 *     403 for anyone else) and tenant scoping.
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
import { RouterContextProvider } from "react-router";
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
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { fakeS3, type FakeS3 } from "../helpers/fake-s3";
import {
  insertRow,
  seedDeclaration,
  seedReceivedVolumes,
  seedTenantDestination,
  TEST_MASTERS_BUCKET,
  TEST_SECRET_PREFIX,
} from "../helpers/media-pipeline";
import { handleManifestDelivery, handleVolumeStatus, type CaptureLinkDeps } from "../../app/lib/capture/link.server";
import { handleVolumeDecisions, recordDecisionsAction } from "../../app/lib/capture/qc.server";
import { buildCarryForwardStatements, CARRY_IDS_PER_STATEMENT } from "../../app/lib/capture/carry.server";
import { fileRegistrationSql, MAX_FILE_STATEMENT_BYTES } from "../../app/lib/capture/file-route.server";
import { applyInventory, checkCaptureManifest, planVolumes } from "../../app/lib/capture/manifest";
import { readCaptureQcPending } from "../../app/lib/capture/hold.server";
import { retakeStateOf, sentAt } from "../../app/lib/capture/retakes";
import { loadRetakes } from "../../app/lib/capture/retakes.server";
import { loadCaptureQueue } from "../../app/lib/capture/screens.server";
import { mintScannerToken } from "../../app/lib/capture/token";
import { loader as retakesLoader } from "../../app/routes/_auth.admin.capture.retakes";
import { tenantContext, userContext, type Tenant, type User } from "../../app/context";

const HOST = "https://neogranadina.fisqua.test";
const ROOT = "neogranadina/";
const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const CODE = "co-test-001";

type Json = Record<string, any>;

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

const digest = (label: string) => createHash("sha256").update(label).digest("hex");
const pad = (n: number) => String(n).padStart(4, "0");

function image(stem: string, n: number, c: number, role: string, version = ""): Json {
  const base = `${stem}-img_${pad(n)}_c${c}`;
  return {
    captureId: `cap-${base}`,
    pairId: role === "single" ? null : `pair-${stem}-${n}`,
    filename: `${base}.cr3`,
    role,
    objectKey: `${stem}/captures/${base}.cr3`,
    sha256: digest(`capture ${base}${version}`),
    previewObjectKey: `${stem}/previews/${base}_preview.jpg`,
    previewSha256: digest(`preview ${base}${version}`),
  };
}

function rec(id: number, sequence: number, status: string, images: Json[]): Json {
  return { captuaRecordId: id, sequence, status, rejectionNote: null, images };
}

/**
 * Openings 11 (a single), 12 (a spread) and 14 (a single). `retaken`
 * names openings whose images were shot again: new digests.
 */
function volume(code: string, retaken: number[] = []): Json {
  const v = (id: number) => (retaken.includes(id) ? "-retake" : "");
  return {
    externalId: code,
    captuaCollectionId: 7,
    stem: code,
    title: `Test volume ${code}`,
    records: [
      rec(11, 1, "in_review", [image(code, 1, 0, "single", v(11))]),
      rec(12, 2, "approved", [image(code, 2, 0, "left", v(12)), image(code, 2, 1, "right", v(12))]),
      rec(14, 4, "approved", [image(code, 5, 0, "single", v(14))]),
    ],
  };
}

/** A volume of `n` two-page openings, record ids 1 to n; `retaken` as above. */
function bigVolume(code: string, n: number, retaken: Set<number> = new Set()): Json {
  const records = Array.from({ length: n }, (_, i) => {
    const v = retaken.has(i + 1) ? "-retake" : "";
    return rec(i + 1, i + 1, "in_review", [image(code, i + 1, 0, "left", v), image(code, i + 1, 1, "right", v)]);
  });
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

function objectKeys(m: Json): string[] {
  return m.volumes.flatMap((v: Json) =>
    v.records.flatMap((r: Json) => r.images.flatMap((img: Json) => [img.objectKey, img.previewObjectKey])),
  );
}

function upload(s3: FakeS3, m: Json): void {
  for (const key of objectKeys(m)) {
    s3.objects.set(`${TEST_MASTERS_BUCKET}/${ROOT}${key}`, { bytes: new Uint8Array(10), etag: "e", contentType: null, meta: {} });
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

async function tenantRow(id: string): Promise<Tenant> {
  const db = drizzle(env.DB, { schema });
  return (await db.select().from(schema.tenants).where(eq(schema.tenants.id, id)).get()) as Tenant;
}

async function person(opts: { tenantId?: string; isAdmin?: boolean; name?: string } = {}): Promise<User> {
  const row = await createTestUser({ tenantId: opts.tenantId, isAdmin: opts.isAdmin, name: opts.name });
  return makeUserContext({ id: row.id, tenantId: row.tenantId, email: row.email, name: row.name, isAdmin: row.isAdmin });
}

async function answer(res: Response): Promise<{ status: number; json: Json | null }> {
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function settle(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}

async function deliver(m: Json, deps: CaptureLinkDeps = world.deps) {
  upload(world.s3, m);
  const request = new Request(`${HOST}/api/capture/v1/manifests`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${world.token}` },
    body: JSON.stringify(m),
  });
  const res = await answer(await handleManifestDelivery(deps, request));
  expect(res.status).toBe(200);
  return res.json as { state: string; manifestId: string; volumeId: string };
}

const sqlRows = async (query: string, ...binds: unknown[]) =>
  (await env.DB.prepare(query).bind(...binds).all()).results as Array<Record<string, any>>;

async function currentDelivery(volumeId: string): Promise<string> {
  const rows = await sqlRows("SELECT id FROM capture_deliveries WHERE pipeline_volume_id = ? AND state = 'registered'", volumeId);
  return rows[0].id;
}

async function decide(volumeId: string, records: Json[], user: User = world.admin) {
  const request = new Request(`${HOST}/admin/capture/volumes/${volumeId}/decisions`, {
    method: "POST",
    body: JSON.stringify({ manifestId: await currentDelivery(volumeId), records }),
  });
  const res = await answer(
    await recordDecisionsAction(
      { db: drizzle(env.DB), now: () => world.clock.now, newId: () => crypto.randomUUID() },
      request,
      volumeId,
      world.tenant,
      user,
    ),
  );
  expect(res.status).toBe(200);
  return res.json as { decisionsId: string };
}

async function decisions(ref: string) {
  const request = new Request(`${HOST}/api/capture/v1/volumes/${encodeURIComponent(ref)}/decisions`, {
    headers: { Authorization: `Bearer ${world.token}` },
  });
  return answer(await handleVolumeDecisions(world.deps, request, ref));
}

async function status(ref: string) {
  const request = new Request(`${HOST}/api/capture/v1/volumes/status?refs=${encodeURIComponent(ref)}`, {
    headers: { Authorization: `Bearer ${world.token}` },
  });
  return (await answer(await handleVolumeStatus(world.deps, request))).json!.volumes[0] as Json;
}

/** The volume's capture QC sets, oldest delivery first. */
async function setsOf(volumeId: string) {
  return sqlRows(
    `SELECT s.delivery_id, s.decisions_id, s.carried_from, s.opening_count, s.decided_count, s.approved_count,
       s.rejected_count, s.notes_bytes, s.state, s.revision
     FROM capture_qc_sets s JOIN capture_deliveries d ON d.tenant_id = s.tenant_id AND d.id = s.delivery_id
     WHERE s.pipeline_volume_id = ? ORDER BY d.seq`,
    volumeId,
  );
}

const decisionsOf = (deliveryId: string) =>
  sqlRows(
    "SELECT captua_record_id, decision, reason, note, decided_by, decided_by_name, decided_at FROM capture_qc_decisions WHERE delivery_id = ? ORDER BY captua_record_id",
    deliveryId,
  );

const rotationsOf = (deliveryId: string) =>
  sqlRows(
    "SELECT captua_record_id, capture_id, role, quarter_turns FROM capture_qc_rotations WHERE delivery_id = ? ORDER BY captua_record_id, role",
    deliveryId,
  );

/** The decisions of the first delivery the tests mostly start from. */
const FIRST_DECISIONS: Json[] = [
  { captuaRecordId: 11, decision: "approved", rotations: [{ captureId: `cap-${CODE}-img_0001_c0`, role: "single", quarterTurns: 2 }] },
  {
    captuaRecordId: 12,
    decision: "approved",
    note: "Faint ink, but legible",
    rotations: [
      { captureId: `cap-${CODE}-img_0002_c0`, role: "left", quarterTurns: 1 },
      { captureId: `cap-${CODE}-img_0002_c1`, role: "right", quarterTurns: 3 },
    ],
  },
  { captuaRecordId: 14, decision: "rejected", reason: "framing", note: "Bottom margin cut" },
];

function context(user: User, tenant: Tenant): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, tenant);
  (ctx as any).cloudflare = { env };
  return ctx;
}

function loadScreen(user: User, tenant: Tenant = { ...world.tenant, digitizationEnabled: true }) {
  return retakesLoader({
    request: new Request(`${HOST}/admin/capture/retakes`),
    context: context(user, tenant),
    params: {},
  } as any);
}

const retakes = (user: User = world.admin, manager = true) =>
  loadRetakes(drizzle(env.DB), DEFAULT_TEST_TENANT_ID, user, manager, world.clock.now);

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
// Carrying approvals over
// ---------------------------------------------------------------------------

describe("carrying approvals over on a retake", () => {
  it("carries each unchanged approval with its note, decider, time and rotations, and leaves changed and rejected openings undecided", async () => {
    const first = await deliver(manifest([volume(CODE)]));
    const firstSet = await decide(first.volumeId, FIRST_DECISIONS);

    // The retake reshoots opening 12 and 14; 11 comes back as it was.
    world.clock.now = T0 + DAY;
    const retake = await deliver(manifest([volume(CODE, [12, 14])]));
    expect(retake.volumeId).toBe(first.volumeId);

    const [older, carried] = await setsOf(first.volumeId);
    expect(older.delivery_id).toBe(first.manifestId);
    expect(carried).toMatchObject({
      delivery_id: retake.manifestId,
      carried_from: first.manifestId,
      opening_count: 3,
      decided_count: 1,
      approved_count: 1,
      rejected_count: 0,
      notes_bytes: 0,
      state: "in_capture_qc",
      revision: 1,
    });
    expect(carried.decisions_id).not.toBe(firstSet.decisionsId);
    expect(await decisionsOf(retake.manifestId)).toEqual([
      { captua_record_id: 11, decision: "approved", reason: null, note: null, decided_by: world.admin.id, decided_by_name: "Test Admin", decided_at: T0 },
    ]);
    expect(await rotationsOf(retake.manifestId)).toEqual([
      { captua_record_id: 11, capture_id: `cap-${CODE}-img_0001_c0`, role: "single", quarter_turns: 2 },
    ]);

    // The unit sees the carried set at once.
    const s = await status(CODE);
    expect(s).toMatchObject({ manifestId: retake.manifestId, state: "in_capture_qc", decisionsId: carried.decisions_id });
    const answer_ = await decisions(CODE);
    expect(answer_.status).toBe(200);
    expect(answer_.json).toEqual({
      decisionsId: carried.decisions_id,
      decidedAt: new Date(T0 + DAY).toISOString(),
      manifestId: retake.manifestId,
      records: [
        {
          captuaRecordId: 11,
          decision: "approved",
          decidedBy: "Test Admin",
          decidedAt: new Date(T0).toISOString(),
          rotations: [{ captureId: `cap-${CODE}-img_0001_c0`, role: "single", quarterTurns: 2 }],
        },
      ],
    });
  });

  it("carries an approval's note, and never an opening whose images differ in number, capture id or role", async () => {
    const first = await deliver(manifest([volume(CODE)]));
    await decide(first.volumeId, [
      { captuaRecordId: 11, decision: "approved" },
      { captuaRecordId: 12, decision: "approved" },
      { captuaRecordId: 14, decision: "approved", note: "Kept despite a small shadow" },
    ]);
    const changed = volume(CODE);
    // 11: same digest under another capture id.
    changed.records[0].images[0].captureId = "cap-other-0001";
    // 12: one image of the two is left, now a single.
    changed.records[1].images = [{ ...changed.records[1].images[0], role: "single", pairId: null }];
    world.clock.now = T0 + DAY;
    const retake = await deliver(manifest([changed]));
    expect(await decisionsOf(retake.manifestId)).toEqual([
      {
        captua_record_id: 14,
        decision: "approved",
        reason: null,
        note: "Kept despite a small shadow",
        decided_by: world.admin.id,
        decided_by_name: "Test Admin",
        decided_at: T0,
      },
    ]);
    expect((await setsOf(first.volumeId))[1]).toMatchObject({ decided_count: 1, notes_bytes: 27, state: "in_capture_qc" });
  });

  it("does not carry a role swapped between the halves of a spread", async () => {
    const first = await deliver(manifest([volume(CODE)]));
    await decide(first.volumeId, [{ captuaRecordId: 12, decision: "approved" }]);
    const swapped = volume(CODE);
    const [left, right] = swapped.records[1].images;
    swapped.records[1].images = [
      { ...left, role: "right" },
      { ...right, role: "left" },
    ];
    const retake = await deliver(manifest([swapped]));
    expect(await decisionsOf(retake.manifestId)).toEqual([]);
  });

  it("carries an opening whose rotateDeg is unchanged, and not one whose rotateDeg changed, was added or was removed", async () => {
    const turned = (rotate: { r11?: number; r12left?: number; r14?: number }) => {
      const v = volume(CODE);
      if (rotate.r11 !== undefined) v.records[0].images[0].rotateDeg = rotate.r11;
      if (rotate.r12left !== undefined) v.records[1].images[0].rotateDeg = rotate.r12left;
      if (rotate.r14 !== undefined) v.records[2].images[0].rotateDeg = rotate.r14;
      return v;
    };
    const first = await deliver(manifest([turned({ r12left: 90, r14: 180 })]));
    await decide(first.volumeId, [
      { captuaRecordId: 11, decision: "approved" },
      { captuaRecordId: 12, decision: "approved" },
      { captuaRecordId: 14, decision: "approved" },
    ]);
    // 11: none, now 0; 12: 90 on the left as before; 14: 180, now 270.
    world.clock.now = T0 + DAY;
    const second = await deliver(manifest([turned({ r11: 0, r12left: 90, r14: 270 })]));
    expect((await decisionsOf(second.manifestId)).map((d) => d.captua_record_id)).toEqual([12]);

    await decide(first.volumeId, [
      { captuaRecordId: 11, decision: "approved" },
      { captuaRecordId: 14, decision: "approved" },
    ]);
    // 11: 0 as before; 12: the left's 90 dropped; 14: 270 as before.
    world.clock.now = T0 + 2 * DAY;
    const third = await deliver(manifest([turned({ r11: 0, r14: 270 })]));
    expect((await decisionsOf(third.manifestId)).map((d) => d.captua_record_id)).toEqual([11, 14]);
  });

  it("holds the retake until its replaced openings are approved again, then releases it", async () => {
    const first = await deliver(manifest([volume(CODE)]));
    await decide(first.volumeId, FIRST_DECISIONS);
    const db = drizzle(env.DB);
    expect(await readCaptureQcPending(db, DEFAULT_TEST_TENANT_ID, [first.volumeId])).toEqual([first.volumeId]);

    world.clock.now = T0 + DAY;
    const retake = await deliver(manifest([volume(CODE, [14])]));
    expect((await setsOf(first.volumeId))[1]).toMatchObject({ decided_count: 2, approved_count: 2, state: "in_capture_qc" });
    expect(await readCaptureQcPending(db, DEFAULT_TEST_TENANT_ID, [first.volumeId])).toEqual([first.volumeId]);

    world.clock.now = T0 + 2 * DAY;
    await decide(first.volumeId, [{ captuaRecordId: 14, decision: "approved" }]);
    expect((await setsOf(first.volumeId))[1]).toMatchObject({
      delivery_id: retake.manifestId,
      decided_count: 3,
      approved_count: 3,
      state: "approved",
      carried_from: first.manifestId,
      revision: 2,
    });
    expect(await readCaptureQcPending(db, DEFAULT_TEST_TENANT_ID, [first.volumeId])).toEqual([]);
    expect((await status(CODE)).state).toBe("approved");
  });

  it("approves the retake at registration when every opening came back approved and unchanged", async () => {
    const first = await deliver(manifest([volume(CODE)]));
    await decide(first.volumeId, FIRST_DECISIONS.slice(0, 2).concat([{ captuaRecordId: 14, decision: "approved" }]));
    const retake = await deliver(manifest([volume(CODE)]));
    expect((await setsOf(first.volumeId))[1]).toMatchObject({ delivery_id: retake.manifestId, decided_count: 3, state: "approved" });
    expect(await rotationsOf(retake.manifestId)).toHaveLength(3);
    expect(await readCaptureQcPending(drizzle(env.DB), DEFAULT_TEST_TENANT_ID, [first.volumeId])).toEqual([]);
  });

  it("holds a handover that still carries the rejected record, and releases the one that brings it back approved", async () => {
    const db = drizzle(env.DB);
    const first = await deliver(manifest([volume(CODE)]));
    await decide(first.volumeId, FIRST_DECISIONS);

    // The unit hands the volume over again before the retake: 14 is still
    // `rejected`, so it is no opening of this delivery. 11 and 12 come
    // over approved, which approves every opening the delivery has.
    world.clock.now = T0 + DAY;
    const before = volume(CODE);
    before.records[2].status = "rejected";
    const again = await deliver(manifest([before]));
    expect(
      await sqlRows("SELECT openings, rejected_records FROM capture_deliveries WHERE id = ?", again.manifestId),
    ).toEqual([{ openings: 2, rejected_records: 1 }]);
    expect((await setsOf(first.volumeId))[1]).toMatchObject({
      delivery_id: again.manifestId,
      opening_count: 2,
      approved_count: 2,
      state: "approved",
    });
    expect(await readCaptureQcPending(db, DEFAULT_TEST_TENANT_ID, [first.volumeId])).toEqual([first.volumeId]);
    // The unit is told it owes a retake, from when the set was approved.
    expect(await status(CODE)).toMatchObject({ state: "retakes_requested", enteredAt: new Date(T0 + DAY).toISOString() });

    // The retake: 14 back in review with new images, which wait for review.
    world.clock.now = T0 + 2 * DAY;
    const retake = await deliver(manifest([volume(CODE, [14])]));
    expect(
      await sqlRows("SELECT openings, rejected_records FROM capture_deliveries WHERE id = ?", retake.manifestId),
    ).toEqual([{ openings: 3, rejected_records: 0 }]);
    expect((await setsOf(first.volumeId))[2]).toMatchObject({
      delivery_id: retake.manifestId,
      approved_count: 2,
      state: "in_capture_qc",
    });
    expect(await readCaptureQcPending(db, DEFAULT_TEST_TENANT_ID, [first.volumeId])).toEqual([first.volumeId]);

    await decide(first.volumeId, [{ captuaRecordId: 14, decision: "approved" }]);
    expect((await setsOf(first.volumeId))[2]).toMatchObject({ approved_count: 3, state: "approved" });
    expect(await readCaptureQcPending(db, DEFAULT_TEST_TENANT_ID, [first.volumeId])).toEqual([]);
    expect((await status(CODE)).state).toBe("approved");
  });

  it("starts the retake with no set when no approval qualifies", async () => {
    // Only rejections: nothing to carry.
    const first = await deliver(manifest([volume(CODE)]));
    await decide(first.volumeId, [{ captuaRecordId: 14, decision: "rejected", reason: "blur" }]);
    const retake = await deliver(manifest([volume(CODE, [14])]));
    expect((await setsOf(first.volumeId)).map((s) => s.delivery_id)).toEqual([first.manifestId]);
    expect((await status(CODE)).state).toBe("registered");

    // Approvals, but every approved opening reshot: the set is written and removed.
    await decide(first.volumeId, [
      { captuaRecordId: 11, decision: "approved" },
      { captuaRecordId: 12, decision: "approved" },
    ]);
    world.clock.now = T0 + DAY;
    const again = await deliver(manifest([volume(CODE, [11, 12])]));
    expect((await setsOf(first.volumeId)).map((s) => s.delivery_id)).toEqual([first.manifestId, retake.manifestId]);
    expect(await decisionsOf(again.manifestId)).toEqual([]);
    expect((await decisions(CODE)).json!.problems[0].rule).toBe("no-decisions");
    expect((await status(CODE))).toMatchObject({ manifestId: again.manifestId, state: "registered" });
  });

  it("carries from the delivery the retake superseded, not from an older one", async () => {
    const first = await deliver(manifest([volume(CODE)]));
    await decide(first.volumeId, [{ captuaRecordId: 11, decision: "approved" }]);
    // A second delivery reshoots 11; its approval of 11 is gone, and 12 is approved there.
    const second = await deliver(manifest([volume(CODE, [11])]));
    await decide(first.volumeId, [{ captuaRecordId: 12, decision: "approved" }]);
    const third = await deliver(manifest([volume(CODE, [11])]));
    expect((await decisionsOf(third.manifestId)).map((d) => d.captua_record_id)).toEqual([12]);
    expect((await setsOf(first.volumeId))[2]).toMatchObject({ delivery_id: third.manifestId, carried_from: second.manifestId });
  });

  it("refuses a volume that repeats a Captua record id, over the link and in the registration command's plan", async () => {
    const twice = volume(CODE);
    twice.records.push(rec(11, 9, "rejected", [image(CODE, 9, 0, "single")]));
    const m = manifest([twice]);
    upload(world.s3, m);
    const res = await answer(
      await handleManifestDelivery(
        world.deps,
        new Request(`${HOST}/api/capture/v1/manifests`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${world.token}` },
          body: JSON.stringify(m),
        }),
      ),
    );
    expect(res.status).toBe(422);
    expect(res.json!.problems).toEqual([expect.objectContaining({ rule: "duplicate-record", captuaRecordId: 11 })]);

    const checked = checkCaptureManifest(m);
    if (!checked.ok) throw new Error("the manifest's shape is valid");
    const desc = (await sqlRows("SELECT id, reference_code FROM descriptions WHERE reference_code = ?", CODE))[0];
    const [planned] = planVolumes({
      manifest: checked.manifest,
      slug: "neogranadina",
      descriptions: new Map([[CODE, { id: desc.id, referenceCode: CODE }]]),
      existing: [],
      newId: () => crypto.randomUUID(),
    });
    expect(planned.action).toBe("skip");
    expect(planned.issues).toEqual([expect.objectContaining({ rule: "duplicate-record", captuaRecordId: 11 })]);
  });

  it("compares only the images of each delivery's openings, so an image of a record with the same id carries nothing", async () => {
    // Delivery A: record 11 under review with image X, approved.
    const first = await deliver(manifest([volume(CODE)]));
    await decide(first.volumeId, [{ captuaRecordId: 11, decision: "approved" }]);
    const X = { capture_id: `cap-${CODE}-img_0001_c0`, sha: digest(`capture ${CODE}-img_0001_c0`) };
    const Y = { capture_id: "cap-other-0001", sha: digest("capture other") };
    // Delivery B: record 11's opening is Y.
    const changed = volume(CODE);
    changed.records[0].images[0] = { ...changed.records[0].images[0], captureId: Y.capture_id, sha256: Y.sha };
    world.clock.now = T0 + DAY;
    const second = await deliver(manifest([changed]));
    expect(await decisionsOf(second.manifestId)).toEqual([]);

    // A record 11 rejected with Y beside the opening in A, and one with X
    // in B: the swap that passed for the same images before statuses
    // were compared. Delivered before record ids had to be unique.
    const extra = (deliveryId: string, img: { capture_id: string; sha: string }) =>
      insertRow("capture_images", {
        id: crypto.randomUUID(),
        tenant_id: DEFAULT_TEST_TENANT_ID,
        delivery_id: deliveryId,
        captua_record_id: 11,
        capture_id: img.capture_id,
        pair_id: null,
        role: "single",
        page_key: `${CODE}-img_0009_c0`,
        capture_key: `${ROOT}${CODE}/captures/${CODE}-img_0009_c0.cr3`,
        capture_sha256: img.sha,
        capture_bytes: 10,
        preview_key: null,
        preview_sha256: null,
        preview_bytes: null,
        record_status: "rejected",
      });
    await extra(first.manifestId, Y);
    await extra(second.manifestId, X);
    const carry = async () => {
      const writeId = (await sqlRows("SELECT write_id FROM capture_deliveries WHERE id = ?", second.manifestId))[0].write_id;
      const statements = buildCarryForwardStatements(drizzle(env.DB), {
        tenantId: DEFAULT_TEST_TENANT_ID,
        volumeId: first.volumeId,
        deliveryId: second.manifestId,
        writeId,
        openings: 3,
        openingIds: [11, 12, 14],
        decisionsId: crypto.randomUUID(),
        now: world.clock.now,
      });
      await drizzle(env.DB).batch(statements as any);
    };
    await carry();
    expect(await decisionsOf(second.manifestId)).toEqual([]);
    expect(await readCaptureQcPending(drizzle(env.DB), DEFAULT_TEST_TENANT_ID, [first.volumeId])).toEqual([first.volumeId]);

    // Counted without the statuses, the two deliveries' images for 11 would
    // match and X's approval would pass to Y.
    await env.DB.prepare("UPDATE capture_images SET record_status = 'in_review' WHERE captua_record_id = 11").run();
    await carry();
    expect((await decisionsOf(second.manifestId)).map((d) => d.captua_record_id)).toEqual([11]);
  });

  it("carries approvals through the file route as the link does", async () => {
    const first = await deliver(manifest([volume(CODE)]));
    await decide(first.volumeId, FIRST_DECISIONS);

    world.clock.now = T0 + DAY;
    const m = manifest([volume(CODE, [12, 14])]);
    const statements = await fileStatements(m, first.volumeId);
    await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
    const sets = await setsOf(first.volumeId);
    expect(sets[1]).toMatchObject({ delivery_id: m.id, carried_from: first.manifestId, decided_count: 1, state: "in_capture_qc" });
    expect((await decisionsOf(m.id)).map((d) => [d.captua_record_id, d.decided_at])).toEqual([[11, T0]]);
    expect(await rotationsOf(m.id)).toHaveLength(1);
  });
});

/** A manifest's registration as the command writes it, for a volume already registered. */
async function fileStatements(m: Json, volumeId: string): Promise<string[]> {
  const checked = checkCaptureManifest(m);
  if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
  const v = checked.manifest.volumes[0];
  const desc = (await sqlRows("SELECT id, reference_code FROM descriptions WHERE reference_code = ?", v.externalId))[0];
  const listing = new Map(objectKeys(m).map((k) => [`${ROOT}${k}`, 10]));
  const [planned] = applyInventory(
    planVolumes({
      manifest: checked.manifest,
      slug: "neogranadina",
      descriptions: new Map([[desc.reference_code, { id: desc.id, referenceCode: desc.reference_code }]]),
      existing: [
        { id: volumeId, descriptionId: desc.id, referenceCode: desc.reference_code, kind: "volume_run", state: "received", held: false, ran: false },
      ],
      newId: () => crypto.randomUUID(),
    }),
    new Map([[`${ROOT}${v.stem}/`, listing]]),
  );
  expect(planned.action).toBe("replace");
  const { statements } = await fileRegistrationSql({
    tenantId: DEFAULT_TEST_TENANT_ID,
    manifest: checked.manifest,
    volume: planned,
    digest: "b".repeat(64),
    masters: { endpoint: "https://s3.example.test", bucket: TEST_MASTERS_BUCKET },
    listing,
    now: world.clock.now,
    newId: () => crypto.randomUUID(),
  });
  return statements;
}

// ---------------------------------------------------------------------------
// D1's limits
// ---------------------------------------------------------------------------

function boundOf(stmt: unknown): { sql: string; params: unknown[] } {
  const s = stmt as { toSQL?: () => { sql: string; params: unknown[] }; getQuery?: () => { sql: string; params: unknown[] } };
  return s.toSQL?.() ?? s.getQuery!();
}

describe("D1's limits on a carried retake", () => {
  it("carries 1,000 openings within 100 parameters and 100 KB a statement on the link, and 95,000 bytes on the file route", async () => {
    const code = "co-test-big";
    await createTestDescription({
      tenantId: DEFAULT_TEST_TENANT_ID,
      repositoryId: world.repositoryId,
      descriptionLevel: "volume",
      referenceCode: code,
    });
    const first = await deliver(manifest([bigVolume(code, 1000)]));
    await decide(
      first.volumeId,
      Array.from({ length: 1000 }, (_, i) => ({
        captuaRecordId: i + 1,
        decision: i % 10 === 0 ? "rejected" : "approved",
        ...(i % 10 === 0 ? { reason: "glare", side: "right" } : {}),
        rotations: [
          { captureId: `cap-${code}-img_${pad(i + 1)}_c0`, role: "left", quarterTurns: 1 },
          { captureId: `cap-${code}-img_${pad(i + 1)}_c1`, role: "right", quarterTurns: 3 },
        ],
      })),
    );
    // Records 2 to 101 reshot: 90 approved and 10 rejected among them.
    const retaken = new Set(Array.from({ length: 100 }, (_, i) => i + 2));

    // The link, its batch's statements captured.
    let captured: unknown[] = [];
    const db = drizzle(env.DB);
    const watching = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: unknown[]) => {
            captured = statements;
            return (target as any).batch(statements);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    world.clock.now = T0 + DAY;
    const retake = await deliver(manifest([bigVolume(code, 1000, retaken)]), { ...world.deps, db: watching as any });
    expect(captured.length).toBeGreaterThan(0);
    for (const stmt of captured) {
      const { sql, params } = boundOf(stmt);
      expect(params.length).toBeLessThanOrEqual(100);
      expect(new TextEncoder().encode(sql).length).toBeLessThan(100_000);
    }
    const carried = (await setsOf(first.volumeId))[1];
    expect(carried).toMatchObject({ delivery_id: retake.manifestId, opening_count: 1000, decided_count: 810, approved_count: 810, state: "in_capture_qc" });
    expect((await sqlRows("SELECT COUNT(*) AS n FROM capture_qc_rotations WHERE delivery_id = ?", retake.manifestId))[0].n).toBe(1620);

    // The file route: every statement written out within the budget.
    world.clock.now = T0 + 2 * DAY;
    const m = manifest([bigVolume(code, 1000, retaken)]);
    const statements = await fileStatements(m, first.volumeId);
    for (const s of statements) expect(new TextEncoder().encode(s).length).toBeLessThanOrEqual(MAX_FILE_STATEMENT_BYTES);
    expect(statements.filter((s) => s.startsWith("INSERT INTO capture_qc_decisions"))).toHaveLength(
      Math.ceil(1000 / CARRY_IDS_PER_STATEMENT),
    );
    await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
    // Every approval of the link's retake came over unchanged again.
    expect((await setsOf(first.volumeId))[2]).toMatchObject({ delivery_id: m.id, carried_from: retake.manifestId, decided_count: 810 });
  });
});

// ---------------------------------------------------------------------------
// The unit's fetches
// ---------------------------------------------------------------------------

describe("the unit's fetch of decisions", () => {
  it("records each decisionsId fetched, first and last, and answers as it did", async () => {
    const { volumeId, manifestId } = await deliver(manifest([volume(CODE)]));

    // Nothing decided: the answer is 404 and nothing is recorded.
    expect((await decisions(CODE)).status).toBe(404);
    expect(await sqlRows("SELECT * FROM capture_qc_fetches")).toEqual([]);

    const one = await decide(volumeId, [{ captuaRecordId: 14, decision: "rejected", reason: "blur" }]);
    world.clock.now = T0 + 1000;
    const a = await decisions(CODE);
    world.clock.now = T0 + 2000;
    const b = await decisions(CODE);
    expect(b).toEqual(a);
    expect(a.json).toEqual({
      decisionsId: one.decisionsId,
      decidedAt: new Date(T0).toISOString(),
      manifestId,
      records: [{ captuaRecordId: 14, decision: "rejected", reason: "blur", decidedBy: "Test Admin", decidedAt: new Date(T0).toISOString(), rotations: [] }],
    });
    expect(await sqlRows("SELECT tenant_id, delivery_id, decisions_id, set_revision, first_fetched_at, last_fetched_at FROM capture_qc_fetches")).toEqual([
      { tenant_id: DEFAULT_TEST_TENANT_ID, delivery_id: manifestId, decisions_id: one.decisionsId, set_revision: 1, first_fetched_at: T0 + 1000, last_fetched_at: T0 + 2000 },
    ]);

    world.clock.now = T0 + 3000;
    const two = await decide(volumeId, [{ captuaRecordId: 11, decision: "approved" }]);
    world.clock.now = T0 + 4000;
    await decisions(CODE);
    expect(await sqlRows("SELECT decisions_id, set_revision, first_fetched_at FROM capture_qc_fetches ORDER BY first_fetched_at")).toEqual([
      { decisions_id: one.decisionsId, set_revision: 1, first_fetched_at: T0 + 1000 },
      { decisions_id: two.decisionsId, set_revision: 2, first_fetched_at: T0 + 4000 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Retake states
// ---------------------------------------------------------------------------

describe("retake states, the rule", () => {
  const fetches = [
    { setRevision: 2, firstFetchedAt: 150 },
    { setRevision: 5, firstFetchedAt: 350 },
  ];
  const none = { inCurrent: true, current: null, currentFetches: fetches, earlier: null };

  it("dates a rejection's sending from the first fetch at its revision or later", () => {
    expect(sentAt(2, fetches)).toBe(150);
    expect(sentAt(3, fetches)).toBe(350);
    expect(sentAt(6, fetches)).toBeNull();
  });

  it("names requested, sent, replaced, missing, and nothing else", () => {
    const rejected = (setRevision: number) => ({ decision: "rejected" as const, setRevision });
    expect(retakeStateOf({ ...none, current: rejected(6) })).toEqual({ state: "requested", sentAt: null, fromEarlier: false });
    expect(retakeStateOf({ ...none, current: rejected(5) })).toEqual({ state: "sent", sentAt: 350, fromEarlier: false });
    const earlier = (sameImages: boolean, setRevision = 1) => ({ ...rejected(setRevision), sameImages, fetches: [] as typeof fetches });
    expect(retakeStateOf({ ...none, earlier: earlier(false) })).toEqual({ state: "replaced", sentAt: null, fromEarlier: true });
    // Brought back unchanged: the earlier delivery's rejection still stands.
    expect(retakeStateOf({ ...none, earlier: earlier(true) })).toEqual({ state: "requested", sentAt: null, fromEarlier: true });
    expect(retakeStateOf({ ...none, earlier: { ...earlier(true, 2), fetches } })).toEqual({ state: "sent", sentAt: 150, fromEarlier: true });
    expect(retakeStateOf({ ...none, inCurrent: false, earlier: earlier(false) })).toEqual({ state: "missing", sentAt: null, fromEarlier: true });
    expect(retakeStateOf({ ...none, current: { decision: "approved", setRevision: 1 }, earlier: earlier(false) })).toBeNull();
    expect(retakeStateOf({ ...none, earlier: { decision: "approved", setRevision: 1, sameImages: false, fetches } })).toBeNull();
    expect(retakeStateOf({ ...none, inCurrent: false, earlier: { decision: "approved", setRevision: 1, sameImages: false, fetches } })).toBeNull();
    expect(retakeStateOf(none)).toBeNull();
  });

  it("orders by revision, not by the clock: a rejection committed after the fetch is still requested", () => {
    // Write B samples 150 and commits first (revision 1); the unit reads
    // revision 1; write A sampled 100 and commits second (revision 2).
    const fetched = [{ setRevision: 1, firstFetchedAt: 160 }];
    expect(retakeStateOf({ ...none, currentFetches: fetched, current: { decision: "rejected", setRevision: 2 } })).toEqual({
      state: "requested",
      sentAt: null,
      fromEarlier: false,
    });
  });
});

describe("retake states, as the screen reads them", () => {
  it("is requested until the unit fetches the rejection, sent from then, and requested again once the rejection changes", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    await decide(volumeId, FIRST_DECISIONS);
    let [card] = await retakes();
    expect(card).toMatchObject({ referenceCode: CODE, title: "Test Description", undecided: 0, sentAt: null });
    expect(card.rows).toEqual([
      {
        captuaRecordId: 14,
        sequence: 4,
        pageKeys: [`${CODE}-img_0005_c0`],
        reason: "framing",
        side: null,
        note: "Bottom margin cut",
        askedBy: "Test Admin",
        askedAt: T0,
        outstandingDays: 0,
        state: "requested",
        sentAt: null,
        fromEarlier: false,
      },
    ]);

    world.clock.now = T0 + DAY;
    await decisions(CODE);
    [card] = await retakes();
    expect(card.rows[0]).toMatchObject({ state: "sent", sentAt: T0 + DAY, outstandingDays: 1 });
    expect(card.sentAt).toBe(T0 + DAY);

    // Another reason: the unit does not have it yet.
    world.clock.now = T0 + 2 * DAY;
    await decide(volumeId, [{ captuaRecordId: 14, decision: "rejected", reason: "other", note: "Torn corner" }]);
    [card] = await retakes();
    expect(card.rows[0]).toMatchObject({ state: "requested", reason: "other", note: "Torn corner", askedAt: T0 + 2 * DAY });

    world.clock.now = T0 + 3 * DAY;
    await decisions(CODE);
    // A later write that leaves the rejection alone keeps it sent.
    world.clock.now = T0 + 4 * DAY;
    await decide(volumeId, [{ captuaRecordId: 11, decision: "approved" }]);
    [card] = await retakes();
    expect(card.rows[0]).toMatchObject({ state: "sent", sentAt: T0 + 3 * DAY });
  });

  it("is replaced once a new delivery brings the opening back, and leaves the list once approved there", async () => {
    const first = await deliver(manifest([volume(CODE)]));
    await decide(first.volumeId, FIRST_DECISIONS);
    await decisions(CODE);

    // 12 approved but reshot, 14 rejected and reshot.
    world.clock.now = T0 + DAY;
    await deliver(manifest([volume(CODE, [12, 14])]));
    let [card] = await retakes();
    expect(card.undecided).toBe(2);
    expect(card.sentAt).toBeNull();
    expect(card.rows).toEqual([
      expect.objectContaining({ captuaRecordId: 14, state: "replaced", reason: "framing", note: "Bottom margin cut", askedAt: T0, outstandingDays: 1 }),
    ]);

    // Rejected again on the retake: requested.
    world.clock.now = T0 + 2 * DAY;
    await decide(first.volumeId, [{ captuaRecordId: 14, decision: "rejected", reason: "shadow" }]);
    [card] = await retakes();
    expect(card.rows).toEqual([expect.objectContaining({ captuaRecordId: 14, state: "requested", reason: "shadow" })]);

    // Approved: no retake left, and the volume leaves the screen.
    await decide(first.volumeId, [{ captuaRecordId: 14, decision: "approved" }]);
    expect(await retakes()).toEqual([]);
  });

  it("keeps a rejection the unit fetched as sent until the unit fetches a later write, however the clocks were read", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    // B: an approval, its clock read at T0 + 150, committed first.
    world.clock.now = T0 + 150;
    await decide(volumeId, [{ captuaRecordId: 11, decision: "approved" }]);
    world.clock.now = T0 + 160;
    await decisions(CODE);
    // A: a rejection whose clock was read earlier, at T0 + 100, committed second.
    world.clock.now = T0 + 100;
    await decide(volumeId, [{ captuaRecordId: 14, decision: "rejected", reason: "blur" }]);
    expect(await sqlRows("SELECT captua_record_id, set_revision, decided_at FROM capture_qc_decisions ORDER BY captua_record_id")).toEqual([
      { captua_record_id: 11, set_revision: 1, decided_at: T0 + 150 },
      { captua_record_id: 14, set_revision: 2, decided_at: T0 + 100 },
    ]);
    let [card] = await retakes();
    expect(card.rows[0]).toMatchObject({ captuaRecordId: 14, state: "requested", sentAt: null });
    world.clock.now = T0 + 200;
    await decisions(CODE);
    [card] = await retakes();
    expect(card.rows[0]).toMatchObject({ captuaRecordId: 14, state: "sent", sentAt: T0 + 200 });
  });

  it("keeps a rejection brought back unchanged as the earlier delivery's, requested or sent, and not replaced", async () => {
    const first = await deliver(manifest([volume(CODE)]));
    await decide(first.volumeId, FIRST_DECISIONS);
    // The retake reshoots 12 only: 14 comes back as it was rejected.
    world.clock.now = T0 + DAY;
    await deliver(manifest([volume(CODE, [12])]));
    let [card] = await retakes();
    expect(card.rows).toEqual([
      expect.objectContaining({ captuaRecordId: 14, state: "requested", fromEarlier: true, reason: "framing", pageKeys: [`${CODE}-img_0005_c0`] }),
    ]);
    // The queue counts 12 alone as replaced and to review again.
    const db = drizzle(env.DB);
    const queueRow = (await loadCaptureQueue(db, DEFAULT_TEST_TENANT_ID, world.admin, true, world.clock.now))[0];
    expect(queueRow).toMatchObject({ referenceCode: CODE, decided: 1, reviewAgain: 1 });

    // Had the unit fetched the earlier set, it is sent.
    await insertRow("capture_qc_fetches", {
      tenant_id: DEFAULT_TEST_TENANT_ID,
      delivery_id: first.manifestId,
      decisions_id: (await setsOf(first.volumeId))[0].decisions_id,
      set_revision: 1,
      first_fetched_at: T0 + 10,
      last_fetched_at: T0 + 10,
    });
    [card] = await retakes();
    expect(card.rows[0]).toMatchObject({ captuaRecordId: 14, state: "sent", sentAt: T0 + 10 });

    // The reviewer can still decide it on the retake.
    await decide(first.volumeId, [{ captuaRecordId: 14, decision: "approved" }]);
    expect(await retakes()).toEqual([]);
  });

  it("counts a rejected opening brought back turned another way as replaced", async () => {
    const first = await deliver(manifest([volume(CODE)]));
    await decide(first.volumeId, FIRST_DECISIONS);
    // 14 comes back with the same pixels and a rotation it did not have.
    const turned = volume(CODE);
    turned.records[2].images[0].rotateDeg = 90;
    world.clock.now = T0 + DAY;
    await deliver(manifest([turned]));
    const [card] = await retakes();
    expect(card.rows).toEqual([expect.objectContaining({ captuaRecordId: 14, state: "replaced" })]);
  });

  it("lists an opening rejected earlier and missing from the new delivery, with its earlier page keys", async () => {
    const first = await deliver(manifest([volume(CODE)]));
    await decide(first.volumeId, FIRST_DECISIONS);
    const without = volume(CODE);
    without.records = without.records.filter((r: Json) => r.captuaRecordId !== 14);
    world.clock.now = T0 + DAY;
    await deliver(manifest([without]));
    const [card] = await retakes();
    expect(card.rows).toEqual([
      expect.objectContaining({ captuaRecordId: 14, sequence: 4, state: "missing", reason: "framing", pageKeys: [`${CODE}-img_0005_c0`] }),
    ]);
    // Every opening of the new delivery approved: it still shows.
    await decide(first.volumeId, [{ captuaRecordId: 12, decision: "approved" }]);
    expect((await retakes())[0].rows.map((r) => r.state)).toEqual(["missing"]);
  });

  it("lists a spread's page keys left then right, with the image to retake", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    await decide(volumeId, [{ captuaRecordId: 12, decision: "rejected", reason: "glare", side: "left" }]);
    const [card] = await retakes();
    expect(card.rows[0].pageKeys).toEqual([`${CODE}-img_0002_c0`, `${CODE}-img_0002_c1`]);
    expect(card.rows[0]).toMatchObject({ reason: "glare", side: "left" });
  });
});

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

describe("the Retakes screen", () => {
  async function seedRetake() {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    await decide(volumeId, FIRST_DECISIONS);
    await insertRow("capture_qc_reviewers", {
      tenant_id: DEFAULT_TEST_TENANT_ID,
      pipeline_volume_id: volumeId,
      reviewer_id: world.reviewer.id,
      assigned_by: world.admin.id,
      assigned_at: T0,
    });
    return volumeId;
  }

  it("answers a bare 404 when the capability is off, even for an admin", async () => {
    await seedRetake();
    expect(await settle(loadScreen(world.admin, { ...world.tenant, digitizationEnabled: false }))).toBe(404);
  });

  it("opens to admins, stewards and assigned reviewers, and 403s anyone else", async () => {
    await seedRetake();
    expect(await settle(loadScreen(world.admin))).toBe(200);
    expect(await settle(loadScreen(world.steward))).toBe(200);
    expect(await settle(loadScreen(world.reviewer))).toBe(200);
    expect(await settle(loadScreen(world.outsider))).toBe(403);
  });

  it("shows a reviewer only the volumes assigned to them", async () => {
    await seedRetake();
    const code = "co-test-002";
    await createTestDescription({ tenantId: DEFAULT_TEST_TENANT_ID, repositoryId: world.repositoryId, descriptionLevel: "volume", referenceCode: code });
    const other = await deliver(manifest([volume(code)]));
    await decide(other.volumeId, [{ captuaRecordId: 11, decision: "rejected", reason: "dirt" }]);

    const all = await loadScreen(world.admin);
    expect(all.volumes.map((v) => v.referenceCode)).toEqual([CODE, code]);
    const mine = await loadScreen(world.reviewer);
    expect(mine.volumes.map((v) => v.referenceCode)).toEqual([CODE]);
  });

  it("shows nothing of another tenant's retakes, and theirs only to them", async () => {
    await seedRetake();
    // The second tenant's volume, delivered and rejected, seeded as rows.
    const { volumes } = await seedReceivedVolumes({ tenantId: SECOND_TEST_TENANT_ID, count: 1, codePrefix: "co-other" });
    const [foreign] = volumes;
    const deliveryId = crypto.randomUUID();
    const otherAdmin = await person({ tenantId: SECOND_TEST_TENANT_ID, isAdmin: true, name: "Other Admin" });
    await insertRow("capture_deliveries", {
      tenant_id: SECOND_TEST_TENANT_ID,
      id: deliveryId,
      route: "file",
      scanner_id: null,
      reference_code: foreign.referenceCode,
      pipeline_volume_id: foreign.id,
      body_sha256: "a".repeat(64),
      state: "registered",
      problems: "[]",
      answer_status: 200,
      answer_body: "{}",
      records: JSON.stringify([{ captuaRecordId: 1, sequence: 1, status: "in_review", rejectionNote: null }]),
      openings: 1,
      received_at: T0,
      superseded_by: null,
      superseded_at: null,
      seq: 1,
      write_id: null,
    });
    await insertRow("capture_qc_sets", {
      tenant_id: SECOND_TEST_TENANT_ID,
      delivery_id: deliveryId,
      pipeline_volume_id: foreign.id,
      decisions_id: crypto.randomUUID(),
      decided_at: T0,
      revision: 1,
      opening_count: 1,
      decided_count: 1,
      approved_count: 0,
      rejected_count: 1,
      notes_bytes: 0,
      state: "retakes_requested",
      state_entered_at: T0,
      write_id: crypto.randomUUID(),
    });
    await insertRow("capture_qc_decisions", {
      tenant_id: SECOND_TEST_TENANT_ID,
      delivery_id: deliveryId,
      captua_record_id: 1,
      decision: "rejected",
      reason: "blur",
      note: null,
      decided_by: otherAdmin.id,
      decided_by_name: "Other Admin",
      decided_at: T0,
    });

    const mine = await loadScreen(world.admin);
    expect(mine.volumes.map((v) => v.referenceCode)).toEqual([CODE]);
    const tenant = makeTenantContext({ id: SECOND_TEST_TENANT_ID, slug: "second-tenant", federationId: SECOND_TEST_FEDERATION_ID, digitizationEnabled: true });
    const theirs = await loadScreen(otherAdmin, tenant);
    expect(theirs.volumes.map((v) => v.referenceCode)).toEqual([foreign.referenceCode]);
    expect(theirs.volumes[0].rows).toEqual([expect.objectContaining({ captuaRecordId: 1, state: "requested", askedBy: "Other Admin", pageKeys: [] })]);
  });

  it("leaves out a volume a pipeline run has named", async () => {
    const volumeId = await seedRetake();
    expect(await retakes()).toHaveLength(1);
    const user = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID });
    const scope = await createTestDescription({ repositoryId: world.repositoryId, descriptionLevel: "fonds" });
    const declaration = await seedDeclaration({ scopeDescriptionId: scope.id, createdBy: user.id });
    const runId = crypto.randomUUID();
    await insertRow("pipeline_runs", {
      id: runId,
      tenant_id: DEFAULT_TEST_TENANT_ID,
      user_id: user.id,
      kind: "volume_run",
      purpose: "sample",
      status: "error",
      runner_image: "ghcr.io/example/runner@sha256:" + "0".repeat(64),
      script_version: "v1.0.0",
      arch: "x64",
      max_review_frac: 1,
      spec_key: `${DEFAULT_TEST_TENANT_ID}/pipeline-runs/${runId}/spec.json`,
      spec_sha256: "0".repeat(64),
      spec_url_expires_at: T0 - 1,
      chunk_count: 1,
      volume_count: 1,
      callback_token_hash: "0".repeat(64),
      token_expires_at: T0,
      token_revoked_at: T0,
      completed_at: T0,
      created_at: T0,
      dispatched_at: T0,
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
      status: "aborted",
      flags_truncated: 0,
      created_at: T0,
    });
    expect(await retakes()).toEqual([]);
  });
});

// @version v0.8.0
