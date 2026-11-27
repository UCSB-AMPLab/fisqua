/**
 * Tests — places and link moves in the command line's authority changes
 *
 * This suite pins the operations of `scripts/lib/authorities-cli/` that
 * act on places and move or drop description links: `create-place`,
 * `update-place`, `merge-place`, `move-place-link`, `drop-place-link`,
 * `move-link` and `drop-link`. The run is driven end to end against an
 * in-memory `node:sqlite` database with the tables and columns the
 * engine reads and writes, foreign keys on and D1's expression depth
 * limit of 100; the file it writes is applied as one unit, as `wrangler
 * d1 execute --file` applies it. Nothing here reaches D1.
 *
 * The vocabulary is the test's own: place types and roles are checked
 * against the federation's `vocabulary_values`, so the codes here are
 * data, not constants of the engine.
 *
 *   - each operation plans, applies, reads back, and a second run
 *     writes nothing and reports every row done;
 *   - a place split as one file (create-place, move-place-link,
 *     update-place) and an entity split (create-entity, move-link,
 *     update-entity);
 *   - the refusals of each operation, and an unknown place type or role
 *     refused against the vocabulary;
 *   - a place or a link changed between plan and apply aborts the file
 *     with nothing written, and so do a loser's and a survivor's
 *     descriptions changing hands with the link counts unchanged, and a
 *     changelog row a rerun relies on changing its diff;
 *   - reruns after a reversal: a merge undone, links back on a loser, a
 *     removed variant restored, a dropped link's id back anywhere; a
 *     parent changed and cleared; label_to_keep fixing a display name;
 *   - an addition naming a record a merge row of the file merges;
 *   - an update-entity row's changelog row, under an id made from the
 *     file and the record, as its only evidence: a field added after the
 *     apply and another file's changelog row are refused; a row its
 *     record already holds without that row (a renamed file, a row
 *     applied under a random changelog id, a fresh row) is "same",
 *     neither done nor pending; an unchanged file, a restated field
 *     among them, reruns clean.
 *
 * The 24 October place merge list, re-expressed as `merge-place` rows,
 * is checked in `authorities-cli-places-proof.test.ts`.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AuthoritiesReport } from "../../scripts/lib/authorities-cli/run";
import { D1_LIMITS, PLACES_DDL, runFile, type RunOptions } from "./authorities-cli-places-helpers";
import { newRecordId } from "../../scripts/lib/authority-links";
import { ENTITY_UPDATE_JOURNAL_NAMESPACE } from "../../scripts/lib/authorities-cli/plan";

const FED = "fed-1";
const TENANT = "t-1";
const FILE = "places-test.csv";
const NOW = 1_763_500_000_000;


/** The test's vocabulary: list and code. */
const VOCABULARY: Array<[string, string, string | null]> = [
  ["entity_type", "person", null], ["entity_type", "corporate", null],
  ["entity_role", "witness", null], ["entity_role", "mentioned", null], ["entity_role", "plaintiff", null],
  ["place_role", "venue", null], ["place_role", "mentioned", null],
  ["place_type", "city", null], ["place_type", "town", null], ["place_type", "hacienda", null],
  ["gender", "female", null], ["gender", "male", null],
  ["relation_role", "parent", "child"], ["relation_role", "child", "parent"],
];

const AA = { id: "e-a", code: "ne-aaaaaa", name: "Juana Díaz" };
const BB = { id: "e-b", code: "ne-bbbbbb", name: "Diego Díaz" };
const CC = { id: "e-c", code: "ne-cccccc", name: "Ana Ruiz" };

const TUNJA = { id: "p-t", code: "nl-tttttt", label: "Tunja" };
const TUNXA = { id: "p-x", code: "nl-xxxxxx", label: "Tunxa" };
const LEIVA = { id: "p-l", code: "nl-llllll", label: "Villa de Leiva" };
const SOGA = { id: "p-s", code: "nl-ssssss", label: "Sogamoso" };
const GONE = { id: "p-g", code: "nl-gggggg", label: "Gone" };
const FAR = { id: "p-f", code: "nl-ffffff", label: "Elsewhere" };

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:", D1_LIMITS);
  db.exec(PLACES_DDL);
  db.exec(`INSERT INTO federations VALUES ('${FED}', 'neogranadina-fed', 'active', '${TENANT}', 1, 'ne', 'nl'), ('fed-2', 'other-fed', 'active', 't-3', 1, 'oe', 'ol');`);
  db.exec(`INSERT INTO tenants VALUES ('${TENANT}', 'neogranadina', '${FED}', NULL, 1, 'ne', 'nl'), ('t-2', 'other', '${FED}', NULL, 1, 'ot', 'op'), ('t-3', 'far', 'fed-2', NULL, 1, 'oe', 'ol');`);
  db.exec(`INSERT INTO users (id, email, name, tenant_id, is_admin) VALUES ('user_001', 'admin@example.org', 'Admin', '${TENANT}', 1);`);
  db.exec(`INSERT INTO descriptions VALUES ('d1', '${TENANT}', 'co-test-001-d001'), ('d2', '${TENANT}', 'co-test-001-d002'), ('d3', '${TENANT}', 'co-test-001-d003'), ('d9', 't-2', 'co-other-d009');`);
  const v = db.prepare("INSERT INTO vocabulary_values (id, federation_id, list, code, created_at, updated_at, inverse_code) VALUES (?, ?, ?, ?, 1, 1, ?)");
  VOCABULARY.forEach(([list, code, inverse], i) => v.run(`v-${i}`, FED, list, code, inverse));
  const e = db.prepare(
    "INSERT INTO entities (id, federation_id, tenant_id, entity_code, display_name, sort_name, entity_type, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, 'person', 1, 5)",
  );
  for (const x of [AA, BB, CC]) e.run(x.id, FED, x.code, x.name, x.name);
  const p = db.prepare(
    "INSERT INTO places (id, federation_id, tenant_id, place_code, label, display_name, place_type, name_variants, latitude, longitude, " +
      "coordinate_precision, merged_into, tgn_id, hgis_id, whg_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, 'city', ?, ?, ?, ?, ?, ?, ?, ?, 1, 7)",
  );
  p.run(TUNJA.id, FED, TUNJA.code, TUNJA.label, TUNJA.label, '["Tunxa de Boyacá"]', null, null, null, null, null, "hg-1", null);
  p.run(TUNXA.id, FED, TUNXA.code, TUNXA.label, TUNXA.label, '["Hunza"]', 5.53, -73.36, "approximate", null, "1001", "hg-1", "w-9");
  p.run(LEIVA.id, FED, LEIVA.code, LEIVA.label, LEIVA.label, "[]", 5.63, -73.52, "exact", null, "1002", null, null);
  p.run(SOGA.id, FED, SOGA.code, SOGA.label, SOGA.label, "[]", null, null, null, null, null, null, null);
  p.run(GONE.id, FED, GONE.code, GONE.label, GONE.label, "[]", null, null, null, SOGA.id, null, null, null);
  db.exec(`INSERT INTO places (id, federation_id, tenant_id, place_code, label, display_name, created_at, updated_at) VALUES ('${FAR.id}', 'fed-2', NULL, '${FAR.code}', '${FAR.label}', '${FAR.label}', 1, 7);`);
  const l = db.prepare("INSERT INTO description_places (id, description_id, place_id, role, role_note, role_raw, created_at) VALUES (?, ?, ?, ?, ?, NULL, 3)");
  l.run("dp-1", "d1", TUNJA.id, "mentioned", null);
  l.run("dp-2", "d1", TUNXA.id, "mentioned", "en Tunxa");
  l.run("dp-3", "d2", TUNXA.id, "venue", null);
  l.run("dp-4", "d9", TUNXA.id, "mentioned", null);
  l.run("dp-5", "d3", LEIVA.id, "venue", null);
  l.run("dp-6", "d3", LEIVA.id, "mentioned", null);
  const de = db.prepare("INSERT INTO description_entities (id, description_id, entity_id, role, sequence, created_at) VALUES (?, ?, ?, ?, 0, 3)");
  de.run("de-1", "d1", AA.id, "witness");
  de.run("de-2", "d2", AA.id, "witness");
  de.run("de-3", "d2", BB.id, "witness");
  de.run("de-4", "d3", AA.id, "plaintiff");
  return db;
}

type Cells = Record<string, string>;

const PLACE_FIELDS = ["label", "display_name", "place_type", "parent", "latitude", "longitude", "coordinate_precision", "tgn_id", "hgis_id", "whg_id", "fclass", "notes"];
const HEADER = [
  "op", "authority_code", "authority_name", "new_key", ...PLACE_FIELDS,
  ...PLACE_FIELDS.filter((f) => f !== "label").map((f) => `current_${f}`),
  "name_variants_add", "name_variants_remove", "label_to_keep", "target_codes", "description_code", "role", "place", "entity", "role_note",
  "sort_name", "entity_type", "primary_function", "current_name", "current_dates", "current_function",
  "changelog_note", "evidence", "facts", "evidence_codes",
];

