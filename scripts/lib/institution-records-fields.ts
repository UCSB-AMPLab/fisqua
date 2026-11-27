/**
 * Scripts — the institution-records fill's repository fields
 *
 * This module deals with what `scripts/lib/institution-records-fill.ts`
 * proposes for each column of one repository, and with what counts as an
 * empty column. It reads nothing and writes nothing.
 *
 * A column is empty when it holds NULL or a string of nothing but
 * spaces, tabs and line breaks (`isBlank`): several columns hold ""
 * rather than NULL in production. `emptyCondition` is the same test in
 * SQL, for the guard of an UPDATE, so the planner and the database agree
 * on which columns may be written. `compare` sets a proposed value only
 * on an empty column; a held value equal to the proposal is unchanged, a
 * different one is reported as differing and left alone, and a column
 * with no proposal is a gap when empty and held otherwise. The one
 * exception is a fact or subtitle whose data entry names, in `replaces`,
 * the exact previous text: a held value equal to it byte for byte is
 * replaced (`replace`, carrying the text in `replaces` for the UPDATE's
 * guard), and any other held value is reported as differing, as above.
 *
 * `repositoryFields` lists, for a repository, every column the fill
 * looks at: the values taken from the instance theme, the approved facts
 * of the data file (`REPOSITORY_FACTS`, each with its source, among them
 * the history, the credit statement in both languages, `rights_text`
 * and the English subtitle, reproduction sentence, opening times and
 * access conditions), the Spanish reproduction sentence cut verbatim from
 * `rights_text` (`reproductionSentence`), and the city and country,
 * which are only reported. Where the data file has no English subtitle
 * or English reproduction sentence for a repository, the column is still
 * reported, with nothing proposed. The reproduction sentence is cut
 * from `rights_text` as it stands after the fill, so the two agree: where `rights_text` is
 * replaced and the held sentence is exactly the one cut from the previous
 * text, the sentence is replaced too, guarded on that sentence. Other names are compared as JSON lists (`canonicalList`), so
 * a list held with other spacing is not taken for a different one. The
 * hero URL depends on an object store and stays with the planner.
 *
 * @version v0.9.0
 */

import type { InstitutionSource, RepositorySource, Sourced } from "../data/institution-records/neogranadina";

export type FieldAction = "set" | "replace" | "unchanged" | "differs" | "gap" | "held";

export interface FieldChange {
  column: string;
  current: string | null;
  proposed: string | null;
  source: string;
  action: FieldAction;
  note?: string;
  /** With `replace`: the exact text held, which the UPDATE is guarded on. */
  replaces?: string;
}

/** Whether a field's proposed value is written: over an empty column, or over the exact previous text. */
export const isWrite = (f: FieldChange) => f.action === "set" || f.action === "replace";

/** The characters SQLite's `trim` is told to strip, matching `isBlank`. */
const BLANK_CHARS = "char(32, 9, 10, 13)";

/** NULL, or nothing but spaces, tabs and line breaks. */
export const isBlank = (v: string | null | undefined): boolean => v === null || v === undefined || /^[ \t\n\r]*$/.test(v);

/** The SQL test that `column` is empty, as `isBlank` decides it. */
export const emptyCondition = (column: string) => `(${column} IS NULL OR trim(${column}, ${BLANK_CHARS}) = '')`;

/** `compare`, except that a held value equal to `replaces` (and not already `proposed`) is replaced. */
function compareOrReplace(
  column: string,
  held: string | null,
  proposed: string,
  source: string,
  replaces: string | undefined,
  compared: string | null = held,
): FieldChange {
  if (replaces !== undefined && held === replaces && held !== proposed) {
    return { column, current: held, proposed, source, action: "replace", replaces };
  }
  return compare(column, compared, proposed, source);
}

export function compare(column: string, current: string | null, proposed: string | null, source: string, note?: string): FieldChange {
  const empty = isBlank(current);
  if (proposed === null) return { column, current, proposed, source, action: empty ? "gap" : "held", note };
  if (empty) return { column, current, proposed, source, action: "set", note };
  return { column, current, proposed, source, action: current === proposed ? "unchanged" : "differs", note };
}

/** A held JSON list in the form the fill writes it, so a list held with other spacing compares equal; anything else as held. */
export function canonicalList(held: string | null): string | null {
  if (held === null) return null;
  try {
    const v = JSON.parse(held);
    return Array.isArray(v) ? JSON.stringify(v) : held;
  } catch {
    return held;
  }
}

