/**
 * Tests — publishing a ready volume: the claim, the record and the sequence
 *
 * This suite pins the writes of a publish. The claim inserts one
 * in-flight publication row for the volume, only while the volume is
 * still ready with the same run and nothing else of it is in flight or
 * published; a claim left `claimed` past its expiry is abandoned in the
 * same batch; a `copying` row is never abandoned there, since it may
 * already hold a canonical write. Another tenant's claim on the same
 * canonical key is refused by the cross-tenant index and answered as
 * not owned. The record statement and the failure statement move only
 * the row of their own claim. Every statement stays within D1's bound
 * parameter limit.
 *
 * The sequence cases publish through `publishVolume` with the test
 * locator, a recording wrapper around the canonical store, and, where a
 * case needs a failure at one step, a wrapper around the D1 binding or
 * the store that fails once at that step. They pin what each failure
 * leaves: before the canonical put, the volume stays ready, nothing
 * reaches the canonical key and the claim is failed; a refused put
 * leaves the other writer's bytes; a final batch that fails after the
 * put leaves the row copying for the stalled-publication sweep. They
 * pin the catalogue change and its journal entry; migrated page-1 OCR
 * text, which the run's pages replace after its text is kept in
 * Fisqua's bucket and recorded with its digest, a failed keep that
 * refuses before any page is written, and a retry that keeps nothing a
 * second time; the previous chain
 * (preserved byte for byte, its image roots read from IIIF 3 and 2
 * manifests, nothing read from bytes that are not JSON), the replay and
 * concurrent cases, the shared canonical key across tenants, and the
 * query budget for a 734-page volume.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase, seedTenants, seedFederations } from "../helpers/db";
import {
  seedReadyVolume,
  insertRow,
  sha256Hex,
  snapshotPipelineTables,
  wrapD1,
  TEST_MANIFEST_BASE,
  TEST_KEY_PREFIX,
  TEST_IMAGE_BASE,
  type ReadyVolume,
  TEST_TILES_TARGET,
  TEST_TILES_BUCKET,
} from "../helpers/media-pipeline";
import { ingestOcrPages } from "../../app/lib/ocr/ingest.server";
import type { CanonicalManifestStore } from "../../app/lib/pipeline/canonical.server";
import { DACS_TEST_TENANT_ID } from "../../app/lib/tenant";
import { getMediaObjectReader } from "../../app/lib/pipeline/store.server";
import { r2CanonicalManifestStore, prefixLocator } from "../../app/lib/pipeline/canonical.server";
import {
  loadPublishContext,
  buildClaimStatements,
  claimPublication,
  buildRecordStatement,
  failClaim,
  buildFailClaimStatement,
  publishVolume,
  buildFinalStatements,
  finalInputFromRow,
  extractImageRoots,
  PublishRefusal,
  PUBLISH_CLAIM_TTL_MS,
  type PublishDeps,
  type PublishContext,
} from "../../app/lib/pipeline/publish.server";

const E = env as any;
const MIN = 60_000;

function deps(over: Partial<PublishDeps> = {}): PublishDeps {
  return {
    db: drizzle(env.DB, { schema }),
    reader: getMediaObjectReader(E, fetch, TEST_TILES_TARGET),
    canonical: r2CanonicalManifestStore(E.MANIFESTS_BUCKET),
    locator: prefixLocator(TEST_MANIFEST_BASE, TEST_KEY_PREFIX),
    specBucket: E.SPEC_BUCKET,
    workingBucket: E.PIPELINE_WORKING_BUCKET,
    tilesBucket: TEST_TILES_BUCKET,
    publishEnabled: true,
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    ...over,
  };
}

async function context(seed: ReadyVolume): Promise<PublishContext> {
  return loadPublishContext(deps(), { id: seed.tenantId }, { id: seed.userId }, seed.volumeId, seed.runId);
}

async function publication(seed: ReadyVolume, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const row = {
    id: crypto.randomUUID(),
    tenant_id: seed.tenantId,
    pipeline_volume_id: seed.volumeId,
    run_id: seed.runId,
    run_volume_id: seed.runVolumeId,
    user_id: seed.userId,
    status: "claimed",
    claim_id: crypto.randomUUID(),
    canonical_url: seed.canonicalUrl,
    canonical_key: seed.canonicalKey,
    manifest_sha256: "0".repeat(64),
    canonical_expect: JSON.stringify({ absent: true }),
    claimed_at: Date.now(),
    ...over,
  };
  await insertRow("pipeline_publications", row);
  return row;
}

async function rows(volumeId: string): Promise<Array<Record<string, any>>> {
  return (
    await env.DB.prepare("SELECT * FROM pipeline_publications WHERE pipeline_volume_id = ? ORDER BY claimed_at, id")
      .bind(volumeId)
      .all()
  ).results as Array<Record<string, any>>;
}

function params(stmt: unknown): unknown[] {
  const s = stmt as { toSQL?: () => { params: unknown[] }; getQuery?: () => { params: unknown[] } };
  return (s.toSQL?.() ?? s.getQuery!()).params;
}

const db = () => drizzle(env.DB, { schema });

describe("publish: claim and record", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedFederations();
  });

  it("claim: abandons an expired claimed row and claims; leaves a fresh claim or a stale copying row alone", async () => {
    const now = Date.now();
    const seed = await seedReadyVolume();
    const ctx = await context(seed);

    const old = await publication(seed, { claimed_at: now - 31 * MIN });
    const ids = { publicationId: crypto.randomUUID(), claimId: crypto.randomUUID() };
    await db().batch(buildClaimStatements(db(), ctx, ids, now) as any);
    let all = await rows(seed.volumeId);
    const abandoned = all.find((r) => r.id === old.id)!;
    expect(abandoned.status).toBe("abandoned");
    expect(JSON.parse(abandoned.error).class).toBe("claim_expired");
    expect(abandoned.finished_at).toBe(now);
    const claimed = all.find((r) => r.id === ids.publicationId)!;
    expect(claimed).toMatchObject({ status: "claimed", claim_id: ids.claimId, claimed_at: now });

    await env.DB.prepare("UPDATE pipeline_publications SET claimed_at = ? WHERE id = ?")
      .bind(now - 5 * MIN, ids.publicationId)
      .run();
    const before = await rows(seed.volumeId);
    await db().batch(
      buildClaimStatements(db(), ctx, { publicationId: crypto.randomUUID(), claimId: crypto.randomUUID() }, now) as any,
    );
    expect(await rows(seed.volumeId)).toEqual(before);

    await env.DB.prepare(
      "UPDATE pipeline_publications SET status = 'copying', copying_at = ?, claimed_at = ? WHERE id = ?",
    ).bind(now - 31 * MIN, now - 40 * MIN, ids.publicationId).run();
    const before2 = await rows(seed.volumeId);
    await db().batch(
      buildClaimStatements(db(), ctx, { publicationId: crypto.randomUUID(), claimId: crypto.randomUUID() }, now) as any,
    );
    all = await rows(seed.volumeId);
    expect(all).toEqual(before2);
    expect(PUBLISH_CLAIM_TTL_MS).toBe(30 * MIN);
  });

  it("failing a claim moves only its own claimed or copying row", async () => {
    const now = Date.now();
    const seed = await seedReadyVolume();
    const a = await publication(seed);
    const pub = { id: a.id as string, tenantId: seed.tenantId, claimId: a.claim_id as string };
    await failClaim(db(), { ...pub, claimId: "another-claim" }, { class: "x" }, now);
    expect((await rows(seed.volumeId))[0].status).toBe("claimed");
    await failClaim(db(), pub, { class: "test" }, now);
    let [r] = await rows(seed.volumeId);
    expect(r).toMatchObject({ status: "failed", finished_at: now });
    expect(JSON.parse(r.error)).toEqual({ class: "test" });

    const b = await publication(seed, { status: "copying", copying_at: now });
    await failClaim(db(), { id: b.id as string, tenantId: seed.tenantId, claimId: b.claim_id as string }, { class: "t" }, now);
    expect((await rows(seed.volumeId)).find((x) => x.id === b.id)!.status).toBe("failed");

    const c = await publication(seed, { status: "published", published_at: now });
    await failClaim(db(), { id: c.id as string, tenantId: seed.tenantId, claimId: c.claim_id as string }, { class: "t" }, now);
    expect((await rows(seed.volumeId)).find((x) => x.id === c.id)!.status).toBe("published");
  });

  it("claim: inserts nothing for a moved run, claims past a failed one, and refuses another tenant's key", async () => {
    const now = Date.now();
    const seed = await seedReadyVolume();
    const ctx = await context(seed);
    await env.DB.prepare("UPDATE pipeline_volumes SET last_run_id = 'moved' WHERE id = ?").bind(seed.volumeId).run();
    await db().batch(
      buildClaimStatements(db(), ctx, { publicationId: crypto.randomUUID(), claimId: crypto.randomUUID() }, now) as any,
    );
    expect(await rows(seed.volumeId)).toEqual([]);
    await env.DB.prepare("UPDATE pipeline_volumes SET last_run_id = ? WHERE id = ?").bind(seed.runId, seed.volumeId).run();

    await publication(seed, { status: "failed" });
    await db().batch(
      buildClaimStatements(db(), ctx, { publicationId: crypto.randomUUID(), claimId: crypto.randomUUID() }, now) as any,
    );
    expect((await rows(seed.volumeId)).map((r) => r.status).sort()).toEqual(["claimed", "failed"]);

    // Another tenant's volume with the same reference code, claimed first
    // under this tenant's key (keys sit under each tenant's slug, so only
    // a row naming another tenant's key reaches this backstop).
    const prefix = `co-claim-${crypto.randomUUID().slice(0, 6)}`;
    const mine = await seedReadyVolume({ codePrefix: prefix });
    const theirs = await seedReadyVolume({ tenantId: DACS_TEST_TENANT_ID, codePrefix: prefix, keySlug: "neogranadina" });
    const mineCtx = await context(mine);
    await publication(theirs);
    let caught: unknown;
    try {
      await claimPublication(deps(), mineCtx, now);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PublishRefusal);
    expect((caught as PublishRefusal).code).toBe("canonical_not_owned");
    expect((caught as PublishRefusal).status).toBe(409);
    expect(await rows(mine.volumeId)).toEqual([]);
  });

  it("claim, record and fail statements stay within the parameter limit", async () => {
    const now = Date.now();
    const seed = await seedReadyVolume();
    const ctx = await context(seed);
    const ids = { publicationId: crypto.randomUUID(), claimId: crypto.randomUUID() };
    const statements = [
      ...buildClaimStatements(db(), ctx, ids, now),
      buildRecordStatement(
        db(),
        ctx,
        { id: ids.publicationId, claimId: ids.claimId },
        {
          descriptionBefore: { iiifManifestUrl: null, hasDigital: false },
          previousCatalogueUrl: null,
          previousManifestSha256: null,
          previousManifestEtag: null,
          previousManifestCopyKey: null,
          previousImageRoots: null,
          ocrPagesWritten: 3,
          ocrBytesRead: 36,
        },
        now,
      ),
      buildFailClaimStatement(db(), { id: ids.publicationId, tenantId: seed.tenantId, claimId: ids.claimId }, { class: "x" }, now),
    ];
    for (const s of statements) expect(params(s).length).toBeLessThanOrEqual(100);
    expect(params(buildClaimStatements(db(), ctx, ids, now)[1]).length).toBeLessThanOrEqual(25);
  });
});

// ---------------------------------------------------------------------------
// The sequence
// ---------------------------------------------------------------------------

/** The step 4 update: the only statement that sets `copying_at`. */
const RECORD_SQL = /^update "pipeline_publications" set .*"copying_at" = \?/s;

