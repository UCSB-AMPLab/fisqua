/**
 * Scripts — record-field planning and helpers shared by the authorities engine
 *
 * This module began as the engine of the entity-splits command, which
 * took apart person authorities that each held several people. That
 * command is retired: a split is now written as an authorities change
 * file (create-entity, move-link and update-entity rows) and run by the
 * command-line engine in `scripts/lib/authorities-cli/`. What stays here
 * is the code that engine imports:
 *
 * - `planRecordFields`, with `RecordFieldsContext`, `OriginalPlan`,
 *   `StoredEntity`, `ENTITY_READ` and `FileRow`: plans a row that changes
 *   a stored entity's own fields. A blank column leaves the stored value,
 *   the literal `NULL` clears it (writing SQL NULL over a stored `''`
 *   too), and `NULL` on a field a record cannot be without
 *   (`display_name`, `sort_name`, `entity_type`, `name_variants`) is
 *   refused. `name_variants` may not be given with
 *   `name_variants_remove` or `name_variants_add`; the `current_*`
 *   columns check the stored name, dates and function, and may name the
 *   value a field had before when the changelog holds that change (a
 *   rerun).
 * - `readTerms` and `termLookupGuards`: the federation's live terms of a
 *   primary-function text, and the guards that a lookup still finds what
 *   it found.
 * - `RECORD_FIELDS`, `text`, `blank`, `sameName` and `sameNfc`: the
 *   entity record's field names and the text comparisons the engine
 *   shares.
 *
 * Used by `change-file.ts`, `plan.ts`, `statements.ts`, `link-moves.ts`,
 * `places.ts`, `additions.ts` and `run.ts` in
 * `scripts/lib/authorities-cli/`, and tested in
 * `tests/import/entity-splits.test.ts`.
 *
 * @version v0.9.0
 */

import { ENTITY_RECORD, PLACE_RECORD, recordValuesOf, type RowReader } from "./authority-links";
import { chunks, guard } from "./authority-merges";
import { parseVariants } from "../../app/lib/pair-merge.server";
import { escapeSql } from "./sql";

/** The record fields of a new entity, as `recordValuesOf` reads them. */
export const RECORD_FIELDS = ENTITY_RECORD as readonly string[];

export interface FileRow {
  /** The file's name, without its folder. */
  file: string;
  /** The row's line, counting the header as 1. */
  line: number;
  cells: Record<string, string>;
}


/** Entity columns read, compared as stored in the opening guards. */
export const ENTITY_READ = [
  "id", "federation_id", "tenant_id", "entity_code", "display_name", "sort_name", "surname", "given_name", "entity_type", "honorific",
  "primary_function", "primary_function_id", "name_variants", "dates_of_existence", "date_start", "date_end", "sources", "merged_into",
  "updated_at",
] as const;

export type StoredEntity = Record<(typeof ENTITY_READ)[number], string | number | null>;


export const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));
export const blank = (v: unknown) => v === null || v === undefined || v === "";
export const sameName = (a: string, b: string) => a.normalize("NFC").trim() === b.normalize("NFC").trim();
/** Two optional text values, `''` and NULL alike. */
const sameText = (a: unknown, b: unknown) => (blank(a) ? "" : String(a)) === (blank(b) ? "" : String(b));
/** As `sameText`, after NFC. */
export const sameNfc = (a: unknown, b: unknown) => sameText(blank(a) ? "" : String(a).normalize("NFC"), blank(b) ? "" : String(b).normalize("NFC"));


/** Each function text → the live terms of the federation of that name, in any case; a text with none is absent. */
export async function readTerms(rows: RowReader, functions: string[], federationId: string): Promise<Map<string, string[]>> {
  const terms = new Map<string, string[]>();
  for (const part of chunks([...new Set(functions)], 100)) {
    const found = await rows(
      `SELECT g.column1 AS given, t.id AS id FROM (VALUES ${part.map((f) => `(${escapeSql(f)})`).join(", ")}) g ` +
        `JOIN vocabulary_terms t ON LOWER(t.canonical) = LOWER(g.column1) ` +
        `WHERE t.federation_id = ${escapeSql(federationId)} AND t.merged_into IS NULL`,
    );
    for (const f of found) terms.set(String(f.given), [...(terms.get(String(f.given)) ?? []), String(f.id)]);
  }
  return terms;
}


export interface OriginalPlan {
  row: FileRow;
  id: string;
  status: "update" | "already updated" | "refused";
  /** Drizzle key → new value, for the fields that change. */
  set: Record<string, unknown>;
  changes: Record<string, { old: unknown; new: unknown }>;
  termsTouched: string[];
  note: string;
}

