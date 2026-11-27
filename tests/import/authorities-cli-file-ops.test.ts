/**
 * Tests — record deletes, link updates, relation drops and minted codes in the command line's authority changes
 *
 * This suite pins four capabilities of `scripts/lib/authorities-cli/`:
 * `delete-entity` and `delete-place`, `update-link`, `drop-relation`, and
 * the code each create-entity and create-place row mints, as the report
 * gives it. The run is driven end to end against an in-memory
 * `node:sqlite` database with the tables and columns the engine reads
 * and writes, foreign keys on and D1's expression depth limit of 100;
 * the file it writes is applied as one unit, as `wrangler d1 execute
 * --file` applies it. Nothing here reaches D1.
 *
 *   - each operation plans, applies, reads back ("Verified"), and a
 *     second run writes nothing and reports every row done;
 *   - a delete writes the ledger row the record page's delete writes,
 *     with the record's full row as its snapshot, and no changelog row;
 *     it is refused for a record with a description link (of any
 *     tenant, a relation side among them), a function row, a child
 *     place, a merge naming it as survivor, a name that differs, and for
 *     a record another row of the file names, and for a shared record
 *     when the actor is not a steward; a link added between plan
 *     and apply aborts the file with nothing written; a deleted record's
 *     primary function term is recounted;
 *   - an update names the stored value of each field it changes and is
 *     refused when D1 holds another, when a new role collides, and when
 *     it would change a relation side's role; a field change on a
 *     relation side is accepted; a link already holding the values is
 *     "same";
 *   - a relation drop removes both sides with an `unlink` changelog row
 *     each, and is refused for a relation the description does not hold
 *     and for one a third link names (on another description, the
 *     file's guard aborts it); `drop-link` still refuses a side;
 *   - a dry run reports "minted on apply" for each record still to make,
 *     the apply report gives the code written, and a rerun the code held.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AuthoritiesReport } from "../../scripts/lib/authorities-cli/run";
import { MINTED_ON_APPLY } from "../../scripts/lib/authorities-cli/run";
import { DELETE_LEDGER_NAMESPACE } from "../../scripts/lib/authorities-cli/deletes";
import { newRecordId } from "../../scripts/lib/authority-links";
import { D1_LIMITS, PLACES_DDL, runFile, type RunOptions } from "./authorities-cli-places-helpers";

const FED = "fed-1";
const TENANT = "t-1";
const FILE = "file-ops-test.csv";
const NOW = 1_763_500_000_000;

const VOCABULARY: Array<[string, string, string | null]> = [
  ["entity_type", "person", null],
  ["entity_role", "witness", null], ["entity_role", "mentioned", null], ["entity_role", "plaintiff", null],
  ["place_role", "venue", null], ["place_role", "mentioned", null],
  ["place_type", "city", null], ["place_type", "town", null],
  ["relation_role", "parent", "child"], ["relation_role", "child", "parent"],
];

const AA = { id: "e-a", code: "ne-aaaaaa", name: "Juana Díaz" };
const BB = { id: "e-b", code: "ne-bbbbbb", name: "Diego Díaz" };
const CC = { id: "e-c", code: "ne-cccccc", name: "Ana Ruiz" };
const DD = { id: "e-d", code: "ne-dddddd", name: "Pedro Ruiz" };
const TUNJA = { id: "p-t", code: "nl-tttttt", label: "Tunja" };
const LEIVA = { id: "p-l", code: "nl-llllll", label: "Villa de Leiva" };
const SOGA = { id: "p-s", code: "nl-ssssss", label: "Sogamoso" };

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:", D1_LIMITS);
  db.exec(PLACES_DDL);
  db.exec(`INSERT INTO federations VALUES ('${FED}', 'neogranadina-fed', 'active', '${TENANT}', 1, 'ne', 'nl');`);
  db.exec(`INSERT INTO tenants VALUES ('${TENANT}', 'neogranadina', '${FED}', NULL, 1, 'ne', 'nl'), ('t-2', 'other', '${FED}', NULL, 1, 'ot', 'op');`);
  db.exec(`INSERT INTO users (id, email, name, tenant_id, is_admin) VALUES ('user_001', 'admin@example.org', 'Admin', '${TENANT}', 1);`);
  db.exec(`INSERT INTO descriptions VALUES ('d1', '${TENANT}', 'co-test-001-d001'), ('d2', '${TENANT}', 'co-test-001-d002'), ('d9', 't-2', 'co-other-d009');`);
  const v = db.prepare("INSERT INTO vocabulary_values (id, federation_id, list, code, created_at, updated_at, inverse_code) VALUES (?, ?, ?, ?, 1, 1, ?)");
  VOCABULARY.forEach(([list, code, inverse], i) => v.run(`v-${i}`, FED, list, code, inverse));
  const e = db.prepare(
    "INSERT INTO entities (id, federation_id, tenant_id, entity_code, display_name, sort_name, entity_type, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, 'person', 1, 5)",
  );
  for (const x of [AA, BB, CC, DD]) e.run(x.id, FED, x.code, x.name, x.name);
  const p = db.prepare(
    "INSERT INTO places (id, federation_id, tenant_id, place_code, label, display_name, place_type, latitude, longitude, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, 'city', ?, ?, 1, 7)",
  );
  p.run(TUNJA.id, FED, TUNJA.code, TUNJA.label, TUNJA.label, 5.53, -73.36);
  p.run(LEIVA.id, FED, LEIVA.code, LEIVA.label, LEIVA.label, null, null);
  p.run(SOGA.id, FED, SOGA.code, SOGA.label, SOGA.label, null, null);
  return db;
}

/** Inserts links in order; a link naming one not yet in is given its `related_to` once every link is in. */
function links(db: DatabaseSync, rows: Array<[string, string, string, string, string | null]>) {
  const ins = db.prepare("INSERT INTO description_entities (id, description_id, entity_id, role, sequence, created_at, related_to) VALUES (?, ?, ?, ?, 0, 3, ?)");
  const has = db.prepare("SELECT 1 AS found FROM description_entities WHERE id = ?");
  const later: Array<[string, string]> = [];
  for (const [id, d, entity, role, related] of rows) {
    const now = related !== null && has.get(related) !== undefined;
    ins.run(id, d, entity, role, now ? related : null);
    if (related !== null && !now) later.push([id, related]);
  }
  const rel = db.prepare("UPDATE description_entities SET related_to = ? WHERE id = ?");
  for (const [id, related] of later) rel.run(related, id);
}