interface StoreOptions {
  putThrowsBefore?: boolean;
  putThrowsAfter?: boolean;
  interfere?: Uint8Array;
}

function recordingStore(opts: StoreOptions = {}): CanonicalManifestStore & { calls: string[] } {
  const inner = r2CanonicalManifestStore(E.MANIFESTS_BUCKET);
  const calls: string[] = [];
  let first = true;
  return {
    calls,
    async head(key) {
      calls.push("head");
      return inner.head(key);
    },
    async get(key) {
      calls.push("get");
      return inner.get(key);
    },
    async put(key, bytes, sha, expect) {
      calls.push("put");
      const once = first;
      first = false;
      if (once && opts.interfere) await E.MANIFESTS_BUCKET.put(key, opts.interfere);
      if (once && opts.putThrowsBefore) throw new Error("put failed");
      const out = await inner.put(key, bytes, sha, expect);
      if (once && opts.putThrowsAfter) throw new Error("put answered with an error");
      return out;
    },
  };
}

function tenantOf(seed: ReadyVolume) {
  return { id: seed.tenantId };
}

async function publish(seed: ReadyVolume, d: PublishDeps) {
  return publishVolume(d, tenantOf(seed) as any, { id: seed.userId } as any, {
    volumeId: seed.volumeId,
    runId: seed.runId,
  });
}

