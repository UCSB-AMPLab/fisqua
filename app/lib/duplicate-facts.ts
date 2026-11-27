/**
 * Duplicate facts — what supports a possible duplicate pair
 *
 * This module deals with the facts that give a pair of authority records a
 * reason to be looked at, since two records can look alike by name and
 * still be different people: a function (office) both records hold, an
 * associate both records appear with, or a document that names both. A
 * place shared by the two is supporting evidence only and never qualifies
 * a pair by itself.
 *
 * Everything here is pure computation over inputs the scheduled job
 * has already read from the database; the module touches no database
 * and imports nothing server-only, so the route can import its types.
 *
 *   - `nameDeletions` — the key plus every string with one character
 *     removed. Two keys within one edit share a deletion, which lets
 *     the job find near spellings by index lookup instead of by
 *     comparing every pair.
 *   - `functionKey` — the comparison key for an office: composed to NFC,
 *     trimmed, whitespace collapsed, case-folded, accents kept ("Alcalde"
 *     and "Álcalde" stay different, and a decomposed "Á" keys as the
 *     composed one).
 *   - `yearOf`, `yearsApart` — the year of a date string, and the gap
 *     in years between two records' spans. A span runs from its earlier
 *     year to its later one, so a start after the end reads as the same
 *     span the other way round.
 *   - `computePairFacts` — the facts for one pair, or null when the
 *     pair is related, separated, more than five years apart, or has
 *     no office, associate or document. The job leaves relation-side
 *     links out of `WorkspaceLinks` before calling it. Associates with
 *     more than 200 descriptions and places with more than 2,000 say
 *     nothing about identity and are left out. The job reads no links
 *     for a record with more than 2,000 descriptions in a workspace
 *     (`recordMaxDescriptions`), so such a record pairs there on its
 *     offices alone. Lists are capped at
 *     three and the remainder is counted in `more`; ordering is by
 *     descending shared descriptions, then id, so output is stable.
 *   - `pairWeight` — an integer used to rank pairs: offices 4 each,
 *     associates 3 each with at most 5 counted, documents 2, places 1
 *     each with at most 5 counted, overlapping dates 2.
 *   - `nearPairAllowed` — whether two name keys may form a pair. Equal
 *     keys always may. Two different keys may only when at least one
 *     contains a space, so a near spelling between two one-word names
 *     ("juan" and "juana") never pairs, while "juan sanchez" and
 *     "juana sanchez" do.
 *
 * @version v0.9.0
 */

export const DUPLICATE_LIMITS = {
  associateMaxDescriptions: 200,
  placeMaxDescriptions: 2000,
  /**
   * Descriptions of one workspace past which the recheck job reads none of
   * a record's links there (`app/lib/duplicate-recheck.server.ts`): the
   * place threshold, applied to the record itself.
   */
  recordMaxDescriptions: 2000,
  maxYearsApart: 5,
  /** Associates counted in `pairWeight`; further ones add nothing. */
  associateWeightCap: 5,
  /** Places counted in `pairWeight`; further ones add nothing. */
  placeWeightCap: 5,
} as const;

const LIST_CAP = 3;

export interface DatedRecord {
  dateStart: string | null;
  dateEnd: string | null;
}

export interface FactRecord extends DatedRecord {
  id: string;
  name: string;
  code: string | null;
  dates: string | null;
}

export interface WorkspaceLinks {
  /** Description id to its title. */
  descriptions: Map<string, string | null>;
  /** Associate entity id to the description ids shared with the record. */
  associates: Map<string, Set<string>>;
  /** Place id to the description ids shared with the record. */
  places: Map<string, Set<string>>;
}

export interface PairInputs {
  a: FactRecord;
  b: FactRecord;
  related: boolean;
  separated: boolean;
  aFunctions: string[];
  bFunctions: string[];
  aLinks: WorkspaceLinks;
  bLinks: WorkspaceLinks;
  /** Total description count per associate entity id and per place id. */
  linkTotals: Map<string, number>;
}

export interface PairFacts {
  warning: "same-document" | null;
  offices: string[];
  associates: Array<{ id: string; name: string; code: string | null }>;
  documents: Array<{ id: string; title: string | null }>;
  dates: { a: string | null; b: string | null; overlap: boolean };
  places: Array<{ id: string; name: string }>;
  more: { associates: number; documents: number; places: number };
}

/** Leading four-digit year of a date string, or null. */
export function yearOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const m = date.match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

/** The key itself plus every string with one character removed. */
export function nameDeletions(key: string): string[] {
  if (!key) return [];
  const out = new Set<string>([key]);
  for (let i = 0; i < key.length; i++) {
    out.add(key.slice(0, i) + key.slice(i + 1));
  }
  return [...out];
}

