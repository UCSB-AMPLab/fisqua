/**
 * Tests — the digitization queue and its sync with a Captua unit
 *
 * This suite drives the queue's server module (`queue.server.ts`) and
 * the three unit calls of contract 1.7 (`queue-link.server.ts`) against
 * the test D1 database, with manifests delivered and decided through the
 * capture link so that states and retakes come from real rows. It pins:
 *
 *   - adding: order kept, one live entry per description, foreign ids
 *     ignored, a withdrawn entry revived on its own row, the ceiling;
 *   - "add everything below this": the deepest volume or file on each
 *     branch, never an item, fonds or series, at most 50, counted no
 *     further than 51;
 *   - reordering, assigning to an active operator only, unassigning,
 *     setting the job and note, withdrawing;
 *   - states: queued, on_unit, skipped from the unit's acknowledgement;
 *     captured or in review, then approved, from the handover; a handover
 *     from before the entry was added not counted;
 *   - retakes: a volume with a rejected opening is an item with job
 *     `spot-recapture` and its rejected openings and pair ids, whether or
 *     not it was queued; it cannot be withdrawn; assigning it writes a
 *     row under the volume's id; it leaves when the retake is approved;
 *   - the unit calls: operators replaced whole (204), malformed and
 *     duplicate lists refused (422); the queue served with an ETag and
 *     304 on a match, approved items left out, withdrawn ones flagged
 *     until acknowledged under a later revision; `retakes` only on a
 *     spot-recapture item, with pair id and side; a retake volume's
 *     item id the same in every revision; acknowledgements
 *     recorded, unknown ids listed back, a revision from the future
 *     refused; no token 401, another method 405, and the shared rate limit;
 *   - the screen and the add route: 404 without the digitization
 *     capability, 403 for someone who does not work in capture; a
 *     federation staff grant loads the screen, adds, assigns, reorders,
 *     sets the job and note, and withdraws through the route;
 *     adding by ids, by "everything below" and by handlist; the count
 *     "everything below" would add, read on its own from 1 to 50 and
 *     null otherwise, for the browsing screens' menus; the export
 *     as a contract digitisation-list file;
 *   - the scanner's mode: recorded from the user list, kept when absent,
 *     an unknown one refused, shown to the queue screen, never refusing
 *     an add.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase, seedFederations, DEFAULT_TEST_TENANT_ID, SECOND_TEST_TENANT_ID } from "../helpers/db";
import { createTestDescription } from "../helpers/descriptions";
import { createTestRepository } from "../helpers/repositories";
import { createGrantUser, createTestUser } from "../helpers/auth";
import { makeUserContext } from "../helpers/context";
import { fakeS3, type FakeS3 } from "../helpers/fake-s3";
import { insertRow, seedTenantDestination, TEST_MASTERS_BUCKET, TEST_SECRET_PREFIX } from "../helpers/media-pipeline";
import { handleManifestDelivery, RATE_LIMIT_PER_MINUTE, type CaptureLinkDeps } from "../../app/lib/capture/link.server";
import { recordDecisionsAction } from "../../app/lib/capture/qc.server";
import { mintScannerToken } from "../../app/lib/capture/token";
import {
  addToQueue,
  assignItems,
  loadQueueItems,
  MAX_ADD,
  moveEntry,
  QueueError,
  setItemJob,
  subtreeToQueue,
  withdrawEntries,
  handlistToQueue,
  readRetakeVolumes,
  pickBelow,
  countBelow,
  MAX_BELOW,
  type QueueDeps,
} from "../../app/lib/capture/queue.server";
import { loadRetakes } from "../../app/lib/capture/retakes.server";
import {
  ackWrites,
  handleOperatorsPut,
  handleQueueAck,
  handleQueueGet,
  revisionInputsSql,
  queueRevisionOf,
  QUEUE_SERVE_VERSION,
} from "../../app/lib/capture/queue-link.server";
import { queueStateOf } from "../../app/lib/capture/queue";
import { tenantContext, userContext, type Tenant, type User } from "../../app/context";
import { RouterContextProvider } from "react-router";
import { createHandlist } from "../../app/lib/handlists.server";
import { action as queueAction, loader as queueLoader } from "../../app/routes/_auth.admin.capture.queue";
import { action as addAction, loader as addLoader } from "../../app/routes/_auth.admin.capture.queue.add";

const HOST = "https://neogranadina.fisqua.test";
const ROOT = "neogranadina/";
const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const CODE = "co-test-001";

type Json = Record<string, any>;

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

/** Openings 11 (a single) and 12 (a spread); `retaken` names openings shot again. */
function volume(code: string, retaken: number[] = []): Json {
  const v = (id: number) => (retaken.includes(id) ? "-retake" : "");
  return {
    externalId: code,
    captuaCollectionId: 7,
    stem: code,
    title: `Test volume ${code}`,
    records: [
      rec(11, 1, "in_review", [image(code, 1, 0, "single", v(11))]),
      rec(12, 2, "in_review", [image(code, 2, 0, "left", v(12)), image(code, 2, 1, "right", v(12))]),
    ],
  };
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

interface World {
  deps: CaptureLinkDeps;
  q: QueueDeps;
  s3: FakeS3;
  clock: { now: number };
  token: string;
  scannerId: string;
  repositoryId: string;
  tenant: Tenant;
  admin: User;
  volumeDescriptionId: string;
}

let world: World;

const sqlRows = async (query: string, ...binds: unknown[]) =>
  (await env.DB.prepare(query).bind(...binds).all()).results as Array<Record<string, any>>;

async function answer(res: Response): Promise<{ status: number; json: Json | null; headers: Headers }> {
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

async function deliver(m: Json) {
  for (const v of m.volumes)
    for (const r of v.records)
      for (const img of r.images)
        for (const key of [img.objectKey, img.previewObjectKey])
          world.s3.objects.set(`${TEST_MASTERS_BUCKET}/${ROOT}${key}`, { bytes: new Uint8Array(10), etag: "e", contentType: null, meta: {} });
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
  expect(res.status).toBe(200);
  return res.json as { volumeId: string };
}

async function decide(volumeId: string, records: Json[]) {
  const [current] = await sqlRows("SELECT id FROM capture_deliveries WHERE pipeline_volume_id = ? AND state = 'registered'", volumeId);
  const res = await answer(
    await recordDecisionsAction(
      { db: drizzle(env.DB), now: () => world.clock.now, newId: () => crypto.randomUUID() },
      new Request(`${HOST}/admin/capture/volumes/${volumeId}/decisions`, {
        method: "POST",
        body: JSON.stringify({ manifestId: current.id, records }),
      }),
      volumeId,
      world.tenant,
      world.admin,
    ),
  );
  expect(res.status).toBe(200);
}

const items = () => loadQueueItems(world.q.db, DEFAULT_TEST_TENANT_ID, world.clock.now);

async function desc(code: string, opts: { parentId?: string; level?: string; childCount?: number; tenantId?: string } = {}) {
  const d = await createTestDescription({
    tenantId: opts.tenantId ?? DEFAULT_TEST_TENANT_ID,
    repositoryId: world.repositoryId,
    descriptionLevel: opts.level ?? "volume",
    referenceCode: code,
    title: `Title ${code}`,
    parentId: opts.parentId ?? null,
    childCount: opts.childCount ?? 0,
  });
  return d.id as string;
}

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, token: string | null = world.token) {
  const h: Record<string, string> = { ...headers };
  if (token !== null) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  return new Request(`${HOST}${path}`, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
}

const putOperators = async (body: unknown, token?: string | null) =>
  answer(await handleOperatorsPut(world.deps, call("PUT", "/api/capture/v1/operators", body, {}, token === undefined ? world.token : token)));
const getQueue = async (headers: Record<string, string> = {}) =>
  answer(await handleQueueGet(world.deps, call("GET", "/api/capture/v1/queue", undefined, headers)));
const ack = async (body: unknown) => answer(await handleQueueAck(world.deps, call("POST", "/api/capture/v1/queue/ack", body)));

async function code(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (thrown) {
    if (thrown instanceof QueueError) return thrown.code;
    throw thrown;
  }
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
  const { token, sha256 } = await mintScannerToken();
  const scannerId = crypto.randomUUID();
  await insertRow("capture_scanners", {
    id: scannerId,
    tenant_id: DEFAULT_TEST_TENANT_ID,
    name: "rig-1",
    token_sha256: sha256,
    token_created_at: T0,
    created_at: T0,
    updated_at: T0,
  });
  const adminRow = await createTestUser({ isAdmin: true, name: "Test Admin" });
  const db = drizzle(env.DB);
  world = {
    deps: {
      db,
      env: {
        [`${TEST_SECRET_PREFIX}_MASTERS_LIST_KEY_ID`]: "test-masters-list-key-id",
        [`${TEST_SECRET_PREFIX}_MASTERS_LIST_SECRET_KEY`]: "test-masters-list-secret",
      },
      fetch: s3.fetch,
      now: () => clock.now,
      newId: () => crypto.randomUUID(),
    },
    q: { db, now: () => clock.now, newId: () => crypto.randomUUID() },
    s3,
    clock,
    token,
    scannerId,
    repositoryId: repo.id,
    tenant: (await drizzle(env.DB, { schema })
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, DEFAULT_TEST_TENANT_ID))
      .get()) as Tenant,
    admin: makeUserContext({ id: adminRow.id, tenantId: adminRow.tenantId, email: adminRow.email, name: adminRow.name, isAdmin: true }),
    volumeDescriptionId: "",
  };
  world.volumeDescriptionId = await desc(CODE);
  await env.DB.prepare("UPDATE tenants SET digitization_enabled = 1 WHERE id = ?").bind(DEFAULT_TEST_TENANT_ID).run();
  world.tenant = { ...world.tenant, digitizationEnabled: true };
});

