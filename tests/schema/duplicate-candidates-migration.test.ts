/**
 * Tests — migration 0129 under D1
 *
 * This suite pins, under D1, the triggers of migration 0129. Migration
 * 0129 adds the stored duplicate-candidate tables, the `entities.name_key`
 * column and the triggers that mark an entity record in
 * `duplicate_recheck` whenever a write could change its duplicate
 * candidates. The test mirror in `tests/helpers/db.ts` holds the tables
 * and the column; the suite installs the migration's triggers on it with
 * `applyDuplicateRecheckTriggers()` and pins, one writer at a time, the
 * exact rows each single statement leaves in `duplicate_recheck`: what it
 * marks, and that a change to a field the list ignores marks nothing.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, cleanDatabase, seedFederations, seedTenants, DEFAULT_TEST_TENANT_ID, DEFAULT_TEST_FEDERATION_ID, SECOND_TEST_TENANT_ID } from "../helpers/db";
import { applyDuplicateRecheckTriggers } from "../helpers/duplicate-recheck";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestEntity } from "../helpers/entities";
import { createTestPlace } from "../helpers/places";
import { createTestUser } from "../helpers/auth";

type Mark = { entity_id: string; description_id: string; seq: number };

const run = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).run();
const marks = async (): Promise<Mark[]> =>
  (await env.DB.prepare("SELECT entity_id, description_id, seq FROM duplicate_recheck ORDER BY entity_id, description_id").all<Mark>()).results;
const pairs = async () => (await marks()).map((m) => [m.entity_id, m.description_id]);
const clear = () => run("DELETE FROM duplicate_recheck");
const link = (id: string, d: string, e: string, role: string, related: string | null = null) =>
  run("INSERT INTO description_entities (id, description_id, entity_id, role, created_at, related_to) VALUES (?, ?, ?, ?, 1, ?)", id, d, e, role, related);

describe("duplicate candidates migration", () => {
  let d1: string;
  let d2: string;
  let d3: string;
  let d4: string;
  let userId: string;
  let n = 0;

  beforeAll(async () => {
    await applyMigrations();
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    userId = (await createTestUser({ email: "dup-0129@example.test" })).id;
    await applyDuplicateRecheckTriggers();
    const repo = await createTestRepository({ tenantId: DEFAULT_TEST_TENANT_ID, code: "repo-0129" });
    d1 = (await createTestDescription({ tenantId: DEFAULT_TEST_TENANT_ID, repositoryId: repo.id })).id;
    d2 = (await createTestDescription({ tenantId: DEFAULT_TEST_TENANT_ID, repositoryId: repo.id })).id;
    d3 = (await createTestDescription({ tenantId: DEFAULT_TEST_TENANT_ID, repositoryId: repo.id })).id;
    d4 = (await createTestDescription({ tenantId: DEFAULT_TEST_TENANT_ID, repositoryId: repo.id })).id;
  });

  beforeEach(clear);

  const entity = async (id: string) => {
    await createTestEntity({ id, entityCode: `ne-0129-${++n}` });
    await clear();
    return id;
  };

  it("adds the name key column and the three tables", async () => {
    const cols = (await env.DB.prepare("PRAGMA table_info(entities)").all<{ name: string }>()).results.map((c) => c.name);
    expect(cols).toContain("name_key");
    for (const t of ["duplicate_recheck", "duplicate_name_deletions", "duplicate_candidates"]) {
      const row = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").bind(t).first();
      expect(row).not.toBeNull();
    }
    const idx = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all<{ name: string }>()).results.map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(["entities_name_key_idx", "duplicate_name_deletions_entity_idx", "duplicate_candidates_weight_idx", "duplicate_candidates_id_a_idx", "duplicate_candidates_id_b_idx"]));
  });

  it("marks a new entity", async () => {
    await createTestEntity({ id: "e-new", entityCode: "ne-0129-new" });
    expect(await pairs()).toEqual([["e-new", ""]]);
  });

  it("marks a renamed entity", async () => {
    const e = await entity("e-rename");
    await run("UPDATE entities SET display_name = 'Another Name' WHERE id = ?", e);
    expect(await pairs()).toEqual([["e-rename", ""]]);
  });

  it("marks an entity whose dates of existence change", async () => {
    await entity("e-doe");
    await run("UPDATE entities SET dates_of_existence = '1701-1760' WHERE id = 'e-doe'");
    expect(await pairs()).toEqual([["e-doe", ""]]);
    await clear();
    await run("UPDATE entities SET dates_of_existence = '1701-1760' WHERE id = 'e-doe'");
    expect(await pairs()).toEqual([]);
  });

  it("does not mark an entity whose only change is a field the list ignores", async () => {
    const e = await entity("e-history");
    await run("UPDATE entities SET history = 'A history' WHERE id = ?", e);
    await run("UPDATE entities SET display_name = display_name WHERE id = ?", e);
    expect(await marks()).toEqual([]);
  });

  it("marks a merged entity", async () => {
    const e = await entity("e-merged");
    const w = await entity("e-winner");
    await run("UPDATE entities SET merged_into = ? WHERE id = ?", w, e);
    expect(await pairs()).toEqual([["e-merged", ""]]);
  });

  it("marks a deleted entity", async () => {
    const e = await entity("e-deleted");
    await run("DELETE FROM entities WHERE id = ?", e);
    expect(await pairs()).toEqual([["e-deleted", ""]]);
  });

  it("marks the entity of an added, changed and removed function row", async () => {
    const e = await entity("e-func");
    await run("INSERT INTO entity_functions (id, entity_id, function, created_at, updated_at) VALUES ('f-1', ?, 'notary', 1, 1)", e);
    expect(await pairs()).toEqual([["e-func", ""]]);
    await clear();
    await run("UPDATE entity_functions SET function = 'scribe' WHERE id = 'f-1'");
    expect(await pairs()).toEqual([["e-func", ""]]);
    await clear();
    await run("DELETE FROM entity_functions WHERE id = 'f-1'");
    expect(await pairs()).toEqual([["e-func", ""]]);
  });

  it("marks a link with its description, old and new entity on a link move", async () => {
    const a = await entity("e-link-a");
    const b = await entity("e-link-b");
    await link("l-1", d1, a, "creator");
    expect(await pairs()).toEqual([["e-link-a", d1]]);
    await clear();
    await run("UPDATE description_entities SET entity_id = ? WHERE id = 'l-1'", b);
    expect(await pairs()).toEqual([["e-link-a", d1], ["e-link-b", d1]].sort());
    await clear();
    await run("DELETE FROM description_entities WHERE id = 'l-1'");
    expect(await pairs()).toEqual([["e-link-b", d1]]);
  });

  it("marks nothing when a link is only reordered or annotated", async () => {
    const a = await entity("e-ord-a");
    await link("l-ord", d1, a, "creator");
    await clear();
    await run("UPDATE description_entities SET sequence = 5, role_note = 'second', honorific = 'don', name_as_recorded = 'Juo' WHERE id = 'l-ord'");
    expect(await pairs()).toEqual([]);
    await run("UPDATE description_entities SET role = 'mentioned', attributes = '{\"office\":\"Alcalde\"}' WHERE id = 'l-ord'");
    expect(await pairs()).toEqual([]);
  });

  it("marks the old and new entity when a link changes entity, description or relation", async () => {
    const a = await entity("e-chg-a");
    const b = await entity("e-chg-b");
    await link("l-chg", d3, a, "creator");
    await clear();
    await run("UPDATE description_entities SET entity_id = ?, sequence = 2 WHERE id = 'l-chg'", b);
    expect(await pairs()).toEqual([["e-chg-a", d3], ["e-chg-b", d3]]);
    await clear();
    await run("UPDATE description_entities SET description_id = ? WHERE id = 'l-chg'", d4);
    expect(await pairs()).toEqual([["e-chg-b", d3], ["e-chg-b", d4]].sort());
    await clear();
    await run("UPDATE description_entities SET related_to = 'l-chg' WHERE id = 'l-chg'");
    expect(await pairs()).toEqual([["e-chg-b", d4]]);
    await run("DELETE FROM description_entities WHERE id = 'l-chg'");
  });

  it("marks both sides of a relation", async () => {
    const a = await entity("e-rel-a");
    const b = await entity("e-rel-b");
    await link("r-a", d2, a, "sibling", "r-a");
    await link("r-b", d2, b, "sibling", "r-a");
    expect(await pairs()).toEqual([["e-rel-a", d2], ["e-rel-b", d2]]);
  });

  it("marks both records of a separate operation", async () => {
    const a = await entity("e-sep-a");
    const b = await entity("e-sep-b");
    await run(
      "INSERT INTO authority_operations (id, federation_id, record_type, operation, source_id, target_id, user_id, created_at) VALUES ('op-1', ?, 'entity', 'separate', ?, ?, ?, 1)",
      DEFAULT_TEST_FEDERATION_ID, a, b, userId,
    );
    expect(await pairs()).toEqual([["e-sep-a", ""], ["e-sep-b", ""]]);
  });

  it("marks nothing for an operation the list excludes", async () => {
    await run(
      "INSERT INTO authority_operations (id, federation_id, record_type, operation, source_id, target_id, user_id, created_at) VALUES ('op-2', ?, 'entity', 'delete', 'x-1', NULL, ?, 1)",
      DEFAULT_TEST_FEDERATION_ID, userId,
    );
    await run(
      "INSERT INTO authority_operations (id, federation_id, record_type, operation, source_id, target_id, user_id, created_at) VALUES ('op-3', ?, 'place', 'merge', 'x-2', 'x-3', ?, 1)",
      DEFAULT_TEST_FEDERATION_ID, userId,
    );
    expect(await marks()).toEqual([]);
  });

  it("marks both records of a duplicate-pair ruling", async () => {
    const insert = "INSERT INTO pending_decisions (id, federation_id, kind, source_module, source_ref, status, created_at) VALUES (?, ?, ?, 'test', ?, 'open', 1)";
    await run(insert, "pd-0", DEFAULT_TEST_FEDERATION_ID, "authority-proposal", "e-pd-a|e-pd-b");
    expect(await marks()).toEqual([]);
    await run(insert, "pd-1", DEFAULT_TEST_FEDERATION_ID, "duplicate-pair", "e-pd-a|e-pd-b");
    expect(await pairs()).toEqual([["e-pd-a", ""], ["e-pd-b", ""]]);
    await clear();
    await run("UPDATE pending_decisions SET status = 'ruled' WHERE id = 'pd-1'");
    expect(await pairs()).toEqual([["e-pd-a", ""], ["e-pd-b", ""]]);
  });

  it("a second mark of the same record replaces the first", async () => {
    const e = await entity("e-twice");
    await run("UPDATE entities SET display_name = 'One' WHERE id = ?", e);
    const first = await marks();
    await run("UPDATE entities SET display_name = 'Two' WHERE id = ?", e);
    const second = await marks();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0].seq).toBeGreaterThan(first[0].seq);
  });

  it("marks the entity a replaced link leaves", async () => {
    const a = await entity("e-rl-a");
    const b = await entity("e-rl-b");
    await link("l-rep", d1, a, "creator");
    await clear();
    await run("INSERT OR REPLACE INTO description_entities (id, description_id, entity_id, role, created_at) VALUES ('l-rep', ?, ?, 'creator', 1)", d1, b);
    expect(await pairs()).toEqual([["e-rl-a", d1], ["e-rl-b", d1]]);
  });

  it("marks the entity a replaced function row leaves", async () => {
    const a = await entity("e-rf-a");
    const b = await entity("e-rf-b");
    await run("INSERT INTO entity_functions (id, entity_id, function, created_at, updated_at) VALUES ('f-rep', ?, 'notary', 1, 1)", a);
    await clear();
    await run("INSERT OR REPLACE INTO entity_functions (id, entity_id, function, created_at, updated_at) VALUES ('f-rep', ?, 'notary', 1, 1)", b);
    expect(await pairs()).toEqual([["e-rf-a", ""], ["e-rf-b", ""]]);
  });

  it("marks the entity a replaced entity record displaces, by id and by code", async () => {
    await createTestEntity({ id: "e-rep-old", entityCode: "ne-0129-rep" });
    await clear();
    const insert = "INSERT OR REPLACE INTO entities (id, federation_id, entity_code, display_name, sort_name, entity_type, legacy_ids, created_at, updated_at) VALUES (?, ?, ?, 'Name', 'Name', 'person', '[]', 1, 1)";
    await run(insert, "e-rep-new", DEFAULT_TEST_FEDERATION_ID, "ne-0129-rep");
    expect(await pairs()).toEqual([["e-rep-new", ""], ["e-rep-old", ""]]);
    await clear();
    await run(insert, "e-rep-new", DEFAULT_TEST_FEDERATION_ID, "ne-0129-other");
    expect(await pairs()).toEqual([["e-rep-new", ""]]);
  });

  it("a re-mark made under an outer OR IGNORE still raises seq", async () => {
    const a = await entity("e-ig-a");
    const b = await entity("e-ig-b");
    await run("UPDATE entities SET display_name = 'One' WHERE id = ?", a);
    const before = (await marks())[0].seq;
    await run("UPDATE OR IGNORE entities SET display_name = 'Two' WHERE id = ?", a);
    const afterUpdate = (await marks())[0].seq;
    expect(afterUpdate).toBeGreaterThan(before);
    const op = (id: string) =>
      run(
        `INSERT OR IGNORE INTO authority_operations (id, federation_id, record_type, operation, source_id, target_id, user_id, created_at) VALUES ('${id}', ?, 'entity', 'merge', ?, ?, ?, 1)`,
        DEFAULT_TEST_FEDERATION_ID, a, b, userId,
      );
    await op("op-ig-1");
    const first = (await marks()).find((m) => m.entity_id === a)!.seq;
    await op("op-ig-2");
    const second = (await marks()).find((m) => m.entity_id === a)!.seq;
    expect(first).toBeGreaterThan(afterUpdate);
    expect(second).toBeGreaterThan(first);
    expect(await marks()).toHaveLength(2);
  });

  it("marks the records linked to a description whose places change", async () => {
    const a = await entity("e-pl-a");
    const b = await entity("e-pl-b");
    const r = await entity("e-pl-rel");
    await link("pl-a", d3, a, "creator");
    await link("pl-b", d3, b, "creator");
    await link("pl-r", d3, r, "sibling", "pl-r");
    const place = (await createTestPlace({ placeCode: "nl-0129-1" })).id;
    await clear();
    await run("INSERT INTO description_places (id, description_id, place_id, role, created_at) VALUES ('dp-1', ?, ?, 'subject', 1)", d3, place);
    expect(await pairs()).toEqual([["e-pl-a", ""], ["e-pl-b", ""]]);
    await clear();
    await run("UPDATE description_places SET role = 'origin' WHERE id = 'dp-1'");
    expect(await pairs()).toEqual([["e-pl-a", ""], ["e-pl-b", ""]]);
    await clear();
    await run("UPDATE description_places SET description_id = ? WHERE id = 'dp-1'", d1);
    expect(await pairs()).toEqual([["e-pl-a", ""], ["e-pl-b", ""]]);
    await clear();
    await run("DELETE FROM description_places WHERE id = 'dp-1'");
    expect(await pairs()).toEqual([]);
    await run("INSERT INTO description_places (id, description_id, place_id, role, created_at) VALUES ('dp-2', ?, ?, 'subject', 1)", d3, place);
    await clear();
    await run("DELETE FROM description_places WHERE id = 'dp-2'");
    expect(await pairs()).toEqual([["e-pl-a", ""], ["e-pl-b", ""]]);
  });

  it("marks the records linked to a description moved to another workspace", async () => {
    const a = await entity("e-ws-a");
    await link("ws-a", d4, a, "creator");
    await clear();
    await run("UPDATE descriptions SET tenant_id = ? WHERE id = ?", SECOND_TEST_TENANT_ID, d4);
    expect(await pairs()).toEqual([["e-ws-a", ""]]);
  });

  it("a description update that leaves tenant_id unchanged marks nothing", async () => {
    const a = await entity("e-ws-same");
    await link("ws-same", d3, a, "creator");
    await clear();
    await run("UPDATE descriptions SET tenant_id = tenant_id, title = 'Other title' WHERE id = ?", d3);
    expect(await marks()).toEqual([]);
  });
});