async function refusal(p: Promise<unknown>): Promise<PublishRefusal> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PublishRefusal) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

async function one<T = Record<string, any>>(q: string, ...binds: unknown[]): Promise<T> {
  return (await env.DB.prepare(q).bind(...binds).first()) as T;
}

async function all<T = Record<string, any>>(q: string, ...binds: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(q).bind(...binds).all()).results as T[];
}

async function heldText(seed: ReadyVolume): Promise<string> {
  return (await E.BUCKET.get(seed.manifestKey)).text();
}

async function canonicalBytes(seed: ReadyVolume): Promise<Uint8Array | null> {
  const obj = await E.MANIFESTS_BUCKET.get(seed.canonicalKey);
  return obj === null ? null : new Uint8Array(await obj.arrayBuffer());
}

function legacyIiif3(roots: string[], bom = true): Uint8Array {
  const doc = {
    "@context": "http://iiif.io/api/presentation/3/context.json",
    id: "https://legacy.test.example/manifest.json",
    type: "Manifest",
    homepage: [{ id: "https://catalogue.test.example/record/1", type: "Text" }],
    items: roots.flatMap((root, r) =>
      [1, 2].map((n) => ({
        id: `https://legacy.test.example/canvas/${r}-${n}`,
        type: "Canvas",
        items: [{ items: [{ body: { id: `${root}/${n}/full/max/0/default.jpg`, service: [{ id: `${root}/${n}`, type: "ImageService3" }] } }] }],
      })),
    ),
  };
  const text = new TextEncoder().encode(JSON.stringify(doc));
  return bom ? new Uint8Array([0xef, 0xbb, 0xbf, ...text]) : text;
}

function legacyIiif2(root: string): Uint8Array {
  const doc = {
    "@context": "http://iiif.io/api/presentation/2/context.json",
    "@id": "https://legacy.test.example/manifest.json",
    "@type": "sc:Manifest",
    sequences: [
      {
        canvases: [1, 2].map((n) => ({
          "@id": `https://legacy.test.example/canvas/${n}`,
          images: [{ resource: { "@id": `${root}/${n}/full/full/0/default.jpg`, service: { "@id": `${root}/${n}`, profile: "level0" } } }],
        })),
      },
    ],
  };
  return new TextEncoder().encode(JSON.stringify(doc));
}

async function journal(descriptionId: string) {
  return all("SELECT * FROM changelog WHERE record_id = ? ORDER BY created_at", descriptionId);
}

/** A page-1 row migrated from the old `ocr_text` column: no run, no keys. */
async function insertMigratedPage(
  seed: ReadyVolume,
  text: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await insertRow("ocr_pages", {
    id,
    tenant_id: seed.tenantId,
    description_id: seed.descriptionId,
    page_seq: 1,
    text,
    created_at: 1,
    ...over,
  });
  return id;
}

