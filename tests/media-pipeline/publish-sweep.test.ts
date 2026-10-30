/**
 * Tests — publishing a ready volume: publications that stalled
 *
 * A publish can stop part way: a `claimed` row whose request died, or a
 * `copying` row whose canonical put may have happened while its final
 * batch did not. This suite pins how such rows are finished or failed,
 * by the scheduled sweep and by a later publish request of the same
 * volume.
 *
 * A `claimed` row past its expiry is abandoned. A `copying` row past its
 * expiry is decided by reading the canonical key: the publication's own
 * bytes there finish the publish (volume, description and journal), as
 * long as the volume has not been flagged restricted since; an untouched
 * key fails the row; bytes someone else wrote, or a volume flagged
 * restricted, mark the row for a person and the sweep stops
 * selecting it; a read that fails counts an attempt, and a row that
 * keeps failing stops being selected after eight. Rows a person must
 * decide never keep a newer row from being reached.
 *
 * A request can also lose its claim between recording the copy and
 * making it: a newer request finds the row past its expiry with the key
 * still empty and fails it as `copy_not_made`, then the older request's
 * put lands and the newer one's is refused. The sweep also visits such
 * failed rows: the publication's own bytes at the key finish the
 * publish, under the same restriction check; anything else counts an
 * attempt, so the row stops being selected after eight.
 *
 * The sweep checks each row against the canonical store of the row's
 * own tenant; a row whose tenant has no storage destination is left as
 * it is and counts an attempt.
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
  seedPipelineRun,
  insertRow,
  wrapD1,
  TEST_MANIFEST_BASE,
  TEST_KEY_PREFIX,
  type ReadyVolume,
  TEST_TILES_TARGET,
  TEST_TILES_BUCKET,
} from "../helpers/media-pipeline";
import { DACS_TEST_TENANT_ID } from "../../app/lib/tenant";
import { getMediaObjectReader } from "../../app/lib/pipeline/store.server";
import {
  r2CanonicalManifestStore,
  prefixLocator,
  type CanonicalManifestStore,
} from "../../app/lib/pipeline/canonical.server";
import {
  publishVolume,
  PublishRefusal,
  PUBLISH_CLAIM_TTL_MS,
  type PublishDeps,
} from "../../app/lib/pipeline/publish.server";
import { runPipelineSweep } from "../../app/lib/pipeline/sweep.server";

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

function sweep(now: number, canonical: CanonicalManifestStore = r2CanonicalManifestStore(E.MANIFESTS_BUCKET)) {
  return runPipelineSweep({
    db: drizzle(env.DB),
    reader: { getText: async () => null },
    now,
    workingBucket: "test-working",
    canonicalFor: async () => canonical,
  });
}

function publish(seed: ReadyVolume, d: PublishDeps = deps()) {
  return publishVolume(d, { id: seed.tenantId }, { id: seed.userId }, { volumeId: seed.volumeId, runId: seed.runId });
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

async function one(q: string, ...b: unknown[]): Promise<Record<string, any>> {
  return (await env.DB.prepare(q).bind(...b).first()) as Record<string, any>;
}
async function all(q: string, ...b: unknown[]): Promise<Array<Record<string, any>>> {
  return (await env.DB.prepare(q).bind(...b).all()).results as Array<Record<string, any>>;
}
const pubs = (volumeId: string) =>
  all("SELECT * FROM pipeline_publications WHERE pipeline_volume_id = ? ORDER BY claimed_at, id", volumeId);
const journal = (descriptionId: string) => all("SELECT * FROM changelog WHERE record_id = ?", descriptionId);

/** A canonical store whose puts wait until released. */
function gated(inner: CanonicalManifestStore) {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const atPut = new Promise<void>((r) => (reached = r));
  const store: CanonicalManifestStore = {
    head: (k) => inner.head(k),
    get: (k) => inner.get(k),
    put: async (...a) => {
      reached();
      await released;
      return inner.put(...a);
    },
  };
  return { store, atPut, release };
}

/**
 * The state a claim lost between the record and the copy leaves. Request
 * A records its copy and stalls before its put. Request B, past A's
 * expiry, finds the key empty, fails A's row as `copy_not_made`, claims,
 * records, and stalls before its own put. A's put then lands and its
 * final batch is refused; B's put is refused by its condition. The
 * manifest is at the canonical key, the volume is still ready, and no
 * row is in flight.
 */
