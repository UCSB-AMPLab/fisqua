/**
 * Tests — the four additions of the command line's authority changes
 *
 * This suite pins the operations of `scripts/lib/authorities-cli/`
 * that add to the catalogue: `create-entity`, `add-link`,
 * `add-place-link` and `add-relation`, and the `gender` field of
 * `update-entity`. The run is driven end to end against an in-memory
 * `node:sqlite` database with the tables and columns the engine reads
 * and writes, foreign keys on and D1's expression depth limit of 100;
 * the file it writes is applied as one unit, as `wrangler d1 execute
 * --file` applies it. Nothing here reaches D1.
 *
 * The vocabulary is the test's own: every code a row gives is checked
 * against the federation's `vocabulary_values`, so the codes here are
 * data, not constants of the engine.
 *
 *   - the change file: `authority_code` and `authority_name` only for
 *     the existing operations, and `authority_name` on add-link and
 *     add-place-link as a check of the record named, blank for a
 *     `new:<key>`; `attr_`, `a_attr_` and `b_attr_` columns;
 *     the header of the AHRB relations file;
 *   - each operation plans, applies, reads back, and a second run
 *     writes nothing and reports every row done;
 *   - `new:<key>` in any row order; a key undefined or defined twice;
 *   - relation pairs: symmetric, gendered, a side derived when one code
 *     fits and refused when several do, a filled pair that cannot be
 *     paired;
 *   - attribute keys and the attributes JSON; a relation code on a
 *     document link;
 *   - duplicates, in the file and in D1: a link or place link D1
 *     holds under another id with the row's values is same, with other
 *     values refused; the link found is guarded as read;
 *   - the closing guard that every link written is in a description of
 *     the acting tenant;
 *   - a vocabulary value or a description changed between plan and
 *     apply aborts the file whole.
 *
 * @version v0.9.0
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { parseChangeFile } from "../../scripts/lib/authorities-cli/change-file";
import { runAuthorities, type AuthoritiesReport } from "../../scripts/lib/authorities-cli/run";
import { d1Read } from "./d1-limits";

const D1_LIMITS = { limits: { exprDepth: 100 } } as unknown as ConstructorParameters<typeof DatabaseSync>[1];

const FED = "fed-1";
const TENANT = "t-1";
const FILE = "relations-test.csv";
const NOW = 1_763_500_000_000;

const DDL = `
PRAGMA foreign_keys = ON;
CREATE TABLE federations (id TEXT PRIMARY KEY, slug TEXT, status TEXT, lead_tenant_id TEXT, shared_authorities_enabled INTEGER,
  entity_code_prefix TEXT, place_code_prefix TEXT);
CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, federation_id TEXT, disabled_at INTEGER, authorities_enabled INTEGER,
  entity_code_prefix TEXT, place_code_prefix TEXT);
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, tenant_id TEXT, is_admin INTEGER DEFAULT 0, is_super_admin INTEGER DEFAULT 0,
  is_records_admin INTEGER DEFAULT 0, is_authorities_admin INTEGER DEFAULT 0, is_imports_admin INTEGER DEFAULT 0,
  is_digitization_admin INTEGER DEFAULT 0);
CREATE TABLE federation_memberships (id TEXT PRIMARY KEY, user_id TEXT, federation_id TEXT, role TEXT);
CREATE TABLE descriptions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, reference_code TEXT);
CREATE TABLE vocabulary_terms (id TEXT PRIMARY KEY, federation_id TEXT, canonical TEXT, merged_into TEXT, entity_count INTEGER DEFAULT 0,
  updated_at INTEGER);
CREATE TABLE vocabulary_values (id TEXT PRIMARY KEY NOT NULL, federation_id TEXT NOT NULL, list TEXT NOT NULL, code TEXT NOT NULL,
  label_es TEXT, label_en TEXT, group_code TEXT, position INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'approved',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, inverse_code TEXT);
CREATE UNIQUE INDEX vocabulary_values_federation_list_code_idx ON vocabulary_values (federation_id, list, code);
CREATE TABLE entities (id TEXT PRIMARY KEY, federation_id TEXT NOT NULL, tenant_id TEXT, entity_code TEXT, display_name TEXT NOT NULL,
  sort_name TEXT NOT NULL, surname TEXT, given_name TEXT, entity_type TEXT NOT NULL, honorific TEXT, primary_function TEXT,
  primary_function_id TEXT, name_variants TEXT DEFAULT '[]', dates_of_existence TEXT, date_start TEXT, date_end TEXT, history TEXT,
  functions TEXT, sources TEXT, merged_into TEXT, wikidata_id TEXT, viaf_id TEXT, dbe_id TEXT, legacy_ids TEXT NOT NULL DEFAULT '[]',
  notes TEXT, internal_notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, gender TEXT,
  known_only_from_relation INTEGER NOT NULL DEFAULT 0, qualified_name TEXT, name_key TEXT);
CREATE UNIQUE INDEX entity_code_idx ON entities (federation_id, entity_code);
CREATE TABLE places (id TEXT PRIMARY KEY, federation_id TEXT NOT NULL, tenant_id TEXT, place_code TEXT, label TEXT NOT NULL,
  display_name TEXT NOT NULL, merged_into TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE description_entities (id TEXT PRIMARY KEY, description_id TEXT NOT NULL REFERENCES descriptions(id),
  entity_id TEXT NOT NULL REFERENCES entities(id), role TEXT NOT NULL,
  role_note TEXT, role_raw TEXT, sequence INTEGER NOT NULL DEFAULT 0, honorific TEXT, name_as_recorded TEXT,
  created_at INTEGER NOT NULL, related_to TEXT REFERENCES description_entities(id) ON DELETE NO ACTION,
  relation_certainty TEXT CHECK (relation_certainty IS NULL OR relation_certainty IN ('doubtful','inferred','derived')),
  attributes TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes) AND json_type(attributes) = 'object'));
CREATE UNIQUE INDEX de_unique_idx ON description_entities (description_id, entity_id, role, COALESCE(related_to, ''));
CREATE TABLE description_places (id TEXT PRIMARY KEY, description_id TEXT NOT NULL REFERENCES descriptions(id),
  place_id TEXT NOT NULL REFERENCES places(id), role TEXT NOT NULL, role_note TEXT, role_raw TEXT, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX dp_unique_idx ON description_places (description_id, place_id, role);
CREATE TABLE entity_functions (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, honorific TEXT, function TEXT NOT NULL, date_start TEXT,
  date_end TEXT, date_note TEXT, certainty TEXT DEFAULT 'probable', source TEXT, notes TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
CREATE TABLE changelog (id TEXT PRIMARY KEY, record_id TEXT NOT NULL, record_type TEXT NOT NULL, user_id TEXT NOT NULL, note TEXT,
  diff TEXT NOT NULL, run_id TEXT, kind TEXT NOT NULL DEFAULT 'update', created_at INTEGER NOT NULL, acted_as TEXT);
CREATE TABLE authority_operations (id TEXT PRIMARY KEY, federation_id TEXT NOT NULL, record_type TEXT NOT NULL, operation TEXT NOT NULL,
  source_id TEXT NOT NULL, target_id TEXT, user_id TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
`;

/** The test's vocabulary: list, code, inverse. `tutor` and `curador` share the inverse `ward`. */
const VOCABULARY: Array<[string, string, string | null]> = [
  ["entity_type", "person", null], ["entity_type", "corporate", null], ["entity_type", "family", null],
  ["entity_role", "witness", null], ["entity_role", "mentioned", null], ["entity_role", "plaintiff", null], ["entity_role", "spouse", null],
  ["place_role", "venue", null], ["place_role", "mentioned", null],
  ["gender", "female", null], ["gender", "male", null],
  ["link_attribute", "office", null], ["link_attribute", "residence", null], ["link_attribute", "age", null],
  ["relation_role", "parent", "child"], ["relation_role", "child", "parent"],
  ["relation_role", "spouse", "spouse"], ["relation_role", "surviving_spouse", "spouse"],
  ["relation_role", "sibling", "sibling"],
  ["relation_role", "tutor", "ward"], ["relation_role", "curador", "ward"], ["relation_role", "ward", "tutor"],
];

