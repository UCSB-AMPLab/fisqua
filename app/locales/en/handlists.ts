/**
 * English translations — handlists namespace
 *
 * Strings for handlists: the working sets a person keeps. A handlist
 * is an ordered, named, persistent set of REFERENCES to records,
 * entities or places — one kind per handlist, fixed by its first
 * member — so most of the copy here is about the two things that
 * follow from that. It references rather than contains, which is why
 * the delete and remove copy states plainly that no record is
 * affected; and it is a snapshot of a moment, which is why the drift
 * notes exist at all.
 *
 * COUNT LINES ARE COMPOSED, NEVER ASSEMBLED. Every sentence that
 * carries a number and a kind of thing has its own key per kind —
 * `metaHeld_records`, `metaHeld_entities`, `metaHeld_places` — in the
 * same shape the search namespace uses for its selection bar. Slotting
 * a noun into a shared frame reads fine in English and is wrong half
 * the time in Spanish, where the article and the participle agree with
 * the noun.
 *
 * THE PICKER GROUP is consumed by the add-to-handlist picker that the
 * search page and the record detail pages share, not by the surfaces
 * in this namespace. It lives here because the vocabulary is the
 * handlist's, and a key that names a handlist belongs with the rest of
 * them rather than duplicated into the search bundle.
 *
 * Two lines deliberately diverge from the design card they came from,
 * both because a later ruling moved underneath the card: the share
 * dialog's reassurance no longer says sharing conveys no export right
 * (export tier is per-user role as of the 2026-08-15 ruling), and the
 * share aside names the editor role, which now ships.
 *
 * @version v0.7.0
 */
