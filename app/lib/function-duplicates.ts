/**
 * Function Duplicates
 *
 * This module deals with the rule that a record holds each of its
 * functions once. A function row records an office or role a person
 * held; the April 2026 import wrote one row per mention, so a person
 * named "Coronel" in three documents held three "Coronel" rows. Every
 * write that adds function rows to a record (the entity editor, the
 * new-entity form, a split's copy, a merge, and the command line's
 * moves and copies) uses the functions here, so a row the record
 * already holds is never added a second time.
 *
 * `functionIdentity` is the comparison: two rows are the same function
 * when their texts are equal after NFC normalisation, trimming,
 * collapsing internal whitespace and lower-casing, so "Cura" and
 * "cura " are one function. Accents count: "Alférez" and "alferez"
 * stay two rows, which the export's grouping (`functionKey`) still
 * counts together. The honorific is not part of the comparison: the
 * record page shows and edits functions as their text, one per line,
 * and never shows a row's honorific, so a row is known by its text and
 * the honorific is one of the fields a held row can take.
 *
 * `fillFunctionFields` gives what a held row takes from an incoming row
 * of the same function: each of `FILLABLE_FUNCTION_FIELDS` the held row
 * lacks (null or blank) and the incoming row carries. A field both
 * carry keeps the held value; when the two differ the pair is returned
 * as a conflict, for the command line's report and the merge ledger.
 * Certainty is never filled: every row has one, the default "probable"
 * among them, so it cannot tell a missing value from a stated one; the
 * held row keeps its own, and a different certainty on the incoming row
 * is reported as a conflict like the other fields.
 *
 * `foldFunctionRows` applies the rule to rows arriving on a record that
 * holds `held`: each incoming row either arrives (moved, copied or
 * inserted) or folds into the row of the same function the record
 * holds by then, a held row or an earlier arrival, filling its empty
 * fields. It returns the arrivals and the folds in the order given, and
 * the record's rows afterwards, so a caller merging several records
 * into one carries them into the next. A record's own duplicates, held
 * before the write, are left as they are; the first of them is the one
 * an arrival folds into.
 *
 * `distinctFunctionLines` applies the rule to the editor's lines: a line
 * that keeps an existing row by its trimmed text is kept, as the editor
 * always has, and a line that would add a row is dropped when the
 * record keeps or adds a row of the same function.
 *
 * @version v0.9.0
 */

/** The fields a held row takes from an incoming row of the same function, in table order. */
export const FILLABLE_FUNCTION_FIELDS = ["honorific", "dateStart", "dateEnd", "dateNote", "source", "notes"] as const;
export type FillableFunctionField = (typeof FILLABLE_FUNCTION_FIELDS)[number];

/** Each fillable field's column in `entity_functions`. */
export const FUNCTION_FIELD_COLUMNS: Record<FillableFunctionField, string> = {
  honorific: "honorific",
  dateStart: "date_start",
  dateEnd: "date_end",
  dateNote: "date_note",
  source: "source",
  notes: "notes",
};

/** The fields a fold compares: the fillable ones, and the certainty, which is compared and never filled. */
export type ComparedFunctionField = FillableFunctionField | "certainty";

/** Each compared field's column in `entity_functions`. */
export const COMPARED_FIELD_COLUMNS: Record<ComparedFunctionField, string> = { ...FUNCTION_FIELD_COLUMNS, certainty: "certainty" };

/** A function row's compared fields. */
export type ComparedFields = { [K in ComparedFunctionField]?: string | null };

/** A function row as the rule reads it: its id, its text and the compared fields. */
export type FunctionFields = { id: string; function: string } & ComparedFields;

/** What a held row takes from an incoming one: the fields it fills, and the fields both hold with different values. */
export interface FunctionFill {
  set: Partial<Record<FillableFunctionField, string>>;
  conflicts: Array<{ field: ComparedFunctionField; held: string; incoming: string }>;
}

/** The text two rows of the same function share: NFC, trimmed, internal whitespace collapsed, lower-cased. */
export function functionIdentity(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

const blank = (v: string | null | undefined) => v === null || v === undefined || v.trim() === "";

/** The fields `held` lacks and `incoming` carries, and the fields both carry with different values. */
export function fillFunctionFields(held: ComparedFields, incoming: ComparedFields): FunctionFill {
  const fill: FunctionFill = { set: {}, conflicts: [] };
  for (const field of FILLABLE_FUNCTION_FIELDS) {
    const h = held[field];
    const i = incoming[field];
    if (blank(i)) continue;
    if (blank(h)) fill.set[field] = i!;
    else if (h!.normalize("NFC").trim() !== i!.normalize("NFC").trim()) {
      fill.conflicts.push({ field, held: h!, incoming: i! });
    }
  }
  // The held row keeps its certainty; a different one is reported.
  if (!blank(held.certainty) && !blank(incoming.certainty) && held.certainty !== incoming.certainty) {
    fill.conflicts.push({ field: "certainty", held: held.certainty!, incoming: incoming.certainty! });
  }
  return fill;
}

/** Whether a fill writes anything. */
export const fills = (fill: FunctionFill) => Object.keys(fill.set).length > 0;

/** An incoming row that folds into a row the record holds by then. */
export interface FunctionFold<T> extends FunctionFill {
  row: T;
  /** The id of the row it folds into. */
  into: string;
}

/**
 * The rows of `incoming` that arrive on a record holding `held`, and
 * those that fold into a row of the same function the record holds by
 * then; `after` is the record's rows afterwards, held rows first, fills
 * applied. The rows given are not changed.
 */
export function foldFunctionRows<T extends FunctionFields>(
  held: readonly T[],
  incoming: readonly T[]
): { arrive: T[]; folded: Array<FunctionFold<T>>; after: T[] } {
  const after: T[] = held.map((r) => ({ ...r }));
  const byIdentity = new Map<string, T>();
  for (const r of after) {
    const key = functionIdentity(r.function);
    if (!byIdentity.has(key)) byIdentity.set(key, r);
  }
  const arrive: T[] = [];
  const folded: Array<FunctionFold<T>> = [];
  for (const row of incoming) {
    const key = functionIdentity(row.function);
    const into = byIdentity.get(key);
    if (!into) {
      const copy = { ...row };
      after.push(copy);
      byIdentity.set(key, copy);
      arrive.push(row);
      continue;
    }
    const fill = fillFunctionFields(into, row);
    Object.assign(into, fill.set);
    folded.push({ row, into: into.id, ...fill });
  }
  return { arrive, folded, after };
}

/**
 * The editor's lines with every line dropped that would add a function
 * the record keeps or adds already. A line keeps the first unused
 * existing row of its trimmed text, as `entityFunctionsReplacement`
 * matches them; a line that keeps none would add a row, and is dropped
 * when a kept row or an earlier added line is the same function.
 */
export function distinctFunctionLines(lines: readonly string[], existing: ReadonlyArray<{ function: string }>): string[] {
  const unused = existing.map((r) => r.function.trim());
  const keeps = lines.map((line) => {
    const at = unused.indexOf(line);
    if (at < 0) return false;
    unused[at] = "\u0000";
    return true;
  });
  const held = new Set(lines.filter((_, i) => keeps[i]).map(functionIdentity));
  return lines.filter((line, i) => {
    if (keeps[i]) return true;
    const key = functionIdentity(line);
    if (held.has(key)) return false;
    held.add(key);
    return true;
  });
}

// @version v0.9.0