/** The data file's approved facts, by key, with the column each fills; `list` is written as JSON. */
export const REPOSITORY_FACTS = [
  { key: "shortName", column: "short_name" },
  { key: "otherNames", column: "other_names", list: true },
  { key: "institutionType", column: "institution_type" },
  { key: "address", column: "address" },
  { key: "email", column: "email" },
  { key: "website", column: "website" },
  { key: "telephone", column: "telephone" },
  { key: "historyEs", column: "history_es" },
  { key: "historyEn", column: "history_en" },
  { key: "openingTimesEs", column: "opening_times_es" },
  { key: "openingTimesEn", column: "opening_times_en" },
  { key: "accessConditionsEs", column: "access_conditions_es" },
  { key: "accessConditionsEn", column: "access_conditions_en" },
  { key: "subtitleEn", column: "subtitle_en" },
  { key: "reproductionServicesEn", column: "reproduction_services_en" },
  { key: "creditStatementEs", column: "credit_statement_es" },
  { key: "creditStatementEn", column: "credit_statement_en" },
  { key: "rightsText", column: "rights_text" },
] as const satisfies ReadonlyArray<{ key: keyof RepositorySource; column: string; list?: boolean }>;

/** The columns `REPOSITORY_FACTS` fills. */
export const FACT_COLUMNS = REPOSITORY_FACTS.map((f) => f.column);

/** The facts a repository's entry holds, each with its key, column and value as written. */
export function factsOf(s: RepositorySource) {
  return REPOSITORY_FACTS.flatMap((f) => {
    const entry = s[f.key] as (Sourced<string | string[]> & { replaces?: string }) | undefined;
    if (!entry) return [];
    const value = "list" in f ? JSON.stringify(entry.value) : String(entry.value);
    return [{ key: f.key, column: f.column, list: "list" in f, value, source: entry.source, replaces: entry.replaces }];
  });
}

/** Cuts the reproduction sentence from `rights_text`, or says why it cannot. */
export function reproductionSentence(src: InstitutionSource, rights: string | null): { value: string | null; note?: string } {
  const rule = src.reproductionServices;
  if (isBlank(rights)) return { value: null, note: "rights_text is empty" };
  if (!rights!.startsWith(rule.prefix)) return { value: null, note: "rights_text does not open with the expected text" };
  const rest = rights!.slice(rule.prefix.length);
  if (!rest.startsWith(rule.sentenceStart) || !rest.endsWith(".") || rest.slice(0, -1).includes(". ")) {
    return { value: null, note: "the text after the licence is not one reproduction sentence" };
  }
  return { value: rest };
}

/** Every column the fill proposes or reports for one repository, but the hero URL. */
export function repositoryFields(src: InstitutionSource, code: string, v: Record<string, string | null>): FieldChange[] {
  const s = src.repositories[code];
  const fields: FieldChange[] = [];
  fields.push(compare("display_title", v.display_title, s.displayTitle.value, s.displayTitle.source));
  fields.push(compareOrReplace("subtitle", v.subtitle, s.subtitle.value, s.subtitle.source, s.subtitle.replaces));
  if (!s.subtitleEn) fields.push(compare("subtitle_en", v.subtitle_en, null, "none: the data file has no English subtitle"));
  fields.push(compare("home_order", v.home_order, String(s.homeOrder.value), s.homeOrder.source));
  fields.push(
    s.region
      ? compare("region", v.region, s.region.value, s.region.source)
      : compare("region", v.region, null, "none: no source names the region"),
  );
  for (const f of factsOf(s)) {
    const held = v[f.column];
    fields.push(compareOrReplace(f.column, held, f.value, f.source, f.replaces, f.list ? canonicalList(held) : held));
  }
  const rights = fields.find((f) => f.column === "rights_text");
  const repro = reproductionSentence(src, rights && isWrite(rights) ? rights.proposed : v.rights_text);
  const reproSource = `${src.reproductionServices.source} (${code})`;
  const previousRepro = rights?.action === "replace" ? reproductionSentence(src, v.rights_text).value : null;
  fields.push(
    repro.value !== null && previousRepro !== null
      ? compareOrReplace("reproduction_services_es", v.reproduction_services_es, repro.value, reproSource, previousRepro)
      : compare("reproduction_services_es", v.reproduction_services_es, repro.value, reproSource, repro.note),
  );
  if (!s.reproductionServicesEn) {
    fields.push(compare("reproduction_services_en", v.reproduction_services_en, null, "none: the data file has no English reproduction sentence"));
  }
  for (const c of ["city", "country"] as const) {
    const attr = v.attribution_es ?? "";
    const named = !isBlank(v[c]) && attr.includes(v[c]!);
    fields.push({
      column: c,
      current: v[c],
      proposed: null,
      source: "D1 as held; checked against attribution_es",
      action: isBlank(v[c]) ? "gap" : "held",
      note: isBlank(v[c]) ? undefined : named ? "attribution_es names it" : "attribution_es does not name it",
    });
  }
  return fields;
}

// @version v0.9.0
