/**
 * English translations — search namespace
 *
 * Strings for the global search surface: one query over records,
 * entities, and places, grouped by category with per-category facets.
 * Category labels reuse the sidebar's module vocabulary (Records /
 * Entities / Places) rather than inventing a parallel taxonomy; level
 * and type labels are NOT duplicated here — the surface reads them
 * from the namespaces that own them.
 *
 * The refine vocabulary (yes/no operator, "Not:" pill prefix, the
 * add-a-term control, the help copy's include/exclude phrasing) is
 * carried over from Zasqua's search so the two systems read as one
 * family; there are no operator keywords in any language — inclusion
 * and exclusion are choices on a control, plus the language-neutral
 * leading hyphen.
 *
 * The handlist strings here are only the ones the SEARCH surface says:
 * the selection bar's save button, the chooser that offers a set to
 * stand in, the verdigris set pill, and the count lines a search inside
 * a set reports with. Everything the picker dialog and the handlist
 * pages say lives in the `handlists` namespace, which owns the
 * feature's vocabulary — including the "{{count}} records" line the
 * chooser's rows borrow rather than duplicate.
 *
 * @version v0.7.0
 */
export default {
  title: "Search",
  placeholder: "Search the whole workspace",

  // Category tabs; counts render as bare numerals beside these.
  catAll: "All",
  catDescriptions: "Records",
  catEntities: "Entities",
  catPlaces: "Places",

  // Grouped ("All") view: each group heads with its category label and
  // count, and closes with the link into the full single-category list.
  seeAll: "See all",

  // Pre-query state. The two help lines adapt Zasqua's search-landing
  // copy: first what the matching does, then how the refine bar works.
  promptHeading: "Search the whole workspace",
  promptBody:
    "Records, entities, and places in one search. Every result opens on its own page.",
  helpP1:
    "Type a term or select a filter in the filter panel to begin exploring, then add more until you find what you are looking for. The search ignores accents and matches whole words; put a hyphen before a term to exclude it.",
  helpP2:
    "Add terms by typing them into the filter panel — select yes or no to include or exclude, pick a field if you want to narrow one, then press + or Enter. Each term or filter appears as a tag that you can remove and replace with ease, so feel free to experiment.",

  // Filter sidebar (the Zasqua filter panel: the refine widget on top,
  // facet groups with live counts beneath).
  filterBy: "Filter by:",
  filtersToggle: "Filters",
  clearFilters: "Clear filters",

  // Results header
  resultsCount_one: "{{count}} result",
  resultsCount_other: "{{count}} results",
  sortBy: "Sort by:",
  sortDate: "Date",
  sortTitle: "Title",
  sortCode: "Code",
  sortName: "Name",
  sortRelevance: "Relevance",

  // The view toggle. The default view is named for what it does —
  // faceted, pill-driven searching — because "Search" alone says
  // nothing beside "Advanced search".
  facetedToggle: "Faceted search and filter",
  facetedBlurb:
    "This is the Zasqua search system, as in the public catalog: add terms and filters, refine by including or excluding, and every choice becomes a tag you can take back.",

  // Advanced search (the classic boolean form behind the view toggle;
  // the row operators are select options, never typed keywords).
  advancedToggle: "Advanced search",
  advancedBlurb:
    "The classic archival advanced search: combine criteria row by row — fields, dates, levels, categories — with and, or, and not.",
  opAnd: "and",
  opOr: "or",
  opNot: "not",
  advTermPlaceholder: "Text to search…",
  advOpLabel: "Operator",
  rowLabel: "Criterion {{n}}",
  addRow: "Add a criterion",
  removeRow: "Remove criterion",
  dateHeading: "Date",
  dateFrom: "From",
  dateTo: "To",
  searchAction: "Search",

  // Refine widget (the Zasqua refine widget, plus Fisqua's field select).
  refineLabel: "Refine the search",
  refinePlaceholder: "Search...",
  refineFieldLabel: "Search field",
  refineOpLabel: "Include or exclude",
  opYes: "Yes",
  opNo: "No",
  addTextFilter: "Add text filter",
  notPrefix: "Not: ",
  removeFilter: "Remove filter",
  fieldAll: "All fields",
  fieldTitle: "Title",
  fieldScope: "Scope",
  fieldNotes: "Notes",
  fieldRef: "Reference code",
  fieldLegacy: "Legacy IDs",

  // Empty states: emptyBody when the query matches nothing anywhere;
  // emptyCategoryBody when the selected tab (or its filters) comes up
  // empty while other tabs still carry hits.
  emptyHeading: "No results",
  emptyBody: "No results for “{{query}}”. Try fewer or different words.",
  emptyCategoryBody:
    "Nothing in this category matches — try another tab or fewer filters.",

  // Facets (single-category view)
  filterLevel: "Level",
  filterRepository: "Repository",
  filterType: "Type",
  // The advanced form's object-kind criterion; "Type" belongs to the
  // entity-type facet, so the object kind gets its own word.
  filterCategory: "Category",
  filterFunction: "Function",
  filterPlaceType: "Place type",
  anyOption: "Any",

  // Selection (the tick column, the selection bar, and the warning a
  // query change raises while ticks are held). Every count sentence is
  // written out per record type rather than assembled from a noun and
  // a verb: Spanish agrees in gender and number, so a sentence built
  // from fragments would be wrong for half the nouns it meets.
  selBar_records_one: "{{count}} record selected",
  selBar_records_other: "{{count}} records selected",
  selBar_entities_one: "{{count}} entity selected",
  selBar_entities_other: "{{count}} entities selected",
  selBar_places_one: "{{count}} place selected",
  selBar_places_other: "{{count}} places selected",
  // Select-all-on-page and select-all-matching are different promises,
  // so both numbers are always spoken.
  selAll_records: "Select all {{count}} matching",
  selAll_entities: "Select all {{count}} matching",
  selAll_places: "Select all {{count}} matching",
  selAllHeld_records: "All {{count}} matching records selected",
  selAllHeld_entities: "All {{count}} matching entities selected",
  selAllHeld_places: "All {{count}} matching places selected",
  selAcrossPages: "across {{count}} pages",
  selOnlyPage: "Select only this page ({{count}})",
  selClear: "Clear",
  selSend: "Send to export",
  // The selection's other fate, offered beside Send: keep the set
  // rather than spend it. The dialog it opens lives in the handlists
  // namespace; only the bar's own button is named here.
  selSave: "Add to handlist",
  selKeptHint: "ticks are kept as you page",

  // Choosing a handlist to stand in. The trigger is offered from the
  // pills row like any other constraint, and the menu it opens lists
  // every handlist this person can reach — including the ones that
  // cannot narrow the tab on screen, which stay listed and say why. A
  // menu that empties itself teaches nothing, so the refusal is a line
  // of text beside a dimmed row rather than an absence.
  chooserTrigger: "Within a handlist…",
  chooserHeader: "Search within a handlist",
  // The header's second half, when not one handlist holds this tab's
  // kind of thing: the shape of the problem, said once, above rows that
  // each repeat their own half of it.
  chooserNone_records: "none of yours hold records",
  chooserNone_entities: "none of yours hold entities",
  chooserNone_places: "none of yours hold places",
  // Why a listed handlist cannot narrow this tab: what it holds, then
  // what was asked for. One key per directed pair — the first noun is
  // the handlist's kind, the second the tab's — because Spanish needs
  // both nouns whole rather than slotted into a frame.
  chooserWhy_records_entities: "holds records, not entities",
  chooserWhy_records_places: "holds records, not places",
  chooserWhy_entities_records: "holds entities, not records",
  chooserWhy_entities_places: "holds entities, not places",
  chooserWhy_places_records: "holds places, not records",
  chooserWhy_places_entities: "holds places, not entities",
  // Whose handlist it is, after the count on a chooser row.
  chooserYours: "yours",
  chooserSharedBy: "shared by {{name}}",

  // Searching inside a handlist. The pill is the ground the question
  // stands on, not a word anyone searched for, so it reads as a place
  // ("in Mission inventories") rather than as a term. Every count line
  // is written out per record type: the verb and the noun agree in
  // Spanish, and a frame would get half of them wrong.
  handlistPill: "in {{name}}",
  inHandlistCount: "{{count}} of {{held}}",
  inHandlistOfSet: "in this handlist",
  inHandlistWorkspace_records_one: "{{count}} record matches in the whole workspace",
  inHandlistWorkspace_records_other:
    "{{count}} records match in the whole workspace",
  inHandlistWorkspace_entities_one: "{{count}} entity matches in the whole workspace",
  inHandlistWorkspace_entities_other:
    "{{count}} entities match in the whole workspace",
  inHandlistWorkspace_places_one: "{{count}} place matches in the whole workspace",
  inHandlistWorkspace_places_other:
    "{{count}} places match in the whole workspace",
  inHandlistWiden: "Search the whole workspace",

  // Nothing here, something there. The title names the set; the body
  // states what the question found inside it and what the same question
  // reaches outside it, so a dead end becomes a next move.
  emptyInHandlistTitle: "No matches in {{name}}",
  emptyInHandlistSet_records_one: "matches nothing in this handlist's one record",
  emptyInHandlistSet_records_other:
    "matches nothing in this handlist's {{count}} records",
  emptyInHandlistSet_entities_one: "matches nothing in this handlist's one entity",
  emptyInHandlistSet_entities_other:
    "matches nothing in this handlist's {{count}} entities",
  emptyInHandlistSet_places_one: "matches nothing in this handlist's one place",
  emptyInHandlistSet_places_other:
    "matches nothing in this handlist's {{count}} places",
  emptyInHandlistClearDates: "Clear the dates",

  // The warning: shown on the click, not on submit. `act` is the
  // control's own label, so the title names the thing being clicked.
  warnChangeTitle: "{{act}}?",
  warnChangeBody1: "This changes the query, so the results are searched again.",
  // The cost, one clause per kind, with the reason said once beneath
  // them (the grouped view can hold two kinds at a time). The rendered
  // text for a single kind is exactly what warnChangeBody2_* said.
  warnChangeHold_records_one: "Your {{count}} selected record will be cleared.",
  warnChangeHold_records_other:
    "Your {{count}} selected records will be cleared.",
  warnChangeHold_entities_one: "Your {{count}} selected entity will be cleared.",
  warnChangeHold_entities_other:
    "Your {{count}} selected entities will be cleared.",
  warnChangeHold_places_one: "Your {{count}} selected place will be cleared.",
  warnChangeHold_places_other:
    "Your {{count}} selected places will be cleared.",
  warnChangeBelong:
    "Selections belong to the result set they were made in, so they cannot survive a new search.",

  warnChangeBody3:
    "Sending to export first keeps them — the export page holds the scope even after you search again.",
  warnSendFirst: "Send to export first",
  warnRemoveClear: "Remove and clear",

  // Pagination
  previous: "Previous",
  next: "Next",
  pageOf: "Page {{page}}",
  showingRange: "Showing {{from}}–{{to}} of {{count}}",
} as const;