// ---------------------------------------------------------------------------
// Pure states
// ---------------------------------------------------------------------------

describe("queueStateOf", () => {
  const base = { addedAt: 10, appliedAt: null, skippedAt: null, retakes: false, handover: null };
  it("reads queued, on_unit and skipped from the acknowledgement", () => {
    expect(queueStateOf(base)).toBe("queued");
    expect(queueStateOf({ ...base, appliedAt: 20 })).toBe("on_unit");
    expect(queueStateOf({ ...base, appliedAt: 20, skippedAt: 30 })).toBe("skipped");
    expect(queueStateOf({ ...base, appliedAt: 40, skippedAt: 30 })).toBe("on_unit");
  });
  it("reads the handover over the acknowledgement, and ignores one from before the entry", () => {
    expect(queueStateOf({ ...base, appliedAt: 20, handover: { state: "in_capture_qc", receivedAt: 30 } })).toBe("in_review");
    expect(queueStateOf({ ...base, handover: { state: "published", receivedAt: 30 } })).toBe("approved");
    expect(queueStateOf({ ...base, handover: { state: "received", receivedAt: 30 } })).toBe("captured");
    expect(queueStateOf({ ...base, handover: { state: "refused", receivedAt: 30 } })).toBe("queued");
    expect(queueStateOf({ ...base, handover: { state: "approved", receivedAt: 5 } })).toBe("queued");
  });
  it("reads retakes first", () => {
    expect(queueStateOf({ ...base, retakes: true, handover: { state: "approved", receivedAt: 30 } })).toBe("retakes_requested");
  });
});

// ---------------------------------------------------------------------------
// Changing the queue
// ---------------------------------------------------------------------------

