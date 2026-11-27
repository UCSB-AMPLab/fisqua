/**
 * Tests — per-fonds export fingerprints
 *
 * This suite checks that a per-fonds publish step (descriptions,
 * children, EAD3, Dublin Core) leaves its files alone when nothing it
 * writes can have changed since it last succeeded for the fonds, and
 * writes them again otherwise. Each case seeds one fonds, runs the four
 * steps through `runUnlessUnchanged` with the real exporters and an
 * in-memory bucket, changes one fingerprint input alone, and runs the
 * four steps again.
 *
 * Covered: an unchanged fonds skips every kind; each input, changed
 * alone, makes the fonds' steps run (a description's `updated_at`, its
 * `is_published`, a description added, one deleted, the repository,
 * `mets_base_url`, the federation's hosting statement, the live
 * reference codes for a fonds with former codes and only for its
 * descriptions step, the format version, the kind); a code going live
 * elsewhere that is not one of the fonds' former codes leaves the fonds
 * skipped, while one that is makes its descriptions step run; a missing main
 * object makes the step run; `force` runs every kind; writing one kind's
 * entry keeps the others'; a step that fails writes no entry; and an
 * edit made while a step runs makes the next run write again.
 *
 * @version v0.9.0
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import {
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
  applyMigrations,
  cleanDatabase,
} from "../helpers/db";
import {
  exportFondsDescriptions,
  exportFondsChildren,
  exportFondsEad,
  exportFondsDc,
  perFondsMainKey,
} from "../../app/lib/export/pipeline.server";
import {
  fondsFingerprint,
  fingerprintKey,
  readFingerprints,
  EXPORT_FORMAT_VERSION,
  runUnlessUnchanged,
  writeFingerprint,
  type FingerprintKind,
} from "../../app/lib/export/fingerprint.server";
import type { ExportStorage } from "../../app/lib/export/r2-client.server";
import type { ExportTenant } from "../../app/lib/export/types";
import { MemoryStorage } from "./memory-storage";

const TENANT: ExportTenant = {
  id: DEFAULT_TEST_TENANT_ID,
  federationId: DEFAULT_TEST_FEDERATION_ID,
  slug: "neogranadina",
  descriptiveStandard: "isadg",
};
const FONDS = "co-fp";
const KINDS: FingerprintKind[] = ["descriptions", "children", "ead", "dc"];
const REPO = "00000000-0000-4000-8000-00000000f001";
const ROOT = "00000000-0000-4000-8000-00000000f010";
const child = (i: number) => `00000000-0000-4000-8000-00000000f1${String(i).padStart(2, "0")}`;
const T0 = 1_700_000_000_000;

const db = drizzle(env.DB, { schema });

async function seed(options: { formerCodes?: boolean } = {}) {
  await cleanDatabase();
  await env.DB.prepare("UPDATE tenants SET mets_base_url = ? WHERE id = ?")
    .bind("https://mets.example.org/", TENANT.id)
    .run();
  await env.DB.prepare("UPDATE federations SET hosting_statement_es = ?, hosting_statement_en = ? WHERE id = ?")
    .bind("Alojado en X.", "Hosted on X.", TENANT.federationId)
    .run();
  await db.insert(schema.repositories).values({
    id: REPO, tenantId: TENANT.id, code: "co-fp-repo", name: "Archivo FP", enabled: true, createdAt: T0, updatedAt: T0,
  });
  await db.insert(schema.descriptions).values({
    id: ROOT, tenantId: TENANT.id, repositoryId: REPO, parentId: null, rootDescriptionId: ROOT,
    descriptionLevel: "fonds", referenceCode: FONDS, title: "Fondo FP", isPublished: true, childCount: 3,
    createdAt: T0, updatedAt: T0,
  });
  for (let i = 1; i <= 3; i++) {
    await db.insert(schema.descriptions).values({
      id: child(i), tenantId: TENANT.id, repositoryId: REPO, parentId: ROOT, rootDescriptionId: ROOT,
      descriptionLevel: "file", referenceCode: `${FONDS}-${i}`, title: `Expediente ${i}`,
      // The third is unpublished.
      isPublished: i < 3, position: i,
      legacyIds: options.formerCodes && i === 1
        ? JSON.stringify([{ provider: "former-reference-code", id: `${FONDS}-old-1` }])
        : "[]",
      createdAt: T0, updatedAt: T0,
    });
  }
}

/** Each kind's exporter, as the workflow calls it. */
function exporter(kind: FingerprintKind, storage: ExportStorage): () => Promise<object> {
  switch (kind) {
    case "descriptions": return () => exportFondsDescriptions(db, storage, FONDS, TENANT, [TENANT.id]);
    case "children": return () => exportFondsChildren(db, storage, FONDS, TENANT);
    case "ead": return () => exportFondsEad(db, storage, FONDS, TENANT);
    case "dc": return () => exportFondsDc(db, storage, FONDS, TENANT);
  }
}

