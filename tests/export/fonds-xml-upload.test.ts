/**
 * Tests — per-fonds EAD3 and Dublin Core files written in batches
 *
 * This suite pins how `exportFondsEad` and `exportFondsDc` write
 * `<slug>/ead/<fonds>.xml` and `<slug>/dc/<fonds>.xml` without holding
 * the fonds or the document in memory. Read with one `select()` and
 * built as one string, the rows and the document of co-ahr-gob (45,341
 * descriptions) or co-cihjml-acc (25,549, 40.8M characters of row
 * text), held in UTF-16, pass the 128 MB a Worker has.
 *
 * The reference is the single-string path: every published row of the
 * fonds read in `id` order, mapped as the old step mapped it, and given
 * to `buildEad3` or `buildDcBulk`. On a fixture fonds small enough for
 * both, with the batch and part sizes cut down so the new path reads
 * several batches and sends several multipart parts, the two must write
 * the same bytes, for the ISAD(G) and DACS profiles, for a fonds whose
 * only published row is its root, and for records whose repository is
 * not the fonds'. The fixture puts rows the steps must not read inside
 * each batch's id range: another fonds of the same tenant, another
 * tenant's rows naming this fonds' root, and an unpublished file.
 *
 * A fonds that changes while its file is being written must never get a
 * completed file. The `hooks` seam unpublishes a row before its batch,
 * publishes a new row into the fonds, and changes the level of a row
 * already written just before the file would be completed. Each must
 * throw `FondsChangedDuringPublishError`, abort the upload and leave
 * the previous file as it was; a run once the data has settled writes
 * the reference bytes. So must a content edit (a new title, with the
 * row's `updated_at`) to rows already written or still to come, so
 * that no file holds one row as it was and another as it became. A
 * failure while the upload is being completed aborts it too.
 *
 * The reference gives each repository its attribution line, composed
 * from the repository row and the federation's hosting statement, which
 * the Dublin Core file's `dc:rights` carries.
 *
 * The last cases bound the cost: every statement binds fewer than D1's
 * 100 parameters and the number of D1 calls is the batches plus a fixed
 * handful; and, without planner statistics as on D1, the outline query
 * seeks `descriptions_tenant_root_id_idx` with equality on the tenant
 * and the root and needs no sort.
 *
 * @version v0.9.0
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, asc, eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { descriptions, repositories } from "../../app/db/schema";
import {
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
  SECOND_TEST_TENANT_ID,
  applyMigrations,
  cleanDatabase,
} from "../helpers/db";
import {
  exportFondsEad,
  exportFondsDc,
  fondsXmlOutlineQuery,
  FondsChangedDuringPublishError,
} from "../../app/lib/export/pipeline.server";
import { buildEad3 } from "../../app/lib/export/ead/builder";
import { buildDcBulk } from "../../app/lib/export/dc/builder";
import { getEadProfile } from "../../app/lib/export/ead/profiles/registry";
import type { ExportStorage } from "../../app/lib/export/r2-client.server";
import type { EadInput, EadRepository, ExportTenant } from "../../app/lib/export/types";
import { repositoryAttribution } from "../../app/lib/export/attribution";
import { readFederationHosting } from "../../app/lib/pipeline/dispatch.server";
import { MemoryStorage } from "./memory-storage";

const TENANT: ExportTenant = {
  id: DEFAULT_TEST_TENANT_ID,
  federationId: DEFAULT_TEST_FEDERATION_ID,
  slug: "neogranadina",
  descriptiveStandard: "isadg",
};
const FONDS = "co-x";
const EAD_KEY = `neogranadina/ead/${FONDS}.xml`;
const DC_KEY = `neogranadina/dc/${FONDS}.xml`;
const NOW = new Date("2026-10-31T12:00:00.000Z");
const now = NOW.getTime();
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ROOT = uuid(1000);
const SMALL = { batchSize: 7, partSize: 1024, now: NOW };

type Db = DrizzleD1Database<any>;

/** The old step's row mapping, kept here as the reference. */
function referenceRows(dbRows: Array<typeof descriptions.$inferSelect>): EadInput[] {
  return dbRows.map((r) => {
    let legacy: EadInput["legacyIds"] = null;
    try {
      const parsed = JSON.parse(r.legacyIds);
      const ok = Array.isArray(parsed)
        ? parsed.filter((e) => e && typeof e.provider === "string" && e.provider && (typeof e.id === "string" || typeof e.id === "number"))
        : [];
      legacy = ok.length ? ok.map((e) => ({ provider: e.provider, id: e.id })) : null;
    } catch {
      legacy = null;
    }
    return {
      id: r.id,
      referenceCode: r.referenceCode,
      title: r.title,
      descriptionLevel: r.descriptionLevel,
      dateExpression: r.dateExpression ?? null,
      extent: r.extent ?? null,
      creatorDisplay: r.creatorDisplay ?? null,
      scopeContent: r.scopeContent ?? null,
      accessConditions: r.accessConditions ?? null,
      language: r.language ?? null,
      placeDisplay: r.placeDisplay ?? null,
      imprint: r.imprint ?? null,
      parentReferenceCode: null,
      repositoryId: r.repositoryId,
      isPublished: !!r.isPublished,
      legacyIds: legacy,
      adminBiogHistory: r.adminBiogHistory ?? null,
      preferredCitation: r.preferredCitation ?? null,
      acquisitionInfo: r.acquisitionInfo ?? null,
      systemOfArrangement: r.systemOfArrangement ?? null,
      physicalCharacteristics: r.physicalCharacteristics ?? null,
    };
  });
}