describe("adding to the queue", () => {
  it("adds in order, once per description, and ignores another tenant's ids", async () => {
    const b = await desc("co-test-002");
    const foreign = await createTestDescription({ tenantId: SECOND_TEST_TENANT_ID, repositoryId: world.repositoryId, referenceCode: "x-1" });
    expect(await addToQueue(world.q, world.tenant, world.admin, [b, world.volumeDescriptionId, foreign.id])).toEqual({ added: 2, alreadyQueued: 0 });
    expect(await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId])).toEqual({ added: 0, alreadyQueued: 1 });
    const list = await items();
    expect(list.map((i) => i.referenceCode)).toEqual(["co-test-002", CODE]);
    expect(list.every((i) => i.state === "queued" && i.action === "full-digitisation" && i.addedByName === "Test Admin")).toBe(true);
  });

  it("revives a withdrawn entry on its own row, at the end", async () => {
    const b = await desc("co-test-002");
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId, b]);
    const [first] = await items();
    world.clock.now += 1000;
    expect(await withdrawEntries(world.q, DEFAULT_TEST_TENANT_ID, [first.id])).toBe(1);
    expect((await items()).find((i) => i.id === first.id)?.withdrawnAt).not.toBeNull();
    world.clock.now += 1000;
    expect(await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId])).toEqual({ added: 1, alreadyQueued: 0 });
    const list = await items();
    expect(list.map((i) => [i.referenceCode, i.withdrawnAt])).toEqual([
      ["co-test-002", null],
      [CODE, null],
    ]);
    expect(list[1].id).toBe(first.id);
  });

  it("refuses more than the ceiling at once", async () => {
    const ids = Array.from({ length: MAX_ADD + 1 }, (_, i) => `id-${i}`);
    expect(await code(addToQueue(world.q, world.tenant, world.admin, ids))).toBe("ceiling");
  });

  it("takes the deepest volume or file on each branch, never an item, never a fonds or series", async () => {
    const fonds = await desc("f", { level: "fonds", childCount: 3 });
    const series = await desc("f-s", { level: "series", parentId: fonds, childCount: 4 });
    // A box at file level with folders at file level beneath it: the folders.
    const box = await desc("f-s-caj1", { level: "file", parentId: series, childCount: 3 });
    const folder1 = await desc("f-s-caj1-car1", { level: "file", parentId: box, childCount: 1 });
    await desc("f-s-caj1-car1-i", { level: "item", parentId: folder1 });
    const folder2 = await desc("f-s-caj1-car2", { level: "file", parentId: box });
    await desc("f-s-caj1-i", { level: "item", parentId: box });
    // A box whose children are all items: the box.
    const box2 = await desc("f-s-caj2", { level: "file", parentId: series, childCount: 1 });
    await desc("f-s-caj2-i", { level: "item", parentId: box2 });
    // A volume with no children: itself; a subseries with none: nothing.
    const vol = await desc("f-s-v", { level: "volume", parentId: series });
    await desc("f-s-sub", { level: "subseries", parentId: series });
    // An item on its own, and a series of items only: nothing.
    await desc("f-i", { level: "item", parentId: fonds });
    const itemsOnly = await desc("f-s2", { level: "series", parentId: fonds, childCount: 1 });
    await desc("f-s2-i", { level: "item", parentId: itemsOnly });

    const below = await subtreeToQueue(world.q.db, DEFAULT_TEST_TENANT_ID, fonds);
    expect(new Set(below)).toEqual(new Set([folder1, folder2, box2, vol]));
    expect(new Set(await subtreeToQueue(world.q.db, DEFAULT_TEST_TENANT_ID, box))).toEqual(new Set([folder1, folder2]));
    // The starting description, when the rule picks it.
    expect(await subtreeToQueue(world.q.db, DEFAULT_TEST_TENANT_ID, folder1)).toEqual([folder1]);
    expect(await subtreeToQueue(world.q.db, DEFAULT_TEST_TENANT_ID, itemsOnly)).toEqual([]);
    expect(await code(subtreeToQueue(world.q.db, DEFAULT_TEST_TENANT_ID, "nope"))).toBe("not-found");
  });

  it("stops counting past 50, and refuses to add more than 50 below a description", async () => {
    const series = await desc("big", { level: "series", childCount: 51 });
    for (let i = 0; i < 51; i++) await desc(`big-${String(i).padStart(2, "0")}`, { level: "file", parentId: series });
    const counted = await pickBelow(world.q.db, DEFAULT_TEST_TENANT_ID, series, MAX_BELOW);
    expect(counted.more).toBe(true);
    expect(counted.ids.length).toBeLessThanOrEqual(MAX_BELOW + 1);
    expect(await code(subtreeToQueue(world.q.db, DEFAULT_TEST_TENANT_ID, series))).toBe("below-limit");
    const res = await addAction({ request: post("/admin/capture/queue/add", { below: series }), context: routeContext(world.admin, world.tenant), params: {} } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "below-limit" });
    expect(await sqlRows("SELECT id FROM capture_queue_entries")).toEqual([]);
    await env.DB.prepare("DELETE FROM descriptions WHERE reference_code = 'big-50'").run();
    expect(await pickBelow(world.q.db, DEFAULT_TEST_TENANT_ID, series, MAX_BELOW)).toMatchObject({ more: false });
  });

  it("counts what everything below would add only from 1 to 50, and never the description itself", async () => {
    const series = await desc("cnt", { level: "series", childCount: 51 });
    for (let i = 0; i < 51; i++) await desc(`cnt-${String(i).padStart(2, "0")}`, { level: "file", parentId: series });
    expect(await countBelow(world.q.db, DEFAULT_TEST_TENANT_ID, series)).toBeNull();
    await env.DB.prepare("DELETE FROM descriptions WHERE reference_code = 'cnt-50'").run();
    expect(await countBelow(world.q.db, DEFAULT_TEST_TENANT_ID, series)).toBe(50);
    // A file with only items beneath it would add itself: not "below".
    const box = await desc("cnt-box", { level: "file", childCount: 1 });
    await desc("cnt-box-i", { level: "item", parentId: box });
    expect(await countBelow(world.q.db, DEFAULT_TEST_TENANT_ID, box)).toBeNull();
    const empty = await desc("cnt-empty", { level: "series" });
    expect(await countBelow(world.q.db, DEFAULT_TEST_TENANT_ID, empty)).toBeNull();
  });
});

describe("ordering, assigning and the job", () => {
  it("moves an entry up and down", async () => {
    const b = await desc("co-test-002");
    const c = await desc("co-test-003");
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId, b, c]);
    const [, second] = await items();
    expect(await moveEntry(world.q, DEFAULT_TEST_TENANT_ID, second.id, "up")).toBe(true);
    expect((await items()).map((i) => i.referenceCode)).toEqual(["co-test-002", CODE, "co-test-003"]);
    expect(await moveEntry(world.q, DEFAULT_TEST_TENANT_ID, second.id, "up")).toBe(false);
    await moveEntry(world.q, DEFAULT_TEST_TENANT_ID, second.id, "down");
    await moveEntry(world.q, DEFAULT_TEST_TENANT_ID, second.id, "down");
    expect((await items()).map((i) => i.referenceCode)).toEqual([CODE, "co-test-003", "co-test-002"]);
  });

  it("assigns only to an active operator of a scanner of the tenant, and unassigns", async () => {
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId]);
    const [entry] = await items();
    expect((await putOperators({ operators: [
      { username: "ana", role: "operator", active: true },
      { username: "old", role: "operator", active: false },
    ] })).status).toBe(204);
    expect(await code(assignItems(world.q, DEFAULT_TEST_TENANT_ID, [entry.id], { scannerId: world.scannerId, username: "old" }))).toBe("operator");
    expect(await code(assignItems(world.q, DEFAULT_TEST_TENANT_ID, [entry.id], { scannerId: world.scannerId, username: "nobody" }))).toBe("operator");
    expect(await code(assignItems(world.q, DEFAULT_TEST_TENANT_ID, [entry.id], { scannerId: "other", username: null }))).toBe("operator");
    expect(await code(assignItems(world.q, DEFAULT_TEST_TENANT_ID, ["missing"], { scannerId: world.scannerId, username: "ana" }))).toBe("not-found");
    await assignItems(world.q, DEFAULT_TEST_TENANT_ID, [entry.id], { scannerId: world.scannerId, username: "ana" });
    expect((await items())[0]).toMatchObject({ scannerId: world.scannerId, assignee: "ana" });
    await assignItems(world.q, DEFAULT_TEST_TENANT_ID, [entry.id], null);
    expect((await items())[0]).toMatchObject({ scannerId: null, assignee: null });
  });

  it("sets the job and note, a blank note as none", async () => {
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId]);
    const [entry] = await items();
    await setItemJob(world.q, DEFAULT_TEST_TENANT_ID, entry.id, { action: "full-rescan", note: "  Folios 3 to 9  " });
    expect((await items())[0]).toMatchObject({ action: "full-rescan", note: "Folios 3 to 9" });
    await setItemJob(world.q, DEFAULT_TEST_TENANT_ID, entry.id, { action: "complete", note: " " });
    expect((await items())[0]).toMatchObject({ action: "complete", note: null });
    expect(await code(setItemJob(world.q, DEFAULT_TEST_TENANT_ID, entry.id, { action: "complete", note: "x".repeat(2001) }))).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------
// States and retakes
// ---------------------------------------------------------------------------

describe("states read from the handover", () => {
  it("is captured or in review once handed over, then approved", async () => {
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId]);
    world.clock.now += 1000;
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    expect(["captured", "in_review"]).toContain((await items())[0].state);
    await decide(volumeId, [
      { captuaRecordId: 11, decision: "approved" },
      { captuaRecordId: 12, decision: "approved" },
    ]);
    expect((await items())[0].state).toBe("approved");
  });
});

