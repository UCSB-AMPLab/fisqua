/**
 * Search query model — terms, exclusions, and field scopes
 *
 * This module is the one place the search language is defined: what a
 * typed query means, how a refinement travels in the URL, and how the
 * whole thing compiles to an FTS5 MATCH expression. It is deliberately
 * pure — no imports, no server suffix — because both sides of the
 * search need it: the server compiles queries with it, and the surface
 * uses the same parser to turn URL state into pills and the same
 * encoder to turn pills back into URL state. One module, one grammar,
 * no drift.
 *
 * THE LANGUAGE. There are no boolean keywords in any language — no
 * AND/OR/NOT words, no typed field:value syntax offered to people, no
 * parentheses. This is Zasqua's search model: terms separated by
 * spaces all have to match (implicit AND); a leading hyphen on a
 * whitespace-separated token excludes that term; a query that opens
 * with a double quote is a verbatim exact phrase and is not picked
 * apart at all. Everything else — include/exclude, field scoping — is
 * a control on the refine bar, not a syntax. Choosing controls over
 * keywords keeps the query language identical for a cataloguer working
 * in Spanish and a reviewer working in English.
 *
 * THE WIRE FORM. State is the URL's repeatable `q` parameter: the
 * first value is the main box, each later value is one refinement.
 * A refinement value reads `-field:term` — optional leading hyphen
 * for exclusion, optional field prefix (one of SEARCH_FIELDS) for
 * scoping, then the term, which may contain spaces (a multi-word
 * refinement is one phrase, one pill). Any other `prefix:` is not a
 * field and stays part of the term, so a person searching for
 * literal colon-bearing text is never surprised.
 *
 * FIELD SCOPES are Fisqua's one extension to the ancestor model. The
 * record index carries per-column filters (title, scope, notes,
 * reference code, legacy identifiers); the name indexes carry no such
 * columns, so a field-scoped query is answerable only by records —
 * `hasFieldRefinements` is how the callers detect that and narrow the
 * surface accordingly.
 *
 * WHOLE WORDS. A term matches whole words, not word beginnings:
 * `casa` finds the word casa and does NOT find Casarín or Casaus.
 * Prefix matching still exists, but only when a person asks for it by
 * ending a term with `*` — `casa*` finds all three. That is the one
 * place the star is meaningful; the emitted unit strips it from the
 * quoted text and re-appends it outside the quotes, where FTS5 reads
 * it as the prefix operator. Accent-insensitivity is free: the
 * indexes tokenise with unicode61, so `cofradia` finds Cofradía
 * whichever way the term is matched.
 *
 * NO MINIMUM LENGTH. Any non-blank term is searchable. A one-letter
 * term is a legitimate question of an archival index — a shelf letter,
 * an initial, a series mark — and whole-word matching means it no
 * longer drags a prefix expansion of the whole corpus behind it.
 * Blankness is the only reason a term is dropped.
 *
 * VALID BY CONSTRUCTION. `compileFtsExpression` never emits a bare
 * token: every unit is a double-quoted string (inner quotes doubled),
 * optionally behind a column filter and optionally followed by the
 * prefix star. Quoting neutralises everything FTS5 would otherwise
 * read as syntax — hyphens, apostrophes, colons, AND/OR/NOT as words —
 * so hyphenated terms and boolean-looking words search fine instead of
 * erroring. The one deliberate exception is the verbatim phrase box,
 * which is passed through as typed and can therefore still carry an
 * unbalanced quote; `sanitisedFallbackExpression` is the retry net for
 * exactly that case.
 *
 * TWO EXPRESSIONS, TWO QUESTIONS. `compileFtsExpression` asks which
 * documents the query WANTS, exclusions subtracted inside the
 * expression. `compileExclusionExpression` asks the opposite question —
 * which documents the exclusions NAME — and exists for the browse
 * reads, where there is no positive side to subtract from and the
 * excluded set has to be removed from a plain scoped read instead.
 *
 * THE ADVANCED GRAMMAR is the second half of this module, and it is a
 * different question asked of the same index. The pills language above
 * cannot express OR — every pill narrows — and an archival reader who
 * wants "Tunja or Muzo, but not the parish books" has no way to say so.
 * The advanced form gives them a stack of ROWS, each one an operator,
 * an optional field scope, and a term, and the rows accumulate LEFT TO
 * RIGHT: the first surviving row is the anchor (always positive, its
 * operator ignored), and each row after it combines with everything
 * before it, never with its immediate neighbour alone. `a OR b NOT c`
 * therefore means `(a OR b) NOT c` — the parens are emitted, not
 * implied, so the reading does not depend on FTS5's own precedence.
 *
 * Operators travel as the wire words `and`/`or`/`not` because they are
 * SELECT values a form chose, not text a person typed; the surface
 * shows them in the reader's own language. Rows ride their own
 * repeatable URL parameter, `op:field:term`, split on the FIRST TWO
 * colons so a term may carry as many more as it likes. A crafted value
 * degrades rather than errors: an operator that is not one of the
 * three, a field name the index does not have, or a term that is blank
 * once trimmed drops that row and leaves the rest of the query
 * standing.
 *
 * @version v0.7.0
 */

