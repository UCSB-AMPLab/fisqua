/**
 * Global Search
 *
 * One query over the whole workspace — archival records, entity
 * authorities, place authorities — reached from its own nav item under
 * Home. The three indexes have nothing in common but the words in
 * them, so results are GROUPED by category rather than blended into a
 * single ranking: normalising BM25 across indexes whose columns and
 * document lengths differ has no honest answer, and grouping is what
 * the facets (category, then level / repository / type / function)
 * actually want.
 *
 * THE ANATOMY. Two columns, after Zasqua's search: a filter sidebar on
 * the left — a compact refine widget on top, checkbox facet groups
 * with live counts beneath — and the results column on the right,
 * where the category tabs, the result count and sort row, the pills,
 * and the cards live. Below the large breakpoint the sidebar folds
 * behind a disclosure button so the results keep the width.
 *
 * TWO VIEWS, ONE RESULTS HOME. That anatomy is the DEFAULT view.
 * Behind `?view=advanced` the same URL answers with the classic
 * archival form instead: ONE list of criteria rows, nothing beside it.
 * A row names a criterion and gives it a value — a text criterion
 * carries an operator (and / or / not) and a term, and those
 * accumulate left to right; a date criterion carries a year range;
 * level, repository, entity type, place type and category criteria
 * each carry one choice. THE ROWS ARE MUTUALLY AWARE: the category
 * criterion says outright what kind of object is being looked for, and
 * the records-only criteria (a date, a level, a repository, a
 * field-scoped term) say it by implication, so whichever is chosen
 * first takes the conflicting options away from the other rows —
 * disabled where they are still meaningful elsewhere, absent where
 * they exist only in one context, as entity type and place type do.
 * A row is never rewritten to fit a later choice; the choice that
 * would invalidate it is simply not on offer. Advanced
 * searches EVERYTHING, and its results come back through exactly the
 * same grouped machinery — tabs, counts, sort row, pagination — laid
 * out in a single column, because there the visible form is the query
 * and a sidebar would be a second way to ask the same thing. The two
 * modes do not bleed into each other: `q` is ignored under
 * `view=advanced`, the repeatable `adv` is ignored without it, and the
 * toggle between them starts the other mode fresh rather than
 * translating a query that has no equivalent on the other side.
 *
 * PILLS, NOT A BOX. There is no big search box on this page at all:
 * the entry points are the dashboard's box and the sidebar's refine
 * widget, and the landing card is help copy, not a form. Once anything
 * is being asked — a term, an exclusion, a facet, a date range — the
 * whole query renders as removable pills above the results: the
 * main term in typographic quotes, each refinement with its operator
 * and field, each facet selection with its vocabulary label. Nothing
 * that narrows the list may be invisible, and every pill can be taken
 * back one at a time; "clear filters" resets to the landing state.
 * Removing the main term promotes the first plain include refinement
 * into the box slot, so the query keeps a subject rather than
 * collapsing.
 *
 * Every piece of state lives in the URL — the repeatable `q`, the
 * repeatable `adv`, `cat`, the repeatable facet params, the date
 * bounds, `sort`, `page` — so a search is linkable, back-navigable,
 * and reproducible from the address bar alone. Facet and sort changes
 * drop the page, because page 7 of a different question is not a page
 * anyone asked for.
 *
 * DATES ARE A RANGE, NOT A TERM. `dateFrom`/`dateTo` are years, and a
 * record answers them when its own span OVERLAPS them — which only the
 * records table can be asked, so a bound behaves exactly as a field
 * scope does: the surface coerces to Records and the authority tabs
 * step aside. The bounds are composed in the advanced form, but they
 * are ordinary URL state, so arriving on the default view they render
 * as one removable pill rather than being silently dropped.
 *
 * REFINING. The model is Zasqua's search transplanted: there are no
 * boolean keywords in any language. Terms AND together implicitly; a
 * leading hyphen on a box token excludes it; the refine widget adds
 * each further term with a yes/no (include/exclude) operator choice.
 * All of it lives in the URL's REPEATABLE `q` parameter — the first
 * value is the main box, each later value one refinement, a `-`
 * prefix an exclusion — and every `q` URL this page builds is built
 * programmatically, box slot first, so the ordering the parser relies
 * on is never at the mercy of a form's field order. Fisqua's one
 * extension is the field select: a field-scoped pill compiles to a
 * column filter only the records index has, so it coerces the surface
 * to the Records tab and the authority tabs step aside entirely
 * rather than showing counts that cannot exist.
 *
 * BROWSING. A query with no positive side is a legitimate question,
 * not a mistake: exclusions alone, or facets alone, or facets with
 * exclusions, all read the catalogue directly and page it honestly.
 * The surface calls that browse mode, and it differs from a match in
 * exactly two visible ways — there is nothing to highlight, so titles
 * render plain and no snippet appears, and relevance is not a sort
 * anyone can ask for, so that button is absent and the list falls back
 * to code (records) or name (authorities).
 *
 * Gating. Search inherits the gates of the pages it links to and never
 * out-reaches them: the loader carries the admin guard the three
 * destination surfaces carry, and the authority categories appear only
 * when the tenant holds the `authorities` capability. A gated-out
 * category is ABSENT — no tab, no count, no facet group, no snippet
 * teaser — because a count is itself a disclosure. Asking for
 * `?cat=entities` without the capability coerces back to the grouped
 * view rather than erroring, which keeps a stale bookmark harmless;
 * so does an authority facet arriving on a tenant that cannot see
 * authorities.
 *
 * The search core lives in `global-search.server` and must never reach
 * the client bundle, so the module is imported dynamically inside the
 * loader and the two values the UI needs from it — the highlight
 * markers and the page size — travel through the loader payload rather
 * than through a value import.
 *
 * SELECTING RESULTS. Every result list carries a tick column — always
 * present, never hover-revealed — because what is ticked here is what
 * an export will be. The selection is client state and belongs to a
 * (query signature × category) pair: the signature is the serialised
 * constraint set with PAGE and SORT left out, so paging and re-sorting
 * never cost a tick, while anything that re-asks the question does.
 * Selections are held per category in one map, so moving between tabs —
 * or between a tab and the grouped view — neither clears nor warns.
 * Two modes: an explicit set of ids, built by ticking and surviving
 * paging, or the symbolic whole matching set, which is never
 * materialised in the browser — unticking a row inside it, or taking
 * "only this page", demotes it to the ids on the list in front of you.
 *
 * ONE BAR PER KIND. The grouped view is three questions at once, so it
 * answers three times: each section carries its own action row beneath
 * its own rows, speaking only about its own kind — "2 records selected"
 * under Records, "1 place selected" under Places, each with its own
 * save, its own send and its own clear. There is never a bar that mixes
 * kinds, because the model will not take one: a handlist holds a single
 * kind and a carried scope names a single record class, so records and
 * places can never be handed to the same one. What a grouped section
 * does NOT offer is the whole-matching-set promise. A section is a
 * capped preview with no pager of its own, so neither "across N pages"
 * nor "only this page" has anything to point at, and the promise would
 * be offered with no honest way back out of it; the route to the full
 * list — and to that promise with its arithmetic intact — is the "See
 * all" link the section already ends with. A whole matching set taken
 * on a tab and then carried into the grouped view still says so, and
 * unticking inside it demotes to the rows on show.
 *
 * WHAT A NEW QUESTION COSTS. While ticks are held, every control whose
 * activation would change the signature — a pill's remove, the refine
 * widget, a facet checkbox, clear-filters, the advanced form's submit,
 * the view toggle — wears the armed treatment and routes through a
 * warning first. The category tabs are exempt, because a selection made
 * under another tab is not the one being spent. A tab therefore arms
 * for its own kind alone, while the grouped view arms for every kind it
 * is showing and the warning names each one it would spend, a line per
 * kind. The warning offers the third way the two obvious buttons do not
 * imply: send the selection to export first, which stashes it
 * server-side and then applies the change that was pending, so the
 * question moves on and the set is still there to export. That way out
 * exists only while ONE kind is at stake — a scope carries one record
 * class, so two kinds cannot become one send — and with more than one
 * held the dialog offers the two ways out it can keep.
 *
 * KEEPING A SELECTION. A ticked set has two fates, and the bar offers
 * both side by side: send it to export now, or save it as a handlist —
 * a named, ordered, persistent set of references that outlives the
 * question it was gathered under. Saving posts to the handlists
 * resource route through the shared picker, which offers only the
 * handlists whose type matches what is ticked. The whole matching set
 * can be saved too, and is materialised HERE by re-running the same
 * scoped question, exactly as the carry does: a promise about a query
 * is never turned into a list by the browser.
 *
 * CHOOSING A SET. The way in is offered from the pills row, beside the
 * constraints it will join, and drawn dashed rather than filled
 * because it is an offer and not yet a narrowing; once a set is
 * applied it disappears, since the green pill is that same facet
 * already on. The menu lists every handlist this person can reach and
 * refuses IN PLACE: on the Entities tab a set of records stays listed,
 * dimmed, saying what it holds, and the header states the shape of the
 * problem when nothing reachable can narrow the tab at all. On the
 * grouped view nothing can be the wrong kind, so choosing simply lands
 * on the chosen set's own tab. Choosing narrows, so it costs a live
 * selection the same warning every other narrowing costs.
 *
 * STANDING INSIDE A SET. `?handlist=<id>` is the other half of the
 * relationship: the search runs INSIDE a handlist. It is the ground the
 * question is asked on rather than one of the things asked for, so it
 * wears verdigris where the query terms wear indigo, and taking it off
 * widens back to the workspace. A handlist holds one kind of thing, so
 * it coerces the surface to that category and the other tabs step
 * aside exactly as a field scope makes them. Because it narrows, it is
 * part of the query signature: removing the pill costs a live selection
 * the same warning any other narrowing costs. An empty result inside a
 * set never dead-ends — the count line and the empty state both report
 * how many the same question reaches in the whole workspace, with the
 * link out to ask it there.
 *
 * Labels are borrowed, never duplicated. Description levels read from
 * the descriptions namespace, entity types from the entities
 * namespace, place types from the places namespace: the same keys
 * their own section pages use, mapped through static records so the
 * vocabulary cannot drift between the section and the search result
 * that points at it.
 *
 * @version v0.7.0
 */

import { useRef, useState } from "react";
import {
  Link,
  redirect,
  useFetcher,
  useLocation,
  useNavigate,
  useSubmit,
} from "react-router";
import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
  Info,
  List,
  Plus,
  Search as SearchIcon,
  SearchX,
  X,
} from "lucide-react";
import { Pager } from "~/components/ui/pager";
import { HandlistPicker } from "~/components/handlists/handlist-picker";
// The chooser's rows say how much a handlist holds in exactly the
// words the handlists index says it in — borrowed through the shared
// key map rather than restated in this namespace.
import { HELD_KEYS } from "~/components/handlists/handlist-labels";
import { tenantContext, userContext } from "../context";
import type { Tenant, User } from "../context";
import { hasCapability } from "../lib/tenant";
import {
  DESCRIPTION_LEVELS,
  ENTITY_TYPES,
  PLACE_TYPES,
} from "~/lib/validation/enums";
import { useFormatters } from "~/lib/use-formatters";
// The query model is pure (no `.server` suffix) precisely so the
// component can encode pills client-side with the same code the
// loader parses with.
import {
  encodeAdvancedRow,
  encodeRefinement,
  hasAdvancedFieldRows,
  hasFieldRefinements,
  hasPositive,
  isBlank,
  parseAdvancedRows,
  parseSearch,
  MAX_ADVANCED_ROWS,
  SEARCH_FIELDS,
  type AdvancedOp,
  type AdvancedRow,
  type ParsedSearch,
  type SearchField,
  type SearchRefinement,
} from "~/lib/search-query";
// Type-only: `global-search.server` must never be pulled into the
// client bundle, so the row shapes travel as types and the runtime
// constants travel through the loader payload.
import type {
  DescriptionHit,
  EntityHit,
  GlobalSearchFacets,
  NameSortKey,
  PlaceHit,
  RecordSortKey,
  SearchCategory,
  SortDir,
  SortSpec,
} from "~/lib/global-search.server";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Route } from "./+types/_auth.search";

/** The tab vocabulary, in the order the surface renders it. */
const CATEGORY_ORDER = ["descriptions", "entities", "places"] as const;

/** Tab and section labels, one key per category. */
const CATEGORY_LABEL_KEYS: Record<SearchCategory, string> = {
  descriptions: "catDescriptions",
  entities: "catEntities",
  places: "catPlaces",
};

/**
 * The carry's vocabulary for the same three indexes. The search core
 * calls the record index `descriptions`; the stashed scope, the
 * selection map and every sentence a person reads call it `records`.
 * One pair of maps keeps that crossing in a single place.
 */
type RecordType = "records" | "entities" | "places";

const RECORD_TYPE_OF: Record<SearchCategory, RecordType> = {
  descriptions: "records",
  entities: "entities",
  places: "places",
};

const CATEGORY_OF_RECORD_TYPE: Record<RecordType, SearchCategory> = {
  records: "descriptions",
  entities: "entities",
  places: "places",
};

/**
 * The selection sentences, one key per record type. They are whole
 * sentences rather than a noun slotted into a frame because Spanish
 * agrees in gender and number: "seleccionados" and "seleccionadas"
 * are not the same word, and a frame would get half of them wrong.
 */
const SEL_BAR_KEYS: Record<RecordType, string> = {
  records: "selBar_records",
  entities: "selBar_entities",
  places: "selBar_places",
};

const SEL_ALL_KEYS: Record<RecordType, string> = {
  records: "selAll_records",
  entities: "selAll_entities",
  places: "selAll_places",
};

const SEL_ALL_HELD_KEYS: Record<RecordType, string> = {
  records: "selAllHeld_records",
  entities: "selAllHeld_entities",
  places: "selAllHeld_places",
};

/**
 * "N match in the whole workspace", one key per record type — the
 * figure a search inside a handlist reports about the world outside it.
 * Written out per type for the same reason the selection sentences are:
 * the verb and the noun agree in Spanish, and a frame would get half of
 * them wrong.
 */
const WORKSPACE_COUNT_KEYS: Record<RecordType, string> = {
  records: "inHandlistWorkspace_records",
  entities: "inHandlistWorkspace_entities",
  places: "inHandlistWorkspace_places",
};

/**
 * "…matches none of this handlist's N records", one key per record
 * type: the first half of the empty-inside-a-set sentence, whose count
 * is the set's own size.
 */
const EMPTY_IN_SET_KEYS: Record<RecordType, string> = {
  records: "emptyInHandlistSet_records",
  entities: "emptyInHandlistSet_entities",
  places: "emptyInHandlistSet_places",
};

/**
 * What the change costs, one whole sentence per kind of thing. The
 * grouped view can hold records and places at once, so the clause is
 * per kind while the reason it applies — that a selection belongs to
 * the result set it was made in — is said ONCE beneath them. Saying it
 * after every kind turns an explanation into a stutter.
 */
const WARN_BODY_KEYS: Record<RecordType, string> = {
  records: "warnChangeHold_records",
  entities: "warnChangeHold_entities",
  places: "warnChangeHold_places",
};

/**
 * "none of yours hold entities" — the second half of the chooser's
 * header when not one reachable handlist can narrow the tab on screen.
 * The shape of the problem is worth stating once, above rows that each
 * repeat their own half of it.
 */
const CHOOSER_NONE_KEYS: Record<RecordType, string> = {
  records: "chooserNone_records",
  entities: "chooserNone_entities",
  places: "chooserNone_places",
};

/**
 * "holds records, not entities" — why a listed handlist cannot narrow
 * this tab, keyed `held:asked`. Six directed pairs written out rather
 * than a frame with two nouns dropped into it, for the reason every
 * other typed sentence on this surface is written out.
 */
const CHOOSER_WHY_KEYS: Record<string, string> = {
  "records:entities": "chooserWhy_records_entities",
  "records:places": "chooserWhy_records_places",
  "entities:records": "chooserWhy_entities_records",
  "entities:places": "chooserWhy_entities_places",
  "places:records": "chooserWhy_places_records",
  "places:entities": "chooserWhy_places_entities",
};

/**
 * Description-level labels. The descriptions admin renders these as
 * `level_<value>` in the `descriptions_admin` namespace; the map keeps
 * the same keys addressable without a runtime-assembled string.
 */
const LEVEL_LABEL_KEYS: Record<string, string> = {
  fonds: "level_fonds",
  subfonds: "level_subfonds",
  series: "level_series",
  subseries: "level_subseries",
  file: "level_file",
  item: "level_item",
  collection: "level_collection",
  section: "level_section",
  volume: "level_volume",
};

/** Entity-type labels, the flat keys the entities admin reads. */
const ENTITY_TYPE_LABEL_KEYS: Record<string, string> = {
  person: "person",
  family: "family",
  corporate: "corporate",
};

/** Place-type labels, the flat keys the places admin reads. */
const PLACE_TYPE_LABEL_KEYS: Record<string, string> = {
  country: "country",
  region: "region",
  department: "department",
  province: "province",
  partido: "partido",
  city: "city",
  town: "town",
  parish: "parish",
  hacienda: "hacienda",
  mine: "mine",
  river: "river",
  other: "other",
};

/** Refine-widget field labels, one key per scoped column. */
const FIELD_LABEL_KEYS: Record<SearchField, string> = {
  title: "fieldTitle",
  scope: "fieldScope",
  notes: "fieldNotes",
  ref: "fieldRef",
  legacy: "fieldLegacy",
};