describe("retakes", () => {
  async function rejectSpread() {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    await decide(volumeId, [
      { captuaRecordId: 11, decision: "approved" },
      { captuaRecordId: 12, decision: "rejected", reason: "framing", side: "both", note: "Margin cut" },
    ]);
    return volumeId;
  }

  it("puts a volume with a rejected opening in the queue as spot-recapture with its pairs", async () => {
    const volumeId = await rejectSpread();
    const list = await items();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: volumeId,
      stored: false,
      origin: "retake",
      referenceCode: CODE,
      action: "spot-recapture",
      state: "retakes_requested",
      assignee: null,
      retakes: [{ captuaRecordId: 12, pairId: `pair-${CODE}-2`, side: "both" }],
    });
    expect(await code(withdrawEntries(world.q, DEFAULT_TEST_TENANT_ID, [volumeId]))).toBe("retakes");
  });

  it("carries the retakes on the entry of a queued description, and refuses to withdraw it", async () => {
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId]);
    world.clock.now += 1000;
    await rejectSpread();
    const list = await items();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ stored: true, origin: "queue", action: "spot-recapture", entryAction: "full-digitisation" });
    expect(await code(withdrawEntries(world.q, DEFAULT_TEST_TENANT_ID, [list[0].id]))).toBe("retakes");
  });

  it("keeps an assignment on a row under the volume's id, and leaves when the retake is approved", async () => {
    const volumeId = await rejectSpread();
    await putOperators({ operators: [{ username: "ana", role: "operator", active: true }] });
    await assignItems(world.q, DEFAULT_TEST_TENANT_ID, [volumeId], { scannerId: world.scannerId, username: "ana" });
    expect((await items())[0]).toMatchObject({ id: volumeId, stored: true, origin: "retake", assignee: "ana" });

    world.clock.now += DAY;
    await deliver(manifest([volume(CODE, [12])]));
    await decide(volumeId, [{ captuaRecordId: 12, decision: "approved" }]);
    expect(await items()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The unit calls
// ---------------------------------------------------------------------------

describe("PUT /api/capture/v1/operators", () => {
  it("replaces the scanner's list whole, with the username as display name when none is sent", async () => {
    await putOperators({ operators: [
      { username: "ana", role: "admin", active: true },
      { username: "luis", role: "operator", active: true },
    ] });
    expect((await putOperators({ operators: [{ username: "luis", displayName: "luis", role: "operator", active: false, email: "ignored" }] })).status).toBe(204);
    const rows = await sqlRows("SELECT username, display_name, role, active, tenant_id FROM capture_scanner_operators");
    expect(rows).toEqual([{ username: "luis", display_name: "luis", role: "operator", active: 0, tenant_id: DEFAULT_TEST_TENANT_ID }]);
    await putOperators({ operators: [{ username: "ana", role: "admin", active: true }] });
    expect(await sqlRows("SELECT username, display_name FROM capture_scanner_operators")).toEqual([{ username: "ana", display_name: "ana" }]);
  });

  it("refuses a malformed body, a reviewer role and a duplicate username with 422", async () => {
    const malformed = await putOperators("{nope");
    expect(malformed.status).toBe(422);
    expect(malformed.json!.problems[0].rule).toBe("malformed");
    const reviewer = await putOperators({ operators: [{ username: "ana", role: "reviewer", active: true }] });
    expect(reviewer.status).toBe(422);
    expect(reviewer.json!.problems[0]).toMatchObject({ rule: "shape", path: "operators.0.role" });
    const twice = await putOperators({ operators: [
      { username: "ana", role: "admin", active: true },
      { username: "ana", role: "operator", active: true },
    ] });
    expect(twice.status).toBe(422);
    expect(twice.json!.problems[0].rule).toBe("duplicate-username");
  });

  it("answers 401 without a token and 405 to another method", async () => {
    expect((await putOperators({ operators: [] }, null)).status).toBe(401);
    expect((await answer(await handleOperatorsPut(world.deps, call("POST", "/api/capture/v1/operators", { operators: [] })))).status).toBe(405);
  });
});

describe("GET /api/capture/v1/queue", () => {
  it("serves the queue with the contract list fields, an ETag, and 304 when unchanged", async () => {
    const fonds = await desc("co-test", { level: "fonds", childCount: 1 });
    const vol = await createTestDescription({
      tenantId: DEFAULT_TEST_TENANT_ID,
      repositoryId: world.repositoryId,
      descriptionLevel: "volume",
      referenceCode: "co-test-009",
      title: "Libro de cabildos",
      dateExpression: "1610-1620",
      parentId: fonds,
    });
    await addToQueue(world.q, world.tenant, world.admin, [vol.id, world.volumeDescriptionId]);
    const first = await getQueue();
    expect(first.status).toBe(200);
    expect(first.headers.get("ETag")).toBe(`"${first.json!.revision}"`);
    expect(first.json!.listName).toBe(world.tenant.name);
    expect(first.json!.items[0]).toEqual({
      itemId: expect.any(String),
      referenceCode: "co-test-009",
      filenameStem: "co-test-009",
      sequence: 1,
      title: "Libro de cabildos",
      dates: { display: "1610-1620", start: null, end: null },
      extent: null,
      containerPath: [{ level: "fonds", title: "Title co-test", referenceCode: "co-test" }],
      action: "full-digitisation",
      notes: null,
      assignee: null,
      withdrawn: false,
    });
    expect(first.json!.items[1]).toMatchObject({ referenceCode: CODE, sequence: 2 });

    const again = await getQueue({ "If-None-Match": `"${first.json!.revision}"` });
    expect(again.status).toBe(304);
    expect(again.headers.get("ETag")).toBe(`"${first.json!.revision}"`);

    world.clock.now += 1000;
    await setItemJob(world.q, DEFAULT_TEST_TENANT_ID, first.json!.items[0].itemId, { action: "full-rescan", note: "Tight binding" });
    const changed = await getQueue({ "If-None-Match": `"${first.json!.revision}"` });
    expect(changed.status).toBe(200);
    expect(changed.json!.items[0]).toMatchObject({ action: "full-rescan", notes: "Tight binding" });
  });

  it("leaves out approved items, and carries the retakes of a retake volume", async () => {
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId]);
    world.clock.now += 1000;
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    await decide(volumeId, [
      { captuaRecordId: 11, decision: "approved" },
      { captuaRecordId: 12, decision: "rejected", reason: "framing", side: "left" },
    ]);
    const withRetakes = await getQueue();
    expect(withRetakes.json!.items).toEqual([
      expect.objectContaining({ referenceCode: CODE, action: "spot-recapture", retakes: [{ captuaRecordId: 12, pairId: `pair-${CODE}-2`, side: "left" }] }),
    ]);
    world.clock.now += DAY;
    await deliver(manifest([volume(CODE, [12])]));
    await decide(volumeId, [{ captuaRecordId: 12, decision: "approved" }]);
    expect((await getQueue()).json!.items).toEqual([]);
  });

  it("flags a withdrawn item until it is acknowledged under a revision from after the withdrawal", async () => {
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId]);
    const before = await getQueue();
    const itemId = before.json!.items[0].itemId;
    world.clock.now += 1000;
    await withdrawEntries(world.q, DEFAULT_TEST_TENANT_ID, [itemId]);
    const after = await getQueue();
    expect(after.json!.items).toEqual([expect.objectContaining({ itemId, withdrawn: true })]);

    // An acknowledgement of the older revision does not clear it.
    expect((await ack({ revision: before.json!.revision, applied: [{ itemId, collectionId: 7 }] })).status).toBe(200);
    expect((await getQueue()).json!.items).toHaveLength(1);
    await ack({ revision: after.json!.revision, applied: [{ itemId, collectionId: 7 }] });
    expect((await getQueue()).json!.items).toEqual([]);
  });

  it("keeps a retake volume's item id across revisions, before and after it gets a row", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    await decide(volumeId, [
      { captuaRecordId: 11, decision: "approved" },
      { captuaRecordId: 12, decision: "rejected", reason: "framing", side: "right" },
    ]);
    const first = await getQueue();
    expect(first.json!.items).toEqual([expect.objectContaining({ itemId: volumeId, retakes: [{ captuaRecordId: 12, pairId: `pair-${CODE}-2`, side: "right" }] })]);
    world.clock.now += 1000;
    await setItemJob(world.q, DEFAULT_TEST_TENANT_ID, volumeId, { action: "spot-recapture", note: "Right page only" });
    const second = await getQueue();
    expect(second.json!.revision).not.toBe(first.json!.revision);
    expect(second.json!.items).toEqual([expect.objectContaining({ itemId: volumeId, notes: "Right page only" })]);
  });

  it("names the assignee only for this scanner's assignments", async () => {
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId]);
    await putOperators({ operators: [{ username: "ana", role: "operator", active: true }] });
    const [entry] = await items();
    await assignItems(world.q, DEFAULT_TEST_TENANT_ID, [entry.id], { scannerId: world.scannerId, username: "ana" });
    expect((await getQueue()).json!.items[0].assignee).toBe("ana");
  });
});