interface RunOptions {
  force?: boolean;
  formatVersion?: number;
  exportId?: string;
}

/** Run one kind and say whether it was skipped. */
async function runKind(storage: MemoryStorage, kind: FingerprintKind, options: RunOptions = {}, run?: () => Promise<object>) {
  const r = await runUnlessUnchanged(
    {
      db,
      storage,
      tenant: TENANT,
      fondsCode: FONDS,
      kind,
      exportId: options.exportId ?? "run",
      mainKey: perFondsMainKey(kind, TENANT.slug, FONDS),
      force: options.force,
      formatVersion: options.formatVersion,
      memberTenantIds: [TENANT.id],
    },
    run ?? exporter(kind, storage as unknown as ExportStorage)
  );
  return r.skipped;
}

/** Run the four kinds in the workflow's order; which were skipped. */
async function runAll(storage: MemoryStorage, options: RunOptions = {}) {
  const skipped: Record<string, boolean> = {};
  for (const kind of KINDS) skipped[kind] = await runKind(storage, kind, options);
  return skipped;
}

const ALL_SKIPPED = { descriptions: true, children: true, ead: true, dc: true };
const NONE_SKIPPED = { descriptions: false, children: false, ead: false, dc: false };

describe("per-fonds fingerprints", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  let storage: MemoryStorage;
  beforeEach(async () => {
    storage = new MemoryStorage();
  });

  it("skips every kind of an unchanged fonds and returns the recorded counts", async () => {
    await seed();
    expect(await runAll(storage)).toEqual(NONE_SKIPPED);
    const puts = storage.objects.size;
    expect(await runAll(storage)).toEqual(ALL_SKIPPED);
    expect(storage.objects.size).toBe(puts);
    const marker = await readFingerprints(storage, TENANT.slug, FONDS);
    expect(Object.keys(marker).sort()).toEqual([...KINDS].sort());
    // The descriptions file holds the two published children and the root.
    const r = await runUnlessUnchanged(
      { db, storage, tenant: TENANT, fondsCode: FONDS, kind: "descriptions", exportId: "x",
        mainKey: perFondsMainKey("descriptions", TENANT.slug, FONDS) },
      exporter("descriptions", storage as unknown as ExportStorage)
    );
    expect(r).toMatchObject({ recordCount: 3, skipped: true });
  });

  const changes: Array<[string, () => Promise<unknown>]> = [
    ["a description's updated_at", () =>
      env.DB.prepare("UPDATE descriptions SET updated_at = updated_at + 1 WHERE id = ?").bind(child(1)).run()],
    ["a description's is_published", () =>
      env.DB.prepare("UPDATE descriptions SET is_published = 1 WHERE id = ?").bind(child(3)).run()],
    ["a description added", () =>
      db.insert(schema.descriptions).values({
        id: child(9), tenantId: TENANT.id, repositoryId: REPO, parentId: ROOT, rootDescriptionId: ROOT,
        descriptionLevel: "file", referenceCode: `${FONDS}-9`, title: "Expediente 9", isPublished: false,
        createdAt: T0, updatedAt: T0,
      })],
    ["a description deleted", () =>
      env.DB.prepare("DELETE FROM descriptions WHERE id = ?").bind(child(3)).run()],
    ["the repository", () =>
      env.DB.prepare("UPDATE repositories SET updated_at = updated_at + 1 WHERE id = ?").bind(REPO).run()],
    ["mets_base_url", () =>
      env.DB.prepare("UPDATE tenants SET mets_base_url = ? WHERE id = ?").bind("https://other.example.org/", TENANT.id).run()],
    ["the federation's hosting statement", () =>
      env.DB.prepare("UPDATE federations SET hosting_statement_en = ? WHERE id = ?").bind("Hosted on Y.", TENANT.federationId).run()],
  ];
  for (const [name, change] of changes) {
    it(`runs every kind when ${name} changes`, async () => {
      await seed();
      await runAll(storage);
      await change();
      expect(await runAll(storage)).toEqual(NONE_SKIPPED);
      expect(await runAll(storage)).toEqual(ALL_SKIPPED);
    });
  }

  /** A fonds-level description elsewhere in the tenant holding `code`. */
  const goLive = (code: string, n: number) =>
    db.insert(schema.descriptions).values({
      id: `00000000-0000-4000-8000-00000000f9${String(n).padStart(2, "0")}`, tenantId: TENANT.id, repositoryId: REPO,
      parentId: null, rootDescriptionId: `00000000-0000-4000-8000-00000000f9${String(n).padStart(2, "0")}`,
      descriptionLevel: "fonds", referenceCode: code, title: "Otro", isPublished: true, createdAt: T0, updatedAt: T0,
    });

  it("stays skipped when a code goes live that is not one of the fonds' former codes", async () => {
    await seed({ formerCodes: true });
    await runAll(storage);
    await goLive("co-elsewhere", 1);
    expect(await runAll(storage)).toEqual(ALL_SKIPPED);
  });

  it("runs the descriptions step, and only it, when one of the fonds' former codes goes live", async () => {
    await seed({ formerCodes: true });
    await runAll(storage);
    expect(await runAll(storage)).toEqual(ALL_SKIPPED);
    // An import elsewhere makes the former code live; its holder is untouched.
    await goLive(`${FONDS}-old-1`, 2);
    expect(await runAll(storage)).toEqual({ ...ALL_SKIPPED, descriptions: false });
    expect(await runAll(storage)).toEqual(ALL_SKIPPED);
  });

  it("reads the live codes in the member tenants it is given", async () => {
    await seed({ formerCodes: true });
    const own = await fondsFingerprint(db, TENANT, FONDS, "descriptions", { memberTenantIds: [TENANT.id] });
    await goLive(`${FONDS}-old-1`, 3);
    const after = await fondsFingerprint(db, TENANT, FONDS, "descriptions", { memberTenantIds: [TENANT.id] });
    const noMembers = await fondsFingerprint(db, TENANT, FONDS, "descriptions", { memberTenantIds: [] });
    expect(after).not.toBe(own);
    expect(noMembers).toBe(own);
  });

  it("runs every kind when the format version changes", async () => {
    await seed();
    await runAll(storage);
    expect(await runAll(storage, { formatVersion: EXPORT_FORMAT_VERSION + 1 })).toEqual(NONE_SKIPPED);
    expect(await runAll(storage, { formatVersion: EXPORT_FORMAT_VERSION + 1 })).toEqual(ALL_SKIPPED);
  });

  it("hashes the kind: one kind's fingerprint does not skip another", async () => {
    await seed();
    const fps = await Promise.all(KINDS.map((k) => fondsFingerprint(db, TENANT, FONDS, k)));
    expect(new Set(fps).size).toBe(KINDS.length);
    await runAll(storage);
    const marker = await readFingerprints(storage, TENANT.slug, FONDS);
    await writeFingerprint(storage, TENANT.slug, FONDS, "children", { ...marker.children, fingerprint: marker.descriptions.fingerprint });
    expect(await runAll(storage)).toEqual({ ...ALL_SKIPPED, children: false });
  });

  it("runs a step whose main object is missing even when the marker matches", async () => {
    await seed();
    await runAll(storage);
    for (const kind of KINDS) storage.objects.delete(perFondsMainKey(kind, TENANT.slug, FONDS));
    expect(await runAll(storage)).toEqual(NONE_SKIPPED);
    for (const kind of KINDS) expect(storage.objects.has(perFondsMainKey(kind, TENANT.slug, FONDS))).toBe(true);
  });

  it("runs every kind when forced, and records the fingerprints", async () => {
    await seed();
    await runAll(storage, { exportId: "first" });
    expect(await runAll(storage, { force: true, exportId: "forced" })).toEqual(NONE_SKIPPED);
    const marker = await readFingerprints(storage, TENANT.slug, FONDS);
    for (const kind of KINDS) expect(marker[kind].exportId).toBe("forced");
    expect(await runAll(storage)).toEqual(ALL_SKIPPED);
  });

  it("keeps the other kinds' entries when one kind's entry is written", async () => {
    await seed();
    await runAll(storage, { exportId: "first" });
    await env.DB.prepare("UPDATE descriptions SET updated_at = updated_at + 1 WHERE id = ?").bind(child(1)).run();
    await runKind(storage, "children", { exportId: "second" });
    const marker = await readFingerprints(storage, TENANT.slug, FONDS);
    expect(marker.children.exportId).toBe("second");
    expect(marker.descriptions.exportId).toBe("first");
    expect(marker.ead.exportId).toBe("first");
    expect(marker.dc.exportId).toBe("first");
  });

  it("writes no entry for a step that fails", async () => {
    await seed();
    await runKind(storage, "descriptions", { exportId: "first" });
    await env.DB.prepare("UPDATE descriptions SET updated_at = updated_at + 1 WHERE id = ?").bind(child(1)).run();
    await expect(
      runKind(storage, "descriptions", { exportId: "failed" }, async () => { throw new Error("boom"); })
    ).rejects.toThrow("boom");
    await expect(
      runKind(storage, "children", { exportId: "failed" }, async () => { throw new Error("boom"); })
    ).rejects.toThrow("boom");
    const marker = await readFingerprints(storage, TENANT.slug, FONDS);
    expect(marker.descriptions.exportId).toBe("first");
    expect(marker.children).toBeUndefined();
  });

  it("writes again on the next run when the fonds is edited while the step runs", async () => {
    await seed();
    await runAll(storage);
    // An edit to the unpublished description while the file is written:
    // the step completes, since its outline holds published rows only.
    await env.DB.prepare("UPDATE descriptions SET updated_at = updated_at + 1 WHERE id = ?").bind(child(1)).run();
    const skipped = await runKind(storage, "descriptions", {}, () =>
      exportFondsDescriptions(db, storage as unknown as ExportStorage, FONDS, TENANT, [TENANT.id], {
        hooks: {
          beforeFinish: async () => {
            await env.DB.prepare("UPDATE descriptions SET updated_at = updated_at + 1 WHERE id = ?").bind(child(3)).run();
          },
        },
      })
    );
    expect(skipped).toBe(false);
    expect(await runKind(storage, "descriptions")).toBe(false);
    expect(await runKind(storage, "descriptions")).toBe(true);
  });

  it("keeps the marker beside the per-fonds files", () => {
    expect(fingerprintKey(TENANT.slug, FONDS)).toBe("neogranadina/fingerprints/co-fp.json");
  });
});

// @version v0.9.0