const AA = { id: "e-a", code: "ne-aaaaaa", name: "Juana Díaz", gender: "female" };
const BB = { id: "e-b", code: "ne-bbbbbb", name: "Diego Díaz", gender: "male" };
const CC = { id: "e-c", code: "ne-cccccc", name: "Ana Ruiz", gender: null };
const MERGED = { id: "e-m", code: "ne-mmmmmm", name: "Merged", gender: null, merged: "e-a" };
const PLACE = { id: "p-1", code: "nl-pppppp", name: "Tunja" };

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:", D1_LIMITS);
  db.exec(DDL);
  db.exec(`INSERT INTO federations VALUES ('${FED}', 'neogranadina-fed', 'active', '${TENANT}', 1, 'ne', 'nl');`);
  db.exec(`INSERT INTO tenants VALUES ('${TENANT}', 'neogranadina', '${FED}', NULL, 1, 'ne', 'nl'), ('t-2', 'other', '${FED}', NULL, 1, 'ot', 'op');`);
  db.exec(`INSERT INTO users (id, email, name, tenant_id, is_admin) VALUES ('user_001', 'admin@example.org', 'Admin', '${TENANT}', 1);`);
  db.exec(`INSERT INTO descriptions VALUES ('d1', '${TENANT}', 'co-test-001-d001'), ('d2', '${TENANT}', 'co-test-001-d002'), ('d9', 't-2', 'co-other-d009');`);
  const v = db.prepare("INSERT INTO vocabulary_values (id, federation_id, list, code, created_at, updated_at, inverse_code) VALUES (?, ?, ?, ?, 1, 1, ?)");
  VOCABULARY.forEach(([list, code, inverse], i) => v.run(`v-${i}`, FED, list, code, inverse));
  const e = db.prepare(
    "INSERT INTO entities (id, federation_id, tenant_id, entity_code, display_name, sort_name, entity_type, gender, merged_into, created_at, updated_at) " +
      "VALUES (?, ?, NULL, ?, ?, ?, 'person', ?, ?, 1, 5)",
  );
  for (const x of [AA, BB, CC, MERGED]) e.run(x.id, FED, x.code, x.name, x.name, x.gender, (x as { merged?: string }).merged ?? null);
  db.exec(`INSERT INTO places VALUES ('${PLACE.id}', '${FED}', NULL, '${PLACE.code}', '${PLACE.name}', '${PLACE.name}', NULL, 1, 1);`);
  return db;
}

const HEADER = [
  "op", "new_key", "display_name", "sort_name", "surname", "given_name", "entity_type", "gender", "qualified_name", "known_only_from_relation",
  "description_code", "entity", "place", "role", "name_as_recorded", "role_raw", "honorific", "attr_office", "attr_residence", "role_note",
  "sequence", "certainty",
  "a_entity", "a_role", "a_name_as_recorded", "a_role_raw", "a_honorific", "a_attr_office", "a_attr_residence", "a_role_note", "a_sequence", "a_certainty",
  "b_entity", "b_role", "b_name_as_recorded", "b_role_raw", "b_honorific", "b_attr_office", "b_attr_residence", "b_role_note", "b_sequence", "b_certainty",
  "changelog_note", "evidence",
];

