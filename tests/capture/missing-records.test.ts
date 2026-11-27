/**
 * Tests — capture manifests at contract version 1.9: openings and pages not captured
 *
 * This suite pins what Fisqua does with the placeholders version 1.9 of
 * the Captua exchange contract adds to a capture manifest (§10.1–10.3):
 * records `missing` one side or both, open or closed, and the
 * `requestId` any record may carry. It drives the checks directly
 * (`checkCaptureManifest`, `planPages`, `qcStatusOf`,
 * `sequenceReordered`) and the whole delivery over the link
 * (`handleManifestDelivery`), with an in-memory S3 server standing in
 * for the masters bucket, then records decisions
 * (`recordDecisionsAction`) and reads what the unit, dispatch, the
 * viewer and the queue read. It pins:
 *
 *   - a 1.9 manifest with each kind of record accepted, its placeholder
 *     fields kept in the delivery's records, and, at versions 1.1 to
 *     1.8, status `missing` refused and the other fields ignored, so a
 *     manifest at those versions is read as it always has been;
 *   - the refusals: `missing` without a side, a side or a closing
 *     reason on a record not missing, a note without a reason, an
 *     unknown reason, and a side the images contradict (`missing-side`);
 *   - which records are pages and openings: a closed placeholder with
 *     an image is an opening and its image a page in sequence position;
 *     an open placeholder, or a closed one with no image, is neither;
 *   - a delivery with no page: refused as `no-pages`, each with a
 *     message of its own, when every record is a placeholder closed with
 *     no image, or when it has open placeholders and is the volume's
 *     first; accepted as a replacement when it has an open placeholder,
 *     superseding the approved delivery and holding the volume, with no
 *     decision set, a state that is never `approved`, its pages and
 *     expected count kept at a new revision, and nothing for the viewer,
 *     Retakes or the queue to divide or decide;
 *   - a rejection answered with a placeholder closed with no image
 *     dropping off Retakes and the queue;
 *   - carry-over through a placeholder: nothing to an approved spread
 *     handed back open, the approval of a closed placeholder handed back
 *     unchanged and renumbered, nothing to a placeholder captured into
 *     a two-image record;
 *   - a closed note left out, never stored empty, when the records'
 *     budget leaves no room for notes;
 *   - the hold and the state: an open placeholder holds the volume as a
 *     record rejected on the unit does, `in_capture_qc` while openings
 *     are undecided and `retakes_requested` once nothing is left to
 *     approve; closing it in a newer delivery releases the hold;
 *   - decisions: an open placeholder is refused as no opening, a closed
 *     one with an image decided as any opening;
 *   - two records sharing a `sequence`, whatever their status and at
 *     every version, refused as `sequence`;
 *   - a newer delivery whose records keep the registered one's ids in a
 *     different relative order: registered, with `sequence-reordered`
 *     among its problems, and approvals carried by record id and
 *     identical images; a placeholder inserted without moving anything
 *     notes nothing; a file delivery notes it when it is given the
 *     registered delivery's records (`previous`);
 *   - the viewer's data carrying every placeholder in sequence order;
 *   - the queue's spot-recapture list ordered by sequence.
 *
 * Every value here is a test value: no real tenant, bucket, key or person.
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
import {
  handleManifestDelivery,
  handleVolumeStatus,
  packRecords,
  unpackJson,
  type CaptureLinkDeps,
} from "../../app/lib/capture/link.server";
import { readVolumeRetakes } from "../../app/lib/capture/retakes.server";
import { recordDecisionsAction } from "../../app/lib/capture/qc.server";
import { readCaptureQcPending } from "../../app/lib/capture/hold.server";
import { loadCaptureQcVolume } from "../../app/lib/capture/viewer.server";
import { readRetakeVolumes } from "../../app/lib/capture/queue.server";
import { mintScannerToken } from "../../app/lib/capture/token";
import { fileRegistrationSql } from "../../app/lib/capture/file-route.server";
import {
  checkCaptureManifest,
  openingCount,
  openingIdsOf,
  planPages,
  qcStatusOf,
  rejectedRecordCount,
  sequenceReordered,
  type CaptureVolume,
  type PlannedVolume,
} from "../../app/lib/capture/manifest";
import type { Tenant, User } from "../../app/context";

const HOST = "https://neogranadina.fisqua.test";
const SLUG = "neogranadina";
const ROOT = `${SLUG}/`;
const T0 = 1_800_000_000_000;
const CODE = "co-test-001";

const CLOSED_ONLY_MESSAGE =
  "every record of the volume is a placeholder closed with no image, so no record has an image to make a page";
const FIRST_OPEN_MESSAGE =
  "no record has an image to make a page, and Fisqua holds no earlier delivery of the volume for its open placeholders to hold";

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

function rec(id: number, sequence: number, status: string, images: Json[], extra: Json = {}): Json {
  return { captuaRecordId: id, sequence, status, rejectionNote: status === "rejected" ? "blurred" : null, images, ...extra };
}

const spread = (stem: string, n: number) => [image(stem, n, 0, "left"), image(stem, n, 1, "right")];

/**
 * A 1.9 volume with every kind of record: an approved spread (sequence 1),
 * an open placeholder missing both pages (2), one missing its left page
 * with the right image (3), a closed placeholder with no image (4), a
 * closed one missing its right page with the left image (5), and an
 * opening captured into a request's placeholder (6).
 */
