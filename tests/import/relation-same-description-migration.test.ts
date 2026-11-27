/**
 * Tests — migration 0126, a relation side must name a link on its own description
 *
 * This suite builds `descriptions` and `description_entities` in the
 * shape 0125 leaves them, writes document links and relations into them,
 * applies migration 0126 under Node's SQLite and pins what it must do:
 *
 *   - it writes no row: every row of both tables is as it was;
 *   - the database itself refuses an INSERT or an UPDATE of `related_to`
 *     that names a link missing or on another description, and an UPDATE
 *     of `description_id` that would leave a link naming, or named by, a
 *     link on another description;
 *   - every write the code makes on a relation still passes: a side
 *     inserted naming itself, the other side naming it, and the first
 *     then pointed at the second (as `add-relation` writes them); a
 *     repoint within the description; a merge's or a move's change of
 *     `entity_id`; a document link moved to another description; a
 *     deletion of both sides.
 *
 * `tests/schema/relation-same-description-migration.test.ts` runs the
 * same file under workerd's D1.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const m0126 = readFileSync(fileURLToPath(new URL("../../drizzle/0126_relation_same_description.sql", import.meta.url)), "utf8");

// The two tables as 0125 leaves them, with the columns the triggers read.
const DDL = `
PRAGMA foreign_keys = ON;
CREATE TABLE descriptions (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL);
CREATE TABLE description_entities (
  id TEXT PRIMARY KEY NOT NULL,
  description_id TEXT NOT NULL REFERENCES descriptions(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL,
  role TEXT NOT NULL,
  sequence INTEGER DEFAULT 0 NOT NULL,
  created_at INTEGER NOT NULL,
  related_to TEXT REFERENCES description_entities(id) ON DELETE NO ACTION,
  relation_certainty TEXT,
  attributes TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX de_unique_idx ON description_entities(description_id, entity_id, role, COALESCE(related_to, ''));
`;

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(DDL);
  db.exec("INSERT INTO descriptions VALUES ('d1', 't-1'), ('d2', 't-1'), ('d3', 't-1'), ('dx', 't-2')");
  const ins = db.prepare("INSERT INTO description_entities (id, description_id, entity_id, role, created_at, related_to) VALUES (?, ?, ?, ?, 1, ?)");
  // A relation on d1 (pa <-> ch), a document link on d1 and one on d2.
  ins.run("pa", "d1", "e-1", "parent", "pa");
  ins.run("ch", "d1", "e-2", "child", "pa");
  db.exec("UPDATE description_entities SET related_to = 'ch' WHERE id = 'pa'");
  ins.run("doc-1", "d1", "e-3", "witness", null);
  ins.run("doc-2", "d2", "e-3", "witness", null);
  // A relation on the other tenant's description.
  ins.run("fx", "dx", "e-9", "spouse", "fx");
  return db;
}

const dump = (db: DatabaseSync) =>
  JSON.stringify(["descriptions", "description_entities"].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()));

function migrated(): DatabaseSync {
  const db = database();
  db.exec(m0126);
  return db;
}

const refused = /a relation side must name a link on its own description/;

describe("migration 0126", () => {
  it("writes no row", () => {
    const db = database();
    const before = dump(db);
    db.exec(m0126);
    expect(dump(db)).toBe(before);
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all().map((r: any) => r.name);
    expect(triggers).toEqual([
      "description_entities_id_fixed",
      "description_entities_related_to_insert",
      "description_entities_related_to_move",
      "description_entities_related_to_update",
    ]);
  });

  it("refuses an insert naming a link on another description, or a missing one", () => {
    const db = migrated();
    const ins = db.prepare("INSERT INTO description_entities (id, description_id, entity_id, role, created_at, related_to) VALUES (?, ?, ?, ?, 1, ?)");
    // An outgoing link naming another tenant's link.
    expect(() => ins.run("out", "d1", "e-4", "spouse", "fx")).toThrow(refused);
    // Another tenant's link naming a local link.
    expect(() => ins.run("in", "dx", "e-8", "child", "pa")).toThrow(refused);
    // A link on another of the tenant's descriptions.
    expect(() => ins.run("near", "d2", "e-4", "child", "pa")).toThrow(refused);
    expect(() => ins.run("gone", "d1", "e-4", "child", "nothing")).toThrow(refused);
  });

  it("refuses replacing a named link with one on another description", () => {
    const db = migrated();
    // pa names ch on d1. INSERT OR REPLACE of ch under its id, on d2, would
    // leave pa naming a link on another description: no update trigger
    // fires, so the insert trigger checks the links naming the new row.
    expect(() =>
      db.exec("INSERT OR REPLACE INTO description_entities (id, description_id, entity_id, role, created_at) VALUES ('ch', 'd2', 'e-2', 'child', 1)"),
    ).toThrow(refused);
    expect(() =>
      db.exec("INSERT OR REPLACE INTO description_entities (id, description_id, entity_id, role, created_at) VALUES ('ch', 'dx', 'e-2', 'child', 1)"),
    ).toThrow(refused);
    // Replacing it on its own description passes.
    db.exec("INSERT OR REPLACE INTO description_entities (id, description_id, entity_id, role, created_at, related_to) VALUES ('ch', 'd1', 'e-2', 'child', 1, 'pa')");
  });

  it("refuses changing a link's id", () => {
    const db = migrated();
    // UPDATE OR REPLACE of another row onto pa's id would leave ch naming a
    // link on d2; a link's id never changes, so any change is refused.
    expect(() => db.exec("UPDATE OR REPLACE description_entities SET id = 'pa' WHERE id = 'doc-2'")).toThrow(/a link's id cannot be changed/);
    expect(() => db.exec("UPDATE description_entities SET id = 'renamed' WHERE id = 'doc-1'")).toThrow(/a link's id cannot be changed/);
    expect(() =>
      db.exec("INSERT INTO description_entities (id, description_id, entity_id, role, created_at) VALUES ('pa', 'd2', 'e-5', 'witness', 1) ON CONFLICT(id) DO UPDATE SET id = 'renamed'"),
    ).toThrow(/a link's id cannot be changed|a relation side must name a link on its own description/);
  });

  it("refuses an update of related_to naming a link on another description", () => {
    const db = migrated();
    expect(() => db.exec("UPDATE description_entities SET related_to = 'fx' WHERE id = 'doc-1'")).toThrow(refused);
    expect(() => db.exec("UPDATE description_entities SET related_to = 'pa' WHERE id = 'fx'")).toThrow(refused);
    expect(() => db.exec("UPDATE description_entities SET related_to = 'doc-2' WHERE id = 'doc-1'")).toThrow(refused);
  });

  it("refuses moving a related link, or a link a relation names, to another description", () => {
    const db = migrated();
    // pa names ch on d1, and ch names pa: neither can leave d1.
    expect(() => db.exec("UPDATE description_entities SET description_id = 'd2' WHERE id = 'pa'")).toThrow(refused);
    expect(() => db.exec("UPDATE description_entities SET description_id = 'd2' WHERE id = 'ch'")).toThrow(refused);
    // A side that names only itself, named by nothing, may move.
    db.exec("UPDATE description_entities SET description_id = 'd2' WHERE id = 'fx'");
  });

  it("passes every write the code makes on a relation", () => {
    const db = migrated();
    const ins = db.prepare("INSERT INTO description_entities (id, description_id, entity_id, role, created_at, related_to) VALUES (?, ?, ?, ?, 1, ?)");
    // add-relation: a naming itself, b naming a, then a naming b.
    ins.run("a", "d2", "e-5", "sibling", "a");
    ins.run("b", "d2", "e-6", "sibling", "a");
    db.exec("UPDATE description_entities SET related_to = 'b' WHERE id = 'a' AND related_to = 'a'");
    // A merge's repoint within the description, and its moves of entity_id.
    ins.run("pa2", "d1", "e-7", "parent", "ch");
    db.exec("UPDATE description_entities SET related_to = 'pa2' WHERE id = 'ch'");
    db.exec("UPDATE description_entities SET entity_id = 'e-1' WHERE id = 'ch'");
    // A document link moved to another description.
    db.exec("UPDATE description_entities SET description_id = 'd3' WHERE id = 'doc-1'");
    // A relation's sides deleted, the side named first unnamed.
    db.exec("UPDATE description_entities SET related_to = NULL WHERE id = 'ch'");
    db.exec("DELETE FROM description_entities WHERE id IN ('pa', 'pa2')");
    db.exec("DELETE FROM description_entities WHERE id = 'ch'");
    expect(db.prepare("SELECT id FROM description_entities ORDER BY id").all().map((r: any) => r.id)).toEqual(["a", "b", "doc-1", "doc-2", "fx"]);
  });
});

// @version v0.9.0