async function lostClaim(seed: ReadyVolume): Promise<{ a: Record<string, any>; b: Record<string, any> }> {
  const inner = r2CanonicalManifestStore(E.MANIFESTS_BUCKET);
  const ga = gated(inner);
  const gb = gated(inner);
  const t0 = Date.now();
  const pa = refusal(publish(seed, deps({ canonical: ga.store, now: () => t0 })));
  await ga.atPut;
  const later = t0 + PUBLISH_CLAIM_TTL_MS + MIN;
  const pb = refusal(publish(seed, deps({ canonical: gb.store, now: () => later })));
  await gb.atPut;
  ga.release();
  const ra = await pa;
  expect([ra.code, ra.status]).toEqual(["publish_in_progress", 409]);
  gb.release();
  const rb = await pb;
  expect([rb.code, rb.status]).toEqual(["canonical_conflict", 409]);
  const [a, b] = await pubs(seed.volumeId);
  expect(a).toMatchObject({ status: "failed", needs_person: 0 });
  expect(JSON.parse(a.error).class).toBe("copy_not_made");
  expect(b.status).toBe("failed");
  expect(JSON.parse(b.error).class).toBe("canonical_conflict");
  expect((await inner.head(seed.canonicalKey))?.sha256).toBe(a.manifest_sha256);
  expect((await one("SELECT state FROM pipeline_volumes WHERE id = ?", seed.volumeId)).state).toBe("ready");
  return { a, b };
}

/** The state a publish leaves when its final batch fails after the put. */
async function stalledAfterCopy(seed: ReadyVolume): Promise<Record<string, any>> {
  let failed = false;
  const d1 = wrapD1(env.DB, {
    batch(n) {
      if (!failed && n === 4) {
        failed = true;
        throw new Error("D1 unavailable");
      }
    },
  });
  const r = await refusal(publish(seed, deps({ db: drizzle(d1, { schema }) })));
  expect(r.code).toBe("publish_incomplete");
  const [row] = await pubs(seed.volumeId);
  expect(row.status).toBe("copying");
  return row;
}

async function age(id: string, field: "claimed_at" | "copying_at", ms: number): Promise<void> {
  await env.DB.prepare(`UPDATE pipeline_publications SET ${field} = ? WHERE id = ?`).bind(Date.now() - ms, id).run();
}

function row(seed: { tenantId: string; volumeId: string; runId: string; runVolumeId: string; userId: string; canonicalKey: string }, over: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    tenant_id: seed.tenantId,
    pipeline_volume_id: seed.volumeId,
    run_id: seed.runId,
    run_volume_id: seed.runVolumeId,
    user_id: seed.userId,
    status: "claimed",
    claim_id: crypto.randomUUID(),
    canonical_url: `${TEST_MANIFEST_BASE}/${seed.canonicalKey}`,
    canonical_key: seed.canonicalKey,
    manifest_sha256: "0".repeat(64),
    canonical_expect: JSON.stringify({ absent: true }),
    claimed_at: Date.now(),
    ...over,
  };
}