describe("POST /api/capture/v1/queue/ack", () => {
  it("records applied and skipped items, and lists unknown ids back", async () => {
    const b = await desc("co-test-002");
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId, b]);
    const served = await getQueue();
    const [x, y] = served.json!.items;
    const res = await ack({
      revision: served.json!.revision,
      applied: [{ itemId: x.itemId, collectionId: 41 }, { itemId: "nope", collectionId: 1 }],
      skipped: [{ itemId: y.itemId, reason: "Stem too long" }],
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ recorded: 2, unknown: ["nope"] });
    const states = Object.fromEntries((await items()).map((i) => [i.referenceCode, [i.state, i.skippedReason]]));
    expect(states).toEqual({ [CODE]: ["on_unit", null], "co-test-002": ["skipped", "Stem too long"] });
    expect(await sqlRows("SELECT collection_id FROM capture_queue_entries WHERE id = ?", x.itemId)).toEqual([{ collection_id: "41" }]);
  });

  it("refuses a revision Fisqua could not have served", async () => {
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId]);
    const served = await getQueue();
    const [stamp, hash] = served.json!.revision.split("-");
    expect((await ack({ revision: `${Number(stamp) + 1}-${hash}`, applied: [] })).status).toBe(422);
    expect((await ack({ revision: "latest", applied: [] })).json!.problems[0].rule).toBe("revision");
    expect((await ack({ revision: served.json!.revision, skipped: [{ itemId: "x", reason: "" }] })).status).toBe(422);
  });

  it("shares the link's rate limit", async () => {
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) expect((await getQueue()).status).toBe(200);
    const over = await ack({ revision: "0-0000000000000000" });
    expect(over.status).toBe(429);
    expect(over.headers.get("Retry-After")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The screen and the add route
// ---------------------------------------------------------------------------

function routeContext(user: User, tenant: Tenant): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, tenant);
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    const res = await p;
    return res instanceof Response ? res.status : 200;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}

function post(path: string, form: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(form)) body.set(k, v);
  return new Request(`${HOST}${path}`, { method: "POST", body });
}