const run = (db: DatabaseSync, rows: Cells[], opts: RunOptions = {}) => runFile(db, rows, { header: HEADER, file: FILE, now: NOW, ...opts });

const all = (db: DatabaseSync, sql: string) => db.prepare(sql).all() as Array<Record<string, any>>;
const one = (db: DatabaseSync, sql: string) => all(db, sql)[0];
const reasons = (r: AuthoritiesReport) => r.refusals.map((f) => `${f.ref}: ${f.reason}`).join("\n");
const snapshot = (db: DatabaseSync) =>
  JSON.stringify(["places", "entities", "description_entities", "description_places", "changelog", "authority_operations"].map((t) => all(db, `SELECT * FROM ${t} ORDER BY rowid`)));

/** Applies the file, then runs it again: the second run writes nothing and reports every row done. */
async function appliesAndReruns(db: DatabaseSync, rows: Cells[], expectDone: string[], opts: { file?: string; header?: string[] } = {}) {
  const { report } = await run(db, rows, { apply: true, ...opts });
  expect(reasons(report)).toBe("");
  expect(report.problems).toEqual([]);
  expect(report.outcome).toBe("verified");
  const after = snapshot(db);
  const again = await run(db, rows, { apply: true, ...opts });
  expect(reasons(again.report)).toBe("");
  expect(again.report.outcome).toBe("nothing to write");
  expect(again.applied).toEqual([]);
  expect(again.report.rows.map((r) => r.status)).toEqual(expectDone);
  expect(snapshot(db)).toBe(after);
  return report;
}

const createPlace = (key: string, label: string, over: Cells = {}): Cells => ({
  op: "create-place", new_key: key, label, display_name: label, changelog_note: "From the places list", ...over,
});
const updatePlace = (p: { code: string; label: string }, over: Cells = {}): Cells => ({
  op: "update-place", authority_code: p.code, authority_name: p.label, changelog_note: "Corrected", ...over,
});
const mergePlace = (loser: { code: string; label: string }, survivor: { code: string }, over: Cells = {}): Cells => ({
  op: "merge-place", authority_code: loser.code, authority_name: loser.label, target_codes: survivor.code, changelog_note: "Same place", ...over,
});
const movePlaceLink = (from: { code: string; label: string }, description: string, role: string, to: string, over: Cells = {}): Cells => ({
  op: "move-place-link", authority_code: from.code, authority_name: from.label, description_code: description, role, target_codes: to, ...over,
});
const dropPlaceLink = (from: { code: string; label: string }, description: string, role: string, over: Cells = {}): Cells => ({
  op: "drop-place-link", authority_code: from.code, authority_name: from.label, description_code: description, role, ...over,
});
const moveLink = (from: { code: string; name: string }, description: string, role: string, to: string, over: Cells = {}): Cells => ({
  op: "move-link", authority_code: from.code, authority_name: from.name, description_code: description, role, target_codes: to, ...over,
});
const dropLink = (from: { code: string; name: string }, description: string, role: string, over: Cells = {}): Cells => ({
  op: "drop-link", authority_code: from.code, authority_name: from.name, description_code: description, role, ...over,
});

// ---------------------------------------------------------------------------
// create-place
// ---------------------------------------------------------------------------

