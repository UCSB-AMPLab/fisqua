/**
 * Global search — one query across records, entities and places
 *
 * This module deals with the workspace-wide search: a single query
 * answered by all three full-text indexes at once, grouped by category
 * rather than blended into one ranked list. It is the only place the
 * search statements live; the surface that renders them decides gates,
 * facets and paging, and asks this module for rows.
 *
 * WHY GROUPED, NOT BLENDED. The three indexes describe different
 * things and have nothing comparable about their document lengths or
 * column sets, so a merged ranking would need BM25 scores normalised
 * across them — fiddly to tune and rarely satisfying. Each group is
 * ordered by BM25 inside its own index, which is honest, and the
 * caller shows them as separate sections.
 *
 * TWO MODES. A search that asks for something positive MATCHES: every
 * read joins its FTS index and the compiled expression carries the
 * exclusions inside it. A search that asks for nothing positive —
 * only exclusions, only facet selections, or nothing at all — BROWSES:
 * the same tables read without an FTS join, narrowed by facets, with
 * excluded documents removed through a NOT IN over the index. Browsing
 * is a real answer, not a refusal: "everything in this repository
 * except the parish books" is a question an archive asks constantly,
 * and it has a row set. Rows reached without a match carry their plain
 * title and no snippet, because there is no matched term to mark.
 *
 * ONE STATEMENT PER READ. Every read applies its scope predicate in
 * the SAME statement as its FROM:
 *
 *     FROM descriptions d JOIN descriptions_fts f ON f.rowid = d.rowid
 *     WHERE d.tenant_id = ?1 AND f.descriptions_fts MATCH ?2
 *
 * That matters twice over. It keeps the scope visible at the point of
 * the read — the boundary is in the statement, not in a later filter
 * the reader has to go and find — and it keeps the parameter count
 * flat: two bindings plus paging, whatever the match count. The older
 * per-section pattern (match in FTS, collect rowids, filter the base
 * table by those rowids) has to inline hundreds of rowid literals to
 * stay under D1's binding cap, and does not scale past a broad query.
 *
 * The rule extends to the exclusion clause, which is built here as a
 * fragment rather than written out at each call site. That fragment
 * names an FTS table of its own, so it spells the scope predicate a
 * second time: the subquery it builds matches rowids with no scope
 * whatsoever, and the clause that does the hiding must never be the
 * only thing standing between a viewer and another tenant's rowid.
 * Repeating the predicate costs one redundant binding and keeps every
 * template self-scoping, which is exactly what the static guard in the
 * tests reads the source for.
 *
 * The FTS5 auxiliary functions (highlight, snippet, bm25) take the
 * index's hidden same-named column, so they are written
 * bm25(f.descriptions_fts) and not bm25(f) — an alias on its own is
 * not a column and SQLite rejects it.
 *
 * SCOPE. Descriptions are tenant-scoped (d.tenant_id). Entities and
 * places are authority records: they scope by authorityScopeSql
 * (app/lib/authority-ownership.server.ts), the one place the
 * federation-plus-own-records visibility rule is written, and
 * merged-away records never appear. The caller decides whether
 * authorities are reachable at all; when they are not, their
 * categories are ABSENT from the counts rather than reported as zero,
 * because a zero is still an answer about records the viewer may not
 * see. Their facet groups are absent for the same reason.
 *
 * WHAT COMES BACK. counts are facet-free per-category counts — the
 * numbers on the category tabs, which must stay live while a facet
 * narrows one category's rows. preview is the top handful per category
 * for the combined view. page is one category's rows under its active
 * facets, with an honest total computed under those same facets so
 * pagination cannot promise a page that is not there. When facets are
 * active that means two count statements for the selected category;
 * the alternative is a number that lies.
 *
 * THE WHOLE SET, AS IDS. Beside the paged read there is an
 * enumeration: every id one category's question reaches, under the same
 * expression, scope, facets and order, in one statement rather than a
 * loop over pages. It exists for the export carry, which has to fix a
 * selection at the moment it is made, and it is built from the same
 * fragments as the paged read precisely so the two can never disagree
 * about what "all matching" means.
 *
 * FACET COUNTS come back on every call, because the sidebar is live
 * from the landing state onwards. Each group counts under the mode's
 * base predicate plus the OTHER groups' selections, with its OWN
 * selections left out. That short-circuit is what keeps the unchecked
 * values in a group honest: checking one level should not collapse
 * every sibling level's count to zero, because checking a second one
 * would widen the result, not narrow it. Across groups the selections
 * are cumulative, which is the same asymmetry a person reads off the
 * sidebar without being told.
 *
 * SORTING is a closed set of keys mapped to fixed ORDER BY fragments —
 * no caller string ever reaches the statement. Relevance exists only
 * in match mode, since bm25 needs the index join; asking for it while
 * browsing resolves to the browse default rather than failing. Missing
 * dates sort last in BOTH directions, written as a leading IS NULL
 * expression rather than NULLS LAST so the ordering does not depend on
 * the SQLite build underneath.
 *
 * MARKERS. Matched terms come back wrapped in two control characters
 * rather than HTML. Control characters cannot occur in catalogued
 * text, so the renderer can split on them and build its own elements —
 * no escaping question, no markup travelling through the database
 * layer. snippet() returns NULL for an empty column, and a snippet
 * that is empty once the markers are stripped is normalised to null so
 * the surface can simply test for absence.
 *
 * THE QUERY. The caller hands over a ParsedSearch — the query model
 * search-query defines: positive box text, refinements with an
 * include/exclude operator and an optional field scope, phrase mode.
 * ONE compiled expression serves all three indexes: exclusions are
 * column-free and subtract from the name indexes exactly as they do
 * from records, and a field-scoped refinement — which only the record
 * index's columns can answer — takes the name indexes out of play
 * entirely rather than sending them a column filter they would reject.
 * That narrowing happens here, not just in the route: a field-scoped
 * query behaves as if authorities were out of scope, ABSENT counts and
 * all.
 *
 * OR THE ADVANCED ROWS. The caller may hand over an array of
 * AdvancedRow instead — the boolean form's stack of operator, field
 * and term — and everything downstream is unchanged: one compiled
 * expression, the same three indexes, the same grouped answer. Two
 * differences follow from how that expression is built. Its anchor row
 * is always positive, so there is a positive side and the advanced
 * path never browses through a NOT IN; and it is quoted by
 * construction with no verbatim phrase box anywhere in it, so there is
 * nothing for the sanitised retry to salvage and none is offered.
 * Should FTS5 reject one anyway, that is still a match-mode failure and
 * takes the log-and-fallback, not the browse rethrow: a compiler bug
 * must not present itself as an infrastructure outage.
 *
 * WITHIN A HANDLIST is the one narrowing that is not a facet. A
 * handlist is the GROUND a question is asked on rather than one of the
 * things asked for, so it narrows every statement alike — tab counts,
 * sidebar, page and enumeration — which is what lets a category
 * honestly read zero inside a set that cannot hold it. It travels as a
 * single id and joins the read as a membership subquery, never as a
 * list of member ids: one binding whatever the set's size. Its absence
 * is the normal case and changes no statement at all.
 *
 * A DATE RANGE is a record facet like any other, and lives with them
 * rather than in the query. It is a pair of years read as an OVERLAP:
 * a record answers when its own span meets the asked-for one at any
 * point, which is the question an archivist means by "anything from the
 * 1650s". A record with no start date is not a match for an open
 * question about dates, so it drops out while either bound is active
 * rather than being counted as an unknown that might qualify. Because
 * only records carry dates, a date bound narrows the authorities out
 * exactly as a field scope does.
 *
 * BAD SYNTAX. Compiled expressions are valid FTS5 by construction —
 * every unit is quoted, so hyphens, apostrophes, colons and the
 * boolean keywords are ordinary text. The one input that can still
 * throw is the verbatim phrase box, which passes a person's raw typing
 * (unbalanced quotes included) through to FTS5. Each category's match
 * is therefore still attempted twice: the compiled expression, then
 * the sanitised positives-only fallback; if both fail, that category
 * reports no matches and the error is logged rather than swallowed.
 * Near-unreachable is not unreachable, and the retry is two lines.
 * Browse reads have no fallback to try — their exclusion expression is
 * quoted by construction and the phrase box cannot reach it — so a
 * failure there logs and reports nothing, which errs towards showing
 * too little. There is deliberately no LIKE fallback here — a
 * workspace-wide LIKE scan over every indexed column is a table scan
 * wearing a search's clothes.
 *
 * @version v0.7.0
 */