/** The spec bucket, with every put of a kept OCR copy failing. */
function failingPreviousOcrPut(): R2Bucket {
  const inner = E.SPEC_BUCKET as R2Bucket;
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === "put") {
        return (key: string, ...rest: unknown[]) => {
          if (key.endsWith("/previous-ocr.txt")) return Promise.reject(new Error("R2 unavailable"));
          return (target.put as (...a: unknown[]) => unknown).call(target, key, ...rest);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

describe("publish: the sequence", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedFederations();
  });

  it("publishes a ready volume with OCR: pages, catalogue, journal, then the manifest", async () => {
    const seed = await seedReadyVolume();
    const store = recordingStore();
    const out = await publish(seed, deps({ canonical: store }));
    expect(out).toMatchObject({ canonicalUrl: seed.canonicalUrl, ocrPagesWritten: 3, retirementStatus: "none" });

    const obj = await E.MANIFESTS_BUCKET.get(seed.canonicalKey);
    const text = await obj.text();
    expect(text).toBe(await heldText(seed));
    expect(obj.httpMetadata.contentType).toBe("application/ld+json");
    expect(obj.customMetadata.sha256).toBe(await sha256Hex(text));

    const desc = await one("SELECT * FROM descriptions WHERE id = ?", seed.descriptionId);
    expect(desc).toMatchObject({ iiif_manifest_url: seed.canonicalUrl, has_digital: 1, updated_by: seed.userId });
    const entries = await journal(seed.descriptionId);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("update");
    expect(entries[0].user_id).toBe(seed.userId);
    expect(JSON.parse(entries[0].diff).iiifManifestUrl).toEqual({ old: null, new: seed.canonicalUrl });

    const vol = await one("SELECT * FROM pipeline_volumes WHERE id = ?", seed.volumeId);
    expect(vol).toMatchObject({ state: "published", last_run_id: seed.runId });
    const pub = await one("SELECT * FROM pipeline_publications WHERE id = ?", out.publicationId);
    expect(pub).toMatchObject({ status: "published", ocr_pages_written: 3, retirement_status: "none" });
    expect(pub.published_at).not.toBeNull();

    const pages = await all("SELECT * FROM ocr_pages WHERE description_id = ? ORDER BY page_seq", seed.descriptionId);
    expect(pages.map((p) => [p.page_seq, p.run_id, p.source_key, p.alto_key, p.text])).toEqual(
      seed.pageKeys.map((k, i) => [
        i + 1,
        seed.runId,
        `${TEST_KEY_PREFIX}ocr/${seed.referenceCode}/txt/${k}.txt`,
        `${TEST_KEY_PREFIX}ocr/${seed.referenceCode}/alto/${k}.xml`,
        `Page text ${k}`,
      ]),
    );
  });

  it("publishes a volume without OCR and reads no OCR object", async () => {
    const seed = await seedReadyVolume({ ocr: false });
    const reads: string[] = [];
    const inner = getMediaObjectReader(E, fetch, TEST_TILES_TARGET);
    const reader = {
      getText: async (b: string, k: string) => {
        reads.push(k);
        return inner.getText(b, k);
      },
    };
    const out = await publish(seed, deps({ reader }));
    expect(out.ocrPagesWritten).toBe(0);
    expect(reads.filter((k) => k.startsWith("ocr/"))).toEqual([]);
    expect(await all("SELECT * FROM ocr_pages WHERE description_id = ?", seed.descriptionId)).toEqual([]);
    const pub = await one("SELECT * FROM pipeline_publications WHERE id = ?", out.publicationId);
    expect(pub.ocr_pages_written).toBeNull();
    expect((await one("SELECT state FROM pipeline_volumes WHERE id = ?", seed.volumeId)).state).toBe("published");
  });

  it("refuses a replay once published, without a second put", async () => {
    const seed = await seedReadyVolume();
    const store = recordingStore();
    const out = await publish(seed, deps({ canonical: store }));
    const etag = (await E.MANIFESTS_BUCKET.head(seed.canonicalKey)).etag;
    const before = await snapshotPipelineTables();
    const r = await refusal(publish(seed, deps({ canonical: store })));
    expect([r.code, r.status]).toEqual(["already_published", 409]);
    expect(r.detail).toEqual({ publication_id: out.publicationId });
    expect(await snapshotPipelineTables()).toEqual(before);
    expect((await E.MANIFESTS_BUCKET.head(seed.canonicalKey)).etag).toBe(etag);
    expect(store.calls.filter((c) => c === "put")).toHaveLength(1);
  });

  it("lets one of two concurrent publishes through", async () => {
    const seed = await seedReadyVolume();
    const store = recordingStore();
    const results = await Promise.allSettled([
      publish(seed, deps({ canonical: store })),
      publish(seed, deps({ canonical: store })),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(PublishRefusal);
    expect(["publish_in_progress", "already_published"]).toContain(refused[0].reason.code);
    expect(refused[0].reason.status).toBe(409);
    expect(store.calls.filter((c) => c === "put")).toHaveLength(1);
    expect(await journal(seed.descriptionId)).toHaveLength(1);
    const pubs = await rows(seed.volumeId);
    expect(pubs.filter((p) => p.status === "published")).toHaveLength(1);
    expect(pubs.filter((p) => p.status === "claimed" || p.status === "copying")).toHaveLength(0);
  });

  it("fails on a missing OCR object, leaves the volume ready, and publishes once it is there", async () => {
    const seed = await seedReadyVolume();
    const missing = `${TEST_KEY_PREFIX}ocr/${seed.referenceCode}/txt/${seed.pageKeys[1]}.txt`;
    await E.BUCKET.delete(missing);
    const descBefore = await one("SELECT * FROM descriptions WHERE id = ?", seed.descriptionId);
    const r = await refusal(publish(seed, deps()));
    expect([r.code, r.status]).toEqual(["ocr_missing_object", 400]);
    expect((await one("SELECT state FROM pipeline_volumes WHERE id = ?", seed.volumeId)).state).toBe("ready");
    expect(await canonicalBytes(seed)).toBeNull();
    const [failed] = await rows(seed.volumeId);
    expect(failed.status).toBe("failed");
    expect(JSON.parse(failed.error)).toMatchObject({ class: "ocr", code: "missing_object" });
    expect(await one("SELECT * FROM descriptions WHERE id = ?", seed.descriptionId)).toEqual(descBefore);
    expect(await journal(seed.descriptionId)).toEqual([]);

    await E.BUCKET.put(missing, `Page text ${seed.pageKeys[1]}`);
    await publish(seed, deps());
    expect((await rows(seed.volumeId)).map((p) => p.status).sort()).toEqual(["failed", "published"]);
  });

  it("replaces a description's migrated page-1 text and keeps it in Fisqua's bucket", async () => {
    const seed = await seedReadyVolume();
    const migratedText = "Texto migrado de la columna ocr_text, página única";
    await insertMigratedPage(seed, migratedText);
    const out = await publish(seed, deps());

    const pages = await all("SELECT page_seq, run_id, text FROM ocr_pages WHERE description_id = ? ORDER BY page_seq", seed.descriptionId);
    expect(pages.map((p) => [p.page_seq, p.run_id])).toEqual(seed.pageKeys.map((_, i) => [i + 1, seed.runId]));
    expect(pages.some((p) => p.text === migratedText)).toBe(false);

    const key = `${seed.tenantId}/pipeline-publications/${out.publicationId}/previous-ocr.txt`;
    const kept = await E.SPEC_BUCKET.get(key);
    const bytes = new Uint8Array(await kept.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toBe(migratedText);
    const pub = await one("SELECT * FROM pipeline_publications WHERE id = ?", out.publicationId);
    expect(pub).toMatchObject({
      status: "published",
      previous_ocr_copy_key: key,
      previous_ocr_sha256: await sha256Hex(bytes),
    });
    expect(pub.previous_ocr_sha256).toBe(await sha256Hex(migratedText));
  });

  it("refuses a migrated row that is not a bare page 1", async () => {
    const seed = await seedReadyVolume();
    const id = await insertMigratedPage(seed, "migrated text", { source_key: "legacy/p1.txt" });
    const r = await refusal(publish(seed, deps()));
    expect([r.code, r.status]).toEqual(["ocr_backfilled_text", 400]);
    expect(await all("SELECT id, text, run_id FROM ocr_pages WHERE description_id = ?", seed.descriptionId)).toEqual([
      { id, text: "migrated text", run_id: null },
    ]);
    expect(await canonicalBytes(seed)).toBeNull();
    const [row] = await rows(seed.volumeId);
    expect(row).toMatchObject({ status: "failed", previous_ocr_copy_key: null, previous_ocr_sha256: null });
    expect((await E.SPEC_BUCKET.list({ prefix: `${seed.tenantId}/pipeline-publications/` })).objects).toEqual([]);
  });

  it("refuses before any OCR write when keeping the migrated text fails", async () => {
    const seed = await seedReadyVolume();
    const id = await insertMigratedPage(seed, "migrated text");
    const ingested: string[] = [];
    const ingest: typeof ingestOcrPages = async (...args) => {
      ingested.push(args[2].descriptionId);
      return ingestOcrPages(...args);
    };
    const r = await refusal(publish(seed, deps({ specBucket: failingPreviousOcrPut(), ingest })));
    expect([r.code, r.status]).toEqual(["publish_failed", 503]);
    expect(ingested).toEqual([]);
    expect(await all("SELECT id, text, run_id FROM ocr_pages WHERE description_id = ?", seed.descriptionId)).toEqual([
      { id, text: "migrated text", run_id: null },
    ]);
    expect((await one("SELECT count(*) AS n FROM ocr_pages_staging")).n).toBe(0);
    const [row] = await rows(seed.volumeId);
    expect(row).toMatchObject({ status: "failed", previous_ocr_copy_key: null, previous_ocr_sha256: null });
    expect((await one("SELECT state FROM pipeline_volumes WHERE id = ?", seed.volumeId)).state).toBe("ready");
    expect(await canonicalBytes(seed)).toBeNull();
  });

  it("keeps the one copy of the migrated text when a publish fails after replacing it and a retry succeeds", async () => {
    const seed = await seedReadyVolume();
    await insertMigratedPage(seed, "migrated text");
    const r = await refusal(publish(seed, deps({ canonical: recordingStore({ putThrowsBefore: true }) })));
    expect(r.code).toBe("canonical_write_failed");
    const [first] = await rows(seed.volumeId);
    const key = `${seed.tenantId}/pipeline-publications/${first.id}/previous-ocr.txt`;
    expect(first).toMatchObject({
      status: "failed",
      previous_ocr_copy_key: key,
      previous_ocr_sha256: await sha256Hex("migrated text"),
    });
    expect(await all("SELECT run_id FROM ocr_pages WHERE description_id = ? AND run_id IS NULL", seed.descriptionId)).toEqual([]);

    const out = await publish(seed, deps());
    const second = await one("SELECT * FROM pipeline_publications WHERE id = ?", out.publicationId);
    expect(second).toMatchObject({ status: "published", previous_ocr_copy_key: null, previous_ocr_sha256: null });
    expect(await one("SELECT * FROM pipeline_publications WHERE id = ?", first.id)).toMatchObject({
      previous_ocr_copy_key: key,
      previous_ocr_sha256: await sha256Hex("migrated text"),
    });
    const kept = (await E.SPEC_BUCKET.list({ prefix: `${seed.tenantId}/pipeline-publications/` })).objects.map(
      (o: { key: string }) => o.key,
    );
    expect(kept).toEqual([key]);
    expect(await (await E.SPEC_BUCKET.get(key)).text()).toBe("migrated text");
  });

  it("fails after the OCR ingest when the record write throws, and a retry keeps the pages", async () => {
    const seed = await seedReadyVolume();
    let thrown = false;
    const d1 = wrapD1(env.DB, {
      before(text) {
        if (!thrown && RECORD_SQL.test(text)) {
          thrown = true;
          throw new Error("D1 unavailable");
        }
      },
    });
    const r = await refusal(publish(seed, deps({ db: drizzle(d1, { schema }) })));
    expect([r.code, r.status, r.detail]).toEqual(["publish_failed", 503, {}]);
    expect((await rows(seed.volumeId))[0].status).toBe("failed");
    expect((await one("SELECT state FROM pipeline_volumes WHERE id = ?", seed.volumeId)).state).toBe("ready");
    expect(await canonicalBytes(seed)).toBeNull();
    const pagesBefore = await all("SELECT id, created_at FROM ocr_pages WHERE description_id = ? ORDER BY page_seq", seed.descriptionId);
    expect(pagesBefore).toHaveLength(3);

    await publish(seed, deps());
    expect(
      await all("SELECT id, created_at FROM ocr_pages WHERE description_id = ? ORDER BY page_seq", seed.descriptionId),
    ).toEqual(pagesBefore);
  });

  it("fails a claim whose record write committed and then threw, and an ingest that threw a plain error", async () => {
    const seed = await seedReadyVolume();
    let thrown = false;
    const d1 = wrapD1(env.DB, {
      after(text) {
        if (!thrown && RECORD_SQL.test(text)) {
          thrown = true;
          throw new Error("lost response");
        }
      },
    });
    const store = recordingStore();
    const r = await refusal(publish(seed, deps({ db: drizzle(d1, { schema }), canonical: store })));
    expect([r.code, r.status]).toEqual(["publish_failed", 503]);
    const [row] = await rows(seed.volumeId);
    expect(row.status).toBe("failed");
    expect(row.copying_at).not.toBeNull();
    expect(store.calls).not.toContain("put");

    const seed2 = await seedReadyVolume();
    const r2 = await refusal(
      publish(seed2, deps({ ingest: async () => { throw new Error("boom"); } })),
    );
    expect([r2.code, r2.status]).toEqual(["publish_failed", 503]);
    expect((await rows(seed2.volumeId))[0].status).toBe("failed");
  });

  it("fails cleanly when the canonical put throws without writing", async () => {
    const seed = await seedReadyVolume();
    const descBefore = await one("SELECT * FROM descriptions WHERE id = ?", seed.descriptionId);
    const r = await refusal(publish(seed, deps({ canonical: recordingStore({ putThrowsBefore: true }) })));
    expect([r.code, r.status]).toEqual(["canonical_write_failed", 503]);
    expect((await rows(seed.volumeId))[0].status).toBe("failed");
    expect((await one("SELECT state FROM pipeline_volumes WHERE id = ?", seed.volumeId)).state).toBe("ready");
    expect(await canonicalBytes(seed)).toBeNull();
    expect(await one("SELECT * FROM descriptions WHERE id = ?", seed.descriptionId)).toEqual(descBefore);
  });

  it("rolls forward when the canonical put wrote and then threw", async () => {
    const seed = await seedReadyVolume();
    const store = recordingStore({ putThrowsAfter: true });
    await publish(seed, deps({ canonical: store }));
    expect(store.calls).toContain("head");
    expect((await one("SELECT state FROM pipeline_volumes WHERE id = ?", seed.volumeId)).state).toBe("published");
    expect((await rows(seed.volumeId))[0].status).toBe("published");
  });

  it("refuses when another writer filled the canonical key after the read", async () => {
    const seed = await seedReadyVolume();
    const other = new TextEncoder().encode('{"other":"writer"}');
    const descBefore = await one("SELECT * FROM descriptions WHERE id = ?", seed.descriptionId);
    const r = await refusal(publish(seed, deps({ canonical: recordingStore({ interfere: other }) })));
    expect([r.code, r.status]).toEqual(["canonical_conflict", 409]);
    expect(await canonicalBytes(seed)).toEqual(other);
    const [row] = await rows(seed.volumeId);
    expect(row.status).toBe("failed");
    expect(JSON.parse(row.error).class).toBe("canonical_conflict");
    expect((await one("SELECT state FROM pipeline_volumes WHERE id = ?", seed.volumeId)).state).toBe("ready");
    expect(await one("SELECT * FROM descriptions WHERE id = ?", seed.descriptionId)).toEqual(descBefore);
  });

  it("leaves the row copying when the final batch fails after the put", async () => {
    const seed = await seedReadyVolume();
    let failed = false;
    const d1 = wrapD1(env.DB, {
      batch(n) {
        if (!failed && n === 4) {
          failed = true;
          throw new Error("D1 unavailable");
        }
      },
    });
    const descBefore = await one("SELECT * FROM descriptions WHERE id = ?", seed.descriptionId);
    const r = await refusal(publish(seed, deps({ db: drizzle(d1, { schema }) })));
    expect([r.code, r.status]).toEqual(["publish_incomplete", 503]);
    expect(new TextDecoder().decode((await canonicalBytes(seed))!)).toBe(await heldText(seed));
    expect((await one("SELECT state FROM pipeline_volumes WHERE id = ?", seed.volumeId)).state).toBe("ready");
    expect((await rows(seed.volumeId))[0].status).toBe("copying");
    expect(await one("SELECT * FROM descriptions WHERE id = ?", seed.descriptionId)).toEqual(descBefore);
    expect(await journal(seed.descriptionId)).toEqual([]);
  });

  it("rolls the final batch back when the claim was lost", async () => {
    const seed = await seedReadyVolume();
    let failed = false;
    const d1 = wrapD1(env.DB, {
      batch(n) {
        if (!failed && n === 4) {
          failed = true;
          throw new Error("D1 unavailable");
        }
      },
    });
    await refusal(publish(seed, deps({ db: drizzle(d1, { schema }) })));
    const [row] = await rows(seed.volumeId);
    await env.DB.prepare("UPDATE pipeline_publications SET claim_id = 'taken' WHERE id = ?").bind(row.id).run();
    const input = await finalInputFromRow(db(), {
      ...(await db().query.pipelinePublications.findFirst({ where: (p, { eq }) => eq(p.id, row.id) }))!,
      claimId: row.claim_id,
    });
    const snap = async () => ({
      v: await one("SELECT * FROM pipeline_volumes WHERE id = ?", seed.volumeId),
      d: await one("SELECT * FROM descriptions WHERE id = ?", seed.descriptionId),
      j: await journal(seed.descriptionId),
      p: await rows(seed.volumeId),
    });
    const before = await snap();
    await expect(db().batch(buildFinalStatements(db(), input!, Date.now()) as any)).rejects.toThrow();
    expect(await snap()).toEqual(before);
  });

  it("rolls the final batch back when the volume was flagged restricted", async () => {
    const seed = await seedReadyVolume();
    let failed = false;
    const d1 = wrapD1(env.DB, {
      batch(n) {
        if (!failed && n === 4) {
          failed = true;
          throw new Error("D1 unavailable");
        }
      },
    });
    await refusal(publish(seed, deps({ db: drizzle(d1, { schema }) })));
    const [row] = await rows(seed.volumeId);
    await env.DB.prepare("UPDATE pipeline_volumes SET restricted = 1 WHERE id = ?").bind(seed.volumeId).run();
    const input = await finalInputFromRow(
      db(),
      (await db().query.pipelinePublications.findFirst({ where: (p, { eq }) => eq(p.id, row.id) }))!,
    );
    const snap = async () => ({
      v: await one("SELECT * FROM pipeline_volumes WHERE id = ?", seed.volumeId),
      d: await one("SELECT * FROM descriptions WHERE id = ?", seed.descriptionId),
      j: await journal(seed.descriptionId),
      p: await rows(seed.volumeId),
    });
    const before = await snap();
    await expect(db().batch(buildFinalStatements(db(), input!, Date.now()) as any)).rejects.toThrow();
    expect(await snap()).toEqual(before);
  });

  it("preserves a legacy IIIF 3 manifest at the canonical key and records its image roots", async () => {
    const legacy = legacyIiif3(["https://tiles.test.example/cdip-00001"]);
    const seed = await seedReadyVolume({ withPreviousCanonical: legacy });
    const store = recordingStore();
    const out = await publish(seed, deps({ canonical: store }));
    expect(out.retirementStatus).toBe("pending");
    const copyKey = `${seed.tenantId}/pipeline-publications/${out.publicationId}/previous-manifest.json`;
    const kept = new Uint8Array(await (await E.SPEC_BUCKET.get(copyKey)).arrayBuffer());
    expect(kept).toEqual(legacy);
    const pub = await one("SELECT * FROM pipeline_publications WHERE id = ?", out.publicationId);
    expect(pub).toMatchObject({
      previous_manifest_sha256: await sha256Hex(legacy),
      previous_manifest_copy_key: copyKey,
      previous_catalogue_url: null,
      retirement_status: "pending",
    });
    expect(pub.previous_manifest_etag).toBeTruthy();
    expect(JSON.parse(pub.previous_image_roots)).toEqual(["https://tiles.test.example/cdip-00001"]);
    const [entry] = await journal(seed.descriptionId);
    expect(JSON.parse(entry.diff)).toEqual({ hasDigital: { old: false, new: true } });
    expect([...new Set(store.calls)].sort()).toEqual(["get", "put"]);
  });

  it("reads the image roots of a legacy IIIF 2 manifest", async () => {
    const seed = await seedReadyVolume({ withPreviousCanonical: legacyIiif2("https://tiles.test.example/cdip-00001") });
    const out = await publish(seed, deps());
    const pub = await one("SELECT * FROM pipeline_publications WHERE id = ?", out.publicationId);
    expect(JSON.parse(pub.previous_image_roots)).toEqual(["https://tiles.test.example/cdip-00001"]);
  });

  it("preserves previous bytes that are not JSON and records no roots", async () => {
    const junk = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
    const seed = await seedReadyVolume({ withPreviousCanonical: junk });
    const out = await publish(seed, deps());
    const pub = await one("SELECT * FROM pipeline_publications WHERE id = ?", out.publicationId);
    expect(pub.previous_image_roots).toBeNull();
    expect(pub.retirement_status).toBe("pending");
    const kept = new Uint8Array(await (await E.SPEC_BUCKET.get(pub.previous_manifest_copy_key)).arrayBuffer());
    expect(kept).toEqual(junk);
  });

  it("records a different catalogue URL as the previous chain", async () => {
    const other = "https://manifests.zasqua.org/iiif/older/manifest.json";
    const seed = await seedReadyVolume({ previousCatalogueUrl: other });
    const out = await publish(seed, deps());
    const pub = await one("SELECT * FROM pipeline_publications WHERE id = ?", out.publicationId);
    expect(pub).toMatchObject({ previous_catalogue_url: other, previous_manifest_copy_key: null, retirement_status: "pending" });
    const [entry] = await journal(seed.descriptionId);
    expect(JSON.parse(entry.diff).iiifManifestUrl.old).toBe(other);
  });

  it("leaves the description and the journal alone when the catalogue already points at the manifest", async () => {
    const seed = await seedReadyVolume();
    await env.DB.prepare("UPDATE descriptions SET iiif_manifest_url = ?, has_digital = 1 WHERE id = ?")
      .bind(seed.canonicalUrl, seed.descriptionId)
      .run();
    const descBefore = await one("SELECT * FROM descriptions WHERE id = ?", seed.descriptionId);
    const sizes: number[] = [];
    const d1 = wrapD1(env.DB, { batch: (n) => sizes.push(n) });
    await publish(seed, deps({ db: drizzle(d1, { schema }) }));
    expect(sizes[sizes.length - 1]).toBe(2);
    expect(await one("SELECT * FROM descriptions WHERE id = ?", seed.descriptionId)).toEqual(descBefore);
    expect(await journal(seed.descriptionId)).toEqual([]);
    expect((await one("SELECT state FROM pipeline_volumes WHERE id = ?", seed.volumeId)).state).toBe("published");
    expect((await rows(seed.volumeId))[0].status).toBe("published");
  });

  it("leaves the new chain's own root out of the previous roots", async () => {
    const probe = await seedReadyVolume();
    const own = `${TEST_IMAGE_BASE}/neogranadina/${probe.referenceCode}`;
    expect(extractImageRoots(legacyIiif3([own, "https://tiles.test.example/cdip-00002"], false), own)).toEqual([
      "https://tiles.test.example/cdip-00002",
    ]);
    const prefix = `co-own-${crypto.randomUUID().slice(0, 6)}`;
    const ref = `${prefix}-001`;
    const seed = await seedReadyVolume({
      codePrefix: prefix,
      withPreviousCanonical: legacyIiif3([`${TEST_IMAGE_BASE}/neogranadina/${ref}`, "https://tiles.test.example/cdip-00002"]),
    });
    const out = await publish(seed, deps());
    const pub = await one("SELECT * FROM pipeline_publications WHERE id = ?", out.publicationId);
    expect(JSON.parse(pub.previous_image_roots)).toEqual(["https://tiles.test.example/cdip-00002"]);
  });

  it("rewrites its own earlier copy, and refuses the same bytes no publication of this volume wrote", async () => {
    const seed = await seedReadyVolume();
    const text = await heldText(seed);
    await E.MANIFESTS_BUCKET.put(seed.canonicalKey, text);
    await publication(seed, { status: "failed", manifest_sha256: await sha256Hex(text) });
    const out = await publish(seed, deps());
    expect(out.retirementStatus).toBe("none");
    const pub = await one("SELECT * FROM pipeline_publications WHERE id = ?", out.publicationId);
    expect(pub.previous_manifest_copy_key).toBeNull();

    const seed2 = await seedReadyVolume();
    await E.MANIFESTS_BUCKET.put(seed2.canonicalKey, await heldText(seed2));
    const r = await refusal(publish(seed2, deps()));
    expect([r.code, r.status, r.detail]).toEqual(["canonical_not_owned", 409, {}]);
  });

  it("refuses a second tenant's publish onto a canonical key the first tenant holds", async () => {
    // Keys sit under each tenant's slug, so this needs a spec that names
    // the first tenant's key; the ownership check is the backstop.
    const prefix = `co-two-${crypto.randomUUID().slice(0, 6)}`;
    const first = await seedReadyVolume({ codePrefix: prefix });
    const second = await seedReadyVolume({ tenantId: DACS_TEST_TENANT_ID, codePrefix: prefix, keySlug: "neogranadina" });
    expect(second.canonicalKey).toBe(first.canonicalKey);
    const store = recordingStore();
    await publish(first, deps({ canonical: store }));
    expect((await all("SELECT DISTINCT tenant_id FROM pipeline_publications")).map((r) => r.tenant_id)).toEqual([
      first.tenantId,
    ]);
    const secondBefore = {
      v: await one("SELECT * FROM pipeline_volumes WHERE id = ?", second.volumeId),
      d: await one("SELECT * FROM descriptions WHERE id = ?", second.descriptionId),
      o: await all("SELECT * FROM ocr_pages WHERE description_id = ?", second.descriptionId),
    };
    expect(secondBefore.o).toEqual([]);
    const firstBefore = {
      v: await one("SELECT * FROM pipeline_volumes WHERE id = ?", first.volumeId),
      d: await one("SELECT * FROM descriptions WHERE id = ?", first.descriptionId),
      p: await rows(first.volumeId),
    };
    const head = await E.MANIFESTS_BUCKET.head(first.canonicalKey);
    const bytes = await canonicalBytes(first);

    const r = await refusal(publish(second, deps({ canonical: store })));
    expect([r.code, r.status, r.detail]).toEqual(["canonical_not_owned", 409, {}]);
    expect((await E.MANIFESTS_BUCKET.head(first.canonicalKey)).etag).toBe(head.etag);
    expect(await canonicalBytes(first)).toEqual(bytes);
    expect({
      v: await one("SELECT * FROM pipeline_volumes WHERE id = ?", first.volumeId),
      d: await one("SELECT * FROM descriptions WHERE id = ?", first.descriptionId),
      p: await rows(first.volumeId),
    }).toEqual(firstBefore);
    expect(await rows(second.volumeId)).toEqual([]);
    expect(store.calls.filter((c) => c === "put")).toHaveLength(1);
    const listed = await E.SPEC_BUCKET.list({ prefix: `${second.tenantId}/pipeline-publications/` });
    expect(listed.objects).toEqual([]);
  });

  it("publishes a 734-page volume within the query budget", async () => {
    const seed = await seedReadyVolume({ pages: 734 });
    const counter = { n: 0 };
    const sizes: number[] = [];
    const d1 = wrapD1(env.DB, { counter, batch: (n) => sizes.push(n) });
    const plain = drizzle(env.DB, { schema });
    const out = await publish(
      seed,
      deps({
        db: drizzle(d1, { schema }),
        ingest: (_db, reader, input) => ingestOcrPages(plain, reader, input),
      }),
    );
    expect(out.ocrPagesWritten).toBe(734);
    // A batch counts as one query, as D1 counts it.
    expect(counter.n).toBeLessThanOrEqual(14);
    expect(sizes[sizes.length - 1]).toBe(4);
    const [row] = await rows(seed.volumeId);
    const input = await finalInputFromRow(db(), {
      ...(await db().query.pipelinePublications.findFirst({ where: (p, { eq }) => eq(p.id, row.id) }))!,
    });
    const statements = buildFinalStatements(db(), { ...input!, descriptionBefore: { iiifManifestUrl: null, hasDigital: false } }, Date.now());
    expect(statements).toHaveLength(4);
    for (const s of statements) expect(params(s).length).toBeLessThanOrEqual(100);
  });
});