/** The fonds read whole and built as one string, as the old steps did. */
async function reference(db: Db, kind: "ead" | "dc", tenant: ExportTenant = TENANT): Promise<string> {
  const rows = referenceRows(
    await db
      .select()
      .from(descriptions)
      .where(
        and(
          eq(descriptions.tenantId, tenant.id),
          eq(descriptions.rootDescriptionId, ROOT),
          eq(descriptions.isPublished, true)
        )
      )
      .orderBy(asc(descriptions.id))
      .all()
  );
  const repos = new Map<string, EadRepository>();
  const hosting = await readFederationHosting(db, tenant.federationId);
  for (const id of new Set(rows.map((r) => r.repositoryId))) {
    const r = await db.select().from(repositories).where(and(eq(repositories.id, id), eq(repositories.tenantId, tenant.id))).get();
    if (r) repos.set(id, { name: r.name, city: r.city ?? "", code: r.code, attribution: repositoryAttribution(r, hosting) });
  }
  return kind === "ead"
    ? buildEad3(rows, repos, getEadProfile(tenant.descriptiveStandard), NOW.toISOString(), ROOT)
    : buildDcBulk(rows, repos, FONDS, NOW.toISOString().slice(0, 10));
}

/**
 * A fonds of one root, 3 series and `files` files, ids assigned out of
 * insertion order, with accented and astral characters, legacy ids,
 * fields every profile reads, one unpublished file, and two files held
 * by a second repository. Interleaved by id: another fonds of the same
 * tenant and another tenant's rows naming this fonds' root.
 */