import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { authorityScopeSql } from "./authority-ownership.server";
import {
  compileAdvancedExpression,
  compileExclusionExpression,
  compileFtsExpression,
  hasAdvancedFieldRows,
  hasFieldRefinements,
  isBlank,
  sanitisedFallbackExpression,
} from "./search-query";
import type { AdvancedRow, ParsedSearch } from "./search-query";

/** Opening marker wrapped around a matched term. */
export const HIGHLIGHT_OPEN = "\u0001";
/** Closing marker wrapped around a matched term. */
export const HIGHLIGHT_CLOSE = "\u0002";
/** Rows shown per group in the combined view. */
export const SEARCH_PREVIEW_LIMIT = 10;
/** Rows per page in a single-category view. */
export const SEARCH_PAGE_SIZE = 25;
/** How many function values the entity facet group offers unprompted. */
export const FN_FACET_LIMIT = 12;

/** Tokens of context `snippet()` builds around a match. */
const SNIPPET_TOKENS = 12;
/** Ellipsis `snippet()` uses where it cuts the surrounding text. */
const SNIPPET_ELLIPSIS = "…";

export type SearchCategory = "descriptions" | "entities" | "places";

export interface DescriptionHit {
  id: string;
  referenceCode: string;
  /** Title with HIGHLIGHT_OPEN/CLOSE marker pairs around matched
   *  terms; the raw title when the row was reached by browsing. */
  titleMarked: string;
  /** scope_content snippet with markers; null when browsing or empty. */
  scopeSnippet: string | null;
  level: string;
  dateExpression: string | null;
}

export interface EntityHit {
  id: string;
  displayName: string;
  entityCode: string | null;
  entityType: string;
  primaryFunction: string | null;
}

export interface PlaceHit {
  id: string;
  displayName: string;
  placeCode: string | null;
  placeType: string | null;
}

/**
 * The active facet selections, one array per group. Several values in
 * a group are an OR; values across groups are an AND. Empty and
 * absent mean the same thing. The caller pre-validates every value.
 */
export interface GlobalSearchFacets {
  /** descriptions: description_level */
  levels?: string[];
  /** descriptions: repository_id */
  repoIds?: string[];
  /** entities: entity_type */
  entityTypes?: string[];
  /** entities: primary_function */
  fns?: string[];
  /** places: place_type */
  placeTypes?: string[];
  /** 4-digit year strings, caller-validated; records-only. */
  dateFrom?: string | null;
  dateTo?: string | null;
}

export type SortDir = "asc" | "desc";
export type RecordSortKey = "relevance" | "date" | "title" | "code";
export type NameSortKey = "relevance" | "name" | "code";
export interface SortSpec {
  key: RecordSortKey | NameSortKey;
  dir: SortDir;
}

export interface FacetValueCount {
  value: string;
  count: number;
}

export interface RepositoryFacetCount {
  id: string;
  name: string;
  count: number;
}

/** Sidebar numbers. A group is absent when its category is. */
export interface FacetCounts {
  levels?: FacetValueCount[];
  repositories?: RepositoryFacetCount[];
  entityTypes?: FacetValueCount[];
  /** Top FN_FACET_LIMIT by count, plus any selected value below them. */
  fns?: FacetValueCount[];
  placeTypes?: FacetValueCount[];
}

export interface GlobalSearchResult {
  /**
   * Facet-free per-category counts (the tab numbers). Categories the
   * caller excluded are ABSENT (undefined), never zero.
   */
  counts: { descriptions?: number; entities?: number; places?: number };
  /** Sidebar numbers, always present. */
  facetCounts: FacetCounts;
  /** "match" when a positive query drove the reads; "browse" otherwise. */
  mode: "match" | "browse";
  /** "all" view: up to SEARCH_PREVIEW_LIMIT rows per included category. */
  preview?: {
    descriptions: DescriptionHit[];
    entities: EntityHit[];
    places: PlaceHit[];
  };
  /** single-category view */
  page?: {
    category: SearchCategory;
    rows: DescriptionHit[] | EntityHit[] | PlaceHit[];
    /** Honest count under the active facets (drives pagination). */
    total: number;
    /** 1-based. */
    pageNumber: number;
  };
}

/** The request's visibility, as the caller's gates resolved it. */
export interface GlobalSearchScope {
  tenantId: string;
  federationId: string;
  includeAuthorities: boolean;
  /**
   * Search INSIDE a handlist: the ground the question is asked on
   * rather than one of the things asked for. Absent — the normal case —
   * changes nothing about any statement.
   *
   * It narrows every read alike, so the tab counts, the sidebar and the
   * page all speak about the set rather than about the workspace, which
   * is what lets a tab honestly read zero for a category the handlist
   * cannot hold. The caller has already resolved the handlist under its
   * own visibility rule (`app/lib/handlists.server.ts`); what travels
   * here is one id, never a materialised list of members.
   */
  handlistId?: string | null;
}

/** What a single-category view asks for, or the combined view. */
export type GlobalSearchView =
  | { category: "all" }
  | {
      category: SearchCategory;
      page: number;
      facets: GlobalSearchFacets;
      /** null = the mode's default. */
      sort: SortSpec | null;
    };

/**
 * What every statement in one request reads under: an FTS expression
 * to match, or an FTS expression naming the documents to remove. Match
 * mode fills the first (exclusions ride inside it); browse mode fills
 * the second, or neither.
 */
interface ReadQuery {
  match: string | null;
  exclude: string | null;
}

/**
 * Run one category's reads under the bad-syntax policy: the compiled
 * expression, then once more with the sanitised positives-only retry,
 * then give up on that category with `fallback` and a logged error.
 * Quoting-by-construction makes the retry near-unreachable — only the
 * verbatim phrase box can still hand FTS5 something it rejects — but
 * near-unreachable is not unreachable, and the net is cheap. A browse
 * read passes no retry: there is no positive side to salvage.
 *
 * Every statement for a category runs inside ONE attempt, so its count
 * and its rows always come from the same expression — a count from the
 * first attempt beside rows from the retry would be a quiet lie.
 */
async function attempt<T>(
  category: SearchCategory,
  query: ReadQuery,
  retry: string | null,
  fallback: T,
  run: (query: ReadQuery) => Promise<T>,
): Promise<T> {
  try {
    return await run(query);
  } catch (firstError) {
    // A browse read (no match side) has no syntax to salvage — its
    // expressions are quoted by construction — so anything that fails
    // here is infrastructure. An infrastructure failure must surface
    // as one, never as an authoritative zero-result page.
    if (query.match === null) throw firstError;
    if (retry === null) {
      console.error(
        `Global search: ${category} match failed and nothing survived sanitising`,
        firstError,
      );
      return fallback;
    }
    try {
      return await run({ match: retry, exclude: query.exclude });
    } catch (retryError) {
      console.error(
        `Global search: ${category} match failed on both the compiled and the sanitised expression`,
        firstError,
        retryError,
      );
      return fallback;
    }
  }
}

/** Rows as D1 hands them back, before camelCasing. */
interface RawDescriptionRow {
  id: string;
  reference_code: string;
  description_level: string;
  date_expression: string | null;
  title_marked: string | null;
  scope_snippet: string | null;
}

interface RawEntityRow {
  id: string;
  display_name: string;
  entity_code: string | null;
  entity_type: string;
  primary_function: string | null;
}

interface RawPlaceRow {
  id: string;
  display_name: string;
  place_code: string | null;
  place_type: string | null;
}

interface RawCountRow {
  total: number;
}

interface RawValueCountRow {
  value: string | null;
  total: number;
}

interface RawRepositoryCountRow {
  id: string;
  name: string;
  total: number;
}

/**
 * A snippet whose only content was the markers themselves (or none at
 * all, which is what `snippet()` returns for a NULL column) carries no
 * information, so it becomes an absence rather than an empty string.
 */
function snippetOrNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const stripped = value.split(HIGHLIGHT_OPEN).join("").split(HIGHLIGHT_CLOSE).join("");
  return stripped.trim().length > 0 ? value : null;
}