/** The field scopes a refinement may carry, in display order. */
export const SEARCH_FIELDS = ["title", "scope", "notes", "ref", "legacy"] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];

export interface SearchRefinement {
  term: string;
  op: "AND" | "NOT";
  /** null = all fields */
  field: SearchField | null;
}

export interface ParsedSearch {
  /** Positive main-box text after exclusion-extraction; "" when
   *  nothing survives. Verbatim raw in phrase mode. */
  q: string;
  /** True when the box text opened with a double quote — the verbatim
   *  exact-phrase idiom; no tokenising, no extraction. */
  phrase: boolean;
  refinements: SearchRefinement[];
}

/** Which FTS5 column of the record index each field scope filters. */
const FIELD_COLUMNS: Record<SearchField, string> = {
  title: "title",
  scope: "scope_content",
  notes: "notes",
  ref: "reference_code",
  legacy: "legacy_ids",
};

/**
 * The field prefix a refinement value may open with. Anchored and
 * case-insensitive; anything else that looks like `prefix:` is part
 * of the term, never a field.
 */
const FIELD_PREFIX = /^(title|scope|notes|ref|legacy):/i;

/**
 * Turn the URL's `q` values into the query model. The first value is
 * the main box; each later value is one refinement in the wire form.
 * Refinements equal on (term, op, field) collapse to one — a pill
 * added twice, or a box exclusion repeated as a pill, is one filter.
 */
export function parseSearch(qValues: string[]): ParsedSearch {
  const refinements: SearchRefinement[] = [];
  const seen = new Set<string>();
  const add = (r: SearchRefinement) => {
    // The parts are joined on a NUL, a byte no typed term can carry,
    // so two different refinements cannot collide on one key.
    const key = `${r.op}\u0000${r.field ?? ""}\u0000${r.term}`;
    if (seen.has(key)) return;
    seen.add(key);
    refinements.push(r);
  };

  const box = (qValues[0] ?? "").trim();
  let q = "";
  let phrase = false;
  if (box.startsWith('"')) {
    // Verbatim phrase mode: what was typed is what is asked.
    q = box;
    phrase = true;
  } else if (box) {
    const positives: string[] = [];
    for (const token of box.split(/\s+/)) {
      if (!token) continue;
      // Only a LEADING hyphen on a token of length > 1 is the exclude
      // operator; one hyphen is stripped and the rest — mid-word
      // hyphens included — is the term. A bare "-" is ordinary text.
      if (token.startsWith("-") && token.length > 1) {
        add({ term: token.slice(1), op: "NOT", field: null });
      } else {
        positives.push(token);
      }
    }
    q = positives.join(" ");
  }

  for (const value of qValues.slice(1)) {
    let rest = value.trim();
    if (!rest) continue;
    let op: SearchRefinement["op"] = "AND";
    if (rest.startsWith("-") && rest.length > 1) {
      op = "NOT";
      rest = rest.slice(1);
    }
    let field: SearchField | null = null;
    const prefix = FIELD_PREFIX.exec(rest);
    if (prefix) {
      field = prefix[1].toLowerCase() as SearchField;
      rest = rest.slice(prefix[0].length);
    }
    const term = rest.trim();
    if (!term) continue;
    add({ term, op, field });
  }

  return { q, phrase, refinements };
}

/** A refinement's wire form, as one `q` value: `-field:term`. */
export function encodeRefinement(r: SearchRefinement): string {
  const not = r.op === "NOT" ? "-" : "";
  const field = r.field ? `${r.field}:` : "";
  return `${not}${field}${r.term}`;
}

export function hasFieldRefinements(p: ParsedSearch): boolean {
  return p.refinements.some((r) => r.field !== null);
}

/** Whether anything positive is being asked for: box text or an AND pill. */
export function hasPositive(p: ParsedSearch): boolean {
  return p.q !== "" || p.refinements.some((r) => r.op === "AND");
}

/** Exclusions exist but nothing positive to subtract them from. */
export function isOnlyNot(p: ParsedSearch): boolean {
  return !hasPositive(p) && p.refinements.length > 0;
}

/** Nothing at all survived parsing. */
export function isBlank(p: ParsedSearch): boolean {
  return p.q === "" && p.refinements.length === 0;
}