async function seed(db: Db, files = 30): Promise<string[]> {
  await db.insert(schema.repositories).values([
    { id: uuid(1), tenantId: TENANT.id, code: "co-x", name: "Archivo X", city: "Popayán", region: "Cauca", creditStatementEs: "Digitalizado por el archivo.", manifestRights: "https://creativecommons.org/licenses/by/4.0/", enabled: true, createdAt: now, updatedAt: now },
    { id: uuid(2), tenantId: TENANT.id, code: "co-y", name: "Archivo «Y»", city: "Cali", enabled: true, createdAt: now, updatedAt: now },
    { id: uuid(3), tenantId: SECOND_TEST_TENANT_ID, code: "mx-z", name: "Archivo Z", enabled: true, createdAt: now, updatedAt: now },
  ]);
  const ids: string[] = [];
  const base = { tenantId: TENANT.id, repositoryId: uuid(1), isPublished: true, createdAt: now, updatedAt: now };
  await db.insert(schema.descriptions).values({
    ...base, id: ROOT, parentId: null, rootDescriptionId: ROOT, descriptionLevel: "fonds", referenceCode: FONDS,
    title: "Fondo X — «Cabildo» 𝄞", scopeContent: "Alcance & <contenido>", adminBiogHistory: "Historia del cabildo",
    preferredCitation: "Archivo X, Fondo X", acquisitionInfo: "Donación", systemOfArrangement: "Tres series",
    physicalCharacteristics: "Papel", accessConditions: "Libre", dateExpression: "1700-1810", extent: "3 cajas",
    creatorDisplay: "Cabildo de Popayán", language: "spa", legacyIds: JSON.stringify([{ provider: "ca", id: 7 }]),
  });
  ids.push(ROOT);
  const series: string[] = [];
  for (let s = 0; s < 3; s++) {
    const id = uuid(1100 + s * 37);
    series.push(id);
    ids.push(id);
    await db.insert(schema.descriptions).values({
      ...base, id, parentId: ROOT, rootDescriptionId: ROOT, descriptionLevel: "series",
      referenceCode: `${FONDS}-ser${s}`, title: `Serie ${s}`,
    });
  }
  for (let f = 0; f < files; f++) {
    const id = uuid(1000 + ((f * 13) % files) * 4 + 2);
    ids.push(id);
    await db.insert(schema.descriptions).values({
      ...base, id, parentId: series[f % 3], rootDescriptionId: ROOT, descriptionLevel: f % 5 === 0 ? "item" : "file",
      repositoryId: f % 11 === 3 ? uuid(2) : uuid(1),
      isPublished: f !== 4,
      referenceCode: `${FONDS}-ser${f % 3}-f${String(f).padStart(3, "0")}`,
      title: `Expediente ${f}: señor Muñoz contra «Pérez» & otros 𝄞`,
      scopeContent: f % 3 === 0 ? null : `Pleito de ${"tierras ".repeat(f % 4 + 1)}en Popayán, año de 17${f}.`,
      dateExpression: f % 2 ? `17${String(f).padStart(2, "0")}` : null,
      creatorDisplay: f % 4 === 1 ? "Real Audiencia" : null,
      extent: f % 6 === 2 ? `${f} folios` : null,
      language: f % 7 === 0 ? "spa" : null,
      legacyIds: f % 7 === 2 ? JSON.stringify([{ provider: "former-reference-code", id: `${FONDS}-old${f}` }, { bad: true }]) : "[]",
    });
  }
  // Rows inside the fonds' id range that the steps must not read.
  for (let i = 0; i < 6; i++) {
    await db.insert(schema.descriptions).values({
      ...base, id: uuid(1001 + i * 8), parentId: null, rootDescriptionId: uuid(1001), descriptionLevel: i === 0 ? "fonds" : "file",
      referenceCode: `co-other-${i}`, title: `Otro ${i}`,
    });
    await db.insert(schema.descriptions).values({
      ...base, tenantId: SECOND_TEST_TENANT_ID, repositoryId: uuid(3), id: uuid(1003 + i * 8), parentId: ROOT,
      rootDescriptionId: ROOT, descriptionLevel: "file", referenceCode: `mx-z-${i}`, title: `Ajeno ${i}`,
    });
  }
  return ids;
}

const asStorage = (s: MemoryStorage) => s as unknown as ExportStorage;