/** One group's selected values as a parameterised IN list. */
function inList(values: string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

// --- sorting --------------------------------------------------------

type ResolvedRecordSort = { key: RecordSortKey; dir: SortDir };
type ResolvedNameSort = { key: NameSortKey; dir: SortDir };

/**
 * Resolve a requested record sort against the mode. Anything that is
 * not one of the four keys — including a name-index key sent to the
 * record index — falls to the mode's default, and relevance falls with
 * it while browsing, where there is no bm25 to order by.
 */
function resolveRecordSort(
  sort: SortSpec | null | undefined,
  matching: boolean,
): ResolvedRecordSort {
  const dir: SortDir = sort?.dir === "desc" ? "desc" : "asc";
  const key = sort?.key;
  if (key === "date" || key === "title" || key === "code") return { key, dir };
  return matching ? { key: "relevance", dir: "asc" } : { key: "code", dir: "asc" };
}

/** The same resolution for the name indexes, whose default is a name. */
function resolveNameSort(
  sort: SortSpec | null | undefined,
  matching: boolean,
): ResolvedNameSort {
  const dir: SortDir = sort?.dir === "desc" ? "desc" : "asc";
  const key = sort?.key;
  if (key === "name" || key === "code") return { key, dir };
  return matching ? { key: "relevance", dir: "asc" } : { key: "name", dir: "asc" };
}

/**
 * The record ORDER BY, chosen from a closed set. Every fragment is a
 * literal — the caller's key selects one, it never becomes one. Rows
 * break ties on the id so a page boundary cannot show the same row
 * twice, and missing dates sort last whichever direction is asked for.
 */
function descriptionOrderSql(sort: ResolvedRecordSort): SQL {
  switch (sort.key) {
    case "date":
      return sort.dir === "desc"
        ? sql` ORDER BY (d.date_start IS NULL), d.date_start DESC, d.id ASC`
        : sql` ORDER BY (d.date_start IS NULL), d.date_start ASC, d.id ASC`;
    case "title":
      return sort.dir === "desc"
        ? sql` ORDER BY d.title COLLATE NOCASE DESC, d.id ASC`
        : sql` ORDER BY d.title COLLATE NOCASE ASC, d.id ASC`;
    case "code":
      return sort.dir === "desc"
        ? sql` ORDER BY d.reference_code DESC, d.id ASC`
        : sql` ORDER BY d.reference_code ASC, d.id ASC`;
    case "relevance":
      return sql` ORDER BY bm25(f.descriptions_fts), d.id ASC`;
  }
}

function entityOrderSql(sort: ResolvedNameSort): SQL {
  switch (sort.key) {
    case "name":
      // sort_name is the archival sort form ("Apellido, Nombre") the
      // entities admin maintains for exactly this — display_name would
      // order a person list by first name.
      return sort.dir === "desc"
        ? sql` ORDER BY e.sort_name COLLATE NOCASE DESC, e.id ASC`
        : sql` ORDER BY e.sort_name COLLATE NOCASE ASC, e.id ASC`;
    case "code":
      return sort.dir === "desc"
        ? sql` ORDER BY (e.entity_code IS NULL), e.entity_code DESC, e.id ASC`
        : sql` ORDER BY (e.entity_code IS NULL), e.entity_code ASC, e.id ASC`;
    case "relevance":
      return sql` ORDER BY bm25(f.entities_fts), e.id ASC`;
  }
}

function placeOrderSql(sort: ResolvedNameSort): SQL {
  switch (sort.key) {
    case "name":
      return sort.dir === "desc"
        ? sql` ORDER BY p.display_name COLLATE NOCASE DESC, p.id ASC`
        : sql` ORDER BY p.display_name COLLATE NOCASE ASC, p.id ASC`;
    case "code":
      return sort.dir === "desc"
        ? sql` ORDER BY (p.place_code IS NULL), p.place_code DESC, p.id ASC`
        : sql` ORDER BY (p.place_code IS NULL), p.place_code ASC, p.id ASC`;
    case "relevance":
      return sql` ORDER BY bm25(f.places_fts), p.id ASC`;
  }
}

// --- descriptions -------------------------------------------------

/** Which record facet group is being counted, and so left out of it. */
type RecordFacetGroup = "levels" | "repoIds";

/**
 * The asked-for span as two 4-digit year bounds, or nulls where the
 * question is open-ended. The years travel as BINDINGS — a year is a
 * value, and no value is ever written into a statement.
 */
function dateBounds(facets: GlobalSearchFacets): {
  lower: string | null;
  upper: string | null;
} {
  return {
    lower: facets.dateFrom || null,
    upper: facets.dateTo || null,
  };
}

/**
 * The date range as an OVERLAP predicate: the record's own span has to
 * meet the asked-for one, so it starts no later than the range ends and
 * ends no earlier than the range begins. The comparison is on the YEAR
 * alone — substr(date, 1, 4) against the bound — because the stored
 * dates are not uniformly day-precise: the corpus carries year-only
 * ('1700') and year-month ('1700-05') values beside full ISO ones, and
 * a lexicographic compare against a full ISO bound would silently drop
 * a year-only record from a range that begins in its own year
 * ('1700' < '1700-01-01'). Year granularity is also what a from/to
 * YEAR question actually means.
 *
 * A record's end date stands in for its start when it has none (a
 * single-dated record is a span of one), and NULLIF folds the empty
 * string into that same absence on BOTH columns — an empty start would
 * otherwise slip past the null guard and compare before every bound. A
 * record with no usable start date cannot be placed on the timeline,
 * so it drops out while either bound is active.
 *
 * The clause belongs to no facet GROUP: nothing counts date values, so
 * it never short-circuits and narrows every record read alike.
 */
function descriptionDateClause(facets: GlobalSearchFacets): SQL {
  const { lower, upper } = dateBounds(facets);
  if (lower === null && upper === null) return sql``;
  const startsInTime =
    upper === null
      ? sql``
      : sql` AND substr(d.date_start, 1, 4) <= ${upper}`;
  const endsInTime =
    lower === null
      ? sql``
      : sql` AND substr(COALESCE(NULLIF(d.date_end, ''), d.date_start), 1, 4) >= ${lower}`;
  return sql` AND NULLIF(d.date_start, '') IS NOT NULL${startsInTime}${endsInTime}`;
}

/** The record facets, as IN-list clauses that vanish when unset. */
function descriptionFacetClauses(
  facets: GlobalSearchFacets,
  omit?: RecordFacetGroup,
): SQL {
  const levels =
    omit !== "levels" && facets.levels && facets.levels.length > 0
      ? sql` AND d.description_level IN (${inList(facets.levels)})`
      : sql``;
  const repos =
    omit !== "repoIds" && facets.repoIds && facets.repoIds.length > 0
      ? sql` AND d.repository_id IN (${inList(facets.repoIds)})`
      : sql``;
  return sql`${levels}${repos}${descriptionDateClause(facets)}`;
}

function hasDescriptionFacets(facets: GlobalSearchFacets): boolean {
  return Boolean(
    facets.levels?.length || facets.repoIds?.length || facets.dateFrom || facets.dateTo,
  );
}

/** Whether either end of the date range is asked for. */
function hasDateBounds(facets: GlobalSearchFacets): boolean {
  return Boolean(facets.dateFrom || facets.dateTo);
}

/** The FTS join, present only when something is being matched. */
function descriptionJoin(query: ReadQuery): SQL {
  return query.match === null
    ? sql``
    : sql` INNER JOIN descriptions_fts f ON f.rowid = d.rowid`;
}

function descriptionMatch(query: ReadQuery): SQL {
  return query.match === null ? sql`` : sql` AND f.descriptions_fts MATCH ${query.match}`;
}

/** Browse-mode subtraction; self-scoping, for the reasons up top. */
function descriptionExclusion(scope: GlobalSearchScope, query: ReadQuery): SQL {
  return query.exclude === null
    ? sql``
    : sql` AND d.tenant_id = ${scope.tenantId} AND d.rowid NOT IN (SELECT rowid FROM descriptions_fts WHERE descriptions_fts MATCH ${query.exclude})`;
}

/**
 * The within-handlist narrowing: membership as a subquery on the
 * handlist id, so ONE binding stands for however many members the set
 * holds. A materialised id list would blow D1's binding cap on any
 * handlist worth searching, and would also mean the search believed a
 * list of ids handed to it rather than the membership table.
 *
 * The subquery only ever REMOVES rows, and the statement it joins keeps
 * its own scope predicate untouched: a member id belonging to another
 * tenant's record cannot arrive here as a row, because the tenant
 * predicate beside it still has to hold. The handlist itself was
 * resolved under its own visibility rule before its id reached this
 * module.
 */
function descriptionHandlistClause(scope: GlobalSearchScope): SQL {
  return scope.handlistId == null
    ? sql``
    : sql` AND d.id IN (SELECT member_id FROM handlist_members WHERE handlist_id = ${scope.handlistId})`;
}

/** Marked title and snippet when matching; the plain title when not. */
function descriptionMarkedColumns(query: ReadQuery): SQL {
  return query.match === null
    ? sql`d.title AS title_marked, NULL AS scope_snippet`
    : sql`highlight(f.descriptions_fts, 1, ${HIGHLIGHT_OPEN}, ${HIGHLIGHT_CLOSE}) AS title_marked,
           snippet(f.descriptions_fts, 2, ${HIGHLIGHT_OPEN}, ${HIGHLIGHT_CLOSE}, ${SNIPPET_ELLIPSIS}, ${SNIPPET_TOKENS}) AS scope_snippet`;
}

async function countDescriptions(
  db: DrizzleD1Database<any>,
  scope: GlobalSearchScope,
  query: ReadQuery,
  facets: GlobalSearchFacets,
): Promise<number> {
  const rows = (await db.all(sql`
    SELECT count(*) AS total
    FROM descriptions d${descriptionJoin(query)}
    WHERE d.tenant_id = ${scope.tenantId}${descriptionMatch(query)}${descriptionExclusion(scope, query)}${descriptionFacetClauses(facets)}${descriptionHandlistClause(scope)}
  `)) as RawCountRow[];
  return Number(rows[0]?.total ?? 0);
}

async function selectDescriptions(
  db: DrizzleD1Database<any>,
  scope: GlobalSearchScope,
  query: ReadQuery,
  facets: GlobalSearchFacets,
  sort: ResolvedRecordSort,
  limit: number,
  offset: number,
): Promise<DescriptionHit[]> {
  const rows = (await db.all(sql`
    SELECT d.id AS id,
           d.reference_code AS reference_code,
           d.description_level AS description_level,
           d.date_expression AS date_expression,
           ${descriptionMarkedColumns(query)}
    FROM descriptions d${descriptionJoin(query)}
    WHERE d.tenant_id = ${scope.tenantId}${descriptionMatch(query)}${descriptionExclusion(scope, query)}${descriptionFacetClauses(facets)}${descriptionHandlistClause(scope)}
    ${descriptionOrderSql(sort)}
    LIMIT ${limit} OFFSET ${offset}
  `)) as RawDescriptionRow[];

  return rows.map((row) => ({
    id: row.id,
    referenceCode: row.reference_code,
    titleMarked: row.title_marked ?? "",
    scopeSnippet: snippetOrNull(row.scope_snippet),
    level: row.description_level,
    dateExpression: row.date_expression,
  }));
}

async function countLevelFacet(
  db: DrizzleD1Database<any>,
  scope: GlobalSearchScope,
  query: ReadQuery,
  facets: GlobalSearchFacets,
): Promise<FacetValueCount[]> {
  const rows = (await db.all(sql`
    SELECT d.description_level AS value, count(*) AS total
    FROM descriptions d${descriptionJoin(query)}
    WHERE d.tenant_id = ${scope.tenantId}${descriptionMatch(query)}${descriptionExclusion(scope, query)}${descriptionFacetClauses(facets, "levels")}${descriptionHandlistClause(scope)}
    GROUP BY d.description_level
    ORDER BY count(*) DESC, d.description_level ASC
  `)) as RawValueCountRow[];
  return toValueCounts(rows);
}

async function countRepositoryFacet(
  db: DrizzleD1Database<any>,
  scope: GlobalSearchScope,
  query: ReadQuery,
  facets: GlobalSearchFacets,
): Promise<RepositoryFacetCount[]> {
  const rows = (await db.all(sql`
    SELECT r.id AS id, r.name AS name, count(*) AS total
    FROM descriptions d${descriptionJoin(query)}
    INNER JOIN repositories r ON r.id = d.repository_id AND r.tenant_id = ${scope.tenantId}
    WHERE d.tenant_id = ${scope.tenantId}${descriptionMatch(query)}${descriptionExclusion(scope, query)}${descriptionFacetClauses(facets, "repoIds")}${descriptionHandlistClause(scope)}
    GROUP BY r.id, r.name
    ORDER BY count(*) DESC, r.name ASC
  `)) as RawRepositoryCountRow[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    count: Number(row.total ?? 0),
  }));
}