interface RepositoryOption {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Facet vocabulary
// ---------------------------------------------------------------------------

/**
 * The five facet groups, keyed as the search core names them. Each is
 * multi-select (OR inside the group, AND across groups) and travels as
 * a REPEATABLE URL parameter.
 */
type FacetKey = "levels" | "repoIds" | "entityTypes" | "fns" | "placeTypes";

type ActiveFacets = Record<FacetKey, string[]>;

const EMPTY_FACETS: ActiveFacets = {
  levels: [],
  repoIds: [],
  entityTypes: [],
  fns: [],
  placeTypes: [],
};

/** The URL parameter each group appears under. */
const FACET_PARAM: Record<FacetKey, string> = {
  levels: "level",
  repoIds: "repoId",
  entityTypes: "type",
  fns: "fn",
  placeTypes: "placeType",
};

/**
 * Which groups belong to which category. A facet is only ever applied,
 * carried, or shown while its own category is the one on screen — a
 * level cannot narrow a list of places, and a pill for a narrowing
 * that is not in force would be a lie.
 */
const CATEGORY_FACET_KEYS: Record<SearchCategory, FacetKey[]> = {
  descriptions: ["levels", "repoIds"],
  entities: ["entityTypes", "fns"],
  places: ["placeTypes"],
};

/**
 * Which groups the ADVANCED form can compose, per category. It is the
 * facet map minus the function group: function is a Zasqua-view facet
 * only, so a link built out of the advanced form must not carry an
 * `fn` the form has no row for and no way to take back.
 */
const ADVANCED_FACET_KEYS: Record<SearchCategory, FacetKey[]> = {
  descriptions: ["levels", "repoIds"],
  entities: ["entityTypes"],
  places: ["placeTypes"],
};

/** The group label keys, borrowed from the facet vocabulary. */
const FACET_LABEL_KEYS: Record<FacetKey, string> = {
  levels: "filterLevel",
  repoIds: "filterRepository",
  entityTypes: "filterType",
  fns: "filterFunction",
  placeTypes: "filterPlaceType",
};

/** Sort keys per mode, in the order the sort row renders them. */
const RECORD_SORT_KEYS = ["date", "title", "code", "relevance"] as const;
const NAME_SORT_KEYS = ["name", "code", "relevance"] as const;

/** Sort-button labels, one key per sort key. */
const SORT_LABEL_KEYS: Record<RecordSortKey | NameSortKey, string> = {
  relevance: "sortRelevance",
  date: "sortDate",
  title: "sortTitle",
  code: "sortCode",
  name: "sortName",
};

/** Distinct values, order preserved — a repeated param is one choice. */
function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * A date bound is a YEAR, one to four digits — the granularity an
 * archival span is actually known at. Anything else in the parameter
 * is dropped rather than corrected, so a crafted URL degrades to the
 * search without that bound.
 */
const YEAR_PATTERN = /^\d{1,4}$/;

/**
 * The bound as a FOUR-digit year, or null when it is not a year. The
 * padding is load-bearing: the reads compare the bound against the
 * stored dates' year substrings as text, so "800" would sort before
 * every "1…" year instead of inside the ninth century.
 */
function readYear(raw: string | null): string | null {
  const value = (raw ?? "").trim();
  return YEAR_PATTERN.test(value) ? value.padStart(4, "0") : null;
}

// ---------------------------------------------------------------------------
// Reading the question out of a URL
// ---------------------------------------------------------------------------

/**
 * Everything a search URL is asking, once every value has been checked
 * against the vocabulary that owns it. PAGE is deliberately absent:
 * it belongs to the results view, not to the question, and the carry
 * — which reads the same URL to materialise "all matching" — must not
 * be able to inherit one.
 */
interface SearchRequest {
  advanced: boolean;
  /**
   * False when the URL asks to search inside a handlist the rest of the
   * question cannot be asked inside — an authority set under a
   * records-only narrowing. The ground is dropped rather than the
   * query, the same way an invalid facet value or an ungated category
   * degrades here instead of erroring.
   */
  handlistApplies: boolean;
  parsed: ParsedSearch;
  advRows: AdvancedRow[];
  dateFrom: string | null;
  dateTo: string | null;
  blank: boolean;
  matchMode: boolean;
  recordsOnly: boolean;
  authorities: boolean;
  namedCategory: SearchCategory | null;
  category: "all" | SearchCategory;
  /** The active category's groups only — see `facetsForCategory`. */
  facets: ActiveFacets;
  anyFacet: boolean;
  sort: SortSpec | null;
}

/**
 * Only the category on screen owns facets; anything left over from
 * another category is dropped rather than carried invisibly.
 */
function facetsForCategory(
  all: ActiveFacets,
  category: "all" | SearchCategory,
): ActiveFacets {
  const facets: ActiveFacets = { ...EMPTY_FACETS };
  if (category !== "all") {
    for (const key of CATEGORY_FACET_KEYS[category]) facets[key] = all[key];
  }
  return facets;
}

/**
 * What the search core is handed: only the groups that actually have a
 * selection. An empty group is an ABSENT group, never an empty IN-list
 * — "narrow this to nothing" is not what an untouched checkbox list
 * means. The date bounds narrow the same way a facet group does.
 */
function callFacetsFrom(
  facets: ActiveFacets,
  dateFrom: string | null,
  dateTo: string | null,
): GlobalSearchFacets {
  const callFacets: GlobalSearchFacets = {};
  for (const key of Object.keys(facets) as FacetKey[]) {
    if (facets[key].length > 0) callFacets[key] = facets[key];
  }
  if (dateFrom) callFacets.dateFrom = dateFrom;
  if (dateTo) callFacets.dateTo = dateTo;
  return callFacets;
}

/**
 * Parse and validate one search URL. The loader reads the request the
 * browser is showing; the carry action reads the request a selection
 * was made under, and must reach exactly the same verdicts about
 * category, facets and sort — so both come through here rather than
 * through two copies of the same rules.
 *
 * `repositoryIds` is the allowlist a `repoId` is checked against: the
 * tenant's own repositories, read by the caller (which knows whether
 * it can be skipped).
 */
function readSearchRequest(
  sp: URLSearchParams,
  options: {
    includeAuthorities: boolean;
    repositoryIds: string[];
    /**
     * The category the handlist in `?handlist=` holds, resolved by the
     * caller (which has the database and the visibility rule). Null
     * for no handlist and for one whose type is not fixed yet — an
     * empty set narrows every category to nothing, which is true, and
     * coerces none of them, which is also true.
     */
    handlistCategory?: SearchCategory | null;
  },
): SearchRequest {
  const { includeAuthorities, repositoryIds } = options;
  const handlistCategory = options.handlistCategory ?? null;

  // Which of the two views is answering. The mode is a hard fork: the
  // pills grammar cannot express an OR and the criteria rows cannot
  // express a promoted box term, so each mode reads only its own
  // parameter and ignores the other's entirely.
  const advanced = sp.get("view") === "advanced";

  // The repeatable `q` is the whole query in the default view: first
  // value the main box, each later value one refinement, a leading
  // hyphen an exclusion.
  const parsed = parseSearch(advanced ? [] : sp.getAll("q"));
  // The repeatable `adv` is the whole query in the advanced view: one
  // value per criteria row, `op:field:term`.
  const advRows = advanced ? parseAdvancedRows(sp.getAll("adv")) : [];

  // Date bounds are years and travel as their own parameters in both
  // views. A pair the wrong way round is a fumble, not a refusal — the
  // range it describes is unambiguous, so it is swapped rather than
  // dropped.
  let dateFrom = readYear(sp.get("dateFrom"));
  let dateTo = readYear(sp.get("dateTo"));
  if (dateFrom && dateTo && Number(dateFrom) > Number(dateTo)) {
    [dateFrom, dateTo] = [dateTo, dateFrom];
  }
  const dateBound = dateFrom !== null || dateTo !== null;

  const blank = advanced ? advRows.length === 0 : isBlank(parsed);
  // A positive side is what makes this a MATCH; without one the reads
  // are a browse, and relevance stops being a thing anyone can sort by.
  // Every surviving criteria row is positive by construction, so any
  // row at all makes the advanced view a match.
  const matchMode = advanced ? advRows.length > 0 : hasPositive(parsed);

  // Three narrowings only the record index can answer: a field-scoped
  // refinement, a field-scoped criteria row, and a date bound. Each
  // compiles to something the name indexes have no column for, so each
  // forces the Records category regardless of `cat` — no crafted URL
  // can ask the search core an authority question it cannot answer.
  const fieldScoped = hasFieldRefinements(parsed) || hasAdvancedFieldRows(advRows);
  const recordsOnly = fieldScoped || dateBound;
  const authorities = includeAuthorities && !recordsOnly;

  // Facet values, each validated against the vocabulary that owns it,
  // invalid values dropped. `fn` is free text matched exactly against
  // `primary_function`, so it has only the non-blank rule to pass. Both
  // views come through here: a level or an entity type composed in the
  // advanced form is checked against the same vocabulary, and gated by
  // the same capability, as one ticked in the sidebar.
  const allFacets: ActiveFacets = {
    levels: unique(
      sp
        .getAll("level")
        .filter((v) => (DESCRIPTION_LEVELS as readonly string[]).includes(v)),
    ),
    repoIds: unique(sp.getAll("repoId").filter((v) => repositoryIds.includes(v))),
    entityTypes: authorities
      ? unique(
          sp
            .getAll("type")
            .filter((v) => (ENTITY_TYPES as readonly string[]).includes(v)),
        )
      : [],
    fns: authorities
      ? unique(sp.getAll("fn").map((v) => v.trim()).filter(Boolean))
      : [],
    placeTypes: authorities
      ? unique(
          sp
            .getAll("placeType")
            .filter((v) => (PLACE_TYPES as readonly string[]).includes(v)),
        )
      : [],
  };

  // Category. An unknown value, or an authority category on a tenant
  // without the capability, coerces to the grouped view — a stale
  // bookmark degrades, it does not error and it does not leak. A URL
  // that carries facets but no category resolves to the category those
  // facets belong to (records first): the grouped view has no facets
  // to apply, so honouring them means going where they work.
  const rawCat = sp.get("cat");
  const namedCategory: SearchCategory | null =
    rawCat === "descriptions" ||
    ((rawCat === "entities" || rawCat === "places") && authorities)
      ? (rawCat as SearchCategory)
      : null;
  const facetedCategory =
    CATEGORY_ORDER.find((c) =>
      CATEGORY_FACET_KEYS[c].some((k) => allFacets[k].length > 0),
    ) ?? null;
  // A handlist is the GROUND, so it outranks a named category and a
  // faceted one: it holds one kind of thing and the other tabs cannot
  // honestly be asked. What it cannot outrank is what the indexes can
  // answer — a records-only narrowing keeps the surface on Records, and
  // an authority set has nowhere to stand under it.
  const handlistApplies =
    handlistCategory === null ||
    handlistCategory === "descriptions" ||
    (!recordsOnly && authorities);
  const category: "all" | SearchCategory = recordsOnly
    ? "descriptions"
    : handlistApplies && handlistCategory !== null
      ? handlistCategory
      : (namedCategory ?? facetedCategory ?? "all");

  const facets = facetsForCategory(allFacets, category);
  const anyFacet =
    Object.values(facets).some((values) => values.length > 0) || dateBound;

  // Sort travels as `key:dir`, validated against the active category's
  // key set — an unknown key, an unknown direction, or relevance
  // without a query to be relevant to all resolve to the mode default.
  const rawSort = sp.get("sort");
  let sort: SortSpec | null = null;
  if (rawSort && category !== "all") {
    const [rawKey, rawDir] = rawSort.split(":");
    const keys: readonly string[] =
      category === "descriptions" ? RECORD_SORT_KEYS : NAME_SORT_KEYS;
    const dirOk = rawDir === "asc" || rawDir === "desc";
    const keyOk = keys.includes(rawKey) && (matchMode || rawKey !== "relevance");
    if (dirOk && keyOk) {
      sort = {
        key: rawKey as RecordSortKey | NameSortKey,
        dir: rawDir as SortDir,
      };
    }
  }

  return {
    advanced,
    handlistApplies,
    parsed,
    advRows,
    dateFrom,
    dateTo,
    blank,
    matchMode,
    recordsOnly,
    authorities,
    namedCategory,
    category,
    facets,
    anyFacet,
    sort,
  };
}

// ---------------------------------------------------------------------------
// The set a question can be asked inside
// ---------------------------------------------------------------------------

/** What the surface needs to know about the handlist it is standing in. */
interface HandlistScope {
  id: string;
  name: string;
  /** Null until the set has its first member. */
  recordType: RecordType | null;
  /** Members held, as the handlists index counts them. */
  memberCount: number;
}

/**
 * Resolve `?handlist=` under the same visibility rule the handlists
 * surfaces use, and refuse anything this person cannot reach — an
 * unreachable set, a foreign one and a nonexistent one are the same
 * 404, as everywhere else.
 *
 * The index read is the lightest one that answers all three questions
 * the pill asks — is it reachable, what does it hold, what is it called
 * — in a single statement. `getWithMembers` would answer them too, but
 * it resolves every member against the workspace to do it, and a search
 * inside a ten-thousand-member set must not pay for that to draw a pill.
 */
async function readHandlistScope(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  raw: string | null,
): Promise<HandlistScope | null> {
  const id = (raw ?? "").trim();
  if (!id) return null;
  const { listForUser } = await import("~/lib/handlists.server");
  const row = (await listForUser(db, tenant, user, "all")).find(
    (candidate) => candidate.id === id,
  );
  if (!row || row.locked) throw new Response("Not found", { status: 404 });
  return {
    id: row.id,
    name: row.name,
    recordType: row.recordType,
    memberCount: row.memberCount,
  };
}

/** The category a handlist's type confines a search to. */
function handlistCategoryOf(scope: HandlistScope | null): SearchCategory | null {
  return scope?.recordType ? CATEGORY_OF_RECORD_TYPE[scope.recordType] : null;
}

/** One set the chooser offers, and everything its row says. */
interface HandlistChoice {
  id: string;
  name: string;
  /** Fixed: a set whose type is not settled yet is not offered at all. */
  recordType: RecordType;
  memberCount: number;
  /** Theirs, or someone else's shared with them. */
  mine: boolean;
  ownerName: string;
}

/**
 * The sets this person could stand in, for the pills-row chooser.
 *
 * Every reachable handlist is offered, INCLUDING the ones that cannot
 * narrow the tab on screen — the type rule refuses in place, on the
 * row, rather than by quietly shortening the menu. Two are left out
 * for reasons that are not about type: one this person may see listed
 * but not open (the demotion residue the index explains), and one whose
 * type is not fixed yet, which holds nothing and so is not a set any
 * question can be asked inside. An authority set on a tenant without
 * the capability is not offered either — standing in one is a 404 on
 * arrival, and a menu must not offer a door that answers 404.
 */
async function readHandlistChoices(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  includeAuthorities: boolean,
): Promise<HandlistChoice[]> {
  const { listForUser } = await import("~/lib/handlists.server");
  const rows = await listForUser(db, tenant, user, "all");
  const choices: HandlistChoice[] = [];
  for (const row of rows) {
    if (row.locked || row.recordType === null) continue;
    if (row.recordType !== "records" && !includeAuthorities) continue;
    choices.push({
      id: row.id,
      name: row.name,
      recordType: row.recordType,
      memberCount: row.memberCount,
      mine: row.role === "owner",
      // A person is named by whatever the workspace knows them as; the
      // address is the fallback the rest of the feature uses.
      ownerName: row.ownerName ?? row.ownerEmail,
    });
  }
  return choices;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { asc, eq } = await import("drizzle-orm");
  const { repositories } = await import("~/db/schema");
  const {
    countMatching,
    runGlobalSearch,
    HIGHLIGHT_OPEN,
    HIGHLIGHT_CLOSE,
    SEARCH_PAGE_SIZE,
  } = await import("~/lib/global-search.server");

  // Search is open to every workspace member (ruled 2026-08-16); only
  // the authority reach carries the admin gate, because that is the
  // gate its destination surfaces carry. For a non-admin the Entities
  // and Places tabs simply do not exist — the same degrade a tenant
  // without the capability gets, and the same branch of every read.
  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const includeAuthorities =
    hasCapability(tenant, "authorities") && user.isAdmin;

  const db = drizzle(context.cloudflare.env.DB);
  const sp = new URL(request.url).searchParams;

  // The tenant's repositories are the allowlist a `repoId` is checked
  // against, and the source of a repository pill's name. In the default
  // view both jobs exist only when the URL actually carries a repoId —
  // the sidebar's repository group draws from
  // `facetCounts.repositories` — so the read is paid only then. The
  // advanced form composes rather than browses, so it needs the whole
  // list up front.
  const rawRepoIds = sp.getAll("repoId");
  const repositoryOptions: RepositoryOption[] =
    sp.get("view") === "advanced" || rawRepoIds.length > 0
      ? await db
          .select({ id: repositories.id, name: repositories.name })
          .from(repositories)
          .where(eq(repositories.tenantId, tenant.id))
          .orderBy(asc(repositories.name))
          .all()
      : [];

  // The set the question is being asked inside, if any. It is resolved
  // before the URL is read, because its type decides which category the
  // surface can honestly show.
  const askedHandlist = await readHandlistScope(
    db,
    tenant,
    user,
    sp.get("handlist"),
  );
  const askedHandlistCategory = handlistCategoryOf(askedHandlist);
  // An authority set on a tenant without the capability is not a set
  // this session may stand in — the same gate its tab is absent under.
  if (
    askedHandlistCategory !== null &&
    askedHandlistCategory !== "descriptions" &&
    !includeAuthorities
  ) {
    throw new Response("Not found", { status: 404 });
  }

  const {
    advanced,
    handlistApplies,
    parsed,
    advRows,
    dateFrom,
    dateTo,
    blank,
    recordsOnly,
    namedCategory,
    category,
    facets,
    anyFacet,
    sort,
  } = readSearchRequest(sp, {
    includeAuthorities,
    repositoryIds: repositoryOptions.map((r) => r.id),
    handlistCategory: askedHandlistCategory,
  });
  const callFacets = callFacetsFrom(facets, dateFrom, dateTo);
  // Dropped when the rest of the question left it nowhere to stand;
  // nothing then renders a pill, so nothing on screen claims a ground
  // the reads did not use.
  const handlist = handlistApplies ? askedHandlist : null;

  const page = Math.max(1, parseInt(sp.get("page") || "1", 10) || 1);

  // Nothing asked for and nothing selected is the landing state: the
  // call still runs, because the sidebar's corpus-wide counts are what
  // it comes back with. In the advanced view there is no sidebar to
  // fill, so the same state simply shows the empty form and no results
  // block at all — a count of everything is not an answer to a
  // question nobody has asked yet.
  // Standing inside a set is itself a question — "show me what is in
  // here" — so the invitation to ask one is not the state to be in.
  const landing = blank && !anyFacet && category === "all" && handlist === null;

  // The chooser's own read, paid only where the chooser will be drawn:
  // never inside a set (the pill holds that ground — one facet, two
  // entrances, and only one of them open at a time), and never on the
  // landing state, which has no pills row to offer it from.
  const handlistOptions =
    handlist === null && !landing
      ? await readHandlistChoices(db, tenant, user, includeAuthorities)
      : [];

  const scope = {
    tenantId: tenant.id,
    federationId: tenant.federationId,
    includeAuthorities,
    handlistId: handlist?.id ?? null,
  };

  const result = await runGlobalSearch(
    db,
    scope,
    advanced ? advRows : parsed,
    category === "all"
      ? { category: "all" }
      : { category, page, facets: callFacets, sort },
  );

  // Inside a set, the same question is also counted OUTSIDE it: the
  // count line says how many of the workspace's rows this question
  // reaches, and the empty state turns a dead end into a next move.
  // One statement, sharing every fragment with the read above.
  const outsideTotal =
    handlist && category !== "all"
      ? await countMatching(
          db,
          { ...scope, handlistId: null },
          advanced ? advRows : parsed,
          { category, facets: callFacets },
        )
      : null;

  return {
    advanced,
    handlist,
    handlistOptions,
    outsideTotal,
    advRows,
    dateFrom,
    dateTo,
    // The box shows only the POSITIVE part of what was typed —
    // extracted exclusions materialise as pills instead.
    boxQuery: parsed.q,
    refinements: parsed.refinements,
    landing,
    recordsOnly,
    category,
    // What the URL actually NAMED, before the coercions above had
    // their say: the advanced form's category criterion seeds from
    // this, so a bound that coerces the results to Records does not
    // rewrite the choice the form is showing.
    namedCategory,
    page,
    includeAuthorities,
    counts: result.counts,
    facetCounts: result.facetCounts,
    mode: result.mode,
    preview: result.preview ?? null,
    pageResult: result.page ?? null,
    repositoryOptions,
    facets,
    sort,
    markers: { open: HIGHLIGHT_OPEN, close: HIGHLIGHT_CLOSE },
    pageSize: SEARCH_PAGE_SIZE,
  };
}

// ---------------------------------------------------------------------------
// Action — the carry
// ---------------------------------------------------------------------------

/**
 * Stash the selection on its way to export.
 *
 * A selection is browser state and dies with the page, so carrying it
 * anywhere means writing it down first: the post says which index it
 * belongs to, whether it is an explicit set of ids or the symbolic
 * whole matching set, what the constraints READ as (labels, for the
 * export summary to quote back), and the query itself — because "all
 * matching" is materialised HERE, by re-running the same scoped
 * question the results page ran, never by trusting a list the browser
 * assembled.
 *
 * The query arrives as the search URL's own parameter string and is
 * re-read through `readSearchRequest`, so every coercion the results
 * page made — the records-only rule, the capability gate, the facet
 * vocabularies — is made again on a posted query nobody can be sure
 * came from this surface.
 *
 * Where it goes afterwards is the one thing the caller chooses. The
 * plain Send lands on the export page with the scope in hand. The
 * warning dialog's "send first" instead asks to be returned to the
 * search it was about to change (`resume`, which must be a search URL),
 * so the pending change applies and the stashed scope waits on the
 * export page for later — which is exactly what the warning promises.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { repositories } = await import("~/db/schema");
  const { stashCarriedScope } = await import("~/lib/carried-scopes.server");

  // Member-level like the loader; the authority reach keeps the admin
  // gate, so a non-admin can neither carry nor materialise an
  // entities/places scope this surface would not have shown them.
  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const includeAuthorities =
    hasCapability(tenant, "authorities") && user.isAdmin;

  const db = drizzle(context.cloudflare.env.DB);
  const formData = await request.formData();

  const intent = (formData.get("_action") as string) || "";
  if (intent !== "carry" && intent !== "handlistIds") {
    throw new Response("Unknown action", { status: 400 });
  }

  const rawType = (formData.get("recordType") as string) || "";
  const recordType: RecordType | null =
    rawType === "records" || rawType === "entities" || rawType === "places"
      ? rawType
      : null;
  if (!recordType) {
    throw new Response("Malformed carry", { status: 400 });
  }

  const category = CATEGORY_OF_RECORD_TYPE[recordType];
  // An authority scope on a tenant without the capability is not a
  // scope this session may hold — the same gate the tabs are absent
  // under, enforced where it can actually be crossed.
  if (category !== "descriptions" && !includeAuthorities) {
    throw new Response("Not found", { status: 404 });
  }

  // The question, re-read from the URL that asked it: the same
  // coercions the results page made, made again on a posted query
  // nobody can be sure came from this surface. The handlist travels in
  // that URL too, and is resolved under its own visibility rule — a
  // selection made inside a set must be materialised inside it, or the
  // "all matching" promise would quietly reach past the ground it was
  // made on.
  const sp = new URLSearchParams((formData.get("query") as string) || "");
  const repositoryIds = (
    await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.tenantId, tenant.id))
      .all()
  ).map((r) => r.id);
  const handlist = await readHandlistScope(db, tenant, user, sp.get("handlist"));
  const asked = readSearchRequest(sp, {
    includeAuthorities,
    repositoryIds,
    handlistCategory: handlistCategoryOf(handlist),
  });
  const facets = facetsForCategory(asked.facets, category);
  const askedQuery = {
    input: asked.advanced ? asked.advRows : asked.parsed,
    // The category is not repeated here: `recordType` above already
    // names the index, and one fact stated twice is one fact that
    // can disagree with itself.
    facets: callFacetsFrom(facets, asked.dateFrom, asked.dateTo),
    sort: asked.sort,
  };
  const searchScope = {
    tenantId: tenant.id,
    federationId: tenant.federationId,
    includeAuthorities,
    handlistId: asked.handlistApplies ? (handlist?.id ?? null) : null,
  };

  // The ids behind "all matching", for a save the browser cannot make:
  // a handlist takes a list of members, and the whole matching set is a
  // promise about a query until this resolves it. The ceiling is the
  // handlist's own, checked before the ids are trusted, so an
  // oversized set is refused rather than quietly cut short.
  if (intent === "handlistIds") {
    const { selectMatchingIds } = await import("~/lib/global-search.server");
    const { HANDLIST_MAX_MEMBERS } = await import("~/lib/handlists.server");
    const { total, ids: matched } = await selectMatchingIds(
      db,
      searchScope,
      askedQuery.input,
      {
        category,
        facets: askedQuery.facets,
        sort: askedQuery.sort,
        limit: HANDLIST_MAX_MEMBERS + 1,
      },
    );
    if (Math.max(total, matched.length) > HANDLIST_MAX_MEMBERS) {
      return Response.json({ ok: false, error: "ceiling" }, { status: 400 });
    }
    return Response.json({ ok: true, ids: matched });
  }

  const rawMode = (formData.get("mode") as string) || "";
  const mode: "ids" | "all" | null =
    rawMode === "ids" || rawMode === "all" ? rawMode : null;
  if (!mode) {
    throw new Response("Malformed carry", { status: 400 });
  }

  const ids = formData.getAll("ids").map(String).filter(Boolean);

  // The constraint labels are what the pills SAID, composed in the
  // reader's language on the surface that showed them; they are stored
  // for display and never re-interpreted as a query.
  let constraints: { label: string }[] = [];
  const rawConstraints = (formData.get("constraints") as string) || "";
  if (rawConstraints) {
    try {
      const parsedConstraints: unknown = JSON.parse(rawConstraints);
      if (Array.isArray(parsedConstraints)) {
        constraints = parsedConstraints
          .map((entry) =>
            entry && typeof entry === "object" && "label" in entry
              ? String((entry as { label: unknown }).label)
              : "",
          )
          .filter(Boolean)
          .map((label) => ({ label }));
      }
    } catch {
      // A malformed summary costs the scope its labels, not its
      // members: the ids are the thing being carried.
      constraints = [];
    }
  }

  // "All matching" inside a set is materialised HERE rather than by the
  // carry, which knows nothing about handlists: the same question, run
  // on the same ground the results page ran it on, handed on as the
  // explicit list it resolved to.
  let carryMode = mode;
  let carryIds = ids;
  if (mode === "all" && searchScope.handlistId) {
    const { selectMatchingIds } = await import("~/lib/global-search.server");
    const { CARRIED_SCOPE_MAX_MEMBERS } = await import(
      "~/lib/carried-scopes.server"
    );
    const { ids: matched } = await selectMatchingIds(
      db,
      searchScope,
      askedQuery.input,
      {
        category,
        facets: askedQuery.facets,
        sort: askedQuery.sort,
        // One past the cap, so an oversized set is refused by the
        // stash rather than stored short.
        limit: CARRIED_SCOPE_MAX_MEMBERS + 1,
      },
    );
    carryMode = "ids";
    carryIds = matched;
  }

  // The faceted total at carry time — the left-hand side of the pruned
  // arithmetic («6 found − 1 unticked»). A ticked carry knows only its
  // own count, so the found figure is re-asked of the same scoped
  // query the results page ran; without it a pruned set would read as
  // "all matches included", which the carried-scope card forbids.
  let found: number | undefined;
  if (mode === "ids") {
    const { countMatching } = await import("~/lib/global-search.server");
    found = await countMatching(db, searchScope, askedQuery.input, {
      category,
      facets: askedQuery.facets,
    });
  }

  const scopeId = await stashCarriedScope(db, user, tenant, {
    recordType,
    mode: carryMode,
    ids: carryIds,
    constraints,
    query: askedQuery,
    found,
  });

  // Only a search URL is a legitimate return: a `resume` is a pending
  // query change, and anything else is somebody else's redirect.
  const resume = (formData.get("resume") as string) || "";
  if (resume.startsWith("/search")) return redirect(resume);
  return redirect(`/admin/exports?scope=${scopeId}`);
}

// ---------------------------------------------------------------------------
// Highlight rendering
// ---------------------------------------------------------------------------

/**
 * Split a marked string into plain and matched runs. The markers are
 * control characters chosen because they cannot occur in stored text,
 * so the split is unambiguous and the result goes into the tree as
 * React children — never as raw HTML. A browse-mode title carries no
 * markers at all and comes through as one plain run.
 */
function markedRuns(
  text: string,
  open: string,
  close: string,
): { text: string; hit: boolean }[] {
  const runs: { text: string; hit: boolean }[] = [];
  let rest = text;
  while (rest.length > 0) {
    const start = rest.indexOf(open);
    if (start === -1) {
      // A stray close marker with no opener would otherwise land in the
      // DOM as an invisible control character — strip, never render.
      runs.push({ text: rest.replaceAll(close, ""), hit: false });
      break;
    }
    if (start > 0) runs.push({ text: rest.slice(0, start), hit: false });
    const afterOpen = rest.slice(start + open.length);
    const end = afterOpen.indexOf(close);
    if (end === -1) {
      // An unclosed marker can only mean a truncated snippet; take the
      // remainder as matched rather than dropping it.
      runs.push({ text: afterOpen, hit: true });
      break;
    }
    runs.push({ text: afterOpen.slice(0, end), hit: true });
    rest = afterOpen.slice(end + close.length);
  }
  return runs;
}

function Marked({
  text,
  markers,
}: {
  text: string;
  markers: { open: string; close: string };
}) {
  return (
    <>
      {markedRuns(text, markers.open, markers.close).map((run, i) =>
        run.hit ? (
          <mark
            key={i}
            className="rounded-[2px] bg-saffron-tint px-px text-inherit"
          >
            {run.text}
          </mark>
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Result rows
// ---------------------------------------------------------------------------

const ROW_CLASS =
  "block border-b border-stone-100 px-3 py-3 transition-colors hover:bg-stone-50";

/**
 * A ticked row wears the verdigris wash a chosen scope wears on the
 * export page — the same dye for the same fact, which is what the tick
 * is promising. It has to defeat the hover as well, or pointing at a
 * chosen row would say it is no longer chosen.
 */
const rowClass = (selected?: boolean) =>
  selected
    ? `${ROW_CLASS} bg-verdigris-wash hover:bg-verdigris-wash`
    : ROW_CLASS;

function DescriptionRow({
  hit,
  markers,
  selected,
}: {
  hit: DescriptionHit;
  markers: { open: string; close: string };
  selected?: boolean;
}) {
  const { t } = useTranslation("descriptions_admin");
  const levelKey = LEVEL_LABEL_KEYS[hit.level];
  return (
    <Link to={`/admin/descriptions/${hit.id}`} className={rowClass(selected)}>
      <p className="flex flex-wrap items-center gap-x-2 text-11 text-stone-500">
        <span className="font-mono text-11 text-stone-600">
          {hit.referenceCode}
        </span>
        {/* Off-enum levels fall back to the raw value, matching the
            descriptions surface this label is borrowed from. */}
        <span>{levelKey ? t(levelKey) : hit.level}</span>
        {hit.dateExpression && <span>{hit.dateExpression}</span>}
      </p>
      <p className="mt-0.5 text-sm font-medium text-indigo">
        <Marked text={hit.titleMarked} markers={markers} />
      </p>
      {hit.scopeSnippet && (
        <p className="mt-1 text-13 text-stone-500">
          <Marked text={hit.scopeSnippet} markers={markers} />
        </p>
      )}
    </Link>
  );
}

function EntityRow({ hit, selected }: { hit: EntityHit; selected?: boolean }) {
  const { t } = useTranslation("entities");
  const typeKey = ENTITY_TYPE_LABEL_KEYS[hit.entityType];
  return (
    <Link to={`/admin/entities/${hit.id}`} className={rowClass(selected)}>
      <p className="flex flex-wrap items-center gap-x-2 text-11 text-stone-500">
        {hit.entityCode && (
          <span className="font-mono text-11 text-stone-600">
            {hit.entityCode}
          </span>
        )}
        {typeKey && <span>{t(typeKey)}</span>}
      </p>
      <p className="mt-0.5 text-sm font-medium text-indigo">
        {hit.displayName}
      </p>
      {hit.primaryFunction && (
        <p className="mt-1 text-13 text-stone-500">{hit.primaryFunction}</p>
      )}
    </Link>
  );
}

function PlaceRow({ hit, selected }: { hit: PlaceHit; selected?: boolean }) {
  const { t } = useTranslation("places");
  const typeKey = hit.placeType ? PLACE_TYPE_LABEL_KEYS[hit.placeType] : null;
  return (
    <Link to={`/admin/places/${hit.id}`} className={rowClass(selected)}>
      <p className="flex flex-wrap items-center gap-x-2 text-11 text-stone-500">
        {hit.placeCode && (
          <span className="font-mono text-11 text-stone-600">
            {hit.placeCode}
          </span>
        )}
        {typeKey && <span>{t(typeKey)}</span>}
      </p>
      <p className="mt-0.5 text-sm font-medium text-indigo">
        {hit.displayName}
      </p>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// The advanced form
// ---------------------------------------------------------------------------

/** The operator options, in the order the select offers them. */
const ADVANCED_OPS = ["and", "or", "not"] as const;

/** Operator labels — options on a control, never keywords to type. */
const OP_LABEL_KEYS: Record<AdvancedOp, string> = {
  and: "opAnd",
  or: "opOr",
  not: "opNot",
};

/**
 * One criteria row as the form holds it, before it is serialised. The
 * kind is what the row's criterion select chose, and it decides both
 * the value control the row draws and the URL parameter the row
 * becomes: a text row an `adv` value, a date row the year bounds, a
 * level, repository, entity-type or place-type row one facet value, a
 * category row the kind of object being looked for. Only text rows
 * carry an operator, because only they can be excluded or ORed — the
 * rest plainly narrow.
 */
type DraftRow = { id: number } & (
  | { kind: "text"; op: AdvancedOp; field: SearchField | ""; term: string }
  | { kind: "date"; from: string; to: string }
  | { kind: "level"; value: string }
  | { kind: "repo"; value: string }
  | { kind: "etype"; value: string }
  | { kind: "ptype"; value: string }
  | { kind: "cat"; value: SearchCategory | "" }
);

/**
 * The criterion select's vocabulary: the empty string and the search
 * fields are text criteria (the value is the row's field scope), the
 * named kinds are the structured ones. None of the sentinels collides
 * with a `SearchField`, so the select's value doubles as the row's
 * kind without a second control.
 */
type CriterionValue =
  | ""
  | SearchField
  | "date"
  | "level"
  | "repo"
  | "etype"
  | "ptype"
  | "cat";

/**
 * The structured criteria, in the order the select offers them after
 * the text ones, each with the label key it borrows and the CONTEXT it
 * belongs to — the kind of object it is able to narrow. The category
 * criterion has none, because it is the one that NAMES a context
 * rather than presupposing one. Date and category are SINGLETONS: a
 * second year range or a second category would be two answers to one
 * question, so once a row holds one, the option is disabled in every
 * other row.
 */
const STRUCTURED_CRITERIA = [
  {
    value: "date",
    labelKey: "dateHeading",
    singleton: true,
    context: "descriptions",
  },
  {
    value: "level",
    labelKey: "filterLevel",
    singleton: false,
    context: "descriptions",
  },
  {
    value: "repo",
    labelKey: "filterRepository",
    singleton: false,
    context: "descriptions",
  },
  {
    value: "etype",
    labelKey: "filterType",
    singleton: false,
    context: "entities",
  },
  {
    value: "ptype",
    labelKey: "filterPlaceType",
    singleton: false,
    context: "places",
  },
  { value: "cat", labelKey: "filterCategory", singleton: true, context: null },
] as const;

/**
 * What a row says about the kind of object being looked for. A
 * category row says it outright; every other structured criterion says
 * it by implication, because it can only be asked of one index — and a
 * text row does too as soon as it is scoped to a record column. A row
 * that has not been given a value yet still counts: it is a question
 * being composed, and the rest of the form has to make room for it.
 */
function rowContext(row: DraftRow): SearchCategory | null {
  if (row.kind === "cat") return row.value === "" ? null : row.value;
  if (row.kind === "etype") return "entities";
  if (row.kind === "ptype") return "places";
  if (row.kind === "text") return row.field === "" ? null : "descriptions";
  return "descriptions";
}

const CONTROL_CLASS =
  "h-[34px] rounded-lg border border-stone-300 bg-white px-2 font-sans text-13 text-stone-700 focus:border-indigo focus:outline-none";

/**
 * The classic archival query, composed rather than typed: ONE list of
 * criteria rows and nothing else. Everything that can narrow the
 * search is a row — a term, a year range, a level, a repository, an
 * entity or place type, the kind of object being searched — so there
 * is a single place to look for what is being asked and a single way
 * to take a piece of it back. The row's criterion select chooses
 * which, and the value control changes underneath it: a text criterion
 * gets the operator and the term it always had, a date criterion two
 * year boxes, and the rest a select over their own vocabulary whose
 * first option is "any".
 *
 * ONE LIST, THREE ZONES. The list reads top to bottom as the question
 * is actually shaped, and a row lives in the zone its criterion
 * belongs to rather than where it happened to be added. The category
 * row comes first, because it is the root question and everything
 * under it is asked of whatever it names. Then the boolean chain of
 * text rows, where order is meaningful and every row but the first
 * carries the operator joining it to what came before. Then, under a
 * rule, the narrowing criteria — order-free and always AND, because
 * "level: file" and "from 1700" do not read differently in the other
 * sequence. Changing a row's criterion moves it to its zone; adding
 * one puts it at the foot of its own.
 *
 * THE ROWS KNOW ABOUT EACH OTHER. Each row implies what is being
 * looked for — the category row by naming it, a date, level,
 * repository or field-scoped term by being answerable only of records,
 * an entity-type or place-type row by being answerable only of that
 * authority — and the union of those implications is the form's
 * CONTEXT. Whatever the context already is takes the contradicting
 * options off the other rows: records criteria go disabled while the
 * question is about authorities, the record field scopes with them,
 * authority criteria are absent outside their own context, and the
 * category select loses whichever categories would strand a row that
 * is already there. Nothing is ever silently rewritten, and because
 * the exclusion holds on both sides, removing any row — the category
 * row included — only relaxes the context. It can never orphan a
 * sibling.
 *
 * The form is a COMPOSER, not a browser — no live counts, no results
 * moving underneath the controls as they are touched. Nothing happens
 * until it is submitted, and what submitting does is build a URL and
 * go there, so the address bar carries the whole question exactly as
 * it does in the default view.
 *
 * The draft rows are seeded from the URL and the component is keyed on
 * the URL, so every navigation — including going back — reseeds the
 * form from the query it is showing results for, rather than leaving
 * yesterday's half-edited criteria on screen.
 */
function AdvancedForm({
  rows,
  dateFrom,
  dateTo,
  levels,
  repoIds,
  entityTypes,
  placeTypes,
  repositoryOptions,
  namedCategory,
  includeAuthorities,
  armed,
  guard,
}: {
  rows: AdvancedRow[];
  dateFrom: string | null;
  dateTo: string | null;
  levels: string[];
  repoIds: string[];
  entityTypes: string[];
  placeTypes: string[];
  repositoryOptions: RepositoryOption[];
  namedCategory: SearchCategory | null;
  includeAuthorities: boolean;
  /** True while a selection is held: the submit wears the cost. */
  armed?: boolean;
  /** Returns true when the results page intercepted the navigation. */
  guard?: (act: string, href: string) => boolean;
}) {
  const { t } = useTranslation("search");
  const { t: td } = useTranslation("descriptions_admin");
  const { t: te } = useTranslation("entities");
  const { t: tp } = useTranslation("places");
  const navigate = useNavigate();

  const nextId = useRef(0);
  const blankRow = (): DraftRow => ({
    id: nextId.current++,
    kind: "text",
    op: "and",
    field: "",
    term: "",
  });
  /**
   * Seeded from the URL, one row per thing the URL is asking: the
   * criteria rows first, then the date range, then each level, then
   * each repository, then each entity type, then each place type, then
   * the category. That is the order the zones render in too (bar the
   * category, which is pinned to the top), so a URL round-trip never
   * visibly reshuffles the form. An empty URL still gets one blank
   * text row — a form with no rows offers nothing to fill in.
   */
  const [draftRows, setDraftRows] = useState<DraftRow[]>(() => {
    const seeded: DraftRow[] = rows.map((r) => ({
      id: nextId.current++,
      kind: "text",
      op: r.op,
      field: r.field ?? "",
      term: r.term,
    }));
    if (dateFrom !== null || dateTo !== null) {
      seeded.push({
        id: nextId.current++,
        kind: "date",
        from: dateFrom ?? "",
        to: dateTo ?? "",
      });
    }
    for (const value of levels) {
      seeded.push({ id: nextId.current++, kind: "level", value });
    }
    for (const value of repoIds) {
      seeded.push({ id: nextId.current++, kind: "repo", value });
    }
    for (const value of entityTypes) {
      seeded.push({ id: nextId.current++, kind: "etype", value });
    }
    for (const value of placeTypes) {
      seeded.push({ id: nextId.current++, kind: "ptype", value });
    }
    if (namedCategory) {
      seeded.push({ id: nextId.current++, kind: "cat", value: namedCategory });
    }
    return seeded.length > 0 ? seeded : [blankRow()];
  });

  /** Patch a row in place, leaving every sibling's identity alone. */
  const patchRow = (id: number, patch: (row: DraftRow) => DraftRow) =>
    setDraftRows((current) =>
      current.map((row) => (row.id === id ? patch(row) : row)),
    );

  /**
   * Changing the criterion rebuilds the row around the new kind, blank
   * rather than carrying a value across vocabularies — a level is not
   * a repository and neither is a year. Re-picking the kind a row
   * already holds leaves it untouched, and the text criteria differ
   * only in their field scope, so switching between them keeps the
   * term and the operator.
   */
  const setCriterion = (id: number, value: CriterionValue) =>
    patchRow(id, (row): DraftRow => {
      if (value === "date") {
        return row.kind === "date" ? row : { id, kind: "date", from: "", to: "" };
      }
      if (value === "level") {
        return row.kind === "level" ? row : { id, kind: "level", value: "" };
      }
      if (value === "repo") {
        return row.kind === "repo" ? row : { id, kind: "repo", value: "" };
      }
      if (value === "etype") {
        return row.kind === "etype" ? row : { id, kind: "etype", value: "" };
      }
      if (value === "ptype") {
        return row.kind === "ptype" ? row : { id, kind: "ptype", value: "" };
      }
      if (value === "cat") {
        return row.kind === "cat" ? row : { id, kind: "cat", value: "" };
      }
      return row.kind === "text"
        ? { ...row, field: value }
        : { id, kind: "text", op: "and", field: value, term: "" };
    });

  /** The select's value for a row: the field scope, or the kind. */
  const criterionOf = (row: DraftRow): CriterionValue =>
    row.kind === "text" ? row.field : row.kind;

  /** Which singleton criteria are already spoken for. */
  const taken = (kind: string) => draftRows.some((row) => row.kind === kind);

  // -- Zones ----------------------------------------------------------
  // The rendered order is derived, never stored: a row moves the moment
  // its criterion changes, and the state keeps only the order that
  // matters — the sequence of the text rows inside the chain.
  const categoryRow = draftRows.find((row) => row.kind === "cat");
  const textRows = draftRows.filter((row) => row.kind === "text");
  const narrowingRows = draftRows.filter(
    (row) => row.kind !== "cat" && row.kind !== "text",
  );
  const orderedRows: DraftRow[] = [
    ...(categoryRow ? [categoryRow] : []),
    ...textRows,
    ...narrowingRows,
  ];

  /**
   * What the form is asking about, from the rows themselves: the
   * category row's own choice if it has one, otherwise the first thing
   * another row implies. The two can never disagree — the option that
   * would let them is disabled on both sides — so a union is a
   * first-hit search.
   */
  const chosenCategory: SearchCategory | "" =
    categoryRow?.kind === "cat" ? categoryRow.value : "";
  const context: SearchCategory | null =
    chosenCategory ||
    draftRows.map(rowContext).find((c) => c !== null) ||
    null;
  /** True while the question is about an authority index. */
  const authorityContext = context !== null && context !== "descriptions";

  const levelLabel = (value: string) => {
    const key = LEVEL_LABEL_KEYS[value];
    return key ? td(key) : value;
  };
  const entityTypeLabel = (value: string) => {
    const key = ENTITY_TYPE_LABEL_KEYS[value];
    return key ? te(key) : value;
  };
  const placeTypeLabel = (value: string) => {
    const key = PLACE_TYPE_LABEL_KEYS[value];
    return key ? tp(key) : value;
  };

  /**
   * The categories a category row may name. A gated-out category is
   * absent from the form for the same reason it is absent from the
   * tabs: it is not a question this tenant can ask.
   */
  const categoryOptions = CATEGORY_ORDER.filter(
    (c) => c === "descriptions" || includeAuthorities,
  );

  /**
   * A category that would strand an existing row is not on offer:
   * picking Entities with a level row on screen would leave that row
   * asking something no entity has. "Any" is always available, because
   * it hands the context back to whatever the other rows imply.
   */
  const categoryTaken = (value: SearchCategory) =>
    value !== chosenCategory &&
    draftRows.some((row) => {
      if (row.kind === "cat") return false;
      const implied = rowContext(row);
      return implied !== null && implied !== value;
    });

  /**
   * Submit builds the URL and navigates. A row with nothing chosen in
   * it is simply not serialised — an unfilled criterion is not an
   * empty search, it is a row somebody stopped filling in. Among the
   * text rows the anchor must be positive, and an exclusion is never
   * quietly inverted into an inclusion: a row still showing "not" when
   * the anchor slot reaches it is skipped (the parser applies the same
   * rule to a crafted URL). Anchoring counts positions among the TEXT
   * rows alone: the category row sits above them and joins nothing.
   * If nothing at all survives — no term, no year, no facet, no
   * category — there is no question to ask and no navigation.
   */
  const submit = () => {
    const params = new URLSearchParams();
    params.set("view", "advanced");
    let anchored = false;
    let yearFrom: string | null = null;
    let yearTo: string | null = null;
    const levelValues: string[] = [];
    const repoValues: string[] = [];
    const entityTypeValues: string[] = [];
    const placeTypeValues: string[] = [];
    for (const [index, row] of textRows.entries()) {
      if (row.kind !== "text") continue;
      const term = row.term.trim();
      if (!term) continue;
      if (!anchored && index > 0 && row.op === "not") continue;
      params.append(
        "adv",
        encodeAdvancedRow({
          op: anchored ? row.op : "and",
          field: row.field === "" ? null : row.field,
          term,
        }),
      );
      anchored = true;
    }
    for (const row of narrowingRows) {
      if (row.kind === "date") {
        yearFrom = readYear(row.from);
        yearTo = readYear(row.to);
      } else if (row.kind === "level") {
        if (row.value) levelValues.push(row.value);
      } else if (row.kind === "repo") {
        if (row.value) repoValues.push(row.value);
      } else if (row.kind === "etype") {
        if (row.value) entityTypeValues.push(row.value);
      } else if (row.kind === "ptype") {
        if (row.value) placeTypeValues.push(row.value);
      }
    }
    if (yearFrom) params.set("dateFrom", yearFrom);
    if (yearTo) params.set("dateTo", yearTo);
    for (const value of levelValues) params.append("level", value);
    for (const value of repoValues) params.append("repoId", value);
    for (const value of entityTypeValues) params.append("type", value);
    for (const value of placeTypeValues) params.append("placeType", value);
    if (
      !anchored &&
      !yearFrom &&
      !yearTo &&
      levelValues.length === 0 &&
      repoValues.length === 0 &&
      entityTypeValues.length === 0 &&
      placeTypeValues.length === 0 &&
      !chosenCategory
    ) {
      return;
    }
    // The context is serialised whether or not a category row spelled
    // it out: a level criterion asked on the grouped view is a
    // narrowing nothing would apply, so the form says which category
    // its criteria are for rather than leaving the results to guess.
    if (context) params.set("cat", context);
    // Sort and page are deliberately absent: a new question starts at
    // its default order, on page one.
    const href = `/search?${params.toString()}`;
    // Submitting the form IS the query change, so a selection held over
    // the results below gets its say first.
    if (guard?.(t("searchAction"), href)) return;
    navigate(href);
  };

  /**
   * One criteria row, wherever it sits. `position` numbers it for the
   * group label; `textIndex` is its place in the boolean chain, and -1
   * for a row that is not part of one — only a text row after the
   * anchor joins on to anything, so only it carries an operator.
   */
  const criteriaRow = (row: DraftRow, position: number, textIndex: number) => {
    const current = criterionOf(row);
    return (
      <div
        key={row.id}
        role="group"
        aria-label={t("rowLabel", { n: position + 1 })}
        className="flex flex-wrap items-center gap-2"
      >
        {/* Only a text criterion joins on to what came before, and the
            anchor carries no operator either: there is nothing to its
            left for one to join it to. */}
        {row.kind === "text" && textIndex > 0 && (
          <select
            value={row.op}
            onChange={(event) =>
              patchRow(row.id, (r) =>
                r.kind === "text"
                  ? { ...r, op: event.target.value as AdvancedOp }
                  : r,
              )
            }
            aria-label={t("advOpLabel")}
            className={`${CONTROL_CLASS} w-[6.5rem]`}
          >
            {ADVANCED_OPS.map((op) => (
              <option key={op} value={op}>
                {t(OP_LABEL_KEYS[op])}
              </option>
            ))}
          </select>
        )}
        <select
          value={current}
          onChange={(event) =>
            setCriterion(row.id, event.target.value as CriterionValue)
          }
          aria-label={t("refineFieldLabel")}
          className={`${CONTROL_CLASS} w-[11rem]`}
        >
          <option value="">{t("fieldAll")}</option>
          {/* A field scope is a record column, so it goes the way the
              record criteria go once the question is an authority
              one — unavailable, but still named. "All fields" asks
              nothing of any particular index and always stands. */}
          {SEARCH_FIELDS.map((f) => (
            <option key={f} value={f} disabled={authorityContext && current !== f}>
              {t(FIELD_LABEL_KEYS[f])}
            </option>
          ))}
          {/* Records criteria are always listed and merely disabled out
              of context; authority criteria are not listed at all
              outside theirs, since a place type is not a narrowing
              anybody could apply to a fonds. A row's own criterion is
              always both listed and enabled — the select has to be
              able to show what the row already holds. */}
          {STRUCTURED_CRITERIA.filter(
            (criterion) =>
              criterion.value === current ||
              criterion.context === null ||
              criterion.context === "descriptions" ||
              (includeAuthorities &&
                (context === null || context === criterion.context)),
          ).map((criterion) => (
            <option
              key={criterion.value}
              value={criterion.value}
              disabled={
                criterion.value !== current &&
                ((criterion.singleton && taken(criterion.value)) ||
                  (criterion.context !== null &&
                    context !== null &&
                    context !== criterion.context))
              }
            >
              {t(criterion.labelKey)}
            </option>
          ))}
        </select>
        {row.kind === "text" && (
          <input
            type="text"
            value={row.term}
            onChange={(event) =>
              patchRow(row.id, (r) =>
                r.kind === "text" ? { ...r, term: event.target.value } : r,
              )
            }
            placeholder={t("advTermPlaceholder")}
            aria-label={t("advTermPlaceholder")}
            className={`${CONTROL_CLASS} min-w-[8rem] flex-1`}
          />
        )}
        {/* Years, not dates: a record answers the range when its own
            span overlaps it. */}
        {row.kind === "date" && (
          <>
            <input
              type="text"
              inputMode="numeric"
              maxLength={4}
              value={row.from}
              onChange={(event) =>
                patchRow(row.id, (r) =>
                  r.kind === "date" ? { ...r, from: event.target.value } : r,
                )
              }
              placeholder={t("dateFrom")}
              aria-label={t("dateFrom")}
              className={`${CONTROL_CLASS} w-24 nums`}
            />
            <input
              type="text"
              inputMode="numeric"
              maxLength={4}
              value={row.to}
              onChange={(event) =>
                patchRow(row.id, (r) =>
                  r.kind === "date" ? { ...r, to: event.target.value } : r,
                )
              }
              placeholder={t("dateTo")}
              aria-label={t("dateTo")}
              className={`${CONTROL_CLASS} w-24 nums`}
            />
          </>
        )}
        {row.kind === "level" && (
          <select
            value={row.value}
            onChange={(event) =>
              patchRow(row.id, (r) =>
                r.kind === "level" ? { ...r, value: event.target.value } : r,
              )
            }
            aria-label={t("filterLevel")}
            className={`${CONTROL_CLASS} min-w-[8rem] flex-1`}
          >
            <option value="">{t("anyOption")}</option>
            {DESCRIPTION_LEVELS.map((value) => (
              <option key={value} value={value}>
                {levelLabel(value)}
              </option>
            ))}
          </select>
        )}
        {row.kind === "repo" && (
          <select
            value={row.value}
            onChange={(event) =>
              patchRow(row.id, (r) =>
                r.kind === "repo" ? { ...r, value: event.target.value } : r,
              )
            }
            aria-label={t("filterRepository")}
            className={`${CONTROL_CLASS} min-w-[8rem] flex-1`}
          >
            <option value="">{t("anyOption")}</option>
            {repositoryOptions.map((repository) => (
              <option key={repository.id} value={repository.id}>
                {repository.name}
              </option>
            ))}
          </select>
        )}
        {/* Entity and place types repeat and OR together, the way the
            sidebar's checkboxes in those groups do — two type rows are
            two acceptable answers, not two conditions to satisfy. */}
        {row.kind === "etype" && (
          <select
            value={row.value}
            onChange={(event) =>
              patchRow(row.id, (r) =>
                r.kind === "etype" ? { ...r, value: event.target.value } : r,
              )
            }
            aria-label={t("filterType")}
            className={`${CONTROL_CLASS} min-w-[8rem] flex-1`}
          >
            <option value="">{t("anyOption")}</option>
            {ENTITY_TYPES.map((value) => (
              <option key={value} value={value}>
                {entityTypeLabel(value)}
              </option>
            ))}
          </select>
        )}
        {row.kind === "ptype" && (
          <select
            value={row.value}
            onChange={(event) =>
              patchRow(row.id, (r) =>
                r.kind === "ptype" ? { ...r, value: event.target.value } : r,
              )
            }
            aria-label={t("filterPlaceType")}
            className={`${CONTROL_CLASS} min-w-[8rem] flex-1`}
          >
            <option value="">{t("anyOption")}</option>
            {PLACE_TYPES.map((value) => (
              <option key={value} value={value}>
                {placeTypeLabel(value)}
              </option>
            ))}
          </select>
        )}
        {row.kind === "cat" && (
          <select
            value={row.value}
            onChange={(event) =>
              patchRow(row.id, (r) =>
                r.kind === "cat"
                  ? { ...r, value: event.target.value as SearchCategory | "" }
                  : r,
              )
            }
            aria-label={t("filterCategory")}
            className={`${CONTROL_CLASS} min-w-[8rem] flex-1`}
          >
            <option value="">{t("anyOption")}</option>
            {categoryOptions.map((value) => (
              <option key={value} value={value} disabled={categoryTaken(value)}>
                {t(CATEGORY_LABEL_KEYS[value])}
              </option>
            ))}
          </select>
        )}
        {/* Any row can go, the category row included — the context it
            was holding simply falls back to what the others imply. The
            last one stays: a form with no rows offers nothing. */}
        {orderedRows.length > 1 && (
          <button
            type="button"
            onClick={() =>
              setDraftRows((current) => current.filter((r) => r.id !== row.id))
            }
            aria-label={t("removeRow")}
            className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg text-stone-400 hover:bg-stone-50 hover:text-stone-700"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        )}
      </div>
    );
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="rounded-xl border border-stone-200 p-4"
    >
      {/* The root question, then the boolean chain it is asked of. */}
      <div className="flex flex-col gap-2">
        {categoryRow && criteriaRow(categoryRow, 0, -1)}
        {textRows.map((row, index) =>
          criteriaRow(row, (categoryRow ? 1 : 0) + index, index),
        )}
      </div>

      {/* The narrowings, under a rule: they all AND together and none
          of them reads differently in another order, so the list stops
          being a sequence here and becomes a set. */}
      {narrowingRows.length > 0 && (
        <div className="mt-2 flex flex-col gap-2 border-t border-stone-200 pt-3">
          {narrowingRows.map((row, index) =>
            criteriaRow(
              row,
              orderedRows.length - narrowingRows.length + index,
              -1,
            ),
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setDraftRows((current) => [...current, blankRow()])}
        disabled={draftRows.length >= MAX_ADVANCED_ROWS}
        className="mt-2 inline-flex items-center gap-1 text-13 font-semibold text-indigo hover:underline disabled:text-stone-300 disabled:no-underline"
      >
        <Plus className="h-4 w-4" strokeWidth={1.75} />
        {t("addRow")}
      </button>

      <div className="mt-4 flex justify-end border-t border-stone-200 pt-4">
        <button
          type="submit"
          className={`inline-flex h-11 items-center rounded-lg px-5 text-15 font-semibold ${
            armed
              ? "border border-madder-soft bg-madder-wash text-madder-deep"
              : "bg-indigo text-parchment hover:bg-indigo-deep"
          }`}
        >
          {t("searchAction")}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Selection state
// ---------------------------------------------------------------------------

/**
 * A selection is either an explicit set of ids or the symbolic whole
 * matching set. The whole set is never enumerated in the browser: it
 * is a promise about a query, materialised server-side at the moment
 * it is carried.
 */
type Selection = { mode: "ids"; ids: Set<string> } | { mode: "all" };

/**
 * The selections in hand, one per index, and the question they were
 * made under. Ticking on the Records tab and then ticking on Places
 * builds two independent sets: a tab's bar speaks for its own kind, and
 * the grouped view's sections speak for all three side by side, one bar
 * each.
 */
interface SelectionState {
  signature: string;
  byType: Partial<Record<RecordType, Selection>>;
}

/**
 * The question, as a string, with PAGE and SORT deliberately left out:
 * page 3 of the same question is the same question, and so is the same
 * question in another order — so neither costs a tick. Everything that
 * narrows — the terms, the criteria rows, the year bounds, the facets
 * — is in, because a selection made under a narrowing is not a
 * selection under the query without it. The category is out too: each
 * category holds its own selection, so moving between tabs neither
 * clears nor warns.
 *
 * Facet params are only ever in the URL for the category on screen, so
 * a tab change that leaves facets behind DOES change the signature and
 * does clear — the facets it dropped were part of the question those
 * ticks answered.
 *
 * The handlist is in, for the same reason the year bounds are: standing
 * inside a set narrows the result list, so ticks made inside it are not
 * ticks made in the workspace. Taking the pill off is a new question
 * and costs what any other new question costs.
 */
function querySignature(input: {
  advanced: boolean;
  advRows: AdvancedRow[];
  boxQuery: string;
  refinements: SearchRefinement[];
  dateFrom: string | null;
  dateTo: string | null;
  handlistId: string | null;
  facets: ActiveFacets;
}): string {
  const params = new URLSearchParams();
  if (input.advanced) {
    params.set("view", "advanced");
    for (const r of input.advRows) params.append("adv", encodeAdvancedRow(r));
  } else {
    if (input.boxQuery || input.refinements.length > 0) {
      params.append("q", input.boxQuery);
    }
    for (const r of input.refinements) params.append("q", encodeRefinement(r));
  }
  if (input.dateFrom) params.set("dateFrom", input.dateFrom);
  if (input.dateTo) params.set("dateTo", input.dateTo);
  if (input.handlistId) params.set("handlist", input.handlistId);
  // Sorted, because a facet group is a SET: ticking two levels in the
  // other order is the same narrowing and must read as the same
  // question.
  for (const key of (Object.keys(input.facets) as FacetKey[]).sort()) {
    for (const value of [...input.facets[key]].sort()) {
      params.append(FACET_PARAM[key], value);
    }
  }
  return params.toString();
}

/** The armed treatment, straight off the card: madder, and only here. */
const ARMED_PILL = "border-madder-soft bg-madder-wash";

// ---------------------------------------------------------------------------
// The query-change warning
// ---------------------------------------------------------------------------

/**
 * What a new question costs, said before it is asked.
 *
 * The house dialog, in the shape `DismissDialog` established — the same
 * scrim, the same 27rem box, the same serif title and 44px buttons —
 * but not that component: this one takes no reason and offers THREE
 * ways out rather than two, and the third is the whole point. Cancel
 * keeps the question as it stands; "Remove and clear" spends the
 * selection knowingly; "Send to export first" stashes it and then lets
 * the change through, which is the move neither of the other buttons
 * implies.
 *
 * The consequence sits in a madder block because this is where the
 * cost is, and madder means cost — the armed control that opened this
 * dialog wears the same dye for the same reason. The block states the
 * cost ONE KIND AT A TIME: a tab spends one selection and says one
 * sentence, while a change made from the grouped view can spend a
 * records set and a places set at once, and each is named in its own
 * whole sentence rather than summed into a noun that fits neither.
 *
 * The third way out is offered only while a single kind is at stake. A
 * carried scope names one record class, so two kinds cannot be sent
 * ahead as one; with more than one held the dialog keeps the two ways
 * out it can honour and says nothing about a third it could not.
 */
function QueryChangeDialog({
  act,
  holds,
  onCancel,
  onSendFirst,
  onProceed,
}: {
  act: string;
  /** Every selection this change would spend, one sentence each. */
  holds: { recordType: RecordType; count: number }[];
  onCancel: () => void;
  /** Absent when more than one kind is at stake: one scope, one class. */
  onSendFirst?: () => void;
  onProceed: () => void;
}) {
  const { t } = useTranslation("search");
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,32,58,0.42)] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="search-warn-title"
    >
      <div className="w-full max-w-[27rem] rounded-lg border border-stone-200 bg-white p-6 shadow-lg">
        <p
          id="search-warn-title"
          className="font-serif text-xl font-semibold leading-snug tracking-[-0.005em] text-indigo"
        >
          {t("warnChangeTitle", { act })}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-indigo-soft [text-wrap:pretty]">
          {t("warnChangeBody1")}
        </p>
        <div className="mt-3.5 space-y-1.5 rounded-md border border-madder-tint bg-madder-wash px-3 py-2.5">
          {holds.map((hold) => (
            <p
              key={hold.recordType}
              className="text-13 leading-normal text-stone-600"
            >
              {t(WARN_BODY_KEYS[hold.recordType], { count: hold.count })}
            </p>
          ))}
          <p className="text-13 leading-normal text-stone-600">
            {t("warnChangeBelong")}
          </p>
        </div>
        {onSendFirst && (
          <div className="mt-3 flex items-start gap-2">
            <Info
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-400"
              strokeWidth={1.75}
            />
            <p className="text-11 leading-normal text-stone-500">
              {t("warnChangeBody3")}
            </p>
          </div>
        )}

        {/* Three ways out will not sit in a 27rem row, so they stack
            full width rather than wrapping into a ragged second line.
            Top to bottom is the narrow contract's rule: the way that
            keeps the work first, the committing one next, and Cancel
            last where an accidental thumb lands harmlessly. Source
            order is the same, so a screen reader hears the safe option
            before the destructive one. */}
        <div className="mt-5 flex flex-col gap-2.5">
          {onSendFirst && (
            <button
              type="button"
              onClick={onSendFirst}
              className="inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-lg bg-verdigris px-4.5 text-15 font-semibold text-white hover:bg-verdigris-deep"
            >
              <Download className="h-4 w-4" strokeWidth={1.75} />
              {t("warnSendFirst")}
            </button>
          )}
          <button
            type="button"
            onClick={onProceed}
            className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-indigo px-4.5 text-15 font-semibold text-parchment hover:bg-indigo-deep"
          >
            {t("warnRemoveClear")}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-11 w-full items-center justify-center rounded-lg border border-stone-300 bg-white px-4.5 text-15 font-semibold text-indigo hover:border-stone-400 hover:bg-stone-50"
          >
            {t("button.cancel", { ns: "common" })}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** One checkbox row's worth of facet: what it is, and how many. */
interface FacetOption {
  value: string;
  label: string;
  count: number;
}

/** A rendered facet group: its label, its category, and its values. */
interface FacetGroupModel {
  key: FacetKey;
  category: SearchCategory;
  label: string;
  options: FacetOption[];
  selected: string[];
}

export default function SearchPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("search");
  const { t: td } = useTranslation("descriptions_admin");
  const { t: te } = useTranslation("entities");
  const { t: tp } = useTranslation("places");
  const { formatNumber } = useFormatters();
  const navigate = useNavigate();
  const location = useLocation();
  const submit = useSubmit();
  const {
    advanced,
    handlist,
    handlistOptions,
    outsideTotal,
    advRows,
    dateFrom,
    dateTo,
    boxQuery,
    refinements,
    landing,
    recordsOnly,
    category,
    namedCategory,
    page,
    includeAuthorities,
    counts,
    facetCounts,
    mode,
    preview,
    pageResult,
    repositoryOptions,
    facets,
    sort,
    markers,
    pageSize,
  } = loaderData;

  // A field scope or a date bound narrows the world to the records
  // index, so the All tab and the authority tabs step aside rather
  // than showing absent counts. A handlist does the same for whichever
  // kind it holds: a set of records cannot answer the Entities tab, and
  // a tab that could only ever read zero is worse than no tab.
  const handlistCategory = handlistCategoryOf(handlist);
  const confined = recordsOnly || handlistCategory !== null;
  const visibleCategories: SearchCategory[] = recordsOnly
    ? ["descriptions"]
    : handlistCategory
      ? [handlistCategory]
      : CATEGORY_ORDER.filter((c) => c === "descriptions" || includeAuthorities);
  const totalHits = visibleCategories.reduce(
    (sum, c) => sum + (counts[c] ?? 0),
    0,
  );
  /** The honest number for the view on screen. */
  const activeTotal = category === "all" ? totalHits : (pageResult?.total ?? 0);

  // -- Selection ------------------------------------------------------
  // Ticks belong to a question and a category. The signature carries
  // the first; the map carries the second. A signature that no longer
  // matches the one the ticks were made under means the question
  // changed underneath them — by a back button, a pasted link, or a
  // change that came through the warning below — and they go, because
  // a selection that outlives its result set is a lie about what it
  // holds.
  const signature = querySignature({
    advanced,
    advRows,
    boxQuery,
    refinements,
    dateFrom,
    dateTo,
    handlistId: handlist?.id ?? null,
    facets,
  });
  const [selection, setSelection] = useState<SelectionState>(() => ({
    signature,
    byType: {},
  }));
  const heldState: SelectionState =
    selection.signature === signature ? selection : { signature, byType: {} };
  if (selection.signature !== signature) setSelection(heldState);

  /**
   * The one kind a tab holds; null on the grouped view, which holds all
   * three at once and speaks for each in its own section rather than
   * through a single bar.
   */
  const recordType = category === "all" ? null : RECORD_TYPE_OF[category];
  const held = recordType ? heldState.byType[recordType] : undefined;
  const heldIds = held?.mode === "ids" ? held.ids : null;
  const allMode = held?.mode === "all";
  const selectionCount = allMode ? activeTotal : (heldIds?.size ?? 0);
  const pageIds = pageResult ? pageResult.rows.map((row) => row.id) : [];
  /** How many pages the whole matching set spans — a number, not a guess. */
  const pageCount = Math.max(1, Math.ceil(activeTotal / pageSize));

  /** Write one kind's selection; the other kinds' are left untouched. */
  const setHeldFor = (type: RecordType, next: Selection | undefined) =>
    setSelection(() => {
      const byType = { ...heldState.byType };
      if (next) byType[type] = next;
      else delete byType[type];
      return { signature, byType };
    });

  const setHeld = (next: Selection | undefined) => {
    if (!recordType) return;
    setHeldFor(recordType, next);
  };

  /**
   * What a kind's selection stands for, as a number: the ids it holds,
   * or the whole matching total for that kind — which is the faceted
   * total on a tab and the section's own count on the grouped view.
   */
  const countHeld = (type: RecordType, total: number) => {
    const selected = heldState.byType[type];
    if (!selected) return 0;
    return selected.mode === "all" ? total : selected.ids.size;
  };

  /**
   * The selections THIS view speaks for, and so the ones a new question
   * asked from here would spend. A tab answers for its own kind alone —
   * a selection made under another tab is not the one being changed,
   * which is why the tabs are exempt from the warning in the first
   * place — while the grouped view shows all three kinds at once and
   * therefore answers for every one it is holding.
   */
  const spokenFor: { recordType: RecordType; count: number }[] =
    category === "all"
      ? visibleCategories
          .map((c) => ({
            recordType: RECORD_TYPE_OF[c],
            count: countHeld(RECORD_TYPE_OF[c], counts[c] ?? 0),
          }))
          .filter((entry) => entry.count > 0)
      : recordType !== null && selectionCount > 0
        ? [{ recordType, count: selectionCount }]
        : [];
  const selectionLive = spokenFor.length > 0;
  /** The single kind at stake, when there is only one. */
  const soleHold = spokenFor.length === 1 ? spokenFor[0] : null;

  /** Let go of everything this view speaks for, and nothing else. */
  const clearSpokenFor = () =>
    setSelection(() => {
      const byType = { ...heldState.byType };
      for (const entry of spokenFor) delete byType[entry.recordType];
      return { signature, byType };
    });

  /**
   * Ticking in `ids` mode adds or removes one id. Unticking inside the
   * whole matching set cannot subtract from a promise, so it demotes:
   * what is left is the rows on show minus the one just let go — this
   * page's rows on a tab, this section's rows in the grouped view.
   */
  const toggleRowOf = (
    type: RecordType,
    visibleIds: string[],
    id: string,
    next: boolean,
  ) => {
    const selected = heldState.byType[type];
    if (selected?.mode === "all") {
      setHeldFor(type, {
        mode: "ids",
        ids: new Set(visibleIds.filter((v) => v !== id)),
      });
      return;
    }
    const ids = new Set(selected?.mode === "ids" ? selected.ids : []);
    if (next) ids.add(id);
    else ids.delete(id);
    setHeldFor(type, ids.size > 0 ? { mode: "ids", ids } : undefined);
  };

  const pageAllTicked =
    pageIds.length > 0 && pageIds.every((id) => heldIds?.has(id));

  const togglePage = () => {
    const ids = new Set(heldIds ?? []);
    for (const id of pageIds) {
      if (pageAllTicked) ids.delete(id);
      else ids.add(id);
    }
    setHeld(ids.size > 0 ? { mode: "ids", ids } : undefined);
  };

  // -- Armed controls -------------------------------------------------
  // While ticks are held, anything that would re-ask the question says
  // so before it does it. The pending change is kept as the URL it
  // would have gone to, so whichever way out of the dialog is taken —
  // proceed, or send to export first — replays exactly the navigation
  // that was interrupted.
  const [pending, setPending] = useState<{ act: string; href: string } | null>(
    null,
  );

  /** True when the change was intercepted, so the caller stands down. */
  const guard = (act: string, href: string): boolean => {
    if (!selectionLive) return false;
    setPending({ act, href });
    return true;
  };

  /** Navigate, unless a live selection says to ask first. */
  const go = (act: string, href: string) => {
    if (!guard(act, href)) navigate(href);
  };

  // -- URL construction ----------------------------------------------
  // Every navigation is a URL built from scratch out of the current
  // state plus the one thing being changed, so the address bar and the
  // screen can never drift apart.

  const sortWire = (spec: SortSpec | null) =>
    spec ? `${spec.key}:${spec.dir}` : null;

  const searchUrl = (options: {
    box?: string;
    refs?: SearchRefinement[];
    dates?: { from: string | null; to: string | null };
    /** Null widens back to the workspace; omitted keeps the set. */
    handlist?: string | null;
    cat?: "all" | SearchCategory;
    facets?: ActiveFacets;
    sort?: SortSpec | null;
    page?: number;
  }) => {
    const cat = options.cat ?? category;
    const nextFacets = options.facets ?? facets;
    // A sort key belongs to the category it was chosen in; crossing to
    // another category starts from that category's default.
    const nextSort =
      options.sort !== undefined ? options.sort : cat === category ? sort : null;

    const params = new URLSearchParams();
    // The query itself, in whichever grammar this view speaks. One
    // helper serves both so a tab, a sort and a page link cannot end up
    // carrying different halves of the state.
    if (advanced) {
      params.set("view", "advanced");
      for (const r of advRows) params.append("adv", encodeAdvancedRow(r));
    } else {
      const box = options.box ?? boxQuery;
      const refs = options.refs ?? refinements;
      // The box first — kept even when empty, so `getAll("q")[0]` stays
      // the box slot whenever refinements follow — then each refinement.
      if (box || refs.length > 0) params.append("q", box);
      for (const r of refs) params.append("q", encodeRefinement(r));
    }
    // The date bounds belong to neither grammar and to both views.
    const dates = options.dates ?? { from: dateFrom, to: dateTo };
    if (dates.from) params.set("dateFrom", dates.from);
    if (dates.to) params.set("dateTo", dates.to);
    // The ground the question stands on travels on every link the page
    // builds — a sort, a page, a tab — because none of those is a
    // reason to step out of the set.
    const nextHandlist =
      options.handlist !== undefined ? options.handlist : (handlist?.id ?? null);
    if (nextHandlist) params.set("handlist", nextHandlist);
    if (cat !== "all") {
      params.set("cat", cat);
      const wire = sortWire(nextSort);
      if (wire) params.set("sort", wire);
    }
    // In the Zasqua view, facet params belong to the category view that
    // owns them. In the advanced view those same groups are part of the
    // COMPOSED QUERY — form criteria, not sidebar state — so they
    // travel on every link, the grouped view's included, and which
    // groups travel follows the category the criteria were composed
    // for: the record groups under Records or no category at all, the
    // type of the authority under each authority.
    if (advanced) {
      for (const key of ADVANCED_FACET_KEYS[cat === "all" ? "descriptions" : cat]) {
        for (const value of nextFacets[key]) params.append(FACET_PARAM[key], value);
      }
    } else if (cat !== "all") {
      for (const key of CATEGORY_FACET_KEYS[cat]) {
        for (const value of nextFacets[key]) params.append(FACET_PARAM[key], value);
      }
    }
    // The page is opt-in: every other change drops it, because a page
    // number from a different question means nothing.
    if (options.page && options.page > 1) params.set("page", String(options.page));
    const query = params.toString();
    return query ? `/search?${query}` : "/search";
  };

  /**
   * A tab link keeps the whole query and drops the page and sort. In
   * the Zasqua view it also drops the facets (they belong to the view
   * being left); in the advanced view the level/repository criteria
   * are part of the query and survive the tab change.
   */
  const tabLink = (next: "all" | SearchCategory) =>
    searchUrl({
      cat: next,
      facets: advanced ? facets : EMPTY_FACETS,
      sort: null,
    });

  const pageLink = (next: number) => searchUrl({ page: next });

  // -- Refine widget --------------------------------------------------
  // Adding never mutates in place: it builds the next URL — every
  // current q value plus the new refinement, page dropped, facets kept
  // — and navigates, so the loader re-parses and the URL stays the
  // single source of truth.
  const [draftTerm, setDraftTerm] = useState("");
  const [draftField, setDraftField] = useState<SearchField | "">("");
  const [draftOp, setDraftOp] = useState<"AND" | "NOT">("AND");
  const [filtersOpen, setFiltersOpen] = useState(false);

  const addRefinement = () => {
    // Leading hyphens are stripped from the draft: here the include/
    // exclude choice belongs to the operator control, and a hyphen kept
    // in front would flip a "yes" term to an exclusion on the next
    // navigation, since the URL's wire form has no escaping.
    const term = draftTerm.trim().replace(/^-+/, "").trim();
    // A blank draft and a duplicate are ignored without ceremony — no
    // error, no navigation — matching the parser's own drops. Length is
    // not a rule: one character is a term like any other.
    if (!term) return;
    const next: SearchRefinement = {
      term,
      op: draftOp,
      field: draftField === "" ? null : draftField,
    };
    if (
      refinements.some(
        (r) => r.term === next.term && r.op === next.op && r.field === next.field,
      )
    ) {
      return;
    }
    // A field-scoped refinement coerces the surface to Records, the
    // same rule the loader enforces on arrival.
    const scoped = next.field !== null || recordsOnly;
    const nextCat = scoped ? "descriptions" : category;
    const href = searchUrl({
      refs: [...refinements, next],
      cat: nextCat,
      facets: nextCat === category ? facets : EMPTY_FACETS,
    });
    // The draft is only cleared once the navigation is going to happen:
    // a warning the cataloguer cancels must leave the term they typed
    // exactly where they left it.
    if (guard(t("addTextFilter"), href)) return;
    setDraftTerm("");
    navigate(href);
  };

  const sameRefinement = (a: SearchRefinement, b: SearchRefinement) =>
    a.term === b.term && a.op === b.op && a.field === b.field;

  /** A refinement pill's own text, which is what its remove names. */
  const refinementLabel = (r: SearchRefinement) =>
    (r.op === "NOT" ? t("notPrefix") : "") +
    (r.field ? `${t(FIELD_LABEL_KEYS[r.field])}: ` : "") +
    r.term;

  const removeRefinement = (target: SearchRefinement) => {
    go(
      `${t("removeFilter")}: ${refinementLabel(target)}`,
      searchUrl({ refs: refinements.filter((r) => !sameRefinement(r, target)) }),
    );
  };

  /**
   * Taking the main term back promotes the first plain include
   * refinement into the box slot, so a query that still has a subject
   * keeps it. With nothing to promote, only the remaining refinements
   * travel.
   */
  const removeMainTerm = () => {
    const promoted = refinements.find((r) => r.op === "AND" && r.field === null);
    const rest = promoted
      ? refinements.filter((r) => !sameRefinement(r, promoted))
      : refinements;
    // The box slot is re-tokenised on arrival (whitespace splits,
    // a leading hyphen excludes), while a refinement term is one unit.
    // A term those rules would reinterpret is promoted as a quoted
    // phrase instead, which the box slot passes through verbatim — the
    // pill keeps meaning exactly what it meant.
    const box = promoted
      ? /\s|^-/.test(promoted.term)
        ? `"${promoted.term}"`
        : promoted.term
      : "";
    go(
      `${t("removeFilter")}: “${boxQuery}”`,
      searchUrl({ box, refs: rest }),
    );
  };

  const toggleFacet = (
    key: FacetKey,
    cat: SearchCategory,
    value: string,
    checked: boolean,
  ) => {
    // Crossing from the grouped view into a category takes only the
    // facet just ticked; within a category the rest of the selection
    // rides along.
    const base = cat === category ? facets : EMPTY_FACETS;
    const chosen = base[key];
    go(
      `${t(FACET_LABEL_KEYS[key])}: ${facetPillLabel(key, value)}`,
      searchUrl({
        cat,
        facets: {
          ...base,
          [key]: checked
            ? chosen.filter((v) => v !== value)
            : [...chosen, value],
        },
      }),
    );
  };

  // -- Facet groups ---------------------------------------------------

  const levelLabel = (value: string) => {
    const key = LEVEL_LABEL_KEYS[value];
    return key ? td(key) : value;
  };
  const entityTypeLabel = (value: string) => {
    const key = ENTITY_TYPE_LABEL_KEYS[value];
    return key ? te(key) : value;
  };
  const placeTypeLabel = (value: string) => {
    const key = PLACE_TYPE_LABEL_KEYS[value];
    return key ? tp(key) : value;
  };
  const repositoryLabel = (id: string) =>
    facetCounts.repositories?.find((r) => r.id === id)?.name ??
    repositoryOptions.find((r) => r.id === id)?.name ??
    id;

  /** Group models for the sidebar, records first, absent groups skipped. */
  const facetGroups: FacetGroupModel[] = [];
  const showsCategory = (c: SearchCategory) =>
    category === "all" ? visibleCategories.includes(c) : category === c;
  const pushGroup = (
    key: FacetKey,
    cat: SearchCategory,
    options: FacetOption[] | undefined,
  ) => {
    if (!options || options.length === 0) return;
    facetGroups.push({
      key,
      category: cat,
      label: t(FACET_LABEL_KEYS[key]),
      options,
      selected: facets[key],
    });
  };
  if (showsCategory("descriptions")) {
    pushGroup(
      "levels",
      "descriptions",
      facetCounts.levels?.map((v) => ({
        value: v.value,
        label: levelLabel(v.value),
        count: v.count,
      })),
    );
    pushGroup(
      "repoIds",
      "descriptions",
      facetCounts.repositories?.map((r) => ({
        value: r.id,
        label: r.name,
        count: r.count,
      })),
    );
  }
  if (showsCategory("entities")) {
    pushGroup(
      "entityTypes",
      "entities",
      facetCounts.entityTypes?.map((v) => ({
        value: v.value,
        label: entityTypeLabel(v.value),
        count: v.count,
      })),
    );
    pushGroup(
      "fns",
      "entities",
      facetCounts.fns?.map((v) => ({
        value: v.value,
        label: v.value,
        count: v.count,
      })),
    );
  }
  if (showsCategory("places")) {
    pushGroup(
      "placeTypes",
      "places",
      facetCounts.placeTypes?.map((v) => ({
        value: v.value,
        label: placeTypeLabel(v.value),
        count: v.count,
      })),
    );
  }

  // -- Pills ----------------------------------------------------------

  const facetPillLabel = (key: FacetKey, value: string) => {
    if (key === "levels") return levelLabel(value);
    if (key === "repoIds") return repositoryLabel(value);
    if (key === "entityTypes") return entityTypeLabel(value);
    if (key === "placeTypes") return placeTypeLabel(value);
    return value;
  };
  const activeFacetPills =
    category === "all"
      ? []
      : CATEGORY_FACET_KEYS[category].flatMap((key) =>
          facets[key].map((value) => ({ key, value })),
        );
  // The range as a person reads it: an en dash between the bounds, the
  // open end simply absent.
  const dateRangeLabel = `${dateFrom ?? ""}–${dateTo ?? ""}`;
  const removeDateRange = () =>
    go(
      `${t("removeFilter")}: ${t("dateHeading")}: ${dateRangeLabel}`,
      searchUrl({ dates: { from: null, to: null } }),
    );
  // The advanced form is the query, so it renders no pills — a pill row
  // beside the controls it duplicates would be two truths to maintain.
  const showQueryPills =
    !advanced &&
    (Boolean(boxQuery) ||
      refinements.length > 0 ||
      activeFacetPills.length > 0 ||
      dateFrom !== null ||
      dateTo !== null);
  // The handlist pill is the exception: it is not part of either
  // grammar, so it shows in both views — the ground is worth stating
  // wherever the question is being composed.
  const hasPills = showQueryPills || handlist !== null;

  /**
   * The URL that keeps the ground and lets everything else go. Clearing
   * the filters inside a set returns to the whole set, not to the
   * workspace: widening the world is the green pill's own job, and
   * nothing else on the row may do it by accident.
   */
  const groundQuery = handlist
    ? `handlist=${encodeURIComponent(handlist.id)}`
    : "";
  const facetedHref = groundQuery ? `/search?${groundQuery}` : "/search";
  const advancedHref = groundQuery
    ? `/search?view=advanced&${groundQuery}`
    : "/search?view=advanced";
  /** The same question, asked of the workspace instead of the set. */
  const widenHref = searchUrl({ handlist: null });
  const handlistPillLabel = handlist
    ? t("handlistPill", { name: handlist.name })
    : "";

  // -- Choosing a set to stand in -------------------------------------
  // The other entrance to the same state, offered from the pills row
  // like any other constraint — dashed and quiet, because it is an
  // OFFER rather than an applied narrowing, and absent altogether once
  // a set is applied: the green pill already occupies that ground.
  const [chooserOpen, setChooserOpen] = useState(false);
  const chooserAvailable = handlist === null && handlistOptions.length > 0;
  /** What the tab on screen holds; null on the grouped view. */
  const tabType: RecordType | null =
    category === "all" ? null : RECORD_TYPE_OF[category];
  /**
   * The type rule, stated as a header rather than as an empty menu.
   * The grouped view asks for no particular kind, so nothing there can
   * be the wrong kind — choosing lands on the chosen set's own tab.
   */
  const noneEligible =
    tabType !== null &&
    !handlistOptions.some((row) => row.recordType === tabType);

  /**
   * Standing inside a set narrows the results, so it is a change to
   * the question and costs a live selection exactly what every other
   * narrowing costs. The navigation therefore goes through `go` rather
   * than straight to the URL.
   */
  const chooseHandlist = (row: HandlistChoice) => {
    setChooserOpen(false);
    go(
      `${t("chooserHeader")}: ${row.name}`,
      searchUrl({
        handlist: row.id,
        cat: CATEGORY_OF_RECORD_TYPE[row.recordType],
      }),
    );
  };

  // -- Sort -----------------------------------------------------------

  const sortKeys: readonly (RecordSortKey | NameSortKey)[] =
    category === "descriptions" ? RECORD_SORT_KEYS : NAME_SORT_KEYS;
  // With no explicit sort the list is on its mode default: relevance
  // under a query, otherwise code (records) or name (authorities).
  const activeSortKey: RecordSortKey | NameSortKey =
    sort?.key ??
    (mode === "match"
      ? "relevance"
      : category === "descriptions"
        ? "code"
        : "name");
  const activeSortDir: SortDir = sort?.dir ?? "asc";
  const sortLink = (key: RecordSortKey | NameSortKey) =>
    key === "relevance"
      ? // Relevance is the match default, so asking for it is asking
        // for no sort parameter at all.
        searchUrl({ sort: null })
      : searchUrl({
          sort: {
            key,
            dir:
              key === activeSortKey && activeSortDir === "asc" ? "desc" : "asc",
          },
        });

  // -- The carry ------------------------------------------------------
  // What the pills SAY, in the reader's own language, travels with the
  // selection so the export page can quote the question back. It is
  // display copy: the query itself travels separately, as the URL that
  // produced it, and is re-read server-side.
  const constraintLabels: string[] = [];
  if (advanced) {
    for (const r of advRows) {
      constraintLabels.push(
        `${r.field ? `${t(FIELD_LABEL_KEYS[r.field])}: ` : ""}${r.term}`,
      );
    }
  } else {
    if (boxQuery) constraintLabels.push(`“${boxQuery}”`);
    for (const r of refinements) constraintLabels.push(refinementLabel(r));
  }
  for (const { key, value } of activeFacetPills) {
    constraintLabels.push(
      `${t(FACET_LABEL_KEYS[key])}: ${facetPillLabel(key, value)}`,
    );
  }
  if (dateFrom !== null || dateTo !== null) {
    constraintLabels.push(`${t("dateHeading")}: ${dateRangeLabel}`);
  }

  /** The question as one readable phrase, the ground left out of it. */
  const askedConstraints = constraintLabels.join(" · ");
  // The ground belongs in the carried summary, though: a scope chosen
  // inside a set was chosen under that set, and the export page has to
  // be able to say so.
  if (handlist) constraintLabels.push(handlistPillLabel);

  // -- Saving a selection as a handlist -------------------------------
  // In `ids` mode the members are already in hand. In `all` mode they
  // are a promise about a query, and a handlist takes a list — so the
  // click asks the server for the ids first, on the same ground the
  // results page stood on, and the dialog opens while it waits.
  const idsFetcher = useFetcher<
    { ok: true; ids: string[] } | { ok: false; error: string }
  >();
  // Which kind the fetcher's answer belongs to. The grouped view can
  // show two sections that each hold a whole matching set, and one
  // kind's resolved ids are emphatically not the other's — so an answer
  // is only ever offered back to the kind that asked for it.
  const [materialisingFor, setMaterialisingFor] = useState<RecordType | null>(
    null,
  );
  // An answer counts only while nothing is in flight: mid-request the
  // last answer is the previous question's, and the dialog says it is
  // still working rather than offering a set it no longer means.
  const idsSettled = idsFetcher.state === "idle" ? idsFetcher.data : undefined;
  const materialised = idsSettled?.ok ? idsSettled.ids : null;
  const materialiseFailed =
    idsSettled && !idsSettled.ok ? idsSettled.error : null;

  /** The members a save would write down for one kind. */
  const saveIdsFor = (type: RecordType) => {
    const selected = heldState.byType[type];
    if (selected?.mode === "ids") return [...selected.ids];
    return materialisingFor === type ? materialised : null;
  };

  const resolveErrorFor = (type: RecordType) => {
    if (materialisingFor !== type || !materialiseFailed) return null;
    return materialiseFailed === "ceiling"
      ? t("pickerErrorCeiling", { ns: "handlists" })
      : t("error.generic_detail", { ns: "common" });
  };

  /** The dialog's own trigger fires this; the ticked case needs nothing. */
  const startSaveFor = (type: RecordType) => {
    const selected = heldState.byType[type];
    if (!selected || selected.mode === "ids") return;
    setMaterialisingFor(type);
    const data = new FormData();
    data.set("_action", "handlistIds");
    data.set("recordType", type);
    // The URL is the query, exactly as the carry sends it.
    data.set("query", location.search);
    void idsFetcher.submit(data, { method: "post" });
  };

  /**
   * Write one kind's selection down and leave. `resume` is the pending
   * query change the warning interrupted: with one, the action sends the
   * cataloguer back to the search they were changing, the scope safely
   * stashed; without one, the plain Send goes to the export page.
   *
   * A scope carries one record class, so this always speaks for exactly
   * one kind — the tab's, or the grouped section whose Send was pressed.
   */
  const carryFor = (type: RecordType, resume: string | null) => {
    const selected = heldState.byType[type];
    if (!selected) return;
    const data = new FormData();
    data.set("_action", "carry");
    data.set("recordType", type);
    data.set("mode", selected.mode);
    if (selected.mode === "ids") {
      for (const id of selected.ids) data.append("ids", id);
    }
    // The URL is the query: "all matching" is re-run server-side from
    // exactly what this page was showing.
    data.set("query", location.search);
    data.set(
      "constraints",
      JSON.stringify(constraintLabels.map((label) => ({ label }))),
    );
    if (resume) data.set("resume", resume);
    void submit(data, { method: "post" });
  };

  // -- Rows -----------------------------------------------------------

  /** The row itself, whichever index it came from. */
  const rowElement = (
    cat: SearchCategory,
    hit: DescriptionHit | EntityHit | PlaceHit,
    selected: boolean,
  ) => {
    if (cat === "descriptions") {
      return (
        <DescriptionRow
          key={hit.id}
          hit={hit as DescriptionHit}
          markers={markers}
          selected={selected}
        />
      );
    }
    if (cat === "entities") {
      return (
        <EntityRow key={hit.id} hit={hit as EntityHit} selected={selected} />
      );
    }
    return <PlaceRow key={hit.id} hit={hit as PlaceHit} selected={selected} />;
  };

  /** What a tick is a tick OF, for the checkbox to announce. */
  const rowTitle = (
    cat: SearchCategory,
    hit: DescriptionHit | EntityHit | PlaceHit,
  ) =>
    cat === "descriptions"
      ? markedRuns((hit as DescriptionHit).titleMarked, markers.open, markers.close)
          .map((run) => run.text)
          .join("")
      : (hit as EntityHit | PlaceHit).displayName;

  /**
   * The same rows, with the tick column — which every list carries, a
   * grouped section exactly as a tab's page does. The column is always
   * there (a cataloguer scanning a hundred results should not have to
   * discover it) and the checkbox sits beside the link rather than
   * inside it, so opening a record and choosing one stay two different
   * gestures. `visibleIds` is the list this one belongs to, which is
   * what a whole matching set demotes to when a row inside it is let go.
   */
  const selectableRows = (
    cat: SearchCategory,
    rows: DescriptionHit[] | EntityHit[] | PlaceHit[],
    visibleIds: string[],
  ) => {
    const type = RECORD_TYPE_OF[cat];
    const selected = heldState.byType[type];
    return rows.map((hit) => {
      const picked = selected
        ? selected.mode === "all" || selected.ids.has(hit.id)
        : false;
      return (
        <div
          key={hit.id}
          className={`grid grid-cols-[44px_1fr] items-stretch ${
            picked ? "bg-verdigris-wash" : ""
          }`}
        >
          <div className="flex items-start justify-center border-b border-stone-100 pt-3.5">
            <input
              type="checkbox"
              checked={picked}
              onChange={() => toggleRowOf(type, visibleIds, hit.id, !picked)}
              aria-label={rowTitle(cat, hit)}
              className="h-3.5 w-3.5 shrink-0 accent-indigo"
            />
          </div>
          <div className="min-w-0">{rowElement(cat, hit, picked)}</div>
        </div>
      );
    });
  };

  /** The words to quote back when nothing matched. */
  const askedFor = advanced
    ? advRows.map((r) => r.term).join(" ")
    : boxQuery || refinements.map((r) => r.term).join(" ");

  return (
    <div className="mx-auto max-w-[1200px] px-6 py-7">
      <h1 className="font-serif text-[2rem] font-semibold leading-[1.2] tracking-[-0.005em] text-indigo">
        {t("title")}
      </h1>

      {/* The two ways of asking, quietly offered. Each link starts its
          mode fresh: the grammars do not translate into one another, so
          carrying a query across would mean inventing what it meant —
          which is exactly why a live selection cannot cross either. */}
      <nav className="mt-4 flex flex-wrap gap-2">
        <Link
          to={facetedHref}
          aria-current={advanced ? undefined : "page"}
          onClick={(event) => {
            if (advanced && guard(t("facetedToggle"), facetedHref)) {
              event.preventDefault();
            }
          }}
          className={`rounded-full px-3 py-1 text-13 font-semibold transition-colors ${
            advanced
              ? `border bg-white text-stone-700 hover:bg-stone-50 ${
                  selectionLive ? ARMED_PILL : "border-stone-300"
                }`
              : "bg-indigo text-parchment"
          }`}
        >
          {t("facetedToggle")}
        </Link>
        <Link
          to={advancedHref}
          aria-current={advanced ? "page" : undefined}
          onClick={(event) => {
            if (!advanced && guard(t("advancedToggle"), advancedHref)) {
              event.preventDefault();
            }
          }}
          className={`rounded-full px-3 py-1 text-13 font-semibold transition-colors ${
            advanced
              ? "bg-indigo text-parchment"
              : `border bg-white text-stone-700 hover:bg-stone-50 ${
                  selectionLive ? ARMED_PILL : "border-stone-300"
                }`
          }`}
        >
          {t("advancedToggle")}
        </Link>
      </nav>

      {/* One line naming what the active view is, not how to use it —
          the how lives on the landing card and in the form itself. */}
      <p className="mt-2 max-w-[62ch] text-13 text-stone-500">
        {advanced ? t("advancedBlurb") : t("facetedBlurb")}
      </p>

      <div
        className={
          advanced
            ? "mt-5"
            : "mt-5 gap-8 lg:grid lg:grid-cols-[16rem_1fr] lg:items-start"
        }
      >
        {/* Filter panel. It belongs to the default view alone — in the
            advanced view the form IS the filter. Below the large
            breakpoint it folds behind a disclosure so the results keep
            the full width. */}
        {!advanced && (
          <div>
            <button
              type="button"
              onClick={() => setFiltersOpen((open) => !open)}
              aria-expanded={filtersOpen}
              className="mb-3 inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-13 font-semibold text-stone-700 hover:bg-stone-50 lg:hidden"
            >
              {t("filtersToggle")}
              {filtersOpen ? (
                <ChevronUp className="h-4 w-4" strokeWidth={1.75} />
              ) : (
                <ChevronDown className="h-4 w-4" strokeWidth={1.75} />
              )}
            </button>

            <aside
              aria-label={t("filterBy")}
              // On the landing state the panel is the only query entry
              // (the help copy points straight at it), so it stays on
              // screen at every width rather than hiding behind the
              // disclosure.
              className={`${filtersOpen || landing ? "block" : "hidden"} lg:block`}
            >
              <h2 className="font-serif text-15 font-semibold text-indigo">
                {t("filterBy")}
              </h2>

              {/* The refine widget: a term, the field it applies to, the
                  include/exclude choice, and the add control. */}
              <div
                role="group"
                aria-label={t("refineLabel")}
                className="mt-3 flex flex-col gap-2 border-b border-stone-200 pb-4"
              >
                <input
                  type="text"
                  value={draftTerm}
                  onChange={(event) => setDraftTerm(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addRefinement();
                    }
                  }}
                  placeholder={t("refinePlaceholder")}
                  aria-label={t("refinePlaceholder")}
                  className="h-[30px] w-full rounded-lg border border-stone-300 bg-white px-2.5 font-sans text-13 focus:border-indigo focus:outline-none"
                />
                <div className="flex items-center gap-2">
                  <select
                    value={draftField}
                    onChange={(event) =>
                      setDraftField(event.target.value as SearchField | "")
                    }
                    aria-label={t("refineFieldLabel")}
                    className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-2 py-1 font-sans text-13 text-stone-700 focus:border-indigo focus:outline-none"
                  >
                    <option value="">{t("fieldAll")}</option>
                    {SEARCH_FIELDS.map((f) => (
                      <option key={f} value={f}>
                        {t(FIELD_LABEL_KEYS[f])}
                      </option>
                    ))}
                  </select>
                  <select
                    value={draftOp}
                    onChange={(event) =>
                      setDraftOp(event.target.value as "AND" | "NOT")
                    }
                    aria-label={t("refineOpLabel")}
                    className="rounded-lg border border-stone-300 bg-white px-2 py-1 font-sans text-13 text-stone-700 focus:border-indigo focus:outline-none"
                  >
                    <option value="AND">{t("opYes")}</option>
                    <option value="NOT">{t("opNo")}</option>
                  </select>
                  <button
                    type="button"
                    onClick={addRefinement}
                    aria-label={t("addTextFilter")}
                    className={`inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border bg-white hover:bg-stone-50 ${
                      selectionLive
                        ? `${ARMED_PILL} text-madder-deep`
                        : "border-stone-300 text-stone-700"
                    }`}
                  >
                    <Plus className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                </div>
              </div>

              {/* Facet groups. Each value carries its live count, taken
                  under the query and the other groups' selections — the
                  unchecked siblings of a checked value keep telling the
                  truth about what checking them would add. */}
              {facetGroups.map((group) => (
                <div key={group.key} className="border-b border-stone-200 py-4">
                  <h3 className="font-sans text-11 font-semibold uppercase tracking-[0.1em] text-stone-400">
                    {group.label}
                  </h3>
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {group.options.map((option) => {
                      const checked = group.selected.includes(option.value);
                      return (
                        <li key={option.value}>
                          <label className="flex items-baseline gap-2 text-13 text-stone-700">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                toggleFacet(
                                  group.key,
                                  group.category,
                                  option.value,
                                  checked,
                                )
                              }
                              className={`mt-0.5 h-3.5 w-3.5 shrink-0 self-center ${
                                selectionLive ? "accent-madder" : "accent-indigo"
                              }`}
                            />
                            <span
                              className={`min-w-0 flex-1 break-words ${
                                selectionLive ? "text-madder-deep" : ""
                              }`}
                            >
                              {option.label}
                            </span>
                            <span className="font-mono text-11 nums text-stone-400">
                              {formatNumber(option.count)}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </aside>
          </div>
        )}

        {/* Results column */}
        <div className={advanced ? "min-w-0" : "mt-6 min-w-0 lg:mt-0"}>
          {/* The advanced query, always visible above its own results.
              Keyed on the URL so a navigation — a back button included
              — reseeds the controls from the query on screen. */}
          {advanced && (
            <div className="mb-6">
              <AdvancedForm
                key={location.search}
                rows={advRows}
                dateFrom={dateFrom}
                dateTo={dateTo}
                levels={facets.levels}
                repoIds={facets.repoIds}
                entityTypes={facets.entityTypes}
                placeTypes={facets.placeTypes}
                repositoryOptions={repositoryOptions}
                namedCategory={namedCategory}
                includeAuthorities={includeAuthorities}
                armed={selectionLive}
                guard={guard}
              />
            </div>
          )}

          {landing ? (
            // The advanced view's landing is the empty form and nothing
            // else; the default view's is the invitation to ask, with
            // the sidebar beside it as the way in.
            advanced ? null : (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-stone-200 px-6 py-14 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-md bg-indigo-tint">
                  <SearchIcon className="h-5 w-5 text-indigo" strokeWidth={1.5} />
                </span>
                <p className="font-serif text-xl text-indigo">
                  {t("promptHeading")}
                </p>
                <p className="measure-36 text-13 text-stone-500">
                  {t("promptBody")}
                </p>
                <p className="measure-36 text-13 text-stone-500">{t("helpP1")}</p>
                <p className="measure-36 text-13 text-stone-500">{t("helpP2")}</p>
              </div>
            )
          ) : (
            <>
              {/* Category tabs — the counts are facet-free, so they stay
                  live while a facet narrows the list beneath them. Under
                  a field scope or a date bound only the Records tab
                  exists, in either view. */}
              <nav className="flex flex-wrap gap-2">
                {!confined && (
                  <Link
                    to={tabLink("all")}
                    aria-current={category === "all" ? "page" : undefined}
                    className={`rounded-full px-3 py-1 text-13 font-semibold transition-colors ${
                      category === "all"
                        ? "bg-indigo text-parchment"
                        : "border border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
                    }`}
                  >
                    {t("catAll")}
                  </Link>
                )}
                {visibleCategories.map((c) => {
                  const active = category === c;
                  return (
                    <Link
                      key={c}
                      to={tabLink(c)}
                      aria-current={active ? "page" : undefined}
                      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-13 font-semibold transition-colors ${
                        active
                          ? "bg-indigo text-parchment"
                          : "border border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
                      }`}
                    >
                      {t(CATEGORY_LABEL_KEYS[c])}
                      <span
                        className={`font-mono text-11 nums ${
                          active ? "text-indigo-tint" : "text-stone-400"
                        }`}
                      >
                        {formatNumber(counts[c] ?? 0)}
                      </span>
                    </Link>
                  );
                })}
              </nav>

              {/* The count line, and — in a single category, where a
                  list has one order — the sort row. */}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-stone-200 pb-2">
                {/* Inside a set the count says what it is a count OF:
                    seven of the forty-two held, not seven of nothing
                    in particular. */}
                {handlist && category !== "all" ? (
                  <p className="text-13 text-stone-500">
                    <span className="font-semibold nums text-indigo">
                      {t("inHandlistCount", {
                        count: activeTotal,
                        held: handlist.memberCount,
                      })}
                    </span>{" "}
                    {t("inHandlistOfSet")}
                  </p>
                ) : (
                  <p className="text-13 nums text-stone-500">
                    {t("resultsCount", { count: activeTotal })}
                  </p>
                )}
                {category !== "all" && (
                  <div
                    role="group"
                    aria-label={t("sortBy")}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1"
                  >
                    <span className="text-11 uppercase tracking-[0.08em] text-stone-400">
                      {t("sortBy")}
                    </span>
                    {sortKeys.map((key) => {
                      // Relevance only exists where something was
                      // matched; a browse has nothing to be relevant to.
                      if (key === "relevance" && mode !== "match") return null;
                      const active = key === activeSortKey;
                      return (
                        <Link
                          key={key}
                          to={sortLink(key)}
                          aria-current={active ? "true" : undefined}
                          className={`inline-flex items-center gap-1 text-13 ${
                            active
                              ? "font-semibold text-indigo"
                              : "text-stone-600 hover:text-indigo"
                          }`}
                        >
                          {t(SORT_LABEL_KEYS[key])}
                          {active &&
                            key !== "relevance" &&
                            (activeSortDir === "asc" ? (
                              <ArrowUp className="h-3.5 w-3.5" strokeWidth={2} />
                            ) : (
                              <ArrowDown
                                className="h-3.5 w-3.5"
                                strokeWidth={2}
                              />
                            ))}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* The whole query, one pill at a time: the main term in
                  quotes, each refinement, each facet selection — and,
                  at the end, the offer of one more constraint. */}
              {(hasPills || chooserAvailable) && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {/* Each remove button names its own pill, so five
                      pills never announce as five identical buttons. */}
                  {!advanced && boxQuery && (
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-13 ${
                        selectionLive
                          ? `${ARMED_PILL} text-madder-deep`
                          : "border-indigo/30 bg-indigo-tint text-indigo"
                      }`}
                    >
                      {`“${boxQuery}”`}
                      <button
                        type="button"
                        onClick={removeMainTerm}
                        aria-label={`${t("removeFilter")}: “${boxQuery}”`}
                        className={`inline-flex h-4 w-4 items-center justify-center rounded-full ${
                          selectionLive
                            ? "text-madder-deep"
                            : "text-indigo/60 hover:text-indigo"
                        }`}
                      >
                        <X className="h-3.5 w-3.5" strokeWidth={1.75} />
                      </button>
                    </span>
                  )}
                  {(advanced ? [] : refinements).map((r) => {
                    const pillText = refinementLabel(r);
                    return (
                      <span
                        key={`${r.op}:${r.field ?? ""}:${r.term}`}
                        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-13 ${
                          selectionLive
                            ? `${ARMED_PILL} text-madder-deep`
                            : "border-stone-300 bg-white text-stone-700"
                        }`}
                      >
                        {pillText}
                        <button
                          type="button"
                          onClick={() => removeRefinement(r)}
                          aria-label={`${t("removeFilter")}: ${pillText}`}
                          className={`inline-flex h-4 w-4 items-center justify-center rounded-full ${
                            selectionLive
                              ? "text-madder-deep"
                              : "text-stone-400 hover:text-stone-700"
                          }`}
                        >
                          <X className="h-3.5 w-3.5" strokeWidth={1.75} />
                        </button>
                      </span>
                    );
                  })}
                  {(advanced ? [] : activeFacetPills).map(({ key, value }) => (
                    <span
                      key={`${key}:${value}`}
                      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-13 ${
                        selectionLive
                          ? `${ARMED_PILL} text-madder-deep`
                          : "border-stone-300 bg-white text-stone-700"
                      }`}
                    >
                      {facetPillLabel(key, value)}
                      <button
                        type="button"
                        onClick={() =>
                          toggleFacet(
                            key,
                            category as SearchCategory,
                            value,
                            true,
                          )
                        }
                        aria-label={`${t("removeFilter")}: ${facetPillLabel(key, value)}`}
                        className={`inline-flex h-4 w-4 items-center justify-center rounded-full ${
                          selectionLive
                            ? "text-madder-deep"
                            : "text-stone-400 hover:text-stone-700"
                        }`}
                      >
                        <X className="h-3.5 w-3.5" strokeWidth={1.75} />
                      </button>
                    </span>
                  ))}
                  {!advanced && (dateFrom !== null || dateTo !== null) && (
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-13 nums ${
                        selectionLive
                          ? `${ARMED_PILL} text-madder-deep`
                          : "border-stone-300 bg-white text-stone-700"
                      }`}
                    >
                      {`${t("dateHeading")}: ${dateRangeLabel}`}
                      <button
                        type="button"
                        onClick={removeDateRange}
                        aria-label={`${t("removeFilter")}: ${t("dateHeading")}: ${dateRangeLabel}`}
                        className={`inline-flex h-4 w-4 items-center justify-center rounded-full ${
                          selectionLive
                            ? "text-madder-deep"
                            : "text-stone-400 hover:text-stone-700"
                        }`}
                      >
                        <X className="h-3.5 w-3.5" strokeWidth={1.75} />
                      </button>
                    </span>
                  )}
                  {/* The set is not a word anyone searched for, so it
                      wears verdigris rather than indigo: taking this
                      one off widens the world instead of narrowing the
                      question. It is still a narrowing, so it arms with
                      the rest while ticks are held. */}
                  {handlist && (
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-13 font-semibold ${
                        selectionLive
                          ? `${ARMED_PILL} text-madder-deep`
                          : "border-verdigris/45 bg-verdigris-tint text-verdigris-deep"
                      }`}
                    >
                      <List className="h-3.5 w-3.5" strokeWidth={1.75} />
                      {handlistPillLabel}
                      <button
                        type="button"
                        onClick={() =>
                          go(
                            `${t("removeFilter")}: ${handlistPillLabel}`,
                            widenHref,
                          )
                        }
                        aria-label={`${t("removeFilter")}: ${handlistPillLabel}`}
                        className={`inline-flex h-4 w-4 items-center justify-center rounded-full ${
                          selectionLive
                            ? "text-madder-deep"
                            : "text-verdigris-deep/65 hover:text-verdigris-deep"
                        }`}
                      >
                        <X className="h-3.5 w-3.5" strokeWidth={1.75} />
                      </button>
                    </span>
                  )}
                  {showQueryPills && (
                    <Link
                      to={facetedHref}
                      onClick={(event) => {
                        if (guard(t("clearFilters"), facetedHref)) {
                          event.preventDefault();
                        }
                      }}
                      className={`text-13 font-semibold hover:underline ${
                        selectionLive ? "text-madder-deep" : "text-indigo"
                      }`}
                    >
                      {t("clearFilters")}
                    </Link>
                  )}
                  {/* Adding a constraint must not wear the same clothes
                      as clearing them all, and an offer must not wear
                      the same clothes as a pill that is already on: the
                      dashed outline says this one is not applied yet. */}
                  {chooserAvailable && (
                    <button
                      type="button"
                      onClick={() => setChooserOpen((open) => !open)}
                      aria-expanded={chooserOpen}
                      className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-stone-400 px-2.5 py-0.5 text-13 font-medium text-stone-600 hover:bg-stone-50"
                    >
                      <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
                      {t("chooserTrigger")}
                    </button>
                  )}
                </div>
              )}

              {/* The menu itself. Every handlist this person can reach
                  is listed, the ones that cannot narrow this tab
                  included: they are dimmed and say what they hold
                  instead of vanishing, because a menu that empties
                  itself teaches nothing about why. */}
              {chooserAvailable && chooserOpen && (
                <div className="mt-3 max-w-[27rem] overflow-hidden rounded-lg border border-stone-200 shadow-md">
                  <div className="border-b border-stone-200 bg-stone-50 px-3 py-2">
                    <p className="text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-stone-400">
                      {noneEligible && tabType
                        ? `${t("chooserHeader")} · ${t(CHOOSER_NONE_KEYS[tabType])}`
                        : t("chooserHeader")}
                    </p>
                  </div>
                  <ul>
                    {handlistOptions.map((row) => {
                      const eligible =
                        tabType === null || row.recordType === tabType;
                      const holds = t(HELD_KEYS[row.recordType], {
                        count: row.memberCount,
                        ns: "handlists",
                      });
                      if (!eligible) {
                        const why = tabType
                          ? CHOOSER_WHY_KEYS[`${row.recordType}:${tabType}`]
                          : undefined;
                        return (
                          <li
                            key={row.id}
                            aria-disabled="true"
                            className="flex items-center gap-2.5 border-b border-stone-100 bg-stone-50 px-3 py-2.5 last:border-b-0"
                          >
                            <List
                              className="h-3.5 w-3.5 shrink-0 text-stone-300"
                              strokeWidth={1.75}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block break-words text-13 font-semibold text-stone-400">
                                {row.name}
                              </span>
                              <span className="mt-0.5 block font-mono text-11 nums text-stone-400">
                                {holds}
                              </span>
                            </span>
                            {why && (
                              <span className="max-w-[10.5rem] shrink-0 text-right text-11 leading-normal text-stone-500">
                                {t(why)}
                              </span>
                            )}
                          </li>
                        );
                      }
                      return (
                        <li
                          key={row.id}
                          className="border-b border-stone-100 last:border-b-0"
                        >
                          <button
                            type="button"
                            onClick={() => chooseHandlist(row)}
                            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-stone-50"
                          >
                            <List
                              className="h-3.5 w-3.5 shrink-0 text-stone-400"
                              strokeWidth={1.75}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block break-words text-13 font-semibold text-stone-700">
                                {row.name}
                              </span>
                              <span className="mt-0.5 block font-mono text-11 nums text-stone-500">
                                {`${holds} · ${
                                  row.mine
                                    ? t("chooserYours")
                                    : t("chooserSharedBy", {
                                        name: row.ownerName,
                                      })
                                }`}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {/* An answer inside a set reports the world outside it:
                  a dead end becomes a next move, and the same question
                  is one click from being asked of the workspace. With
                  no rows at all the empty state below says it instead,
                  at length and with the way out as a button. */}
              {handlist &&
                category !== "all" &&
                outsideTotal !== null &&
                (pageResult?.rows.length ?? 0) > 0 && (
                <div className="mt-3 flex flex-wrap items-baseline justify-end border-t border-stone-100 pt-2.5">
                  <Link
                    to={widenHref}
                    onClick={(event) => {
                      if (guard(t("inHandlistWiden"), widenHref)) {
                        event.preventDefault();
                      }
                    }}
                    className={`text-13 font-semibold hover:underline ${
                      selectionLive ? "text-madder-deep" : "text-indigo"
                    }`}
                  >
                    {t(WORKSPACE_COUNT_KEYS[RECORD_TYPE_OF[category]], {
                      count: outsideTotal,
                    })}{" "}
                    →
                  </Link>
                </div>
              )}

              {/* The selection bar: what is held, the wider promise or
                  the narrower one back, and the two things that can be
                  done with it. It exists only while something is held.
                  This is the TAB's bar, speaking for the one kind on
                  screen; the grouped view's sections carry their own,
                  one per kind, further down. */}
              {recordType && selectionCount > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-x-3.5 gap-y-2.5 rounded-lg border border-indigo-tint bg-indigo-wash px-3 py-2.5">
                  <span className="text-13 font-semibold nums text-indigo">
                    {allMode
                      ? t(SEL_ALL_HELD_KEYS[recordType], { count: activeTotal })
                      : t(SEL_BAR_KEYS[recordType], { count: selectionCount })}
                  </span>
                  {allMode ? (
                    <>
                      <span className="text-11 nums text-stone-500">
                        {t("selAcrossPages", { count: pageCount })}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setHeld({ mode: "ids", ids: new Set(pageIds) })
                        }
                        className="text-13 font-semibold text-indigo underline underline-offset-2"
                      >
                        {t("selOnlyPage", { count: pageIds.length })}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setHeld({ mode: "all" })}
                      className="text-13 font-semibold text-indigo underline underline-offset-2"
                    >
                      {t(SEL_ALL_KEYS[recordType], { count: activeTotal })}
                    </button>
                  )}
                  <span className="flex-1" />
                  <button
                    type="button"
                    onClick={() => setHeld(undefined)}
                    className="text-13 font-semibold text-stone-600 hover:text-stone-700"
                  >
                    {t("selClear")}
                  </button>
                  {/* Both fates of a selection, side by side: keep it,
                      or send it. Neither is primary over the other —
                      Send stays filled because it is the errand most
                      selections are on. */}
                  <HandlistPicker
                    recordType={recordType}
                    memberIds={saveIdsFor(recordType)}
                    triggerLabel={t("selSave")}
                    intent="save"
                    resolveError={resolveErrorFor(recordType)}
                    triggerClassName="inline-flex h-8 items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3.5 text-13 font-semibold text-stone-700 hover:bg-stone-50"
                    onOpen={() => startSaveFor(recordType)}
                  />
                  <button
                    type="button"
                    onClick={() => carryFor(recordType, null)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-indigo px-3.5 text-13 font-semibold text-white hover:bg-indigo-deep"
                  >
                    <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
                    {t("selSend")}
                  </button>
                </div>
              )}

              {category === "all" ? (
                totalHits === 0 ? (
                  <div className="mt-6 flex flex-col items-center gap-3 rounded-xl border border-stone-200 px-6 py-14 text-center">
                    <p className="font-serif text-xl text-indigo">
                      {t("emptyHeading")}
                    </p>
                    <p className="measure-36 text-13 text-stone-500">
                      {/* A refinements-only search has an empty box;
                          quote the pill terms rather than an empty
                          string, and say nothing about words at all
                          when the narrowing was not words. */}
                      {askedFor
                        ? t("emptyBody", { query: askedFor })
                        : t("emptyCategoryBody")}
                    </p>
                  </div>
                ) : (
                  /* Grouped view: one section per non-empty category,
                     each ranked inside its own index and never merged
                     with the others — and each with its own ticks and
                     its own bar, because a handlist holds one kind and
                     a scope carries one record class, so a bar that
                     spoke for two would be promising something neither
                     destination can take. */
                  <div className="mt-4 flex flex-col gap-8">
                    {visibleCategories.map((c) => {
                      const rows = preview ? preview[c] : [];
                      if (!rows || rows.length === 0) return null;
                      const type = RECORD_TYPE_OF[c];
                      const sectionTotal = counts[c] ?? 0;
                      const sectionIds = rows.map((row) => row.id);
                      const selected = heldState.byType[type];
                      const sectionCount = countHeld(type, sectionTotal);
                      return (
                        <section key={c}>
                          <div className="flex items-baseline justify-between border-b border-stone-200 pb-1.5">
                            <h2 className="font-sans text-11 font-semibold uppercase tracking-[0.1em] text-stone-400">
                              {t(CATEGORY_LABEL_KEYS[c])}
                            </h2>
                            <span className="font-mono text-11 nums text-stone-400">
                              {formatNumber(sectionTotal)}
                            </span>
                          </div>
                          {/* This section's own action row, ABOVE its
                              rows — where the single-category tabs put
                              theirs, so the two views read alike and a
                              live selection is stated before the thing
                              it is a selection of. It speaks only about
                              this section's kind. The whole-matching
                              promise is not offered here — a preview
                              has no pages for "across N pages" or "only
                              this page" to mean anything by — but one
                              taken on the tab and carried in still says
                              what it is. */}
                          {sectionCount > 0 && (
                            <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-2.5 rounded-lg border border-indigo-tint bg-indigo-wash px-3 py-2.5">
                              <span className="text-13 font-semibold nums text-indigo">
                                {selected?.mode === "all"
                                  ? t(SEL_ALL_HELD_KEYS[type], {
                                      count: sectionTotal,
                                    })
                                  : t(SEL_BAR_KEYS[type], {
                                      count: sectionCount,
                                    })}
                              </span>
                              <span className="flex-1" />
                              <button
                                type="button"
                                onClick={() => setHeldFor(type, undefined)}
                                className="text-13 font-semibold text-stone-600 hover:text-stone-700"
                              >
                                {t("selClear")}
                              </button>
                              <HandlistPicker
                                recordType={type}
                                memberIds={saveIdsFor(type)}
                                triggerLabel={t("selSave")}
                                intent="save"
                                resolveError={resolveErrorFor(type)}
                                triggerClassName="inline-flex h-8 items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3.5 text-13 font-semibold text-stone-700 hover:bg-stone-50"
                                onOpen={() => startSaveFor(type)}
                              />
                              <button
                                type="button"
                                onClick={() => carryFor(type, null)}
                                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-indigo px-3.5 text-13 font-semibold text-white hover:bg-indigo-deep"
                              >
                                <Download
                                  className="h-3.5 w-3.5"
                                  strokeWidth={1.75}
                                />
                                {t("selSend")}
                              </button>
                            </div>
                          )}
                          <div>{selectableRows(c, rows, sectionIds)}</div>
                          <Link
                            to={tabLink(c)}
                            className="mt-2 inline-flex items-center gap-1 px-3 text-13 font-semibold text-indigo hover:underline"
                          >
                            {t("seeAll")}
                            <ChevronRight
                              className="h-4 w-4"
                              strokeWidth={1.75}
                            />
                          </Link>
                        </section>
                      );
                    })}
                  </div>
                )
              ) : (
                <>
                  {pageResult && pageResult.rows.length === 0 ? (
                    handlist &&
                    outsideTotal !== null &&
                    askedConstraints.length > 0 ? (
                      /* Nothing here, something there. A dead end inside
                         a set is only a dead end if the surface refuses
                         to say what the same question reaches outside
                         it — so it says both, and offers the way out. */
                      <div className="mt-6 flex flex-col items-center gap-3 rounded-xl border border-dashed border-stone-300 px-6 py-12 text-center">
                        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-stone-100 text-stone-400">
                          <SearchX className="h-5 w-5" strokeWidth={1.5} />
                        </span>
                        <p className="font-serif text-xl text-indigo">
                          {t("emptyInHandlistTitle", { name: handlist.name })}
                        </p>
                        <p className="measure-36 text-13 text-stone-600">
                          {`${askedConstraints} ${t(
                            EMPTY_IN_SET_KEYS[RECORD_TYPE_OF[category]],
                            { count: handlist.memberCount },
                          )} — ${t(
                            WORKSPACE_COUNT_KEYS[RECORD_TYPE_OF[category]],
                            { count: outsideTotal },
                          )}.`}
                        </p>
                        <div className="mt-1 flex flex-wrap justify-center gap-2">
                          <Link
                            to={widenHref}
                            className="inline-flex h-9 items-center rounded-md bg-indigo px-3.5 text-13 font-semibold text-parchment hover:bg-indigo-deep"
                          >
                            {t("inHandlistWiden")}
                          </Link>
                          {(dateFrom !== null || dateTo !== null) && (
                            <button
                              type="button"
                              onClick={removeDateRange}
                              className="inline-flex h-9 items-center rounded-md border border-stone-300 bg-white px-3.5 text-13 font-semibold text-stone-700 hover:bg-stone-50"
                            >
                              {t("emptyInHandlistClearDates")}
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="mt-6 flex flex-col items-center gap-3 rounded-xl border border-stone-200 px-6 py-14 text-center">
                        <p className="font-serif text-xl text-indigo">
                          {t("emptyHeading")}
                        </p>
                        <p className="measure-36 text-13 text-stone-500">
                          {t("emptyCategoryBody")}
                        </p>
                      </div>
                    )
                  ) : (
                    <div className="mt-3">
                      {/* Select-all-on-page: a different promise from
                          select-all-matching, and only meaningful while
                          the selection is a list of ids. */}
                      {pageResult && !allMode && pageIds.length > 0 && (
                        <div className="grid grid-cols-[44px_1fr] items-center border-b border-stone-200">
                          <div className="flex items-center justify-center py-2">
                            <input
                              type="checkbox"
                              checked={pageAllTicked}
                              onChange={togglePage}
                              aria-label={t("selOnlyPage", {
                                count: pageIds.length,
                              })}
                              className="h-3.5 w-3.5 shrink-0 accent-indigo"
                            />
                          </div>
                        </div>
                      )}
                      {pageResult &&
                        selectableRows(
                          pageResult.category,
                          pageResult.rows,
                          pageIds,
                        )}
                    </div>
                  )}

                  {pageResult && (
                    <Pager
                      page={page}
                      pageSize={pageSize}
                      total={pageResult.total}
                      makeHref={pageLink}
                      // The hint is only true while something is held —
                      // and only worth saying then.
                      hint={selectionLive ? t("selKeptHint") : undefined}
                    />
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* The cost of a new question, stated before it is asked — one
          sentence per kind this view would spend, which on a tab is
          always one and in the grouped view is however many are held. */}
      {pending && selectionLive && (
        <QueryChangeDialog
          act={pending.act}
          holds={spokenFor}
          onCancel={() => setPending(null)}
          // The carry redirects back to the pending change, so the
          // question moves on with the selection already written down.
          // It is offered only for a single kind: a scope names one
          // record class, so two kinds cannot be sent ahead as one.
          onSendFirst={
            soleHold
              ? () => carryFor(soleHold.recordType, pending.href)
              : undefined
          }
          onProceed={() => {
            const href = pending.href;
            setPending(null);
            clearSpokenFor();
            navigate(href);
          }}
        />
      )}
    </div>
  );
}
