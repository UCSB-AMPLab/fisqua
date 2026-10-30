/**
 * Tests — the Digitization screens: Volumes and the Capture QC queue
 *
 * This suite seeds pipeline volumes and capture deliveries directly, in
 * the default tenant and in a second one, and reads them through the
 * two pages' loaders and the module behind them. It pins:
 *
 *   - the digitization capability: off by default, a bare 404 from both
 *     loaders when off, and the migrated `tenants` column defaulting to 0;
 *   - who sees what: Volumes for those who pass the digitization area
 *     (workspace admins and the digitization admin, not the other area
 *     admins) and federation stewards only; the queue for them and for a volume's assigned reviewer, who
 *     sees only their own volumes and gets no reviewer candidates; a bare
 *     403 for anyone else; and `captureAccess`, which the sidebar reads;
 *   - tenant scoping: nothing of the second tenant's handovers, volumes,
 *     decisions or reviewers reaches the default tenant's screens;
 *   - the state mapping, for every link state, and the next step, and
 *     the states the loader derives from deliveries, decisions and runs,
 *     a volume whose handover has a rejected record and every opening
 *     approved reading as retakes requested, waiting for the scanner,
 *     and out of the queue;
 *   - assignment through the existing reviewer route, as the queue
 *     posts it, and the candidates grouped as that route allows;
 *   - the reviewer and decisions actions answering a bare 404, and
 *     writing nothing, when the capability is off;
 *   - a failed run showing the message the run recorded for the volume,
 *     while the status call keeps answering with the error's class only.
 *
 * Every value here is a test value: no real tenant, volume or person.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { RouterContextProvider } from "react-router";
import {
  applyMigrations,
  cleanDatabase,
  seedFederations,
  DEFAULT_TEST_FEDERATION_ID,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_FEDERATION_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { insertRow, seedReceivedVolumes, type ReceivedVolume } from "../helpers/media-pipeline";
import { mintScannerToken } from "../../app/lib/capture/token";
import { handleVolumeStatus } from "../../app/lib/capture/link.server";
import { tenantContext, userContext, type Tenant, type User } from "../../app/context";
import { hasCapability, requireCapability } from "../../app/lib/tenant";
import { CAPTURE_LINK_STATES, type CaptureLinkState } from "../../app/lib/validation/enums";
import { inQueue, nextStepOf, REFUSAL_RULES, refusalKey, screenStateFor, screenStateOf, waitingDays } from "../../app/lib/capture/screens";
import enCapture from "../../app/locales/en/capture";
import esCapture from "../../app/locales/es/capture";
import {
  captureAccess,
  loadCaptureVolumes,
  loadReviewerCandidates,
  loadVolumeScreenStates,
} from "../../app/lib/capture/screens.server";
import { loader as volumesLoader } from "../../app/routes/_auth.admin.capture.volumes";
import { loader as queueLoader } from "../../app/routes/_auth.admin.capture.qc";
import { action as reviewerAction } from "../../app/routes/_auth.admin.capture.volumes.$volumeId.reviewer";
import { action as decisionsAction } from "../../app/routes/_auth.admin.capture.volumes.$volumeId.decisions";

const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const HEX = "a".repeat(64);

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

let seq = 0;

/** A delivery row as the registration writes it, by the file route. */
async function delivery(
  tenantId: string,
  ref: string,
  opts: {
    volumeId?: string | null;
    state?: "received" | "registered" | "refused" | "superseded";
    openings?: number;
    rejectedRecords?: number;
    receivedAt?: number;
    supersededBy?: string;
    problems?: string;
    rule?: string;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const state = opts.state ?? "registered";
  seq += 1;
  await insertRow("capture_deliveries", {
    tenant_id: tenantId,
    id,
    route: "file",
    scanner_id: null,
    reference_code: ref,
    pipeline_volume_id: opts.volumeId ?? null,
    body_sha256: HEX,
    state,
    problems: "[]",
    answer_status: state === "refused" ? 422 : 200,
    answer_body: state === "refused" ? JSON.stringify({ problems: [{ rule: opts.rule ?? "test", message: opts.problems ?? "Refused for a test" }] }) : "{}",
    records: state === "refused" ? null : "[]",
    openings: opts.openings ?? 4,
    rejected_records: opts.rejectedRecords ?? 0,
    received_at: opts.receivedAt ?? T0,
    superseded_by: state === "superseded" ? opts.supersededBy ?? "later" : null,
    superseded_at: state === "superseded" ? (opts.receivedAt ?? T0) + 1 : null,
    seq,
    write_id: null,
  });
  return id;
}

async function decisionSet(
  tenantId: string,
  deliveryId: string,
  volumeId: string,
  counts: { openings: number; approved: number; rejected: number },
) {
  const state =
    counts.rejected > 0 ? "retakes_requested" : counts.approved === counts.openings ? "approved" : "in_capture_qc";
  await insertRow("capture_qc_sets", {
    tenant_id: tenantId,
    delivery_id: deliveryId,
    pipeline_volume_id: volumeId,
    decisions_id: crypto.randomUUID(),
    decided_at: T0,
    revision: 1,
    opening_count: counts.openings,
    decided_count: counts.approved + counts.rejected,
    approved_count: counts.approved,
    rejected_count: counts.rejected,
    notes_bytes: 0,
    state,
    state_entered_at: T0,
    write_id: crypto.randomUUID(),
  });
}

async function assignRow(tenantId: string, volumeId: string, reviewerId: string, by: string) {
  await insertRow("capture_qc_reviewers", {
    tenant_id: tenantId,
    pipeline_volume_id: volumeId,
    reviewer_id: reviewerId,
    assigned_by: by,
    assigned_at: T0,
  });
}

async function person(opts: { tenantId?: string; isAdmin?: boolean; name?: string } = {}): Promise<User> {
  const row = await createTestUser({ tenantId: opts.tenantId, isAdmin: opts.isAdmin, name: opts.name });
  return makeUserContext({ id: row.id, tenantId: row.tenantId, email: row.email, name: row.name, isAdmin: row.isAdmin });
}

function context(user: User, tenant: Tenant): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, tenant);
  (ctx as any).cloudflare = { env };
  return ctx;
}