type Cells = Record<string, string>;

const LINK_FIELDS = ["role_note", "role_raw", "honorific", "name_as_recorded", "sequence"];
const HEADER = [
  "op", "authority_code", "authority_name", "description_code", "role", "new_role", ...LINK_FIELDS, ...LINK_FIELDS.map((f) => `current_${f}`),
  "a_entity", "a_role", "b_entity", "b_role", "target_codes", "label_to_keep", "name_variants_add", "new_key", "display_name", "sort_name",
  "entity_type", "label", "entity", "changelog_note",
];

const run = (db: DatabaseSync, rows: Cells[], opts: RunOptions = {}) => runFile(db, rows, { header: HEADER, file: FILE, now: NOW, ...opts });
const all = (db: DatabaseSync, sql: string) => db.prepare(sql).all() as Array<Record<string, any>>;
const one = (db: DatabaseSync, sql: string) => all(db, sql)[0];
const reasons = (r: AuthoritiesReport) => r.refusals.map((f) => `${f.ref}: ${f.reason}`).join("\n");
const snapshot = (db: DatabaseSync) =>
  JSON.stringify(["places", "entities", "description_entities", "description_places", "entity_functions", "changelog", "authority_operations"]
    .map((t) => all(db, `SELECT * FROM ${t} ORDER BY rowid`)));

/** Applies the file, then runs it again: the second run writes nothing and reports every row done. */
async function appliesAndReruns(db: DatabaseSync, rows: Cells[], expectDone: string[]) {
  const { report } = await run(db, rows, { apply: true });
  expect(reasons(report)).toBe("");
  expect(report.problems).toEqual([]);
  expect(report.outcome).toBe("verified");
  const after = snapshot(db);
  const again = await run(db, rows, { apply: true });
  expect(reasons(again.report)).toBe("");
  expect(again.report.outcome).toBe("nothing to write");
  expect(again.applied).toEqual([]);
  expect(again.report.rows.map((r) => r.status)).toEqual(expectDone);
  expect(snapshot(db)).toBe(after);
  return report;
}