describe("the EAD3 and Dublin Core steps write the single-string bytes in batches", () => {
  let db: Db;
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("writes the EAD3 file buildEad3 builds, over several batches and parts", async () => {
    await seed(db);
    const storage = new MemoryStorage();
    let batches = 0;
    const r = await exportFondsEad(db, asStorage(storage), FONDS, TENANT, {
      ...SMALL,
      hooks: { beforeBatch: async () => { batches++; } },
    });
    const expected = await reference(db, "ead");
    expect(storage.text(EAD_KEY)).toBe(expected);
    expect(r.byteSize).toBe(new TextEncoder().encode(expected).length);
    // 33 published rows of the fonds (root, 3 series, 29 files).
    expect(r.recordCount).toBe(33);
    expect(batches).toBe(Math.ceil(33 / 7));
    expect(storage.partSizes.length).toBeGreaterThan(2);
    expect(storage.contentTypes.get(EAD_KEY)).toBe("application/xml; charset=utf-8");
    expect(expected).not.toContain("Otro ");
    expect(expected).not.toContain("Ajeno");
  });

  it("writes the EAD3 file of another profile byte for byte", async () => {
    await seed(db);
    const dacs: ExportTenant = { ...TENANT, descriptiveStandard: "dacs" };
    const storage = new MemoryStorage();
    await exportFondsEad(db, asStorage(storage), FONDS, dacs, SMALL);
    expect(storage.text(EAD_KEY)).toBe(await reference(db, "ead", dacs));
    expect(storage.text(EAD_KEY)).toContain("<prefercite>");
  });

  it("writes the Dublin Core file buildDcBulk builds, with each record's own repository", async () => {
    await seed(db);
    const storage = new MemoryStorage();
    const r = await exportFondsDc(db, asStorage(storage), FONDS, TENANT, SMALL);
    const expected = await reference(db, "dc");
    expect(storage.text(DC_KEY)).toBe(expected);
    expect(r.recordCount).toBe(33);
    expect(r.byteSize).toBe(new TextEncoder().encode(expected).length);
    expect(expected).toContain("<dc:source>Archivo «Y», Cali</dc:source>");
    expect(storage.partSizes.length).toBeGreaterThan(2);
  });

  it("writes the same bytes with the default batch and part sizes", async () => {
    await seed(db);
    const storage = new MemoryStorage();
    await exportFondsEad(db, asStorage(storage), FONDS, TENANT, { now: NOW });
    await exportFondsDc(db, asStorage(storage), FONDS, TENANT, { now: NOW });
    expect(storage.text(EAD_KEY)).toBe(await reference(db, "ead"));
    expect(storage.text(DC_KEY)).toBe(await reference(db, "dc"));
  });

  it("writes a fonds whose only published row is its root, with no <dsc>", async () => {
    await seed(db, 3);
    await env.DB.prepare("UPDATE descriptions SET is_published = 0 WHERE root_description_id = ? AND id != ?").bind(ROOT, ROOT).run();
    const storage = new MemoryStorage();
    await exportFondsEad(db, asStorage(storage), FONDS, TENANT, SMALL);
    await exportFondsDc(db, asStorage(storage), FONDS, TENANT, SMALL);
    expect(storage.text(EAD_KEY)).toBe(await reference(db, "ead"));
    expect(storage.text(EAD_KEY)).not.toContain("<dsc>");
    expect(storage.text(DC_KEY)).toBe(await reference(db, "dc"));
  });

  it("writes an empty EAD3 file and an empty record list when nothing in the fonds is published", async () => {
    await seed(db, 3);
    await env.DB.prepare("UPDATE descriptions SET is_published = 0 WHERE root_description_id = ?").bind(ROOT).run();
    const storage = new MemoryStorage();
    expect(await exportFondsEad(db, asStorage(storage), FONDS, TENANT, SMALL)).toEqual({ recordCount: 0, byteSize: 0 });
    expect(storage.text(EAD_KEY)).toBe("");
    expect(await reference(db, "ead")).toBe("");
    const dc = await exportFondsDc(db, asStorage(storage), FONDS, TENANT, SMALL);
    expect(dc.recordCount).toBe(0);
    expect(storage.text(DC_KEY)).toBe(await reference(db, "dc"));
  });

  it("writes a fonds whose root is a collection, with the root as <archdesc> and not as a <c>", async () => {
    await seed(db);
    await env.DB.prepare("UPDATE descriptions SET description_level = 'collection' WHERE id = ?").bind(ROOT).run();
    // A fonds-level row below the root is a component, not the archdesc.
    await env.DB.prepare("UPDATE descriptions SET description_level = 'fonds' WHERE id = ?").bind(uuid(1100)).run();
    const storage = new MemoryStorage();
    const r = await exportFondsEad(db, asStorage(storage), FONDS, TENANT, SMALL);
    const xml = storage.text(EAD_KEY) ?? "";
    expect(xml).toBe(await reference(db, "ead"));
    expect(xml).toContain('<archdesc level="collection">');
    expect(xml).not.toContain('<c level="collection">');
    expect(xml).toContain('<c level="fonds">');
    // 3 series and 29 published files; the root is not repeated as a component.
    expect(xml.split("<c level=").length - 1).toBe(32);
    expect(r.recordCount).toBe(33);
  });

  it("refuses an EAD3 file for a fonds whose root is not published, as buildEad3 does", async () => {
    await seed(db, 3);
    await env.DB.prepare("UPDATE descriptions SET is_published = 0 WHERE id = ?").bind(ROOT).run();
    await expect(reference(db, "ead")).rejects.toThrow("buildEad3: no root row in input");
    await expect(exportFondsEad(db, asStorage(new MemoryStorage()), FONDS, TENANT, SMALL)).rejects.toThrow(
      "buildEad3: no root row in input"
    );
  });
});

