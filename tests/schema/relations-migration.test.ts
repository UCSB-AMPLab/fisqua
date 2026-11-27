/**
 * Tests — migration 0125 under D1
 *
 * This suite runs migration 0125 under workerd's D1, the engine production
 * uses. `tests/import/relations-migration.test.ts` pins what migration
 * 0125 does to each row, under Node's SQLite; this suite runs the same
 * file statement by statement on tables put back into the shape they had
 * before 0125: `vocabulary_values` as 0119 created it,
 * `description_entities` with its `function` column and the three-column
 * unique index, and `entities` without the three relation columns. It pins
 * that:
 *
 *   - every statement runs (ADD COLUMN with a JSON CHECK, DROP COLUMN,
 *     the expression index and the partial index included);
 *   - a link's function ends in `attributes.office`, quotes kept;
 *   - the three tables then have the shape the test mirror in
 *     `tests/helpers/db.ts` builds, so the mirror the other suites use
 *     cannot drift from the file;
 *   - D1 enforces `related_to`'s foreign key on this binding: deleting a
 *     link another link names fails, naming a missing link fails, and in
 *     a batch a repoint followed by the delete succeeds while the delete
 *     followed by the repoint fails with nothing of the batch written;
 *     deleting the description still takes both sides of a relation.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, cleanDatabase, seedFederations, seedTenants } from "../helpers/db";
import { runMigrationFile } from "../helpers/migration-file";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestEntity } from "../helpers/entities";

const TABLES = ["vocabulary_values", "entities", "description_entities"];

type Shape = Record<string, { columns: unknown[]; indexes: unknown[]; fks: unknown[] }>;

async function shape(): Promise<Shape> {
  const out: Shape = {};
  for (const table of TABLES) {
    const cols = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    const idx = await env.DB.prepare(`PRAGMA index_list(${table})`).all<{ name: string; unique: number; partial: number }>();
    const fks = await env.DB.prepare(`PRAGMA foreign_key_list(${table})`).all<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>();
    out[table] = {
      columns: cols.results,
      indexes: idx.results
        .filter((r) => !r.name.startsWith("sqlite_"))
        .map((r) => ({ name: r.name, unique: r.unique, partial: r.partial }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      fks: fks.results
        .map((r) => ({ table: r.table, from: r.from, to: r.to, onDelete: r.on_delete.toUpperCase() }))
        .sort((a, b) => a.from.localeCompare(b.from)),
    };
  }
  return out;
}

const run = (sql: string) => env.DB.prepare(sql).run();

/** Puts the three tables back as they were before 0125. */
async function before0125(): Promise<void> {
  await run("DROP TABLE vocabulary_values");
  await run(
    "CREATE TABLE vocabulary_values (id TEXT PRIMARY KEY NOT NULL, federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE RESTRICT, " +
      "list TEXT NOT NULL CHECK (list IN ('entity_type','place_type','entity_role','place_role','role_group')), code TEXT NOT NULL, " +
      "label_es TEXT, label_en TEXT, group_code TEXT, position INTEGER NOT NULL DEFAULT 0, external_scheme TEXT, external_uri TEXT, " +
      "external_label TEXT, status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','proposed','deprecated')), " +
      "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  );
  await run("CREATE UNIQUE INDEX vocabulary_values_federation_list_code_idx ON vocabulary_values (federation_id, list, code)");
  await run("CREATE INDEX vocabulary_values_position_idx ON vocabulary_values (federation_id, list, position)");
  await run("DROP TABLE description_entities");
  await run(
    "CREATE TABLE description_entities (id TEXT PRIMARY KEY NOT NULL, description_id TEXT NOT NULL REFERENCES descriptions(id) ON DELETE CASCADE, " +
      "entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE RESTRICT, role TEXT NOT NULL, role_note TEXT, role_raw TEXT, " +
      "sequence INTEGER DEFAULT 0 NOT NULL, honorific TEXT, function TEXT, name_as_recorded TEXT, created_at INTEGER NOT NULL)",
  );
  await run("CREATE INDEX de_desc_idx ON description_entities(description_id)");
  await run("CREATE INDEX de_entity_role_idx ON description_entities(entity_id, role)");
  await run("CREATE UNIQUE INDEX de_unique_idx ON description_entities(description_id, entity_id, role)");
  // name_key arrived with 0129, after 0125: take it off as well, and put it
  // back once 0125 has run, so the column order is the mirror's.
  await run("DROP INDEX IF EXISTS entities_name_key_idx");
  for (const column of ["name_key", "gender", "known_only_from_relation", "qualified_name"]) {
    await run(`ALTER TABLE entities DROP COLUMN ${column}`);
  }
}

let mirror: Shape;
let linkId: string;
let descId: string;
let entityId: string;
let repoId: string;

const insertLink = (id: string, relatedTo: string | null, d = descId) =>
  env.DB.prepare("INSERT INTO description_entities (id, description_id, entity_id, role, sequence, created_at, related_to) VALUES (?, ?, ?, ?, 0, 1, ?)")
    .bind(id, d, entityId, `role-${id}`, relatedTo);
/** Two links naming each other: a relation. */
async function pair(a: string, b: string, d = descId) {
  await insertLink(a, null, d).run();
  await insertLink(b, a, d).run();
  await env.DB.prepare("UPDATE description_entities SET related_to = ? WHERE id = ?").bind(b, a).run();
}
const relatedOf = async (id: string) =>
  (await env.DB.prepare("SELECT related_to FROM description_entities WHERE id = ?").bind(id).first<{ related_to: string | null }>())?.related_to;

describe("migration 0125 under D1", () => {
  beforeAll(async () => {
    await applyMigrations();
    mirror = await shape();
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    const entity = await createTestEntity({ entityCode: "ne-rel-1" });
    const repo = await createTestRepository({ code: "repo-rel" });
    const desc = await createTestDescription({ repositoryId: repo.id });
    descId = desc.id;
    entityId = entity.id;
    repoId = repo.id;
    await before0125();
    linkId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO description_entities (id, description_id, entity_id, role, sequence, function, created_at) VALUES (?, ?, ?, 'creator', 0, ?, 1)",
    )
      .bind(linkId, desc.id, entity.id, 'Escribano "público"')
      .run();
    await runMigrationFile("0125_relations.sql");
    await run("ALTER TABLE entities ADD COLUMN name_key TEXT");
    await run("CREATE INDEX entities_name_key_idx ON entities(federation_id, name_key)");
  });

  it("moves the link's function into attributes.office", async () => {
    const row = await env.DB.prepare("SELECT attributes FROM description_entities WHERE id = ?").bind(linkId).first<{ attributes: string }>();
    expect(JSON.parse(row!.attributes)).toEqual({ office: 'Escribano "público"' });
  });

  it("leaves the three tables in the shape of the test mirror", async () => {
    expect(await shape()).toEqual(mirror);
  });

  it("refuses to delete a link another link names, and to name a link that does not exist", async () => {
    await pair("fk-a", "fk-b");
    await expect(env.DB.prepare("DELETE FROM description_entities WHERE id = 'fk-a'").run()).rejects.toThrow(/FOREIGN KEY/);
    await expect(env.DB.prepare("UPDATE description_entities SET related_to = 'no-such-link' WHERE id = 'fk-a'").run()).rejects.toThrow(/FOREIGN KEY/);
    await expect(insertLink("fk-x", "no-such-link").run()).rejects.toThrow(/FOREIGN KEY/);
    expect(await relatedOf("fk-a")).toBe("fk-b");
  });

  it("in a batch, takes a repoint followed by the delete, and refuses the delete followed by the repoint with nothing written", async () => {
    await pair("fk-c", "fk-d");
    await env.DB.batch([
      insertLink("fk-e", null),
      env.DB.prepare("UPDATE description_entities SET related_to = 'fk-e' WHERE id = 'fk-d'"),
      env.DB.prepare("DELETE FROM description_entities WHERE id = 'fk-c'"),
    ]);
    expect(await relatedOf("fk-d")).toBe("fk-e");
    expect(await relatedOf("fk-c")).toBeUndefined();

    await pair("fk-f", "fk-g");
    await expect(
      env.DB.batch([
        insertLink("fk-h", null),
        env.DB.prepare("DELETE FROM description_entities WHERE id = 'fk-f'"),
        env.DB.prepare("UPDATE description_entities SET related_to = 'fk-h' WHERE id = 'fk-g'"),
      ]),
    ).rejects.toThrow(/FOREIGN KEY/);
    expect(await relatedOf("fk-f")).toBe("fk-g");
    expect(await relatedOf("fk-g")).toBe("fk-f");
    expect(await relatedOf("fk-h")).toBeUndefined();
  });

  it("still deletes a description with a relation on it, both sides with it", async () => {
    const other = await createTestDescription({ repositoryId: repoId });
    await pair("fk-i", "fk-j", other.id);
    await env.DB.prepare("DELETE FROM descriptions WHERE id = ?").bind(other.id).run();
    expect(await relatedOf("fk-i")).toBeUndefined();
    expect(await relatedOf("fk-j")).toBeUndefined();
  });
});

// @version v0.9.0