/** A refused file: the reasons given, and nothing written by a run with apply. */
async function refused(db: DatabaseSync, rows: Cells[]): Promise<string> {
  const before = snapshot(db);
  const { report, applied } = await run(db, rows, { apply: true });
  expect(report.outcome).toBe("refused");
  expect(applied).toEqual([]);
  expect(snapshot(db)).toBe(before);
  return reasons(report);
}

const deleteEntity = (e: { code: string; name: string }, over: Cells = {}): Cells => ({ op: "delete-entity", authority_code: e.code, authority_name: e.name, ...over });
const deletePlace = (p: { code: string; label: string }, over: Cells = {}): Cells => ({ op: "delete-place", authority_code: p.code, authority_name: p.label, ...over });
const updateLink = (e: { code: string; name: string }, description: string, role: string, over: Cells = {}): Cells => ({
  op: "update-link", authority_code: e.code, authority_name: e.name, description_code: description, role, changelog_note: "Corrected", ...over,
});
const dropRelation = (a: { code: string }, aRole: string, b: { code: string }, bRole: string, over: Cells = {}): Cells => ({
  op: "drop-relation", description_code: "co-test-001-d001", a_entity: a.code, a_role: aRole, b_entity: b.code, b_role: bRole, changelog_note: "Not a relation", ...over,
});

// ---------------------------------------------------------------------------
// delete-entity and delete-place
// ---------------------------------------------------------------------------