type Cells = Record<string, string>;
const csvOf = (header: string[], rows: Cells[]) =>
  [header.join(","), ...rows.map((r) => header.map((h) => {
    const v = r[h] ?? "";
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(","))].join("\n") + "\n";

const create = (key: string, name: string, over: Cells = {}): Cells => ({
  op: "create-entity", new_key: key, display_name: name, sort_name: name, entity_type: "person", known_only_from_relation: "0",
  changelog_note: "From the people list", evidence: "img 0001", ...over,
});
const link = (entity: string, role: string, over: Cells = {}): Cells => ({
  op: "add-link", description_code: "co-test-001-d001", entity, role, changelog_note: "Link from the people list", ...over,
});
const placeLink = (place: string, role: string, over: Cells = {}): Cells => ({
  op: "add-place-link", description_code: "co-test-001-d001", place, role, ...over,
});
const relation = (a: string, aRole: string, b: string, bRole: string, over: Cells = {}): Cells => ({
  op: "add-relation", description_code: "co-test-001-d001", a_entity: a, a_role: aRole, b_entity: b, b_role: bRole,
  changelog_note: "Relation from the description", ...over,
});

function applyAsOneUnit(db: DatabaseSync, statements: string[]): void {
  db.exec("BEGIN");
  try {
    db.exec(statements.join("\n"));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

async function run(
  db: DatabaseSync,
  rows: Cells[],
  opts: { apply?: boolean; now?: number; header?: string[]; file?: string; text?: string; beforeApply?: (db: DatabaseSync, statements: string[]) => void } = {},
): Promise<{ report: AuthoritiesReport; applied: string[][]; written: Map<string, string> }> {
  const written = new Map<string, string>();
  const applied: string[][] = [];
  const file = opts.file ?? FILE;
  let n = 0;
  const report = await runAuthorities(
    { file, rows: parseChangeFile(opts.text ?? csvOf(opts.header ?? HEADER, rows), file) },
    { target: "staging", tenant: "neogranadina", actorEmail: "admin@example.org", apply: opts.apply ?? false, confirmProduction: false },
    {
      rows: async (sql) => d1Read(db, sql),
      writeFile: (p, t) => written.set(p, t),
      createFile: (p, t) => {
        if (written.has(p)) throw new Error(`EEXIST: ${p}`);
        written.set(p, t);
      },
      readFile: (p) => written.get(p) ?? "",
      newId: () => `0f1e2d3c-0000-4000-8000-${String(++n).padStart(12, "0")}`,
      applyFile: (_p, statements) => {
        applied.push(statements);
        opts.beforeApply?.(db, statements);
        applyAsOneUnit(db, statements);
      },
      now: () => opts.now ?? NOW,
    },
    () => {},
  );
  return { report, applied, written };
}

const all = (db: DatabaseSync, sql: string) => db.prepare(sql).all() as Array<Record<string, any>>;
const reasons = (r: AuthoritiesReport) => r.refusals.map((f) => `${f.ref}: ${f.reason}`).join("\n");
const snapshot = (db: DatabaseSync) =>
  JSON.stringify(["entities", "description_entities", "description_places", "changelog"].map((t) => all(db, `SELECT * FROM ${t} ORDER BY rowid`)));

/** A file with each of the four operations, the keys referred to before they are defined. */
const fullRows = (): Cells[] => [
  link("new:k-uno", "witness", { name_as_recorded: "Pedro Uno", role_raw: "testigo", honorific: "don", attr_residence: "vecino de Tunja", attr_office: "regidor", sequence: "3" }),
  relation("new:k-uno", "child", AA.code, "parent", { a_name_as_recorded: "Pedro", a_role_raw: "hijo legítimo de", a_sequence: "4", b_honorific: "doña", b_certainty: "doubtful" }),
  relation(BB.code, "sibling", CC.code, "sibling", { a_attr_residence: "vecino de Tunja" }),
  relation("new:k-dos", "tutor", BB.code, "", { a_role_raw: "tutor de" }),
  placeLink(PLACE.code, "venue", { role_note: "en la ciudad" }),
  create("k-uno", "Pedro Uno", { sort_name: "Uno, Pedro", surname: "Uno", given_name: "Pedro", gender: "male" }),
  create("k-dos", "María", { gender: "female", qualified_name: "María, tutora de Diego Díaz", known_only_from_relation: "1" }),
];

// ---------------------------------------------------------------------------
// The change file
// ---------------------------------------------------------------------------

describe("the change file", () => {
  it("needs authority_code and authority_name only for the existing operations", async () => {
    const header = ["op", "new_key", "display_name", "sort_name", "entity_type"];
    expect(parseChangeFile(csvOf(header, [create("k", "Pedro")]), FILE)).toHaveLength(1);
    expect(() => parseChangeFile(csvOf(header, [{ op: "update-entity" }]), FILE)).toThrow(/missing columns authority_code, authority_name/);
    const { report } = await run(database(), [{ ...create("k", "Pedro"), authority_code: AA.code, authority_name: AA.name }], {
      header: [...HEADER, "authority_code", "authority_name"],
    });
    expect(reasons(report)).toMatch(/create-entity carries no authority_code, authority_name/);
  });

  it("accepts attribute columns, and refuses an unknown column that is not one", () => {
    expect(parseChangeFile(csvOf([...HEADER, "attr_age", "a_attr_age"], [link(AA.code, "witness")]), FILE)).toHaveLength(1);
    expect(() => parseChangeFile(csvOf([...HEADER, "colour"], []), FILE)).toThrow(/unknown columns colour/);
    expect(() => parseChangeFile(csvOf([...HEADER, "c_attr_age"], []), FILE)).toThrow(/unknown columns c_attr_age/);
  });

  it("reads the header of the AHRB relations file", () => {
    const text = fs.readFileSync(path.join(__dirname, "fixtures", "authorities-additions-header.csv"), "utf8");
    const rows = parseChangeFile(text, "relations-1.csv");
    expect(rows.map((r) => r.cells.op)).toEqual(["create-entity", "add-link", "add-place-link", "add-relation"]);
    expect(rows[1].cells.attr_residence).toBe("vecino de Tunja");
    expect(rows[3].cells.b_certainty).toBe("derived");
  });
});

// ---------------------------------------------------------------------------
// The four operations
// ---------------------------------------------------------------------------

describe("the four operations", () => {
  it("plan, apply and read back; a second run writes nothing and reports every row done", async () => {
    const db = database();
    const dry = await run(db, fullRows());
    expect(reasons(dry.report)).toBe("");
    expect(dry.report.outcome).toBe("dry run");
    expect(dry.report.totals).toMatchObject({ rows: 7, create: 2, link: 1, placeLink: 1, relate: 3, alreadyDone: 0 });

    const before = snapshot(db);
    const { report } = await run(db, fullRows(), { apply: true });
    expect(reasons(report)).toBe("");
    expect(report.problems).toEqual([]);
    expect(report.outcome).toBe("verified");
    expect(snapshot(db)).not.toBe(before);

    // The records: codes under the federation's prefix, the fields the file gives.
    const made = all(db, "SELECT * FROM entities WHERE created_at = " + NOW + " ORDER BY display_name");
    expect(made.map((e) => [e.display_name, e.gender, e.known_only_from_relation, e.qualified_name, e.tenant_id])).toEqual([
      ["María", "female", 1, "María, tutora de Diego Díaz", null],
      ["Pedro Uno", "male", 0, null, null],
    ]);
    for (const e of made) expect(e.entity_code).toMatch(/^ne-[a-z2-9]{6}$/);
    const uno = made.find((e) => e.display_name === "Pedro Uno")!;
    const dos = made.find((e) => e.display_name === "María")!;
    expect(uno).toMatchObject({ sort_name: "Uno, Pedro", surname: "Uno", given_name: "Pedro", entity_type: "person", name_variants: "[]", updated_at: NOW });

    // The document link, its attributes exactly as written.
    const [doc] = all(db, `SELECT * FROM description_entities WHERE entity_id = '${uno.id}' AND role = 'witness'`);
    expect(doc).toMatchObject({ description_id: "d1", name_as_recorded: "Pedro Uno", role_raw: "testigo", honorific: "don", sequence: 3, related_to: null, relation_certainty: null });
    expect(doc.attributes).toBe(JSON.stringify({ office: "regidor", residence: "vecino de Tunja" }));

    // The relations: two links, each naming the other.
    const sides = all(db, "SELECT * FROM description_entities WHERE related_to IS NOT NULL");
    expect(sides).toHaveLength(6);
    for (const s of sides) {
      const other = sides.find((o) => o.id === s.related_to)!;
      expect(other.related_to).toBe(s.id);
      expect(other.description_id).toBe(s.description_id);
    }
    const side = (entity: string, role: string) => sides.find((s) => s.entity_id === entity && s.role === role)!;
    expect(side(uno.id, "child")).toMatchObject({ role_raw: "hijo legítimo de", name_as_recorded: "Pedro", sequence: 4, relation_certainty: null, attributes: "{}" });
    expect(side(AA.id, "parent")).toMatchObject({ honorific: "doña", relation_certainty: "doubtful", related_to: side(uno.id, "child").id });
    expect(side(BB.id, "sibling").attributes).toBe(JSON.stringify({ residence: "vecino de Tunja" }));
    expect(side(CC.id, "sibling").related_to).toBe(side(BB.id, "sibling").id);
    // The side the file leaves blank: the one code that fits, derived.
    expect(side(BB.id, "ward")).toMatchObject({ relation_certainty: "derived", related_to: side(dos.id, "tutor").id });

    const [pl] = all(db, "SELECT * FROM description_places");
    expect(pl).toMatchObject({ description_id: "d1", place_id: PLACE.id, role: "venue", role_note: "en la ciudad", created_at: NOW });

    // The changelog: a create row per record, a link row per link, on the description.
    const journal = all(db, "SELECT * FROM changelog ORDER BY rowid");
    expect(journal.filter((j) => j.kind === "create").map((j) => j.record_id).sort()).toEqual([uno.id, dos.id].sort());
    const links = journal.filter((j) => j.kind === "link");
    expect(links).toHaveLength(8);
    for (const j of links) expect(j).toMatchObject({ record_type: "description", record_id: "d1", user_id: "user_001" });
    const docJournal = JSON.parse(links.find((j) => JSON.parse(j.diff).id === doc.id)!.diff);
    expect(docJournal).toMatchObject({ entityId: uno.id, role: "witness", attributes: doc.attributes, relatedTo: null });
    const createJournal = JSON.parse(journal.find((j) => j.record_id === uno.id)!.diff);
    expect(createJournal.displayName).toEqual({ old: null, new: "Pedro Uno" });
    expect(createJournal.gender).toEqual({ old: null, new: "male" });
    expect(all(db, "SELECT note FROM changelog WHERE kind = 'create'").map((r) => r.note)).toEqual(["From the people list", "From the people list"]);
    // The reviewer's column is never written.
    expect(JSON.stringify(all(db, "SELECT * FROM changelog"))).not.toContain("img 0001");

    // A second run writes nothing and reports every row done.
    const after = snapshot(db);
    const again = await run(db, fullRows(), { apply: true, now: NOW + 5000 });
    expect(reasons(again.report)).toBe("");
    expect(again.report.outcome).toBe("nothing to write");
    expect(again.applied).toEqual([]);
    expect(again.report.rows.map((r) => r.status).sort()).toEqual(
      ["already created", "already created", "already linked", "already place-linked", "already related", "already related", "already related"],
    );
    expect(snapshot(db)).toBe(after);
  });

  it("refuses a rerun under another file name, whose keys are new and whose relations another file wrote", async () => {
    const db = database();
    expect((await run(db, fullRows(), { apply: true })).report.outcome).toBe("verified");
    const { report } = await run(db, fullRows(), { file: "relations-renamed.csv" });
    expect(report.outcome).toBe("refused");
    expect(reasons(report)).toMatch(/line 4: co-test-001-d001 already holds this relation between ne-bbbbbb \(sibling\) and ne-cccccc \(sibling\), not written by this file/);
    // A place link held with the row's values is same, whichever file wrote it.
    expect(reasons(report)).not.toMatch(/line 6:/);
    expect(report.rows.find((r) => r.line === 6)?.status).toBe("same");
  });
});

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

describe("new:<key>", () => {
  it("resolves a key defined after the rows that refer to it", async () => {
    const { report } = await run(database(), [link("new:k", "witness"), create("k", "Pedro")]);
    expect(reasons(report)).toBe("");
  });

  it("refuses a key never defined, and a key defined twice", async () => {
    const undefinedKey = await run(database(), [link("new:nadie", "witness")]);
    expect(reasons(undefinedKey.report)).toMatch(/new:nadie is not defined by any create-entity row/);
    const twice = await run(database(), [create("k", "Pedro"), create("k", "Pedro Díaz"), link("new:k", "witness")]);
    expect(reasons(twice.report)).toMatch(/new_key k is defined again \(line 2\)/);
  });

  it("refuses a key whose record an earlier run made and that now holds other values", async () => {
    const db = database();
    expect((await run(db, [create("k", "Pedro", { gender: "male" })], { apply: true })).report.outcome).toBe("verified");
    db.exec(`UPDATE entities SET gender = 'female' WHERE created_at = ${NOW}`);
    const { report } = await run(db, [create("k", "Pedro", { gender: "male" })]);
    expect(reasons(report)).toMatch(/k's record .* holds other values in gender/);
  });
});

// ---------------------------------------------------------------------------
// The rows themselves
// ---------------------------------------------------------------------------

describe("create-entity", () => {
  it("checks the entity type, gender and the flag against the federation's vocabulary", async () => {
    const { report } = await run(database(), [
      create("k1", "Uno", { entity_type: "robot" }),
      create("k2", "Dos", { gender: "other" }),
      create("k3", "Tres", { known_only_from_relation: "yes" }),
      create("k4", "Cuatro", { gender: "" , known_only_from_relation: "" }),
      create("", "Cinco"),
    ]);
    const r = reasons(report);
    expect(r).toMatch(/line 2: entity_type "robot" is not in the federation's entity_type list/);
    expect(r).toMatch(/line 3: gender "other" is not in the federation's gender list/);
    expect(r).toMatch(/line 4: known_only_from_relation is 0, 1 or blank/);
    expect(r).not.toMatch(/line 5/);
    expect(r).toMatch(/line 6: create-entity names no new_key/);
  });
});

describe("add-link", () => {
  it("refuses a relation code that is not a document role, a role outside the document roles, and any certainty", async () => {
    const { report } = await run(database(), [
      link(AA.code, "parent"),
      link(AA.code, "astronaut"),
      link(BB.code, "witness", { certainty: "possible" }),
      link(CC.code, "witness", { certainty: "certain" }),
      link(CC.code, "mentioned", { sequence: "x" }),
    ]);
    const r = reasons(report);
    expect(r).toMatch(/line 2: parent is a relation role of the federation and not a document role; add-relation carries it/);
    expect(r).toMatch(/line 3: role "astronaut" is not a document role/);
    expect(r).toMatch(/line 4: add-link carries no certainty/);
    expect(r).toMatch(/line 5: add-link carries no certainty/);
    expect(r).toMatch(/line 6: sequence "x" is not a whole number/);
  });

  it("accepts a document role that is also a relation role", async () => {
    const db = database();
    const { report } = await run(db, [link(AA.code, "spouse")], { apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    expect(all(db, "SELECT role, related_to FROM description_entities")).toEqual([{ role: "spouse", related_to: null }]);
  });

  it("refuses a create whose record a merge row of the file merges away, and one an applied merge took", async () => {
    const db = database();
    expect((await run(db, [create("k", "Pedro")], { apply: true })).report.outcome).toBe("verified");
    const [made] = all(db, `SELECT id, entity_code FROM entities WHERE created_at = ${NOW}`);
    const header = [...HEADER, "authority_code", "authority_name", "target_codes", "label_to_keep", "name_variants_add", "facts", "evidence_codes"];
    const merge = {
      op: "merge-entity", authority_code: made.entity_code, authority_name: "Pedro", target_codes: AA.code, label_to_keep: AA.name, name_variants_add: "Pedro",
      facts: "matter", evidence_codes: "co-test-001-d001 co-test-001-d002",
    };
    const before = snapshot(db);
    const { report } = await run(db, [create("k", "Pedro"), merge], { header, apply: true, now: NOW + 1000 });
    expect(report.outcome).toBe("refused");
    expect(reasons(report)).toMatch(/line 2: k's record .* is merged by line 3, so the file may not also make it/);
    expect(snapshot(db)).toBe(before);
    // Merged by another file: the create is refused, not reported done. The merge cites a link of each record.
    db.exec(`INSERT INTO description_entities (id, description_id, entity_id, role, created_at) VALUES ('l-p', 'd1', '${made.id}', 'witness', 1), ('l-a', 'd2', '${AA.id}', 'witness', 1)`);
    const merged = await run(db, [merge], { header, apply: true, now: NOW + 2000, file: "merge.csv" });
    expect(reasons(merged.report)).toBe("");
    expect(merged.report.outcome).toBe("verified");
    const again = await run(db, [create("k", "Pedro")], { now: NOW + 3000 });
    expect(reasons(again.report)).toMatch(/line 2: k's record .* has been merged into e-a/);
  });

  it("refuses a new record that a merge row of the file merges away", async () => {
    const db = database();
    expect((await run(db, [create("k", "Pedro")], { apply: true })).report.outcome).toBe("verified");
    const [made] = all(db, `SELECT entity_code FROM entities WHERE created_at = ${NOW}`);
    const header = [...HEADER, "authority_code", "authority_name", "target_codes", "label_to_keep"];
    const merge = { op: "merge-entity", authority_code: made.entity_code, authority_name: "Pedro", target_codes: AA.code, label_to_keep: AA.name };
    const before = snapshot(db);
    const { report } = await run(db, [create("k", "Pedro"), merge, link("new:k", "witness")], { header, apply: true, now: NOW + 1000 });
    expect(report.outcome).toBe("refused");
    // The create is refused for the merge, and the link with it.
    expect(reasons(report)).toMatch(/line 2: k's record .* is merged by line 3/);
    expect(reasons(report)).toMatch(/line 4: new:k is refused at line 2/);
    expect(snapshot(db)).toBe(before);
  });

  it("refuses a description outside the tenant and an entity merged away", async () => {
    const { report } = await run(database(), [
      link(AA.code, "witness", { description_code: "co-other-d009" }),
      link(MERGED.code, "witness"),
    ]);
    const r = reasons(report);
    expect(r).toMatch(/line 2: no description has the code co-other-d009 in neogranadina/);
    expect(r).toMatch(/line 3: ne-mmmmmm is merged into e-a/);
  });

  it("refuses a link D1 holds with other values that this file did not write, and two rows that make one link", async () => {
    const db = database();
    db.exec(`INSERT INTO description_entities (id, description_id, entity_id, role, created_at) VALUES ('l-x', 'd1', '${AA.id}', 'witness', 1)`);
    const held = await run(db, [link(AA.code, "witness", { sequence: "2", name_as_recorded: "Juana" })]);
    expect(reasons(held.report)).toMatch(
      /co-test-001-d001 is already linked to ne-aaaaaa as witness \(link l-x\), not by this file, with other values in sequence, name_as_recorded/,
    );
    const twice = await run(database(), [link(AA.code, "witness"), link(AA.code, "witness", { sequence: "2" })]);
    expect(reasons(twice.report)).toMatch(/line 3: line 2 makes the same link/);
  });
});

describe("a link D1 already holds, not written by this file", () => {
  const holdLink = (db: DatabaseSync) => db.exec(
    `INSERT INTO description_entities (id, description_id, entity_id, role, role_note, sequence, honorific, name_as_recorded, attributes, created_at)
     VALUES ('l-x', 'd1', '${AA.id}', 'witness', 'al margen', 2, 'doña', 'Juana', '{"office":"vecina"}', 1)`,
  );
  const holdPlaceLink = (db: DatabaseSync) => db.exec(
    `INSERT INTO description_places (id, description_id, place_id, role, role_note, created_at) VALUES ('pl-x', 'd1', '${PLACE.id}', 'venue', 'en la ciudad', 1)`,
  );
  const held = (over: Cells = {}) => link(AA.code, "witness", {
    role_note: "al margen", sequence: "2", honorific: "doña", name_as_recorded: "Juana", attr_office: "vecina", ...over,
  });

  it("is same when it holds the row's values: nothing is written, and the file is not refused as changed", async () => {
    const db = database();
    holdLink(db);
    holdPlaceLink(db);
    const before = snapshot(db);
    const alone = await run(db, [held(), placeLink(PLACE.code, "venue", { role_note: "en la ciudad" })], { apply: true });
    expect(reasons(alone.report)).toBe("");
    expect(alone.report.rows.map((r) => r.status)).toEqual(["same", "same"]);
    expect(alone.report.totals).toMatchObject({ same: 2, link: 0, placeLink: 0 });
    expect(alone.report.outcome).toBe("nothing to write");
    expect(alone.applied).toEqual([]);
    expect(snapshot(db)).toBe(before);

    // Beside a row that writes: the write goes ahead, and a rerun finds one row same and one done.
    const mixed = await run(db, [held(), link(BB.code, "witness")], { apply: true, file: "mixed.csv" });
    expect(reasons(mixed.report)).toBe("");
    expect(mixed.report.rows.map((r) => r.status)).toEqual(["same", "link"]);
    expect(mixed.report.outcome).toBe("verified");
    expect(all(db, "SELECT count(*) AS n FROM changelog")[0].n).toBe(1);
    const again = await run(db, [held(), link(BB.code, "witness")], { apply: true, file: "mixed.csv", now: NOW + 1000 });
    expect(reasons(again.report)).toBe("");
    expect(again.report.rows.map((r) => r.status)).toEqual(["same", "already linked"]);
    expect(again.report.outcome).toBe("nothing to write");
  });

  it("guards the link it found as read: a change between plan and apply aborts the file", async () => {
    const db = database();
    holdLink(db);
    let before = "";
    await expect(run(db, [held(), link(BB.code, "witness")], {
      apply: true,
      beforeApply: (d) => {
        d.exec("UPDATE description_entities SET sequence = 3 WHERE id = 'l-x'");
        before = snapshot(d);
      },
    })).rejects.toThrow(/ABORT|malformed JSON/);
    expect(snapshot(db)).toBe(before);
  });

  it("is refused when it holds other values: a link field, an attribute, or a place link's note", async () => {
    const db = database();
    holdLink(db);
    holdPlaceLink(db);
    const { report } = await run(db, [held({ honorific: "" }), placeLink(PLACE.code, "venue", { role_note: "extramuros" })]);
    const r = reasons(report);
    expect(r).toMatch(/line 2: co-test-001-d001 is already linked to ne-aaaaaa as witness \(link l-x\), not by this file, with other values in honorific/);
    expect(r).toMatch(/line 3: co-test-001-d001 is already linked to nl-pppppp as venue \(link pl-x\), not by this file, with other values in role_note/);
    const attr = await run(db, [held({ attr_office: "regidora" })]);
    expect(reasons(attr.report)).toMatch(/with other values in attributes/);
    // A document link's role_raw is a column of the row, and compared.
    const raw = await run(db, [held({ role_raw: "testigo" })]);
    expect(reasons(raw.report)).toMatch(/with other values in role_raw/);
  });

  it("compares a place link's note alone: the row has no role_raw, and one the import stored does not refuse it", async () => {
    const db = database();
    db.exec(`INSERT INTO description_places (id, description_id, place_id, role, role_note, role_raw, created_at) VALUES ('pl-x', 'd1', '${PLACE.id}', 'venue', NULL, 'lugar', 1)`);
    const { report } = await run(db, [placeLink(PLACE.code, "venue")]);
    expect(reasons(report)).toBe("");
    expect(report.rows.map((r) => r.status)).toEqual(["same"]);
  });

  it("is same only when the stored sequence is the integer the row writes; a stored '' or NULL is a blank text", async () => {
    // '0' and 0.0 are stored as the integer 0 (INTEGER affinity); these stay text.
    for (const sequence of ["''", "' '", "'0x0'"]) {
      const db = database();
      db.exec(`INSERT INTO description_entities (id, description_id, entity_id, role, sequence, created_at) VALUES ('l-x', 'd1', '${AA.id}', 'witness', ${sequence}, 1)`);
      const { report } = await run(db, [link(AA.code, "witness")]);
      expect(reasons(report)).toMatch(/\(link l-x\), not by this file, with other values in sequence/);
    }
    // A stored '' in a text column is no value, as NULL is: same against a blank row.
    const blanks = database();
    blanks.exec(`INSERT INTO description_entities (id, description_id, entity_id, role, role_note, role_raw, honorific, name_as_recorded, created_at) VALUES ('l-x', 'd1', '${AA.id}', 'witness', '', '', '', '', 1)`);
    blanks.exec(`INSERT INTO description_places (id, description_id, place_id, role, role_note, created_at) VALUES ('pl-x', 'd1', '${PLACE.id}', 'venue', '', 1)`);
    const same = await run(blanks, [link(AA.code, "witness"), placeLink(PLACE.code, "venue")]);
    expect(reasons(same.report)).toBe("");
    expect(same.report.rows.map((x) => x.status)).toEqual(["same", "same"]);
    // A stored value that is not '' must match exactly: a space is not a blank.
    const spaced = database();
    spaced.exec(`INSERT INTO description_entities (id, description_id, entity_id, role, honorific, created_at) VALUES ('l-x', 'd1', '${AA.id}', 'witness', ' ', 1)`);
    const r = reasons((await run(spaced, [link(AA.code, "witness")])).report);
    expect(r).toMatch(/\(link l-x\), not by this file, with other values in honorific/);
    // Only TEXT '' and NULL are blank: an empty BLOB is another type, and differs.
    const blob = database();
    blob.exec(`INSERT INTO description_entities (id, description_id, entity_id, role, role_note, created_at) VALUES ('l-x', 'd1', '${AA.id}', 'witness', x'', 1)`);
    blob.exec(`INSERT INTO description_places (id, description_id, place_id, role, role_note, created_at) VALUES ('pl-x', 'd1', '${PLACE.id}', 'venue', x'', 1)`);
    const b = reasons((await run(blob, [link(AA.code, "witness"), placeLink(PLACE.code, "venue")])).report);
    expect(b).toMatch(/line 2: .*\(link l-x\), not by this file, with other values in role_note/);
    expect(b).toMatch(/line 3: .*\(link pl-x\), not by this file, with other values in role_note/);
    // The exact integer, and NULL for NULL: same.
    const exact = database();
    exact.exec(`INSERT INTO description_entities (id, description_id, entity_id, role, sequence, created_at) VALUES ('l-x', 'd1', '${AA.id}', 'witness', 0, 1)`);
    expect((await run(exact, [link(AA.code, "witness")])).report.rows.map((x) => x.status)).toEqual(["same"]);
  });

  it("refuses the file when another row of it moves or drops the entity link a row finds held", async () => {
    const header = [...HEADER, "authority_code", "authority_name", "target_codes"];
    const from = { authority_code: AA.code, authority_name: AA.name, description_code: "co-test-001-d001", role: "witness" };
    for (const other of [{ op: "move-link", ...from, target_codes: BB.code }, { op: "drop-link", ...from }]) {
      const db = database();
      holdLink(db);
      const before = snapshot(db);
      const { report, applied } = await run(db, [held(), other], { header, apply: true });
      expect(report.outcome).toBe("refused");
      expect(reasons(report)).toMatch(/line 3: link l-x is written by line 2, which finds it held/);
      expect(applied).toEqual([]);
      expect(snapshot(db)).toBe(before);
    }
  });

  it("closes the file with a guard that every link written is in a description of the acting tenant", async () => {
    const { report, applied } = await run(database(), [link(AA.code, "witness"), placeLink(PLACE.code, "venue")], { apply: true });
    expect(report.outcome).toBe("verified");
    const sql = applied[0].join("\n");
    expect(sql).toMatch(/FROM description_entities l JOIN descriptions d ON d\.id = l\.description_id WHERE l\.id IN \('[^']+'\) AND d\.tenant_id = 't-1'/);
    expect(sql).toMatch(/FROM description_places l JOIN descriptions d ON d\.id = l\.description_id WHERE l\.id IN \('[^']+'\) AND d\.tenant_id = 't-1'/);
  });
});

describe("sequence", () => {
  it("refuses a sequence beyond the safe integers at plan, on a link and on a relation side", async () => {
    const big = "1000000000000000000000";
    const { report, applied } = await run(database(), [
      link(AA.code, "witness", { sequence: big }),
      relation(AA.code, "parent", BB.code, "child", { a_sequence: String(Number.MAX_SAFE_INTEGER + 1) }),
    ], { apply: true });
    const r = reasons(report);
    expect(r).toMatch(/line 2: sequence "1000000000000000000000" is not a whole number from 0 to 9007199254740991/);
    expect(r).toMatch(/line 3: a_sequence "9007199254740992" is not a whole number from 0 to 9007199254740991/);
    expect(applied).toEqual([]);
    const top = await run(database(), [link(AA.code, "witness", { sequence: String(Number.MAX_SAFE_INTEGER) })], { apply: true });
    expect(top.report.outcome).toBe("verified");
  });
});

describe("authority_name on a link, as a check", () => {
  const header = [...HEADER, "authority_name"];

  it("links when it is the record's name (NFC and spaces aside) or blank, and refuses another name", async () => {
    const db = database();
    const { report } = await run(db, [
      link(AA.code, "witness", { authority_name: " Juana Díaz " }),
      link(BB.code, "witness"),
      placeLink(PLACE.code, "venue", { authority_name: "Tunja" }),
    ], { header, apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    expect(report.rows.map((r) => r.status)).toEqual(["link", "link", "place-link"]);

    const wrong = await run(database(), [
      link(AA.code, "witness", { authority_name: "Diego Díaz" }),
      placeLink(PLACE.code, "venue", { authority_name: "Santiago de Tunja" }),
    ], { header });
    const r = reasons(wrong.report);
    expect(r).toMatch(/line 2: authority_name "Diego Díaz" is not the stored name "Juana Díaz"/);
    expect(r).toMatch(/line 3: authority_name "Santiago de Tunja" is not the stored label "Tunja"/);
  });

  it("refuses a name on a row that names a new:<key>", async () => {
    const { report } = await run(database(), [
      create("k", "Pedro"),
      link("new:k", "witness", { authority_name: "Pedro" }),
    ], { header });
    expect(reasons(report)).toMatch(/line 3: authority_name must be blank when the row names new:k/);
  });

  it("is still refused on the other additions, and authority_code is refused on a link", async () => {
    const { report } = await run(database(), [
      create("k", "Pedro", { authority_name: "Pedro" }),
      link(AA.code, "witness", { authority_code: AA.code }),
    ], { header: [...header, "authority_code"] });
    const r = reasons(report);
    expect(r).toMatch(/line 2: create-entity carries no authority_name/);
    expect(r).toMatch(/line 3: add-link carries no authority_code/);
  });
});

describe("add-place-link", () => {
  it("refuses a place not found, a new place no create-place row defines, and a place role outside the list", async () => {
    const { report } = await run(database(), [placeLink("nl-zzzzzz", "venue"), placeLink("new:k", "venue"), placeLink(PLACE.code, "sky")]);
    const r = reasons(report);
    expect(r).toMatch(/line 2: no place has the code nl-zzzzzz/);
    expect(r).toMatch(/line 3: new:k is not defined by any create-place row of the file/);
    expect(r).toMatch(/line 4: role "sky" is not a place role/);
  });
});

describe("link roles from the federation's list", () => {
  /** The database, with codes the constants lack: approved, proposed, deprecated, and another federation's. */
  function withRoles(): DatabaseSync {
    const db = database();
    const v = db.prepare("INSERT INTO vocabulary_values (id, federation_id, list, code, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)");
    v.run("r-1", FED, "entity_role", "deponent", "approved");
    v.run("r-2", FED, "place_role", "seat", "approved");
    v.run("r-3", FED, "entity_role", "guessed", "proposed");
    v.run("r-4", FED, "entity_role", "retired", "deprecated");
    v.run("r-5", FED, "place_role", "old_seat", "deprecated");
    v.run("r-6", "fed-other", "entity_role", "elsewhere", "approved");
    v.run("r-7", "fed-other", "place_role", "far", "approved");
    return db;
  }

  it("writes a document or place link with a code the federation approves and the constants lack", async () => {
    const db = withRoles();
    const { report } = await run(db, [link(AA.code, "deponent"), placeLink(PLACE.code, "seat")], { apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    expect(db.prepare("SELECT role FROM description_entities").all().map((r: any) => r.role)).toEqual(["deponent"]);
    expect(db.prepare("SELECT role FROM description_places").all().map((r: any) => r.role)).toEqual(["seat"]);
  });

  it("refuses a missing, proposed, deprecated or other federation's code", async () => {
    const { report } = await run(withRoles(), [
      link(AA.code, "astronaut"),
      link(AA.code, "guessed"),
      link(AA.code, "retired"),
      link(AA.code, "elsewhere"),
      placeLink(PLACE.code, "old_seat"),
      placeLink(PLACE.code, "far"),
    ]);
    const r = reasons(report);
    for (const [line, code] of [[2, "astronaut"], [3, "guessed"], [4, "retired"], [5, "elsewhere"]] as const) {
      expect(r).toMatch(new RegExp(`line ${line}: role "${code}" is not a document role`));
    }
    expect(r).toMatch(/line 6: role "old_seat" is not a place role/);
    expect(r).toMatch(/line 7: role "far" is not a place role/);
  });

  it("aborts the file, writing nothing, when a code is deprecated between plan and apply", async () => {
    const db = withRoles();
    await expect(run(db, [link(AA.code, "deponent")], {
      apply: true,
      beforeApply: (d) => d.exec("UPDATE vocabulary_values SET status = 'deprecated' WHERE code = 'deponent'"),
    })).rejects.toThrow(/ABORT|malformed JSON/);
    expect(all(db, "SELECT * FROM description_entities")).toHaveLength(0);
  });
});

describe("add-relation", () => {
  it("derives a blank side when one code fits, and refuses it when several do", async () => {
    const db = database();
    const { report } = await run(db, [relation(AA.code, "curador", BB.code, ""), relation(CC.code, "ward", BB.code, ""), relation(AA.code, "spouse", CC.code, "")]);
    const r = reasons(report);
    expect(r).not.toMatch(/line 2/);
    expect(r).toMatch(/line 3: b_role is blank and ward pairs with curador, tutor; the file must name one/);
    expect(r).toMatch(/line 4: b_role is blank and spouse pairs with spouse, surviving_spouse; the file must name one/);
    const ok = await run(db, [relation(AA.code, "curador", BB.code, "", { b_certainty: "" }), relation(AA.code, "surviving_spouse", BB.code, "")], { apply: true });
    expect(ok.report.outcome).toBe("verified");
    const ward = all(db, `SELECT * FROM description_entities WHERE entity_id = '${BB.id}' AND role = 'ward'`);
    expect(ward).toHaveLength(1);
    expect(ward[0].relation_certainty).toBe("derived");
    expect(all(db, `SELECT relation_certainty FROM description_entities WHERE entity_id = '${BB.id}' AND role = 'spouse'`)).toEqual([{ relation_certainty: "derived" }]);
  });

  it("derives only towards approved codes: an inverse not approved, or missing, gives no candidate", async () => {
    const db = database();
    db.exec("UPDATE vocabulary_values SET status = 'deprecated' WHERE list = 'relation_role' AND code = 'ward'");
    db.exec(`INSERT INTO vocabulary_values (id, federation_id, list, code, created_at, updated_at, inverse_code) VALUES ('v-m', '${FED}', 'relation_role', 'mentor', 1, 1, 'pupil')`);
    const { report } = await run(db, [relation(AA.code, "curador", BB.code, ""), relation(AA.code, "mentor", BB.code, ""), relation(AA.code, "tutor", BB.code, "ward")]);
    const r = reasons(report);
    expect(r).toMatch(/line 2: b_role is blank and curador pairs with no code; the file must name one/);
    expect(r).toMatch(/line 3: b_role is blank and mentor pairs with no code; the file must name one/);
    expect(r).toMatch(/line 4: b_role "ward" is not in the federation's relation_role list/);
  });

  it("refuses a filled pair that cannot be paired, a blank a_role, one person on both sides, and an unknown certainty", async () => {
    const { report } = await run(database(), [
      relation(AA.code, "parent", BB.code, "spouse"),
      relation(AA.code, "", BB.code, "parent"),
      relation(AA.code, "sibling", AA.code, "sibling"),
      relation(AA.code, "sibling", BB.code, "sibling", { a_certainty: "probable" }),
      relation(AA.code, "witness", BB.code, "witness"),
    ]);
    const r = reasons(report);
    expect(r).toMatch(/line 2: parent pairs with child, not spouse, so the two sides could not be paired/);
    expect(r).toMatch(/line 3: add-relation names no a_role/);
    expect(r).toMatch(/line 4: a_entity and b_entity are both ne-aaaaaa/);
    expect(r).toMatch(/line 5: a_certainty "probable" is not blank, doubtful, inferred or derived/);
    expect(r).toMatch(/line 6: a_role "witness" is not in the federation's relation_role list/);
  });

  it("lets a person hold a document role and a relation side of the same role in one description", async () => {
    const db = database();
    db.exec(`INSERT INTO description_entities (id, description_id, entity_id, role, created_at) VALUES ('l-s', 'd1', '${CC.id}', 'spouse', 1)`);
    const { report } = await run(db, [relation(CC.code, "spouse", BB.code, "spouse")], { apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    expect(all(db, `SELECT count(*) AS n FROM description_entities WHERE entity_id = '${CC.id}' AND role = 'spouse'`)).toEqual([{ n: 2 }]);
  });

  it("refuses a relation D1 already holds, and two rows that make one relation", async () => {
    const db = database();
    expect((await run(db, [relation(AA.code, "parent", BB.code, "child")], { apply: true })).report.outcome).toBe("verified");
    const held = await run(db, [relation(BB.code, "child", AA.code, "parent")], { file: "other.csv" });
    expect(reasons(held.report)).toMatch(/already holds this relation between ne-bbbbbb \(child\) and ne-aaaaaa \(parent\), not written by this file/);
    const twice = await run(database(), [relation(AA.code, "parent", BB.code, "child"), relation(BB.code, "child", AA.code, "parent")]);
    expect(reasons(twice.report)).toMatch(/line 3: line 2 makes the same relation/);
  });
});

describe("attributes", () => {
  it("refuses an unknown attribute column in a file of the existing operations alone", async () => {
    const header = ["op", "authority_code", "authority_name", "current_dates", "current_function", "gender", "attr_colour"];
    const { report } = await run(database(), [{ op: "update-entity", authority_code: CC.code, authority_name: CC.name, gender: "female" }], { header });
    expect(reasons(report)).toMatch(/attr_colour: colour is not a key of the federation's link_attribute list/);
  });

  it("refuses the file whole for a key the federation does not list", async () => {
    const { report } = await run(database(), [link(AA.code, "witness")], { header: [...HEADER, "attr_colour"] });
    expect(reasons(report)).toMatch(/attr_colour: colour is not a key of the federation's link_attribute list/);
  });

  it("writes {} when the row gives none, and refuses attribute columns on another operation", async () => {
    const db = database();
    const { report } = await run(db, [link(AA.code, "witness"), create("k", "Pedro", { attr_office: "regidor" })]);
    expect(reasons(report)).toMatch(/create-entity carries no attr_office/);
    expect((await run(db, [link(AA.code, "witness")], { apply: true })).report.outcome).toBe("verified");
    expect(all(db, "SELECT attributes FROM description_entities")).toEqual([{ attributes: "{}" }]);
  });
});

describe("a file that mixes additions with the existing operations", () => {
  const header = [...HEADER, "authority_code", "authority_name", "target_codes", "label_to_keep", "current_dates", "current_function"];

  it("applies both, and refuses an addition naming a record a merge row of the file names", async () => {
    const db = database();
    const merge = { op: "merge-entity", authority_code: CC.code, authority_name: CC.name, target_codes: BB.code, label_to_keep: BB.name };
    const refused = await run(db, [merge, link(CC.code, "witness")], { header });
    expect(reasons(refused.report)).toMatch(/line 3: ne-cccccc is merged by line 2, so no other row may name it/);
    const gender = { op: "update-entity", authority_code: CC.code, authority_name: CC.name, gender: "female" };
    const { report } = await run(db, [gender, link(CC.code, "witness"), create("k", "Pedro")], { header, apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    expect(report.totals).toMatchObject({ update: 1, link: 1, create: 1 });
  });
});

// ---------------------------------------------------------------------------
// update-entity: gender
// ---------------------------------------------------------------------------

describe("update-entity gender", () => {
  const header = ["op", "authority_code", "authority_name", "current_dates", "current_function", "gender", "changelog_note"];
  const update = (e: { code: string; name: string }, gender: string) => ({ op: "update-entity", authority_code: e.code, authority_name: e.name, gender });

  it("sets a code, clears with NULL, leaves the stored value when blank, and refuses a code outside the list", async () => {
    const db = database();
    // A row that gives no field writes nothing, so it has a file of its own: beside rows that write it would
    // read as done in a file that changed (the rerun contract).
    expect((await run(db, [update(BB, "")], { header, apply: true })).report.outcome).toBe("nothing to write");
    const { report } = await run(db, [update(CC, "female"), update(AA, "NULL")], { header, apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    expect(all(db, "SELECT entity_code, gender FROM entities WHERE id IN ('e-a', 'e-b', 'e-c') ORDER BY id")).toEqual([
      { entity_code: AA.code, gender: null }, { entity_code: BB.code, gender: "male" }, { entity_code: CC.code, gender: "female" },
    ]);
    const journal = all(db, "SELECT record_id, diff FROM changelog WHERE kind = 'update' ORDER BY record_id");
    expect(journal.map((j) => [j.record_id, JSON.parse(j.diff)])).toEqual([
      [AA.id, { gender: { old: "female", new: null } }], [CC.id, { gender: { old: null, new: "female" } }],
    ]);
    const again = await run(db, [update(CC, "female"), update(AA, "NULL")], { header, apply: true });
    expect(again.report.outcome).toBe("nothing to write");
    const bad = await run(database(), [update(CC, "other")], { header });
    expect(reasons(bad.report)).toMatch(/gender "other" is not in the federation's gender list/);
  });

  it("clears a stored empty gender with NULL, and leaves SQL NULL", async () => {
    const db = database();
    db.exec(`UPDATE entities SET gender = '' WHERE id = '${CC.id}'`);
    const { report } = await run(db, [update(CC, "NULL")], { header, apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    expect(all(db, `SELECT typeof(gender) AS t FROM entities WHERE id = '${CC.id}'`)).toEqual([{ t: "null" }]);
  });

  it("refuses a row that leaves a gender on a record it makes other than a person", async () => {
    const db = database();
    const h = [...header, "entity_type"];
    const kept = await run(db, [{ ...update(BB, ""), entity_type: "corporate" }], { header: h });
    expect(reasons(kept.report)).toMatch(/ne-bbbbbb would be corporate and keep the gender "male"; only a person has a gender/);
    const given = await run(db, [{ ...update(CC, "female"), entity_type: "corporate" }], { header: h });
    expect(reasons(given.report)).toMatch(/ne-cccccc would be corporate and have the gender "female"; only a person has a gender/);
    const cleared = await run(db, [{ ...update(BB, "NULL"), entity_type: "corporate" }], { header: h, apply: true });
    expect(reasons(cleared.report)).toBe("");
    expect(cleared.report.outcome).toBe("verified");
    expect(all(db, `SELECT entity_type, gender FROM entities WHERE id = '${BB.id}'`)).toEqual([{ entity_type: "corporate", gender: null }]);
  });

  it("refuses a gender on a record that is not a person, made or updated", async () => {
    const db = database();
    db.exec(`INSERT INTO entities (id, federation_id, entity_code, display_name, sort_name, entity_type, created_at, updated_at) VALUES ('e-corp', '${FED}', 'ne-kkkkkk', 'Cabildo', 'Cabildo', 'corporate', 1, 5)`);
    const updated = await run(db, [update({ code: "ne-kkkkkk", name: "Cabildo" }, "female")], { header });
    expect(reasons(updated.report)).toMatch(/ne-kkkkkk is corporate, and only a person has a gender/);
    const made = await run(db, [create("k", "Cabildo de Tunja", { entity_type: "corporate", gender: "male" })]);
    expect(reasons(made.report)).toMatch(/line 2: a corporate record has no gender; only a person has one/);
  });

  // Two statements a row, a changelog row and the record's update: 65,000 rows
  // make about 130,000 statements, more than a spread into one call can pass.
  it("plans a file of 65,000 rows", async () => {
    const db = database();
    const e = db.prepare(
      "INSERT INTO entities (id, federation_id, entity_code, display_name, sort_name, entity_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'person', 1, 5)",
    );
    const rows: Cells[] = [];
    db.exec("BEGIN");
    for (let i = 0; i < 65_000; i++) {
      const code = `ne-x${String(i).padStart(5, "0")}`;
      e.run(`e-x${i}`, FED, code, `Persona ${i}`, `Persona ${i}`);
      rows.push(update({ code, name: `Persona ${i}` }, i % 2 ? "male" : "female"));
    }
    db.exec("COMMIT");
    const { report } = await run(db, rows, { header });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("dry run");
    expect(report.totals.update).toBe(65_000);
    expect(report.totals.statements).toBeGreaterThan(130_000);
    expect(report.totals.largestStatement).toBeGreaterThan(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// What was read, as read
// ---------------------------------------------------------------------------

describe("what was read, as read", () => {
  async function aborts(change: (db: DatabaseSync, statements: string[]) => void, rows = fullRows()) {
    const db = database();
    let before = "";
    const changed = (d: DatabaseSync, statements: string[]) => {
      change(d, statements);
      before = snapshot(d);
    };
    await expect(run(db, rows, { apply: true, beforeApply: changed })).rejects.toThrow(/ABORT|malformed JSON/);
    // Nothing the file writes is there: only the other session's change.
    expect(before).not.toBe("");
    expect(snapshot(db)).toBe(before);
  }
  it("aborts the file when a vocabulary value changes", async () => {
    await aborts((d) => d.exec("UPDATE vocabulary_values SET inverse_code = 'parent' WHERE code = 'curador'"));
  });
  it("aborts the file when a vocabulary value is added to a list read", async () => {
    await aborts((d) => d.exec(`INSERT INTO vocabulary_values (id, federation_id, list, code, created_at, updated_at, inverse_code) VALUES ('v-new', '${FED}', 'relation_role', 'mentor', 1, 1, 'ward')`));
  });
  it("aborts the file when a description's code changes", async () => {
    await aborts((d) => d.exec("UPDATE descriptions SET reference_code = 'co-test-001-d001-bis' WHERE id = 'd1'"));
  });
  it("aborts the file when a description gains a link", async () => {
    await aborts((d) => d.exec(`INSERT INTO description_entities (id, description_id, entity_id, role, created_at) VALUES ('l-new', 'd1', '${CC.id}', 'mentioned', 1)`));
  });
  it("aborts the file when a place changes", async () => {
    await aborts((d) => d.exec(`UPDATE places SET merged_into = 'p-2' WHERE id = '${PLACE.id}'`));
  });
  it("aborts the file when the code minted for a record is taken", async () => {
    await aborts((d, statements) => {
      // The code the plan minted, taken by a record another session makes.
      const code = /insert into "entities".*?'(ne-[a-z2-9]{6})'/i.exec(statements.join("\n"))![1];
      d.exec(`INSERT INTO entities (id, federation_id, entity_code, display_name, sort_name, entity_type, created_at, updated_at)
        VALUES ('e-taken', 'fed-2', '${code}', 'x', 'x', 'person', 1, 1)`);
    }, [create("k", "Pedro")]);
  });
});

// @version v0.9.0