// --- entities -----------------------------------------------------

type EntityFacetGroup = "entityTypes" | "fns";

function entityFacetClauses(
  facets: GlobalSearchFacets,
  omit?: EntityFacetGroup,
): SQL {
  const types =
    omit !== "entityTypes" && facets.entityTypes && facets.entityTypes.length > 0
      ? sql` AND e.entity_type IN (${inList(facets.entityTypes)})`
      : sql``;
  const fns =
    omit !== "fns" && facets.fns && facets.fns.length > 0
      ? sql` AND e.primary_function IN (${inList(facets.fns)})`
      : sql``;
  return sql`${types}${fns}`;
}

function hasEntityFacets(facets: GlobalSearchFacets): boolean {
  return Boolean(facets.entityTypes?.length || facets.fns?.length);
}

function entityJoin(query: ReadQuery): SQL {
  return query.match === null
    ? sql``
    : sql` INNER JOIN entities_fts f ON f.rowid = e.rowid`;
}

function entityMatch(query: ReadQuery): SQL {
  return query.match === null ? sql`` : sql` AND f.entities_fts MATCH ${query.match}`;
}

function entityExclusion(scope: GlobalSearchScope, query: ReadQuery): SQL {
  return query.exclude === null
    ? sql``
    : sql` AND ${authorityScopeSql("e", scope.federationId, scope.tenantId)} AND e.merged_into IS NULL AND e.rowid NOT IN (SELECT rowid FROM entities_fts WHERE entities_fts MATCH ${query.exclude})`;
}

/** The within-handlist narrowing; see `descriptionHandlistClause`. */
function entityHandlistClause(scope: GlobalSearchScope): SQL {
  return scope.handlistId == null
    ? sql``
    : sql` AND e.id IN (SELECT member_id FROM handlist_members WHERE handlist_id = ${scope.handlistId})`;
}

async function countEntities(
  db: DrizzleD1Database<any>,
  scope: GlobalSearchScope,
  query: ReadQuery,
  facets: GlobalSearchFacets,
): Promise<number> {
  const rows = (await db.all(sql`
    SELECT count(*) AS total
    FROM entities e${entityJoin(query)}
    WHERE ${authorityScopeSql("e", scope.federationId, scope.tenantId)}
    AND e.merged_into IS NULL${entityMatch(query)}${entityExclusion(scope, query)}${entityFacetClauses(facets)}${entityHandlistClause(scope)}
  `)) as RawCountRow[];
  return Number(rows[0]?.total ?? 0);
}

async function selectEntities(
  db: DrizzleD1Database<any>,
  scope: GlobalSearchScope,
  query: ReadQuery,
  facets: GlobalSearchFacets,
  sort: ResolvedNameSort,
  limit: number,
  offset: number,
): Promise<EntityHit[]> {
  const rows = (await db.all(sql`
    SELECT e.id AS id,
           e.display_name AS display_name,
           e.entity_code AS entity_code,
           e.entity_type AS entity_type,
           e.primary_function AS primary_function
    FROM entities e${entityJoin(query)}
    WHERE ${authorityScopeSql("e", scope.federationId, scope.tenantId)}
    AND e.merged_into IS NULL${entityMatch(query)}${entityExclusion(scope, query)}${entityFacetClauses(facets)}${entityHandlistClause(scope)}
    ${entityOrderSql(sort)}
    LIMIT ${limit} OFFSET ${offset}
  `)) as RawEntityRow[];

  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    entityCode: row.entity_code,
    entityType: row.entity_type,
    primaryFunction: row.primary_function,
  }));
}