describe("delete-entity", () => {
  it("deletes the record, writes the page's ledger row with its snapshot, reads back, and a rerun writes nothing", async () => {
    const db = database();
    const dry = await run(db, [deleteEntity(DD)]);
    expect(reasons(dry.report)).toBe("");
    expect(dry.report.totals.deleteEntity).toBe(1);
    await appliesAndReruns(db, [deleteEntity(DD)], ["already deleted entity"]);
    expect(all(db, `SELECT id FROM entities WHERE id = '${DD.id}'`)).toEqual([]);
    const ledger = all(db, "SELECT * FROM authority_operations");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      id: await newRecordId(FED, TENANT, FILE, `delete-entity|${DD.code}`, DELETE_LEDGER_NAMESPACE),
      federation_id: FED, record_type: "entity", operation: "delete", source_id: DD.id, target_id: null, user_id: "user_001", created_at: NOW,
    });
    const { snapshot: snap } = JSON.parse(ledger[0].detail);
    expect(snap).toMatchObject({ id: DD.id, entityCode: DD.code, displayName: DD.name, federationId: FED, tenantId: null, knownOnlyFromRelation: false, updatedAt: 5 });
    expect(Object.keys(snap)).toHaveLength(32);
    expect(all(db, "SELECT * FROM changelog")).toEqual([]);
  });

  it("refuses a record with a description link, of this tenant or another, a document link or a relation side", async () => {
    const db = database();
    links(db, [["doc-1", "d1", AA.id, "witness", null], ["f-1", "d9", BB.id, "mentioned", null], ["r-c", "d2", CC.id, "child", "r-d"], ["r-d", "d2", DD.id, "parent", "r-c"]]);
    expect(await refused(db, [deleteEntity(AA), deleteEntity(BB), deleteEntity(CC)])).toBe([
      `${FILE} line 2: ne-aaaaaa holds 1 description link (document links and relation sides); drop or move it in an earlier file`,
      `${FILE} line 3: ne-bbbbbb holds 1 description link (document links and relation sides); drop or move it in an earlier file`,
      `${FILE} line 4: ne-cccccc holds 1 description link (document links and relation sides); drop or move it in an earlier file`,
    ].join("\n"));
  });

  it("refuses a record with function rows, a merge survivor, a name that differs and a code not found", async () => {
    const db = database();
    db.exec(`INSERT INTO entity_functions (id, entity_id, function, created_at, updated_at) VALUES ('f-1', '${AA.id}', 'alcalde', 1, 1), ('f-2', '${AA.id}', 'regidor', 1, 1);`);
    db.exec(`INSERT INTO entities (id, federation_id, entity_code, display_name, sort_name, entity_type, merged_into, created_at, updated_at) VALUES ('e-m', '${FED}', 'ne-mmmmmm', 'Merged', 'Merged', 'person', '${BB.id}', 1, 5);`);
    expect(await refused(db, [
      deleteEntity(AA), deleteEntity(BB), deleteEntity(CC, { authority_name: "Ana Ruíz" }), deleteEntity({ code: "ne-zzzzzz", name: "Nadie" }),
      deleteEntity({ code: "ne-mmmmmm", name: "Merged" }),
    ])).toBe([
      `${FILE} line 2: ne-aaaaaa holds 2 function rows, which the delete would remove with it; move or delete them in an earlier file`,
      `${FILE} line 3: ne-bbbbbb is the survivor of a merge: the records merged into it name it`,
      `${FILE} line 4: authority_name "Ana Ruíz" is not the stored name "Ana Ruiz"`,
      `${FILE} line 5: no entity has the code ne-zzzzzz in the federation`,
      `${FILE} line 6: ne-mmmmmm is merged into e-b`,
    ].join("\n"));
  });

  it("refuses a file that drops a record's link and deletes it, and a record deleted twice", async () => {
    const db = database();
    links(db, [["doc-1", "d1", AA.id, "witness", null]]);
    expect(await refused(db, [
      { op: "drop-link", authority_code: AA.code, authority_name: AA.name, description_code: "co-test-001-d001", role: "witness" },
      deleteEntity(AA), deleteEntity(DD), deleteEntity(DD),
    ])).toBe([
      `${FILE} line 3: ne-aaaaaa is named by line 2, so the file may not also delete it; apply that row in one file and delete the entity in a later one`,
      `${FILE} line 5: ne-dddddd is deleted by line 4 as well`,
    ].join("\n"));
  });

  it("aborts with nothing written when a link is added between plan and apply", async () => {
    const db = database();
    let before = "";
    await expect(run(db, [deleteEntity(DD)], {
      apply: true,
      beforeApply: (x) => {
        x.exec(`INSERT INTO description_entities (id, description_id, entity_id, role, sequence, created_at) VALUES ('late', 'd9', '${DD.id}', 'witness', 0, 9);`);
        before = snapshot(x);
      },
    })).rejects.toThrow(/ABORT|malformed JSON/);
    expect(before).not.toBe("");
    expect(snapshot(db)).toBe(before);
  });

  it("recounts the term of a deleted record's primary function", async () => {
    const db = database();
    db.exec(`INSERT INTO vocabulary_terms (id, federation_id, canonical, entity_count, updated_at) VALUES ('term-1', '${FED}', 'alcalde', 2, 1);`);
    db.exec(`UPDATE entities SET primary_function = 'alcalde', primary_function_id = 'term-1' WHERE id IN ('${CC.id}', '${DD.id}');`);
    await appliesAndReruns(db, [deleteEntity(DD)], ["already deleted entity"]);
    expect(one(db, "SELECT entity_count, updated_at FROM vocabulary_terms WHERE id = 'term-1'")).toEqual({ entity_count: 1, updated_at: NOW });
  });

  it("refuses a rerun when the deleted record's code is in use again", async () => {
    const db = database();
    await run(db, [deleteEntity(DD)], { apply: true });
    db.exec(`INSERT INTO entities (id, federation_id, entity_code, display_name, sort_name, entity_type, created_at, updated_at) VALUES ('e-d2', '${FED}', '${DD.code}', '${DD.name}', '${DD.name}', 'person', 1, 5);`);
    const again = await run(db, [deleteEntity(DD)]);
    expect(reasons(again.report)).toMatch(/line 2: line 2 was applied before and has changed since: .*the ledger row [0-9a-f-]+ of this file records a deletion, and ne-dddddd is there/);
  });
});