describe("the queue screen and the add route", () => {
  const on = () => ({ ...world.tenant, digitizationEnabled: true });

  it("are 404 without the capability and 403 for someone who does not manage capture work", async () => {
    const outsiderRow = await createTestUser({ name: "Test Outsider" });
    const outsider = makeUserContext({ id: outsiderRow.id, tenantId: outsiderRow.tenantId, email: outsiderRow.email });
    const off = { ...world.tenant, digitizationEnabled: false };
    expect(await status(queueLoader({ request: new Request(`${HOST}/admin/capture/queue`), context: routeContext(world.admin, off), params: {} } as any))).toBe(404);
    expect(await status(queueLoader({ request: new Request(`${HOST}/admin/capture/queue`), context: routeContext(outsider, on()), params: {} } as any))).toBe(403);
    const add = post("/admin/capture/queue/add", { descriptionIds: JSON.stringify([world.volumeDescriptionId]) });
    expect(await status(addAction({ request: add, context: routeContext(outsider, on()), params: {} } as any))).toBe(403);
    const count = () => new Request(`${HOST}/admin/capture/queue/add?below=${world.volumeDescriptionId}`);
    expect(await status(addLoader({ request: count(), context: routeContext(world.admin, off), params: {} } as any))).toBe(404);
    expect(await status(addLoader({ request: count(), context: routeContext(outsider, on()), params: {} } as any))).toBe(403);
    expect(await sqlRows("SELECT id FROM capture_queue_entries")).toEqual([]);
  });

  it("lets a federation staff grant load the queue, add, assign, reorder, set the job and withdraw", async () => {
    const staff = await createGrantUser("staff", { name: "Test Staff" });
    const ctx = () => routeContext(staff, on());
    const second = await desc("co-test-002");
    const added = await addAction({ request: post("/admin/capture/queue/add", { descriptionIds: JSON.stringify([world.volumeDescriptionId, second]) }), context: ctx(), params: {} } as any);
    expect(await added.json()).toEqual({ ok: true, added: 2, alreadyQueued: 0 });
    const count = await addLoader({ request: new Request(`${HOST}/admin/capture/queue/add?below=${world.volumeDescriptionId}`), context: ctx(), params: {} } as any);
    expect(count.status).toBe(200);

    const loaded = await queueLoader({ request: new Request(`${HOST}/admin/capture/queue`), context: ctx(), params: {} } as any);
    expect(loaded.items.map((i: Json) => i.referenceCode)).toEqual([CODE, "co-test-002"]);
    const [first, next] = loaded.items as Json[];

    expect((await putOperators({ operators: [{ username: "ana", role: "operator", active: true }] })).status).toBe(204);
    const act = (form: Record<string, string>) => queueAction({ request: post("/admin/capture/queue", form), context: ctx(), params: {} } as any);
    expect(await act({ intent: "assign", ids: JSON.stringify([first.id]), to: `${world.scannerId}|ana` })).toEqual({ ok: true });
    expect(await act({ intent: "move", id: next.id, direction: "up" })).toEqual({ ok: true });
    expect(await act({ intent: "job", id: first.id, action: "full-rescan", note: "Folios 3 to 9" })).toEqual({ ok: true });
    expect(await act({ intent: "withdraw", ids: JSON.stringify([next.id]) })).toEqual({ ok: true });

    const after = (await items()).filter((i) => i.withdrawnAt === null);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ referenceCode: CODE, assignee: "ana", action: "full-rescan", note: "Folios 3 to 9" });
  });

  it("adds by ids, by everything below, and by handlist", async () => {
    const ctx = routeContext(world.admin, on());
    const byIds = await addAction({ request: post("/admin/capture/queue/add", { descriptionIds: JSON.stringify([world.volumeDescriptionId]) }), context: ctx, params: {} } as any);
    expect(await byIds.json()).toEqual({ ok: true, added: 1, alreadyQueued: 0 });

    const series = await desc("co-s", { level: "series", childCount: 2 });
    await desc("co-s-1", { parentId: series });
    await desc("co-s-2", { parentId: series });
    const counted = await addLoader({ request: new Request(`${HOST}/admin/capture/queue/add?below=${series}`), context: ctx, params: {} } as any);
    expect(await counted.json()).toEqual({ below: 2 });
    const unknown = await addLoader({ request: new Request(`${HOST}/admin/capture/queue/add?below=nope`), context: ctx, params: {} } as any);
    expect(await unknown.json()).toEqual({ below: null });
    const below = await addAction({ request: post("/admin/capture/queue/add", { below: series }), context: ctx, params: {} } as any);
    expect(await below.json()).toEqual({ ok: true, added: 2, alreadyQueued: 0 });

    const extra = await desc("co-h-1");
    const list = await createHandlist(world.q.db, world.tenant, world.admin, { name: "To scan", recordType: "records", memberIds: [extra, world.volumeDescriptionId] });
    const byList = await addAction({ request: post("/admin/capture/queue/add", { handlistId: list.id }), context: ctx, params: {} } as any);
    expect(await byList.json()).toEqual({ ok: true, added: 1, alreadyQueued: 1 });

    const loaded = await queueLoader({ request: new Request(`${HOST}/admin/capture/queue`), context: ctx, params: {} } as any);
    expect(loaded.items.map((i: Json) => i.referenceCode)).toEqual([CODE, "co-s-1", "co-s-2", "co-h-1"]);
  });

  it("exports the queue as a contract digitisation-list file", async () => {
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId]);
    const res = (await queueAction({ request: post("/admin/capture/queue", { intent: "export", ids: "[]" }), context: routeContext(world.admin, on()), params: {} } as any)) as Response;
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="digitisation-list_neogranadina_queue_\d{4}-\d{2}-\d{2}\.json"$/);
    const file = await res.json();
    expect(file).toMatchObject({
      contract: "fisqua-captua-exchange",
      version: "1.4",
      kind: "digitisation-list",
      generatedBy: { system: "fisqua", instance: "neogranadina" },
      list: { name: world.tenant.name, tenant: "neogranadina" },
      items: [{ referenceCode: CODE, filenameStem: CODE, sequence: 1, action: "full-digitisation", notes: null, typology: null, expectedImages: null }],
    });
  });
});

// ---------------------------------------------------------------------------
// Review fixes
// ---------------------------------------------------------------------------

describe("item ids, acknowledgements and the gate", () => {
  async function rejectSpread(side = "both") {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    await decide(volumeId, [
      { captuaRecordId: 11, decision: "approved" },
      { captuaRecordId: 12, decision: "rejected", reason: "framing", side },
    ]);
    return volumeId;
  }

  it("keeps a derived retake's volume id when its description is added to the queue", async () => {
    const volumeId = await rejectSpread();
    expect((await getQueue()).json!.items[0].itemId).toBe(volumeId);
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId]);
    expect((await items())[0]).toMatchObject({ id: volumeId, stored: true, origin: "queue" });
    expect((await getQueue()).json!.items[0].itemId).toBe(volumeId);
  });

  it("refuses an acknowledgement under a revision never served to this scanner", async () => {
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId]);
    const served = await getQueue();
    const itemId = served.json!.items[0].itemId;
    world.clock.now += 1000;
    await withdrawEntries(world.q, DEFAULT_TEST_TENANT_ID, [itemId]);
    const stamp = (await sqlRows("SELECT MAX(changed_at) AS s FROM capture_queue_entries"))[0].s;
    const forged = await ack({ revision: `${stamp}-ffffffffffffffff`, applied: [{ itemId, collectionId: 1 }] });
    expect(forged.status).toBe(422);
    expect(forged.json!.problems[0].rule).toBe("revision");
    expect((await getQueue()).json!.items).toEqual([expect.objectContaining({ itemId, withdrawn: true })]);
  });

  it("lists back a volume id that is not a derived retake, and one whose description has its own entry", async () => {
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId]);
    const [entry] = await items();
    world.clock.now += 1000;
    const volumeId = await rejectSpread();
    expect(entry.id).not.toBe(volumeId);
    const served = await getQueue();
    const res = await ack({ revision: served.json!.revision, applied: [{ itemId: volumeId, collectionId: 1 }] });
    expect(res.json).toEqual({ recorded: 0, unknown: [volumeId] });

    const other = await desc("co-test-002");
    world.clock.now += 1000;
    const plain = await deliver(manifest([volume("co-test-002")]));
    await decide(plain.volumeId, [
      { captuaRecordId: 11, decision: "approved" },
      { captuaRecordId: 12, decision: "approved" },
    ]);
    const again = await getQueue();
    expect((await ack({ revision: again.json!.revision, applied: [{ itemId: plain.volumeId, collectionId: 2 }] })).json).toEqual({
      recorded: 0,
      unknown: [plain.volumeId],
    });
    expect(await sqlRows("SELECT id FROM capture_queue_entries WHERE description_id = ?", other)).toEqual([]);
  });

  it("clears the acknowledgement when a withdrawn entry is added again", async () => {
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId]);
    const served = await getQueue();
    const itemId = served.json!.items[0].itemId;
    await ack({ revision: served.json!.revision, skipped: [{ itemId, reason: "Stem too long" }] });
    world.clock.now += 1000;
    await withdrawEntries(world.q, DEFAULT_TEST_TENANT_ID, [itemId]);
    world.clock.now += 1000;
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId]);
    expect((await items())[0]).toMatchObject({ id: itemId, state: "queued", skippedReason: null });
    expect(await sqlRows("SELECT applied_at, collection_id, skipped_at, acked_revision FROM capture_queue_entries")).toEqual([
      { applied_at: null, collection_id: null, skipped_at: null, acked_revision: null },
    ]);
  });

  it("adds a handlist's members as they resolve now, leaving out a deleted one", async () => {
    const a = await desc("co-test-002");
    const b = await desc("co-test-003");
    const list = await createHandlist(world.q.db, world.tenant, world.admin, { name: "To scan", recordType: "records", memberIds: [b, a] });
    await env.DB.prepare("DELETE FROM descriptions WHERE id = ?").bind(b).run();
    expect(await handlistToQueue(world.q.db, world.tenant, world.admin, list.id)).toEqual([a]);
  });

  it("reads the same outstanding retakes as the Retakes screen, in one batch", async () => {
    const volumeId = await rejectSpread("left");
    const same = async () => {
      const screen = (await loadRetakes(world.q.db, DEFAULT_TEST_TENANT_ID, world.admin, true, world.clock.now)).map((v) => [
        v.volumeId,
        v.rows.map((r) => [r.captuaRecordId, r.side ?? "both"]),
      ]);
      const queue = (await readRetakeVolumes(world.q.db, DEFAULT_TEST_TENANT_ID)).map((v) => [
        v.volumeId,
        v.retakes.map((r) => [r.captuaRecordId, r.side]),
      ]);
      expect(queue).toEqual(screen);
      return queue;
    };
    expect(await same()).toEqual([[volumeId, [[12, "left"]]]]);
    // Reshot and not yet reviewed: still outstanding.
    world.clock.now += DAY;
    await deliver(manifest([volume(CODE, [12])]));
    expect(await same()).toEqual([[volumeId, [[12, "left"]]]]);
    // The unit gives the record as excluded: no longer a retake.
    world.clock.now += DAY;
    const excluded = volume(CODE, [12]);
    excluded.records[1].status = "excluded";
    await deliver(manifest([excluded]));
    expect(await same()).toEqual([]);
  });

  it("answers 404 on all three calls when the workspace has no digitization capability", async () => {
    await env.DB.prepare("UPDATE tenants SET digitization_enabled = 0 WHERE id = ?").bind(DEFAULT_TEST_TENANT_ID).run();
    expect((await putOperators({ operators: [] })).status).toBe(404);
    expect((await getQueue()).status).toBe(404);
    expect((await ack({ revision: "0-0000000000000000" })).status).toBe(404);
  });
});

