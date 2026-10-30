/**
 * Tests — the capture QC viewer's loader
 *
 * This suite seeds pipeline volumes, capture deliveries, their images,
 * decisions, rotations and reviewers directly, in the default tenant and
 * in a second one, and reads them through the viewer route's loader and
 * `loadCaptureQcVolume`. It pins:
 *
 *   - each refusal: a bare 404 with the digitization capability off,
 *     even for an admin; a bare 404 for a volume that is not the
 *     tenant's, or that has no current delivery; a bare 403 for a user
 *     who is neither a manager nor the volume's assigned reviewer,
 *     including the reviewer of another volume;
 *   - who gets through: the tenant's admins, a steward of its
 *     federation, and the volume's reviewer;
 *   - the shape of the data: the volume, its title and its reviewer; the
 *     current delivery's id, which handover it is and how many of its
 *     records are rejected; the openings in
 *     manifest sequence order, leaving out records that are not
 *     openings, each with its images left, right then single, its
 *     decision and its rotations by capture id and role; the set's
 *     counts; `canDecide` and `locked`; and `tiles`;
 *   - `tiles` from the current delivery's review runs: `none` without a
 *     review-tiles bucket or without a review run, `preparing` while a
 *     run can still report, `failed` for an aborted or halted run, a
 *     run closed before it reported, or a run that only an earlier
 *     delivery had, and `ready` once a run reported `review_ready`;
 *   - the decisions, rotations and revision read in one batch, so a
 *     write landing after the reads never pairs older decisions with a
 *     newer revision;
 *   - `locked` once a run has taken the volume, with `canDecide` off;
 *   - each decision's `sentAt`, the unit's first fetch of a set at the
 *     decision's revision or later, and null before one;
 *   - `tiles` `purged` once a purge of the delivery's prefix is
 *     recorded, finished or failed, even over tiles reported ready;
 *   - `earlier` only on an opening the latest earlier handover itself
 *     rejected (never an older handover's rejection that the latest
 *     left undecided) and whose images the current handover changed,
 *     and only while that handover's tiles are ready and not purged.
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
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { insertRow, seedReceivedVolumes, type ReceivedVolume } from "../helpers/media-pipeline";
import { tenantContext, userContext, type Tenant, type User } from "../../app/context";
import { loadCaptureQcVolume } from "../../app/lib/capture/viewer.server";
import { loader as viewerLoader } from "../../app/routes/_auth.admin.capture.qc.$volumeId";
import type { CaptureQcVolume } from "../../app/lib/capture/viewer";

const T0 = 1_800_000_000_000;
const HEX = "a".repeat(64);
let seq = 0;

async function delivery(
  tenantId: string,
  ref: string,
  volumeId: string,
  opts: { state?: "registered" | "superseded"; records?: unknown[]; receivedAt?: number } = {},
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
    pipeline_volume_id: volumeId,
    body_sha256: HEX,
    state,
    problems: "[]",
    answer_status: 200,
    answer_body: "{}",
    records: JSON.stringify(opts.records ?? []),
    openings: (opts.records ?? []).length,
    rejected_records: (opts.records ?? []).filter((r) => (r as { status?: string }).status === "rejected").length,
    received_at: opts.receivedAt ?? T0,
    superseded_by: state === "superseded" ? "later" : null,
    superseded_at: state === "superseded" ? T0 + 1 : null,
    seq,
    write_id: null,
  });
  return id;
}

async function image(tenantId: string, deliveryId: string, record: number, captureId: string, role: string, pageKey: string, status = "in_review") {
  await insertRow("capture_images", {
    id: crypto.randomUUID(),
    tenant_id: tenantId,
    delivery_id: deliveryId,
    captua_record_id: record,
    capture_id: captureId,
    pair_id: null,
    role,
    page_key: pageKey,
    capture_key: `captures/${pageKey}.cr2`,
    capture_sha256: HEX,
    capture_bytes: null,
    preview_key: null,
    preview_sha256: null,
    preview_bytes: null,
    record_status: status,
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

function load(user: User, volumeId: string, tenant: Tenant = on()) {
  return viewerLoader({
    request: new Request(`http://neogranadina.fisqua.test/admin/capture/qc/${volumeId}`),
    context: context(user, tenant),
    params: { volumeId },
  } as any) as Promise<CaptureQcVolume>;
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (thrown) {
    if (thrown instanceof Response) {
      expect(thrown.body).toBeNull();
      return thrown.status;
    }
    throw thrown;
  }
}

interface World {
  admin: User;
  steward: User;
  reviewer: User;
  otherReviewer: User;
  outsider: User;
  mine: ReceivedVolume;
  bare: ReceivedVolume;
  foreign: ReceivedVolume;
  current: string;
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
  const otherReviewer = await person({ name: "Other Reviewer" });
  const outsider = await person({ name: "Test Outsider" });
  const steward = await person({ tenantId: SECOND_TEST_TENANT_ID, name: "Test Steward" });
  await insertRow("federation_memberships", {
    id: crypto.randomUUID(),
    user_id: steward.id,
    federation_id: DEFAULT_TEST_FEDERATION_ID,
    role: "steward",
    created_at: T0,
  });

  const local = await seedReceivedVolumes({ count: 3, codePrefix: "co-view" });
  const [mine, bare, other] = local.volumes;
  const remote = await seedReceivedVolumes({ tenantId: SECOND_TEST_TENANT_ID, count: 1, codePrefix: "co-far" });
  const [foreign] = remote.volumes;
  const t = DEFAULT_TEST_TENANT_ID;

  // An earlier handover, then the current one: record 103 is captured
  // only and 105 rejected (neither an opening), and the manifest lists the
  // openings out of order.
  await delivery(t, mine.referenceCode, mine.id, { state: "superseded", records: [{ captuaRecordId: 101, sequence: 1, status: "in_review" }] });
  const current = await delivery(t, mine.referenceCode, mine.id, {
    receivedAt: T0 + 5,
    records: [
      { captuaRecordId: 102, sequence: 2, status: "approved" },
      { captuaRecordId: 101, sequence: 1, status: "in_review" },
      { captuaRecordId: 103, sequence: 3, status: "captured" },
      { captuaRecordId: 104, sequence: 4, status: "in_review" },
      { captuaRecordId: 105, sequence: 5, status: "rejected" },
    ],
  });
  await image(t, current, 101, "cap-a", "right", "co-view-img_0002_c2");
  await image(t, current, 101, "cap-a", "left", "co-view-img_0001_c1");
  await image(t, current, 102, "cap-b", "single", "co-view-img_0003_c1", "approved");
  await image(t, current, 103, "cap-c", "single", "co-view-img_0004_c1", "captured");
  await image(t, current, 104, "cap-d", "left", "co-view-img_0005_c1");
  await image(t, current, 104, "cap-d", "right", "co-view-img_0006_c2");
  await insertRow("capture_qc_sets", {
    tenant_id: t,
    delivery_id: current,
    pipeline_volume_id: mine.id,
    decisions_id: crypto.randomUUID(),
    decided_at: T0,
    revision: 1,
    opening_count: 3,
    decided_count: 2,
    approved_count: 1,
    rejected_count: 1,
    notes_bytes: 4,
    state: "retakes_requested",
    state_entered_at: T0,
    write_id: crypto.randomUUID(),
  });
  for (const d of [
    { r: 101, decision: "approved", reason: null, side: null, note: null },
    { r: 104, decision: "rejected", reason: "other", side: "right", note: "Torn" },
  ]) {
    await insertRow("capture_qc_decisions", {
      tenant_id: t,
      delivery_id: current,
      captua_record_id: d.r,
      decision: d.decision,
      reason: d.reason,
      side: d.side,
      note: d.note,
      decided_by: reviewer.id,
      decided_by_name: "Test Reviewer",
      decided_at: T0 + 10,
      set_revision: 1,
    });
  }
  await insertRow("capture_qc_rotations", {
    tenant_id: t,
    delivery_id: current,
    captua_record_id: 101,
    capture_id: "cap-a",
    role: "right",
    quarter_turns: 1,
  });
  await insertRow("capture_qc_reviewers", {
    tenant_id: t,
    pipeline_volume_id: mine.id,
    reviewer_id: reviewer.id,
    assigned_by: admin.id,
    assigned_at: T0,
  });

  // Another volume, with a delivery and its own reviewer.
  await delivery(t, other.referenceCode, other.id, { records: [{ captuaRecordId: 1, sequence: 1, status: "in_review" }] });
  await insertRow("capture_qc_reviewers", {
    tenant_id: t,
    pipeline_volume_id: other.id,
    reviewer_id: otherReviewer.id,
    assigned_by: admin.id,
    assigned_at: T0,
  });

  // The second tenant's volume, with a delivery.
  await delivery(SECOND_TEST_TENANT_ID, foreign.referenceCode, foreign.id, {
    records: [{ captuaRecordId: 1, sequence: 1, status: "in_review" }],
  });

  world = { admin, steward, reviewer, otherReviewer, outsider, mine, bare, foreign, current };
});

describe("who may open the viewer", () => {
  it("answers a bare 404 with the digitization capability off, even for an admin", async () => {
    expect(await status(load(world.admin, world.mine.id, makeTenantContext({ digitizationEnabled: false })))).toBe(404);
  });

  it("answers a bare 404 for a volume not the tenant's, unknown, or without a current delivery", async () => {
    expect(await status(load(world.admin, world.foreign.id))).toBe(404);
    expect(await status(load(world.admin, "no-such-volume"))).toBe(404);
    expect(await status(load(world.admin, world.bare.id))).toBe(404);
  });

  it("answers a bare 403 for anyone neither a manager nor the volume's reviewer", async () => {
    expect(await status(load(world.outsider, world.mine.id))).toBe(403);
    expect(await status(load(world.otherReviewer, world.mine.id))).toBe(403);
  });

  it("lets in the tenant's admins, the federation's stewards and the volume's reviewer", async () => {
    expect(await status(load(world.admin, world.mine.id))).toBe(200);
    expect(await status(load(world.steward, world.mine.id))).toBe(200);
    expect(await status(load(world.reviewer, world.mine.id))).toBe(200);
  });
});

describe("what the viewer reads", () => {
  it("answers the volume, its delivery and its openings in sequence order", async () => {
    const data = await load(world.reviewer, world.mine.id);
    expect(data.volume).toEqual({ id: world.mine.id, referenceCode: world.mine.referenceCode, title: "Test unit" });
    expect(data.reviewer).toEqual({ id: world.reviewer.id, name: "Test Reviewer" });
    expect(data.delivery).toEqual({ manifestId: world.current, handover: 2, receivedAt: T0 + 5, rejectedRecords: 1 });
    expect(data.openings.map((o) => [o.captuaRecordId, o.sequence, o.scannerStatus])).toEqual([
      [101, 1, "in_review"],
      [102, 2, "approved"],
      [104, 4, "in_review"],
    ]);
    expect(data.openings[0].images).toEqual([
      { captureId: "cap-a", role: "left", pageKey: "co-view-img_0001_c1" },
      { captureId: "cap-a", role: "right", pageKey: "co-view-img_0002_c2" },
    ]);
    expect(data.openings[1].images).toEqual([{ captureId: "cap-b", role: "single", pageKey: "co-view-img_0003_c1" }]);
  });

  it("answers each opening's decision and rotations, and the set's counts", async () => {
    const data = await load(world.admin, world.mine.id);
    const [first, second, third] = data.openings;
    expect(first.decision).toEqual({
      decision: "approved",
      reason: null,
      side: null,
      note: null,
      decidedBy: "Test Reviewer",
      decidedAt: T0 + 10,
      sentAt: null,
    });
    expect(first.rotations).toEqual([{ captureId: "cap-a", role: "right", quarterTurns: 1 }]);
    expect(second.decision).toBeNull();
    expect(second.rotations).toEqual([]);
    expect(third.decision).toMatchObject({ decision: "rejected", reason: "other", side: "right", note: "Torn" });
    expect(data.counts).toEqual({ openings: 3, images: 5, approved: 1, rejected: 1, decided: 2 });
    expect(data.revision).toBe(1);
    expect(data.canDecide).toBe(true);
    expect(data.locked).toBe(false);
    expect(data.tiles).toEqual({ state: "none" });
  });

  it("reads decisions, rotations and revision from one snapshot", async () => {
    const db = drizzle(env.DB);
    let batches = 0;
    // Another reviewer's write lands right after the loader's reads.
    const racing = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: unknown) => {
            batches += 1;
            const results = await (target as any).batch(statements);
            await env.DB.prepare("UPDATE capture_qc_decisions SET decision = 'rejected', reason = 'blur' WHERE captua_record_id = 101").run();
            await env.DB.prepare("UPDATE capture_qc_sets SET revision = 2 WHERE delivery_id = ?").bind(world.current).run();
            return results;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const before = await loadCaptureQcVolume(racing as any, on(), world.admin, world.mine.id, Date.now());
    expect(batches).toBe(1);
    expect(before.revision).toBe(1);
    expect(before.openings[0].decision?.decision).toBe("approved");
    const after = await loadCaptureQcVolume(db, on(), world.admin, world.mine.id, Date.now());
    expect(after.revision).toBe(2);
    expect(after.openings[0].decision).toMatchObject({ decision: "rejected", reason: "blur" });
  });

  it("dates a decision from the unit's first fetch of a set carrying it", async () => {
    const t = DEFAULT_TEST_TENANT_ID;
    // 104 was rewritten at revision 2, after the unit's fetch of revision 1.
    await env.DB.prepare("UPDATE capture_qc_decisions SET set_revision = 2 WHERE captua_record_id = 104").run();
    await insertRow("capture_qc_fetches", {
      tenant_id: t,
      delivery_id: world.current,
      decisions_id: crypto.randomUUID(),
      set_revision: 1,
      first_fetched_at: T0 + 20,
      last_fetched_at: T0 + 30,
    });
    let data = await load(world.admin, world.mine.id);
    expect(data.openings[0].decision?.sentAt).toBe(T0 + 20);
    expect(data.openings[2].decision?.sentAt).toBeNull();
    await insertRow("capture_qc_fetches", {
      tenant_id: t,
      delivery_id: world.current,
      decisions_id: crypto.randomUUID(),
      set_revision: 2,
      first_fetched_at: T0 + 40,
      last_fetched_at: T0 + 40,
    });
    data = await load(world.admin, world.mine.id);
    expect(data.openings[2].decision?.sentAt).toBe(T0 + 40);
  });

  it("is locked once a run has taken the volume", async () => {
    await env.DB.prepare("UPDATE pipeline_volumes SET state = 'prepared' WHERE id = ?").bind(world.mine.id).run();
    const data = await loadCaptureQcVolume(drizzle(env.DB), on(), world.admin, world.mine.id, Date.now());
    expect(data.locked).toBe(true);
    expect(data.canDecide).toBe(false);
  });
});

describe("the review images", () => {
  const NOW = Date.now();

  async function setReviewBucket(bucket: string | null): Promise<void> {
    await env.DB.prepare("UPDATE federations SET pipeline_review_tiles_bucket = ? WHERE id = ?")
      .bind(bucket, DEFAULT_TEST_FEDERATION_ID)
      .run();
  }

  /** A review run of `deliveryId`, as `startReviewRun` writes one, with the row's status and the run's. */
  async function reviewRun(
    deliveryId: string,
    opts: { status: string; runStatus?: string; tokenRevokedAt?: number | null; chunkStatus?: string; purge?: "purged" | "failed" },
  ): Promise<void> {
    const runId = crypto.randomUUID();
    await insertRow("pipeline_runs", {
      id: runId,
      tenant_id: DEFAULT_TEST_TENANT_ID,
      federation_id: DEFAULT_TEST_FEDERATION_ID,
      user_id: world.admin.id,
      kind: "review_run",
      purpose: null,
      regenerates_run_id: null,
      status: opts.runStatus ?? "pending",
      runner_image: "ghcr.io/test/runner@sha256:" + HEX,
      script_version: "v1.1.0",
      arch: "x64",
      max_review_frac: 1,
      spec_key: `specs/${runId}.json`,
      spec_sha256: HEX,
      spec_url_expires_at: NOW + 1_800_000,
      chunk_count: 1,
      volume_count: 1,
      volumes_reported: 0,
      callback_token_hash: HEX,
      token_expires_at: NOW + 3_600_000,
      token_revoked_at: opts.tokenRevokedAt ?? null,
      created_at: NOW - 1000,
    });
    await insertRow("pipeline_run_chunks", {
      id: crypto.randomUUID(),
      run_id: runId,
      tenant_id: DEFAULT_TEST_TENANT_ID,
      chunk_index: 0,
      status: opts.chunkStatus ?? "dispatched",
      created_at: NOW - 1000,
    });
    await insertRow("capture_review_runs", {
      tenant_id: DEFAULT_TEST_TENANT_ID,
      run_id: runId,
      delivery_id: deliveryId,
      pipeline_volume_id: world.mine.id,
      review_prefix: `neogranadina/${deliveryId}/`,
      status: opts.status,
      reported_at: opts.status === "dispatched" ? null : NOW - 500,
      created_at: NOW - 1000,
      purge_status: opts.purge ?? null,
      purged_at: opts.purge === "purged" ? NOW - 100 : null,
    });
  }

  const tiles = async () =>
    (await loadCaptureQcVolume(drizzle(env.DB), on(), world.admin, world.mine.id, NOW)).tiles;

  beforeEach(async () => {
    await setReviewBucket("test-review-tiles");
  });

  it("is none when the federation has no review-tiles bucket, even with tiles ready", async () => {
    await reviewRun(world.current, { status: "review_ready", runStatus: "completed", tokenRevokedAt: NOW - 500 });
    await setReviewBucket(null);
    expect(await tiles()).toEqual({ state: "none" });
  });

  it("is none when the delivery has no review run", async () => {
    expect(await tiles()).toEqual({ state: "none" });
  });

  it("is preparing while the run can still report", async () => {
    await reviewRun(world.current, { status: "dispatched" });
    expect(await tiles()).toEqual({ state: "preparing" });
  });

  it("is failed for an aborted or halted run, or one closed before it reported", async () => {
    await reviewRun(world.current, { status: "aborted", runStatus: "error", tokenRevokedAt: NOW - 500, chunkStatus: "not_sent" });
    expect(await tiles()).toEqual({ state: "failed" });
    await cleanReviewRuns();
    await reviewRun(world.current, { status: "halted", runStatus: "error", tokenRevokedAt: NOW - 500 });
    expect(await tiles()).toEqual({ state: "failed" });
    await cleanReviewRuns();
    await reviewRun(world.current, { status: "dispatched", runStatus: "error", tokenRevokedAt: NOW - 500 });
    expect(await tiles()).toEqual({ state: "failed" });
  });

  it("is ready once a run reported review_ready", async () => {
    await reviewRun(world.current, { status: "review_ready", runStatus: "completed", tokenRevokedAt: NOW - 500 });
    expect(await tiles()).toEqual({ state: "ready" });
  });

  it("is purged once a purge has started, finished or failed, over tiles ready", async () => {
    await reviewRun(world.current, { status: "review_ready", runStatus: "completed", tokenRevokedAt: NOW - 500, purge: "purged" });
    expect(await tiles()).toEqual({ state: "purged" });
    await cleanReviewRuns();
    await reviewRun(world.current, { status: "review_ready", runStatus: "completed", tokenRevokedAt: NOW - 500, purge: "failed" });
    expect(await tiles()).toEqual({ state: "purged" });
  });

  it("reads only the current delivery's runs", async () => {
    const earlier = (await env.DB.prepare(
      "SELECT id FROM capture_deliveries WHERE pipeline_volume_id = ? AND state = 'superseded'",
    )
      .bind(world.mine.id)
      .first<{ id: string }>())!.id;
    await reviewRun(earlier, { status: "review_ready", runStatus: "completed", tokenRevokedAt: NOW - 500 });
    expect(await tiles()).toEqual({ state: "none" });
  });

  describe("an earlier handover's rejected images", () => {
    const t = DEFAULT_TEST_TENANT_ID;
    let older: string;
    let latest: string;

    async function setWith(deliveryId: string, rows: Array<{ r: number; decision: string; reason?: string; side?: string }>) {
      await insertRow("capture_qc_sets", {
        tenant_id: t,
        delivery_id: deliveryId,
        pipeline_volume_id: world.mine.id,
        decisions_id: crypto.randomUUID(),
        decided_at: T0,
        revision: 1,
        opening_count: 3,
        decided_count: rows.length,
        approved_count: rows.filter((x) => x.decision === "approved").length,
        rejected_count: rows.filter((x) => x.decision === "rejected").length,
        notes_bytes: 0,
        state: "in_capture_qc",
        state_entered_at: T0,
        write_id: crypto.randomUUID(),
      });
      for (const row of rows) {
        await insertRow("capture_qc_decisions", {
          tenant_id: t,
          delivery_id: deliveryId,
          captua_record_id: row.r,
          decision: row.decision,
          reason: row.reason ?? null,
          side: row.side ?? null,
          note: null,
          decided_by: world.reviewer.id,
          decided_by_name: "Test Reviewer",
          decided_at: T0 + 1,
          set_revision: 1,
        });
      }
    }

    beforeEach(async () => {
      older = (await env.DB.prepare("SELECT id FROM capture_deliveries WHERE pipeline_volume_id = ? AND state = 'superseded'")
        .bind(world.mine.id)
        .first<{ id: string }>())!.id;
      // The handover between the older one and the current one.
      latest = await delivery(t, world.mine.referenceCode, world.mine.id, { state: "superseded" });
      const cur = (await env.DB.prepare("SELECT seq FROM capture_deliveries WHERE id = ?").bind(world.current).first<{ seq: number }>())!.seq;
      await env.DB.prepare("UPDATE capture_deliveries SET seq = ? WHERE id = ?").bind(cur + 100000, world.current).run();
      await env.DB.prepare("UPDATE capture_deliveries SET seq = ? WHERE id = ?").bind(cur, latest).run();

      // The older handover rejected 102; the latest approved it, rejected
      // 101 with other images, and rejected 104 with the same ones.
      await setWith(older, [{ r: 102, decision: "rejected", reason: "blur" }]);
      await setWith(latest, [
        { r: 102, decision: "approved" },
        { r: 101, decision: "rejected", reason: "glare", side: "left" },
        { r: 104, decision: "rejected", reason: "shadow", side: "both" },
      ]);
      await image(t, older, 102, "cap-old", "single", "co-view-old_0003_c1");
      await image(t, latest, 102, "cap-old2", "single", "co-view-old2_0003_c1");
      await image(t, latest, 101, "cap-x", "right", "co-view-x_0002_c2");
      await image(t, latest, 101, "cap-x", "left", "co-view-x_0001_c1");
      await image(t, latest, 104, "cap-d", "left", "co-view-img_0005_c1");
      await image(t, latest, 104, "cap-d", "right", "co-view-img_0006_c2");
      await reviewRun(older, { status: "review_ready", runStatus: "completed", tokenRevokedAt: NOW - 500 });
    });

    const earlierOf = async () =>
      (await loadCaptureQcVolume(drizzle(env.DB), on(), world.admin, world.mine.id, NOW)).openings.map((o) => [
        o.captuaRecordId,
        o.earlier,
      ]);

    it("is given only for an opening the latest earlier handover rejected and this one brought back with new images", async () => {
      await reviewRun(latest, { status: "review_ready", runStatus: "completed", tokenRevokedAt: NOW - 500 });
      expect(await earlierOf()).toEqual([
        [
          101,
          {
            deliveryId: latest,
            handover: 2,
            images: [
              { captureId: "cap-x", role: "left", pageKey: "co-view-x_0001_c1" },
              { captureId: "cap-x", role: "right", pageKey: "co-view-x_0002_c2" },
            ],
            decision: {
              decision: "rejected",
              reason: "glare",
              side: "left",
              note: null,
              decidedBy: "Test Reviewer",
              decidedAt: T0 + 1,
            },
          },
        ],
        // The older handover's rejection of 102 gave way to the latest's approval.
        [102, null],
        // 104 came back with the same images: its rejection stands, with nothing to compare.
        [104, null],
      ]);
    });

    it("is not given for an older handover's rejection that the latest one left undecided or cleared", async () => {
      await reviewRun(latest, { status: "review_ready", runStatus: "completed", tokenRevokedAt: NOW - 500 });
      // The older handover rejected 101 too, with images of its own.
      await env.DB.prepare(
        `INSERT INTO capture_qc_decisions (tenant_id, delivery_id, captua_record_id, decision, reason, decided_by, decided_by_name,
           decided_at, set_revision) VALUES (?, ?, 101, 'rejected', 'blur', ?, 'Test Reviewer', ?, 1)`,
      )
        .bind(t, older, world.reviewer.id, T0)
        .run();
      await image(t, older, 101, "cap-y", "left", "co-view-y_0001_c1");
      await image(t, older, 101, "cap-y", "right", "co-view-y_0002_c2");
      // The latest handover's own rejection of 101 is gone.
      await env.DB.prepare("DELETE FROM capture_qc_decisions WHERE delivery_id = ? AND captua_record_id = 101").bind(latest).run();
      expect((await earlierOf())[0]).toEqual([101, null]);
    });

    it("is not given while that handover's tiles are not ready, or once their purge has started", async () => {
      expect((await earlierOf())[0][1]).toBeNull();
      await reviewRun(latest, { status: "dispatched" });
      expect((await earlierOf())[0][1]).toBeNull();
      await reviewRun(latest, { status: "review_ready", runStatus: "completed", tokenRevokedAt: NOW - 500, purge: "failed" });
      expect((await earlierOf())[0][1]).toBeNull();
    });
  });

  async function cleanReviewRuns(): Promise<void> {
    await env.DB.prepare("DELETE FROM capture_review_runs").run();
    await env.DB.prepare("DELETE FROM pipeline_run_chunks").run();
    await env.DB.prepare("DELETE FROM pipeline_runs").run();
  }
});

// @version v0.8.0