async function countEntityTypeFacet(
  db: DrizzleD1Database<any>,
  scope: GlobalSearchScope,
  query: ReadQuery,
  facets: GlobalSearchFacets,
): Promise<FacetValueCount[]> {
  const rows = (await db.all(sql`
    SELECT e.entity_type AS value, count(*) AS total
    FROM entities e${entityJoin(query)}
    WHERE ${authorityScopeSql("e", scope.federationId, scope.tenantId)}
    AND e.merged_into IS NULL${entityMatch(query)}${entityExclusion(scope, query)}${entityFacetClauses(facets, "entityTypes")}${entityHandlistClause(scope)}
    GROUP BY e.entity_type
    ORDER BY count(*) DESC, e.entity_type ASC
  `)) as RawValueCountRow[];
  return toValueCounts(rows);
}

async function countFnFacet(
  db: DrizzleD1Database<any>,
  scope: GlobalSearchScope,
  query: ReadQuery,
  facets: GlobalSearchFacets,
): Promise<FacetValueCount[]> {
  const rows = (await db.all(sql`
    SELECT e.primary_function AS value, count(*) AS total
    FROM entities e${entityJoin(query)}
    WHERE ${authorityScopeSql("e", scope.federationId, scope.tenantId)}
    AND e.merged_into IS NULL
    AND e.primary_function IS NOT NULL${entityMatch(query)}${entityExclusion(scope, query)}${entityFacetClauses(facets, "fns")}${entityHandlistClause(scope)}
    GROUP BY e.primary_function
    ORDER BY count(*) DESC, e.primary_function ASC
  `)) as RawValueCountRow[];
  return toValueCounts(rows);
}

// --- places -------------------------------------------------------

function placeFacetClauses(facets: GlobalSearchFacets, omit?: "placeTypes"): SQL {
  return omit !== "placeTypes" && facets.placeTypes && facets.placeTypes.length > 0
    ? sql` AND p.place_type IN (${inList(facets.placeTypes)})`
    : sql``;
}

function hasPlaceFacets(facets: GlobalSearchFacets): boolean {
  return Boolean(facets.placeTypes?.length);
}

function placeJoin(query: ReadQuery): SQL {
  return query.match === null
    ? sql``
    : sql` INNER JOIN places_fts f ON f.rowid = p.rowid`;
}

function placeMatch(query: ReadQuery): SQL {
  return query.match === null ? sql`` : sql` AND f.places_fts MATCH ${query.match}`;
}

function placeExclusion(scope: GlobalSearchScope, query: ReadQuery): SQL {
  return query.exclude === null
    ? sql``
    : sql` AND ${authorityScopeSql("p", scope.federationId, scope.tenantId)} AND p.merged_into IS NULL AND p.rowid NOT IN (SELECT rowid FROM places_fts WHERE places_fts MATCH ${query.exclude})`;
}

/** The within-handlist narrowing; see `descriptionHandlistClause`. */
function placeHandlistClause(scope: GlobalSearchScope): SQL {
  return scope.handlistId == null
    ? sql``
    : sql` AND p.id IN (SELECT member_id FROM handlist_members WHERE handlist_id = ${scope.handlistId})`;
}

async function countPlaces(
  db: DrizzleD1Database<any>,
  scope: GlobalSearchScope,
  query: ReadQuery,
  facets: GlobalSearchFacets,
): Promise<number> {
  const rows = (await db.all(sql`
    SELECT count(*) AS total
    FROM places p${placeJoin(query)}
    WHERE ${authorityScopeSql("p", scope.federationId, scope.tenantId)}
    AND p.merged_into IS NULL${placeMatch(query)}${placeExclusion(scope, query)}${placeFacetClauses(facets)}${placeHandlistClause(scope)}
  `)) as RawCountRow[];
  return Number(rows[0]?.total ?? 0);
}

async function selectPlaces(
  db: DrizzleD1Database<any>,
  scope: GlobalSearchScope,
  query: ReadQuery,
  facets: GlobalSearchFacets,
  sort: ResolvedNameSort,
  limit: number,
  offset: number,
): Promise<PlaceHit[]> {
  const rows = (await db.all(sql`
    SELECT p.id AS id,
           p.display_name AS display_name,
           p.place_code AS place_code,
           p.place_type AS place_type
    FROM places p${placeJoin(query)}
    WHERE ${authorityScopeSql("p", scope.federationId, scope.tenantId)}
    AND p.merged_into IS NULL${placeMatch(query)}${placeExclusion(scope, query)}${placeFacetClauses(facets)}${placeHandlistClause(scope)}
    ${placeOrderSql(sort)}
    LIMIT ${limit} OFFSET ${offset}
  `)) as RawPlaceRow[];

  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    placeCode: row.place_code,
    placeType: row.place_type,
  }));
}

async function countPlaceTypeFacet(
  db: DrizzleD1Database<any>,
  scope: GlobalSearchScope,
  query: ReadQuery,
  facets: GlobalSearchFacets,
): Promise<FacetValueCount[]> {
  const rows = (await db.all(sql`
    SELECT p.place_type AS value, count(*) AS total
    FROM places p${placeJoin(query)}
    WHERE ${authorityScopeSql("p", scope.federationId, scope.tenantId)}
    AND p.merged_into IS NULL
    AND p.place_type IS NOT NULL${placeMatch(query)}${placeExclusion(scope, query)}${placeFacetClauses(facets, "placeTypes")}${placeHandlistClause(scope)}
    GROUP BY p.place_type
    ORDER BY count(*) DESC, p.place_type ASC
  `)) as RawValueCountRow[];
  return toValueCounts(rows);
}

// --- facet counts ---------------------------------------------------

/** Group rows, with the NULL bucket a GROUP BY can still produce out. */
function toValueCounts(rows: RawValueCountRow[]): FacetValueCount[] {
  const counts: FacetValueCount[] = [];
  for (const row of rows) {
    if (row.value == null) continue;
    counts.push({ value: row.value, count: Number(row.total ?? 0) });
  }
  return counts;
}

/**
 * The function group is the one long tail in the sidebar, so it shows
 * the commonest values and stops. A value the person has already
 * checked stays visible below the cut whatever its rank, with its real
 * count — a checkbox that vanishes when checked cannot be unchecked.
 */
function trimFnFacet(
  all: FacetValueCount[],
  selected: string[] | undefined,
): FacetValueCount[] {
  const top = all.slice(0, FN_FACET_LIMIT);
  if (!selected || selected.length === 0) return top;
  const shown = new Set(top.map((entry) => entry.value));
  const extra: FacetValueCount[] = [];
  for (const value of selected) {
    if (shown.has(value)) continue;
    shown.add(value);
    extra.push(all.find((entry) => entry.value === value) ?? { value, count: 0 });
  }
  return [...top, ...extra];
}

/**
 * Every sidebar group for every in-scope category, in one pass. The
 * statements are independent, so they all start before any is awaited.
 */
async function collectFacetCounts(
  db: DrizzleD1Database<any>,
  scope: GlobalSearchScope,
  query: ReadQuery,
  retry: string | null,
  facets: GlobalSearchFacets,
  authorities: boolean,
): Promise<FacetCounts> {
  const levelsP = attempt("descriptions", query, retry, [] as FacetValueCount[], (q) =>
    countLevelFacet(db, scope, q, facets),
  );
  const reposP = attempt(
    "descriptions",
    query,
    retry,
    [] as RepositoryFacetCount[],
    (q) => countRepositoryFacet(db, scope, q, facets),
  );
  const typesP = authorities
    ? attempt("entities", query, retry, [] as FacetValueCount[], (q) =>
        countEntityTypeFacet(db, scope, q, facets),
      )
    : null;
  const fnsP = authorities
    ? attempt("entities", query, retry, [] as FacetValueCount[], (q) =>
        countFnFacet(db, scope, q, facets),
      )
    : null;
  const placeTypesP = authorities
    ? attempt("places", query, retry, [] as FacetValueCount[], (q) =>
        countPlaceTypeFacet(db, scope, q, facets),
      )
    : null;

  const counts: FacetCounts = {
    levels: await levelsP,
    repositories: await reposP,
  };
  if (typesP && fnsP && placeTypesP) {
    counts.entityTypes = await typesP;
    counts.fns = trimFnFacet(await fnsP, facets.fns);
    counts.placeTypes = await placeTypesP;
  }
  return counts;
}