describe("create-place", () => {
  it("plans, applies and reads back; a second run writes nothing", async () => {
    const db = database();
    const rows = [
      createPlace("k-ramiriqui", "Ramiriquí", {
        place_type: "town", parent: "new:k-boyaca", latitude: "5.4", longitude: "-73.33", coordinate_precision: "approximate",
        tgn_id: "1003", fclass: "P", notes: "Pueblo de indios", name_variants_add: "Ramiriqui | Ramiriquy",
      }),
      createPlace("k-boyaca", "Boyacá", { place_type: "city", parent: TUNJA.code }),
    ];
    const dry = await run(db, rows);
    expect(reasons(dry.report)).toBe("");
    expect(dry.report.totals.create).toBe(2);
    await appliesAndReruns(db, rows, ["already created", "already created"]);
    const made = all(db, `SELECT * FROM places WHERE created_at = ${NOW} ORDER BY label`);
    expect(made.map((p) => p.label)).toEqual(["Boyacá", "Ramiriquí"]);
    const [boyaca, ramiriqui] = made;
    expect(ramiriqui).toMatchObject({
      display_name: "Ramiriquí", place_type: "town", parent_id: boyaca.id, latitude: 5.4, longitude: -73.33, coordinate_precision: "approximate",
      tgn_id: "1003", hgis_id: null, whg_id: null, fclass: "P", notes: "Pueblo de indios", name_variants: '["Ramiriqui","Ramiriquy"]',
      merged_into: null, tenant_id: null, legacy_ids: "[]", updated_at: NOW,
    });
    expect(ramiriqui.place_code).toMatch(/^nl-[a-z2-9]{6}$/);
    expect(boyaca).toMatchObject({ parent_id: TUNJA.id, fclass: null });
    const journal = all(db, `SELECT * FROM changelog WHERE record_id = '${ramiriqui.id}'`);
    expect(journal.map((j) => [j.record_type, j.kind, j.note])).toEqual([["place", "create", "From the places list"]]);
    expect(JSON.parse(journal[0].diff).label).toEqual({ old: null, new: "Ramiriquí" });
  });

  it("mints a place owned by the tenant, under its prefix, where the federation does not share its authorities", async () => {
    const db = database();
    db.exec(`UPDATE federations SET shared_authorities_enabled = 0 WHERE id = '${FED}'`);
    db.exec(`UPDATE tenants SET place_code_prefix = 'tn' WHERE id = '${TENANT}'`);
    const { report } = await run(db, [createPlace("k", "Moniquirá")], { apply: true });
    expect(report.outcome).toBe("verified");
    const p = one(db, "SELECT tenant_id, place_code FROM places WHERE label = 'Moniquirá'");
    expect(p.tenant_id).toBe(TENANT);
    expect(p.place_code).toMatch(/^tn-[a-z2-9]{6}$/);
  });

  it("is refused in a federation that shares its authorities when the actor is not a steward", async () => {
    const db = database();
    db.exec("UPDATE users SET is_admin = 0, is_authorities_admin = 1, is_records_admin = 1 WHERE id = 'user_001'");
    await expect(run(db, [createPlace("k", "Moniquirá")])).rejects.toThrow(/is not a steward of neogranadina-fed, whose shared authorities a new record joins/);
  });

  it("is linked by add-place-link as new:<key> in the same file, in either order, and a second run writes nothing", async () => {
    const link = { op: "add-place-link", description_code: "co-test-001-d002", place: "new:k-suta", role: "venue", role_note: "en la hacienda" };
    const create = createPlace("k-suta", "Hacienda de Suta", { place_type: "hacienda" });
    for (const rows of [[create, link], [link, create]]) {
      const db = database();
      await appliesAndReruns(db, rows, rows[0] === create ? ["already created", "already place-linked"] : ["already place-linked", "already created"]);
      const suta = one(db, "SELECT id FROM places WHERE label = 'Hacienda de Suta'");
      expect(all(db, `SELECT description_id, role, role_note FROM description_places WHERE place_id = '${suta.id}'`)).toEqual([
        { description_id: "d2", role: "venue", role_note: "en la hacienda" },
      ]);
      const journal = all(db, "SELECT record_id, record_type, kind FROM changelog ORDER BY rowid").map((j) => `${j.record_type}:${j.kind}`);
      expect(journal.sort()).toEqual(["description:link", "place:create"]);
    }
  });

  it("refuses a place link to a key whose create-place row is refused", async () => {
    const { report } = await run(database(), [
      { op: "add-place-link", description_code: "co-test-001-d002", place: "new:k-bad", role: "venue" },
      createPlace("k-bad", "Mala", { place_type: "volcano" }),
    ]);
    expect(reasons(report)).toMatch(/line 2: new:k-bad is refused at line 3/);
  });

  it("leaves fclass empty when the file does not give it, whatever the type", async () => {
    const db = database();
    await run(db, [createPlace("k", "Hacienda de Suta", { place_type: "hacienda" })], { apply: true });
    expect(one(db, "SELECT fclass, place_type FROM places WHERE label = 'Hacienda de Suta'")).toEqual({ fclass: null, place_type: "hacienda" });
  });

  it("refuses a type, precision, fclass or coordinate the app would not accept", async () => {
    const db = database();
    const { report } = await run(db, [
      createPlace("k1", "Uno", { place_type: "volcano" }),
      createPlace("k2", "Dos", { coordinate_precision: "roughly" }),
      createPlace("k3", "Tres", { fclass: "Q" }),
      createPlace("k4", "Cuatro", { latitude: "5.1" }),
      createPlace("k5", "Cinco", { latitude: "95", longitude: "-73" }),
      createPlace("k6", "Seis", { display_name: "" }),
      createPlace("k1", "Siete"),
      createPlace("k8", "Ocho", { parent: "new:k-none" }),
      createPlace("k9", "Nueve", { parent: GONE.code }),
    ]);
    const r = reasons(report);
    expect(r).toMatch(/line 2: place_type "volcano" is not in the federation's place_type list/);
    expect(r).toMatch(/line 3: coordinate_precision "roughly" is not one of/);
    expect(r).toMatch(/line 4: fclass "Q" is not one of P, H, A, T, S/);
    expect(r).toMatch(/line 5: latitude and longitude are given together or not at all/);
    expect(r).toMatch(/line 6: latitude/);
    expect(r).toMatch(/line 7: create-place names no display_name/);
    expect(r).toMatch(/line 8: new_key k1 is defined again \(line 2\)/);
    expect(r).toMatch(/line 9: new:k-none is not defined by any create-place row of the file/);
    expect(r).toMatch(/line 10: the parent nl-gggggg is merged into p-s/);
  });

  it("refuses a type the federation's list holds that the app does not accept", async () => {
    const db = database();
    db.exec(`INSERT INTO vocabulary_values (id, federation_id, list, code, created_at, updated_at) VALUES ('v-x', '${FED}', 'place_type', 'island', 1, 1)`);
    const { report } = await run(db, [createPlace("k", "Isla", { place_type: "island" })]);
    expect(reasons(report)).toMatch(/place_type "island" is not one the place editor accepts/);
  });
});

// ---------------------------------------------------------------------------
// update-place
// ---------------------------------------------------------------------------

describe("update-place", () => {
  it("changes the fields given, clears NULL, adds and removes variants, and journals one row", async () => {
    const db = database();
    const rows = [updatePlace(TUNXA, {
      label: "Hunza", display_name: "Hunza (Tunja)", current_display_name: "Tunxa", place_type: "NULL", current_place_type: "city",
      latitude: "NULL", longitude: "NULL", current_latitude: "5.53", current_longitude: "-73.36", coordinate_precision: "NULL",
      current_coordinate_precision: "approximate", tgn_id: "1009", current_tgn_id: "1001", parent: TUNJA.code, notes: "Nombre muisca",
      name_variants_add: "Tunxa", name_variants_remove: "Hunza",
    })];
    const dry = await run(db, rows);
    expect(reasons(dry.report)).toBe("");
    expect(dry.report.totals.update).toBe(1);
    await appliesAndReruns(db, rows, ["already updated"]);
    const p = one(db, `SELECT * FROM places WHERE id = '${TUNXA.id}'`);
    expect(p).toMatchObject({
      label: "Hunza", display_name: "Hunza (Tunja)", place_type: null, latitude: null, longitude: null, coordinate_precision: null,
      tgn_id: "1009", hgis_id: "hg-1", parent_id: TUNJA.id, notes: "Nombre muisca", name_variants: '["Tunxa"]',
    });
    expect(p.updated_at).toBe(NOW);
    const journal = all(db, `SELECT * FROM changelog WHERE record_id = '${TUNXA.id}'`);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ record_type: "place", kind: "update", note: "Corrected" });
    expect(JSON.parse(journal[0].diff)).toMatchObject({
      label: { old: "Tunxa", new: "Hunza" }, latitude: { old: 5.53, new: null }, nameVariants: { old: '["Hunza"]', new: '["Tunxa"]' },
      parentId: { old: null, new: TUNJA.id },
    });
  });

  it("refuses NULL on label or display name, a lone coordinate, a wrong current value and a second row", async () => {
    const db = database();
    const { report } = await run(db, [
      updatePlace(TUNJA, { label: "NULL" }),
      updatePlace(TUNXA, { display_name: "NULL", current_display_name: "Tunxa" }),
      updatePlace(LEIVA, { latitude: "5.7", current_latitude: "5.63" }),
      updatePlace(SOGA, { tgn_id: "77", current_tgn_id: "66" }),
      updatePlace(SOGA, { notes: "x" }),
      updatePlace({ code: TUNJA.code, label: "Tunxa" }, { notes: "x" }),
    ]);
    const r = reasons(report);
    expect(r).toMatch(/line 2: label cannot be NULL/);
    expect(r).toMatch(/line 3: display_name cannot be NULL/);
    expect(r).toMatch(/line 4: latitude and longitude are given together or not at all/);
    expect(r).toMatch(/line 5: current_tgn_id "66" is not the stored ""/);
    expect(r).toMatch(/line 6: nl-ssssss has another update-place row \(line 5\)/);
    expect(r).toMatch(/line 7: authority_name "Tunxa" is not the stored label "Tunja"/);
    const moreRun = (await run(database(), [
      updatePlace(LEIVA, { name_variants_remove: "Leyva" }),
      updatePlace(TUNXA, { place_type: "volcano", current_place_type: "city" }),
      updatePlace(TUNJA, { notes: "NULL" }),
    ])).report;
    const more = reasons(moreRun);
    expect(more).toMatch(/line 2: name_variants_remove names "Leyva", which the stored name_variants do not hold/);
    expect(more).toMatch(/line 3: place_type "volcano" is not in the federation's place_type list/);
    // A row the place already holds, with no changelog row of this file: same, not a refusal.
    expect(more).not.toMatch(/line 4/);
    expect(moreRun.rows[2].status).toBe("same");
  });

  it("refuses a change without its current value", async () => {
    const db = database();
    const { report } = await run(db, [updatePlace(TUNXA, { tgn_id: "1009" })]);
    expect(reasons(report)).toMatch(/current_tgn_id "" is not the stored "1001"/);
  });
});

// ---------------------------------------------------------------------------
// merge-place
// ---------------------------------------------------------------------------

