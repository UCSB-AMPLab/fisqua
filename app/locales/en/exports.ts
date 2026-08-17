/**
 * English translations — exports namespace
 *
 * Strings for the self-service export surface: the three axes a person
 * chooses along (what leaves, the descriptive shape it takes, the file
 * that carries it), the dialog that watches a run, and the history that
 * records every run the workspace has ever made.
 *
 * COUNT LINES ARE COMPOSED, NEVER ASSEMBLED FROM A SHARED FRAME. Every
 * sentence carrying a number and a kind of thing has its own key per
 * kind — `countRecords`, `countEntities`, `countPlaces` — because a
 * noun slotted into one frame reads fine in English and is wrong half
 * the time in Spanish, where the article and the participle agree with
 * the noun. Each key takes both `count` (so i18next picks the plural)
 * and `formatted` (the number already grouped for the reader's locale,
 * since `{{count}}` interpolates ungrouped digits).
 *
 * MACHINE CODES BECOME SENTENCES HERE AND NOWHERE ELSE. The legality
 * matrix, the scope resolver and the run executor all speak in stable
 * identifiers — `ead-not-authority`, `handlist-needs-review`,
 * `duplicate-reference-code` — and this bundle is the single place a
 * code turns into something a person reads. The `reason*` and
 * `failure*` groups are keyed by those codes; renaming a code without
 * renaming its key here leaves the surface printing an identifier.
 *
 * TWO TONES, KEPT APART. Saffron copy (the `loss*` group) describes
 * choices that SUCCEED and cost something — a crosswalk that drops
 * fields, an authorities toggle turned off. Madder copy (the
 * `failure*` group) describes runs that stopped. Nothing in the first
 * group may read like an error, because a cataloguer who learns to
 * click past the colour of a warning will click past the colour of a
 * refusal too.
 *
 * @version v0.7.0
 */
