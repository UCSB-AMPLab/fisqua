/**
 * English translations — descriptions namespace (admin)
 *
 * This locale namespace deals with the admin-side labels for the
 * standard-aware description form.
 * Single namespace with per-standard overrides as sibling literal-string
 * keys; column-name keys; sections are i18n-keyed too. The flat
 * `field_X` / `section_X` keys from v0.3 normalise to nested
 * `fields.<columnName>` / `sections.<id>` keys, with per-standard
 * overrides as sibling literal-string keys at the same nesting level
 * (e.g. `sections["context.dacs"]` lives next to `sections.context`).
 *
 * keySeparator setting (verified 2026-05-03 against
 * `app/middleware/i18next.ts`): the project does NOT set
 * `keySeparator: false`, so i18next uses its default dot separator.
 * In that mode i18next's resolver checks for an exact literal-key
 * match before drilling, so storing the override as a literal key
 * `"context.dacs"` resolves correctly via `t("sections.context.dacs")`
 * without breaking `t("sections.context")`. This is the shape `tStd`
 * (`app/lib/i18n/standard-aware.ts`) consumes — `tStd(t,
 * "sections.context", "dacs")` resolves the override; `tStd(t,
 * "sections.context", "isadg")` falls back to the bare key.
 *
 * Section ID rename: `section_access` (v0.3) → `sections.conditions`
 * — matches the `accessConditions` column area concept and aligns
 * with `app/lib/standards/isadg.ts`'s ISAD 3.4 section id.
 *
 * The legacy related-materials flat key is removed: the corresponding
 * column was dropped in migration 0036 (0% populated in the production
 * audit); the locale entry is removed in lockstep.
 *
 * @version v0.4.3
 */