describe("delete-place", () => {
  it("deletes the place, writes the page's ledger row with its snapshot, reads back, and a rerun writes nothing", async () => {
    const db = database();
    await appliesAndReruns(db, [deletePlace(TUNJA)], ["already deleted place"]);
    expect(all(db, `SELECT id FROM places WHERE id = '${TUNJA.id}'`)).toEqual([]);
    const [ledger] = all(db, "SELECT * FROM authority_operations");
    expect(ledger).toMatchObject({ record_type: "place", operation: "delete", source_id: TUNJA.id, target_id: null });
    expect(JSON.parse(ledger.detail).snapshot).toMatchObject({ id: TUNJA.id, placeCode: TUNJA.code, label: TUNJA.label, latitude: 5.53, longitude: -73.36, updatedAt: 7 });
  });

  it("refuses a place with a description link, a child, or a merge naming it as survivor", async () => {
    const db = database();
    db.exec(`INSERT INTO description_places (id, description_id, place_id, role, created_at) VALUES ('dp-1', 'd9', '${TUNJA.id}', 'venue', 3);`);
    db.exec(`UPDATE places SET parent_id = '${LEIVA.id}' WHERE id = '${SOGA.id}';`);
    db.exec(`INSERT INTO places (id, federation_id, place_code, label, display_name, merged_into, created_at, updated_at) VALUES ('p-m', '${FED}', 'nl-mmmmmm', 'Merged', 'Merged', '${SOGA.id}', 1, 7);`);
    expect(await refused(db, [deletePlace(TUNJA), deletePlace(LEIVA), deletePlace(SOGA)])).toBe([
      `${FILE} line 2: nl-tttttt holds 1 description link; drop or move it in an earlier file`,
      `${FILE} line 3: nl-llllll is the parent of 1 place, which would name a place that is gone`,
      `${FILE} line 4: nl-ssssss is the survivor of a merge: the records merged into it name it`,
    ].join("\n"));
  });
});