describe("a fonds that changes while its EAD3 or Dublin Core file is written", () => {
  let db: Db;
  let ids: string[];
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
    ids = await seed(db);
  });

  const previous = new TextEncoder().encode("<previous/>");
  const steps = [
    ["EAD3", exportFondsEad, EAD_KEY],
    ["Dublin Core", exportFondsDc, DC_KEY],
  ] as const;

  async function expectRefused(
    run: typeof exportFondsEad,
    key: string,
    hooks: { beforeBatch?: (i: number) => Promise<void>; beforeFinish?: () => Promise<void> },
    detail: RegExp
  ) {
    const storage = new MemoryStorage();
    storage.objects.set(key, previous);
    const err = await run(db, asStorage(storage), FONDS, TENANT, { ...SMALL, hooks }).catch((e) => e);
    expect(err).toBeInstanceOf(FondsChangedDuringPublishError);
    expect(err.message).toMatch(detail);
    expect(storage.objects.get(key)).toEqual(previous);
    expect(storage.uploads.size).toBe(0);
    // Once the fonds has settled, a second run writes the reference.
    await run(db, asStorage(storage), FONDS, TENANT, SMALL);
    expect(storage.text(key)).toBe(await reference(db, key === EAD_KEY ? "ead" : "dc"));
  }

  for (const [name, run, key] of steps) {
    it(`refuses the ${name} file when a row is unpublished before its batch`, async () => {
      const sorted = [...ids].sort();
      const late = sorted[sorted.length - 2];
      await expectRefused(run, key, {
        beforeBatch: async (i) => {
          if (i === 3) await env.DB.prepare("UPDATE descriptions SET is_published = 0 WHERE id = ?").bind(late).run();
        },
      }, /is no longer published in it/);
    });

    it(`refuses the ${name} file when a row is published into the fonds`, async () => {
      await expectRefused(run, key, {
        beforeBatch: async (i) => {
          if (i === 1) {
            await env.DB.prepare(
              `INSERT INTO descriptions (id, tenant_id, repository_id, parent_id, root_description_id, description_level,
                 reference_code, title, is_published, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'file', 'co-x-new', 'Nuevo', 1, ?, ?)`
            ).bind(uuid(1999), TENANT.id, uuid(1), ROOT, ROOT, now, now).run();
          }
        },
      }, /co-x-new was published after the publish began|published descriptions became/);
    });

    it(`refuses the ${name} file when a written row changes level before the end`, async () => {
      const first = [...ids].sort()[1];
      await expectRefused(run, key, {
        beforeFinish: async () => {
          await env.DB.prepare("UPDATE descriptions SET description_level = 'subseries' WHERE id = ?").bind(first).run();
        },
      }, /was edited after the publish began/);
    });
  }

  for (const [name, run, key] of steps) {
    it(`refuses the ${name} file when written rows' content is edited between batches`, async () => {
      const sorted = [...ids].sort();
      await expectRefused(run, key, {
        beforeBatch: async (i) => {
          if (i === 2) {
            await env.DB.prepare("UPDATE descriptions SET title = 'Nuevo', updated_at = ? WHERE id = ?").bind(now + 1, sorted[1]).run();
            await env.DB.prepare("UPDATE descriptions SET title = 'Otro', updated_at = ? WHERE id = ?").bind(now + 1, sorted[sorted.length - 1]).run();
          }
        },
      }, /was edited after the publish began/);
    });

    it(`aborts the ${name} upload when completing it fails`, async () => {
      const storage = new MemoryStorage();
      storage.objects.set(key, previous);
      storage.completeMultipartUpload = async () => {
        throw new Error("complete failed");
      };
      await expect(run(db, asStorage(storage), FONDS, TENANT, SMALL)).rejects.toThrow("complete failed");
      expect(storage.aborted).toHaveLength(1);
      expect(storage.uploads.size).toBe(0);
      expect(storage.objects.get(key)).toEqual(previous);
    });
  }

  it("names the file it did not replace", async () => {
    const err = await exportFondsDc(db, asStorage(new MemoryStorage()), FONDS, TENANT, {
      ...SMALL,
      hooks: { beforeFinish: async () => { await env.DB.prepare("UPDATE descriptions SET is_published = 0 WHERE id = ?").bind(ids[5]).run(); } },
    }).catch((e) => e);
    expect(err.message).toContain("its Dublin Core file was not replaced");
  });
});