describe("merge-place", () => {
  it("moves the tenant's links, drops a collision into the ledger, folds the names and carries only into an empty field", async () => {
    const db = database();
    const rows = [mergePlace(TUNXA, TUNJA, {
      label_to_keep: "Tunja de Boyacá", name_variants_add: "Tunxa | Hunza | Tunja", tgn_id: "1001", hgis_id: "hg-1",
      latitude: "5.53", longitude: "-73.36", coordinate_precision: "approximate",
    })];
    const dry = await run(db, rows);
    expect(reasons(dry.report)).toBe("");
    expect(dry.report.totals.merge).toBe(1);
    await appliesAndReruns(db, rows, ["already merged"]);

    const loser = one(db, `SELECT * FROM places WHERE id = '${TUNXA.id}'`);
    expect(loser.merged_into).toBe(TUNJA.id);
    expect(loser.updated_at).toBe(NOW);
    const s = one(db, `SELECT * FROM places WHERE id = '${TUNJA.id}'`);
    expect(s).toMatchObject({
      label: "Tunja de Boyacá", display_name: "Tunja de Boyacá", tgn_id: "1001", hgis_id: "hg-1", whg_id: null,
      latitude: 5.53, longitude: -73.36, coordinate_precision: "approximate", updated_at: NOW,
    });
    expect(JSON.parse(s.name_variants)).toEqual(["Tunxa de Boyacá", "Tunxa", "Hunza", "Tunja"]);
    // d1 mentioned collides with Tunja's own link and is dropped; d2 moves; d9 is another tenant's and stays.
    expect(all(db, "SELECT id, place_id FROM description_places WHERE id IN ('dp-1','dp-2','dp-3','dp-4') ORDER BY id")).toEqual([
      { id: "dp-1", place_id: TUNJA.id }, { id: "dp-3", place_id: TUNJA.id }, { id: "dp-4", place_id: TUNXA.id },
    ]);
    const [ledger] = all(db, "SELECT * FROM authority_operations");
    expect(ledger).toMatchObject({ record_type: "place", operation: "merge", source_id: TUNXA.id, target_id: TUNJA.id, user_id: "user_001" });
    const detail = JSON.parse(ledger.detail);
    expect(detail.movedLinks).toBe(1);
    expect(detail.droppedLinks).toEqual([expect.objectContaining({ id: "dp-2", descriptionId: "d1", placeId: TUNXA.id, role: "mentioned", roleNote: "en Tunxa" })]);
    expect(detail.carried).toEqual({ tgnId: "1001", coordinates: "5.53,-73.36 (approximate)" });
    const kinds = all(db, "SELECT record_id, record_type, kind FROM changelog ORDER BY rowid").map((j) => `${j.record_type}:${j.record_id}:${j.kind}`);
    expect(kinds).toContain(`place:${TUNXA.id}:update`);
    expect(kinds.filter((k) => k === `place:${TUNJA.id}:update`).length).toBeGreaterThanOrEqual(1);
    expect(kinds).toContain("description:d1:unlink");
    expect(kinds).toContain("description:d2:link");
  });

  it("refuses a carried value the loser does not hold, or one the survivor holds otherwise", async () => {
    const db = database();
    const { report } = await run(db, [
      mergePlace(TUNXA, TUNJA, { hgis_id: "hg-2" }),
      mergePlace(LEIVA, SOGA, { whg_id: "w-1" }),
    ]);
    const r = reasons(report);
    expect(r).toMatch(/line 2: the row carries hgis_id "hg-2"; nl-xxxxxx holds "hg-1"/);
    expect(r).toMatch(/line 3: the row carries whg_id "w-1"; nl-llllll holds ""/);
    const held = await run(database(), [mergePlace(LEIVA, TUNXA, { tgn_id: "1002", latitude: "5.63", longitude: "-73.52", coordinate_precision: "exact" })]);
    expect(reasons(held.report)).toMatch(/nl-xxxxxx already holds tgn_id "1001"; the row carries "1002"/);
    expect(reasons(held.report)).toMatch(/nl-xxxxxx already holds coordinates 5.53,-73.36 \(approximate\); the row carries 5.63,-73.52 \(exact\)/);
  });

  it("refuses an already merged loser, a survivor that is also a loser, a merged survivor, itself, two targets and another federation", async () => {
    const db = database();
    const { report } = await run(db, [
      mergePlace(GONE, TUNJA),
      mergePlace(TUNXA, LEIVA),
      mergePlace(LEIVA, TUNJA),
      mergePlace(SOGA, GONE),
      mergePlace(TUNJA, TUNJA),
      mergePlace(SOGA, { code: `${TUNJA.code} ${LEIVA.code}` }),
      mergePlace(SOGA, FAR),
    ]);
    const r = reasons(report);
    expect(r).toMatch(/line 2: nl-gggggg is merged into p-s/);
    expect(r).toMatch(/line 3: survivor nl-llllll is also a loser in the file \(line 4\)/);
    expect(r).toMatch(/line 5: the target nl-gggggg is merged into p-s/);
    expect(r).toMatch(/line 6: target nl-tttttt is the row's own place/);
    expect(r).toMatch(/line 7: merge-place names exactly one target code/);
    expect(r).toMatch(/line 8: no place has the code nl-ffffff in the federation/);
  });

  it("checks the variants a survivor gains against name_variants_add", async () => {
    const db = database();
    const { report } = await run(db, [mergePlace(TUNXA, TUNJA, { name_variants_add: "Tunxa" })]);
    expect(reasons(report)).toMatch(/nl-tttttt would gain \["Hunza","Tunxa"\]; the file adds \["Tunxa"\]/);
  });

  it("is refused for a shared place when the actor is not a steward", async () => {
    const db = database();
    db.exec("UPDATE users SET is_admin = 0, is_authorities_admin = 1, is_records_admin = 1 WHERE id = 'user_001'");
    await expect(run(db, [mergePlace(TUNXA, TUNJA, { name_variants_add: "Tunxa | Hunza" })])).rejects.toThrow(/is not a steward of neogranadina-fed, whose shared records the file changes/);
  });
});

// ---------------------------------------------------------------------------
// Link moves
// ---------------------------------------------------------------------------

describe("move-place-link and drop-place-link", () => {
  it("move and drop as the app does, journal each, and a second run finds them done", async () => {
    const db = database();
    const rows = [
      movePlaceLink(TUNXA, "co-test-001-d002", "venue", SOGA.code, { changelog_note: "Wrong place" }),
      dropPlaceLink(LEIVA, "co-test-001-d003", "mentioned"),
    ];
    const dry = await run(db, rows);
    expect(reasons(dry.report)).toBe("");
    await appliesAndReruns(db, rows, ["already moved link", "already dropped link"]);
    expect(one(db, "SELECT place_id FROM description_places WHERE id = 'dp-3'").place_id).toBe(SOGA.id);
    expect(all(db, "SELECT id FROM description_places WHERE id = 'dp-6'")).toEqual([]);
    const journal = all(db, "SELECT record_id, record_type, kind, note, diff FROM changelog ORDER BY rowid");
    expect(journal.map((j) => [j.record_id, j.record_type, j.kind])).toEqual([
      ["d2", "description", "unlink"], ["d2", "description", "link"], ["d3", "description", "unlink"],
    ]);
    expect(journal[0].note).toBe("Wrong place");
    expect(JSON.parse(journal[1].diff)).toMatchObject({ id: "dp-3", placeId: SOGA.id, descriptionId: "d2", role: "venue" });
    expect(JSON.parse(journal[2].diff)).toMatchObject({ id: "dp-6", placeId: LEIVA.id, role: "mentioned" });
    // The places keep their versions: a link is the description's.
    expect(one(db, `SELECT updated_at FROM places WHERE id = '${SOGA.id}'`).updated_at).toBe(7);
  });

  it("refuses a move onto a link the target holds, a link that is not there, an unknown role and another tenant's description", async () => {
    const db = database();
    const { report } = await run(db, [
      movePlaceLink(TUNXA, "co-test-001-d001", "mentioned", TUNJA.code),
      dropPlaceLink(TUNJA, "co-test-001-d002", "venue"),
      dropPlaceLink(TUNXA, "co-test-001-d002", "residence"),
      dropPlaceLink(TUNXA, "co-other-d009", "mentioned"),
      movePlaceLink(LEIVA, "co-test-001-d003", "venue", LEIVA.code),
      movePlaceLink(LEIVA, "co-test-001-d003", "mentioned", "new:k-nowhere"),
    ]);
    const r = reasons(report);
    expect(r).toMatch(/line 2: nl-tttttt already holds co-test-001-d001 as mentioned \(link dp-1\); the move is refused, not merged/);
    expect(r).toMatch(/line 3: nl-tttttt holds no link to co-test-001-d002 as venue/);
    expect(r).toMatch(/line 4: role "residence" is not in the federation's place_role list/);
    expect(r).toMatch(/line 5: no description has the code co-other-d009 in neogranadina/);
    expect(r).toMatch(/line 6: target nl-llllll is the row's own record/);
    expect(r).toMatch(/line 7: new:k-nowhere is not defined by any create-place row of the file/);
  });

  it("refuses two rows that act on one link, and a place a merge row names", async () => {
    const db = database();
    const { report } = await run(db, [
      movePlaceLink(LEIVA, "co-test-001-d003", "venue", SOGA.code),
      dropPlaceLink(LEIVA, "co-test-001-d003", "venue"),
      mergePlace(TUNXA, TUNJA, { name_variants_add: "Tunxa | Hunza" }),
      movePlaceLink(TUNXA, "co-test-001-d002", "venue", SOGA.code),
    ]);
    const r = reasons(report);
    expect(r).toMatch(/line 3: link dp-5 is relied on by line 2/);
    expect(r).toMatch(/line 5: nl-xxxxxx is merged by line 4, so no other row may name it/);
  });
});

describe("move-link and drop-link", () => {
  it("move and drop an entity's document links; a second run finds them done", async () => {
    const db = database();
    const rows = [moveLink(AA, "co-test-001-d001", "witness", CC.code), dropLink(AA, "co-test-001-d003", "plaintiff")];
    await appliesAndReruns(db, rows, ["already moved link", "already dropped link"]);
    expect(one(db, "SELECT entity_id FROM description_entities WHERE id = 'de-1'").entity_id).toBe(CC.id);
    expect(all(db, "SELECT id FROM description_entities WHERE id = 'de-4'")).toEqual([]);
    const journal = all(db, "SELECT record_id, kind, diff FROM changelog ORDER BY rowid");
    expect(journal.map((j) => [j.record_id, j.kind])).toEqual([["d1", "unlink"], ["d1", "link"], ["d3", "unlink"]]);
    expect(JSON.parse(journal[1].diff)).toMatchObject({ id: "de-1", entityId: CC.id, role: "witness" });
  });

  it("refuses a move onto a link the target holds, an unknown role and a relation side's drop", async () => {
    const db = database();
    db.exec("INSERT INTO description_entities (id, description_id, entity_id, role, sequence, created_at, related_to) VALUES ('de-r1', 'd1', 'e-b', 'parent', 0, 3, 'de-r1')");
    db.exec("INSERT INTO description_entities (id, description_id, entity_id, role, sequence, created_at, related_to) VALUES ('de-r2', 'd1', 'e-c', 'child', 0, 3, 'de-r1')");
    db.exec("UPDATE description_entities SET related_to = 'de-r2' WHERE id = 'de-r1'");
    const { report } = await run(db, [
      moveLink(AA, "co-test-001-d002", "witness", BB.code),
      dropLink(AA, "co-test-001-d001", "notary"),
      dropLink(BB, "co-test-001-d001", "parent"),
    ]);
    const r = reasons(report);
    expect(r).toMatch(/line 2: ne-bbbbbb already holds co-test-001-d002 as witness \(link de-3\); the move is refused, not merged/);
    expect(r).toMatch(/line 3: role "notary" is not in the federation's entity_role or relation_role list/);
    expect(r).toMatch(/line 4: link de-r1 is a side of a relation; drop-link removes document links/);
  });
});

// ---------------------------------------------------------------------------
// Splits as one file
// ---------------------------------------------------------------------------

describe("a link an addition finds held, named by another row of the file", () => {
  const sameEntity = { op: "add-link", description_code: "co-test-001-d001", entity: AA.code, role: "witness" };
  const samePlace = { op: "add-place-link", description_code: "co-test-001-d001", place: TUNJA.code, role: "mentioned" };
  const header = [...HEADER, "sequence"];

  it("is same alone", async () => {
    const { report } = await run(database(), [sameEntity, samePlace], { header });
    expect(reasons(report)).toBe("");
    expect(report.rows.map((r) => r.status)).toEqual(["same", "same"]);
  });

  it("refuses the file when a row moves or drops the held link", async () => {
    const cases: Array<[Cells, Cells, string]> = [
      [sameEntity, moveLink(AA, "co-test-001-d001", "witness", BB.code), "de-1"],
      [sameEntity, dropLink(AA, "co-test-001-d001", "witness"), "de-1"],
      [samePlace, movePlaceLink(TUNJA, "co-test-001-d001", "mentioned", SOGA.code), "dp-1"],
      [samePlace, dropPlaceLink(TUNJA, "co-test-001-d001", "mentioned"), "dp-1"],
    ];
    for (const [row, other, link] of cases) {
      const db = database();
      const before = snapshot(db);
      const { report, applied } = await run(db, [row, other], { header, apply: true });
      expect(report.outcome).toBe("refused");
      expect(reasons(report)).toMatch(new RegExp(`line 3: link ${link} is written by line 2, which finds it held`));
      expect(applied).toEqual([]);
      expect(snapshot(db)).toBe(before);
    }
  });

  it("refuses the row when the file merges away its entity or place", async () => {
    const { report } = await run(database(), [
      sameEntity,
      { op: "merge-entity", authority_code: AA.code, authority_name: AA.name, target_codes: BB.code, label_to_keep: BB.name },
      samePlace,
      { op: "merge-place", authority_code: TUNJA.code, authority_name: TUNJA.label, target_codes: TUNXA.code, label_to_keep: TUNXA.label },
    ], { header });
    const r = reasons(report);
    expect(r).toMatch(/line 2: ne-aaaaaa is merged by line 3/);
    expect(r).toMatch(/line 4: nl-tttttt is merged by line 5/);
  });
});

describe("a split as one file", () => {
  it("of a place: create-place, move-place-link, update-place", async () => {
    const db = database();
    const rows = [
      movePlaceLink(TUNXA, "co-test-001-d002", "venue", "new:k-hunza"),
      updatePlace(TUNXA, { name_variants_remove: "Hunza", notes: "Split from Hunza" }),
      createPlace("k-hunza", "Hunza", { place_type: "town", hgis_id: "hg-1" }),
    ];
    const dry = await run(db, rows);
    expect(reasons(dry.report)).toBe("");
    await appliesAndReruns(db, rows, ["already moved link", "already updated", "already created"]);
    const hunza = one(db, "SELECT * FROM places WHERE label = 'Hunza'");
    expect(one(db, "SELECT place_id FROM description_places WHERE id = 'dp-3'").place_id).toBe(hunza.id);
    expect(one(db, `SELECT name_variants, notes FROM places WHERE id = '${TUNXA.id}'`)).toEqual({ name_variants: "[]", notes: "Split from Hunza" });
  });

  it("of an entity: create-entity, move-link, update-entity", async () => {
    const db = database();
    const rows = [
      moveLink(AA, "co-test-001-d002", "witness", "new:k-juana"),
      { op: "create-entity", new_key: "k-juana", display_name: "Juana Díaz la menor", sort_name: "Díaz, Juana", entity_type: "person" },
      { op: "update-entity", authority_code: AA.code, authority_name: AA.name, display_name: "Juana Díaz la mayor", current_name: AA.name },
    ];
    await appliesAndReruns(db, rows, ["already moved link", "already created", "already updated"]);
    const juana = one(db, "SELECT * FROM entities WHERE display_name = 'Juana Díaz la menor'");
    expect(one(db, "SELECT entity_id FROM description_entities WHERE id = 'de-2'").entity_id).toBe(juana.id);
    expect(one(db, `SELECT display_name FROM entities WHERE id = '${AA.id}'`).display_name).toBe("Juana Díaz la mayor");
  });
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Review round: reruns, reversals and ownership
// ---------------------------------------------------------------------------

describe("reruns and reversals", () => {
  const merge = () => mergePlace(TUNXA, TUNJA, { name_variants_add: "Tunxa | Hunza" });

  it("changes a parent to another place and to NULL, each verified and rerun clean", async () => {
    for (const [to, after] of [[SOGA.code, SOGA.id], ["NULL", null]] as const) {
      const db = database();
      db.exec(`UPDATE places SET parent_id = '${LEIVA.id}' WHERE id = '${TUNXA.id}'`);
      await appliesAndReruns(db, [updatePlace(TUNXA, { parent: to, current_parent: LEIVA.code })], ["already updated"]);
      expect(one(db, `SELECT parent_id FROM places WHERE id = '${TUNXA.id}'`).parent_id).toBe(after);
    }
    const db = database();
    db.exec(`UPDATE places SET parent_id = '${LEIVA.id}' WHERE id = '${TUNXA.id}'`);
    const { report } = await run(db, [updatePlace(TUNXA, { parent: SOGA.code, current_parent: TUNJA.code })]);
    expect(reasons(report)).toMatch(/current_parent "nl-tttttt" is not the stored "nl-llllll"/);
  });

  it("refuses to merge again a pair this file merged and that has since been undone", async () => {
    const db = database();
    await run(db, [merge()], { apply: true });
    db.exec(`UPDATE places SET merged_into = NULL WHERE id = '${TUNXA.id}'`);
    const { report } = await run(db, [merge()]);
    expect(reasons(report)).toMatch(/line 2: nl-xxxxxx was merged into nl-tttttt by this file and since undone/);
  });

  it("is not done when links have come back to the loser", async () => {
    const db = database();
    await run(db, [merge()], { apply: true });
    db.exec(`INSERT INTO description_places VALUES ('dp-back', 'd3', '${TUNXA.id}', 'venue', NULL, NULL, 3)`);
    const { report } = await run(db, [merge()]);
    expect(reasons(report)).toMatch(/nl-xxxxxx is merged into nl-tttttt, and holds links of the tenant's descriptions again \(dp-back\)/);
  });

  it("is not done when the survivor holds again a variant the row removes", async () => {
    const db = database();
    const rows = [mergePlace(TUNXA, TUNJA, { name_variants_add: "Tunxa", name_variants_remove: "Hunza" })];
    await run(db, rows, { apply: true });
    expect(JSON.parse(one(db, `SELECT name_variants FROM places WHERE id = '${TUNJA.id}'`).name_variants)).not.toContain("Hunza");
    db.exec(`UPDATE places SET name_variants = '["Tunxa de Boyacá","Tunxa","Hunza"]' WHERE id = '${TUNJA.id}'`);
    const { report } = await run(db, rows);
    expect(reasons(report)).toMatch(/whose variants hold \["Hunza"\], which the row removes/);
  });

  it("is not done for a drop when the link's id is anywhere again", async () => {
    const db = database();
    const rows = [dropPlaceLink(LEIVA, "co-test-001-d003", "mentioned")];
    await run(db, rows, { apply: true });
    db.exec(`INSERT INTO description_places VALUES ('dp-6', 'd1', '${LEIVA.id}', 'mentioned', NULL, NULL, 3)`);
    const { report } = await run(db, rows);
    expect(reasons(report)).toMatch(/records the removal of link dp-6, which is still there/);
    const entity = database();
    const drop = [dropLink(AA, "co-test-001-d003", "plaintiff")];
    await run(entity, drop, { apply: true });
    entity.exec("INSERT INTO description_entities (id, description_id, entity_id, role, sequence, created_at) VALUES ('de-4', 'd2', 'e-c', 'witness', 0, 3)");
    expect(reasons((await run(entity, drop)).report)).toMatch(/records the removal of link de-4, which is still there/);
  });

  it("sets the survivor's display name to label_to_keep when only the display name differs", async () => {
    const db = database();
    db.exec(`UPDATE places SET display_name = 'Tunja (Boyacá)' WHERE id = '${TUNJA.id}'`);
    await appliesAndReruns(db, [mergePlace(TUNXA, TUNJA, { label_to_keep: "Tunja", name_variants_add: "Tunxa | Hunza" })], ["already merged"]);
    expect(one(db, `SELECT label, display_name FROM places WHERE id = '${TUNJA.id}'`)).toEqual({ label: "Tunja", display_name: "Tunja" });
  });

  it("counts a row done when the field it adds is restated unchanged, and refuses one whose stated value is not stored or recorded", async () => {
    const db = database();
    await run(db, [updatePlace(TUNXA, { tgn_id: "1009", current_tgn_id: "1001" })], { apply: true });
    // The hgis id the place already held, restated at its current value: no evidence needed.
    const restated = await run(db, [updatePlace(TUNXA, { tgn_id: "1009", current_tgn_id: "1001", hgis_id: "hg-1", current_hgis_id: "hg-1" })]);
    expect(restated.report.rows.map((r) => r.status)).toEqual(["already updated"]);
    // A field the row changes (whg_id from w-9) that the changelog row of this file does not record changing.
    const { report } = await run(db, [updatePlace(TUNXA, { tgn_id: "1009", current_tgn_id: "1001", whg_id: "w-9", current_whg_id: "w-0" })]);
    expect(reasons(report)).toMatch(/line 2: current_whg_id "w-0" is not the stored "w-9"/);
  });

  it("needs no evidence for a field the row restates unchanged: a latitude beside a changed longitude", async () => {
    const db = database();
    await appliesAndReruns(db, [updatePlace(TUNXA, { latitude: "5.53", current_latitude: "5.53", longitude: "-73.4", current_longitude: "-73.36" })], ["already updated"]);
    expect(one(db, `SELECT latitude, longitude FROM places WHERE id = '${TUNXA.id}'`)).toEqual({ latitude: 5.53, longitude: -73.4 });
  });

  it("needs no evidence for an entity's display name restated unchanged beside a changed sort name", async () => {
    const db = database();
    await appliesAndReruns(db, [{ op: "update-entity", authority_code: AA.code, authority_name: AA.name, display_name: AA.name, sort_name: "Díaz, Juana" }], ["already updated"]);
    expect(one(db, `SELECT display_name, sort_name FROM entities WHERE id = '${AA.id}'`)).toEqual({ display_name: AA.name, sort_name: "Díaz, Juana" });
  });

  it("needs no evidence for an entity type restated unchanged beside a changed display name", async () => {
    const db = database();
    const row = { op: "update-entity", authority_code: AA.code, authority_name: AA.name, display_name: "Juana Díaz de Tunja", current_name: AA.name, entity_type: "person" };
    await appliesAndReruns(db, [row], ["already updated"]);
    expect(one(db, `SELECT display_name, entity_type FROM entities WHERE id = '${AA.id}'`)).toEqual({ display_name: "Juana Díaz de Tunja", entity_type: "person" });
  });

  it("needs no evidence for a primary function restated as NULL beside a changed display name", async () => {
    const db = database();
    const row = { op: "update-entity", authority_code: AA.code, authority_name: AA.name, display_name: "Juana Díaz de Tunja", current_name: AA.name, primary_function: "NULL" };
    await appliesAndReruns(db, [row], ["already updated"]);
    expect(one(db, `SELECT display_name, primary_function FROM entities WHERE id = '${AA.id}'`)).toEqual({ display_name: "Juana Díaz de Tunja", primary_function: null });
  });

  it("needs no evidence for a variant added that the place already holds, beside a changed field", async () => {
    const db = database();
    await appliesAndReruns(db, [updatePlace(TUNXA, { notes: "Pueblo", name_variants_add: "Hunza" })], ["already updated"]);
    expect(one(db, `SELECT notes, name_variants FROM places WHERE id = '${TUNXA.id}'`)).toEqual({ notes: "Pueblo", name_variants: '["Hunza"]' });
  });

  describe("update-entity evidence tied to the file", () => {
    const header = [...HEADER, "surname", "dates_of_existence"];
    const entity = (over: Cells): Cells => ({ op: "update-entity", authority_code: AA.code, authority_name: AA.name, ...over });
    const TUNJA_NAME = "Juana Díaz de Tunja";

    it("writes its changelog row under an id made from the tenant, the file and the record, and reruns clean", async () => {
      const db = database();
      await appliesAndReruns(db, [entity({ display_name: TUNJA_NAME, current_name: AA.name, sort_name: "Díaz de Tunja, Juana" })], ["already updated"], { header });
      const id = await newRecordId(FED, TENANT, FILE, AA.id, ENTITY_UPDATE_JOURNAL_NAMESPACE);
      expect(all(db, `SELECT id FROM changelog WHERE record_id = '${AA.id}'`).map((r) => r.id)).toEqual([id]);
    });

    it("refuses a row given a field without a stated value after it was applied: sort_name, then surname", async () => {
      const db = database();
      expect((await run(db, [entity({ sort_name: "Díaz, Juana" })], { header, apply: true })).report.outcome).toBe("verified");
      const before = snapshot(db);
      const { report, applied } = await run(db, [entity({ sort_name: "Díaz, Juana", surname: "Díaz" })], { header, apply: true });
      expect(applied).toEqual([]);
      expect(report.outcome).toBe("refused");
      expect(reasons(report)).toMatch(/line 2 was applied before and has changed since: put new changes in a new file \(part of its effect is present/);
      expect(snapshot(db)).toBe(before);
    });

    it("does not take another file's changelog row as this file's evidence", async () => {
      const db = database();
      await run(db, [entity({ display_name: TUNJA_NAME, current_name: AA.name })], { header, apply: true });
      // Under another name the file has no evidence: a row the record holds is same, never done.
      const renamed = await run(db, [entity({ authority_name: TUNJA_NAME, display_name: TUNJA_NAME })], { header, file: "renamed.csv" });
      expect(reasons(renamed.report)).toBe("");
      expect(renamed.report.rows.map((r) => r.status)).toEqual(["same"]);
      const other = await run(db, [entity({ authority_name: TUNJA_NAME, dates_of_existence: "fl. 1620" })], { header, file: "other.csv", apply: true });
      expect(other.report.outcome).toBe("verified");
      // The first file, edited to give the dates the other file wrote: its own row records no change of dates.
      const edited = await run(db, [entity({ display_name: TUNJA_NAME, current_name: AA.name, dates_of_existence: "fl. 1620" })], { header, apply: true });
      expect(edited.applied).toEqual([]);
      expect(edited.report.rows.map((r) => r.status)).toEqual(["refused"]);
      expect(reasons(edited.report)).toMatch(/line 2: current_dates "" is not the stored "fl. 1620"/);
    });

    it("reports a row applied before the changelog id was made from the file as same, never done", async () => {
      const db = database();
      const rows = [entity({ display_name: TUNJA_NAME, current_name: AA.name, sort_name: "Díaz de Tunja, Juana" })];
      await run(db, rows, { header, apply: true });
      // An older run's changelog row: a random id.
      db.exec(`UPDATE changelog SET id = '9a9a9a9a-0000-4000-8000-000000000001' WHERE record_id = '${AA.id}'`);
      // A rename: without this file's changelog row the old name is not the stored one, so the row is refused.
      const { report, applied } = await run(db, rows, { header, apply: true });
      expect(applied).toEqual([]);
      expect(reasons(report)).toMatch(/line 2: authority_name "Juana Díaz" is not the stored name "Juana Díaz de Tunja"/);
      // A row that names the stored values: same, nothing written, never done.
      const plain = [entity({ authority_name: TUNJA_NAME, sort_name: "Díaz de Tunja, Juana" })];
      const again = await run(db, plain, { header, apply: true });
      expect(again.applied).toEqual([]);
      expect(again.report.outcome).toBe("nothing to write");
      expect(again.report.rows.map((r) => r.status)).toEqual(["same"]);
    });

    it("applies a fresh file with a row its record already holds beside one that writes, and reruns it clean", async () => {
      const db = database();
      db.exec(`UPDATE entities SET sort_name = 'Díaz, Diego' WHERE id = '${BB.id}'`);
      const rows = [
        entity({ sort_name: "Díaz, Juana" }),
        { op: "update-entity", authority_code: BB.code, authority_name: BB.name, sort_name: "Díaz, Diego" },
      ];
      const first = await run(db, rows, { header, apply: true });
      expect(reasons(first.report)).toBe("");
      expect(first.report.outcome).toBe("verified");
      expect(first.report.rows.map((r) => r.status)).toEqual(["update", "same"]);
      expect(all(db, `SELECT record_id FROM changelog`).map((r) => r.record_id)).toEqual([AA.id]);
      const after = snapshot(db);
      const again = await run(db, rows, { header, apply: true });
      expect(reasons(again.report)).toBe("");
      expect(again.report.outcome).toBe("nothing to write");
      expect(again.applied).toEqual([]);
      expect(again.report.rows.map((r) => r.status)).toEqual(["already updated", "same"]);
      expect(snapshot(db)).toBe(after);
    });

    it("still verifies a restated unchanged field beside a changed one, and a variant added", async () => {
      const db = database();
      await appliesAndReruns(db, [entity({ display_name: AA.name, current_name: AA.name, sort_name: "Díaz, Juana", name_variants_add: "Joana Díaz" })], ["already updated"], { header });
    });
  });

  it("refuses a rerun whose current value is not the one the changelog records the change from", async () => {
    const db = database();
    await run(db, [updatePlace(TUNXA, { tgn_id: "1009", current_tgn_id: "1001" })], { apply: true });
    const { report } = await run(db, [updatePlace(TUNXA, { tgn_id: "1009", current_tgn_id: "1009" })]);
    expect(reasons(report)).toMatch(/records tgn_id changing from "1001", not from the row's "1009"/);
  });

  it("refuses an update row given a field after it was applied", async () => {
    const db = database();
    await run(db, [updatePlace(TUNJA, { notes: "x" })], { apply: true });
    const { report, applied } = await run(db, [updatePlace(TUNJA, { notes: "x", tgn_id: "77" })], { apply: true });
    expect(applied).toEqual([]);
    expect(reasons(report)).toMatch(/line 2 was applied before and has changed since: put new changes in a new file \(part of its effect is present/);
  });

  it("refuses a copy-function row given a target after it was applied", async () => {
    const db = database();
    db.exec(`INSERT INTO entity_functions (id, entity_id, function, created_at, updated_at) VALUES ('f-1', '${AA.id}', 'Vecina', 1, 1)`);
    const header = [...HEADER, "function_id", "function"];
    const copy = (targets: string): Cells => ({ op: "copy-function", authority_code: AA.code, authority_name: AA.name, function_id: "f-1", function: "Vecina", target_codes: targets });
    expect((await run(db, [copy(BB.code)], { header, apply: true })).report.outcome).toBe("verified");
    const { report, applied } = await run(db, [copy(`${BB.code} ${CC.code}`)], { header, apply: true });
    expect(applied).toEqual([]);
    expect(reasons(report)).toMatch(/line 2 was applied before and has changed since: put new changes in a new file \(part of its effect is present: the row f-1 makes is already on ne-bbbbbb, not on ne-cccccc\)/);
  });

  it("refuses at plan a completed place link beside a drop of it", async () => {
    const db = database();
    const add = { op: "add-place-link", description_code: "co-test-001-d003", place: SOGA.code, role: "venue" };
    await run(db, [add], { apply: true });
    const { report, applied } = await run(db, [add, dropPlaceLink(SOGA, "co-test-001-d003", "venue")], { apply: true });
    expect(applied).toEqual([]);
    expect(reasons(report)).toMatch(/applied before and has changed since: put new changes in a new file \(line 2 is already place-linked; line 3 would drop link\)/);
  });

  it("refuses two merges into one survivor where one adds a variant the other removes", async () => {
    const { report } = await run(database(), [
      mergePlace(TUNXA, TUNJA, { name_variants_add: "Tunxa | Hunza | Villa de Leiva" }),
      mergePlace(LEIVA, TUNJA, { name_variants_remove: "Hunza" }),
    ]);
    expect(reasons(report)).toMatch(/line 2 adds "Hunza" to nl-tttttt and line 3 removes it; the rows contradict each other/);
  });

  it("leaves the old label out of the variants when the row removes it", async () => {
    const db = database();
    await appliesAndReruns(db, [mergePlace(TUNXA, TUNJA, { label_to_keep: "Tunja de Boyacá", name_variants_add: "Tunxa | Hunza", name_variants_remove: "Tunja" })], ["already merged"]);
    const s = one(db, `SELECT label, display_name, name_variants FROM places WHERE id = '${TUNJA.id}'`);
    expect(s).toMatchObject({ label: "Tunja de Boyacá", display_name: "Tunja de Boyacá" });
    expect(JSON.parse(s.name_variants)).toEqual(["Tunxa de Boyacá", "Tunxa", "Hunza"]);
  });

  it("refuses a label_to_keep the place schema refuses", async () => {
    const { report } = await run(database(), [mergePlace(TUNXA, TUNJA, { label_to_keep: "T".repeat(600), name_variants_add: "Tunxa | Hunza" })]);
    expect(reasons(report)).toMatch(/line 2: label_to_keep: label /);
  });

  it("refuses a link row naming a link a merge of the file repoints", async () => {
    const db = database();
    db.exec(`INSERT INTO entities (id, federation_id, tenant_id, entity_code, display_name, sort_name, entity_type, created_at, updated_at) VALUES ('e-d', '${FED}', NULL, 'ne-dddddd', 'Pedro Ruiz', 'Pedro Ruiz', 'person', 1, 5)`);
    const side = db.prepare("INSERT INTO description_entities (id, description_id, entity_id, role, sequence, created_at, related_to) VALUES (?, 'd1', ?, ?, 0, 3, ?)");
    side.run("de-r1", BB.id, "parent", "de-r1");
    side.run("de-r2", CC.id, "child", "de-r1");
    db.exec("UPDATE description_entities SET related_to = 'de-r2' WHERE id = 'de-r1'");
    // AA's side collides with BB's (same description, role and related_to), so the merge drops it and repoints de-r5.
    side.run("de-r3", AA.id, "parent", "de-r2");
    side.run("de-r5", "e-d", "child", "de-r3");
    const { report } = await run(db, [
      { op: "merge-entity", authority_code: AA.code, authority_name: AA.name, target_codes: BB.code, name_variants_add: AA.name, facts: "kin", evidence_codes: "co-test-001-d001" },
      moveLink({ code: "ne-dddddd", name: "Pedro Ruiz" }, "co-test-001-d001", "child", CC.code),
    ]);
    expect(reasons(report)).toMatch(/line 3: link de-r5 is written by the merge of line 2, which repoints its related_to/);
  });

  it("refuses an addition that names a record a merge row of the file merges, loser or survivor", async () => {
    const add = (place: string): Cells => ({ op: "add-place-link", description_code: "co-test-001-d003", place, role: "mentioned" });
    const { report } = await run(database(), [merge(), add(TUNXA.code), add(TUNJA.code)]);
    const r = reasons(report);
    expect(r).toMatch(/line 3: nl-xxxxxx is merged by line 2, so no other row may name it; link to the survivor in a separate file, or after the merge/);
    expect(r).toMatch(/line 4: nl-tttttt is merged by line 2, so no other row may name it; link to the survivor in a separate file, or after the merge/);
    const link = (entity: string): Cells => ({ op: "add-link", description_code: "co-test-001-d003", entity, role: "mentioned" });
    const entities = await run(database(), [
      { op: "merge-entity", authority_code: BB.code, authority_name: BB.name, target_codes: AA.code, name_variants_add: BB.name },
      link(BB.code), link(AA.code),
    ]);
    const e = reasons(entities.report);
    expect(e).toMatch(/line 3: ne-bbbbbb is merged by line 2, so no other row may name it; link to the survivor/);
    expect(e).toMatch(/line 4: ne-aaaaaa is merged by line 2, so no other row may name it; link to the survivor/);
  });
});

describe("guards", () => {
  const merge = () => mergePlace(TUNXA, TUNJA, { name_variants_add: "Tunxa | Hunza" });
  async function aborts(rows: Cells[], changed: (db: DatabaseSync) => void) {
    const db = database();
    let before = "";
    await expect(run(db, rows, { apply: true, beforeApply: (d) => { changed(d); before = snapshot(d); } })).rejects.toThrow(/ABORT|malformed JSON/);
    expect(before).not.toBe("");
    expect(snapshot(db)).toBe(before);
  }
  it("aborts a merge when a place changes between plan and apply", async () => {
    await aborts([mergePlace(TUNXA, TUNJA, { name_variants_add: "Tunxa | Hunza" })], (d) => d.exec(`UPDATE places SET whg_id = 'w-2' WHERE id = '${TUNJA.id}'`));
  });
  it("aborts a merge when a link is added to the loser", async () => {
    await aborts([mergePlace(TUNXA, TUNJA, { name_variants_add: "Tunxa | Hunza" })], (d) => d.exec(`INSERT INTO description_places VALUES ('dp-9', 'd3', '${TUNXA.id}', 'venue', NULL, NULL, 3)`));
  });
  it("aborts an update when the place changes", async () => {
    await aborts([updatePlace(TUNJA, { notes: "x" })], (d) => d.exec(`UPDATE places SET notes = 'y' WHERE id = '${TUNJA.id}'`));
  });
  it("aborts a link move when the link changes", async () => {
    await aborts([movePlaceLink(TUNXA, "co-test-001-d002", "venue", SOGA.code)], (d) => d.exec("UPDATE description_places SET role_note = 'x' WHERE id = 'dp-3'"));
  });
  it("aborts a link move when the description gains a link", async () => {
    await aborts([moveLink(AA, "co-test-001-d001", "witness", CC.code)], (d) => d.exec("INSERT INTO description_entities (id, description_id, entity_id, role, sequence, created_at) VALUES ('de-9', 'd1', 'e-c', 'witness', 0, 3)"));
  });
  it("aborts a merge when a loser's description and a survivor's change hands, the link counts unchanged", async () => {
    const swap = (d: DatabaseSync) => d.exec(`UPDATE descriptions SET tenant_id = CASE id WHEN 'd2' THEN 't-2' ELSE '${TENANT}' END WHERE id IN ('d2', 'd8')`);
    const db = database();
    db.exec("INSERT INTO descriptions VALUES ('d8', 't-2', 'co-other-d008')");
    db.exec(`INSERT INTO description_places VALUES ('dp-8', 'd8', '${TUNJA.id}', 'venue', NULL, NULL, 3)`);
    let before = "";
    await expect(run(db, [merge()], { apply: true, beforeApply: (d) => { swap(d); before = snapshot(d); } })).rejects.toThrow(/ABORT|malformed JSON/);
    expect(snapshot(db)).toBe(before);
  });
  it("refuses at plan a completed merge beside a new row, before anything is written", async () => {
    const db = database();
    await run(db, [merge()], { apply: true });
    const before = snapshot(db);
    const { report, applied } = await run(db, [merge(), createPlace("k", "Uno")], { apply: true });
    expect(applied).toEqual([]);
    expect(reasons(report)).toMatch(/this file was applied before and has changed since: put new changes in a new file \(line 2 is already merged; line 3 would create\)/);
    expect(snapshot(db)).toBe(before);
  });
  it("aborts a link move when its description changes hands", async () => {
    const db = database();
    let before = "";
    await expect(run(db, [movePlaceLink(TUNXA, "co-test-001-d002", "venue", SOGA.code)], {
      apply: true, beforeApply: (d) => { d.exec("UPDATE descriptions SET tenant_id = 't-2' WHERE id = 'd2'"); before = snapshot(d); },
    })).rejects.toThrow(/ABORT|malformed JSON/);
    expect(snapshot(db)).toBe(before);
  });
  const swapD2D9 = (d: DatabaseSync) => d.exec(`UPDATE descriptions SET tenant_id = CASE id WHEN 'd2' THEN 't-2' ELSE '${TENANT}' END WHERE id IN ('d2', 'd9')`);
  it("aborts an entity merge when the loser's description and another change hands, the link counts unchanged", async () => {
    const db = database();
    db.exec("INSERT INTO description_entities (id, description_id, entity_id, role, sequence, created_at) VALUES ('de-9', 'd9', 'e-c', 'witness', 0, 3)");
    // The target's link on one of the tenant's descriptions, which the merge cites as its evidence.
    db.exec("INSERT INTO description_entities (id, description_id, entity_id, role, sequence, created_at) VALUES ('de-10', 'd1', 'e-c', 'witness', 0, 3)");
    let before = "";
    await expect(run(db, [
      { op: "merge-entity", authority_code: BB.code, authority_name: BB.name, target_codes: CC.code, name_variants_add: BB.name, facts: "office", evidence_codes: "co-test-001-d002 co-test-001-d001" },
      createPlace("k", "Uno"),
    ], { apply: true, beforeApply: (d) => { swapD2D9(d); before = snapshot(d); } })).rejects.toThrow(/ABORT|malformed JSON/);
    expect(snapshot(db)).toBe(before);
    expect(one(db, "SELECT entity_id FROM description_entities WHERE id = 'de-3'").entity_id).toBe(BB.id);
  });
  it("finds an all-done file with a merged pair done, and writes nothing", async () => {
    // Under the rerun contract a file with a done row never writes, so no apply can reach the
    // constant guard on a merged loser; the guard stays, and this run shows the file writes nothing.
    const db = database();
    await run(db, [merge()], { apply: true });
    const again = await run(db, [merge()], { apply: true });
    expect(again.report.outcome).toBe("nothing to write");
    expect(again.report.rows.map((r) => r.status)).toEqual(["already merged"]);
  });
  it("refuses at plan a completed update beside a new row", async () => {
    const db = database();
    const update = updatePlace(TUNJA, { notes: "x" });
    await run(db, [update], { apply: true });
    const { report, applied } = await run(db, [update, createPlace("k", "Uno")], { apply: true });
    expect(applied).toEqual([]);
    expect(reasons(report)).toMatch(/applied before and has changed since/);
  });
  it("aborts a create when the place type list changes", async () => {
    await aborts([createPlace("k", "Uno", { place_type: "town" })], (d) => d.exec("UPDATE vocabulary_values SET status = 'pending' WHERE code = 'town'"));
  });
});

// ---------------------------------------------------------------------------
// How the actor acted, on every changelog row
// ---------------------------------------------------------------------------

describe("acted_as on the changelog", () => {
  /** `neogranadina` (t-1) leads fed-1 and `other` (t-2) is a member; a platform admin lives in `far` (t-3). */
  function federationDb(): DatabaseSync {
    const db = database();
    db.exec("ALTER TABLE tenants ADD COLUMN kind TEXT NOT NULL DEFAULT 'tenant'");
    db.exec("ALTER TABLE tenants ADD COLUMN status TEXT");
    db.exec("ALTER TABLE users ADD COLUMN is_platform_admin INTEGER DEFAULT 0");
    db.exec("INSERT INTO users (id, email, name, tenant_id, is_platform_admin) VALUES ('user_platform', 'platform@example.org', 'Platform', 't-3', 1)");
    db.exec(`INSERT INTO description_entities (id, description_id, entity_id, role, sequence, created_at) VALUES ('de-9', 'd9', '${BB.id}', 'witness', 0, 3)`);
    return db;
  }
  // A create, a merge with a link moved, an entity link added and one moved, all on the member's description d9.
  const memberRows = (): Cells[] => [
    createPlace("raq", "Ráquira"),
    mergePlace(TUNXA, TUNJA, { name_variants_add: "Tunxa | Hunza" }),
    { op: "add-link", description_code: "co-other-d009", entity: AA.code, role: "witness" },
    moveLink(BB, "co-other-d009", "witness", CC.code),
  ];
  const actedAs = (db: DatabaseSync) => all(db, "SELECT acted_as FROM changelog").map((r) => r.acted_as as string | null);

  it("lets the lead's admin move links on a member's descriptions, and refuses them shared creates and merges there", async () => {
    const db = federationDb();
    const moved = await run(db, [moveLink(BB, "co-other-d009", "witness", CC.code)], { apply: true, tenant: "other" });
    expect(reasons(moved.report)).toBe("");
    expect(moved.report.outcome).toBe("verified");
    expect(all(db, "SELECT acted_as FROM changelog").map((r) => r.acted_as)).toEqual(["lead-admin", "lead-admin"]);
    await expect(run(federationDb(), [createPlace("raq", "Ráquira")], { tenant: "other" })).rejects.toThrow(/is not a steward/);
    await expect(run(federationDb(), [mergePlace(TUNXA, TUNJA, { name_variants_add: "Tunxa | Hunza" })], { tenant: "other" }))
      .rejects.toThrow(/is not a steward/);
  });

  it("writes lead-admin on every changelog row of a lead admin's apply on a member", async () => {
    const db = federationDb();
    // A steward membership lets the file create and merge in the shared space.
    db.exec(`INSERT INTO federation_memberships VALUES ('m-1', 'user_001', '${FED}', 'steward')`);
    const { report } = await run(db, memberRows(), { apply: true, tenant: "other" });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    const kinds = all(db, "SELECT record_type, kind FROM changelog").map((r) => `${r.record_type}:${r.kind}`);
    expect(kinds).toEqual(expect.arrayContaining(["place:create", "place:update", "description:link", "description:unlink"]));
    expect(new Set(actedAs(db))).toEqual(new Set(["lead-admin"]));
  });

  it("writes platform-admin on every changelog row of a platform admin's apply, on the lead, where they are a steward", async () => {
    const db = federationDb();
    const rows: Cells[] = [
      createPlace("raq", "Ráquira"),
      mergePlace(TUNXA, TUNJA, { name_variants_add: "Tunxa | Hunza" }),
      { op: "add-link", description_code: "co-test-001-d003", entity: AA.code, role: "witness" },
      moveLink(BB, "co-test-001-d002", "witness", CC.code),
    ];
    const { report } = await run(db, rows, { apply: true, email: "platform@example.org" });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    expect(actedAs(db).length).toBeGreaterThan(4);
    expect(new Set(actedAs(db))).toEqual(new Set(["platform-admin"]));
  });

  it("writes NULL on every changelog row of a member's apply", async () => {
    const db = federationDb();
    const { report } = await run(db, [createPlace("raq", "Ráquira"), mergePlace(TUNXA, TUNJA, { name_variants_add: "Tunxa | Hunza" })], { apply: true });
    expect(report.outcome).toBe("verified");
    expect(actedAs(db).length).toBeGreaterThan(2);
    expect(new Set(actedAs(db))).toEqual(new Set([null]));
  });
});

// @version v0.9.0
