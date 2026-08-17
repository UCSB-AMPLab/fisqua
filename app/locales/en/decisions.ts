/**
 * English translations — decisions namespace
 *
 * Strings for the Pending decisions surface: the surface chrome and
 * tab bar, the authority-proposal queue with its accept / amend /
 * reject rulings, the entities-and-places duplicates toggle, and the
 * feedback lines the rulings return. Kept in its own namespace rather
 * than folded into `authorities` because the surface spans three
 * modules — authority proposals, the duplicates scan, and the
 * vocabulary review queue — and none of them owns the others' copy.
 *
 * The duplicates tab reuses the `authorities` namespace for the
 * worklist body itself (`dup*` keys); only the surface-level toggle
 * and the dismissal wording live here.
 *
 * @version v0.7.0
 */
export default {
  // Surface chrome
  surfaceName: "Pending decisions",
  surfaceIntro:
    "Questions this workspace has not answered yet: authority records an import proposed, records that may be the same thing, and vocabulary terms awaiting review.",

  // Tabs
  tabProposals: "Proposals",
  tabDuplicates: "Possible duplicates",
  tabVocabulary: "Vocabulary",

  // Proposals — status filter
  filterOpen: "Open",
  filterRuled: "Ruled",
  countOpen_one: "{{count}} open proposal",
  countOpen_other: "{{count}} open proposals",
  // Ruled proposals are paged without a total, so the line is
  // explicitly page-scoped rather than pretending to be a census.
  countRuled_one: "{{count}} ruled proposal on this page",
  countRuled_other: "{{count}} ruled proposals on this page",

  // Proposals — empty states
  emptyOpenHeading: "Nothing waiting",
  emptyOpenBody:
    "No proposals are open. Imports and bulk loads file them here when they meet a name they cannot resolve on their own.",
  emptyRuledHeading: "No rulings yet",
  emptyRuledBody: "Proposals you accept, amend, or reject appear here.",

  // Proposals — card body
  sortNameLabel: "Sort name",

  // Proposal types
  typePerson: "Person",
  typeFamily: "Family",
  typeCorporate: "Corporate body",
  typePlace: "Place",
  typeTopic: "Topic",

  // Proposals — card anatomy: object, then the ask panel ("Suggested
  // action" eyebrow over the recommendation), the comment thread, and
  // the options row
  inTheIndexAs: "In the index as",
  suggestedActionEyebrow: "Suggested action",
  recommendCreate: "Create a {{type}} record",
  recommendLink: "Link to an existing record",
  recommendTopic: "None — this is a subject, not a name; nothing to create",
  recommendUndetermined: "None — this one needs your judgement",
  commentsHeading: "Comments",
  optCreate: "Create record",
  optConfirmTopic: "Confirm as subject",
  optNoCreate: "Don't create",
  reviewAndDecide: "Review and decide",
  optNoRecord: "Dismiss",

  // Evidence and links. A proposal that was read off a record names
  // that record, so the card can say what accepting would link and the
  // detail page can list every description the heading turns up in; a
  // proposal read off the heading alone says so instead of going
  // quiet. The external block is display until the reviewer confirms
  // one match — the pipeline's candidates are never recorded on their
  // own.
  mentionCount_one: "Mentioned in {{count}} record",
  mentionCount_other: "Mentioned in {{count}} records",
  classifiedFromHeading:
    "Classified from the heading alone — no record link proposed.",
  wouldLinkAs: "Would link as {{role}} to {{ref}}",
  evidenceHeading: "Records that mention this heading",
  evidenceRelatedHeading: "Records mentioning related terms",
  evidenceSeeAll: "See all in search",
  linkRoleLabel: "Link as",
  skipLinkLabel: "Don't create this link",
  externalHeading: "External matches",
  externalNone: "Don't record a match",
  externalConfirmHint: "The selected match is recorded when you accept.",
  linkCreated: "Linked to {{ref}} as {{role}}.",

  // Comment attribution pills: the System pill marks the platform's
  // own comments; humans get their snapshotted role.
  pillSystem: "System",
  pill_admin: "Admin",
  pill_lead: "Lead",
  pill_reviewer: "Reviewer",
  pill_cataloguer: "Cataloguer",
  quoteSource: "Quoted from this workspace's own catalog",

  // Proposals — ruling controls
  cancel: "Cancel",
  amendTypeLabel: "Record type",
  amendNameLabel: "Name",
  amendSortNameLabel: "Sort name",
  amendSortNamePlaceholder: "Sort form (falls back to the name)",
  rejectReasonPlaceholder: "Why this should not be created",

  // Proposals — ruled rows
  ruledAccepted: "Accepted",
  ruledAmended: "Amended",
  ruledRejected: "Rejected",
  ruledOn: "Ruled {{date}}",
  ruledResult: "Created record",

  // Proposals — feedback
  feedbackAccepted: "Proposal accepted.",
  feedbackAmended: "Proposal amended and accepted.",
  feedbackRejected: "Proposal rejected.",
  errorConflict: "This proposal has already been ruled.",
  errorInvalid: "That ruling could not be saved. Check the name and try again.",
  errorGeneric: "The ruling did not save.",

  // Detail page — the considered lane
  backToQueue: "Back to pending decisions",
  recordToCreate: "Record to create",

  detailPlaceType: "Place type",
  detailPlaceTypeNone: "Not specified",
  detailVariants: "Name variants",
  detailVariantsPlaceholder: "One spelling per line",
  detailInternalNote: "Internal note",
  detailInternalNotePlaceholder: "Kept on the record, after its provenance line",
  detailEditorHint:
    "Coordinates, external identifiers, dates, and everything else can be added in the record editor once the record exists.",
  detailCreatedHeading: "Record created",
  detailTopicHeading: "Recorded as a topic",
  detailRejectedHeading: "Proposal rejected",
  detailAlreadyRuled: "This question has already been ruled.",
  viewRecord: "View record",

  addComment: "Add a comment",
  addCommentPlaceholder: "For whoever reads this ruling later",
  postComment: "Post comment",

  // Comment affordances: edit is author-only, delete is author-or-admin,
  // and the delete button arms into a second-click confirm instead of
  // opening a dialog — deleting one comment is not a ruling.
  commentEdit: "Edit",
  commentDelete: "Delete",
  commentDeleteArmed: "Delete?",
  commentEdited: "Edited",
  commentSave: "Save",
  commentError: "The comment could not be saved.",
  commentDeleteError: "The comment could not be deleted.",

  optAcceptRecommendation: "Accept recommendation",
  optDismiss: "Dismiss",
  dismissModalTitle: "Dismiss the proposal for {{name}}?",
  // States the consequence plainly and does not soften it: the ruling
  // is retrievable, not reversible.
  dismissModalBody:
    "Nothing will be created. The question is closed and kept in the ruled list, with your name and today's date against it.",
  dismissConfirm: "Dismiss proposal",
  rejectReasonLabel: "Reason (optional)",

  // Pagination
  previous: "Previous",
  next: "Next",
  pageOf: "Page {{page}}",

  // Duplicates tab
  dupTypeEntities: "Entities",
  dupTypePlaces: "Places",
  dupDismissedNote:
    "Pairs you have marked as separate records stay out of this list.",

  // Duplicate pair card. The scan asks — it never recommends on
  // identity — so the ask slot uses the judgement eyebrow, not
  // "Suggested action". The load line separates evidence (provenance
  // prose) from consequence (how many descriptions ride on the form).
  askQuestionEyebrow: "The question",
  pairLoad_one: "{{formattedCount}} description names this form",
  pairLoad_other: "{{formattedCount}} descriptions name this form",
  pairLoadNone: "No descriptions attached yet",
  lookCloser: "Look closer",
  keepBoth: "Keep both",
  mergeIntoOne: "Merge into one record",

  // Vocabulary term card: two panes so the two forms can be read side
  // by side; the load slot carries entity usage, the consequence of a
  // term merge.
  vocabIncomingLabel: "Awaiting review",
  vocabExistingLabel: "Already in the vocabulary",
  vocabLoad_one: "{{formattedCount}} entity uses this form",
  vocabLoad_other: "{{formattedCount}} entities use this form",
  vocabLoadNone: "No entities use this form yet",
  keepOwnTerm: "Keep as its own term",
  mergeIntoExisting: "Merge into existing",

  // Pair collation page
  collationFieldLabel: "Field",

  // Merge confirmation: the direction is chosen HERE, and the fate
  // labels flip with the selection so the outcome for both records is
  // legible before committing. The body never implies undo.
  mergeDirectionLabel: "Which record survives",
  mergeSurvives: "Survives",
  mergeRetired: "Retired",
  mergeModalBody:
    "One record survives and keeps its code. The other is retired — its name form is kept as a variant on the survivor, and every description pointing at it is repointed. This cannot be undone.",
  mergeConfirm: "Merge records",

  // Pair card context and questions. The question names what the two
  // records would have to be for a merge to be right; when the two
  // sides disagree on type, the generic form asks about the record.
  pairContext: "Two records answer to this name",
  pairQuestion_person: "Are these the same person?",
  pairQuestion_family: "Are these the same family?",
  pairQuestion_corporate: "Are these the same corporate body?",
  pairQuestion_place: "Are these the same place?",
  pairQuestion_generic: "Are these the same record?",

  // Direction lines: a statement of mechanical consequence in the
  // card's quietest tone, never a recommendation. The uneven form
  // carries the survivor's code in mono via a <0> span.
  dirEven:
    "Neither record carries descriptions — you choose which code survives.",
  dirUneven_one:
    "Merging would keep <0>{{code}}</0>: {{formattedCount}} description points at it.",
  dirUneven_other:
    "Merging would keep <0>{{code}}</0>: {{formattedCount}} descriptions point at it.",

  // Keep both — the neutral-tone ruling confirm. Final, not
  // destructive: nothing is merged, the question closes.
  keepBothModalTitle: "Keep both records for {{name}}?",
  keepBothModalBody:
    "Both records stay as they are, and nothing is merged. The question is closed and kept in the ruled list — retrievable, not reversible.",
  whyDifferent_person: "Why these are different people",
  whyDifferent_family: "Why these are different families",
  whyDifferent_corporate: "Why these are different bodies",
  whyDifferent_place: "Why these are different places",
  whyDifferent_generic: "Why these are separate records",

  // Merge — dialog title and reason placeholders per record type.
  mergeModalTitle: "Merge the two records for {{name}}?",
  whySame_person: "Why these are the same person",
  whySame_family: "Why these are the same family",
  whySame_corporate: "Why these are the same body",
  whySame_place: "Why these are the same place",
  whySame_generic: "Why these are the same record",

  // Ruled pair rows
  ruledPairMerged: "Merged — {{code}} survived",
  ruledPairKeptBoth: "Kept both",

  // Pane provenance fallback and pair feedback
  pairProvNone: "No provenance recorded.",
  pairErrorConflict: "This pair has already been ruled.",
  feedbackPairMerged: "Records merged.",
  feedbackPairKeptBoth: "Both records kept.",

  // Vocabulary near-match cards. Provenance is deliberately spare:
  // status is the fact that matters, and the counts carry the load.
  vocabContext: "Subject term awaiting review",
  vocabIncomingProv: "Proposed for the vocabulary; not yet approved.",
  vocabExistingProv: "Approved as a subject term.",
  vocabSuggestedMerge: 'Merge into "{{term}}"',
  vocabDirection: "Merging keeps {{term}} — the approved form.",
  vocabKeepModalTitle: 'Keep "{{term}}" as its own term?',
  vocabKeepModalBody:
    "The term is approved and enters the vocabulary as its own subject form, alongside the existing one.",
  whyOwnTerm: "Why this is its own subject",
  vocabMergeModalTitle: "Merge the two forms of this subject?",
  vocabMergeModalBody:
    "One form survives as the subject term. The other is retired — every entity classified with it is reclassified under the survivor. This cannot be undone.",
  whySameSubject: "Why these are the same subject",
} as const;