// --- the search itself ---------------------------------------------

/** No facets at all — the shape the tab counts are always taken under. */
const NO_FACETS: GlobalSearchFacets = {};

/** A query that asks for nothing, for the caller that hands over null. */
const NO_QUERY: ParsedSearch = { q: "", phrase: false, refinements: [] };

/**
 * What a caller may ask with: the pills query model, the advanced
 * form's rows, or nothing. An array is always the advanced grammar —
 * empty included, which asks as little as a blank box does.
 */
export type SearchQueryInput = ParsedSearch | AdvancedRow[] | null;

/**
 * What one request's expressions came out as, compiled once. Every
 * read in a request shares this: the mode, the expression that drives
 * it, the sanitised retry the bad-syntax policy may fall back to, and
 * the two grammars' parsed forms, which the authority-reach rule below
 * still has questions for.
 */
interface CompiledRead {
  advancedRows: AdvancedRow[] | null;
  parsedQuery: ParsedSearch;
  matching: boolean;
  mode: GlobalSearchResult["mode"];
  query: ReadQuery;
  retry: string | null;
  /** Nothing is being asked for at all — the landing question. */
  blank: boolean;
}

/**
 * Compile whatever the caller asked with into the one expression every
 * statement in the request runs under. The advanced grammar and the
 * pills grammar are mutually exclusive: an array is the one, anything
 * else is the other. Whichever arrives, everything downstream sees only
 * a compiled expression.
 */
function compileRead(input: SearchQueryInput): CompiledRead {
  const advancedRows: AdvancedRow[] | null = Array.isArray(input) ? input : null;
  const parsedQuery: ParsedSearch = Array.isArray(input) ? NO_QUERY : (input ?? NO_QUERY);
  const primary =
    advancedRows === null
      ? compileFtsExpression(parsedQuery)
      : compileAdvancedExpression(advancedRows);
  const matching = primary !== null;
  const query: ReadQuery = matching
    ? { match: primary, exclude: null }
    : {
        match: null,
        // An advanced query with no rows excludes nothing; the anchor
        // rule means a query WITH rows always has a positive side, so
        // the advanced path never reaches the NOT IN subtraction.
        exclude:
          advancedRows === null ? compileExclusionExpression(parsedQuery) : null,
      };
  return {
    advancedRows,
    parsedQuery,
    matching,
    mode: matching ? "match" : "browse",
    query,
    // Quoted by construction, with no verbatim phrase box to salvage:
    // an advanced expression FTS5 rejects has no plainer form to retry.
    retry:
      matching && advancedRows === null ? sanitisedFallbackExpression(parsedQuery) : null,
    blank: advancedRows === null ? isBlank(parsedQuery) : advancedRows.length === 0,
  };
}

/**
 * Whether the name indexes are in play at all. Three things narrow the
 * effective authority scope to false whatever the caller's gate said: a
 * field-scoped refinement, a field-scoped advanced row, and a date
 * bound. Only records have columns for a field scope and only records
 * have dates, so each of those asks the name indexes something they
 * have no column to answer.
 */
function authorityReach(
  scope: GlobalSearchScope,
  read: CompiledRead,
  facets: GlobalSearchFacets,
): boolean {
  return (
    scope.includeAuthorities &&
    !hasFieldRefinements(read.parsedQuery) &&
    !(read.advancedRows !== null && hasAdvancedFieldRows(read.advancedRows)) &&
    !hasDateBounds(facets)
  );
}

/**
 * Answer one search.
 *
 * `scope` is the request's visibility as the caller's gates resolved
 * it: the tenant whose records are readable, the federation whose
 * authorities are, and whether authorities are reachable at all.
 *
 * A blank query on the combined view is the LANDING state: no category
 * is read at all, and what comes back is the sidebar — corpus-wide
 * facet counts under the scope alone. Every other shape runs reads,
 * matching or browsing.
 *
 * Three things narrow the effective authority scope to false: a
 * field-scoped refinement, a field-scoped advanced row, and a date
 * bound. Only records have columns for a field scope and only records
 * have dates, so in each case the name-index categories go ABSENT
 * (undefined counts, empty previews, no facet groups) — the same shape
 * a capability gate produces.
 *
 * Asking for `entities` or `places` while authorities are out of
 * scope — gated out by the caller, or forced out by any of those
 * three — is a caller bug: the gate should have coerced the category
 * before it got here, and this throws rather than quietly answering a
 * question the viewer was not allowed to ask.
 */