const COLUMN_OF: Record<string, string> = {
  displayName: "display_name", nameVariants: "name_variants", sortName: "sort_name", surname: "surname", givenName: "given_name",
  entityType: "entity_type", honorific: "honorific", primaryFunction: "primary_function", primaryFunctionId: "primary_function_id",
  datesOfExistence: "dates_of_existence", dateStart: "date_start", dateEnd: "date_end",
};

/** The originals file's value that clears a field. */
const NULL = "NULL";
/** Fields a record cannot be without: NULL on one of them is refused. */
const NOT_NULL = new Set(["display_name", "sort_name", "entity_type", "name_variants"]);
/** The fields the schema requires, filled from the stored record when the row leaves them blank. */
const REQUIRED = ["display_name", "sort_name", "entity_type"];
/** File column → Drizzle key. */
const KEY_OF: Record<string, string> = Object.fromEntries(Object.entries(COLUMN_OF).map(([k, c]) => [c, k]));



/** The record fields of a row, as a cell set `recordValuesOf` reads. */
const recordCells = (c: Record<string, string>) =>
  Object.fromEntries([...RECORD_FIELDS, ...PLACE_RECORD].map((k) => [k, RECORD_FIELDS.includes(k) ? (c[k] ?? "") : ""]));

/** What planning a row of record fields reads besides the record. */
export interface RecordFieldsContext {
  /** A primary function's text → the live terms of the federation of that name, in any case. */
  terms: Map<string, string[]>;
  /** Whether the changelog records an update of `key` on the record from `from` to `to`. */
  changedFrom: (key: string, from: unknown, to: unknown) => boolean;
  /** Whether the variants a row removes that the record does not hold count as removed (the file was applied). */
  removedBefore: (absent: string[]) => boolean;
}

/**
 * Plans a row that changes a record's own fields (`RECORD_FIELDS`, with
 * `name_variants_remove`, `name_variants_add` and the `current_*`
 * checks) against the stored record: fills `plan.set`, `plan.changes`
 * and `plan.termsTouched`, and sets `plan.status` to "update" or
 * "already updated", or leaves it "refused" after calling `refuse`. A row
 * whose cells lack `name_variants_add` adds none.
 */