/**
 * One term as one FTS5 unit: a double-quoted string with its inner
 * quotes doubled, matching whole words. A trailing `*` on the term is
 * the person's own request for prefix matching: it comes off the text,
 * the rest is quoted, and the star goes back on OUTSIDE the quotes,
 * where FTS5 reads it as the prefix operator rather than as a
 * character to look for. On a multi-word term the result is a phrase —
 * the words in order — and with the star, a phrase whose last word is
 * open-ended.
 */
function quotedUnit(term: string): string {
  const prefixed = term.endsWith("*");
  const text = prefixed ? term.slice(0, -1) : term;
  return `"${text.replaceAll('"', '""')}"${prefixed ? "*" : ""}`;
}

/**
 * One term as one FTS5 unit, behind its column filter when the term is
 * field-scoped. Both grammars emit units through here, so a pill and an
 * advanced row asking the same thing compile to the same string.
 */
function scopedUnit(field: SearchField | null, term: string): string {
  const unit = quotedUnit(term);
  return field ? `${FIELD_COLUMNS[field]}: ${unit}` : unit;
}

/** A refinement's unit, behind its column filter when field-scoped. */
function refinementUnit(r: SearchRefinement): string {
  return scopedUnit(r.field, r.term);
}

/**
 * Compile the query model to an FTS5 MATCH expression, or null when
 * there is nothing positive to match (blank and only-NOT queries have
 * no answerable positive side — the caller answers those by browsing
 * instead of matching).
 *
 * Shape: every positive unit joined with explicit ` AND ` inside one
 * paren group, then each exclusion appended as ` NOT unit` — FTS5's
 * NOT is binary and left-associative, so the chain subtracts each
 * exclusion in turn. The phrase-mode box travels verbatim inside its
 * own parens, the one place a person's raw typing reaches FTS5.
 */
export function compileFtsExpression(p: ParsedSearch): string | null {
  if (!hasPositive(p)) return null;

  const positives: string[] = [];
  if (p.phrase) {
    positives.push(`(${p.q})`);
  } else if (p.q) {
    for (const token of p.q.split(/\s+/)) positives.push(quotedUnit(token));
  }
  for (const r of p.refinements) {
    if (r.op === "AND") positives.push(refinementUnit(r));
  }

  let expression = `(${positives.join(" AND ")})`;
  for (const r of p.refinements) {
    if (r.op === "NOT") expression += ` NOT ${refinementUnit(r)}`;
  }
  return expression;
}

/**
 * The expression that MATCHES the excluded documents — the same units
 * `compileFtsExpression` subtracts, column filters and all, joined
 * with ` OR ` because a document is excluded if it answers ANY of
 * them. A column filter binds only to the unit that follows it, so
 * one scoped exclusion in a chain does not scope its neighbours.
 *
 * Null when the query excludes nothing. This is the browse path's
 * subtraction: with no positive side there is no expression to append
 * ` NOT` to, so the excluded set is matched here and removed from an
 * ordinary scoped read instead.
 */
export function compileExclusionExpression(p: ParsedSearch): string | null {
  const units: string[] = [];
  for (const r of p.refinements) {
    if (r.op === "NOT") units.push(refinementUnit(r));
  }
  return units.length === 0 ? null : units.join(" OR ");
}

/**
 * The retry net: positives only (box tokens and AND refinements),
 * with every character FTS5 could read as syntax stripped, in the
 * plain quoted whole-word AND form. Exclusions and field scopes are
 * deliberately dropped — this expression exists to salvage SOME
 * answer from a query whose compiled form threw (in practice, a
 * phrase-mode box with an unbalanced quote), not to preserve every
 * nuance of it. The star goes with the rest of the syntax: a salvaged
 * query asks the plainest possible question. Null when nothing
 * survives the stripping.
 */