export default {
  // ── The surface ──────────────────────────────────────────────────
  title: "Handlists",
  intro:
    "A handlist is a set of records you keep. Build one from a search, or add records as you come across them — a handlist survives the search that made it, so it is the scope to reach for when the same set will be exported more than once.",
  newHandlist: "New handlist",

  // ── Index tabs ───────────────────────────────────────────────────
  tabMine: "Mine",
  tabShared: "Shared with me",
  tabAll: "All",

  // ── Index table ──────────────────────────────────────────────────
  colHandlist: "Handlist",
  colHolds: "Holds",
  colOwner: "Owner",
  colUpdated: "Updated",
  open: "Open",
  export: "Export",
  ownerYou: "You",
  sharedWith_one: "Shared with 1",
  sharedWith_other: "Shared with {{count}}",
  workspaceVisibleBadge: "Whole workspace",

  // What a handlist holds — the bare type label under the count.
  holdsRecords: "records",
  holdsEntities: "entities",
  holdsPlaces: "places",
  holdsEmpty: "empty",

  // ── The locked residue row ───────────────────────────────────────
  // A handlist shared with someone who has since lost the flag that
  // opens it. Shown with its reason, never silently absent.
  lockedLabel: "Cannot open",
  reasonAuthoritiesAdminOnly:
    "Only workspace administrators can open a handlist of authority records.",

  // ── Empty states ─────────────────────────────────────────────────
  emptyMineHeading: "No handlists yet",
  emptyMineBody:
    "Tick results on the search page and choose “Add to handlist”, or add a record to a handlist from its own page while browsing.",
  emptySharedHeading: "Nothing shared with you yet",
  emptySharedBody:
    "A handlist someone shares with you appears here, named with the person who shared it.",
  emptyAllHeading: "No handlists yet",
  emptyAllBody:
    "Tick results on the search page and choose “Add to handlist”, or add a record to a handlist from its own page while browsing.",
  emptyMembersHeading: "Nothing in this handlist yet",
  emptyMembersBody:
    "Tick results on the search page and choose “Add to handlist”, or add a record from its own page while browsing. The first thing you add fixes what this handlist holds.",

  // ── The handlist's own page ──────────────────────────────────────
  ownYours: "you own this",
  sharedBy: "shared by {{name}}",
  savedAt: "saved {{date}}",
  updatedAt: "updated {{date}}",
  rename: "Rename",
  share: "Share",
  delete: "Delete",
  exportHandlist: "Export this handlist",
  roleViewOnly: "View only",
  roleCanEdit: "Can edit",

  // How many it holds, one sentence per kind of thing.
  metaHeld_records_one: "{{count}} record",
  metaHeld_records_other: "{{count}} records",
  metaHeld_entities_one: "{{count}} entity",
  metaHeld_entities_other: "{{count}} entities",
  metaHeld_places_one: "{{count}} place",
  metaHeld_places_other: "{{count}} places",
  metaHeldEmpty: "No members yet",

  // How many would actually leave in an export.
  metaWillExport_records_one: "{{count}} record will export",
  metaWillExport_records_other: "{{count}} records will export",
  metaWillExport_entities_one: "{{count}} entity will export",
  metaWillExport_entities_other: "{{count}} entities will export",
  metaWillExport_places_one: "{{count}} place will export",
  metaWillExport_places_other: "{{count}} places will export",

  metaNeedsReview_one: "{{count}} needs review",
  metaNeedsReview_other: "{{count}} need review",
  metaMissing_one: "{{count}} no longer exists",
  metaMissing_other: "{{count}} no longer exist",

  // ── Drift: the banner over a handlist the workspace moved under ──
  driftLead_one: "One member changed under this handlist.",
  driftLead_other: "{{count}} members changed under this handlist.",
  driftExport_one:
    "Exporting now leaves one member out, so {{exportable}} of {{total}} would leave.",
  driftExport_other:
    "Exporting now leaves {{count}} members out, so {{exportable}} of {{total}} would leave.",
  driftReview_one: "Review it",
  driftReview_other: "Review the {{count}}",

  // ── Per-row integrity notes ──────────────────────────────────────
  noteMerged: "Followed a merge",
  noteCollapsed_one: "Followed a merge — 1 duplicate row folded in",
  noteCollapsed_other: "Followed a merge — {{count}} duplicate rows folded in",
  noteSplit: "Split into two records — choose which belongs here",
  noteMissing: "No longer in the workspace — not counted, not exported",
  acknowledge: "Acknowledge",
  keepBoth: "Keep both",
  keepOnly: "{{name}} only",
  keepOnlyUntitled: "The original only",
  removeFromHandlist: "Remove from handlist",
  dragHandle: "Drag to reorder",
  footDragHint: "drag to reorder; the order is kept on export",
  footExportHint: "{{exportable}} will export · {{excluded}} excluded",

  // ── The other door into the within-handlist scope ────────────────
  // Typing here lands on the search surface with the handlist pill
  // already set, rather than running a private search in this page —
  // one facet, two entrances, and no second implementation of the
  // tabs, the facets and the selection bar. The count is the
  // handlist's own, so the placeholder says which set is about to be
  // asked, one sentence per kind of thing.
  searchWithin_records_one: "Search this record…",
  searchWithin_records_other: "Search these {{count}} records…",
  searchWithin_entities_one: "Search this entity…",
  searchWithin_entities_other: "Search these {{count}} entities…",
  searchWithin_places_one: "Search this place…",
  searchWithin_places_other: "Search these {{count}} places…",

  // ── Export, gated by the review ──────────────────────────────────
  exportBlockedWhy:
    "Export waits on the review. A handlist with members awaiting a decision would leave them out without saying so, so the action returns once every row has been resolved.",

  // ── Create ───────────────────────────────────────────────────────
  provenance: "Handlists",
  createTitle: "New handlist",
  createBody:
    "A handlist keeps the set you put in it, and it survives the search that made it. Name it so you recognize it later.",
  createAside:
    "The first thing you add fixes what this handlist holds — records, entities or places — and that cannot change later.",
  createConfirm: "Create handlist",
  nameLabel: "Name (required)",
  namePlaceholder: "Name this handlist",
  cancel: "Cancel",

  // ── Rename ───────────────────────────────────────────────────────
  renameTitle: "Rename handlist",
  renameConfirm: "Save",
  renameUnaffected: "unaffected",

  // ── Delete ───────────────────────────────────────────────────────
  deleteTitle: "Delete “{{name}}”?",
  deleteBody:
    "The handlist and its order are gone for good. This cannot be undone.",
  deleteKeepLead: "No records are affected.",
  deleteKeepBody_one:
    "The one member stays exactly where it is in the workspace — a handlist only points at it. Nothing is removed from any collection, and no description changes.",
  deleteKeepBody_other:
    "All {{count}} members stay exactly where they are in the workspace — a handlist only points at them. Nothing is removed from any collection, and no description changes.",
  deleteLossLead: "What you lose:",
  deleteLoss_one:
    "the name, the place you gave its one member, and this handlist as an export scope.",
  deleteLoss_other:
    "the name, the chosen order of the {{count}} members, and this handlist as an export scope.",
  deleteSharedNote_one: "Shared with 1 person. They will no longer see it.",
  deleteSharedNote_other:
    "Shared with {{count}} people. They will no longer see it.",
  deleteConfirm: "Delete handlist",

  // ── Share ────────────────────────────────────────────────────────
  shareTitle: "Share “{{name}}”",
  shareBody:
    "People you share with can read this handlist and open its members.",
  shareAddLabel: "Add someone",
  shareOwner: "Owner",
  shareRoleViewer: "View only",
  shareRoleEditor: "Can edit",
  shareKeepLead: "Sharing grants nothing else.",
  shareKeepBody_one:
    "It conveys no module access, and it changes nothing about the export formats a person is offered — those follow their own role. It withholds nothing either: everyone shared with sees the one member this handlist holds.",
  shareKeepBody_other:
    "It conveys no module access, and it changes nothing about the export formats a person is offered — those follow their own role. It withholds nothing either: everyone shared with sees all {{count}} members.",
  shareAside:
    "Only you can rename, share and delete this handlist. Someone with edit access can add, remove and reorder its members.",
  shareIneligible: "Cannot be shared",
  shareNobody: "Nobody else is in this workspace yet.",
  shareDone: "Done",

  // Workspace visibility, the share dialog's other half.
  workspaceVisibleLabel: "Visible to the whole workspace",
  workspaceVisibleHint:
    "Anyone in this workspace can find and read it, without being named here.",

  // ── Refusals, surfaced where the choice was made ─────────────────
  errorNameRequired: "A handlist needs a name.",
  errorDuplicateName:
    "You already have a handlist called “{{name}}”. Names must differ so exports can be told apart in history.",
  errorCeiling:
    "A handlist holds at most {{max}} members. Export a branch or the whole workspace instead.",
  errorIneligibleShare:
    "That person cannot open this handlist, so it cannot be shared with them.",
  errorForbidden: "You cannot do that to this handlist.",
  errorNotFound: "That handlist is no longer here.",
  errorGeneric: "That did not go through. Try again.",
  warnCeiling_one:
    "This handlist now holds {{count}} member. Past a few thousand, a branch or the whole workspace is a better scope than a handlist.",
  warnCeiling_other:
    "This handlist now holds {{count}} members. Past a few thousand, a branch or the whole workspace is a better scope than a handlist.",

  // ── No access ────────────────────────────────────────────────────
  noAccessTitle: "You cannot open this handlist",

  // ── The add-to-handlist picker (consumed by search and detail) ───
  pickerSaveTitle: "Add to handlist",
  pickerAddTitle: "Add to handlist",
  pickerNewOption: "New handlist…",
  pickerNameLabel: "Name (required)",
  pickerNamePlaceholder: "Name this handlist",
  pickerAdd: "Add",
  pickerCreateAndAdd: "Create and add",
  pickerCancel: "Cancel",
  pickerEmpty: "No handlists of this kind yet. Make one to start.",
  pickerResult_one: "Now 1 in {{name}}",
  pickerResult_other: "Now {{count}} in {{name}}",
  pickerAlreadyIn_one: "1 already in",
  pickerAlreadyIn_other: "{{count}} already in",
  // Membership, said before the add rather than after it: on a menu
  // row that already holds the one record being added, and on the
  // affordance itself, which states where the record is instead of
  // only offering to put it somewhere.
  pickerHoldsThis: "Already in",
  inHandlists_one: "In 1 handlist",
  inHandlists_other: "In {{count}} handlists",
  pickerErrorTypeMismatch: "That handlist holds a different kind of thing.",
  pickerErrorCeiling:
    "That would take the handlist past {{max}} members. Export a branch or the whole workspace instead.",
  pickerErrorDuplicateName:
    "You already have a handlist with that name. Names must differ so exports can be told apart in history.",
  pickerErrorNameRequired: "A handlist needs a name.",
} as const;