export default {
  // Page
  page_title: "Descriptions",
  new_description: "New description",
  create_description: "Create description",
  save_changes: "Save changes",
  edit: "Edit",
  discard_changes: "Discard changes",
  back_to_descriptions: "Back to descriptions",
  delete_description: "Delete description",
  delete_cancel: "Go back",
  move_button: "Move...",
  move_title: "Move description",
  move_subtitle: "Select the new parent for '{{title}}'.",
  move_confirm: "Confirm move",
  move_cancel: "Cancel",
  add_child: "Add child",
  reorder: "Reorder",
  breadcrumb_new: "New description",
  breadcrumb_root: "Descriptions",
  empty_heading: "No descriptions",
  empty_body:
    "Add the first description or import existing records.",
  filter_placeholder: "Filter...",
  ref_code_helper:
    "Suggested from parent record. You can edit it.",
  parent_helper: "Parent: {{parentTitle}}",
  level_required_helper:
    "The {{level}} level also requires these. You can revise them later on the description itself.",

  // Field guidance: the standard's OWN statement of what each element
  // is for, quoted verbatim and shown beside the field. Keyed by
  // standard with no cross-standard fallback — see FieldConfig.guidance
  // in app/lib/standards/types.ts for why a fallback would amount to a
  // false attribution. The citation is NOT stored here; it comes from
  // the config, so the two cannot drift into disagreement.
  //
  // ISAD(G): General International Standard Archival Description,
  // 2nd ed. (International Council on Archives, 2000), quoted from the
  // "Purpose" statement of each element.
  guidance: {
    "referenceCode.isadg":
      "To identify uniquely the unit of description and to provide a link to the description that represents it.",
    "title.isadg": "To name the unit of description.",
    "dateExpression.isadg":
      "To identify and record the date(s) of the unit of description.",
    "descriptionLevel.isadg":
      "To identify the level of arrangement of the unit of description.",
    "extent.isadg":
      "To identify and describe a. the physical or logical extent and b. the medium of the unit of description.",
    "creatorDisplay.isadg":
      "To identify the creator (or creators) of the unit of description.",
    "scopeContent.isadg":
      "To enable users to judge the potential relevance of the unit of description.",
    "provenance.isadg":
      "To provide information on the history of the unit of description that is significant for its authenticity, integrity and interpretation.",
    "arrangement.isadg":
      "To provide information on the internal structure, the order and/or the system of classification of the unit of description.",
    "accessConditions.isadg":
      "To provide information on the legal status or other regulations that restrict or affect access to the unit of description.",
    "reproductionConditions.isadg":
      "To identify any restrictions on reproduction of the unit of description.",
    "language.isadg":
      "To identify the language(s), script(s) and symbol systems employed in the unit of description.",
    "findingAids.isadg":
      "To identify any finding aids to the unit of description.",
    "locationOfOriginals.isadg":
      "To indicate the existence, location, availability and/or destruction of originals where the unit of description consists of copies.",
    "locationOfCopies.isadg":
      "To indicate the existence, location and availability of copies of the unit of description.",
    "notes.isadg":
      "To provide information that cannot be accommodated in any of the other areas.",
    // DACS: Describing Archives: A Content Standard, 2019.0.3 (Society
    // of American Archivists), quoted from the "Purpose and Scope"
    // statement of each element, trimmed at the Commentary. DACS is
    // published under CC-BY, so verbatim reuse is licensed; the citation
    // is the attribution.
    //
    // DACS has no element for level of description, so that field
    // carries no guidance here — correct, not an omission.
    "referenceCode.dacs":
      "This element provides a unique identifier for the unit being described. The identifier may consist of three subelements: a local identifier, a code for the repository, and a code for the country.",
    "repositoryId.dacs":
      "This element identifies the name and location of the repository that holds the materials being described.",
    "title.dacs":
      "This element provides a word or phrase by which the material being described is known or can be identified. A title may be devised or formal.",
    "dateExpression.dacs":
      "This element identifies and records the date(s) that pertain to the creation, assembly, accumulation, and/or maintenance and use of the materials being described.",
    "extent.dacs":
      "This element indicates the extent and the physical nature of the materials being described. This is handled in two parts, a number (quantity) and an expression of the extent or material type.",
    "creatorDisplay.dacs":
      "This element identifies the corporate bodies, persons, and families associated with the creation, assembly, accumulation, and/or maintenance and use of the materials being described so that they might be appropriately documented and used to create access points by which users can search for and retrieve descriptive records.",
    // 2.7's opening sentence describes what the element's RULES cover
    // rather than what the field is for, so the second sentence — the
    // one that answers "what goes here" — is the one quoted.
    "adminBiogHistory.dacs":
      "The administrative/biographical history provides relevant information about corporate bodies, persons, or families who are identified using the Name of Creator(s) Element and who therefore function as nominal access points.",
    "scopeContent.dacs":
      "This element provides information about the nature of the materials and activities reflected in the unit being described to enable users to judge its potential relevance.",
    "accessConditions.dacs":
      "This element provides information about access restrictions due to the nature of the information in the materials being described, such as those imposed by the donor, by the repository, or by statutory/regulatory requirements.",
    "language.dacs":
      "This element identifies the language(s), script(s), and symbol systems employed in the materials being described, particularly as they may affect its use.",
    // RAD: Rules for Archival Description (Canadian Council of
    // Archives), Chapter 1, revised July 2008. RAD's text is all rights
    // reserved, so these are SUMMARIES in our own words, not quotations
    // — the config marks the standard `guidanceVerbatim: false` and the
    // affordance drops the quotation marks accordingly.
    "title.rad":
      "Transcribe the formal title the material itself carries; supply one where it has none.",
    "editionStatement.rad":
      "Transcribe the edition statement on the item. Item-level description only.",
    "dateExpression.rad":
      "The date or dates the material was created. At aggregate levels record creation dates, not publication details.",
    "extent.rad":
      "How many physical units there are, in arabic numerals, with the specific material designation for that class of material.",
    "dimensions.rad":
      "The dimensions of the material, following the rules for its class.",
    "seriesStatement.rad":
      "The title of a publisher's or artist's series the item belongs to — not an archival series.",
    "adminBiogHistory.rad":
      "The history of the body, person or family responsible for creating, accumulating and using the material.",
    "provenance.rad":
      "The successive transfers of ownership, custody or control of the material, with their dates, as far as they can be established. Distinct from the creator's own history.",
    "scopeContent.rad":
      "The functions or activities the records arise from, how they relate to each other, how they are organized and their documentary forms, with the period, subject matter and geographical area they cover.",
    "systemOfArrangement.rad":
      "Arrangement that matters for understanding the material but does not belong in scope and content — a reorganization by the creator, arrangement by the archivist, a change of classification scheme.",
    "notes.rad":
      "Descriptive information that does not fit any other area.",
  },
  guidance_source: "{{standard}} {{element}}",
  guidance_source_summary: "Based on {{standard}} {{element}}",
  guidance_example_label: "e.g.",
  // Worked examples, quoted from the standards' own Examples blocks.
  // Only where the published example is short enough to read at a
  // glance: scope and content's run to a paragraph, so that field
  // carries the purpose statement alone.
  guidance_example: {
    "referenceCode.isadg": "CA OTY F0453",
    "title.isadg": "Helen Lucas fonds",
    "dateExpression.isadg": "1833-1998 (bulk 1833-1874)",
    "descriptionLevel.isadg": "Fonds",
    "extent.isadg": "103.5 cubic feet (98 boxes)",
    "creatorDisplay.isadg": "Lucas, Helen (1931- )",
  },

  // Section labels: keyed by stable English section id from the
  // standard configs (`app/lib/standards/{isadg,dacs,rad}.ts`). Per-
  // standard overrides live as sibling literal keys (e.g.
  // `"context.dacs"`) and resolve via `tStd(t, "sections.context",
  // standard)` — see file header note on keySeparator semantics.
  sections: {
    // Shared (ISAD(G) baseline + DACS/RAD overlapping)
    identity: "Identification",
    context: "Context",
    content: "Content and structure",
    conditions: "Conditions of access and use",
    allied: "Allied materials",
    notes: "Notes",
    bibliographic: "Bibliographic data",
    digital: "Digital objects",
    entities: "Linked entities",
    places: "Linked places",

    // Per-standard override: DACS calls the context block
    // "Biographical/Historical Note" rather than "Context".
    "context.dacs": "Biographical/Historical Note",

    // DACS-specific section labels
    description_control: "Description Control",
    acquisition: "Acquisition and Appraisal Information",
    related_materials: "Related Materials",
    conditions_access: "Conditions of Access and Use",
    rights: "Rights Statements",

    // RAD-specific section labels
    edition: "Edition",
    // RAD class-specific section renders empty in v0.4 (no
    // cartographic/architectural/philatelic columns post-Phase-30; see
    // `app/lib/standards/rad.ts` header).
    class_specific: "Class of Materials Specific Details",
    dates_creation: "Dates of Creation",
    physical_description: "Physical Description",
    publishers_series: "Publisher's Series",
    archival_description: "Archival Description",
    standard_number: "Standard Number",
    access_points: "Access Points",
  },

  // Field labels: keyed by column name on `descriptions`.
  // Per-standard overrides as sibling literal keys at the same level.
  fields: {
    // Identity area
    referenceCode: "Reference code",
    localIdentifier: "Local identifier",
    legacyIds: "Legacy identifiers",
    title: "Title",
    translatedTitle: "Translated title",
    uniformTitle: "Uniform title",
    descriptionLevel: "Level of description",
    resourceType: "Resource type",
    genre: "Genre",
    repositoryId: "Repository",
    parentId: "Parent record",
    childCount: "Child items",

    // Per-standard override: RAD distinguishes "Title proper" from
    // supplied/parallel titles (1.1B1 / 2.1B); ISAD(G) and DACS use
    // the bare "Title".
    "title.rad": "Title proper",

    // Date / extent
    dateExpression: "Date(s)",
    dateStart: "Start date",
    dateEnd: "End date",
    dateCertainty: "Date certainty",
    extent: "Extent",
    dimensions: "Dimensions",
    medium: "Medium",

    // Context
    creatorDisplay: "Creator",
    provenance: "Custodial history",
    adminBiogHistory: "Administrative/Biographical history",

    // Content and structure
    scopeContent: "Scope and content",
    systemOfArrangement: "System of arrangement",
    physicalCharacteristics: "Physical characteristics",
    arrangement: "Arrangement",
    ocrText: "OCR text",

    // Conditions
    accessConditions: "Conditions governing access",
    reproductionConditions: "Conditions governing reproduction",
    language: "Language of materials",

    // Allied materials
    locationOfOriginals: "Location of originals",
    locationOfCopies: "Location of copies",
    findingAids: "Finding aids",

    // Notes / citation
    notes: "Notes",
    internalNotes: "Internal notes",
    preferredCitation: "Preferred citation",

    // Acquisition (DACS)
    acquisitionInfo: "Acquisition information",

    // Bibliographic
    imprint: "Imprint",
    editionStatement: "Edition statement",
    seriesStatement: "Series statement",
    volumeNumber: "Volume number",
    issueNumber: "Issue number",
    pages: "Pages",
    sectionTitle: "Section title",
    publicationTitle: "Publication title",

    // Description control (RAD `standard_number` analogue lands here)
    descriptionsArchivists: "Archivists",
    revisionHistory: "Revision history",
    languageOfDescription: "Language of description",

    // DBE identifier (RAD authority cross-reference)
    dbeId: "DBE identifier",

    // Digital surrogate
    iiifManifestUrl: "IIIF manifest URL",
    hasDigital: "Has digital surrogate",
  },

  // Entity/place linking
  add_entity: "Add entity",
  add_place: "Add place",
  search_entity: "Search entity...",
  search_place: "Search place...",
  role_label: "Role",
  // Entity roles (must match ENTITY_ROLES in lib/validation/enums.ts)
  role_creator: "Creator",
  role_author: "Author",
  role_editor: "Editor",
  role_publisher: "Publisher",
  role_sender: "Sender",
  role_recipient: "Recipient",
  role_mentioned: "Mentioned",
  role_subject: "Subject",
  role_scribe: "Scribe",
  role_witness: "Witness",
  role_notary: "Notary",
  role_photographer: "Photographer",
  role_artist: "Artist",
  role_plaintiff: "Plaintiff",
  role_defendant: "Defendant",
  role_petitioner: "Petitioner",
  role_judge: "Judge",
  role_appellant: "Appellant",
  role_official: "Official",
  role_heir: "Heir",
  role_albacea: "Executor",
  role_spouse: "Spouse",
  role_victim: "Victim",
  role_grantor: "Grantor",
  role_donor: "Donor",
  role_seller: "Seller",
  role_buyer: "Buyer",
  role_mortgagor: "Mortgagor",
  role_mortgagee: "Mortgagee",
  role_creditor: "Creditor",
  role_debtor: "Debtor",
  role_fiador: "Surety",
  role_apoderado: "Attorney-in-Fact",
  // Place roles (must match PLACE_ROLES in lib/validation/enums.ts)
  role_created: "Created",
  role_sent_from: "Sent from",
  role_sent_to: "Sent to",
  role_published: "Published",
  role_venue: "Venue",
  // Role-picker group labels (optgroups; keys mirror ENTITY_ROLE_GROUPS)
  role_group_production: "Production & mentions",
  role_group_correspondence: "Correspondence",
  role_group_notarial: "Notarial attestation",
  role_group_legal: "Legal proceedings",
  role_group_family: "Family & inheritance",
  role_group_transactions: "Transactions",
  role_group_visual: "Visual materials",
  honorific_label: "Honorific",
  function_label: "Function",
  name_as_recorded_label: "Name as recorded",
  link_confirm: "Confirm",
  link_cancel: "Cancel",
  remove_link_confirm: "Remove link with {{name}}?",
  remove_link_button: "Remove",
  no_results: "No results found",

  // Draft/changelog
  commit_note_placeholder: "Note about changes (optional)",
  autosave_saving: "Saving...",
  autosave_saved: "Draft saved",
  conflict_banner:
    "{{name}} has unsaved changes from {{time}}.",
  overwrite_confirm:
    "This record was modified by {{name}} at {{time}}. Overwrite?",
  overwrite_button: "Overwrite",
  overwrite_cancel: "Cancel",

  // Publishing
  published_badge: "Published",
  unpublished_badge: "Unpublished",
  pending_publish: "Pending publish",
  pending_removal: "Pending removal",
  live_badge: "Live",
  publish_action: "Publish",
  unpublish_action: "Unpublish",

  // Errors
  error_generic: "An error occurred. Try again.",
  error_required: "This field is required.",
  error_duplicate_ref:
    "A description with that reference code already exists.",
  error_invalid_level:
    "The level must be below the parent record's level.",
  error_delete_blocked:
    "Cannot delete -- {{count}} child descriptions",
  error_delete_cascade:
    "Deleting this description will remove {{entityCount}} entity links and {{placeCount}} place links.",
  error_delete_confirm:
    "Are you sure you want to delete {{title}}? This action cannot be undone.",
  error_move_children:
    "This description has {{count}} children that will also be moved.",

  // Success
  success_created: "Description created.",
  success_updated: "Description updated.",
  success_deleted: "Description deleted.",
  success_moved: "Description moved.",
  success_published: "Description published.",
  success_unpublished: "Description unpublished.",
  success_entity_linked: "Entity linked.",
  success_place_linked: "Place linked.",
  success_link_removed: "Link removed.",

  // Accessibility labels
  aria_move_up: "Move up",
  aria_move_down: "Move down",
  aria_edit_link: "Edit link",
  aria_remove_link: "Remove link with {{name}}",

  // Description level display names
  level_fonds: "Fonds",
  level_subfonds: "Subfonds",
  level_series: "Series",
  level_subseries: "Subseries",
  level_file: "File",
  level_item: "Item",
  level_collection: "Collection",
  level_section: "Section",
  level_volume: "Volume",

  // View toggle
  view_tree: "File tree",
  view_columns: "Column view",

  // Column view table headers
  col_reference_code: "Reference code",
  col_title: "Title",
  col_level: "Level",
  col_repository: "Repository",
  col_has_digital: "Digital object",
  col_parent_code: "Parent code",
  col_toggle: "Columns",

  // Column view filters
  filter_level: "Description level",
  filter_repository: "Repository",
  filter_has_digital: "Has digital object",
  search_descriptions: "Search by title or reference code...",

  // Tree browser
  root_column_title: "Contents",
  loading: "Loading...",

  // No manifest placeholder
  no_manifest: "No digitized material",
  add_manifest: "Add IIIF manifest URL",

  // IIIF viewer
  loading_manifest: "Loading manifest...",
  empty_manifest: "No pages found in manifest",
  manifest_load_error: "Could not load manifest",
  zoom_in: "Zoom in",
  zoom_out: "Zoom out",
  prev_page: "Previous page",
  next_page: "Next page",
} as const;

/* @version v0.4.3 */