describe("deletes of shared records", () => {
  it("are refused when the actor is not a steward, for an entity and for a place", async () => {
    const db = database();
    db.exec("UPDATE users SET is_admin = 0, is_authorities_admin = 1, is_records_admin = 1 WHERE id = 'user_001'");
    for (const row of [deleteEntity(DD), deletePlace(TUNJA)]) {
      await expect(run(db, [row], { apply: true })).rejects.toThrow(/is not a steward of neogranadina-fed, whose shared records the file changes/);
    }
    expect(all(db, `SELECT id FROM entities WHERE id = '${DD.id}'`)).toHaveLength(1);
    expect(all(db, `SELECT id FROM places WHERE id = '${TUNJA.id}'`)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// update-link
// ---------------------------------------------------------------------------

describe("update-link", () => {
  const seed = () => {
    const db = database();
    links(db, [["doc-1", "d1", AA.id, "witness", null], ["doc-2", "d1", BB.id, "witness", null], ["doc-3", "d1", BB.id, "plaintiff", null]]);
    db.exec("UPDATE description_entities SET role_note = 'por su padre', sequence = 2 WHERE id = 'doc-1'");
    return db;
  };

  it("changes the role and the fields given, journals the link as read and as written, and a rerun writes nothing", async () => {
    const db = seed();
    const row = updateLink(AA, "co-test-001-d001", "witness", {
      new_role: "plaintiff", role_note: "en nombre propio", current_role_note: "por su padre", sequence: "4", current_sequence: "2",
      honorific: "doña", name_as_recorded: "Juana", role_raw: "NULL",
    });
    const dry = await run(db, [row]);
    expect(reasons(dry.report)).toBe("");
    expect(dry.report.totals.updateLink).toBe(1);
    await appliesAndReruns(db, [row], ["already updated link"]);
    expect(one(db, "SELECT * FROM description_entities WHERE id = 'doc-1'")).toMatchObject({
      entity_id: AA.id, role: "plaintiff", role_note: "en nombre propio", sequence: 4, honorific: "doña", name_as_recorded: "Juana", role_raw: null,
    });
    const journal = all(db, "SELECT kind, record_id, record_type, diff FROM changelog ORDER BY rowid");
    expect(journal.map((j) => [j.kind, j.record_id, j.record_type])).toEqual([["unlink", "d1", "description"], ["link", "d1", "description"]]);
    expect(JSON.parse(journal[0].diff)).toMatchObject({ id: "doc-1", role: "witness", roleNote: "por su padre", sequence: 2 });
    expect(JSON.parse(journal[1].diff)).toMatchObject({ id: "doc-1", role: "plaintiff", roleNote: "en nombre propio", sequence: 4, honorific: "doña" });
  });

  it("changes a relation side's fields, keeping its role and partner", async () => {
    const db = database();
    links(db, [["r-a", "d1", AA.id, "parent", "r-c"], ["r-c", "d1", CC.id, "child", "r-a"]]);
    const row = updateLink(AA, "co-test-001-d001", "parent", { honorific: "doña" });
    await appliesAndReruns(db, [row], ["already updated link"]);
    expect(one(db, "SELECT role, honorific, related_to FROM description_entities WHERE id = 'r-a'")).toEqual({ role: "parent", honorific: "doña", related_to: "r-c" });
  });

  it("is same when the link already holds the values, with nothing written", async () => {
    const db = seed();
    const { report, applied } = await run(db, [updateLink(AA, "co-test-001-d001", "witness", { role_note: "por su padre", current_role_note: "por su padre" })], { apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("nothing to write");
    expect(report.rows.map((r) => r.status)).toEqual(["same"]);
    expect(applied).toEqual([]);
  });

  it("refuses a stated value that differs, a colliding role, a relation side's role, and rows that give nothing to change", async () => {
    const db = seed();
    links(db, [["r-a", "d2", AA.id, "parent", "r-c"], ["r-c", "d2", CC.id, "child", "r-a"]]);
    expect(await refused(db, [
      updateLink(AA, "co-test-001-d001", "witness", { role_note: "x", current_role_note: "por su madre" }),
      updateLink(BB, "co-test-001-d001", "witness", { new_role: "plaintiff" }),
      updateLink(AA, "co-test-001-d002", "parent", { new_role: "witness" }),
      updateLink(CC, "co-test-001-d002", "child", {}),
      updateLink(CC, "co-test-001-d002", "child", { current_honorific: "don" }),
      updateLink(CC, "co-test-001-d002", "child", { sequence: "-1", current_sequence: "0" }),
      updateLink(AA, "co-test-001-d001", "witness", { new_role: "notary" }),
      updateLink(AA, "co-test-001-d001", "witness", { sequence: "3", current_sequence: "" }),
    ])).toBe([
      `${FILE} line 2: current_role_note "por su madre" is not the stored "por su padre"`,
      `${FILE} line 3: ne-bbbbbb already holds co-test-001-d001 as plaintiff (link doc-3); the update is refused, not merged`,
      `${FILE} line 4: link r-a is a side of a relation, whose role is paired with its partner's; update-link does not change it`,
      `${FILE} line 5: update-link gives no field to change`,
      `${FILE} line 6: current_honorific is given and honorific is not`,
      `${FILE} line 7: sequence "-1" is not a whole number from 0 to ${Number.MAX_SAFE_INTEGER}`,
      `${FILE} line 8: new_role "notary" is not in the federation's entity_role list`,
      `${FILE} line 9: current_sequence "" is not the stored "2"`,
    ].join("\n"));
  });

  it("refuses a rerun when the link was changed after the apply", async () => {
    const db = seed();
    const row = updateLink(AA, "co-test-001-d001", "witness", { role_note: "en nombre propio", current_role_note: "por su padre" });
    await run(db, [row], { apply: true });
    db.exec("UPDATE description_entities SET role_note = 'otra' WHERE id = 'doc-1'");
    const again = await run(db, [row]);
    expect(reasons(again.report)).toMatch(/line 2: line 2 was applied before and has changed since: .*records an update of link doc-1, and the row would write more/);
  });
});

// ---------------------------------------------------------------------------
// drop-relation, and drop-link on a relation side
// ---------------------------------------------------------------------------

describe("drop-relation", () => {
  const seed = () => {
    const db = database();
    links(db, [["r-a", "d1", AA.id, "parent", "r-c"], ["r-c", "d1", CC.id, "child", "r-a"], ["doc-1", "d1", AA.id, "witness", null]]);
    return db;
  };

  it("removes both sides, journals an unlink of each, and a rerun writes nothing", async () => {
    const db = seed();
    const row = dropRelation(AA, "parent", CC, "child");
    const dry = await run(db, [row]);
    expect(reasons(dry.report)).toBe("");
    expect(dry.report.totals.dropRelation).toBe(1);
    await appliesAndReruns(db, [row], ["already dropped relation"]);
    expect(all(db, "SELECT id FROM description_entities ORDER BY id")).toEqual([{ id: "doc-1" }]);
    const journal = all(db, "SELECT kind, record_id, diff FROM changelog ORDER BY rowid");
    expect(journal.map((j) => [j.kind, j.record_id, JSON.parse(j.diff).id, JSON.parse(j.diff).relatedTo])).toEqual([
      ["unlink", "d1", "r-a", "r-c"], ["unlink", "d1", "r-c", "r-a"],
    ]);
  });

  it("finds the relation whichever side the file names first", async () => {
    const db = seed();
    await appliesAndReruns(db, [dropRelation(CC, "child", AA, "parent")], ["already dropped relation"]);
    expect(all(db, "SELECT id FROM description_entities WHERE related_to IS NOT NULL")).toEqual([]);
  });

  it("aborts with nothing written when a link of another description names a side", async () => {
    const db = seed();
    // Stale data the plan does not read: a link on another tenant's description naming r-a.
    links(db, [["f-1", "d9", BB.id, "child", "r-a"]]);
    const before = snapshot(db);
    await expect(run(db, [dropRelation(AA, "parent", CC, "child")], { apply: true })).rejects.toThrow(/ABORT|malformed JSON/);
    expect(snapshot(db)).toBe(before);
  });

  it("refuses a relation the description does not hold, one a third link names, a column of another operation, and one record twice; drop-link refuses a side", async () => {
    const db = seed();
    links(db, [["r-b", "d2", BB.id, "parent", "r-d"], ["r-d", "d2", DD.id, "child", "r-b"], ["x-2", "d2", CC.id, "child", "r-b"]]);
    expect(await refused(db, [
      dropRelation(AA, "child", CC, "parent"),
      dropRelation(BB, "parent", DD, "child", { description_code: "co-test-001-d002" }),
      { op: "drop-link", authority_code: AA.code, authority_name: AA.name, description_code: "co-test-001-d001", role: "parent" },
      dropRelation(AA, "parent", CC, "child", { role: "parent" }),
      dropRelation(AA, "parent", AA, "child"),
    ])).toBe([
      // The row's shape is checked first, as for every operation.
      `${FILE} line 5: drop-relation carries no role`,
      `${FILE} line 2: co-test-001-d001 holds no relation between ne-aaaaaa (child) and ne-cccccc (parent)`,
      `${FILE} line 3: link x-2 names a side of the relation, which would name a link that is gone`,
      `${FILE} line 4: link r-a is a side of a relation; drop-link removes document links, and drop-relation removes a relation`,
      `${FILE} line 6: a_entity and b_entity are both ne-aaaaaa`,
    ].join("\n"));
  });
});

// ---------------------------------------------------------------------------
// Minted codes
// ---------------------------------------------------------------------------

describe("minted codes in the report", () => {
  const rows: Cells[] = [
    { op: "create-entity", new_key: "k-uno", display_name: "Pedro Uno", sort_name: "Uno, Pedro", entity_type: "person" },
    { op: "create-place", new_key: "k-ramiriqui", label: "Ramiriquí", display_name: "Ramiriquí" },
  ];

  it("gives minted on apply in a dry run, the code written after the apply, and the code held on a rerun", async () => {
    const db = database();
    const dry = await run(db, rows);
    expect(reasons(dry.report)).toBe("");
    expect(dry.report.minted).toEqual([
      { line: 2, op: "create-entity", newKey: "k-uno", status: "create", code: MINTED_ON_APPLY },
      { line: 3, op: "create-place", newKey: "k-ramiriqui", status: "create", code: MINTED_ON_APPLY },
    ]);
    const md = [...dry.written].find(([p]) => p.endsWith(".md"))![1];
    expect(md).toContain("| 2 | create-entity | k-uno | minted on apply | create |");

    const applied = await run(db, rows, { apply: true });
    expect(applied.report.outcome).toBe("verified");
    const entityCode = one(db, `SELECT entity_code FROM entities WHERE created_at = ${NOW}`).entity_code;
    const placeCode = one(db, `SELECT place_code FROM places WHERE created_at = ${NOW}`).place_code;
    expect(applied.report.minted.map((m) => m.code)).toEqual([entityCode, placeCode]);
    const json = JSON.parse([...applied.written].find(([p]) => p.endsWith(".json"))![1]) as AuthoritiesReport;
    expect(json.minted.map((m) => [m.newKey, m.code])).toEqual([["k-uno", entityCode], ["k-ramiriqui", placeCode]]);
    const appliedMd = [...applied.written].find(([p]) => p.endsWith(".md"))![1];
    expect(appliedMd).toContain(`| 2 | create-entity | k-uno | ${entityCode} | create |`);
    expect(appliedMd).toContain(`| 3 | create-place | k-ramiriqui | ${placeCode} | create |`);

    const again = await run(db, rows);
    expect(again.report.minted.map((m) => [m.status, m.code])).toEqual([["already created", entityCode], ["already created", placeCode]]);
  });
});

// @version v0.9.0