/** A D1 binding that logs the calls reaching D1 and the parameters each statement binds. */
function instrumentedD1(d1: D1Database) {
  const log = { calls: 0, binds: [] as number[] };
  const patch = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const s = stmt as any;
    const bind = s.bind.bind(stmt);
    s.bind = (...args: unknown[]) => {
      log.binds.push(args.length);
      return patch(bind(...args));
    };
    for (const m of ["all", "run", "first", "raw"]) {
      const f = s[m].bind(stmt);
      s[m] = (...a: unknown[]) => {
        log.calls++;
        return f(...a);
      };
    }
    return stmt;
  };
  return {
    d1: new Proxy(d1, {
      get(target, prop) {
        if (prop === "prepare") return (q: string) => patch(target.prepare(q));
        const v = (target as any)[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database,
    log,
  };
}

describe("the EAD3 and Dublin Core steps' cost is bounded by the batches", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seed(drizzle(env.DB, { schema }));
  });

  it("binds fewer than 100 parameters per statement and makes a fixed number of calls per batch", async () => {
    const ead = instrumentedD1(env.DB);
    await exportFondsEad(drizzle(ead.d1, { schema }), asStorage(new MemoryStorage()), FONDS, TENANT, SMALL);
    // Root, outline, fonds row, the repositories in one query and the
    // federation's hosting statement in two, five batches, outline again.
    expect(ead.log.calls).toBe(1 + 1 + 1 + 3 + Math.ceil(33 / 7) + 1);
    for (const n of ead.log.binds) expect(n).toBeLessThan(100);

    const dc = instrumentedD1(env.DB);
    await exportFondsDc(drizzle(dc.d1, { schema }), asStorage(new MemoryStorage()), FONDS, TENANT, SMALL);
    expect(dc.log.calls).toBe(1 + 1 + 3 + Math.ceil(33 / 7) + 1);
    for (const n of dc.log.binds) expect(n).toBeLessThan(100);
  });

  it("reads the outline through the fonds index, with no sort and without statistics", async () => {
    const stat = await env.DB.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'").first<{ n: number }>();
    expect(stat!.n).toBe(0);
    const { sql, params } = fondsXmlOutlineQuery(drizzle(env.DB, { schema }), TENANT.id, ROOT).toSQL();
    const out = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>();
    expect(out.results.map((r) => r.detail)).toEqual([
      "SEARCH descriptions USING INDEX descriptions_tenant_root_id_idx (tenant_id=? AND root_description_id=?)",
    ]);
  });
});

// @version v0.9.0