function volume19(stem = CODE): Json {
  return {
    externalId: stem,
    captuaCollectionId: 7,
    stem,
    title: `Test volume ${stem}`,
    records: [
      rec(21, 1, "approved", spread(stem, 1)),
      rec(22, 2, "missing", [], { missingSide: "both", requestId: "req-1" }),
      rec(23, 3, "missing", [image(stem, 3, 1, "right")], { missingSide: "left" }),
      rec(24, 4, "missing", [], { missingSide: "both", closedReason: "foliation_skip", closedNote: "Folio 12 skipped" }),
      rec(25, 5, "missing", [image(stem, 5, 0, "left")], { missingSide: "right", closedReason: "leaf_missing_from_volume" }),
      rec(26, 6, "in_review", spread(stem, 6), { requestId: "req-2" }),
    ],
  };
}

function manifest(volumes: Json[], version = "1.9"): Json {
  return {
    contract: "fisqua-captua-exchange",
    version,
    kind: "capture-manifest",
    id: crypto.randomUUID(),
    generatedAt: "2026-10-31T12:00:00Z",
    generatedBy: { system: "captua", instance: "rig-1", systemVersion: "0.1.0" },
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

describe("reading a 1.9 manifest", () => {
  it("accepts every kind of record and keeps its placeholder fields", () => {
    const v = checked(manifest([volume19()]));
    expect(v.records.map((r) => [r.captuaRecordId, r.status, r.missingSide ?? null, r.closedReason ?? null, r.requestId ?? null])).toEqual([
      [21, "approved", null, null, null],
      [22, "missing", "both", null, "req-1"],
      [23, "missing", "left", null, null],
      [24, "missing", "both", "foliation_skip", null],
      [25, "missing", "right", "leaf_missing_from_volume", null],
      [26, "in_review", null, null, "req-2"],
    ]);
    expect(v.records[3].closedNote).toBe("Folio 12 skipped");
    expect(planPages(v, SLUG, ROOT).problems).toEqual([]);
  });

  it("reads each placeholder as the status capture QC and the hold treat it as", () => {
    const v = checked(manifest([volume19()]));
    expect(v.records.map((r) => qcStatusOf(r))).toEqual(["approved", "rejected", "rejected", "excluded", "in_review", "in_review"]);
    expect(openingCount(v)).toBe(3);
    expect(openingIdsOf(v)).toEqual([21, 25, 26]);
    expect(rejectedRecordCount(v)).toBe(2);
  });

  it("makes pages of the openings' images only, in sequence order, a closed placeholder's image among them", () => {
    const v = checked(manifest([volume19()]));
    expect(planPages(v, SLUG, ROOT).pages.map((p) => [p.seq, p.pageKey])).toEqual([
      [1, `${CODE}-img_0001_c0`],
      [2, `${CODE}-img_0001_c1`],
      [3, `${CODE}-img_0005_c0`],
      [4, `${CODE}-img_0006_c0`],
      [5, `${CODE}-img_0006_c1`],
    ]);
  });

  it("refuses status missing before 1.9 and ignores the other placeholder fields there", () => {
    const early = volume19();
    expect(problemsOf(manifest([early], "1.8")).map((p) => [p.rule, p.path])).toEqual([
      ["shape", "volumes.0.records.1.status"],
      ["shape", "volumes.0.records.2.status"],
      ["shape", "volumes.0.records.3.status"],
      ["shape", "volumes.0.records.4.status"],
    ]);
    const plain = {
      ...volume19(),
      records: [
        rec(21, 1, "approved", spread(CODE, 1), { requestId: "req-1", missingSide: "both", closedReason: "other" }),
      ],
    };
    const v = checked(manifest([plain], "1.6"));
    expect(v.records[0]).toEqual({ captuaRecordId: 21, sequence: 1, status: "approved", rejectionNote: null, images: v.records[0].images });
  });

  it("refuses a placeholder field where 1.9 does not allow it", () => {
    const cases: Array<[Json, string]> = [
      [rec(30, 9, "missing", []), "volumes.0.records.6.missingSide"],
      [rec(30, 9, "missing", [], { missingSide: "top" }), "volumes.0.records.6.missingSide"],
      [rec(30, 9, "approved", spread(CODE, 9), { missingSide: "left" }), "volumes.0.records.6.missingSide"],
      [rec(30, 9, "approved", spread(CODE, 9), { closedReason: "other" }), "volumes.0.records.6.closedReason"],
      [rec(30, 9, "missing", [], { missingSide: "both", closedReason: "lost" }), "volumes.0.records.6.closedReason"],
      [rec(30, 9, "missing", [], { missingSide: "both", closedNote: "a note" }), "volumes.0.records.6.closedNote"],
      [rec(30, 9, "approved", spread(CODE, 9), { requestId: "" }), "volumes.0.records.6.requestId"],
    ];
    for (const [record, path] of cases) {
      const v = volume19();
      v.records.push(record);
      expect(problemsOf(manifest([v])).map((p) => [p.rule, p.path])).toEqual([["shape", path]]);
    }
  });

  it("refuses a missing side the images contradict", () => {
    const cases: Json[] = [
      rec(30, 9, "missing", [image(CODE, 9, 0, "single")], { missingSide: "both" }),
      rec(30, 9, "missing", [image(CODE, 9, 0, "left")], { missingSide: "left" }),
      rec(30, 9, "missing", spread(CODE, 9), { missingSide: "right" }),
      rec(30, 9, "missing", [], { missingSide: "right", closedReason: "other" }),
      rec(30, 9, "missing", [image(CODE, 9, 0, "single")], { missingSide: "left", closedReason: "other" }),
    ];
    for (const record of cases) {
      const v = volume19();
      v.records.push(record);
      expect(planPages(checked(manifest([v])), SLUG, ROOT).issues.map((i) => [i.rule, i.captuaRecordId])).toEqual([
        ["missing-side", 30],
      ]);
    }
  });

  it("refuses two records sharing a sequence, whatever their status, at every version", () => {
    const v = volume19();
    v.records[3].sequence = 1; // a closed placeholder on the approved spread's sequence
    expect(planPages(checked(manifest([v])), SLUG, ROOT).issues.map((i) => [i.rule, i.sequence])).toEqual([["sequence", 1]]);

    const early = {
      ...volume19(),
      records: [
        rec(21, 1, "approved", spread(CODE, 1)),
        rec(22, 2, "excluded", [image(CODE, 2, 0, "single")]),
        rec(23, 2, "rejected", spread(CODE, 3)),
      ],
    };
    expect(planPages(checked(manifest([early], "1.6")), SLUG, ROOT).issues.map((i) => [i.rule, i.sequence])).toEqual([
      ["sequence", 2],
    ]);
  });

  it("refuses a volume of placeholders closed with no image as no-pages, saying so", () => {
    const v = {
      ...volume19(),
      records: [
        rec(22, 1, "missing", [], { missingSide: "both", closedReason: "foliation_skip" }),
        rec(24, 3, "missing", [], { missingSide: "both", closedReason: "captured_elsewhere" }),
      ],
    };
    expect(planPages(checked(manifest([v])), SLUG, ROOT).issues).toEqual([
      {
        rule: "no-pages",
        message: CLOSED_ONLY_MESSAGE,
        stem: CODE,
      },
    ]);
    // An open placeholder among them gives no page and refuses nothing here:
    // whether the volume can take such a delivery is decided by whether
    // Fisqua already holds it (`planVolumes`).
    v.records.push(rec(23, 2, "missing", [image(CODE, 3, 1, "right")], { missingSide: "left" }));
    const plan = planPages(checked(manifest([v])), SLUG, ROOT);
    expect([plan.pages, plan.issues]).toEqual([[], []]);
    // Anything else with no page keeps the message it has always had.
    const excluded = { ...volume19(), records: [rec(21, 1, "excluded", [image(CODE, 1, 0, "single")])] };
    expect(planPages(checked(manifest([excluded])), SLUG, ROOT).issues.map((i) => i.message)).toEqual([
      "no in_review or approved record has an image",
    ]);
  });

  it("tells a reordering from an insertion", () => {
    const before = [
      { captuaRecordId: 1, sequence: 1 },
      { captuaRecordId: 2, sequence: 2 },
      { captuaRecordId: 3, sequence: 3 },
    ];
    // A placeholder inserted after record 1, the rest renumbered: no record moved.
    expect(
      sequenceReordered(before, [
        { captuaRecordId: 1, sequence: 1 },
        { captuaRecordId: 9, sequence: 2 },
        { captuaRecordId: 2, sequence: 3 },
        { captuaRecordId: 3, sequence: 4 },
      ]),
    ).toBe(false);
    // Record 3 moved before record 2.
    expect(
      sequenceReordered(before, [
        { captuaRecordId: 1, sequence: 1 },
        { captuaRecordId: 3, sequence: 2 },
        { captuaRecordId: 2, sequence: 3 },
      ]),
    ).toBe(true);
    // A record left out and the others in order.
    expect(sequenceReordered(before, [{ captuaRecordId: 3, sequence: 7 }, { captuaRecordId: 1, sequence: 1 }])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The link
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

async function answer(res: Response): Promise<{ status: number; json: Json | null }> {
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function send(m: Json) {
  upload(world.s3, m);
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

describe("delivering a 1.9 manifest", () => {
  it("registers the openings' pages and keeps every placeholder in the delivery's records", async () => {
    const m = manifest([volume19()]);
    const { volumeId } = await deliver(m);
    const pages = await sqlRows("SELECT seq, page_key FROM pipeline_volume_pages WHERE pipeline_volume_id = ? ORDER BY seq", volumeId);
    expect(pages.map((p) => p.page_key)).toEqual([
      `${CODE}-img_0001_c0`,
      `${CODE}-img_0001_c1`,
      `${CODE}-img_0005_c0`,
      `${CODE}-img_0006_c0`,
      `${CODE}-img_0006_c1`,
    ]);
    const [d] = await sqlRows("SELECT openings, rejected_records, records FROM capture_deliveries WHERE id = ?", m.id);
    expect([d.openings, d.rejected_records]).toEqual([3, 2]);
    expect(JSON.parse(await unpackJson(d.records))).toEqual([
      { captuaRecordId: 21, sequence: 1, status: "approved", rejectionNote: null },
      { captuaRecordId: 22, sequence: 2, status: "missing", rejectionNote: null, missingSide: "both", requestId: "req-1" },
      { captuaRecordId: 23, sequence: 3, status: "missing", rejectionNote: null, missingSide: "left" },
      {
        captuaRecordId: 24,
        sequence: 4,
        status: "missing",
        rejectionNote: null,
        missingSide: "both",
        closedReason: "foliation_skip",
        closedNote: "Folio 12 skipped",
      },
      { captuaRecordId: 25, sequence: 5, status: "missing", rejectionNote: null, missingSide: "right", closedReason: "leaf_missing_from_volume" },
      { captuaRecordId: 26, sequence: 6, status: "in_review", rejectionNote: null, requestId: "req-2" },
    ]);
    // Each image is kept under the status its record is read as.
    expect(
      await sqlRows("SELECT captua_record_id AS id, role, record_status AS s FROM capture_images WHERE delivery_id = ? ORDER BY id, role", m.id),
    ).toEqual([
      { id: 21, role: "left", s: "approved" },
      { id: 21, role: "right", s: "approved" },
      { id: 23, role: "right", s: "rejected" },
      { id: 25, role: "left", s: "in_review" },
      { id: 26, role: "left", s: "in_review" },
      { id: 26, role: "right", s: "in_review" },
    ]);
  });

  it("keeps a pre-1.9 delivery's records exactly as before", async () => {
    const m = manifest(
      [{ ...volume19(), records: [rec(21, 1, "approved", spread(CODE, 1)), rec(26, 2, "in_review", spread(CODE, 6))] }],
      "1.6",
    );
    await deliver(m);
    const [d] = await sqlRows("SELECT records FROM capture_deliveries WHERE id = ?", m.id);
    expect(await unpackJson(d.records)).toBe(
      JSON.stringify([
        { captuaRecordId: 21, sequence: 1, status: "approved", rejectionNote: null },
        { captuaRecordId: 26, sequence: 2, status: "in_review", rejectionNote: null },
      ]),
    );
  });

  it("refuses a manifest whose records share a sequence", async () => {
    const v = volume19();
    v.records[1].sequence = 6;
    const res = await send(manifest([v]));
    expect(res.status).toBe(422);
    expect(res.json!.problems.map((p: Json) => [p.rule, p.sequence])).toEqual([["sequence", 6]]);
  });

  it("refuses a missing side the images contradict", async () => {
    const v = volume19();
    v.records[2].missingSide = "right";
    const res = await send(manifest([v]));
    expect(res.status).toBe(422);
    expect(res.json!.problems.map((p: Json) => [p.rule, p.captuaRecordId])).toEqual([["missing-side", 23]]);
  });

  it("answers a volume of placeholders closed with no image 422 no-pages, with its own message", async () => {
    const v = { ...volume19(), records: [rec(22, 1, "missing", [], { missingSide: "both", closedReason: "other" })] };
    expect(await send(manifest([v]))).toEqual({
      status: 422,
      json: { problems: [{ rule: "no-pages", message: CLOSED_ONLY_MESSAGE, stem: CODE }] },
    });
  });

  it("answers a first delivery with open placeholders and no page 422 no-pages: there is nothing for it to hold", async () => {
    const v = { ...volume19(), records: [rec(21, 1, "missing", [image(CODE, 1, 1, "right")], { missingSide: "left" })] };
    expect(await send(manifest([v]))).toEqual({
      status: 422,
      json: { problems: [{ rule: "no-pages", message: FIRST_OPEN_MESSAGE, stem: CODE }] },
    });
    expect(await sqlRows("SELECT id FROM pipeline_volumes")).toEqual([]);
  });
});

describe("a replacement with no page", () => {
  /** One spread, record 21, captured. */
  const captured = (): Json => ({ ...volume19(), records: [rec(21, 1, "in_review", spread(CODE, 1))] });
  /** The same opening handed back missing its left page, as a missing_page decision leaves it. */
  const reopened = (): Json => ({
    ...volume19(),
    records: [rec(21, 1, "missing", [image(CODE, 1, 1, "right")], { missingSide: "left" })],
  });

  it("is registered, supersedes the approved delivery and holds the volume, never approved", async () => {
    const first = manifest([captured()]);
    const { volumeId } = await deliver(first);
    expect((await decide(volumeId, [{ captuaRecordId: 21, decision: "approved" }])).status).toBe(200);
    expect(await held(volumeId)).toBe(false);
    expect((await status(CODE)).state).toBe("approved");
    const [before] = await sqlRows("SELECT expected_count, pages_revision FROM pipeline_volumes WHERE id = ?", volumeId);

    world.clock.now = T0 + 1000;
    const second = manifest([reopened()]);
    const res = await send(second);
    expect(res).toEqual({ status: 200, json: { state: "registered", manifestId: second.id, volumeId } });
    expect(await sqlRows("SELECT id, state, superseded_by, openings, rejected_records FROM capture_deliveries ORDER BY seq")).toEqual([
      { id: first.id, state: "superseded", superseded_by: second.id, openings: 1, rejected_records: 0 },
      { id: second.id, state: "registered", superseded_by: null, openings: 0, rejected_records: 1 },
    ]);
    // No decision set: there is no opening to decide, so none can read as approved.
    expect(await sqlRows("SELECT delivery_id FROM capture_qc_sets WHERE delivery_id = ?", second.id)).toEqual([]);
    expect(await held(volumeId)).toBe(true);
    const s = await status(CODE);
    expect(s.state).toBe("retakes_requested");
    expect(s.enteredAt).toBe(new Date(T0 + 1000).toISOString());
    // The volume keeps its pages and expected count, at a new revision, so a claim read before is refused.
    const [after] = await sqlRows("SELECT expected_count, pages_revision FROM pipeline_volumes WHERE id = ?", volumeId);
    expect(after).toEqual({ expected_count: before.expected_count, pages_revision: before.pages_revision + 1 });

    // What the viewer, Retakes and the queue read of it.
    const data = await loadCaptureQcVolume(drizzle(env.DB), world.tenant, world.admin, volumeId, T0 + 1000);
    expect(data.openings).toEqual([]);
    expect(data.counts).toEqual({ openings: 0, images: 0, approved: 0, rejected: 0, excluded: 0, decided: 0 });
    expect(data.delivery.rejectedRecords).toBe(1);
    expect(data.placeholders?.map((p) => [p.captuaRecordId, p.missingSide, p.opening])).toEqual([[21, "left", false]]);
    expect(await readVolumeRetakes(drizzle(env.DB), DEFAULT_TEST_TENANT_ID, second.id, volumeId, T0 + 1000)).toEqual([]);
    expect(await readRetakeVolumes(drizzle(env.DB), DEFAULT_TEST_TENANT_ID)).toEqual([]);
    // No decision can be recorded on it.
    expect((await decide(volumeId, [{ captuaRecordId: 21, decision: "approved" }])).status).toBe(422);

    // The page captured again: the volume is reviewed again and released only when approved.
    world.clock.now = T0 + 2000;
    const recaptured = captured();
    recaptured.records[0].images[0] = image(CODE, 2, 0, "left");
    await deliver(manifest([recaptured]));
    expect(await held(volumeId)).toBe(true);
    expect((await decide(volumeId, [{ captuaRecordId: 21, decision: "approved" }])).status).toBe(200);
    expect(await held(volumeId)).toBe(false);
  });
});

describe("a rejection answered with a placeholder closed with no image", () => {
  it("drops off the Retakes screen and the queue", async () => {
    const v = { ...volume19(), records: [rec(21, 1, "in_review", spread(CODE, 1)), rec(22, 2, "in_review", spread(CODE, 2))] };
    const { volumeId } = await deliver(manifest([v]));
    await decide(volumeId, [
      { captuaRecordId: 21, decision: "approved" },
      { captuaRecordId: 22, decision: "rejected", reason: "blur", side: "both" },
    ]);
    expect((await readRetakeVolumes(drizzle(env.DB), DEFAULT_TEST_TENANT_ID)).map((r) => r.retakes.map((x) => x.captuaRecordId))).toEqual([[22]]);

    // The unit finds the leaf is not in the volume and closes record 22 without capturing it.
    world.clock.now = T0 + 1000;
    const closed = { ...v, records: [v.records[0], rec(22, 2, "missing", [], { missingSide: "both", closedReason: "leaf_missing_from_volume" })] };
    const m = manifest([closed]);
    await deliver(m);
    expect(await readVolumeRetakes(drizzle(env.DB), DEFAULT_TEST_TENANT_ID, m.id, volumeId, T0 + 1000)).toEqual([]);
    expect(await readRetakeVolumes(drizzle(env.DB), DEFAULT_TEST_TENANT_ID)).toEqual([]);
    expect(await held(volumeId)).toBe(false);
  });
});

describe("carry-over through a placeholder", () => {
  const carried = (deliveryId: string) =>
    sqlRows("SELECT captua_record_id AS id, decision FROM capture_qc_decisions WHERE delivery_id = ? ORDER BY id", deliveryId);

  it("carries nothing to an approved spread handed back as an open placeholder, and holds the volume", async () => {
    const v = { ...volume19(), records: [rec(21, 1, "in_review", spread(CODE, 1)), rec(26, 2, "in_review", spread(CODE, 6))] };
    const { volumeId } = await deliver(manifest([v]));
    await decide(volumeId, [
      { captuaRecordId: 21, decision: "approved" },
      { captuaRecordId: 26, decision: "approved" },
    ]);
    world.clock.now = T0 + 1000;
    const reopened = { ...v, records: [rec(21, 1, "missing", [image(CODE, 1, 1, "right")], { missingSide: "left" }), v.records[1]] };
    const m = manifest([reopened]);
    await deliver(m);
    expect(await carried(m.id)).toEqual([{ id: 26, decision: "approved" }]);
    expect(await held(volumeId)).toBe(true);
    expect((await status(CODE)).state).toBe("retakes_requested");
  });

  it("carries the approval of a closed placeholder handed back unchanged and renumbered", async () => {
    const closed = rec(25, 2, "missing", [image(CODE, 5, 0, "left")], { missingSide: "right", closedReason: "leaf_missing_from_volume" });
    const v = { ...volume19(), records: [rec(21, 1, "in_review", spread(CODE, 1)), closed] };
    const { volumeId } = await deliver(manifest([v]));
    await decide(volumeId, [
      { captuaRecordId: 21, decision: "approved" },
      { captuaRecordId: 25, decision: "approved" },
    ]);
    world.clock.now = T0 + 1000;
    // A requested placeholder is inserted before it, and it moves to sequence 3.
    const renumbered = {
      ...v,
      records: [v.records[0], rec(29, 2, "missing", [], { missingSide: "both", requestId: "req-1" }), { ...closed, sequence: 3 }],
    };
    const m = manifest([renumbered]);
    await deliver(m);
    expect(await carried(m.id)).toEqual([
      { id: 21, decision: "approved" },
      { id: 25, decision: "approved" },
    ]);
    expect((await status(CODE)).problems).toEqual([]);
  });

  it("carries nothing to a placeholder captured into a two-image record", async () => {
    const closed = rec(25, 2, "missing", [image(CODE, 5, 0, "left")], { missingSide: "right", closedReason: "other" });
    const v = { ...volume19(), records: [rec(21, 1, "in_review", spread(CODE, 1)), closed] };
    const { volumeId } = await deliver(manifest([v]));
    await decide(volumeId, [
      { captuaRecordId: 21, decision: "approved" },
      { captuaRecordId: 25, decision: "approved" },
    ]);
    world.clock.now = T0 + 1000;
    const filled = { ...v, records: [v.records[0], rec(25, 2, "in_review", [image(CODE, 5, 0, "left"), image(CODE, 7, 1, "right")])] };
    const m = manifest([filled]);
    await deliver(m);
    expect(await carried(m.id)).toEqual([{ id: 21, decision: "approved" }]);
    expect(await held(volumeId)).toBe(true);
    expect((await status(CODE)).state).toBe("in_capture_qc");
  });
});

describe("a closed note past the records' budget", () => {
  it("is left out, not stored empty, when the notes no longer fit", async () => {
    // Characters that do not repeat, so the note cannot shrink below its length.
    const note = Array.from({ length: 3000 }, (_, i) => String.fromCharCode(0x4e00 + ((i * 7919) % 20000))).join("");
    const base = { ...volume19(), records: [rec(24, 1, "missing", [], { missingSide: "both", closedReason: "other" })] };
    const without = await packRecords(checked(manifest([base])));
    const noted = { ...base, records: [{ ...base.records[0], closedNote: note }] };
    const packed = await packRecords(checked(manifest([noted])), without.length);
    expect(packed).toBe(without);
    expect(JSON.parse(await unpackJson(packed))[0]).not.toHaveProperty("closedNote");
  });
});

describe("the hold and the state", () => {
  it("holds the volume while a placeholder is open, and releases it when the placeholder is closed", async () => {
    const { volumeId } = await deliver(manifest([volume19()]));
    expect(await held(volumeId)).toBe(true);

    // An open placeholder, and a closed one with no image, is no opening: it cannot be decided.
    for (const id of [22, 23, 24]) {
      expect(await decide(volumeId, [{ captuaRecordId: id, decision: "approved" }])).toEqual({
        status: 422,
        json: { error: "unknown_records", captua_record_ids: [id] },
      });
    }

    // While openings are undecided the volume is in capture QC, as with a record rejected on the unit.
    world.clock.now = T0 + 1000;
    expect(
      (
        await decide(volumeId, [
          { captuaRecordId: 21, decision: "approved" },
          { captuaRecordId: 26, decision: "approved" },
        ])
      ).status,
    ).toBe(200);
    expect((await status(CODE)).state).toBe("in_capture_qc");
    // The closed placeholder's image needs approval like any opening.
    world.clock.now = T0 + 2000;
    expect((await decide(volumeId, [{ captuaRecordId: 25, decision: "approved" }])).status).toBe(200);
    const [set] = await sqlRows("SELECT opening_count, approved_count, rejected_count, excluded_count, state FROM capture_qc_sets");
    expect(set).toEqual({ opening_count: 3, approved_count: 3, rejected_count: 0, excluded_count: 0, state: "approved" });
    // Every opening approved, the open placeholders still owed.
    const s = await status(CODE);
    expect(s.state).toBe("retakes_requested");
    expect(s.enteredAt).toBe(new Date(T0 + 2000).toISOString());
    expect(await held(volumeId)).toBe(true);

    // The operator closes both open placeholders without capturing.
    world.clock.now = T0 + 3000;
    const closed = volume19();
    closed.records[1].closedReason = "captured_elsewhere";
    closed.records[2].closedReason = "other";
    closed.records[2].closedNote = "Damaged leaf";
    await deliver(manifest([closed]));
    // 23 is now an opening with an image nobody approved.
    expect(await held(volumeId)).toBe(true);
    expect((await status(CODE)).state).toBe("in_capture_qc");
    expect((await decide(volumeId, [{ captuaRecordId: 23, decision: "approved" }])).status).toBe(200);
    expect(await held(volumeId)).toBe(false);
    expect((await status(CODE)).state).toBe("approved");
  });

  it("releases the hold when an open placeholder with no image is closed and every opening was approved", async () => {
    const v = volume19();
    v.records = v.records.filter((r: Json) => [21, 22, 26].includes(r.captuaRecordId));
    const { volumeId } = await deliver(manifest([v]));
    await decide(volumeId, [
      { captuaRecordId: 21, decision: "approved" },
      { captuaRecordId: 26, decision: "approved" },
    ]);
    expect(await held(volumeId)).toBe(true);
    expect((await status(CODE)).state).toBe("retakes_requested");

    world.clock.now = T0 + 1000;
    v.records[1].closedReason = "foliation_skip";
    await deliver(manifest([v]));
    // The approvals came over and nothing holds the volume.
    expect(await held(volumeId)).toBe(false);
    expect((await status(CODE)).state).toBe("approved");
  });
});

describe("a reordered delivery", () => {
  function plain(): Json {
    return {
      ...volume19(),
      records: [
        rec(21, 1, "in_review", spread(CODE, 1)),
        rec(22, 2, "in_review", spread(CODE, 2)),
        rec(23, 3, "in_review", spread(CODE, 3)),
      ],
    };
  }

  it("is registered with sequence-reordered among its problems, its approvals carried by record id", async () => {
    const { volumeId } = await deliver(manifest([plain()]));
    await decide(volumeId, [
      { captuaRecordId: 21, decision: "approved" },
      { captuaRecordId: 22, decision: "approved" },
      { captuaRecordId: 23, decision: "approved" },
    ]);
    world.clock.now = T0 + 1000;
    const moved = plain();
    moved.records[1].sequence = 3;
    moved.records[2].sequence = 2;
    const m = manifest([moved]);
    await deliver(m);
    const s = await status(CODE);
    expect(s.problems.map((p: Json) => p.rule)).toEqual(["sequence-reordered"]);
    expect(s.state).toBe("approved");
    expect(
      await sqlRows("SELECT captua_record_id AS id, decision FROM capture_qc_decisions WHERE delivery_id = ? ORDER BY id", m.id),
    ).toEqual([
      { id: 21, decision: "approved" },
      { id: 22, decision: "approved" },
      { id: 23, decision: "approved" },
    ]);
    const pages = await sqlRows("SELECT page_key FROM pipeline_volume_pages WHERE pipeline_volume_id = ? ORDER BY seq", volumeId);
    expect(pages.map((p) => p.page_key)).toEqual([
      `${CODE}-img_0001_c0`,
      `${CODE}-img_0001_c1`,
      `${CODE}-img_0003_c0`,
      `${CODE}-img_0003_c1`,
      `${CODE}-img_0002_c0`,
      `${CODE}-img_0002_c1`,
    ]);
  });

  it("notes nothing when a placeholder is inserted and the rest renumbered", async () => {
    await deliver(manifest([plain()]));
    world.clock.now = T0 + 1000;
    const inserted = plain();
    inserted.records[1].sequence = 3;
    inserted.records[2].sequence = 4;
    inserted.records.push(rec(29, 2, "missing", [], { missingSide: "both", requestId: "req-9" }));
    await deliver(manifest([inserted]));
    expect((await status(CODE)).problems).toEqual([]);
  });
});

describe("a reordered file delivery", () => {
  it("notes sequence-reordered when it is given the registered delivery's records", async () => {
    const parsed = checkCaptureManifest(manifest([volume19()]));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
    const planned: PlannedVolume = {
      stem: CODE,
      externalId: CODE,
      captuaCollectionId: 7,
      action: "replace",
      volumeId: "pv-1",
      descriptionId: "d-1",
      referenceCode: CODE,
      mastersPrefix: `${ROOT}${CODE}/`,
      pages: planPages(parsed.manifest.volumes[0], SLUG, ROOT).pages,
      objects: [],
      inventory: { masterBytes: 0, missingMasters: [], missingOthers: [], unlisted: [] },
    };
    const noted = async (previous: Array<{ captuaRecordId: number; sequence: number }> | undefined) =>
      (
        await fileRegistrationSql({
          tenantId: DEFAULT_TEST_TENANT_ID,
          manifest: parsed.manifest,
          volume: planned,
          digest: "0".repeat(64),
          masters: { endpoint: "https://masters.test", bucket: TEST_MASTERS_BUCKET },
          listing: new Map(),
          now: T0,
          newId: () => crypto.randomUUID(),
          previous,
        })
      ).statements.some((s) => s.includes("sequence-reordered"));
    expect(
      await noted([
        { captuaRecordId: 26, sequence: 1 },
        { captuaRecordId: 21, sequence: 2 },
      ]),
    ).toBe(true);
    expect(await noted(undefined)).toBe(false);
    expect(await noted([{ captuaRecordId: 21, sequence: 1 }, { captuaRecordId: 26, sequence: 9 }])).toBe(false);
  });
});

describe("what the viewer reads", () => {
  it("offers the openings for approval and carries every placeholder in sequence order", async () => {
    const { volumeId } = await deliver(manifest([volume19()]));
    const data = await loadCaptureQcVolume(drizzle(env.DB), world.tenant, world.admin, volumeId, T0);
    expect(data.openings.map((o) => [o.sequence, o.captuaRecordId])).toEqual([
      [1, 21],
      [5, 25],
      [6, 26],
    ]);
    expect(data.placeholders).toEqual([
      { captuaRecordId: 22, sequence: 2, missingSide: "both", closedReason: null, closedNote: null, requestId: "req-1", opening: false, images: [] },
      {
        captuaRecordId: 23,
        sequence: 3,
        missingSide: "left",
        closedReason: null,
        closedNote: null,
        requestId: null,
        opening: false,
        images: [{ captureId: `cap-${CODE}-img_0003_c1`, role: "right", pageKey: `${CODE}-img_0003_c1` }],
      },
      { captuaRecordId: 24, sequence: 4, missingSide: "both", closedReason: "foliation_skip", closedNote: "Folio 12 skipped", requestId: null, opening: false, images: [] },
      {
        captuaRecordId: 25,
        sequence: 5,
        missingSide: "right",
        closedReason: "leaf_missing_from_volume",
        closedNote: null,
        requestId: null,
        opening: true,
        images: [{ captureId: `cap-${CODE}-img_0005_c0`, role: "left", pageKey: `${CODE}-img_0005_c0` }],
      },
    ]);
  });
});

describe("the spot-recapture list", () => {
  it("lists the rejected openings in sequence order", async () => {
    const v = {
      ...volume19(),
      records: [
        rec(40, 1, "in_review", spread(CODE, 1)),
        rec(31, 2, "in_review", spread(CODE, 2)),
        rec(35, 3, "in_review", spread(CODE, 3)),
      ],
    };
    const { volumeId } = await deliver(manifest([v]));
    expect(
      (
        await decide(volumeId, [
          { captuaRecordId: 35, decision: "rejected", reason: "blur", side: "both" },
          { captuaRecordId: 40, decision: "rejected", reason: "blur", side: "left" },
          { captuaRecordId: 31, decision: "rejected", reason: "glare", side: "right" },
        ])
      ).status,
    ).toBe(200);
    const [vol] = await readRetakeVolumes(drizzle(env.DB), DEFAULT_TEST_TENANT_ID, { pairs: false });
    expect(vol.retakes.map((r) => r.captuaRecordId)).toEqual([40, 31, 35]);
  });
});

// @version v0.9.0