const on = (overrides: Partial<Tenant> = {}) => makeTenantContext({ digitizationEnabled: true, ...overrides });

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}

function loadVolumes(user: User, tenant: Tenant) {
  return volumesLoader({ request: new Request("http://neogranadina.fisqua.test/admin/capture/volumes"), context: context(user, tenant), params: {} } as any);
}

function loadQueue(user: User, tenant: Tenant) {
  return queueLoader({ request: new Request("http://neogranadina.fisqua.test/admin/capture/qc"), context: context(user, tenant), params: {} } as any);
}

interface World {
  admin: User;
  steward: User;
  reviewer: User;
  outsider: User;
  otherAdmin: User;
  /** Default tenant: in capture QC, assigned to `reviewer`. */
  mine: ReceivedVolume;
  /** Default tenant: registered, undecided, unassigned. */
  open: ReceivedVolume;
  /** Second tenant: registered and assigned to its own admin. */
  foreign: ReceivedVolume;
  mineDelivery: string;
}

let world: World;

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDatabase();
  await seedFederations();
  const admin = await person({ isAdmin: true, name: "Test Admin" });
  const reviewer = await person({ name: "Test Reviewer" });
  const outsider = await person({ name: "Test Outsider" });
  // A steward of the default tenant's federation whose home is another tenant.
  const steward = await person({ tenantId: SECOND_TEST_TENANT_ID, name: "Test Steward" });
  await insertRow("federation_memberships", {
    id: crypto.randomUUID(),
    user_id: steward.id,
    federation_id: DEFAULT_TEST_FEDERATION_ID,
    role: "steward",
    created_at: T0,
  });
  const otherAdmin = await person({ tenantId: SECOND_TEST_TENANT_ID, isAdmin: true, name: "Other Admin" });

  const local = await seedReceivedVolumes({ count: 2, codePrefix: "co-test" });
  const [mine, open] = local.volumes;
  const remote = await seedReceivedVolumes({ tenantId: SECOND_TEST_TENANT_ID, count: 1, codePrefix: "co-other" });
  const [foreign] = remote.volumes;

  const mineDelivery = await delivery(DEFAULT_TEST_TENANT_ID, mine.referenceCode, { volumeId: mine.id, receivedAt: T0 - 3 * DAY });
  await decisionSet(DEFAULT_TEST_TENANT_ID, mineDelivery, mine.id, { openings: 4, approved: 2, rejected: 0 });
  await assignRow(DEFAULT_TEST_TENANT_ID, mine.id, reviewer.id, admin.id);
  await delivery(DEFAULT_TEST_TENANT_ID, open.referenceCode, { volumeId: open.id, receivedAt: T0 - DAY });

  const foreignDelivery = await delivery(SECOND_TEST_TENANT_ID, foreign.referenceCode, { volumeId: foreign.id });
  await decisionSet(SECOND_TEST_TENANT_ID, foreignDelivery, foreign.id, { openings: 4, approved: 1, rejected: 1 });
  await assignRow(SECOND_TEST_TENANT_ID, foreign.id, otherAdmin.id, otherAdmin.id);

  world = { admin, steward, reviewer, outsider, otherAdmin, mine, open, foreign, mineDelivery };
});