describe("the scanner's mode", () => {
  const modeOf = async () => (await sqlRows("SELECT mode, mode_reported_at FROM capture_scanners WHERE id = ?", world.scannerId))[0];

  it("records the mode sent with the user list, keeps it when none is sent, and refuses an unknown one", async () => {
    expect(await modeOf()).toEqual({ mode: null, mode_reported_at: null });
    expect((await putOperators({ operators: [], mode: "backup" })).status).toBe(204);
    expect(await modeOf()).toEqual({ mode: "backup", mode_reported_at: world.clock.now });
    world.clock.now += 1000;
    await putOperators({ operators: [{ username: "ana", role: "operator", active: true }] });
    expect(await modeOf()).toEqual({ mode: "backup", mode_reported_at: world.clock.now - 1000 });
    const bad = await putOperators({ operators: [], mode: "sleeping" });
    expect(bad.status).toBe(422);
    expect(bad.json!.problems[0].path).toBe("mode");
  });

  it("is on the queue screen's scanners, and never stops an add", async () => {
    await putOperators({ operators: [], mode: "offline" });
    const ctx = routeContext(world.admin, world.tenant);
    const added = await addAction({ request: post("/admin/capture/queue/add", { descriptionIds: JSON.stringify([world.volumeDescriptionId]) }), context: ctx, params: {} } as any);
    expect(await added.json()).toEqual({ ok: true, added: 1, alreadyQueued: 0 });
    const loaded = await queueLoader({ request: new Request(`${HOST}/admin/capture/queue`), context: ctx, params: {} } as any);
    expect(loaded.scanners).toEqual([{ id: world.scannerId, name: "rig-1", mode: "offline", revokedAt: null }]);
  });
});

describe("re-review: revision coverage, stale acknowledgements, large acknowledgements", () => {
  it("changes the revision when a description or an ancestor is edited", async () => {
    const fonds = await desc("co-f", { level: "fonds", childCount: 1 });
    const vol = await desc("co-f-1", { parentId: fonds });
    await addToQueue(world.q, world.tenant, world.admin, [vol]);
    const first = await getQueue();
    await env.DB.prepare("UPDATE descriptions SET title = 'Renamed fonds', updated_at = ? WHERE id = ?").bind(Date.now() + 60_000, fonds).run();
    const after = await getQueue({ "If-None-Match": `"${first.json!.revision}"` });
    expect(after.status).toBe(200);
    expect(after.json!.items[0].containerPath[0].title).toBe("Renamed fonds");
  });

  it("changes the revision when a pipeline run's hold ends by expiry, with no write", async () => {
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId]);
    const user = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID });
    const runId = crypto.randomUUID();
    await insertRow("pipeline_runs", {
      id: runId, tenant_id: DEFAULT_TEST_TENANT_ID, user_id: user.id, kind: "volume_run", purpose: "sample",
      status: "dispatched", runner_image: "ghcr.io/example/runner@sha256:" + "0".repeat(64), script_version: "v1.0.0",
      arch: "x64", max_review_frac: 1, spec_key: `k/${runId}`, spec_sha256: "0".repeat(64),
      spec_url_expires_at: world.clock.now + 500, chunk_count: 1, volume_count: 1, callback_token_hash: "0".repeat(64),
      token_expires_at: world.clock.now + 1000, created_at: world.clock.now, dispatched_at: world.clock.now,
    });
    const before = await getQueue();
    world.clock.now += 2000;
    const after = await getQueue({ "If-None-Match": `"${before.json!.revision}"` });
    expect(after.status).toBe(200);
    expect(after.json!.revision).not.toBe(before.json!.revision);
  });

  it("lists back an item acknowledged under a revision served before it was added again", async () => {
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId]);
    const old = await getQueue();
    const itemId = old.json!.items[0].itemId;
    world.clock.now += 1000;
    await withdrawEntries(world.q, DEFAULT_TEST_TENANT_ID, [itemId]);
    world.clock.now += 1000;
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId]);
    const late = await ack({ revision: old.json!.revision, applied: [{ itemId, collectionId: 9 }], skipped: [{ itemId, reason: "late" }] });
    expect(late.json).toEqual({ recorded: 0, unknown: [itemId] });
    expect((await items())[0]).toMatchObject({ state: "queued", skippedReason: null });
    // Under a revision served since, it counts.
    const fresh = await getQueue();
    expect((await ack({ revision: fresh.json!.revision, applied: [{ itemId, collectionId: 9 }] })).json).toEqual({ recorded: 1, unknown: [] });
  });

  it("records a 5,000-item acknowledgement in a bounded number of statements", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) ids.push(await desc(`co-bulk-${String(i).padStart(3, "0")}`));
    await addToQueue(world.q, world.tenant, world.admin, ids);
    const served = await getQueue();
    const known = served.json!.items.map((i: Json) => i.itemId as string);
    const applied = [
      ...known.slice(0, 30).map((itemId: string, n: number) => ({ itemId, collectionId: n })),
      ...Array.from({ length: 2470 }, (_, n) => ({ itemId: `unknown-a-${n}`, collectionId: n })),
    ];
    const skipped = [
      ...known.slice(30).map((itemId: string) => ({ itemId, reason: "No stem" })),
      ...Array.from({ length: 2470 }, (_, n) => ({ itemId: `unknown-s-${n}`, reason: "x" })),
    ];
    let prepared = 0;
    const counting = new Proxy(env.DB, {
      get(target, prop) {
        const value = (target as any)[prop];
        if (prop === "prepare") return (q: string) => { prepared++; return value.call(target, q); };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const res = await answer(
      await handleQueueAck({ ...world.deps, db: drizzle(counting as D1Database) }, call("POST", "/api/capture/v1/queue/ack", { revision: served.json!.revision, applied, skipped })),
    );
    expect(res.status).toBe(200);
    expect(res.json!.recorded).toBe(60);
    expect(res.json!.unknown).toHaveLength(4940);
    expect(prepared).toBeLessThan(60);
    const states = (await items()).map((i) => i.state);
    expect(states.filter((s) => s === "on_unit")).toHaveLength(30);
    expect(states.filter((s) => s === "skipped")).toHaveLength(30);
  });
});