describe("stalled publications", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedFederations();
  });

  it("abandons an expired claim and leaves fresh claims and fresh copies alone", async () => {
    const a = await seedReadyVolume();
    const b = await seedReadyVolume();
    const c = await seedReadyVolume();
    const now = Date.now();
    const old = row(a, { claimed_at: now - 31 * MIN });
    const fresh = row(b, { claimed_at: now - 5 * MIN });
    const copying = row(c, { status: "copying", claimed_at: now - 40 * MIN, copying_at: now - 5 * MIN });
    for (const r of [old, fresh, copying]) await insertRow("pipeline_publications", r);
    const counts = await sweep(now);
    expect(counts.publicationsResolved).toBe(1);
    const [x] = await pubs(a.volumeId);
    expect(x.status).toBe("abandoned");
    expect(JSON.parse(x.error).class).toBe("claim_expired");
    expect((await pubs(b.volumeId))[0].status).toBe("claimed");
    expect((await pubs(c.volumeId))[0]).toMatchObject({ status: "copying", resolve_attempts: 0 });
  });

  it("finishes a stalled publish whose manifest is at the canonical key", async () => {
    const seed = await seedReadyVolume();
    const stalled = await stalledAfterCopy(seed);
    await age(stalled.id, "copying_at", 31 * MIN);
    const counts = await sweep(Date.now());
    expect(counts.publicationsResolved).toBe(1);
    expect((await one("SELECT state FROM pipeline_volumes WHERE id = ?", seed.volumeId)).state).toBe("published");
    expect((await one("SELECT iiif_manifest_url FROM descriptions WHERE id = ?", seed.descriptionId)).iiif_manifest_url).toBe(
      seed.canonicalUrl,
    );
    const entries = await journal(seed.descriptionId);
    expect(entries).toHaveLength(1);
    expect(entries[0].user_id).toBe(seed.userId);
    expect((await pubs(seed.volumeId))[0].status).toBe("published");
  });

  it("fails a stalled copy that never reached the canonical key, and the volume publishes again", async () => {
    const seed = await seedReadyVolume();
    await insertRow(
      "pipeline_publications",
      row(seed, {
        status: "copying",
        claimed_at: Date.now() - 40 * MIN,
        copying_at: Date.now() - 31 * MIN,
        description_before: JSON.stringify({ iiifManifestUrl: null, hasDigital: false }),
      }),
    );
    expect((await sweep(Date.now())).publicationsResolved).toBe(1);
    const [r] = await pubs(seed.volumeId);
    expect(r.status).toBe("failed");
    expect(JSON.parse(r.error).class).toBe("copy_not_made");
    expect((await one("SELECT state FROM pipeline_volumes WHERE id = ?", seed.volumeId)).state).toBe("ready");
    await publish(seed);
    expect((await one("SELECT state FROM pipeline_volumes WHERE id = ?", seed.volumeId)).state).toBe("published");
  });

  it("holds a stalled copy for a person when someone else's bytes are at the key", async () => {
    const seed = await seedReadyVolume();
    const stalled = await stalledAfterCopy(seed);
    await E.MANIFESTS_BUCKET.put(seed.canonicalKey, '{"third":"party"}');
    await age(stalled.id, "copying_at", 31 * MIN);
    expect((await sweep(Date.now())).publicationsUnresolved).toBe(1);
    const [r] = await pubs(seed.volumeId);
    expect(r).toMatchObject({ status: "copying", needs_person: 1 });
    expect(JSON.parse(r.error).class).toBe("canonical_changed");
    const p = await refusal(publish(seed));
    expect([p.code, p.status]).toEqual(["publish_in_progress", 409]);
    const before = await pubs(seed.volumeId);
    const counts = await sweep(Date.now());
    expect(counts.publicationsResolved + counts.publicationsUnresolved).toBe(0);
    expect(await pubs(seed.volumeId)).toEqual(before);
  });

  it("counts a failed read of the key and stops selecting the row after eight", async () => {
    const seed = await seedReadyVolume();
    const stalled = await stalledAfterCopy(seed);
    await age(stalled.id, "copying_at", 31 * MIN);
    const failing: CanonicalManifestStore = {
      head: async () => {
        throw new Error("unreachable");
      },
      get: async () => null,
      put: async () => null,
    };
    const before = (await pubs(seed.volumeId))[0];
    const first = await sweep(Date.now(), failing);
    expect(first.publicationsUnresolved).toBe(1);
    const after = (await pubs(seed.volumeId))[0];
    expect(after).toEqual({ ...before, resolve_attempts: 1 });
    for (let i = 2; i <= 8; i++) await sweep(Date.now(), failing);
    expect((await pubs(seed.volumeId))[0].resolve_attempts).toBe(8);
    const ninth = await sweep(Date.now(), failing);
    expect(ninth.publicationsUnresolved).toBe(0);
    expect((await pubs(seed.volumeId))[0].resolve_attempts).toBe(8);
  });

  it("reaches a newer stalled row behind twenty that wait for a person", async () => {
    const now = Date.now();
    const a = await seedPipelineRun({ volumeCount: 11 });
    const b = await seedPipelineRun({ volumeCount: 10, tenantId: DACS_TEST_TENANT_ID });
    const seeded = [
      ...a.volumes.map((v) => ({ run: a, v })),
      ...b.volumes.map((v) => ({ run: b, v })),
    ];
    const ids: string[] = [];
    for (let i = 0; i < seeded.length; i++) {
      const { run, v } = seeded[i];
      const newest = i === seeded.length - 1;
      const r = row(
        {
          tenantId: run.tenantId,
          volumeId: v.id,
          runId: run.runId,
          runVolumeId: v.runVolumeId,
          userId: run.userId,
          canonicalKey: `iiif/${v.referenceCode}/manifest.json`,
        },
        {
          status: "copying",
          claimed_at: now - 120 * MIN + i,
          copying_at: now - (newest ? 31 : 100) * MIN + i,
          needs_person: newest ? 0 : 1,
          description_before: JSON.stringify({ iiifManifestUrl: null, hasDigital: false }),
        },
      );
      ids.push(r.id);
      await insertRow("pipeline_publications", r);
    }
    expect(ids).toHaveLength(21);
    const counts = await sweep(now);
    expect(counts.publicationsResolved).toBe(1);
    const newest = await one("SELECT status FROM pipeline_publications WHERE id = ?", ids[20]);
    expect(newest.status).toBe("failed");
  });

  it("lets a publish request resolve an expired claim and go on", async () => {
    const seed = await seedReadyVolume();
    const fresh = row(seed, { claimed_at: Date.now() - 5 * MIN });
    await insertRow("pipeline_publications", fresh);
    const before = await pubs(seed.volumeId);
    const p = await refusal(publish(seed));
    expect([p.code, p.status]).toEqual(["publish_in_progress", 409]);
    expect(await pubs(seed.volumeId)).toEqual(before);

    await age(fresh.id, "claimed_at", 31 * MIN);
    await publish(seed);
    const rows = await pubs(seed.volumeId);
    const old = rows.find((r) => r.id === fresh.id)!;
    expect(old.status).toBe("abandoned");
    expect(JSON.parse(old.error).class).toBe("claim_expired");
    expect(rows.filter((r) => r.status === "published")).toHaveLength(1);
  });

  it("does not point the catalogue at a copy whose volume was flagged restricted", async () => {
    const seed = await seedReadyVolume();
    const stalled = await stalledAfterCopy(seed);
    await env.DB.prepare("UPDATE pipeline_volumes SET restricted = 1 WHERE id = ?").bind(seed.volumeId).run();
    const descBefore = await one("SELECT * FROM descriptions WHERE id = ?", seed.descriptionId);
    await age(stalled.id, "copying_at", 31 * MIN);
    expect((await sweep(Date.now())).publicationsUnresolved).toBe(1);
    const [r] = await pubs(seed.volumeId);
    expect(r).toMatchObject({ status: "copying", needs_person: 1 });
    expect(JSON.parse(r.error).class).toBe("restricted_after_copy");
    expect((await one("SELECT state FROM pipeline_volumes WHERE id = ?", seed.volumeId)).state).toBe("ready");
    expect(await one("SELECT * FROM descriptions WHERE id = ?", seed.descriptionId)).toEqual(descBefore);
    expect(await journal(seed.descriptionId)).toEqual([]);
  });

  it("finishes a publish whose claim was lost between recording the copy and making it", async () => {
    const seed = await seedReadyVolume();
    const { a, b } = await lostClaim(seed);
    const counts = await sweep(Date.now());
    expect(counts.publicationsResolved).toBe(1);
    expect((await one("SELECT state FROM pipeline_volumes WHERE id = ?", seed.volumeId)).state).toBe("published");
    expect((await one("SELECT iiif_manifest_url FROM descriptions WHERE id = ?", seed.descriptionId)).iiif_manifest_url).toBe(
      seed.canonicalUrl,
    );
    const entries = await journal(seed.descriptionId);
    expect(entries).toHaveLength(1);
    expect(entries[0].user_id).toBe(seed.userId);
    const after = await pubs(seed.volumeId);
    expect(after.find((r) => r.id === a.id)).toMatchObject({ status: "published", error: null });
    expect(after.find((r) => r.id === b.id)).toEqual(b);
    const again = await sweep(Date.now());
    expect(again.publicationsResolved + again.publicationsUnresolved).toBe(0);
    const r = await refusal(publish(seed));
    expect([r.code, r.status]).toEqual(["already_published", 409]);
  });

  it("holds a lost claim for a person when its volume was flagged restricted", async () => {
    const seed = await seedReadyVolume();
    const { a } = await lostClaim(seed);
    await env.DB.prepare("UPDATE pipeline_volumes SET restricted = 1 WHERE id = ?").bind(seed.volumeId).run();
    const descBefore = await one("SELECT * FROM descriptions WHERE id = ?", seed.descriptionId);
    expect((await sweep(Date.now())).publicationsUnresolved).toBe(1);
    const r = (await pubs(seed.volumeId)).find((x) => x.id === a.id)!;
    expect(r).toMatchObject({ status: "failed", needs_person: 1 });
    expect(JSON.parse(r.error).class).toBe("restricted_after_copy");
    expect((await one("SELECT state FROM pipeline_volumes WHERE id = ?", seed.volumeId)).state).toBe("ready");
    expect(await one("SELECT * FROM descriptions WHERE id = ?", seed.descriptionId)).toEqual(descBefore);
    expect(await journal(seed.descriptionId)).toEqual([]);
    const again = await sweep(Date.now());
    expect(again.publicationsResolved + again.publicationsUnresolved).toBe(0);
  });

  it("counts a failed copy whose key stays empty and stops selecting it after eight", async () => {
    const seed = await seedReadyVolume();
    await insertRow(
      "pipeline_publications",
      row(seed, {
        status: "copying",
        claimed_at: Date.now() - 40 * MIN,
        copying_at: Date.now() - 31 * MIN,
        description_before: JSON.stringify({ iiifManifestUrl: null, hasDigital: false }),
      }),
    );
    expect((await sweep(Date.now())).publicationsResolved).toBe(1);
    const failed = (await pubs(seed.volumeId))[0];
    expect(JSON.parse(failed.error).class).toBe("copy_not_made");
    for (let i = 1; i <= 8; i++) {
      const c = await sweep(Date.now());
      expect([c.publicationsResolved, c.publicationsUnresolved]).toEqual([0, 1]);
      expect((await pubs(seed.volumeId))[0]).toEqual({ ...failed, resolve_attempts: i });
    }
    const ninth = await sweep(Date.now());
    expect(ninth.publicationsResolved + ninth.publicationsUnresolved).toBe(0);
  });

  it("counts, and does not finish, a failed copy whose volume another publication published", async () => {
    const seed = await seedReadyVolume();
    await publish(seed);
    const [published] = await pubs(seed.volumeId);
    const stale = row(seed, {
      status: "failed",
      claimed_at: Date.now() - 60 * MIN,
      copying_at: Date.now() - 50 * MIN,
      finished_at: Date.now() - 20 * MIN,
      manifest_sha256: published.manifest_sha256,
      description_before: JSON.stringify({ iiifManifestUrl: null, hasDigital: false }),
      error: JSON.stringify({ class: "copy_not_made" }),
    });
    await insertRow("pipeline_publications", stale);
    const before = await one("SELECT * FROM pipeline_publications WHERE id = ?", stale.id);
    const descBefore = await one("SELECT * FROM descriptions WHERE id = ?", seed.descriptionId);
    expect((await sweep(Date.now())).publicationsUnresolved).toBe(1);
    expect(await one("SELECT * FROM pipeline_publications WHERE id = ?", stale.id)).toEqual({ ...before, resolve_attempts: 1 });
    expect(await one("SELECT * FROM pipeline_publications WHERE id = ?", published.id)).toEqual(published);
    expect(await one("SELECT * FROM descriptions WHERE id = ?", seed.descriptionId)).toEqual(descBefore);
  });

  it("lets the same publish request finish a stalled copy past its expiry", async () => {
    const seed = await seedReadyVolume();
    const puts: string[] = [];
    const inner = r2CanonicalManifestStore(E.MANIFESTS_BUCKET);
    const counting: CanonicalManifestStore = {
      head: (k) => inner.head(k),
      get: (k) => inner.get(k),
      put: (...a) => {
        puts.push(a[0]);
        return inner.put(...a);
      },
    };
    let failed = false;
    const d1 = wrapD1(env.DB, {
      batch(n) {
        if (!failed && n === 4) {
          failed = true;
          throw new Error("D1 unavailable");
        }
      },
    });
    await refusal(publish(seed, deps({ db: drizzle(d1, { schema }), canonical: counting })));
    const later = Date.now() + PUBLISH_CLAIM_TTL_MS + MIN;
    const r = await refusal(publish(seed, deps({ canonical: counting, now: () => later })));
    expect([r.code, r.status]).toEqual(["already_published", 409]);
    expect((await one("SELECT state FROM pipeline_volumes WHERE id = ?", seed.volumeId)).state).toBe("published");
    expect(await journal(seed.descriptionId)).toHaveLength(1);
    expect(puts).toHaveLength(1);
  });

  it("checks each row against its own tenant's store, and counts a row whose tenant has none", async () => {
    const seed = await seedReadyVolume();
    const stalled = await stalledAfterCopy(seed);
    await age(stalled.id, "copying_at", 31 * MIN);
    const asked: string[] = [];
    const none = await runPipelineSweep({
      db: drizzle(env.DB),
      reader: { getText: async () => null },
      now: Date.now(),
      workingBucket: "test-working",
      canonicalFor: async (tenantId) => {
        asked.push(tenantId);
        return null;
      },
    });
    expect(asked).toEqual([seed.tenantId]);
    expect(none.publicationsUnresolved).toBe(1);
    expect((await pubs(seed.volumeId))[0]).toMatchObject({ status: "copying", resolve_attempts: 1, needs_person: 0 });
    expect((await one("SELECT state FROM pipeline_volumes WHERE id = ?", seed.volumeId)).state).toBe("ready");

    const counts = await sweep(Date.now());
    expect(counts.publicationsResolved).toBe(1);
    expect((await one("SELECT state FROM pipeline_volumes WHERE id = ?", seed.volumeId)).state).toBe("published");
  });
});
