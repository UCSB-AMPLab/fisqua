/**
 * Tests — publishing a ready volume: the checks before any write
 *
 * This suite drives `loadPublishContext`, the read-only first step of
 * publishing, and pins every refusal it can answer. Each refusal case
 * snapshots the pipeline tables, descriptions, OCR pages, the journal,
 * the publication ledger and the canonical manifest bucket before and
 * after, and asserts that nothing changed: a refused publish writes
 * nothing.
 *
 * The cases cover, in the order the checks run: publishing switched
 * off for the environment; a volume that is missing or another
 * tenant's; a volume not ready or already published; a stale run; an
 * open review queue or a missing gate pass; a run still open or whose
 * spec URL is still live; a volume flagged restricted (the access
 * conditions text is not read for this); the spec object missing,
 * altered or naming another tile root; the default locator; held keys
 * outside the run's working prefix; a held manifest that is missing,
 * malformed, names a key twice in one object (the parse keeps the last
 * value, the published text would keep both), or differs in any way
 * from the document Fisqua builds from the spec (the runner chooses
 * only the canvas dimensions); a report
 * that does not match the spec's pages; and a canonical key that
 * another tenant holds or that holds an object no catalogue row of this
 * volume names. The refusal bodies and the console never carry the
 * run's callback token. One case pins the manifest builder against a
 * document written out by hand from the runner's builder.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase, seedTenants, seedFederations } from "../helpers/db";
import {
  seedReadyVolume,
  rewriteSpec,
  insertRow,
  snapshotPipelineTables,
  sha256Hex,
  TEST_MANIFEST_BASE,
  TEST_KEY_PREFIX,
  TEST_IMAGE_BASE,
  type ReadyVolume,
  TEST_TILES_TARGET,
  TEST_TILES_BUCKET,
} from "../helpers/media-pipeline";
import { DACS_TEST_TENANT_ID } from "../../app/lib/tenant";
import { getMediaObjectReader, type MediaObjectReader } from "../../app/lib/pipeline/store.server";
import {
  r2CanonicalManifestStore,
  prefixLocator,
  defaultCanonicalManifestLocator,
} from "../../app/lib/pipeline/canonical.server";
import {
  loadPublishContext,
  expectedHeldManifest,
  hasDuplicateKey,
  PublishRefusal,
  type PublishDeps,
} from "../../app/lib/pipeline/publish.server";

const E = env as any;

function recordingReader(): MediaObjectReader & { reads: string[] } {
  const inner = getMediaObjectReader(E, fetch, TEST_TILES_TARGET);
  const reads: string[] = [];
  return {
    reads,
    async getText(bucket, key) {
      reads.push(`${bucket}/${key}`);
      return inner.getText(bucket, key);
    },
  };
}

function deps(over: Partial<PublishDeps> = {}): PublishDeps & { reader: { reads: string[] } } {
  return {
    db: drizzle(env.DB, { schema }),
    reader: recordingReader(),
    canonical: r2CanonicalManifestStore(E.MANIFESTS_BUCKET),
    locator: prefixLocator(TEST_MANIFEST_BASE, TEST_KEY_PREFIX),
    specBucket: E.SPEC_BUCKET,
    workingBucket: E.PIPELINE_WORKING_BUCKET,
    tilesBucket: TEST_TILES_BUCKET,
    publishEnabled: true,
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    ...over,
  } as PublishDeps & { reader: { reads: string[] } };
}

async function snapshotAll(): Promise<unknown> {
  const out: Record<string, unknown> = { ...(await snapshotPipelineTables()) };
  for (const t of ["descriptions", "ocr_pages", "changelog", "pipeline_publications"]) {
    out[t] = (await env.DB.prepare(`SELECT * FROM ${t} ORDER BY id`).all()).results;
  }
  const listed = await E.MANIFESTS_BUCKET.list();
  out.manifests = listed.objects.map((o: any) => [o.key, o.etag]);
  return out;
}

let consoleCalls: string[] = [];
let tokens: string[] = [];

function load(seed: ReadyVolume, d: PublishDeps = deps(), runId = seed.runId, volumeId = seed.volumeId) {
  return loadPublishContext(d, { id: seed.tenantId }, { id: seed.userId }, volumeId, runId);
}

async function expectRefusal(
  p: Promise<unknown>,
  code: string,
  status: number,
): Promise<PublishRefusal> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(PublishRefusal);
  const r = caught as PublishRefusal;
  expect({ code: r.code, status: r.status }).toEqual({ code, status });
  const body = JSON.stringify({ error: r.code, ...r.detail }) + r.message;
  for (const t of tokens) {
    expect(body).not.toContain(t);
    for (const c of consoleCalls) expect(c).not.toContain(t);
  }
  return r;
}

/** Runs `fn` against a fresh seed and asserts nothing was written. */
async function refusedUnchanged(
  seed: ReadyVolume,
  fn: () => Promise<unknown>,
  code: string,
  status: number,
): Promise<PublishRefusal> {
  const before = await snapshotAll();
  const r = await expectRefusal(fn(), code, status);
  expect(await snapshotAll()).toEqual(before);
  return r;
}

