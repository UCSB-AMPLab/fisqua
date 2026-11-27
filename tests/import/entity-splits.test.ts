/**
 * Tests — record-field planning and helpers shared by the authorities engine
 *
 * This suite pins what `scripts/lib/entity-splits.ts` keeps now that the
 * entity-splits command is retired: `planRecordFields` (the plan of a row
 * that changes a stored entity's own fields), `readTerms` and
 * `termLookupGuards` (the term lookups of a primary function and their
 * guards), and the text helpers `text`, `blank`, `sameName` and
 * `sameNfc`. The authorities engine's own suites run these through whole
 * change files; the checks here are direct. `readTerms` and the guards run
 * against an in-memory `node:sqlite` database. Nothing here reaches D1.
 *
 *   - blank leaves a stored field, `NULL` clears it and is refused on a
 *     field a record cannot be without;
 *   - the variant columns exclude each other, and removal and addition
 *     change the stored list;
 *   - the `current_*` checks refuse a value the record does not hold, and
 *     accept a value the changelog shows a field had before;
 *   - the term pointer follows a changed function text;
 *   - the term lookups read the federation's live terms in any case, and
 *     their guards pass while the lookup holds and abort when it does not.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  RECORD_FIELDS,
  blank,
  planRecordFields,
  readTerms,
  sameName,
  sameNfc,
  termLookupGuards,
  text,
  type FileRow,
  type OriginalPlan,
  type RecordFieldsContext,
  type StoredEntity,
} from "../../scripts/lib/entity-splits";

const stored = (over: Partial<StoredEntity> = {}): StoredEntity => ({
  id: "e-1", federation_id: "fed-1", tenant_id: "t-1", entity_code: "ne-aaaaaa", display_name: "Juan Rodríguez", sort_name: "Rodríguez, Juan",
  surname: "Rodríguez", given_name: "Juan", entity_type: "person", honorific: null, primary_function: "Zapatero", primary_function_id: "term-zap",
  name_variants: JSON.stringify(["Juan Rodrigues", "J. Rodríguez"]), dates_of_existence: "fl. 1620", date_start: null, date_end: null,
  sources: null, merged_into: null, updated_at: 1,
  ...over,
});

const CELLS = [...RECORD_FIELDS, "current_name", "current_dates", "current_function", "name_variants_remove", "name_variants_add"];

function planOf(given: Record<string, string>): OriginalPlan {
  const cells = Object.fromEntries(CELLS.map((c) => [c, ""])) as Record<string, string>;
  const row: FileRow = { file: "originals.csv", line: 2, cells: { ...cells, ...given } };
  return { row, id: "e-1", status: "refused", set: {}, changes: {}, termsTouched: [], note: "" };
}

const NO_TERMS: RecordFieldsContext = { terms: new Map(), changedFrom: () => false, removedBefore: () => false };

function plan(given: Record<string, string>, e = stored(), ctx: Partial<RecordFieldsContext> = {}) {
  const p = planOf(given);
  const reasons: string[] = [];
  planRecordFields(p, e, { ...NO_TERMS, ...ctx }, (r) => reasons.push(r));
  return { p, reasons };
}

const CURRENT = { current_name: "Juan Rodríguez", current_dates: "fl. 1620", current_function: "Zapatero" };

describe("planRecordFields", () => {
  it("leaves a blank column's stored value and writes only the columns given", () => {
    const { p, reasons } = plan({ ...CURRENT, honorific: "Don" });
    expect(reasons).toEqual([]);
    expect(p.status).toBe("update");
    expect(p.set).toEqual({ honorific: "Don" });
    expect(p.changes.honorific).toEqual({ old: null, new: "Don" });
  });

  it("reports a row the record already holds as already updated", () => {
    const { p, reasons } = plan({ ...CURRENT, honorific: "Don" }, stored({ honorific: "Don" }));
    expect(reasons).toEqual([]);
    expect(p.status).toBe("already updated");
    expect(p.set).toEqual({});
  });

  it("clears a field given as NULL, over a stored empty string too, and the term pointer of a cleared function", () => {
    const a = plan({ ...CURRENT, dates_of_existence: "NULL" });
    expect(a.p.set).toEqual({ datesOfExistence: null });
    const b = plan({ ...CURRENT, honorific: "NULL" }, stored({ honorific: "" }));
    expect(b.p.set).toEqual({ honorific: null });
    const c = plan({ ...CURRENT, primary_function: "NULL" });
    expect(c.p.set).toEqual({ primaryFunction: null, primaryFunctionId: null });
    expect(c.p.termsTouched).toEqual(["term-zap"]);
  });

  it("refuses NULL on a field a record cannot be without, and a lower-case null is text", () => {
    expect(plan({ ...CURRENT, sort_name: "NULL" }).reasons).toEqual(["sort_name cannot be NULL"]);
    expect(plan({ ...CURRENT, name_variants: "NULL" }).reasons).toEqual(["name_variants cannot be NULL"]);
    expect(plan({ ...CURRENT, honorific: "null" }).p.set).toEqual({ honorific: "null" });
  });

  it("refuses name_variants together with name_variants_remove or name_variants_add", () => {
    const list = JSON.stringify(["X"]);
    expect(plan({ ...CURRENT, name_variants: list, name_variants_remove: "J. Rodríguez" }).reasons).toEqual([
      "the row gives both name_variants and name_variants_remove",
    ]);
    expect(plan({ ...CURRENT, name_variants: list, name_variants_add: "Y" }).reasons).toEqual([
      "the row gives both name_variants and name_variants_add",
    ]);
  });

  it("removes the variants named, adds new ones, and refuses one the record does not hold", () => {
    const removed = plan({ ...CURRENT, name_variants_remove: "J. Rodríguez" });
    expect(JSON.parse(String(removed.p.set.nameVariants))).toEqual(["Juan Rodrigues"]);
    const added = plan({ ...CURRENT, name_variants_add: "Juan Rodriguez | Juan Rodrigues" });
    expect(JSON.parse(String(added.p.set.nameVariants))).toEqual(["Juan Rodrigues", "J. Rodríguez", "Juan Rodriguez"]);
    expect(plan({ ...CURRENT, name_variants_remove: "Nobody" }).reasons[0]).toContain('name_variants_remove names "Nobody"');
    expect(plan({ ...CURRENT, name_variants_remove: "Nobody" }, stored(), { removedBefore: () => true }).reasons).toEqual([]);
  });

  it("refuses a current value the record does not hold", () => {
    const { reasons } = plan({ ...CURRENT, current_name: "Pedro", honorific: "Don" });
    expect(reasons).toEqual(['current_name "Pedro" is not the stored "Juan Rodríguez"']);
  });

  it("accepts the value a field had before when the changelog shows the change, on a row already applied", () => {
    const e = stored({ display_name: "Juan Rodríguez Gil" });
    const given = { ...CURRENT, current_name: "Juan Rodríguez", display_name: "Juan Rodríguez Gil" };
    expect(plan(given, e).reasons).toHaveLength(1);
    const { p, reasons } = plan(given, e, { changedFrom: (k, from, to) => k === "displayName" && from === "Juan Rodríguez" && to === "Juan Rodríguez Gil" });
    expect(reasons).toEqual([]);
    expect(p.status).toBe("already updated");
  });

  it("points a changed function at the one live term of the new text, or at none, and refuses two", () => {
    const one = plan({ ...CURRENT, primary_function: "Alférez" }, stored(), { terms: new Map([["Alférez", ["term-alf"]]]) });
    expect(one.p.set).toEqual({ primaryFunction: "Alférez", primaryFunctionId: "term-alf" });
    expect(one.p.termsTouched.sort()).toEqual(["term-alf", "term-zap"]);
    const none = plan({ ...CURRENT, primary_function: "Alférez" });
    expect(none.p.set).toEqual({ primaryFunction: "Alférez", primaryFunctionId: null });
    const two = plan({ ...CURRENT, primary_function: "Alférez" }, stored(), { terms: new Map([["Alférez", ["a", "b"]]]) });
    expect(two.reasons).toEqual(['primary_function "Alférez" names 2 terms of the federation']);
  });
});

function termsDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE vocabulary_terms (id TEXT PRIMARY KEY, federation_id TEXT, canonical TEXT, merged_into TEXT);
    INSERT INTO vocabulary_terms VALUES ('t-zap','fed-1','Zapatero',NULL),('t-alf','fed-1','alférez',NULL),('t-old','fed-1','Alférez','t-alf'),('t-other','fed-2','Zapatero',NULL);`);
  return db;
}
const readerOf = (db: DatabaseSync) => async (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];

describe("readTerms", () => {
  it("finds the federation's live terms of a text in any case, skips merged and other federations' terms, and omits a text with none", async () => {
    const terms = await readTerms(readerOf(termsDb()), ["Zapatero", "Alférez", "Sastre"], "fed-1");
    expect([...terms.entries()]).toEqual([["Zapatero", ["t-zap"]], ["Alférez", ["t-alf"]]]);
  });
});

describe("termLookupGuards", () => {
  const passes = (db: DatabaseSync, sql: string) => db.prepare(sql).get() as { guard: unknown };

  it("passes while each lookup holds and aborts when a term is renamed or a second one appears", () => {
    const db = termsDb();
    const lookups = new Map<string, string | null>([["Zapatero", "t-zap"], ["Alférez", "t-alf"], ["Sastre", null]]);
    const [g] = termLookupGuards(lookups, "fed-1");
    expect(passes(db, g).guard).toBe(1);
    db.exec(`INSERT INTO vocabulary_terms VALUES ('t-zap2','fed-1','ZAPATERO',NULL)`);
    expect(() => passes(db, g)).toThrow(/malformed JSON/);
  });

  it("aborts when a term appears for a text the lookup found none for, and when the term found is renamed", () => {
    const db = termsDb();
    const [g] = termLookupGuards(new Map([["Sastre", null]]), "fed-1");
    expect(passes(db, g).guard).toBe(1);
    db.exec(`INSERT INTO vocabulary_terms VALUES ('t-sas','fed-1','Sastre',NULL)`);
    expect(() => passes(db, g)).toThrow(/malformed JSON/);
    const [h] = termLookupGuards(new Map([["Zapatero", "t-zap"]]), "fed-1");
    db.exec(`UPDATE vocabulary_terms SET canonical = 'Cordonero' WHERE id = 't-zap'`);
    expect(() => passes(db, h)).toThrow(/malformed JSON/);
  });

  it("packs a hundred lookups to a statement", () => {
    const lookups = new Map<string, string | null>(Array.from({ length: 250 }, (_, i) => [`f${i}`, null]));
    expect(termLookupGuards(lookups, "fed-1")).toHaveLength(3);
  });
});

describe("the text helpers", () => {
  it("text gives '' for null and undefined, and blank is true for null, undefined and ''", () => {
    expect(text(null)).toBe("");
    expect(text(undefined)).toBe("");
    expect(text(0)).toBe("0");
    expect(blank(null)).toBe(true);
    expect(blank("")).toBe(true);
    expect(blank(0)).toBe(false);
  });

  it("sameName compares after NFC and trimming, and sameNfc treats '' and null alike", () => {
    expect(sameName("José ", "José")).toBe(true);
    expect(sameName("José", "Jose")).toBe(false);
    expect(sameNfc(null, "")).toBe(true);
    expect(sameNfc("José", "José")).toBe(true);
    expect(sameNfc("a", null)).toBe(false);
  });

  it("RECORD_FIELDS names the entity record's fields", () => {
    expect(RECORD_FIELDS).toContain("display_name");
    expect(RECORD_FIELDS).toContain("name_variants");
  });
});