export async function runGlobalSearch(
  db: DrizzleD1Database<any>,
  scope: GlobalSearchScope,
  input: SearchQueryInput,
  view: GlobalSearchView,
): Promise<GlobalSearchResult> {
  const read = compileRead(input);
  const { matching, mode, query, retry, blank } = read;

  const facets = view.category === "all" ? NO_FACETS : (view.facets ?? NO_FACETS);
  const sort = view.category === "all" ? null : view.sort;

  const authorities = authorityReach(scope, read, facets);
  if (view.category !== "all" && view.category !== "descriptions" && !authorities) {
    throw new Error(
      `Global search asked for the "${view.category}" category with authorities out of scope`,
    );
  }

  // The sidebar is the one thing every shape returns, so its
  // statements go out first and are awaited last.
  const facetCountsP = collectFacetCounts(db, scope, query, retry, facets, authorities);

  // Landing: nothing is being asked of any category, so nothing is
  // read from one. The sidebar still answers, which is what makes the
  // blank state browsable rather than empty.
  if (view.category === "all" && blank) {
    return { counts: {}, facetCounts: await facetCountsP, mode };
  }

  // The tab numbers: one facet-free count per included category, so a
  // facet narrowing one category never moves another's number.
  const counts: GlobalSearchResult["counts"] = {};

  if (view.category === "all") {
    const recordSort = resolveRecordSort(null, matching);
    const nameSort = resolveNameSort(null, matching);
    // The three categories are independent reads against independent
    // indexes, and each D1 call is its own network round trip — start
    // every attempt before awaiting any, so wall-clock is the slowest
    // category rather than the sum of all of them.
    const recordsP = attempt(
      "descriptions",
      query,
      retry,
      { count: 0, rows: [] as DescriptionHit[] },
      async (q) => ({
        count: await countDescriptions(db, scope, q, NO_FACETS),
        rows: await selectDescriptions(
          db,
          scope,
          q,
          NO_FACETS,
          recordSort,
          SEARCH_PREVIEW_LIMIT,
          0,
        ),
      }),
    );
    const entitiesP = authorities
      ? attempt(
          "entities",
          query,
          retry,
          { count: 0, rows: [] as EntityHit[] },
          async (q) => ({
            count: await countEntities(db, scope, q, NO_FACETS),
            rows: await selectEntities(
              db,
              scope,
              q,
              NO_FACETS,
              nameSort,
              SEARCH_PREVIEW_LIMIT,
              0,
            ),
          }),
        )
      : null;
    const placesP = authorities
      ? attempt(
          "places",
          query,
          retry,
          { count: 0, rows: [] as PlaceHit[] },
          async (q) => ({
            count: await countPlaces(db, scope, q, NO_FACETS),
            rows: await selectPlaces(
              db,
              scope,
              q,
              NO_FACETS,
              nameSort,
              SEARCH_PREVIEW_LIMIT,
              0,
            ),
          }),
        )
      : null;

    const records = await recordsP;
    counts.descriptions = records.count;

    let entityRows: EntityHit[] = [];
    let placeRows: PlaceHit[] = [];
    if (entitiesP && placesP) {
      const found = await entitiesP;
      counts.entities = found.count;
      entityRows = found.rows;
      const places = await placesP;
      counts.places = places.count;
      placeRows = places.rows;
    }

    return {
      counts,
      facetCounts: await facetCountsP,
      mode,
      preview: {
        descriptions: records.rows,
        entities: entityRows,
        places: placeRows,
      },
    };
  }

  // The caller validates the page number, but a non-finite one would
  // reach SQLite as an OFFSET binding it cannot make sense of, so it
  // resolves to the first page here rather than failing the read.
  const pageNumber = Number.isFinite(view.page)
    ? Math.max(1, Math.floor(view.page))
    : 1;
  const offset = (pageNumber - 1) * SEARCH_PAGE_SIZE;

  // Records: the selected category's own reads carry its facets and
  // its honest total; the other categories contribute their tab count.
  if (view.category === "descriptions") {
    const recordSort = resolveRecordSort(sort, matching);
    // Same concurrency posture as the "all" view: the sibling tab
    // counts do not depend on the selected category's reads.
    const selectedP = attempt(
      "descriptions",
      query,
      retry,
      { count: 0, total: 0, rows: [] as DescriptionHit[] },
      async (q) => {
        const count = await countDescriptions(db, scope, q, NO_FACETS);
        const total = hasDescriptionFacets(facets)
          ? await countDescriptions(db, scope, q, facets)
          : count;
        const rows = await selectDescriptions(
          db,
          scope,
          q,
          facets,
          recordSort,
          SEARCH_PAGE_SIZE,
          offset,
        );
        return { count, total, rows };
      },
    );
    const entitiesCountP = authorities
      ? attempt("entities", query, retry, 0, (q) =>
          countEntities(db, scope, q, NO_FACETS),
        )
      : null;
    const placesCountP = authorities
      ? attempt("places", query, retry, 0, (q) => countPlaces(db, scope, q, NO_FACETS))
      : null;
    const selected = await selectedP;
    counts.descriptions = selected.count;
    if (entitiesCountP && placesCountP) {
      counts.entities = await entitiesCountP;
      counts.places = await placesCountP;
    }
    return {
      counts,
      facetCounts: await facetCountsP,
      mode,
      page: {
        category: "descriptions",
        rows: selected.rows,
        total: selected.total,
        pageNumber,
      },
    };
  }

  const nameSort = resolveNameSort(sort, matching);
  const descriptionsCountP = attempt("descriptions", query, retry, 0, (q) =>
    countDescriptions(db, scope, q, NO_FACETS),
  );

  if (view.category === "entities") {
    const selectedP = attempt(
      "entities",
      query,
      retry,
      { count: 0, total: 0, rows: [] as EntityHit[] },
      async (q) => {
        const count = await countEntities(db, scope, q, NO_FACETS);
        const total = hasEntityFacets(facets)
          ? await countEntities(db, scope, q, facets)
          : count;
        const rows = await selectEntities(
          db,
          scope,
          q,
          facets,
          nameSort,
          SEARCH_PAGE_SIZE,
          offset,
        );
        return { count, total, rows };
      },
    );
    const placesCountP = attempt("places", query, retry, 0, (q) =>
      countPlaces(db, scope, q, NO_FACETS),
    );
    const selected = await selectedP;
    counts.descriptions = await descriptionsCountP;
    counts.entities = selected.count;
    counts.places = await placesCountP;
    return {
      counts,
      facetCounts: await facetCountsP,
      mode,
      page: {
        category: "entities",
        rows: selected.rows,
        total: selected.total,
        pageNumber,
      },
    };
  }

  const selectedP = attempt(
    "places",
    query,
    retry,
    { count: 0, total: 0, rows: [] as PlaceHit[] },
    async (q) => {
      const count = await countPlaces(db, scope, q, NO_FACETS);
      const total = hasPlaceFacets(facets)
        ? await countPlaces(db, scope, q, facets)
        : count;
      const rows = await selectPlaces(
        db,
        scope,
        q,
        facets,
        nameSort,
        SEARCH_PAGE_SIZE,
        offset,
      );
      return { count, total, rows };
    },
  );
  const entitiesCountP = attempt("entities", query, retry, 0, (q) =>
    countEntities(db, scope, q, NO_FACETS),
  );
  const selected = await selectedP;
  counts.descriptions = await descriptionsCountP;
  counts.places = selected.count;
  counts.entities = await entitiesCountP;
  return {
    counts,
    facetCounts: await facetCountsP,
    mode,
    page: {
      category: "places",
      rows: selected.rows,
      total: selected.total,
      pageNumber,
    },
  };
}

// --- id enumeration ------------------------------------------------
//
// A page shows twenty-five rows; a person who takes "all matching"
// takes every row the same question reaches. Answering that needs the
// ids and nothing else, so it is a read of its own rather than a loop
// over paged calls: one statement per category, under the SAME scope,
// expression and facets the page ran, ordered the same way, capped by
// the caller.
//
// Ordering matters even though the caller only keeps a set. The cap can
// truncate — the caller refuses above its own limit, but the LIMIT is
// still written — and a truncated list ordered as the page was is the
// front of what the person was looking at rather than an arbitrary
// slice of it.
//
// The scope rule at the top of this module applies unchanged: each
// statement carries its scope predicate in the same template as its
// FROM, through the same fragments the paged reads use.

interface RawIdRow {
  id: string;
}

async function selectDescriptionIds(
  db: DrizzleD1Database<any>,
  scope: GlobalSearchScope,
  query: ReadQuery,
  facets: GlobalSearchFacets,
  sort: ResolvedRecordSort,
  limit: number,
): Promise<string[]> {
  const rows = (await db.all(sql`
    SELECT d.id AS id
    FROM descriptions d${descriptionJoin(query)}
    WHERE d.tenant_id = ${scope.tenantId}${descriptionMatch(query)}${descriptionExclusion(scope, query)}${descriptionFacetClauses(facets)}${descriptionHandlistClause(scope)}
    ${descriptionOrderSql(sort)}
    LIMIT ${limit}
  `)) as RawIdRow[];
  return rows.map((row) => row.id);
}

async function selectEntityIds(
  db: DrizzleD1Database<any>,
  scope: GlobalSearchScope,
  query: ReadQuery,
  facets: GlobalSearchFacets,
  sort: ResolvedNameSort,
  limit: number,
): Promise<string[]> {
  const rows = (await db.all(sql`
    SELECT e.id AS id
    FROM entities e${entityJoin(query)}
    WHERE ${authorityScopeSql("e", scope.federationId, scope.tenantId)}
    AND e.merged_into IS NULL${entityMatch(query)}${entityExclusion(scope, query)}${entityFacetClauses(facets)}${entityHandlistClause(scope)}
    ${entityOrderSql(sort)}
    LIMIT ${limit}
  `)) as RawIdRow[];
  return rows.map((row) => row.id);
}

async function selectPlaceIds(
  db: DrizzleD1Database<any>,
  scope: GlobalSearchScope,
  query: ReadQuery,
  facets: GlobalSearchFacets,
  sort: ResolvedNameSort,
  limit: number,
): Promise<string[]> {
  const rows = (await db.all(sql`
    SELECT p.id AS id
    FROM places p${placeJoin(query)}
    WHERE ${authorityScopeSql("p", scope.federationId, scope.tenantId)}
    AND p.merged_into IS NULL${placeMatch(query)}${placeExclusion(scope, query)}${placeFacetClauses(facets)}${placeHandlistClause(scope)}
    ${placeOrderSql(sort)}
    LIMIT ${limit}
  `)) as RawIdRow[];
  return rows.map((row) => row.id);
}

/** Every id one category's question reaches, and how many there are. */
export interface MatchedIds {
  /** Up to `limit` ids, in the order the results page shows them. */
  ids: string[];
  /** The honest count under the SAME facets — the page's own total. */
  total: number;
}

/**
 * Enumerate one category's whole result set as ids.
 *
 * This is the paged read's other half: `runGlobalSearch` answers "what
 * is on this page", and this answers "what is in the whole set" for a
 * caller that needs the members rather than the rows — the export
 * carry, which materialises a selection at the moment it is made.
 *
 * It runs under exactly what the page ran under, because it is built
 * out of the same fragments: the same compiled expression and
 * bad-syntax policy, the same tenant and authority scope predicates,
 * the same facet and date clauses, the same ORDER BY. `total` is the
 * count under those facets, so it is the number the page was showing,
 * not the tab count.
 *
 * `limit` caps the array, never the count. A caller that refuses large
 * sets should compare `total` against its own cap rather than measuring
 * `ids`, which the cap may have truncated.
 *
 * Asking for `entities` or `places` when authorities are out of reach —
 * gated out by the caller, or forced out by a field scope or a date
 * bound — throws, exactly as the paged read does: the gate should have
 * coerced the category before it got here.
 */