async function ready(opts: Parameters<typeof seedReadyVolume>[0] = {}): Promise<ReadyVolume> {
  const seed = await seedReadyVolume(opts);
  tokens.push(seed.run.token);
  return seed;
}

async function putHeld(seed: ReadyVolume, doc: unknown): Promise<void> {
  await E.BUCKET.put(seed.manifestKey, typeof doc === "string" ? doc : JSON.stringify(doc));
}

async function putReport(seed: ReadyVolume, report: unknown): Promise<void> {
  await E.BUCKET.put(seed.reportKey, JSON.stringify(report));
}

describe("publish checks", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedFederations();
    consoleCalls = [];
    tokens = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        consoleCalls.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes a ready volume and returns its context", async () => {
    const seed = await ready();
    const ctx = await load(seed);
    expect(ctx.canonicalUrl).toBe(seed.canonicalUrl);
    expect(ctx.canonicalKey).toBe(seed.canonicalKey);
    expect(ctx.ocrPages).toEqual(
      seed.pageKeys.map((k, i) => ({
        seq: i + 1,
        textKey: `${TEST_KEY_PREFIX}ocr/${seed.referenceCode}/txt/${k}.txt`,
        altoKey: `${TEST_KEY_PREFIX}ocr/${seed.referenceCode}/alto/${k}.xml`,
      })),
    );
    expect(ctx.current).toBeNull();
    expect(ctx.manifestSha256).toBe(await sha256Hex(ctx.manifestText));
  });

  it("refuses when publishing is switched off, before reading the volume", async () => {
    const seed = await ready();
    const db = new Proxy({}, {
      get() {
        throw new Error("the database was read");
      },
    }) as any;
    await refusedUnchanged(seed, () => load(seed, deps({ publishEnabled: false, db })), "publish_disabled", 400);
  });

  it("answers an unknown volume and another tenant's volume alike", async () => {
    const seed = await ready();
    const other = await ready({ tenantId: DACS_TEST_TENANT_ID });
    const a = await refusedUnchanged(seed, () => load(seed, deps(), seed.runId, "no-such-volume"), "volume_not_found", 404);
    const b = await refusedUnchanged(seed, () => load(seed, deps(), other.runId, other.volumeId), "volume_not_found", 404);
    expect(a.detail).toEqual(b.detail);
  });

  it("refuses a volume that is not ready", async () => {
    const seed = await ready();
    for (const state of ["received", "prepared"]) {
      await env.DB.prepare("UPDATE pipeline_volumes SET state = ? WHERE id = ?").bind(state, seed.volumeId).run();
      await refusedUnchanged(seed, () => load(seed), "volume_state", 409);
    }
  });

  it("refuses an earlier run of the volume", async () => {
    const seed = await ready();
    // A second, closed run of the same volume that ended aborted; the
    // volume's last run stays the ready one.
    const earlierRunId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO pipeline_runs SELECT ?, tenant_id, federation_id, user_id, kind, purpose, regenerates_run_id, status, " +
        "runner_image, script_version, arch, max_review_frac, spec_key || '.earlier', spec_sha256, spec_url_expires_at, " +
        "chunk_count, volume_count, volumes_reported, callback_token_hash, token_expires_at, token_revoked_at, error, " +
        "created_at - 1000, dispatched_at, completed_at FROM pipeline_runs WHERE id = ?",
    ).bind(earlierRunId, seed.runId).run();
    await env.DB.prepare(
      "INSERT INTO pipeline_run_volumes (id, run_id, tenant_id, pipeline_volume_id, declaration_id, job_index, " +
        "chunk_index, reference_code, tile_root, expected_count, resolved_recipe, status, created_at) " +
        "SELECT ?, ?, tenant_id, pipeline_volume_id, declaration_id, job_index, chunk_index, reference_code, " +
        "tile_root, expected_count, resolved_recipe, 'aborted', created_at FROM pipeline_run_volumes WHERE id = ?",
    ).bind(crypto.randomUUID(), earlierRunId, seed.runVolumeId).run();
    const r = await refusedUnchanged(seed, () => load(seed, deps(), earlierRunId), "stale_run", 409);
    expect(r.detail).toEqual({ run_id: seed.runId });
  });

  it("refuses a run volume that is not prepared, or a tile root that moved", async () => {
    const seed = await ready();
    await env.DB.prepare("UPDATE pipeline_run_volumes SET status = 'aborted' WHERE id = ?").bind(seed.runVolumeId).run();
    await refusedUnchanged(seed, () => load(seed), "volume_state", 409);
    const seed2 = await ready();
    await env.DB.prepare("UPDATE pipeline_volumes SET current_tile_root = 'elsewhere' WHERE id = ?").bind(seed2.volumeId).run();
    await refusedUnchanged(seed2, () => load(seed2), "volume_state", 409);
  });

  it("refuses an open review queue and a missing gate pass", async () => {
    const seed = await ready();
    await env.DB.prepare("UPDATE pipeline_volumes SET open_review_count = 1 WHERE id = ?").bind(seed.volumeId).run();
    await refusedUnchanged(seed, () => load(seed), "review_open", 409);
    await env.DB.prepare("UPDATE pipeline_volumes SET open_review_count = 0 WHERE id = ?").bind(seed.volumeId).run();
    await env.DB.prepare("DELETE FROM pipeline_gate_passes WHERE tenant_id = ?").bind(seed.tenantId).run();
    await refusedUnchanged(seed, () => load(seed), "gate_missing", 409);
  });

  it("refuses an open run and a live spec URL, and treats an expired token as closed", async () => {
    const seed = await ready();
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE pipeline_runs SET status = 'running', token_revoked_at = NULL, token_expires_at = ?, spec_url_expires_at = ? WHERE id = ?",
    ).bind(now + 3_600_000, now - 120_000, seed.runId).run();
    await refusedUnchanged(seed, () => load(seed), "run_open", 409);

    const live = now + 60_000;
    await env.DB.prepare(
      "UPDATE pipeline_runs SET status = 'completed', token_revoked_at = ?, token_expires_at = ?, spec_url_expires_at = ? WHERE id = ?",
    ).bind(now, now + 3_600_000, live, seed.runId).run();
    const r = await refusedUnchanged(seed, () => load(seed), "run_spec_live", 409);
    expect(r.detail).toEqual({ spec_url_expires_at: live });

    await env.DB.prepare(
      "UPDATE pipeline_runs SET status = 'running', token_revoked_at = NULL, token_expires_at = ?, spec_url_expires_at = ? WHERE id = ?",
    ).bind(now - 1000, now - 120_000, seed.runId).run();
    const before = await env.DB.prepare("SELECT * FROM pipeline_runs WHERE id = ?").bind(seed.runId).first();
    await load(seed);
    expect(await env.DB.prepare("SELECT * FROM pipeline_runs WHERE id = ?").bind(seed.runId).first()).toEqual(before);
  });

  it("refuses a volume flagged restricted after the run", async () => {
    const seed = await ready();
    await env.DB.prepare("UPDATE pipeline_volumes SET restricted = 1 WHERE id = ?").bind(seed.volumeId).run();
    await refusedUnchanged(seed, () => load(seed), "restricted_material", 400);
  });

  it("does not read the access conditions to decide restriction", async () => {
    const seed = await ready();
    await env.DB.prepare("UPDATE descriptions SET access_conditions = 'Libre acceso' WHERE id = ?").bind(seed.descriptionId).run();
    const ctx = await load(seed);
    expect(ctx.canonicalUrl).toBe(seed.canonicalUrl);
  });

  it("refuses with the default locator", async () => {
    const seed = await ready();
    await refusedUnchanged(seed, () => load(seed, deps({ locator: defaultCanonicalManifestLocator })), "manifest_inputs_unavailable", 400);
  });

  it("refuses a missing, altered or inconsistent spec", async () => {
    const seed = await ready();
    const key = `${seed.tenantId}/pipeline-runs/${seed.runId}/spec.json`;
    const text = await (await E.SPEC_BUCKET.get(key)).text();
    await E.SPEC_BUCKET.delete(key);
    await refusedUnchanged(seed, () => load(seed), "spec_mismatch", 400);
    await E.SPEC_BUCKET.put(key, text.replace('"spec_version":1', '"spec_version":2'));
    await refusedUnchanged(seed, () => load(seed), "spec_mismatch", 400);
    const spec = structuredClone(seed.spec);
    spec.volumes[0].tile_root = "another-root";
    await rewriteSpec(seed, spec);
    await refusedUnchanged(seed, () => load(seed), "spec_mismatch", 400);
  });

  it("refuses held keys outside the run's working prefix without reading them", async () => {
    const seed = await ready();
    const other = await ready();
    await env.DB.prepare("UPDATE pipeline_run_volumes SET manifest_key = ? WHERE id = ?")
      .bind(other.manifestKey, seed.runVolumeId)
      .run();
    const d = deps();
    await refusedUnchanged(seed, () => load(seed, d), "held_material_invalid", 400);
    expect(d.reader.reads).toEqual([]);
  });

  type Mutation = [string, string, Record<string, unknown> | null, (doc: any, seed: ReadyVolume) => unknown];
  const held: Mutation[] = [
    ["absent", "held_manifest_missing", null, () => undefined],
    ["not JSON", "held_manifest_invalid", null, () => "{not json"],
    ["a JSON array", "held_manifest_invalid", null, () => []],
    ["items an object", "held_manifest_invalid", null, (d) => ({ ...d, items: {} })],
    ["items holding null", "held_manifest_invalid", null, (d) => ({ ...d, items: [null] })],
    ["carrying an earlier duplicate label", "held_manifest_invalid", { token: "manifest_duplicate_key" }, (d) =>
      JSON.stringify(d).replace('"label":', '"label":{"none":["runner text"]},"label":')],
    ["carrying a duplicate key spelled with an escape", "held_manifest_invalid", { token: "manifest_duplicate_key" }, (d) =>
      JSON.stringify(d).replace('"label":', '"l\\u0061bel":{"none":["runner text"]},"label":')],
    ["carrying a duplicate key inside a canvas", "held_manifest_invalid", { token: "manifest_duplicate_key" }, (d) =>
      JSON.stringify(d).replace('"type":"Canvas"', '"type":"runner text","type":"Canvas"')],
    ["another id", "held_manifest_mismatch", { check: "id" }, (d) => ({ ...d, id: `${TEST_MANIFEST_BASE}/iiif/x/manifest.json` })],
    ["another homepage", "held_manifest_mismatch", { check: "homepage" }, (d) => ({ ...d, homepage: [{ ...d.homepage[0], id: "https://zasqua.org/another-ref" }] })],
    ["one canvas fewer", "held_manifest_mismatch", { check: "page_count" }, (d) => ({ ...d, items: d.items.slice(1) })],
    ["a service under another root", "held_manifest_mismatch", { check: "image_root" }, (d) => {
      d.items[1].items[0].items[0].body.service[0].id = `${TEST_IMAGE_BASE}/elsewhere/p0002`;
      return d;
    }],
    ["a width of 0", "held_manifest_mismatch", { check: "dimensions" }, (d) => {
      d.items[0].width = 0;
      return d;
    }],
    ["a changed label", "held_manifest_mismatch", { check: "document", path: "$.label.none[0]" }, (d) => ({ ...d, label: { none: ["Other"] } })],
    ["rights added", "held_manifest_mismatch", { check: "document", path: "$.rights" }, (d) => ({ ...d, rights: "https://rights.test.example" })],
    ["a changed requiredStatement", "held_manifest_mismatch", { check: "document", path: "$.requiredStatement.value.none[0]" }, (d) => ({ ...d, requiredStatement: { ...d.requiredStatement, value: { none: ["Other"] } } })],
    ["a changed provider", "held_manifest_mismatch", { check: "document", path: "$.provider[0].id" }, (d) => ({ ...d, provider: [{ ...d.provider[0], id: "https://other.test.example" }] })],
    ["an extra seeAlso", "held_manifest_mismatch", { check: "document", path: "$.seeAlso" }, (d) => ({ ...d, seeAlso: [] })],
    ["an extra rendering", "held_manifest_mismatch", { check: "document", path: "$.rendering" }, (d) => ({ ...d, rendering: [] })],
    ["an extra structures", "held_manifest_mismatch", { check: "document", path: "$.structures" }, (d) => ({ ...d, structures: [] })],
    ["an extra annotations", "held_manifest_mismatch", { check: "document", path: "$.annotations" }, (d) => ({ ...d, annotations: [] })],
    ["an extra canvas property", "held_manifest_mismatch", { check: "document", path: "$.items[0].navDate" }, (d) => {
      d.items[0].navDate = "1700-01-01T00:00:00Z";
      return d;
    }],
    ["a canvas id under another root", "held_manifest_mismatch", { check: "document", path: "$.items[0].id" }, (d) => {
      d.items[0].id = `${TEST_IMAGE_BASE}/elsewhere/canvas/1`;
      return d;
    }],
    ["a second service", "held_manifest_mismatch", { check: "document", path: "$.items[0].items[0].items[0].body.service" }, (d) => {
      d.items[0].items[0].items[0].body.service.push({ id: "https://svc.test.example", type: "ImageService3", profile: "level0" });
      return d;
    }],
    ["a second annotation", "held_manifest_mismatch", { check: "document", path: "$.items[0].items[0].items" }, (d) => {
      d.items[0].items[0].items.push({ ...d.items[0].items[0].items[0], id: "https://a.test.example/2" });
      return d;
    }],
    ["a changed thumbnail size", "held_manifest_mismatch", { check: "document", path: "$.items[0].thumbnail[0].id" }, (d) => {
      d.items[0].thumbnail[0].id = d.items[0].thumbnail[0].id.replace("/full/200,300/", "/full/96,144/");
      d.items[0].thumbnail[0].width = 96;
      d.items[0].thumbnail[0].height = 144;
      return d;
    }],
  ];

  it.each(held)("refuses a held manifest that is %s", async (_label, code, detail, mutate) => {
    const seed = await ready();
    const doc = mutate(structuredClone(seed.heldManifest), seed);
    if (doc === undefined) await E.BUCKET.delete(seed.manifestKey);
    else await putHeld(seed, doc);
    const r = await refusedUnchanged(seed, () => load(seed), code, 400);
    if (detail !== null) expect(r.detail).toEqual(detail);
    if (code === "held_manifest_invalid") expect(typeof r.detail.token).toBe("string");
  });

  it("finds duplicate keys at any depth, and only real ones", () => {
    expect(hasDuplicateKey('{"a":1,"b":{"x":1,"x":2}}')).toBe(true);
    expect(hasDuplicateKey('[{"a":1},{"a":1,"a":1}]')).toBe(true);
    expect(hasDuplicateKey('{"a":1,"\\u0061":2}')).toBe(true);
    expect(hasDuplicateKey('{"a":"}\\",\\"a\\":1","b":{"a":1},"c":[{"a":1},{"a":2}],"d":{}}')).toBe(false);
    expect(hasDuplicateKey(' { "a" : [ 1 , { "a" : null } ] , "b" : "a" } ')).toBe(false);
    expect(hasDuplicateKey("[]")).toBe(false);
  });

  const METADATA = [
    { label: { en: ["Date"], es: ["Fecha"] }, value: { es: ["1570"] } },
  ];

  it("passes a held manifest carrying the spec's metadata, summary and METS link", async () => {
    const seed = await ready({
      manifestExtras: {
        metadata: METADATA,
        summary: { es: ["Resumen"] },
        see_also: [{ id: "https://files.test.example/mets/x.xml", type: "Dataset" }],
      },
    });
    expect(seed.heldManifest.seeAlso).toEqual([{ id: "https://files.test.example/mets/x.xml", type: "Dataset" }]);
    const ctx = await load(seed);
    expect(ctx.canonicalUrl).toBe(seed.canonicalUrl);
  });

  it("refuses a held manifest with an extra metadata entry, at that path", async () => {
    const seed = await ready({ manifestExtras: { metadata: METADATA } });
    const doc = structuredClone(seed.heldManifest);
    doc.metadata.push({ label: { en: ["Language"] }, value: { es: ["Español"] } });
    await putHeld(seed, doc);
    const r = await refusedUnchanged(seed, () => load(seed), "held_manifest_mismatch", 400);
    expect(r.detail).toEqual({ check: "document", path: "$.metadata" });
  });

  it("refuses a held manifest with a changed metadata value, at that path", async () => {
    const seed = await ready({ manifestExtras: { metadata: METADATA } });
    const doc = structuredClone(seed.heldManifest);
    doc.metadata[0].value.es[0] = "1571";
    await putHeld(seed, doc);
    const r = await refusedUnchanged(seed, () => load(seed), "held_manifest_mismatch", 400);
    expect(r.detail).toEqual({ check: "document", path: "$.metadata[0].value.es[0]" });
  });

  it("passes a spec entry without a homepage, and refuses a held manifest that adds one", async () => {
    const seed = await ready({ manifestExtras: { homepage: undefined } });
    expect("homepage" in seed.heldManifest).toBe(false);
    const ctx = await load(seed);
    expect(ctx.canonicalUrl).toBe(seed.canonicalUrl);
    const doc = { ...structuredClone(seed.heldManifest), homepage: [{ id: "https://zasqua.org/x", type: "Text" }] };
    await putHeld(seed, doc);
    const r = await refusedUnchanged(seed, () => load(seed), "held_manifest_mismatch", 400);
    expect(r.detail).toEqual({ check: "homepage" });
  });

  it("does not apply the shared parser's homepage host rule", async () => {
    const seed = await ready({ homepageId: "https://catalogue.test.example/records/abc" });
    const ctx = await load(seed);
    expect(ctx.canonicalUrl).toBe(seed.canonicalUrl);
  });

  type ReportMutation = [string, (r: any, seed: ReadyVolume) => unknown, { ocr?: boolean }?];
  const reports: ReportMutation[] = [
    ["absent", () => undefined],
    ["missing a page", (r) => ({ ...r, pages: r.pages.slice(1) })],
    ["starting at seq 0", (r) => ({ ...r, pages: r.pages.map((p: any) => ({ ...p, seq: p.seq - 1 })) })],
    ["with a page key out of order", (r) => {
      [r.pages[0].page_key, r.pages[1].page_key] = [r.pages[1].page_key, r.pages[0].page_key];
      return r;
    }],
    ["with a text key under another tile root", (r) => {
      r.pages[0].text_key = r.pages[0].text_key.replace(/^neogranadina\/ocr\/[^/]+\//, "neogranadina/ocr/other-root/");
      return r;
    }],
    ["with an ALTO key under txt/", (r) => {
      r.pages[0].alto_key = r.pages[0].alto_key.replace("/alto/", "/txt/");
      return r;
    }],
    ["with a text key while OCR was off", (r, seed) => {
      r.pages[0].text_key = `${TEST_KEY_PREFIX}ocr/${seed.referenceCode}/txt/${seed.pageKeys[0]}.txt`;
      return r;
    }, { ocr: false }],
  ];

  it.each(reports)("refuses a report %s", async (label, mutate, opts) => {
    const seed = await ready(opts ?? {});
    const report = mutate(structuredClone(seed.report), seed);
    if (report === undefined) await E.BUCKET.delete(seed.reportKey);
    else await putReport(seed, report);
    await refusedUnchanged(seed, () => load(seed), label === "absent" ? "report_missing" : "report_invalid", 400);
  });

  it("refuses a canonical key another tenant holds, or one holding an object this volume does not name", async () => {
    const prefix = `co-own-${crypto.randomUUID().slice(0, 6)}`;
    // (a) another tenant's publication names the key. Keys sit under
    // each tenant's slug, so the other tenant's row is made to name this
    // tenant's key; the ownership check is the backstop.
    const mine = await ready({ codePrefix: prefix });
    const theirs = await ready({ tenantId: DACS_TEST_TENANT_ID, codePrefix: prefix, keySlug: "neogranadina" });
    expect(theirs.canonicalKey).toBe(mine.canonicalKey);
    await insertRow("pipeline_publications", {
      id: crypto.randomUUID(),
      tenant_id: theirs.tenantId,
      pipeline_volume_id: theirs.volumeId,
      run_id: theirs.runId,
      run_volume_id: theirs.runVolumeId,
      user_id: theirs.userId,
      status: "published",
      claim_id: crypto.randomUUID(),
      canonical_url: theirs.canonicalUrl,
      canonical_key: theirs.canonicalKey,
      manifest_sha256: "0".repeat(64),
      canonical_expect: JSON.stringify({ absent: true }),
      claimed_at: Date.now(),
      published_at: Date.now(),
    });
    const a = await refusedUnchanged(mine, () => load(mine), "canonical_not_owned", 409);
    expect(a.detail).toEqual({});
    await env.DB.prepare("DELETE FROM pipeline_publications").run();

    // (b) another tenant's description names the canonical URL.
    await env.DB.prepare("UPDATE descriptions SET iiif_manifest_url = ? WHERE id = ?")
      .bind(theirs.canonicalUrl, theirs.descriptionId)
      .run();
    const b = await refusedUnchanged(mine, () => load(mine), "canonical_not_owned", 409);
    expect(b.detail).toEqual({});
    await env.DB.prepare("UPDATE descriptions SET iiif_manifest_url = NULL WHERE id = ?").bind(theirs.descriptionId).run();

    // (c) an object at the key that nothing of this volume names.
    await E.MANIFESTS_BUCKET.put(mine.canonicalKey, '{"other":true}');
    const etag = (await E.MANIFESTS_BUCKET.head(mine.canonicalKey)).etag;
    const c = await refusedUnchanged(mine, () => load(mine), "canonical_not_owned", 409);
    expect(c.detail).toEqual({});
    expect((await E.MANIFESTS_BUCKET.head(mine.canonicalKey)).etag).toBe(etag);
    await E.MANIFESTS_BUCKET.delete(mine.canonicalKey);
  });

  it("keeps the callback token out of refusals and the console", async () => {
    const seed = await ready();
    const spec = structuredClone(seed.spec);
    spec.volumes[0].reference_code = "mismatch";
    await rewriteSpec(seed, spec);
    await expectRefusal(load(seed), "spec_mismatch", 400);
    await putHeld(seed, { ...seed.heldManifest, id: "https://x.test.example/manifest.json" });
    await rewriteSpec(seed, seed.spec);
    await expectRefusal(load(seed), "held_manifest_mismatch", 400);
    for (const c of consoleCalls) expect(c).not.toContain(seed.run.token);
  });

  it("builds the manifest the runner builds", () => {
    const base = "https://tiles.test.example/co-x-001";
    const doc = expectedHeldManifest(
      {
        id: "https://manifests.test.example/iiif/co-x-001/manifest.json",
        label: { none: ["Test"] },
        homepage: [{ id: "https://zasqua.org/co-x-001", type: "Text" }],
        rights: null,
        required_statement: { label: { none: ["L"] }, value: { none: ["V"] } },
        provider: [{ id: "https://p.test.example", type: "Agent" }],
      },
      [
        { seq: 1, page_key: "p0001" },
        { seq: 2, page_key: "p0002" },
      ],
      "https://tiles.test.example/",
      "co-x-001",
      [96, 200],
      [
        { width: 1001, height: 1501 },
        { width: 96, height: 150 },
      ],
    );
    const body = (key: string, w: number, h: number) => ({
      id: `${base}/${key}/full/max/0/default.jpg`,
      type: "Image",
      format: "image/jpeg",
      height: h,
      width: w,
      service: [{ id: `${base}/${key}`, type: "ImageService3", profile: "level0" }],
    });
    const canvas = (i: number, key: string, w: number, h: number, thumb: unknown) => ({
      id: `${base}/canvas/${i}`,
      type: "Canvas",
      label: { none: [`img ${i}`] },
      height: h,
      width: w,
      thumbnail: [thumb],
      items: [
        {
          id: `${base}/canvas/${i}/page`,
          type: "AnnotationPage",
          items: [
            {
              id: `${base}/canvas/${i}/annotation`,
              type: "Annotation",
              motivation: "painting",
              target: `${base}/canvas/${i}`,
              body: body(key, w, h),
            },
          ],
        },
      ],
    });
    expect(doc).toEqual({
      "@context": "http://iiif.io/api/presentation/3/context.json",
      id: "https://manifests.test.example/iiif/co-x-001/manifest.json",
      type: "Manifest",
      label: { none: ["Test"] },
      homepage: [{ id: "https://zasqua.org/co-x-001", type: "Text" }],
      behavior: ["paged"],
      provider: [{ id: "https://p.test.example", type: "Agent" }],
      requiredStatement: { label: { none: ["L"] }, value: { none: ["V"] } },
      items: [
        // 1501 * 200 / 1001 = 299.9..., rounded to 300.
        canvas(1, "p0001", 1001, 1501, {
          id: `${base}/p0001/full/200,300/0/default.jpg`,
          type: "Image",
          format: "image/jpeg",
          width: 200,
          height: 300,
        }),
        // No baked width is below 96 pixels, so the thumbnail is full/max.
        canvas(2, "p0002", 96, 150, {
          id: `${base}/p0002/full/max/0/default.jpg`,
          type: "Image",
          format: "image/jpeg",
          width: 96,
          height: 150,
        }),
      ],
    });
    expect("rights" in doc).toBe(false);
  });
});