describe("third pass: guarded writes, query plans, named retakes", () => {
  const plan = async (statement: any) =>
    (await world.q.db.all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${statement}`)).map((r) => r.detail);

  it("guards both writes by scanner and by revival, so a late acknowledgement changes nothing", async () => {
    const b = await desc("co-test-002");
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId, b]);
    const [x, y] = await items();
    // x revived after stamp 100; y assigned to another tenant's scanner.
    await env.DB.prepare("UPDATE capture_queue_entries SET revived_stamp = 200 WHERE id = ?").bind(x.id).run();
    const otherScanner = crypto.randomUUID();
    await insertRow("capture_scanners", { id: otherScanner, tenant_id: SECOND_TEST_TENANT_ID, name: "rig-2", created_at: T0, updated_at: T0 });
    await env.DB.prepare("UPDATE capture_queue_entries SET scanner_id = ? WHERE id = ?").bind(otherScanner, y.id).run();
    const writes = ackWrites({
      tenantId: DEFAULT_TEST_TENANT_ID, scannerId: world.scannerId, ackedStamp: 100, now: world.clock.now,
      applied: new Map([[x.id, "7"]]), skipped: new Map([[y.id, "late"]]),
    });
    const changed: string[] = [];
    for (const w of writes) changed.push(...(await world.q.db.all<{ id: string }>(w)).map((r) => r.id));
    expect(changed).toEqual([]);
    expect(await sqlRows("SELECT applied_at, skipped_at FROM capture_queue_entries ORDER BY position")).toEqual([
      { applied_at: null, skipped_at: null },
      { applied_at: null, skipped_at: null },
    ]);
  });

  it("writes acknowledgements by primary key lookups, never scanning the tenant's entries", async () => {
    const writes = ackWrites({
      tenantId: DEFAULT_TEST_TENANT_ID, scannerId: world.scannerId, ackedStamp: 1, now: 1,
      applied: new Map([["a", "1"]]), skipped: new Map([["b", "r"]]),
    });
    expect(writes).toHaveLength(2);
    for (const w of writes) {
      const details = await plan(w);
      expect(details.some((d) => /^SCAN capture_queue_entries\b/.test(d))).toBe(false);
      expect(details.some((d) => /^SEARCH capture_queue_entries USING .*\(id=\?\)/.test(d))).toBe(true);
    }
  });

  it("reads the revision's inputs through tenant-leading indexes", async () => {
    const details = await plan(revisionInputsSql(DEFAULT_TEST_TENANT_ID, world.clock.now));
    const scans = details.filter((d) => /^SCAN (pipeline_|capture_|descriptions)/.test(d) && !/USING/.test(d));
    expect(scans).toEqual([]);
    for (const table of ["pipeline_run_chunks", "pipeline_run_volumes", "pipeline_runs", "capture_review_runs"]) {
      expect(details.some((d) => d.includes(table) && /USING/.test(d))).toBe(true);
    }
  });

  it("reads the retakes of named volumes only", async () => {
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    await decide(volumeId, [
      { captuaRecordId: 11, decision: "approved" },
      { captuaRecordId: 12, decision: "rejected", reason: "framing", side: "both" },
    ]);
    expect((await readRetakeVolumes(world.q.db, DEFAULT_TEST_TENANT_ID, { volumeIds: [volumeId] })).map((v) => v.volumeId)).toEqual([volumeId]);
    expect(await readRetakeVolumes(world.q.db, DEFAULT_TEST_TENANT_ID, { volumeIds: ["other"] })).toEqual([]);
  });
});

describe("only entries with capture work left are served", () => {
  it("does not serve an entry added before its handover, which reads as captured", async () => {
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId]);
    world.clock.now += 1000;
    await deliver(manifest([volume(CODE)]));
    expect(["captured", "in_review"]).toContain((await items())[0].state);
    expect((await getQueue()).json!.items).toEqual([]);
  });

  it("stops serving a queued entry once its handover arrives, under a new revision", async () => {
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId]);
    const before = await getQueue();
    expect(before.json!.items).toHaveLength(1);
    world.clock.now += 1000;
    await deliver(manifest([volume(CODE)]));
    const after = await getQueue({ "If-None-Match": `"${before.json!.revision}"` });
    expect(after.status).toBe(200);
    expect(after.json!.revision).not.toBe(before.json!.revision);
    expect(after.json!.items).toEqual([]);
    // The screen still lists it, with its state.
    expect((await items()).map((i) => i.referenceCode)).toEqual([CODE]);
  });

  it("still serves a retakes_requested entry with its retakes", async () => {
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId]);
    world.clock.now += 1000;
    const { volumeId } = await deliver(manifest([volume(CODE)]));
    expect((await getQueue()).json!.items).toEqual([]);
    await decide(volumeId, [
      { captuaRecordId: 11, decision: "approved" },
      { captuaRecordId: 12, decision: "rejected", reason: "framing", side: "left" },
    ]);
    expect((await items())[0].state).toBe("retakes_requested");
    expect((await getQueue()).json!.items).toEqual([
      expect.objectContaining({ referenceCode: CODE, action: "spot-recapture", retakes: [{ captuaRecordId: 12, pairId: `pair-${CODE}-2`, side: "left" }] }),
    ]);
  });
});

describe("the serving-rules version", () => {
  it("is part of the revision, so a change of rules ends every ETag held from before", async () => {
    await addToQueue(world.q, world.tenant, world.admin, [world.volumeDescriptionId]);
    const served = await getQueue();
    const row = await world.q.db.get<Record<string, number | string | null>>(revisionInputsSql(DEFAULT_TEST_TENANT_ID, world.clock.now));
    const parts = { scannerId: world.scannerId, listName: world.tenant.name, row };
    const stamp = Number(row?.stamp ?? 0);
    expect(QUEUE_SERVE_VERSION).toBe(2);
    expect(await queueRevisionOf(stamp, parts)).toBe(served.json!.revision);
    expect(await queueRevisionOf(stamp, parts, QUEUE_SERVE_VERSION - 1)).not.toBe(served.json!.revision);
  });
});

// @version v0.9.0