export default {
  // ── The surface ──────────────────────────────────────────────────
  eyebrow: "Import and export",
  title: "Export records",
  titleAuthority: "Export authority records",
  intro:
    "Choose what leaves the workspace, the descriptive shape it takes, and the file that carries it. The three choices are independent; the same records can leave in any shape a form can render.",
  introAuthority:
    "The scope carries its own type, and this one holds entities rather than archival descriptions. That single fact reshapes both axes beside it: most descriptive standards have nothing to say about a person, and a finding aid is not a thing you can encode an authority file as.",

  axisWhat: "1 · What",
  axisForm: "2 · Form",
  axisFormat: "3 · Format",

  // ── Counts ───────────────────────────────────────────────────────
  // Each takes { count, formatted }: `count` drives the plural,
  // `formatted` carries the locale's thousands grouping.
  countRecords_one: "{{formatted}} record",
  countRecords_other: "{{formatted}} records",
  countEntities_one: "{{formatted}} entity",
  countEntities_other: "{{formatted}} entities",
  countPlaces_one: "{{formatted}} place",
  countPlaces_other: "{{formatted}} places",
  countLinks_one: "{{formatted}} description link",
  countLinks_other: "{{formatted}} description links",
  countSeries_one: "{{formatted}} series",
  countSeries_other: "{{formatted}} series",
  countCollections_one: "{{formatted}} collection",
  countCollections_other: "{{formatted}} collections",
  // "14 entities, 0 places, and their 212 description links"
  andTheirLinks: "and their {{links}}",
  joinOr: "{{head}} or {{tail}}",

  // ── The What axis ────────────────────────────────────────────────
  doorWorkspace: "The whole workspace",
  doorBranch: "One collection or branch",
  doorBranchSub: "Pick any level of the hierarchy; descendants come with it",
  doorCarried: "A search or selection",
  doorCarriedSub:
    "Carried from the search page — a query, records you ticked, or both",
  doorCarriedSubEmpty: "Nothing carried yet",
  doorHandlist: "A handlist",
  doorHandlistSub:
    "One of your saved handlists — re-exportable as often as needed",
  doorHandlistSubAuthority: "An entity-typed handlist of your own",

  // Door-level dim reasons, keyed by the matrix's machine codes.
  reasonDoorHoldsRecords:
    "Records, not authority records — pick an authority scope instead",
  reasonDoorNotInHierarchy:
    "Authority records do not sit in the archival hierarchy",

  // ── The branch picker ────────────────────────────────────────────
  branchFilterPlaceholder: "Filter collections and series…",
  branchEscHint: "esc",
  branchUse: "Use this branch",
  branchChange: "Change",
  branchNothingChosen: "Nothing chosen yet.",
  branchChosen: "{{name}} — {{records}} across {{series}} beneath it",
  branchChosenFlat: "{{name}} — {{records}}",
  branchSummary: "{{records}} · {{series}} beneath",
  branchSummaryFlat: "{{records}}",
  branchMatches_one: "{{count}} match in {{collections}}",
  branchMatches_other: "{{count}} matches in {{collections}}",
  branchHidden_one: "{{count}} series without a match hidden",
  branchHidden_other: "{{count}} series without a match hidden",
  branchNoMatchHeading: "No collection or series matches “{{term}}”",
  branchNoMatchBody:
    "Check the spelling, or clear the filter to browse the whole hierarchy.",
  branchNoMatchCount: "0 matches.",
  branchEmptyHeading: "This workspace has no descriptions yet",
  branchEmptyBody:
    "A branch is a position in the hierarchy, so there is nothing to pick until something is catalogued.",

  // ── The carried scope ────────────────────────────────────────────
  carriedAllMatches: "{{items}} · all matches included",
  carriedRunStamp: "run {{stamp}}",
  carriedFoundRecords: "{{records}} found",
  carriedFoundEntities: "{{entities}} found",
  carriedFoundPlaces: "{{places}} found",
  carriedUnticked: "− {{formatted}} unticked",
  carriedWillExport: "{{items}} will export",
  carriedRerun:
    "Re-run before exporting if records changed since {{time}} — a query is a claim about the index at the moment it ran.",
  carriedTickedRecords: "{{records}}, ticked one by one",
  carriedTickedEntities: "{{entities}} · ticked on the Entities tab",
  carriedTickedPlaces: "{{places}} · ticked on the Places tab",
  carriedNoQuery: "no query",
  carriedNotSaved:
    "This set is not saved. It applies to this export only; the history row will name the count, not the records. To keep it, add it to a handlist — a handlist is the saved scope, and has its own tile.",
  carriedEmptyHeading: "No search or selection carried yet",
  carriedEmptyBody:
    "Build one on the search page and send it here, or pick a recent search below.",
  carriedRecentLabel: "Recent searches",
  carriedOpenSearch: "Open the search page",
  carriedChange: "Change",

  // ── The handlist door ────────────────────────────────────────────
  handlistMeta: "{{records}} · saved {{date}}",
  handlistMetaEntities: "{{entities}} · saved {{date}}",
  handlistMetaPlaces: "{{places}} · saved {{date}}",
  handlistOrderNote:
    "The handlist's own order is kept in the export. Editing the handlist later does not change a run already recorded.",
  handlistTypedEntities:
    "Typed to entities, so the whole handlist is one kind of thing — which is what lets the two axes beside it narrow honestly.",
  handlistTypedPlaces:
    "Typed to places, so the whole handlist is one kind of thing — which is what lets the two axes beside it narrow honestly.",
  handlistChange: "Change handlist",
  handlistChoose: "Choose a handlist",
  handlistEmptyHeading: "No handlists to export yet",
  handlistEmptyBody:
    "A handlist is the saved scope: build one from a search, then come back and export it as often as you need.",
  handlistOpen: "Open handlists",

  // ── The authorities toggle ───────────────────────────────────────
  toggleTitle: "Include authorities and their links",
  toggleSub:
    "Your own entities and places, plus the shared ones your records cite.",
  toggleOff:
    "Descriptions still name their people and places. Without the authority records, those names arrive as plain text — no codes, no dates, no variants, and nothing to resolve two spellings of one person to each other.",
  toggleNotApplicable:
    "Not applicable — the scope is authorities. Their linked descriptions are named in the summary instead.",

  // ── The Form axis ────────────────────────────────────────────────
  formIsadg: "ISAD(G)",
  formDacs: "DACS",
  formRad: "RAD",
  formDc: "Dublin Core",
  formCanonical: "Fisqua canonical",
  formOwnSub: "This workspace's own standard",
  formCrosswalkSub: "Crosswalk",
  formDcSub: "Fifteen-element crosswalk",
  formDcSubAuthority: "Fifteen-element crosswalk · agents as creator and subject",
  formCanonicalSub: "Round-trips through import",
  reasonDescriptiveStandardNotAuthority:
    "Describes archival materials, not authority records",
  eacLabel: "Proposed · later cut",
  eacTitle: "EAC-CPF",
  eacBody:
    "The standard built for authority records. Until it exists as a form, an authority export leaves in canonical or Dublin Core.",

  // ── The Format axis ──────────────────────────────────────────────
  formatCsv: "CSV",
  formatCsvSub: "Spreadsheet rows, one per record",
  formatCsvSubCanonical:
    "Export, edit, re-import — the same columns the importer reads",
  formatEad: "EAD XML",
  formatEadSub: "Encoded finding aid",
  formatJson: "JSON",
  formatJsonSub: "Structured data",
  formatPdf: "PDF",
  formatPdfSub: "Formatted finding aid — opens print-ready in a new tab",
  reasonEadNeedsDescriptiveStandard:
    "Only the descriptive standards render as an encoded finding aid",
  reasonEadNotAuthority: "Encodes a finding aid, which an authority file is not",
  reasonPdfNeedsDescriptiveStandard: "A finding aid needs a descriptive standard",

  // ── What a crosswalk costs ───────────────────────────────────────
  lossTitle: "{{form}} cannot carry everything {{own}} holds",
  lossDroppedLabel: "Dropped",
  lossDroppedBody:
    "No {{form}} element carries {{fields}}. These are written in {{own}} and will not appear in the file.",
  lossFieldFirst_one: "{{field}} ({{formatted}} record)",
  lossFieldFirst_other: "{{field}} ({{formatted}} records)",
  lossField: "{{field}} ({{formatted}})",
  lossMergedLabel: "Merged",
  lossMergedFirst_one:
    "{{fields}} both become {{into}}. On the {{formatted}} record that holds both, the two become one paragraph and cannot be told apart afterwards.",
  lossMergedFirst_other:
    "{{fields}} both become {{into}}. On the {{formatted}} records that hold both, the two become one paragraph and cannot be told apart afterwards.",
  lossMergedMore: "{{fields}} merge the same way, into {{into}}.",
  lossMergedPair: "{{a}} and {{b}}",
  lossFlattenedLabel: "Flattened",
  lossFlattenedBody:
    "{{form}} has no way to say that one record belongs inside another. These {{records}} sit in {{series}} across {{collections}}; they arrive as {{plain}} unrelated items, and the arrangement that gives them meaning is not recoverable from the file.",
  lossFooter: "Every one of these survives in this workspace's own standard.",
  lossEscape: "Export as {{standard}} instead",
  lossCompactDropped_one: "{{count}} field dropped",
  lossCompactDropped_other: "{{count}} fields dropped",
  lossCompactMerged_one: "{{count}} pair merged",
  lossCompactMerged_other: "{{count}} pairs merged",
  lossCompactFlattened: "hierarchy flattened",

  // The canonical field names the loss report counts, keyed by the
  // machine codes `computeCrosswalkLoss` returns.
  // The description columns the crosswalk loss report can name, keyed
  // by the schema column code `computeCrosswalkLoss` returns. Lowercase
  // because every one of them appears mid-sentence.
  fieldAccessConditions: "access conditions",
  fieldAcquisitionInfo: "immediate source of acquisition",
  fieldAdminBiogHistory: "administrative and biographical history",
  fieldArrangement: "arrangement",
  fieldCreatorDisplay: "creator",
  fieldDateCertainty: "date certainty",
  fieldDateEnd: "end date",
  fieldDateExpression: "date",
  fieldDateStart: "start date",
  fieldDescriptionLevel: "level of description",
  fieldDimensions: "dimensions",
  fieldEditionStatement: "edition statement",
  fieldExtent: "extent",
  fieldFindingAids: "finding aids",
  fieldGenre: "genre",
  fieldHasDigital: "digital availability",
  fieldIiifManifestUrl: "IIIF manifest",
  fieldImprint: "imprint",
  fieldInternalNotes: "internal notes",
  fieldIssueNumber: "issue number",
  fieldLanguage: "language",
  fieldLegacyIds: "legacy identifiers",
  fieldLocalIdentifier: "local identifier",
  fieldLocationOfCopies: "location of copies",
  fieldLocationOfOriginals: "location of originals",
  fieldMedium: "medium",
  fieldNotes: "notes",
  fieldOcrText: "transcribed text",
  fieldPages: "pages",
  fieldPhysicalCharacteristics: "physical characteristics",
  fieldPreferredCitation: "preferred citation",
  fieldProvenance: "custodial history",
  fieldPublicationTitle: "publication title",
  fieldReferenceCode: "reference code",
  fieldRepositoryId: "repository",
  fieldReproductionConditions: "reproduction conditions",
  fieldResourceType: "resource type",
  fieldScopeContent: "scope and content",
  fieldSectionTitle: "section title",
  fieldSeriesStatement: "series statement",
  fieldSystemOfArrangement: "system of arrangement",
  fieldTitle: "title",
  fieldTranslatedTitle: "translated title",
  fieldUniformTitle: "uniform title",
  fieldVolumeNumber: "volume number",

  // ── The confirm bar ──────────────────────────────────────────────
  barSummary: "{{scope}} · {{form}} as {{format}} — {{counts}}",
  barRecorded: "Recorded in export history.",
  barRecordedAuthority:
    "Recorded in export history. Descriptions themselves are not included; their links are.",
  barNothingChosen: "Choose what leaves, and in what shape.",
  exportAction: "Export",

  // ── Scopes named in prose ────────────────────────────────────────
  scopeWorkspace: "The whole workspace",
  scopeSelection: "A selection",

  // ── The dialog ───────────────────────────────────────────────────
  dialogProvenance: "Export · {{scope}}",
  confirmTitleRecords_one: "Export {{formatted}} record?",
  confirmTitleRecords_other: "Export {{formatted}} records?",
  confirmTitleEntities_one: "Export {{formatted}} entity?",
  confirmTitleEntities_other: "Export {{formatted}} entities?",
  confirmTitlePlaces_one: "Export {{formatted}} place?",
  confirmTitlePlaces_other: "Export {{formatted}} places?",
  confirmBody:
    "Fisqua will prepare the file and record the run in export history. Nothing in the workspace changes.",
  rowScope: "Scope",
  rowForm: "Form",
  rowFormat: "Format",
  rowFormOwn: "this workspace's own standard",
  rowFormCrosswalk: "crosswalked from {{own}}",
  rowFormatCsv: "one row per record",
  rowFormatEad: "encoded finding aid",
  rowFormatJson: "structured data",
  rowFormatPdf: "formatted finding aid",
  confirmFooterAuthoritiesOn:
    "Recorded in export history with its scope, shape, and counts. Authorities are included because the toggle is on.",
  confirmFooterAuthoritiesOff:
    "Recorded in export history with its scope, shape, and counts. Authorities are not included, because the toggle is off.",
  confirmFooterAuthorityScope:
    "Recorded in export history with its scope, shape, and counts. The descriptions these authorities are linked to are named as links, not exported.",
  cancel: "Cancel",

  workingTitle: "Preparing your export",
  statusInProgress: "In progress",
  workingProgress: "{{done}} of {{items}}",
  workingEta_one: "about {{count}} minute left",
  workingEta_other: "about {{count}} minutes left",
  stageDescriptions: "Writing descriptions.",
  stageAuthorities: "Writing authorities.",
  stageSerializing: "Writing {{artifact}}.",
  stageThenAuthorities: "Then authorities, then {{artifact}}.",
  stageThen: "Then {{artifact}}.",
  artifactCsv: "the spreadsheet",
  artifactEad: "the encoded finding aid",
  artifactJson: "the structured data",
  artifactPdf: "the rendered finding aid",
  workingLeave:
    "You can close this and keep working. The run continues, and finishes in export history.",
  workingStarted: "Started {{time}}",
  cancelRun: "Cancel run",
  close: "Close",

  readyTitle: "Your export is ready",
  statusCompleted: "Completed",
  readyFinished: "finished {{time}} · took {{duration}}",
  readyMeta: "{{format}} · {{size}} · {{counts}}",
  readyRetention:
    "Kept in export history for 30 days, and downloadable again from there.",
  download: "Download",
  openFindingAid: "Open finding aid",

  failedTitle: "The export stopped",
  statusFailed: "Failed",
  statusCancelled: "Cancelled",
  failedStopped: "stopped after {{done}} of {{items}}",
  failedStoppedEarly: "stopped before anything was written",
  failedRecorded: "Recorded in export history as a failed run, with this reason.",
  failedWindow: "{{from}} – {{to}}",
  openRecords: "Open the records",
  tryAgain: "Try again",

  // ── Failures, keyed by the run's machine code ────────────────────
  failureDuplicateReferenceCode:
    "Two records share the reference code {{code}}. Reference codes must be unique to encode a finding aid.",
  failureDuplicateReferenceCodeFix:
    "Open either record to correct one, then run the export again.",
  failureFormatNotBuilt:
    "This format is not available yet. It is still being built; the other formats work now.",
  failureUnexpected:
    "The run stopped for a reason Fisqua could not name. Try it again — either way, the run stays recorded here.",
  failureWorkspaceStandardUnset:
    "This workspace has no descriptive standard set, so an export has no form to take.",
  failureFormatRequiresAdmin:
    "That format is available to workspace admins only.",
  failureHandlistNeedsReview:
    "This handlist has members waiting on a decision. Resolve them on the handlist page, then export.",
  failureHandlistEmpty: "Nothing in this handlist would export.",
  failureHandlistUntyped:
    "This handlist has no members yet, so it has no type to export as.",
  failureBranchNotFound: "That branch is no longer in this workspace.",
  failureScopeEmpty: "This scope holds nothing to export.",
  failureIllegalCombination:
    "That form and that format do not make an artifact. Choose again.",

  // ── Export history ───────────────────────────────────────────────
  historyTitle: "Export history",
  historyIntro:
    "These records are yours, and getting them out never requires us. Every export is recorded here, so the workspace can always say what left, in what shape, and when.",
  historyEmptyHeading: "No exports yet",
  historyEmptyBody:
    "Choose what to export above. Every run is recorded here with its scope, shape, and counts.",
  rowTitle: "{{scope}} · {{form}} · {{format}}",
  rowPreparing: "Preparing · {{counts}}",
  rowProgress: "{{stage}} · {{done}} of {{items}}",
  rowLeaveWithEta:
    "{{eta}}. You can leave this page — the run continues, and finishes here.",
  rowLeave: "You can leave this page — the run continues, and finishes here.",
  rowReadyShortly: "Ready shortly",
  rowHandlist: "handlist",
  rowCarriedFound: "{{exported}} of {{found}} found",
  rowCarriedUnticked: "{{count}} unticked",
  rowFileGone:
    "The file was removed after 30 days. What left, in what shape, and when stays recorded.",
  openAgain: "Open again",

  // ── Nothing to offer ─────────────────────────────────────────────
  nothingHeading: "There is nothing here for you to take",
  nothingBody:
    "Authority records leave as data rather than as a finding aid, and the machine-readable formats belong to workspace admins. Ask an admin of this workspace to export this scope.",
  standardUnsetHeading: "This workspace has no descriptive standard",
  standardUnsetBody:
    "An export takes the shape of a descriptive standard, so a workspace without one has no form to leave in. An admin can set it in the workspace settings.",
} as const;
