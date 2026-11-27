/**
 * Tests — entities.json written in batches
 *
 * This suite pins how `exportEntities` writes `<slug>/entities.json`
 * without holding every entity or the whole file in memory. Built as
 * one string, the file of zasqua.org's 78,136 exported entities (about
 * 42 MB of JSON) and the rows beside it pass the 128 MB a Worker has
 * once any of the text needs UTF-16.
 *
 * The reference is the single-string path: the federation's entities
 * linked to a published description of a member tenant and not merged,
 * read with one DISTINCT join, sorted by id, formatted and given to
 * `JSON.stringify`. On a fixture federation small enough for both, with
 * the batch and part sizes cut down so the new path reads several
 * batches and sends several multipart parts, the two must write the
 * same bytes. The fixture holds entities the file must leave out among
 * those it keeps, interleaved by id: linked only to an unpublished
 * description, linked only to a non-member tenant's description,
 * merged into another (whose retired code and current code the survivor
 * inherits), owned
 * by a tenant outside the members, and of another federation; and
 * entities linked several times, which must appear once. A batch that
 * ends exactly at the last entity is followed by one that finds none.
 * An entity edited while the file is written refuses the file and keeps
 * the previous one, so the file never holds two states of the
 * federation; a failure while the upload is completed aborts it.
 *
 * Each entity's `functions` come from its `entity_functions` rows, read
 * for each batch by the batch's own entity ids, and the fixture gives
 * function rows to kept and left-out entities alike, with ids in the
 * opposite order to their entry. Every write to an entity's functions
 * also sets the entity's `updated_at`, so functions replaced while the
 * file is written refuse it through the same check as any other edit.
 * `dbe_id` is written on every entity.
 *
 * The last cases check the batch queries' plans without planner
 * statistics, as on D1: the entities query walks the entities' primary
 * key in `id` order, with no sort, and reaches the links by
 * `de_entity_role_idx`; the functions query searches `ef_entity_idx`
 * for each of the batch's ids, passed as one JSON parameter.
 *
 * @version v0.9.0
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, asc, eq, inArray, isNull, isNotNull } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { descriptions, descriptionEntities, entities } from "../../app/db/schema";
import {
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
  SECOND_TEST_TENANT_ID,
  SECOND_TEST_FEDERATION_ID,
  applyMigrations,
  cleanDatabase,
} from "../helpers/db";
import {
  exportEntities,
  entityBatchQuery,
  entityFunctionsBatchQuery,
  EntitiesChangedDuringPublishError,
} from "../../app/lib/export/pipeline.server";
import { entityFunctionsReplacement, readEntityFunctionRows } from "../../app/lib/entity-functions.server";
import { formatEntity } from "../../app/lib/export/entities.server";
import { formerCodesFor, mergedFormerCodes } from "../../app/lib/export/former-codes.server";
import { authorityScope } from "../../app/lib/authority-ownership.server";
import type { ExportStorage } from "../../app/lib/export/r2-client.server";
import type { ExportTenant } from "../../app/lib/export/types";
import { MemoryStorage } from "./memory-storage";

const TENANT: ExportTenant = {
  id: DEFAULT_TEST_TENANT_ID,
  federationId: DEFAULT_TEST_FEDERATION_ID,
  slug: "neogranadina",
  descriptiveStandard: "isadg",
};
const KEY = "neogranadina/entities.json";
const now = 1_700_000_000_000;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Db = DrizzleD1Database<any>;

/** The single-string file: every exported entity read at once, in id order. */
async function reference(db: Db, tenantIds: string[]): Promise<string> {
  const rows = await db
    .selectDistinct({
      id: entities.id, updatedAt: entities.updatedAt, entityCode: entities.entityCode, displayName: entities.displayName, sortName: entities.sortName,
      givenName: entities.givenName, surname: entities.surname, entityType: entities.entityType, honorific: entities.honorific,
      primaryFunction: entities.primaryFunction, primaryFunctionId: entities.primaryFunctionId, nameVariants: entities.nameVariants,
      datesOfExistence: entities.datesOfExistence, dateStart: entities.dateStart, dateEnd: entities.dateEnd,
      history: entities.history, sources: entities.sources, wikidataId: entities.wikidataId,
      viafId: entities.viafId, dbeId: entities.dbeId, legacyIds: entities.legacyIds, mergedInto: entities.mergedInto,
    })
    .from(entities)
    .innerJoin(descriptionEntities, eq(descriptionEntities.entityId, entities.id))
    .innerJoin(descriptions, eq(descriptionEntities.descriptionId, descriptions.id))
    .where(
      and(
        authorityScope(entities, TENANT.federationId, tenantIds),
        inArray(descriptions.tenantId, tenantIds),
        eq(descriptions.isPublished, true),
        isNull(entities.mergedInto)
      )
    )
    .orderBy(asc(entities.id))
    .all();
  const merged = await db
    .select({ id: entities.id, mergedInto: entities.mergedInto, code: entities.entityCode, legacyIds: entities.legacyIds })
    .from(entities)
    .where(and(authorityScope(entities, TENANT.federationId, tenantIds), isNotNull(entities.mergedInto)))
    .orderBy(asc(entities.id))
    .all();
  const inherited = mergedFormerCodes(merged.map((r) => ({ ...r, mergedInto: r.mergedInto! })));
  // Every entity's function rows, in the order they were entered.
  const fnRows = await env.DB.prepare("SELECT entity_id, function FROM entity_functions ORDER BY rowid")
    .all<{ entity_id: string; function: string }>();
  const fnByEntity = new Map<string, Array<{ function: string }>>();
  for (const r of fnRows.results) {
    const list = fnByEntity.get(r.entity_id) ?? [];
    list.push({ function: r.function });
    fnByEntity.set(r.entity_id, list);
  }
  return JSON.stringify(
    rows.map((row) =>
      formatEntity(
        { ...row, primaryFunctionCanonical: null, entityFunctions: fnByEntity.get(row.id) ?? [] },
        formerCodesFor(row.entityCode, row.legacyIds, inherited.get(row.id))
      )
    )
  );
}