// ---------------------------------------------------------------------------
// The capability
// ---------------------------------------------------------------------------

describe("the digitization capability", () => {
  it("is off on a fresh tenant and gates with a bare 404", () => {
    expect(hasCapability(makeTenantContext(), "digitization")).toBe(false);
    expect(hasCapability(on(), "digitization")).toBe(true);
    try {
      requireCapability(makeTenantContext(), "digitization");
      expect.fail("should throw");
    } catch (e) {
      expect((e as Response).status).toBe(404);
      expect((e as Response).body).toBeNull();
    }
  });

  it("defaults to 0 in the migrated tenants table", async () => {
    const row = await env.DB.prepare("SELECT digitization_enabled FROM tenants WHERE id = ?")
      .bind(DEFAULT_TEST_TENANT_ID)
      .first<{ digitization_enabled: number }>();
    expect(row!.digitization_enabled).toBe(0);
  });

  it("404s both pages when the capability is off, even for an admin", async () => {
    const off = makeTenantContext({ digitizationEnabled: false });
    expect(await status(loadVolumes(world.admin, off))).toBe(404);
    expect(await status(loadQueue(world.admin, off))).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Who sees what
// ---------------------------------------------------------------------------

describe("access", () => {
  it("names admins and stewards as managers, and assigned reviewers as reviewers", async () => {
    const db = drizzle(env.DB);
    expect(await captureAccess(db, on(), world.admin)).toEqual({ manager: true, reviewer: false });
    expect(await captureAccess(db, on(), world.steward)).toEqual({ manager: true, reviewer: false });
    expect(await captureAccess(db, on(), world.reviewer)).toEqual({ manager: false, reviewer: true });
    expect(await captureAccess(db, on(), world.outsider)).toEqual({ manager: false, reviewer: false });
  });

  it("names the digitization admin a manager, and no other area admin", async () => {
    const db = drizzle(env.DB);
    const digitizationAdmin = { ...world.outsider, isDigitizationAdmin: true };
    expect(await captureAccess(db, on(), digitizationAdmin)).toEqual({ manager: true, reviewer: false });
    expect(await status(loadVolumes(digitizationAdmin, on()))).toBe(200);
    expect(await status(loadQueue(digitizationAdmin, on()))).toBe(200);
    for (const flag of ["isRecordsAdmin", "isAuthoritiesAdmin", "isImportsAdmin"] as const) {
      const other = { ...world.outsider, [flag]: true };
      expect(await captureAccess(db, on(), other)).toEqual({ manager: false, reviewer: false });
      expect(await status(loadVolumes(other, on()))).toBe(403);
    }
  });

  it("does not count a reviewer assignment on another tenant", async () => {
    const db = drizzle(env.DB);
    // otherAdmin reviews a volume of the second tenant only.
    const asVisitor = makeUserContext({ id: world.otherAdmin.id, tenantId: SECOND_TEST_TENANT_ID });
    expect(await captureAccess(db, on(), asVisitor)).toEqual({ manager: false, reviewer: false });
  });

  it("opens Volumes to admins and stewards only", async () => {
    expect(await status(loadVolumes(world.admin, on()))).toBe(200);
    expect(await status(loadVolumes(world.steward, on()))).toBe(200);
    expect(await status(loadVolumes(world.reviewer, on()))).toBe(403);
    expect(await status(loadVolumes(world.outsider, on()))).toBe(403);
  });

  it("opens the queue to managers and assigned reviewers, and 403s anyone else", async () => {
    expect(await status(loadQueue(world.admin, on()))).toBe(200);
    expect(await status(loadQueue(world.steward, on()))).toBe(200);
    expect(await status(loadQueue(world.reviewer, on()))).toBe(200);
    expect(await status(loadQueue(world.outsider, on()))).toBe(403);
  });

  it("shows a manager every waiting volume, with candidates to assign", async () => {
    const data = await loadQueue(world.admin, on());
    expect(data.volumes.map((v) => v.referenceCode).sort()).toEqual(
      [world.mine.referenceCode, world.open.referenceCode].sort(),
    );
    expect(data.canAssign).toBe(true);
    expect(data.candidates).not.toBeNull();
    expect(data.federationName).toBe("Neogranadina");
  });

  it("shows an assigned reviewer only their own volumes, and nothing to assign with", async () => {
    const data = await loadQueue(world.reviewer, on());
    expect(data.volumes.map((v) => v.referenceCode)).toEqual([world.mine.referenceCode]);
    expect(data.volumes[0].reviewer).toEqual({ id: world.reviewer.id, name: "Test Reviewer" });
    expect(data.canAssign).toBe(false);
    expect(data.candidates).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tenant scoping
// ---------------------------------------------------------------------------

describe("tenant scoping", () => {
  it("lists only the request tenant's volumes on Volumes", async () => {
    const data = await loadVolumes(world.admin, on());
    const refs = data.volumes.map((v) => v.referenceCode);
    expect(refs.sort()).toEqual([world.mine.referenceCode, world.open.referenceCode].sort());
    expect(refs).not.toContain(world.foreign.referenceCode);
  });

  it("lists only the second tenant's volume on its own screens, with its own decisions and reviewer", async () => {
    const tenant = on({ id: SECOND_TEST_TENANT_ID, slug: "second-tenant", federationId: SECOND_TEST_FEDERATION_ID });
    const rows = await loadCaptureVolumes(drizzle(env.DB), SECOND_TEST_TENANT_ID, T0);
    expect(rows.map((r) => r.referenceCode)).toEqual([world.foreign.referenceCode]);
    expect(rows[0]).toMatchObject({ state: "retakes_requested", rejected: 1, reviewer: { id: world.otherAdmin.id } });
    const data = await loadVolumes(world.otherAdmin, tenant);
    expect(data.volumes.map((v) => v.referenceCode)).toEqual([world.foreign.referenceCode]);
  });

  it("does not show a reviewer of another tenant in the default tenant's queue", async () => {
    const data = await loadQueue(world.admin, on());
    for (const v of data.volumes) expect(v.reviewer?.id).not.toBe(world.otherAdmin.id);
  });

  it("ignores a delivery of another tenant that shares a reference code", async () => {
    await delivery(SECOND_TEST_TENANT_ID, world.mine.referenceCode, { state: "refused", receivedAt: T0 + DAY });
    const rows = await loadCaptureVolumes(drizzle(env.DB), DEFAULT_TEST_TENANT_ID, T0);
    const mine = rows.find((r) => r.referenceCode === world.mine.referenceCode);
    expect(mine?.state).toBe("in_capture_qc");
  });
});

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

describe("state mapping", () => {
  const expected: Record<CaptureLinkState, string | null> = {
    received: "received",
    registered: "received",
    preparing_review: "preparing_review",
    in_capture_qc: "in_capture_qc",
    retakes_requested: "retakes_requested",
    approved: "approved",
    queued: "processing",
    running: "processing",
    review_pending: "processing",
    published: "published",
    refused: "refused",
    superseded: "superseded",
    failed: "failed",
    unknown: null,
  };

  it("maps every link state", () => {
    for (const s of CAPTURE_LINK_STATES) expect(screenStateOf(s)).toBe(expected[s]);
  });

  it("names the next step only where the app can take it", () => {
    const base = { registered: true, hasReviewer: false, hasEarlierDelivery: false };
    expect(nextStepOf({ ...base, linkState: "registered" })).toBe("assign_reviewer");
    expect(nextStepOf({ ...base, linkState: "in_capture_qc", hasReviewer: true })).toBe("continue_review");
    expect(nextStepOf({ ...base, linkState: "received", registered: false })).toBeNull();
    expect(nextStepOf({ ...base, linkState: "preparing_review" })).toBe("review_opens");
    expect(nextStepOf({ ...base, linkState: "preparing_review", hasEarlierDelivery: true })).toBe("retakes_came_back");
    expect(nextStepOf({ ...base, linkState: "retakes_requested" })).toBe("waiting_for_scanner");
    expect(nextStepOf({ ...base, linkState: "approved" })).toBeNull();
    expect(nextStepOf({ ...base, linkState: "queued" })).toBeNull();
    expect(nextStepOf({ ...base, linkState: "running" })).toBe("running");
    expect(nextStepOf({ ...base, linkState: "published" })).toBe("open_volume");
    expect(nextStepOf({ ...base, linkState: "refused" })).toBeNull();
  });

  it("applies the review run: failed, no bucket, and the steps to prepare or retry", () => {
    expect(screenStateFor("registered", "failed")).toBe("review_failed");
    expect(screenStateFor("in_capture_qc", "failed")).toBe("review_failed");
    expect(screenStateFor("retakes_requested", "failed")).toBe("retakes_requested");
    expect(screenStateFor("registered", "not_applicable")).toBe("in_capture_qc");
    expect(screenStateFor("registered", "none")).toBe("received");
    expect(screenStateFor("preparing_review", "open")).toBe("preparing_review");
    const base = { registered: true, hasReviewer: false, hasEarlierDelivery: false };
    expect(nextStepOf({ ...base, linkState: "registered", review: "none" })).toBe("prepare_review");
    expect(nextStepOf({ ...base, linkState: "registered", review: "failed" })).toBe("retry_review");
    expect(nextStepOf({ ...base, linkState: "in_capture_qc", review: "failed" })).toBe("retry_review");
    expect(nextStepOf({ ...base, linkState: "registered", review: "not_applicable" })).toBe("assign_reviewer");
    expect(nextStepOf({ ...base, linkState: "registered", review: "none", registered: false })).toBeNull();
  });

  it("queues registered, preparing and in-review volumes only", () => {
    expect(CAPTURE_LINK_STATES.filter(inQueue)).toEqual(["registered", "preparing_review", "in_capture_qc"]);
  });

  it("gives every refusal rule a sentence in both locales, and an unknown rule the generic one", () => {
    for (const rule of REFUSAL_RULES) {
      const key = refusalKey(rule).replace("problem.", "") as keyof typeof enCapture.problem;
      expect(enCapture.problem[key], rule).toBeTruthy();
      expect(esCapture.problem[key], rule).toBeTruthy();
    }
    expect(refusalKey("object-missing")).toBe("problem.object_missing");
    expect(refusalKey("roles")).toBe("problem.roles");
    expect(refusalKey("problems-truncated")).toBe("problem.unknown");
    expect(refusalKey("")).toBe("problem.unknown");
  });

  it("counts whole days waited", () => {
    expect(waitingDays(T0, T0 + DAY - 1)).toBe(0);
    expect(waitingDays(T0, T0 + 3 * DAY)).toBe(3);
    expect(waitingDays(T0 + DAY, T0)).toBe(0);
  });

  it("derives each row's state, counts and next step from what the tenant holds", async () => {
    const db = drizzle(env.DB);
    const more = await seedReceivedVolumes({ count: 3, codePrefix: "co-more" });
    const [approved, retaken, published] = more.volumes;
    const a = await delivery(DEFAULT_TEST_TENANT_ID, approved.referenceCode, { volumeId: approved.id, openings: 2 });
    await decisionSet(DEFAULT_TEST_TENANT_ID, a, approved.id, { openings: 2, approved: 2, rejected: 0 });
    // A retake: the earlier handover superseded, the new one undecided.
    const newer = await delivery(DEFAULT_TEST_TENANT_ID, retaken.referenceCode, { volumeId: retaken.id, receivedAt: T0 + 10 });
    await delivery(DEFAULT_TEST_TENANT_ID, retaken.referenceCode, {
      volumeId: retaken.id,
      state: "superseded",
      supersededBy: newer,
      receivedAt: T0,
    });
    await delivery(DEFAULT_TEST_TENANT_ID, published.referenceCode, { volumeId: published.id });
    await env.DB.prepare("UPDATE pipeline_volumes SET state = 'published' WHERE id = ?").bind(published.id).run();
    // A handover refused before any volume was registered.
    await delivery(DEFAULT_TEST_TENANT_ID, "co-test-refused", { state: "refused", rule: "description", problems: "No description matches" });

    const rows = new Map((await loadCaptureVolumes(db, DEFAULT_TEST_TENANT_ID, T0)).map((r) => [r.referenceCode, r]));
    expect(rows.get(world.mine.referenceCode)).toMatchObject({
      state: "in_capture_qc",
      nextStep: "continue_review",
      approved: 2,
      rejected: 0,
      decided: 2,
      openings: 4,
    });
    // The test federation has no review-tiles bucket, so a registered,
    // undecided volume is in capture QC at once.
    expect(rows.get(world.open.referenceCode)).toMatchObject({ state: "in_capture_qc", nextStep: "assign_reviewer", reviewer: null });
    expect(rows.get(approved.referenceCode)).toMatchObject({ state: "approved", nextStep: null });
    expect(rows.get(retaken.referenceCode)).toMatchObject({ state: "in_capture_qc", hasEarlierDelivery: true, decided: 0 });
    expect(rows.get(published.referenceCode)).toMatchObject({
      state: "published",
      nextStep: "open_volume",
      descriptionId: published.descriptionId,
    });
    expect(rows.get("co-test-refused")).toMatchObject({
      state: "refused",
      volumeId: null,
      title: null,
      problem: { kind: "refusal", rule: "description" },
    });
  });

  it("shows a volume whose handover has a rejected record and every opening approved as waiting for retakes", async () => {
    const db = drizzle(env.DB);
    const more = await seedReceivedVolumes({ count: 2, codePrefix: "co-held" });
    const [held, noOpenings] = more.volumes;
    const d = await delivery(DEFAULT_TEST_TENANT_ID, held.referenceCode, { volumeId: held.id, openings: 2, rejectedRecords: 1 });
    await decisionSet(DEFAULT_TEST_TENANT_ID, d, held.id, { openings: 2, approved: 2, rejected: 0 });
    await delivery(DEFAULT_TEST_TENANT_ID, noOpenings.referenceCode, { volumeId: noOpenings.id, openings: 0, rejectedRecords: 2 });

    const rows = new Map((await loadCaptureVolumes(db, DEFAULT_TEST_TENANT_ID, T0)).map((r) => [r.referenceCode, r]));
    for (const v of [held, noOpenings]) {
      expect(rows.get(v.referenceCode)).toMatchObject({
        linkState: "retakes_requested",
        state: "retakes_requested",
        nextStep: "waiting_for_scanner",
      });
    }
    expect(rows.get(held.referenceCode)).toMatchObject({ approved: 2, rejected: 0, decided: 2 });
    expect(await loadVolumeScreenStates(db, DEFAULT_TEST_TENANT_ID, [held.id, noOpenings.id], T0)).toEqual(
      new Map([
        [held.id, "retakes_requested"],
        [noOpenings.id, "retakes_requested"],
      ]),
    );
    const queued = (await loadQueue(world.admin, on())).volumes.map((v: { referenceCode: string }) => v.referenceCode);
    expect(queued).not.toContain(held.referenceCode);
    expect(queued).not.toContain(noOpenings.referenceCode);
  });
});

// ---------------------------------------------------------------------------
// Assigning through the reviewer route
// ---------------------------------------------------------------------------

describe("assignment", () => {
  function post(user: User, volumeId: string, reviewerId: string | null) {
    return reviewerAction({
      request: new Request(`http://neogranadina.fisqua.test/admin/capture/volumes/${volumeId}/reviewer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewerId }),
      }),
      context: context(user, on()),
      params: { volumeId },
    } as any);
  }

  it("assigns a reviewer from the queue, who then sees the volume", async () => {
    const res = (await post(world.admin, world.open.id, world.outsider.id)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reviewerId: world.outsider.id });
    const queue = await loadQueue(world.outsider, on());
    expect(queue.volumes.map((v) => v.referenceCode)).toEqual([world.open.referenceCode]);
    const managed = await loadQueue(world.admin, on());
    expect(managed.volumes.find((v) => v.referenceCode === world.open.referenceCode)?.reviewer?.name).toBe("Test Outsider");
  });

  it("lets a steward reassign, and refuses an assigned reviewer who is not a manager", async () => {
    expect(((await post(world.steward, world.mine.id, world.steward.id)) as Response).status).toBe(200);
    expect(await status(post(world.reviewer, world.open.id, world.reviewer.id))).toBe(403);
  });

  it("refuses a volume of another tenant", async () => {
    const res = (await post(world.admin, world.foreign.id, world.outsider.id)) as Response;
    expect(res.status).toBe(404);
  });

  it("offers the tenant's users as archive staff and the federation's other members under its name", async () => {
    const candidates = await loadReviewerCandidates(drizzle(env.DB), on());
    const staff = candidates.staff.map((c) => c.id);
    expect(staff).toEqual(expect.arrayContaining([world.admin.id, world.reviewer.id, world.outsider.id]));
    expect(staff).not.toContain(world.steward.id);
    expect(staff).not.toContain(world.otherAdmin.id);
    expect(candidates.federationName).toBe("Neogranadina");
    expect(candidates.federation.map((c) => c.id)).toEqual([world.steward.id]);
    // Every candidate is one the route accepts.
    for (const c of [...candidates.staff, ...candidates.federation]) {
      expect(((await post(world.admin, world.open.id, c.id)) as Response).status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// The actions with the capability off
// ---------------------------------------------------------------------------

describe("the capture QC actions with the capability off", () => {
  const off = () => makeTenantContext({ digitizationEnabled: false });

  it("404s an admin's assignment and assigns no one", async () => {
    const request = new Request(`http://neogranadina.fisqua.test/admin/capture/volumes/${world.open.id}/reviewer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewerId: world.outsider.id }),
    });
    const res = reviewerAction({ request, context: context(world.admin, off()), params: { volumeId: world.open.id } } as any);
    expect(await status(res)).toBe(404);
    const rows = await env.DB.prepare("SELECT reviewer_id FROM capture_qc_reviewers WHERE pipeline_volume_id = ?")
      .bind(world.open.id)
      .all();
    expect(rows.results).toEqual([]);
  });

  it("404s an admin's decisions and records none", async () => {
    const before = await env.DB.prepare("SELECT decisions_id FROM capture_qc_sets WHERE delivery_id = ?")
      .bind(world.mineDelivery)
      .first<{ decisions_id: string }>();
    const request = new Request(`http://neogranadina.fisqua.test/admin/capture/volumes/${world.mine.id}/decisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifestId: world.mineDelivery, records: [{ captuaRecordId: 1, decision: "approved" }] }),
    });
    const res = decisionsAction({ request, context: context(world.admin, off()), params: { volumeId: world.mine.id } } as any);
    expect(await status(res)).toBe(404);
    const after = await env.DB.prepare("SELECT decisions_id FROM capture_qc_sets WHERE delivery_id = ?")
      .bind(world.mineDelivery)
      .first<{ decisions_id: string }>();
    expect(after).toEqual(before);
    const decided = await env.DB.prepare("SELECT COUNT(*) AS n FROM capture_qc_decisions WHERE delivery_id = ?")
      .bind(world.mineDelivery)
      .first<{ n: number }>();
    expect(decided!.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A failed run's error
// ---------------------------------------------------------------------------

/** Puts a closed run on the volume whose job aborted with `error`. */
async function failedRun(volume: ReceivedVolume, error: string | null) {
  const declaration = await declarationOf(volume);
  const runId = crypto.randomUUID();
  await insertRow("pipeline_runs", {
    id: runId,
    tenant_id: DEFAULT_TEST_TENANT_ID,
    user_id: world.admin.id,
    kind: "volume_run",
    purpose: "sample",
    status: "error",
    runner_image: "ghcr.io/example/runner@sha256:" + "0".repeat(64),
    script_version: "v1.0.0",
    arch: "x64",
    max_review_frac: 1,
    spec_key: `${DEFAULT_TEST_TENANT_ID}/pipeline-runs/${runId}/spec.json`,
    spec_sha256: "0".repeat(64),
    spec_url_expires_at: T0 + 1_000_000,
    chunk_count: 1,
    volume_count: 1,
    callback_token_hash: "0".repeat(64),
    token_expires_at: T0 + 3_600_000,
    token_revoked_at: T0 + 10,
    completed_at: T0 + 10,
    created_at: T0,
    dispatched_at: T0,
  });
  await insertRow("pipeline_run_chunks", {
    id: crypto.randomUUID(),
    run_id: runId,
    tenant_id: DEFAULT_TEST_TENANT_ID,
    chunk_index: 0,
    status: "dispatched",
    created_at: T0,
  });
  await insertRow("pipeline_run_volumes", {
    id: crypto.randomUUID(),
    run_id: runId,
    tenant_id: DEFAULT_TEST_TENANT_ID,
    pipeline_volume_id: volume.id,
    declaration_id: declaration.id,
    job_index: 0,
    chunk_index: 0,
    reference_code: volume.referenceCode,
    tile_root: "x",
    expected_count: 1,
    resolved_recipe: "{}",
    status: "aborted",
    error,
    flags_truncated: 0,
    reported_at: T0 + 5,
    created_at: T0,
  });
}

/** The recipe declaration `seedReceivedVolumes` made for the volume's scope. */
async function declarationOf(volume: ReceivedVolume): Promise<{ id: string }> {
  const row = await env.DB.prepare(
    "SELECT d.id AS id FROM pipeline_recipe_declarations d JOIN pipeline_volumes v ON v.recipe_scope_description_id = d.scope_description_id WHERE v.id = ?",
  )
    .bind(volume.id)
    .first<{ id: string }>();
  return { id: row!.id };
}

describe("a failed run's error", () => {
  const STORED = JSON.stringify({ class: "internal", message: "Cannot download preview: HTTP 403" });

  it("shows the message the run recorded, not the status call's sentence", async () => {
    await failedRun(world.open, STORED);
    const rows = await loadCaptureVolumes(drizzle(env.DB), DEFAULT_TEST_TENANT_ID, T0 + 100);
    expect(rows.find((r) => r.referenceCode === world.open.referenceCode)).toMatchObject({
      state: "failed",
      problem: { kind: "pipeline", message: "Cannot download preview: HTTP 403" },
    });
  });

  it("falls back to the status call's sentence when the run recorded no message", async () => {
    await failedRun(world.open, JSON.stringify({ class: "timeout" }));
    const rows = await loadCaptureVolumes(drizzle(env.DB), DEFAULT_TEST_TENANT_ID, T0 + 100);
    expect(rows.find((r) => r.referenceCode === world.open.referenceCode)?.problem).toEqual({
      kind: "pipeline",
      message: "The media pipeline stopped the volume (timeout)",
    });
  });

  it("leaves the status call's answer as it was: the class only", async () => {
    await failedRun(world.open, STORED);
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
    const request = new Request(
      `https://neogranadina.fisqua.test/api/capture/v1/volumes/status?refs=${encodeURIComponent(world.open.referenceCode)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const res = await handleVolumeStatus(
      { db: drizzle(env.DB), env: {}, fetch: () => Promise.reject(new Error("no fetch")), now: () => T0 + 100, newId: () => crypto.randomUUID() },
      request,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { volumes: Array<{ state: string; problems: Array<Record<string, unknown>> }> };
    expect(body.volumes[0].state).toBe("failed");
    expect(body.volumes[0].problems).toEqual([
      { rule: "pipeline", message: "The media pipeline stopped the volume (internal)", errorClass: "internal" },
    ]);
    expect(JSON.stringify(body)).not.toContain("HTTP 403");
  });
});

// @version v0.8.0
