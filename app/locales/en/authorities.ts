/**
 * English translations — authorities namespace
 *
 * This module deals with the English strings of the shared chrome for the
 * authorities module's full-page workbenches (merge and split), the
 * ledger-derived status band, and the entity/place list bulk-merge
 * toolbar. They are kept in one namespace (rather than duplicated across
 * `entities` and `places`) because every string here is record-type
 * agnostic; the record-type-specific field labels come from the caller's
 * own namespace.
 *
 * @version v0.9.0
 */
export default {
  // Merge workbench — page head
  mergeEyebrowEntities: "Authorities · Entities",
  mergeEyebrowPlaces: "Authorities · Places",
  mergeHeading: "Merge authority record",
  mergeIntro:
    "Combine a duplicate record into a surviving record. Linked descriptions move to the survivor; the merged-away record keeps a redirect.",

  // Merge — record pair
  mergeThisRecord: "This record · will be merged away",
  mergeSurvivor: "Survivor · will be kept",
  mergeSwapDirection: "swap direction",
  mergeSelectSurvivor: "Select a surviving record to compare",

  // Merge — survivor typeahead
  mergeSearchPlaceholder: "Search for the surviving record…",
  mergeSearchLinks: "{{count}} links",

  // Merge — comparison table
  mergeColField: "Field",
  mergeColThis: "This record",
  mergeColSurvivor: "Survivor",

  // Merge — linked descriptions
  mergeLinksHeading: "Linked descriptions",
  mergeLinksShowing:
    "Showing {{shown}} of {{total}} · all move to survivor unless unchecked",
  mergeLinksWarning:
    "{{count}} descriptions will stay on a merged-away record. They keep the old redirect and will not appear under the survivor.",
  mergeDestSurvivor: "Survivor",
  mergeDestStays: "Stays",
  mergeLoadMore: "Load {{count}} more descriptions",

  // Linked-description context cards (both merge sides + split)
  ctxSurvivorHeading: "Survivor's linked descriptions",
  ctxSurvivorKept: "These stay on the survivor.",
  ctxMergedHeading: "This record's linked descriptions",
  ctxShowing: "Showing {{shown}} of {{cards}} · {{links}} links",
  ctxAndMore: "… and {{count}} more",
  ctxNoLinks: "No linked descriptions.",
  ctxAsRecorded: "as recorded:",
  ctxSourceOcr: "OCR text",

  // Merge — fold names
  mergeFoldNames: "Add this record's name(s) to the survivor's name variants",
  mergeFoldNamesHelper:
    "Off by default. When on, the merged-away record's preferred name and variants are added to the survivor.",

  // Merge — bottom bar
  reasonLabel: "Reason",
  reasonRequired: "· required",
  reasonOptional: "· optional",
  reasonPlaceholder: "Why is this being done? (recorded in the ledger)",
  mergeSummary: "{{moved}} links move · {{stay}} stay",
  mergeConfirm: "Merge into {{name}}",
  mergeConfirmGeneric: "Merge record",

  // Merge — refused because a relation repoint would duplicate a link
  mergeErrorRelationCollision:
    "Nothing was merged. After the merge, {{entity}} would hold two links to {{description}} as {{role}} that point to the same side of a relation.",

  // Merge — conflict state
  conflictTitle: "This record changed since you opened it",
  conflictBody:
    "It was edited on {{time}}. Reload to see the current version, or merge anyway to proceed with what you have.",
  conflictReload: "Reload",
  conflictProceed: "Merge anyway",
  conflictProceedSplit: "Split anyway",

  // Split workbench — page head
  splitHeading: "Split authority record",
  splitIntro:
    "Divide one conflated record into the original and a new record. Assign each field, then divide the linked descriptions.",

  // Split — record banner
  splitBeingSplit: "Splitting this record",
  splitLinkedCount: "{{count}} linked descriptions",

  // Split — assignment table
  splitColField: "Field",
  splitColGoesTo: "Goes to — Original · Both · New record",
  splitOriginal: "Original",
  splitBoth: "Both",
  splitNew: "New record",
  splitUnassigned: "Unassigned",
  splitNameOriginal: "Original record name",
  splitNameNew: "New record name",
  splitNamesIdentical:
    "Both names are identical — the new record needs a distinct name.",

  // Split — divide descriptions
  splitDivideHeading: "Divide linked descriptions",
  splitDivideNote: "Checked descriptions move to the new record",
  splitDestNew: "New record",
  splitDestOriginal: "Original",

  // Split — bottom bar
  splitConfirm: "Split record",
  splitSummaryOriginal: "Original keeps {{summary}}",
  splitSummaryNew: "New record gets {{summary}}",
  splitBlockerUnassigned: "{{count}} field rows are unassigned.",
  splitBlockerNames: "The new record needs a name distinct from the original.",
  splitBlockerReason: "Add a reason to enable confirm.",
  splitDescriptionsUnit: "{{count}} descriptions",

  // Status band
  bandMerged: "Merged into {{survivor}} on {{date}} by {{user}}",
  bandSplit: "Split into {{records}} on {{date}} by {{user}}",
  bandSplitFrom: "Split from {{parent}} on {{date}} by {{user}}",
  bandViewSurvivor: "View survivor",
  bandViewRecords: "View records",
  bandOpenLedger: "Open ledger entry",
  bandRedirectedCount: "0 (redirected)",
  bandUnknownUser: "an unknown user",

  // Bulk action bar (list surfaces). One ticked column serves every
  // errand the count can support: merge at exactly two, a handlist or
  // an export at any number. The count sentence is written whole per
  // kind of thing, the way every other count in the product is.
  bulkSelected: "{{count}} selected",
  bulkCountRecords_one: "{{count}} record selected",
  bulkCountRecords_other: "{{count}} records selected",
  bulkCountEntities_one: "{{count}} entity selected",
  bulkCountEntities_other: "{{count}} entities selected",
  bulkCountPlaces_one: "{{count}} place selected",
  bulkCountPlaces_other: "{{count}} places selected",
  bulkClear: "Clear",
  bulkMerge: "Merge…",
  bulkHintPickTwo: "Select exactly two records to merge.",
  bulkAddToHandlist: "Add to handlist",
  bulkSendToExport: "Send to export",
  bulkSelectRow: "Select this record",

  // Show-merged toggle + merged row indicator
  showMerged: "Show merged",
  mergedPill: "merged",
  mergedArrow: "→ {{survivor}}",

  // Generic errors
  errorReasonRequired: "A reason is required.",
  errorSurvivorRequired: "Select a surviving record.",
  errorNamesIdentical: "The two records need distinct names.",
  errorUnassigned: "Every field must be assigned before splitting.",
  errorGeneric: "Something went wrong. Try again.",
  // Possible-duplicates worklist
  dupHeading: "Possible duplicates",
  dupIntro:
    "Work through candidate duplicate pairs: merge true duplicates, or dismiss false matches with a reason recorded in the ledger.",
  dupCountLine_one: "candidate pair",
  dupCountLine_other: "candidate pairs · sorted by match strength",
  dupSignalName: "normalized name",
  dupSignalNearName: "near spelling",
  dupNearSpellingHint:
    "The two normalized names differ by a single character.",
  dupSignalDates: "overlapping dates",
  dupSignalWikidata: "shared Wikidata",
  dupSignalTgn: "shared Getty TGN",
  dupNotDuplicate: "Not a duplicate",
  dupCompareMerge: "Compare & merge",
  dupModalTitle: "Mark as not a duplicate",
  dupModalBody:
    "Record that {{a}} and {{b}} are not the same. The pair will not resurface in this list.",
  dupModalCancel: "Cancel",
  dupDismissedBanner:
    "Pair marked 'not a duplicate' — recorded in the ledger. It will not resurface unless the records change.",
  dupEmptyHeading: "No duplicate candidates",
  dupEmptyBody:
    "Every flagged pair has been merged or dismissed. New candidates appear here as records are added or edited.",
  dupLinksMeta: "{{count}} links",

  // Operation history
  histHeading: "Operation history",
  histBackToRecord: "Back to record",
  histEmpty: "No operations recorded for this record.",
  histMergedInto: "Merged into {{name}}",
  histMergedFrom: "Merged from {{name}}",
  histSplitInto: "Split into {{name}}",
  histSplitFrom: "Split from {{name}}",
  histSeparate: "Marked not a duplicate of {{name}}",
  histDeleted: "Record deleted",
  histResolved: "Creation provenance recorded",
  histUnknownRecord: "an unknown record",
  histDetailMoved: "{{count}} links moved",
  histDetailDropped: "{{count}} conflicting links captured",
  histDetailLeft: "{{count}} links left behind",
  dupShowing: "Showing {{shown}} of {{total}}",
  dupTabEntities: "Entities",
  dupTabPlaces: "Places",
  histShowingLatest: "Showing the latest {{shown}} of {{total}} operations",

  // Linked-descriptions worklist (detail-page redesign)
  wlSearchPlaceholder: "Search titles and codes…",
  wlAll: "All",
  wlShowing: "Showing {{shown}} of {{total}} linked descriptions",
  wlSortAria: "Sort",
  wlSortDate: "Date (newest first)",
  wlSortTitle: "Title",
  wlSortCode: "Reference code",
  wlSizeAria: "Results per page",
  wlPrev: "Previous",
  wlNext: "Next",
  wlPage: "Page {{page}} of {{pages}}",
  wlNoMatches: "No linked descriptions match the current filters.",
  // Click-to-unfold context card
  wlToggleCard: "Show or hide linked description details",
  wlCardLoading: "Loading details…",
  wlCardError: "These details could not be loaded.",
  // Filter pill group labels (round 3)
  wlFilterByRole: "Filter by role:",
  wlFilterByRepo: "Filter by repository:",
  // Unfold snippet — source tiers, expansion, and multi-match steppers
  wlSnippetScope: "Scope and content",
  wlSnippetScopeHead: "(no name match — showing the opening)",
  wlSnippetOcr: "OCR text",
  wlShowMore: "Show more",
  wlShowLess: "Show less",
  wlShowAll: "Show all",
  // Only rendered when there is more than one match, so never "1 match".
  wlMatchCount: "{{count}} matches",
  wlPrevMatch: "Previous match",
  wlNextMatch: "Next match",
  wlOcrWindowCaption:
    "Window from a {{kb}} KB transcript — full text on the description.",
  wlOcrWideCaption: "Wider window (capped) — shipped with the card.",
  wlOcrFullCaption: "Full transcript ({{kb}} KB) — fetched on demand.",
  wlOcrLoading: "Loading transcript…",

  // Evidence for a merge of two entity records: a fact and the
  // descriptions that show it. A shared name is never evidence.
  merge_evidence: {
    // By record type, as the pair page asks its question.
    facts_heading: {
      person: "What shows they are the same person?",
      family: "What shows they are the same family?",
      corporate: "What shows they are the same corporate body?",
      generic: "What shows they are the same record?",
    },
    facts_hint: "Tick at least one",
    fact: {
      dates: "Dates",
      office: "Office",
      kin: "Kin",
      place: "Place",
      matter: "Matter",
    },
    fact_help: {
      dates: "Overlapping, consistent dates",
      office: "Same office, occupation or function",
      kin: "Same parents, spouse, children or members",
      place: "Same residence or origin",
      matter: "Same case, event or business",
    },
    name_alone: "A name alone is not enough",
    descriptions_heading: "Which descriptions show it?",
    descriptions_hint: "At least one for each record",
    no_descriptions:
      "This record has no descriptions in this workspace, so there is nothing to cite and the pair cannot be merged.",
    loading: "Loading the descriptions…",
    note_label: "Note (optional)",
    error: {
      evidence_facts: {
        person: "Tick at least one fact that shows they are the same person. A name alone is not enough.",
        family: "Tick at least one fact that shows they are the same family. A name alone is not enough.",
        corporate: "Tick at least one fact that shows they are the same corporate body. A name alone is not enough.",
        generic: "Tick at least one fact that shows they are the same record. A name alone is not enough.",
      },
      evidence_loser: "Choose at least one description of the record being merged away.",
      evidence_survivor: "Choose at least one description of the surviving record.",
      evidence_unlinked: "A description you chose is not linked to its record. Reload the page and choose again.",
      evidence_stale: "A description you chose was unlinked from its record in the meantime. Reload the page and choose again.",
    },
  },

  // Possible-duplicates card: what the scan found, shown as chips. They
  // inform; they are not evidence.
  duplicates: {
    signals_label: "Found by the scan",
    signal: {
      name: "Same name",
      nearName: "Near spelling",
      dates: "Overlapping dates: {{a}} · {{b}}",
      externalId: "Shared external id",
    },
    facts: {
      label: "Facts that support this pair",
      warningTitle: "Same document.",
      warningBody: "Both records appear in the same document. They may be two people with the same name, such as a father and a son.",
      offices_one: "Office",
      offices_other: "Offices",
      officesLead: "Both hold",
      associates_one: "Associated record",
      associates_other: "Associated records",
      associatesLead: "Both appear with",
      documents_one: "Document",
      documents_other: "Documents",
      documentsLead: "Both are named in",
      untitled: "Untitled description",
      dates: "Dates",
      datesBoth: "{{a}} · {{b}}",
      datesOverlap: "The spans overlap.",
      places_one: "Place",
      places_other: "Places",
      placesLead: "Both are linked to",
      more: "+{{count}} more",
    },
  },
} as const;

// @version v0.9.0