export function planRecordFields(plan: OriginalPlan, e: StoredEntity, ctx: RecordFieldsContext, refuse: (reason: string) => void): void {
  const c = plan.row.cells;
  const add = (c.name_variants_add ?? "").split(" | ").map((v) => v.trim()).filter(Boolean);
  // Only the columns given are compared and written: blank leaves the
  // stored value, NULL clears it.
  const given = RECORD_FIELDS.filter((k) => c[k] !== "");
  const cannot = given.find((k) => c[k] === NULL && NOT_NULL.has(k));
  if (cannot) {
    refuse(`${cannot} cannot be NULL`);
    return;
  }
  if (c.name_variants !== "" && c.name_variants_remove !== "") {
    refuse("the row gives both name_variants and name_variants_remove");
    return;
  }
  if (add.length > 0 && c.name_variants !== "") {
    refuse("the row gives both name_variants and name_variants_add");
    return;
  }
  const twice = add.find((v) => (c.name_variants_remove ?? "").split(" | ").map((x) => x.trim()).includes(v));
  if (twice) {
    refuse(`name_variants_add and name_variants_remove both name ${JSON.stringify(twice)}`);
    return;
  }
  // The schema checks the columns given, with the stored values of the
  // ones a record cannot be without.
  const cells: Record<string, string> = {};
  for (const k of RECORD_FIELDS) cells[k] = given.includes(k) ? (c[k] === NULL ? "" : c[k]) : REQUIRED.includes(k) ? text(e[k as keyof StoredEntity]) : "";
  const values = recordValuesOf("entity", recordCells(cells) as never);
  if (typeof values === "string") {
    refuse(values);
    return;
  }
  const after: Record<string, unknown> = {};
  for (const k of given) after[KEY_OF[k]] = c[k] === NULL ? null : values[KEY_OF[k]];
  if (c.name_variants_remove !== "") {
    const remove = c.name_variants_remove.split(" | ").map((v) => v.trim()).filter(Boolean);
    const stored = parseVariants(blank(e.name_variants) ? null : String(e.name_variants));
    // A rerun of an applied file finds the variants already off.
    const absent = remove.filter((v) => !stored.includes(v));
    if (absent.length > 0 && !ctx.removedBefore(absent)) {
      refuse(`name_variants_remove names ${JSON.stringify(absent[0])}, which the stored name_variants do not hold`);
      return;
    }
    const next = stored.filter((v) => !remove.includes(v));
    if (next.length !== stored.length) after.nameVariants = JSON.stringify(next);
  }
  if (add.length > 0) {
    const stored = "nameVariants" in after ? parseVariants(String(after.nameVariants)) : parseVariants(blank(e.name_variants) ? null : String(e.name_variants));
    const next = [...stored, ...add.filter((v, i) => !stored.includes(v) && add.indexOf(v) === i)];
    if (next.length !== stored.length) after.nameVariants = JSON.stringify(next);
  }
  // The fields that change. A value given compares with the stored one,
  // '' and NULL alike, and a NULL list of variants as `[]`; NULL given
  // matches only SQL NULL, so it clears a stored ''.
  for (const [key, value] of Object.entries(after)) {
    const stored = e[COLUMN_OF[key] as keyof StoredEntity];
    const same =
      value === null ? stored === null : key === "nameVariants" ? (blank(stored) ? "[]" : String(stored)) === value : sameText(stored, value);
    if (!same) {
      plan.set[key] = value;
      plan.changes[key] = { old: stored, new: value };
    }
  }
  // The term pointer follows the text: none under NULL, the term of a
  // changed text (or none), the stored pointer under an unchanged text.
  let termRefused = false;
  if ("primaryFunction" in after) {
    let termId: string | null = blank(e.primary_function_id) ? null : String(e.primary_function_id);
    if (after.primaryFunction === null) termId = null;
    else if ("primaryFunction" in plan.set) {
      const terms = ctx.terms.get(String(after.primaryFunction)) ?? [];
      if (terms.length > 1) {
        refuse(`primary_function ${JSON.stringify(after.primaryFunction)} names ${terms.length} terms of the federation`);
        termRefused = true;
      }
      termId = terms[0] ?? null;
    }
    if (termId !== e.primary_function_id) {
      plan.set.primaryFunctionId = termId;
      plan.changes.primaryFunctionId = { old: e.primary_function_id, new: termId };
      plan.termsTouched = [...new Set([text(e.primary_function_id), text(termId)].filter(Boolean))];
    }
  }
  if (termRefused) return;
  // The stored values the row names. A row with something to write must
  // name them as stored; a row the record already holds may instead name
  // the value a field it gives had before, when the changelog records
  // that field changing from it to the stored value.
  const pending = Object.keys(plan.set).length > 0;
  const checks: Array<[string, string, unknown, string]> = [
    ["current_name", c.current_name, e.display_name, "displayName"],
    ["current_dates", c.current_dates, e.dates_of_existence, "datesOfExistence"],
    ["current_function", c.current_function, e.primary_function, "primaryFunction"],
  ];
  const wrong = checks.find(([, named, stored, key]) =>
    !sameNfc(named, stored) && (pending || !(key in after) || !ctx.changedFrom(key, named, stored)),
  );
  if (wrong) {
    refuse(`${wrong[0]} ${JSON.stringify(wrong[1])} is not the stored ${JSON.stringify(text(wrong[2]))}`);
    return;
  }
  plan.status = pending ? "update" : "already updated";
}

// ---------------------------------------------------------------------------
// The statements

/**
 * Guards that each term lookup still finds what it found: for every
 * function text looked up, the federation's live terms of that text in
 * any case (the lookup's condition) are exactly the one found, or none
 * when the lookup found none.
 */
export function termLookupGuards(lookups: Map<string, string | null>, federationId: string): string[] {
  const live = (alias: string, given: string) =>
    `${alias}.federation_id = ${escapeSql(federationId)} AND ${alias}.merged_into IS NULL AND LOWER(${alias}.canonical) = LOWER(${given})`;
  return chunks([...lookups], 100).map((part) =>
    guard(
      `(SELECT count(*) FROM (VALUES ${part.map(([t, id]) => `(${escapeSql(t)}, ${escapeSql(id)})`).join(", ")}) v ` +
        `WHERE (SELECT count(*) FROM vocabulary_terms t WHERE ${live("t", "v.column1")}) = (CASE WHEN v.column2 IS NULL THEN 0 ELSE 1 END) ` +
        `AND (v.column2 IS NULL OR EXISTS (SELECT 1 FROM vocabulary_terms t WHERE t.id = v.column2 AND ${live("t", "v.column1")}))) = ${part.length}`,
      "a term a lookup found, or the absence of one, has changed since it was read",
    ),
  );
}

// @version v0.9.0