/** Returns the ids of the entities the file must hold, in id order. */
async function seed(db: Db): Promise<string[]> {
  await db.insert(schema.repositories).values([
    { id: uuid(1), tenantId: TENANT.id, code: "co-x", name: "X", enabled: true, createdAt: now, updatedAt: now },
    { id: uuid(2), tenantId: SECOND_TEST_TENANT_ID, code: "mx-z", name: "Z", enabled: true, createdAt: now, updatedAt: now },
  ]);
  const desc = async (id: string, tenantId: string, published: boolean) =>
    db.insert(schema.descriptions).values({
      id, tenantId, repositoryId: tenantId === TENANT.id ? uuid(1) : uuid(2), parentId: null, rootDescriptionId: id,
      descriptionLevel: "fonds", referenceCode: `ref-${id.slice(-4)}`, title: "T", isPublished: published,
      createdAt: now, updatedAt: now,
    });
  await desc(uuid(10), TENANT.id, true);
  await desc(uuid(11), TENANT.id, true);
  await desc(uuid(12), TENANT.id, false);
  await desc(uuid(13), SECOND_TEST_TENANT_ID, true);
  let link = 0;
  let fnSeq = 0;
  const addFunction = (entityId: string, fn: string) =>
    db.insert(schema.entityFunctions).values({
      id: uuid(500000 - fnSeq++), entityId, function: fn, createdAt: now, updatedAt: now,
    });
  const linkTo = (entityId: string, descriptionId: string, role = "creator") =>
    db.insert(schema.descriptionEntities).values({
      id: uuid(90000 + link++), descriptionId, entityId, role: role as any, createdAt: now,
    });
  const kept: string[] = [];
  for (let i = 0; i < 26; i++) {
    const id = uuid(1000 + ((i * 7) % 26) * 3);
    const kind = i % 13;
    await db.insert(schema.entities).values({
      id,
      federationId: kind === 9 ? SECOND_TEST_FEDERATION_ID : TENANT.federationId,
      tenantId: kind === 10 ? SECOND_TEST_TENANT_ID : kind === 4 ? TENANT.id : null,
      entityCode: `ne-${String(i).padStart(4, "0")}`,
      displayName: `Persona ${i} — «Muñoz» 𝄞`,
      sortName: `Muñoz, ${i}`,
      entityType: "person",
      nameVariants: i % 4 === 0 ? JSON.stringify([`Variante ${i}`]) : "[]",
      history: i % 3 === 0 ? `Vecino de Popayán, ${"activo ".repeat(i)}` : null,
      legacyIds: i % 5 === 1 ? JSON.stringify([{ provider: "zasqua-2026-04", id: `ne-old-${i}` }]) : "[]",
      dbeId: i % 6 === 2 ? String(40000 + i) : null,
      createdAt: now,
      updatedAt: now,
    });
    // Function rows, their ids falling in the opposite order to their
    // entry, so only the entry order gives the first spelling.
    const fns = i % 3 === 1 ? ["escribano", "Alcalde", "Escribano"] : i % 4 === 0 ? ["Capitán"] : [];
    for (const fn of fns) await addFunction(id, fn);
    if (kind === 7) {
      await linkTo(id, uuid(12)); // only an unpublished description
    } else if (kind === 8) {
      await linkTo(id, uuid(13)); // only a non-member tenant's description
    } else {
      await linkTo(id, uuid(10));
      if (i % 2) await linkTo(id, uuid(11));
      if (i % 3 === 0) await linkTo(id, uuid(10), "subject");
      if (kind !== 9 && kind !== 10) kept.push(id);
    }
  }
  // Merged records: left out, their retired codes and current code
  // carried by the survivor.
  const survivor = kept[0];
  await db.insert(schema.entities).values({
    id: uuid(1001), federationId: TENANT.federationId, entityCode: "ne-merged", displayName: "Duplicado",
    sortName: "Duplicado", entityType: "person", mergedInto: survivor,
    legacyIds: JSON.stringify([{ provider: "zasqua-2026-04", id: "ne-dup-1" }]), createdAt: now, updatedAt: now,
  });
  await linkTo(uuid(1001), uuid(10));
  await addFunction(uuid(1001), "Duplicado");
  return kept.sort();
}