/** Comparison key for a function: NFC, trimmed, collapsed, case-folded. */
export function functionKey(fn: string): string {
  return fn.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

function span(r: DatedRecord): [number, number] | null {
  const s = yearOf(r.dateStart);
  const e = yearOf(r.dateEnd);
  if (s == null && e == null) return null;
  const first = s ?? e!;
  const last = e ?? s!;
  return [Math.min(first, last), Math.max(first, last)];
}

/**
 * Gap in years between two records' spans: 0 when they touch or
 * overlap, null when either has no year. A start-only or end-only
 * record is a one-year span, and a reversed span is read from its
 * earlier year to its later one.
 */
export function yearsApart(a: DatedRecord, b: DatedRecord): number | null {
  const sa = span(a);
  const sb = span(b);
  if (!sa || !sb) return null;
  return Math.max(0, sb[0] - sa[1], sa[0] - sb[1]);
}

function byShared(
  entries: Array<{ id: string; shared: number }>
): string[] {
  return entries
    .sort((x, y) => y.shared - x.shared || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .map((e) => e.id);
}

function sharedIds(
  a: Map<string, Set<string>>,
  b: Map<string, Set<string>>,
  totals: Map<string, number>,
  max: number
): string[] {
  const entries: Array<{ id: string; shared: number }> = [];
  for (const [id, aSet] of a) {
    const bSet = b.get(id);
    if (!bSet) continue;
    // A missing total is excluded: the shared sets are not the real total.
    const total = totals.get(id);
    if (total === undefined || total > max) continue;
    entries.push({ id, shared: aSet.size + bSet.size });
  }
  return byShared(entries);
}

/**
 * Facts supporting the pair, or null when it should not be queued.
 * `names` maps an associate or place id to its display name; `codes`
 * optionally maps an associate id to its code.
 */
export function computePairFacts(
  input: PairInputs,
  names: Map<string, string>,
  codes: Map<string, string | null> = new Map()
): PairFacts | null {
  if (input.related || input.separated) return null;

  const apart = yearsApart(input.a, input.b);
  if (apart != null && apart > DUPLICATE_LIMITS.maxYearsApart) return null;

  const bKeys = new Set(input.bFunctions.map(functionKey));
  const officeByKey = new Map<string, string>();
  for (const fn of input.aFunctions) {
    const k = functionKey(fn);
    if (k && bKeys.has(k) && !officeByKey.has(k)) officeByKey.set(k, fn.trim());
  }
  const offices = [...officeByKey.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([, v]) => v);

  const associateIds = sharedIds(
    input.aLinks.associates,
    input.bLinks.associates,
    input.linkTotals,
    DUPLICATE_LIMITS.associateMaxDescriptions
  );
  const placeIds = sharedIds(
    input.aLinks.places,
    input.bLinks.places,
    input.linkTotals,
    DUPLICATE_LIMITS.placeMaxDescriptions
  );
  const documentIds = [...input.aLinks.descriptions.keys()]
    .filter((id) => input.bLinks.descriptions.has(id))
    .sort();

  if (offices.length === 0 && associateIds.length === 0 && documentIds.length === 0) {
    return null;
  }

  return {
    warning: documentIds.length > 0 ? "same-document" : null,
    offices: offices.slice(0, LIST_CAP),
    associates: associateIds.slice(0, LIST_CAP).map((id) => ({
      id,
      name: names.get(id) ?? id,
      code: codes.get(id) ?? null,
    })),
    documents: documentIds.slice(0, LIST_CAP).map((id) => ({
      id,
      title: input.aLinks.descriptions.get(id) ?? null,
    })),
    dates: {
      a: input.a.dates,
      b: input.b.dates,
      overlap: apart === 0,
    },
    places: placeIds.slice(0, LIST_CAP).map((id) => ({
      id,
      name: names.get(id) ?? id,
    })),
    more: {
      associates: Math.max(0, associateIds.length - LIST_CAP),
      documents: Math.max(0, documentIds.length - LIST_CAP),
      places: Math.max(0, placeIds.length - LIST_CAP),
    },
  };
}

/**
 * Whether two normalised name keys may form a pair: true when the keys
 * are equal or when either contains a space.
 */
export function nearPairAllowed(keyA: string, keyB: string): boolean {
  return keyA === keyB || keyA.includes(" ") || keyB.includes(" ");
}

/**
 * Ranking weight: offices 4, associates 3 each (at most
 * `associateWeightCap` counted), documents 2, places 1 each (at most
 * `placeWeightCap` counted), dates 2.
 */
export function pairWeight(facts: PairFacts): number {
  const n = (listed: number, more: number) => listed + more;
  return (
    4 * facts.offices.length +
    3 *
      Math.min(
        DUPLICATE_LIMITS.associateWeightCap,
        n(facts.associates.length, facts.more.associates)
      ) +
    2 * n(facts.documents.length, facts.more.documents) +
    1 *
      Math.min(
        DUPLICATE_LIMITS.placeWeightCap,
        n(facts.places.length, facts.more.places)
      ) +
    (facts.dates.overlap ? 2 : 0)
  );
}

// @version v0.9.0
