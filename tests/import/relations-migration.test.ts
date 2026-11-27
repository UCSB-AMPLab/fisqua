/**
 * Tests — migration 0125, relations between people named in a document
 *
 * This suite builds `vocabulary_values`, `entities` and
 * `description_entities` in the shape production holds before 0125
 * (0119's vocabulary table as written; the link table as 0011 and 0040
 * left it; a stand-in for the parts of `entities` the migration does
 * not touch), writes rows into them, applies migration 0125 and pins
 * what it must do:
 *
 *   - a link's `function` moves into `attributes` under `office`,
 *     encoded as JSON (a value with quotes stays the same value), an
 *     empty or null `function` becomes `{}`, and the `function` column
 *     is gone;
 *   - the unique index on links lets a person hold a document-role link
 *     and a relation-side link with the same role on one description,
 *     and still refuses a second of either;
 *   - `relation_certainty` takes only `doubtful`, `inferred` and
 *     `derived`, and `attributes` only a JSON object;
 *   - `entities` gains `gender`, `known_only_from_relation` (0 on every
 *     existing row) and `qualified_name`;
 *   - `vocabulary_values` keeps every row unchanged, accepts the lists
 *     `relation_role`, `link_attribute` and `gender`, still refuses any
 *     other list, carries the connector, inverse, hide-when-group and
 *     label-form columns, and has its two indexes back.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../../drizzle/${name}`, import.meta.url)), "utf8");
const m0125 = read("0125_relations.sql");

// vocabulary_values exactly as 0119 creates it.
const VOCABULARY_0119 = `
CREATE TABLE vocabulary_values (
  id TEXT PRIMARY KEY NOT NULL,
  federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE RESTRICT,
  list TEXT NOT NULL
    CHECK (list IN ('entity_type','place_type','entity_role','place_role','role_group')),
  code TEXT NOT NULL,
  label_es TEXT,
  label_en TEXT,
  group_code TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  external_scheme TEXT,
  external_uri TEXT,
  external_label TEXT,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','proposed','deprecated')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX vocabulary_values_federation_list_code_idx ON vocabulary_values (federation_id, list, code);
CREATE INDEX vocabulary_values_position_idx ON vocabulary_values (federation_id, list, position);
`;

// description_entities as 0011 creates it, with 0040's role_raw.
const LINKS_0011_0040 = `
CREATE TABLE description_entities (
  id text PRIMARY KEY NOT NULL,
  description_id text NOT NULL,
  entity_id text NOT NULL,
  role text NOT NULL,
  role_note text,
  sequence integer DEFAULT 0 NOT NULL,
  honorific text,
  function text,
  name_as_recorded text,
  created_at integer NOT NULL,
  FOREIGN KEY (description_id) REFERENCES descriptions(id) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON UPDATE no action ON DELETE restrict
);
CREATE INDEX de_desc_idx ON description_entities (description_id);
CREATE INDEX de_entity_role_idx ON description_entities (entity_id, role);
CREATE UNIQUE INDEX de_unique_idx ON description_entities (description_id, entity_id, role);
ALTER TABLE description_entities ADD COLUMN role_raw TEXT;
`;

const LINK =
  "INSERT INTO description_entities (id, description_id, entity_id, role, role_note, sequence, honorific, function, name_as_recorded, created_at, role_raw) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

const VALUE =
  "INSERT INTO vocabulary_values (id, federation_id, list, code, label_es, label_en, group_code, position, external_scheme, external_uri, external_label, status, created_at, updated_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE federations (id TEXT PRIMARY KEY NOT NULL)");
  db.exec("CREATE TABLE descriptions (id TEXT PRIMARY KEY NOT NULL)");
  db.exec("CREATE TABLE entities (id TEXT PRIMARY KEY NOT NULL, display_name TEXT NOT NULL)");
  db.exec(VOCABULARY_0119);
  db.exec(LINKS_0011_0040);
  db.exec("INSERT INTO federations (id) VALUES ('f-1')");
  db.exec("INSERT INTO descriptions (id) VALUES ('d-1'), ('d-2')");
  db.exec("INSERT INTO entities (id, display_name) VALUES ('e-1', 'Uno'), ('e-2', 'Dos')");
  db.prepare(LINK).run("l-1", "d-1", "e-1", "creator", "nota", 1, "don", 'Escribano "público"', "Juan", 100, "otorgante");
  db.prepare(LINK).run("l-2", "d-1", "e-2", "witness", null, 0, null, null, null, 200, null);
  db.prepare(LINK).run("l-3", "d-2", "e-1", "mentioned", null, 0, null, "", null, 300, null);
  db.prepare(VALUE).run("v-1", "f-1", "role_group", "family", "Familia", "Family", null, 1, null, null, null, "approved", 10, 20);
  db.prepare(VALUE).run("v-2", "f-1", "entity_role", "spouse", "cónyuge", "spouse", "family", 2, null, null, null, "approved", 10, 20);
  db.prepare(VALUE).run("v-3", "f-1", "place_type", "city", "ciudad", "city", null, 0, "aat", "http://vocab.getty.edu/aat/1", "cities", "deprecated", 10, 20);
  return db;
}

const linkRows = (db: DatabaseSync) => db.prepare("SELECT * FROM description_entities ORDER BY id").all() as Array<Record<string, unknown>>;
const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
const names = (db: DatabaseSync, type: string, table: string) =>
  db
    .prepare(`SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all(type, table)
    .map((r) => (r as { name: string }).name);

const NEW_LINK =
  "INSERT INTO description_entities (id, description_id, entity_id, role, sequence, created_at, related_to, relation_certainty, attributes) " +
  "VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?)";

describe("migration 0125: relations", () => {
  it("moves each link's function into attributes.office and drops the column", () => {
    const db = database();
    db.exec(m0125);
    const rows = linkRows(db);
    expect(rows.map((r) => r.attributes)).toEqual(['{"office":"Escribano \\"público\\""}', "{}", "{}"]);
    expect(JSON.parse(rows[0].attributes as string)).toEqual({ office: 'Escribano "público"' });
    expect(columns(db, "description_entities")).not.toContain("function");
  });

  it("keeps every other value of every link unchanged", () => {
    const db = database();
    const before = linkRows(db).map(({ function: _f, ...rest }) => rest);
    db.exec(m0125);
    const after = linkRows(db).map(({ attributes: _a, related_to, relation_certainty, ...rest }) => {
      expect(related_to).toBeNull();
      expect(relation_certainty).toBeNull();
      return rest;
    });
    expect(after).toEqual(before);
  });

  it("lets a document-role link and a relation side share a role, and refuses duplicates of either", () => {
    const db = database();
    db.exec(m0125);
    // l-2 is (d-1, e-2, witness) with no related_to.
    db.prepare(NEW_LINK).run("r-1", "d-1", "e-2", "witness", "l-1", null, "{}");
    expect(() => db.prepare(NEW_LINK).run("r-2", "d-1", "e-2", "witness", null, null, "{}")).toThrow(/UNIQUE/);
    expect(() => db.prepare(NEW_LINK).run("r-3", "d-1", "e-2", "witness", "l-1", null, "{}")).toThrow(/UNIQUE/);
    db.prepare(NEW_LINK).run("r-4", "d-1", "e-2", "witness", "l-3", null, "{}");
  });

  it("takes only Fisqua's relation certainties and only a JSON object as attributes", () => {
    const db = database();
    db.exec(m0125);
    ["doubtful", "inferred", "derived"].forEach((c, i) =>
      db.prepare(NEW_LINK).run(`c-${i}`, "d-2", "e-2", `role-${i}`, "l-1", c, '{"age":"30"}'),
    );
    expect(() => db.prepare(NEW_LINK).run("c-x", "d-2", "e-2", "role-x", "l-1", "probable", "{}")).toThrow(/CHECK/);
    expect(() => db.prepare(NEW_LINK).run("c-y", "d-2", "e-2", "role-y", null, null, "[]")).toThrow(/CHECK/);
    expect(() => db.prepare(NEW_LINK).run("c-z", "d-2", "e-2", "role-z", null, null, "not json")).toThrow(/CHECK/);
    db.exec(
      "INSERT INTO description_entities (id, description_id, entity_id, role, sequence, created_at) VALUES ('c-d', 'd-2', 'e-2', 'role-d', 0, 1)",
    );
    expect(db.prepare("SELECT attributes FROM description_entities WHERE id = 'c-d'").get()).toEqual({ attributes: "{}" });
  });

  it("keeps the link indexes, with the loosened unique index and an index on related_to", () => {
    const db = database();
    db.exec(m0125);
    expect(names(db, "index", "description_entities")).toEqual([
      "de_desc_idx",
      "de_entity_role_idx",
      "de_related_to_idx",
      "de_unique_idx",
    ]);
    const unique = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'de_unique_idx'").get() as { sql: string };
    expect(unique.sql).toMatch(/COALESCE\(related_to, ''\)/);
  });

  it("adds gender, known_only_from_relation and qualified_name to entities", () => {
    const db = database();
    db.exec(m0125);
    expect(db.prepare("SELECT * FROM entities ORDER BY id").all()).toEqual([
      { id: "e-1", display_name: "Uno", gender: null, known_only_from_relation: 0, qualified_name: null },
      { id: "e-2", display_name: "Dos", gender: null, known_only_from_relation: 0, qualified_name: null },
    ]);
    db.exec(
      "INSERT INTO entities (id, display_name, gender, known_only_from_relation, qualified_name) VALUES ('e-3', 'María', 'female', 1, 'María, hija de Pedro Díaz')",
    );
  });

  it("keeps every vocabulary value unchanged and adds the relation columns", () => {
    const db = database();
    const before = db.prepare("SELECT * FROM vocabulary_values ORDER BY id").all() as Array<Record<string, unknown>>;
    db.exec(m0125);
    const after = db.prepare("SELECT * FROM vocabulary_values ORDER BY id").all() as Array<Record<string, unknown>>;
    const added = [
      "connector_es", "connector_en", "inverse_code", "hide_when_group",
      "label_es_female", "label_es_male", "label_es_unrecorded", "label_es_alone",
      "label_en_female", "label_en_male", "label_en_unrecorded", "label_en_alone",
    ];
    expect(after).toEqual(before.map((r) => ({ ...r, ...Object.fromEntries(added.map((c) => [c, null])) })));
    expect(names(db, "index", "vocabulary_values")).toEqual([
      "vocabulary_values_federation_list_code_idx",
      "vocabulary_values_position_idx",
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'vocabulary_values_next'").all()).toEqual([]);
  });

  it("accepts the relation_role, link_attribute and gender lists and still refuses others", () => {
    const db = database();
    expect(() =>
      db.prepare(VALUE).run("n-0", "f-1", "relation_role", "parent", null, null, null, 0, null, null, null, "approved", 1, 1),
    ).toThrow(/CHECK/);
    db.exec(m0125);
    ["entity_type", "place_type", "entity_role", "place_role", "role_group", "relation_role", "link_attribute", "gender"].forEach(
      (list, i) => db.prepare(VALUE).run(`n-${i}`, "f-1", list, `code-${i}`, null, null, null, 0, null, null, null, "approved", 1, 1),
    );
    expect(() =>
      db.prepare(VALUE).run("n-x", "f-1", "garbage", "x", null, null, null, 0, null, null, null, "approved", 1, 1),
    ).toThrow(/CHECK/);
    db.exec(
      "INSERT INTO vocabulary_values (id, federation_id, list, code, created_at, updated_at, connector_es, connector_en, inverse_code, " +
        "label_es_female, label_es_male, label_es_unrecorded, label_es_alone) " +
        "VALUES ('n-r', 'f-1', 'relation_role', 'enslaved', 1, 1, 'por', 'by', 'enslaver', 'esclavizada', 'esclavizado', 'persona esclavizada', NULL)",
    );
  });
});

// @version v0.9.0