export async function selectMatchingIds(
  db: DrizzleD1Database<any>,
  scope: GlobalSearchScope,
  input: SearchQueryInput,
  view: {
    category: SearchCategory;
    facets: GlobalSearchFacets;
    /** null = the mode's default, as on the page. */
    sort: SortSpec | null;
    limit: number;
  },
): Promise<MatchedIds> {
  const read = compileRead(input);
  const { matching, query, retry } = read;
  const facets = view.facets ?? NO_FACETS;

  if (view.category !== "descriptions" && !authorityReach(scope, read, facets)) {
    throw new Error(
      `Global search asked to enumerate the "${view.category}" category with authorities out of scope`,
    );
  }

  const empty: MatchedIds = { ids: [], total: 0 };

  if (view.category === "descriptions") {
    const sort = resolveRecordSort(view.sort, matching);
    return attempt("descriptions", query, retry, empty, async (q) => ({
      total: await countDescriptions(db, scope, q, facets),
      ids: await selectDescriptionIds(db, scope, q, facets, sort, view.limit),
    }));
  }

  const sort = resolveNameSort(view.sort, matching);
  if (view.category === "entities") {
    return attempt("entities", query, retry, empty, async (q) => ({
      total: await countEntities(db, scope, q, facets),
      ids: await selectEntityIds(db, scope, q, facets, sort, view.limit),
    }));
  }
  return attempt("places", query, retry, empty, async (q) => ({
    total: await countPlaces(db, scope, q, facets),
    ids: await selectPlaceIds(db, scope, q, facets, sort, view.limit),
  }));
}

/**
 * How many rows one category's question reaches, and nothing else.
 *
 * It exists for the empty state inside a handlist, which has to report
 * the world outside the set it just failed to answer in: "none of this
 * handlist's 42 records — but 61 match in the whole workspace". The
 * caller asks the SAME question with `handlistId` cleared from the
 * scope, so the two numbers are the same query counted on two grounds,
 * and the second costs one statement rather than a whole second search.
 *
 * It is the count half of `selectMatchingIds` and shares every fragment
 * with it, so a number it reports can never mean something the paged
 * read would disagree with.
 */
export async function countMatching(
  db: DrizzleD1Database<any>,
  scope: GlobalSearchScope,
  input: SearchQueryInput,
  view: { category: SearchCategory; facets: GlobalSearchFacets },
): Promise<number> {
  const read = compileRead(input);
  const { query, retry } = read;
  const facets = view.facets ?? NO_FACETS;

  if (view.category !== "descriptions" && !authorityReach(scope, read, facets)) {
    throw new Error(
      `Global search asked to count the "${view.category}" category with authorities out of scope`,
    );
  }

  if (view.category === "descriptions") {
    return attempt("descriptions", query, retry, 0, (q) =>
      countDescriptions(db, scope, q, facets),
    );
  }
  if (view.category === "entities") {
    return attempt("entities", query, retry, 0, (q) =>
      countEntities(db, scope, q, facets),
    );
  }
  return attempt("places", query, retry, 0, (q) =>
    countPlaces(db, scope, q, facets),
  );
}

// --- heading mentions ----------------------------------------------
//
// A different question from the search box, answered by the same index:
// "which records mention THIS heading?" The decisions surface asks it
// of an authority proposal, where the heading is a fixed string the
// producer read off a source rather than something a person typed, and
// the answer is evidence for a ruling rather than a result page.
//
// TWO TIERS, IN ORDER. The phrase tier matches the whole heading as one
// FTS phrase — the only tier whose hits are unambiguous, and the only
// one the count reports. The related tier exists because a heading is
// often written one way in the index and another in the record
// ("Hernández de Alba, Gregorio" against "Gregorio Hernández"), so when
// the phrase finds nothing the heading's substantial tokens are ORed
// together and the surface labels the result as related rather than as
// a mention. It is computed ONLY when the phrase tier is empty: a
// heading that matched exactly has nothing to gain from a looser pass,
// and the looser pass is the noisier one.
//
// TOKENS are the heading's runs of letters, accents included, four
// characters or longer. Four is where Spanish particles stop being
// noise-free: "de", "los", "y" match nearly everything, and a tier
// built out of them is a tier of false positives. A heading with no
// token that long yields no related tier at all rather than a bad one.
//
// EVERY expression is quoted by construction — the phrase with its
// inner quotes doubled, each token as its own quoted term — so no
// heading, however punctuated, can reach FTS5 as syntax. A heading with
// nothing indexable in it skips the read entirely rather than sending
// FTS5 an empty phrase to reject.
//
// The scope rule at the top of this module applies unchanged: both
// statements carry d.tenant_id in the same statement as their FROM.

/** One record that mentions a heading — enough to link to and read. */
export interface HeadingMention {
  id: string;
  referenceCode: string | null;
  title: string;
}

interface RawMentionRow {
  id: string;
  reference_code: string | null;
  title: string | null;
}

/** The heading as one FTS phrase, inner quotes doubled. */
function headingPhraseExpression(heading: string): string | null {
  if (!hasIndexableContent(heading)) return null;
  return '"' + heading.split('"').join('""') + '"';
}

/**
 * The heading's substantial tokens, ORed. Null when it has none —
 * which the caller reads as "no related tier", not as "match nothing".
 */
function headingRelatedExpression(heading: string): string | null {
  const tokens = heading.split(/[^\p{L}]+/u).filter((t) => t.length >= 4);
  if (tokens.length === 0) return null;
  return tokens.map((token) => '"' + token + '"').join(" OR ");
}

/**
 * Whether a heading has anything an FTS5 phrase could match. A string
 * of punctuation compiles to an empty phrase, which FTS5 rejects as
 * syntax rather than answering with zero rows.
 */
function hasIndexableContent(heading: string): boolean {
  return /[\p{L}\p{N}]/u.test(heading);
}

async function selectMentions(
  db: DrizzleD1Database<any>,
  scope: GlobalSearchScope,
  expression: string,
  limit: number,
): Promise<HeadingMention[]> {
  const rows = (await db.all(sql`
    SELECT d.id AS id,
           d.reference_code AS reference_code,
           d.title AS title
    FROM descriptions d INNER JOIN descriptions_fts f ON f.rowid = d.rowid
    WHERE d.tenant_id = ${scope.tenantId} AND f.descriptions_fts MATCH ${expression}
    ORDER BY bm25(f.descriptions_fts) ASC, d.reference_code ASC
    LIMIT ${limit}
  `)) as RawMentionRow[];
  return rows.map((row) => ({
    id: row.id,
    referenceCode: row.reference_code,
    title: row.title ?? "",
  }));
}

/**
 * The records that mention a heading, phrase tier first. The related
 * tier is populated only when the phrase tier came back empty; when
 * the phrase tier has rows, `related` is empty by construction rather
 * than by coincidence.
 */
export async function selectHeadingMentions(
  db: DrizzleD1Database<any>,
  scope: GlobalSearchScope,
  heading: string,
  limit: number,
): Promise<{ phrase: HeadingMention[]; related: HeadingMention[] }> {
  const phraseExpression = headingPhraseExpression(heading);
  const phrase = phraseExpression
    ? await selectMentions(db, scope, phraseExpression, limit)
    : [];
  if (phrase.length > 0) return { phrase, related: [] };

  const relatedExpression = headingRelatedExpression(heading);
  const related = relatedExpression
    ? await selectMentions(db, scope, relatedExpression, limit)
    : [];
  return { phrase, related };
}

/**
 * How many records mention the heading as a phrase. The PHRASE tier
 * only: a count that silently included related hits would put a number
 * on the card that the evidence list cannot account for.
 */
export async function countHeadingMentions(
  db: DrizzleD1Database<any>,
  scope: GlobalSearchScope,
  heading: string,
): Promise<number> {
  const expression = headingPhraseExpression(heading);
  if (!expression) return 0;
  const rows = (await db.all(sql`
    SELECT count(*) AS total
    FROM descriptions d INNER JOIN descriptions_fts f ON f.rowid = d.rowid
    WHERE d.tenant_id = ${scope.tenantId} AND f.descriptions_fts MATCH ${expression}
  `)) as RawCountRow[];
  return Number(rows[0]?.total ?? 0);
}