export function sanitisedFallbackExpression(p: ParsedSearch): string | null {
  const tokens: string[] = [];
  const keep = (value: string) => {
    const cleaned = value.replace(/["():\-*]/g, "");
    if (cleaned) tokens.push(cleaned);
  };
  if (p.q) for (const token of p.q.split(/\s+/)) keep(token);
  for (const r of p.refinements) {
    if (r.op !== "AND") continue;
    for (const word of r.term.split(/\s+/)) keep(word);
  }
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"`).join(" ");
}

// --- the advanced grammar -------------------------------------------

/** How an advanced row joins to everything stated before it. */
/**
 * Rows beyond this are ignored. The compiled expression nests one
 * paren layer per row and FTS5's parser stack gives out near a
 * hundred; two dozen criteria is already far past any real question,
 * so the cap protects the parser without ever being felt.
 */
export const MAX_ADVANCED_ROWS = 24;

export type AdvancedOp = "and" | "or" | "not";

/** One line of the advanced form, as the URL carries it. */
export interface AdvancedRow {
  /** The first surviving row is always "and" (the anchor). */
  op: AdvancedOp;
  /** null = all fields */
  field: SearchField | null;
  term: string;
}

/** The FTS5 keyword each operator accumulates with. */
const ADVANCED_KEYWORDS: Record<AdvancedOp, string> = {
  and: "AND",
  or: "OR",
  not: "NOT",
};

/** The operator, or null when the value names no operator at all. */
function parseAdvancedOp(value: string): AdvancedOp | null {
  const op = value.trim().toLowerCase();
  return op === "and" || op === "or" || op === "not" ? op : null;
}

/**
 * The field scope of one row: null for the empty (all-fields) name,
 * the field for a name the record index has, and `undefined` — the one
 * value a row cannot hold — for a name it does not, which is how the
 * caller tells "all fields" apart from "this row is nonsense".
 */
function parseAdvancedField(value: string): SearchField | null | undefined {
  const name = value.trim().toLowerCase();
  if (name === "") return null;
  return (SEARCH_FIELDS as readonly string[]).includes(name)
    ? (name as SearchField)
    : undefined;
}

/**
 * Turn the URL's repeatable `adv` values into advanced rows. Each value
 * is `op:field:term`, split on the FIRST TWO colons so the term keeps
 * every colon of its own. A value missing either colon, naming an
 * operator that is not one of the three, naming a field the index does
 * not have, or carrying a term that is blank once trimmed is DROPPED —
 * a hand-edited URL degrades to the query it can still express instead
 * of failing. Whichever row survives first becomes the anchor, and an
 * anchor is always positive: its operator is forced to "and", so a URL
 * that opens with `not:` or whose first rows all dropped still asks a
 * question with something in it.
 */
export function parseAdvancedRows(advValues: string[]): AdvancedRow[] {
  const rows: AdvancedRow[] = [];
  for (const value of advValues) {
    if (rows.length >= MAX_ADVANCED_ROWS) break;
    const firstColon = value.indexOf(":");
    if (firstColon === -1) continue;
    const secondColon = value.indexOf(":", firstColon + 1);
    if (secondColon === -1) continue;

    const op = parseAdvancedOp(value.slice(0, firstColon));
    if (op === null) continue;
    const field = parseAdvancedField(value.slice(firstColon + 1, secondColon));
    if (field === undefined) continue;
    const term = value.slice(secondColon + 1).trim();
    if (!term) continue;

    // The anchor must be positive. A leading "or" means the same thing
    // as "and" with nothing before it, so it normalises; a leading
    // "not" does NOT — flipping it would search FOR what the row asked
    // to exclude — so the row is dropped instead, and the next row is
    // considered for the anchor in its place.
    if (rows.length === 0) {
      if (op === "not") continue;
      rows.push({ op: "and", field, term });
    } else {
      rows.push({ op, field, term });
    }
  }
  return rows;
}

/** A row's wire form, as one `adv` value: `op:field:term`. */
export function encodeAdvancedRow(r: AdvancedRow): string {
  return `${r.op}:${r.field ?? ""}:${r.term}`;
}

/**
 * Whether any row is field-scoped. Only the record index has columns to
 * answer one, so this is what takes the name indexes out of play —
 * exactly what `hasFieldRefinements` does for the pills grammar.
 */
export function hasAdvancedFieldRows(rows: AdvancedRow[]): boolean {
  return rows.some((r) => r.field !== null);
}

/**
 * Compile the advanced rows to an FTS5 MATCH expression, or null when
 * there are no rows — the caller answers an empty form by browsing, the
 * same way it answers a blank box.
 *
 * Shape: the anchor's unit inside its own parens, then one paren layer
 * per row, each wrapping everything before it — `(((a) OR b) NOT c)`.
 * Writing the association out means the expression reads the way the
 * form reads, top to bottom, rather than the way FTS5 would group it if
 * left alone. Every unit is quoted by construction (and behind a column
 * filter when scoped), so the whole expression is valid FTS5 and needs
 * no sanitised retry behind it.
 */
export function compileAdvancedExpression(rows: AdvancedRow[]): string | null {
  const anchor = rows[0];
  if (!anchor) return null;

  let expression = `(${scopedUnit(anchor.field, anchor.term)})`;
  for (const row of rows.slice(1)) {
    const unit = scopedUnit(row.field, row.term);
    expression = `(${expression} ${ADVANCED_KEYWORDS[row.op]} ${unit})`;
  }
  return expression;
}