const asStorage = (s: MemoryStorage) => s as unknown as ExportStorage;

describe("exportEntities writes entities.json in batches", () => {
  let db: Db;
  let kept: string[];
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
    kept = await seed(db);
  });

  it("writes the single-string bytes over several batches and parts", async () => {
    const storage = new MemoryStorage();
    const r = await exportEntities(db, asStorage(storage), TENANT, undefined, { batchSize: 4, partSize: 512 });
    const expected = await reference(db, [TENANT.id]);
    expect(storage.text(KEY)).toBe(expected);
    expect(r.count).toBe(kept.length);
    expect(JSON.parse(expected)).toHaveLength(kept.length);
    expect(expected).toContain("ne-dup-1");
    expect(storage.partSizes.length).toBeGreaterThan(2);
    expect(storage.contentTypes.get(KEY)).toBe("application/json; charset=utf-8");
  });

  it("writes the same bytes with the default sizes, and across member tenants", async () => {
    const storage = new MemoryStorage();
    await exportEntities(db, asStorage(storage), TENANT, undefined);
    expect(storage.text(KEY)).toBe(await reference(db, [TENANT.id]));
    const members = [TENANT.id, SECOND_TEST_TENANT_ID];
    const fed = new MemoryStorage();
    const r = await exportEntities(db, asStorage(fed), TENANT, members, { batchSize: 3, partSize: 256 });
    expect(fed.text(KEY)).toBe(await reference(db, members));
    expect(r.count).toBeGreaterThan(kept.length);
  });

  it("ends with a batch that finds none when the last batch is exactly full", async () => {
    const storage = new MemoryStorage();
    const r = await exportEntities(db, asStorage(storage), TENANT, undefined, { batchSize: kept.length, partSize: 512 });
    expect(r.count).toBe(kept.length);
    expect(storage.text(KEY)).toBe(await reference(db, [TENANT.id]));
  });

  it("refuses the file when an entity is edited while it is written, and keeps the previous one", async () => {
    const storage = new MemoryStorage();
    const previous = new TextEncoder().encode("[]");
    storage.objects.set(KEY, previous);
    const err = await exportEntities(db, asStorage(storage), TENANT, undefined, {
      batchSize: 4,
      partSize: 512,
      hooks: {
        beforeBatch: async (i) => {
          if (i === 2) {
            await env.DB.prepare("UPDATE entities SET display_name = 'Editado', updated_at = ? WHERE id = ?")
              .bind(now + 1, kept[0]).run();
          }
        },
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(EntitiesChangedDuringPublishError);
    expect(storage.objects.get(KEY)).toEqual(previous);
    expect(storage.uploads.size).toBe(0);
    // Once settled, the next attempt writes the reference.
    await exportEntities(db, asStorage(storage), TENANT, undefined, { batchSize: 4, partSize: 512 });
    expect(storage.text(KEY)).toBe(await reference(db, [TENANT.id]));
  });

  it("writes each entity's functions from entity_functions, and dbe_id, across batches", async () => {
    const storage = new MemoryStorage();
    await exportEntities(db, asStorage(storage), TENANT, undefined, { batchSize: 4, partSize: 512 });
    const out = JSON.parse(storage.text(KEY) ?? "null") as Array<Record<string, any>>;
    const withFns = out.filter((e) => e.functions);
    expect(withFns.length).toBeGreaterThan(4);
    expect(withFns.map((e) => e.functions)).toContainEqual([
      { function: "escribano", count: 2 },
      { function: "Alcalde", count: 1 },
    ]);
    expect(withFns.map((e) => e.functions)).toContainEqual([{ function: "Capitán", count: 1 }]);
    expect(JSON.stringify(out)).not.toContain("Duplicado\"");
    expect(out.filter((e) => typeof e.dbe_id === "number").length).toBeGreaterThan(1);
    expect(out.every((e) => "dbe_id" in e)).toBe(true);
  });

  it("refuses the file when an entity's functions change while it is written, and keeps the previous one", async () => {
    const storage = new MemoryStorage();
    const previous = new TextEncoder().encode("[]");
    storage.objects.set(KEY, previous);
    const err = await exportEntities(db, asStorage(storage), TENANT, undefined, {
      batchSize: 4,
      partSize: 512,
      hooks: {
        beforeBatch: async (i) => {
          if (i === 2) {
            // Through the write path the entity editor uses.
            const existing = await readEntityFunctionRows(db, kept[0]);
            // At the version the entity holds (`now`), as the editor does.
            const { functionStatements, touch } = entityFunctionsReplacement(
              db, kept[0], ["Regidor"], existing, now, now + 5
            );
            await db.batch([...functionStatements, touch] as any);
          }
        },
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(EntitiesChangedDuringPublishError);
    expect(storage.objects.get(KEY)).toEqual(previous);
    expect(storage.uploads.size).toBe(0);
    await exportEntities(db, asStorage(storage), TENANT, undefined, { batchSize: 4, partSize: 512 });
    expect(storage.text(KEY)).toBe(await reference(db, [TENANT.id]));
    expect(storage.text(KEY)).toContain("Regidor");
  });

  it("aborts the upload when completing it fails", async () => {
    const storage = new MemoryStorage();
    storage.completeMultipartUpload = async () => {
      throw new Error("complete failed");
    };
    await expect(
      exportEntities(db, asStorage(storage), TENANT, undefined, { batchSize: 4, partSize: 512 })
    ).rejects.toThrow("complete failed");
    expect(storage.aborted).toHaveLength(1);
    expect(storage.uploads.size).toBe(0);
  });

  it("writes [] when no entity is linked to a published description", async () => {
    await env.DB.prepare("UPDATE descriptions SET is_published = 0").run();
    const storage = new MemoryStorage();
    expect(await exportEntities(db, asStorage(storage), TENANT)).toEqual({ count: 0 });
    expect(storage.text(KEY)).toBe("[]");
  });

  it("reads only the function rows of the batch's own entities, in entry order, by one bound parameter", async () => {
    // Every entity with function rows, kept or left out, in id order.
    const all = (
      await env.DB.prepare("SELECT DISTINCT entity_id FROM entity_functions ORDER BY entity_id").all<{ entity_id: string }>()
    ).results.map((r) => r.entity_id);
    const ids = [all[0], all[all.length - 1]];
    const query = entityFunctionsBatchQuery(db, ids);
    const { sql, params } = query.toSQL();
    expect(params).toHaveLength(1);
    const rows = await query.all();
    expect(new Set(rows.map((r) => r.entityId))).toEqual(new Set(ids));
    const entry = (
      await env.DB.prepare(
        "SELECT entity_id, function FROM entity_functions WHERE entity_id IN (?, ?) ORDER BY entity_id, rowid"
      ).bind(...ids).all<{ entity_id: string; function: string }>()
    ).results.map((r) => [r.entity_id, r.function]);
    expect(rows.map((r) => [r.entityId, r.function])).toEqual(entry);
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>();
    const detail = plan.results.map((r) => r.detail);
    expect(detail).toContain("SEARCH entity_functions USING INDEX ef_entity_idx (entity_id=?)");
    expect(detail.some((d) => d.startsWith("SCAN entity_functions"))).toBe(false);
  });

  it("walks the primary key in id order, with no sort and without statistics", async () => {
    const stat = await env.DB.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'").first<{ n: number }>();
    expect(stat!.n).toBe(0);
    for (const [after, first] of [
      [null, "SCAN entities USING INDEX sqlite_autoindex_entities_1"],
      [uuid(1000), "SEARCH entities USING INDEX sqlite_autoindex_entities_1 (id>?)"],
    ] as const) {
      const { sql, params } = entityBatchQuery(db, TENANT, [TENANT.id, SECOND_TEST_TENANT_ID], after, 1000).toSQL();
      const out = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>();
      const detail = out.results.map((r) => r.detail);
      expect(detail[0]).toBe(first);
      expect(detail).toContain("SEARCH description_entities USING INDEX de_entity_role_idx (entity_id=?)");
      expect(detail.some((d) => d.includes("TEMP B-TREE"))).toBe(false);
    }
  });
});

// @version v0.9.0
