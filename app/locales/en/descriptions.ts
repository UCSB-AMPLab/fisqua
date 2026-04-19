/**
 * English translations — descriptions namespace
 *
 * @version v0.3.0
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

  // ISAD(G) section headings
  section_identity: "Identification",
  section_context: "Context",
  section_content: "Content and structure",
  section_access: "Conditions of access and use",
  section_allied: "Allied materials",
  section_notes: "Notes",
  section_bibliographic: "Bibliographic data",
  section_digital: "Digital objects",
  section_entities: "Linked entities",
  section_places: "Linked places",

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
  // Place roles (must match PLACE_ROLES in lib/validation/enums.ts)
  role_created: "Created",
  role_sent_from: "Sent from",
  role_sent_to: "Sent to",
  role_published: "Published",
  role_venue: "Venue",
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

  // Field labels
  field_referenceCode: "Reference code",
  field_localIdentifier: "Local identifier",
  field_title: "Title",
  field_translatedTitle: "Translated title",
  field_uniformTitle: "Uniform title",
  field_descriptionLevel: "Description level",
  field_resourceType: "Resource type",
  field_genre: "Genre",
  field_dateExpression: "Date expression",
  field_childCount: "Child items",
  field_dateStart: "Start date",
  field_dateEnd: "End date",
  field_dateCertainty: "Date certainty",
  field_extent: "Extent",
  field_dimensions: "Dimensions",
  field_medium: "Medium",
  field_provenance: "Provenance",
  field_scopeContent: "Scope and content",
  field_arrangement: "Arrangement",
  field_ocrText: "OCR text",
  field_accessConditions: "Access conditions",
  field_reproductionConditions: "Reproduction conditions",
  field_language: "Language",
  field_locationOfOriginals: "Location of originals",
  field_locationOfCopies: "Location of copies",
  field_relatedMaterials: "Related materials",
  field_findingAids: "Finding aids",
  field_notes: "Notes",
  field_internalNotes: "Internal notes",
  field_imprint: "Imprint",
  field_editionStatement: "Edition statement",
  field_seriesStatement: "Series statement",
  field_volumeNumber: "Volume number",
  field_issueNumber: "Issue number",
  field_pages: "Pages",
  field_sectionTitle: "Section title",
  field_iiifManifestUrl: "IIIF manifest URL",
  field_hasDigital: "Digitized material",
  field_repositoryId: "Repository",
  field_parentId: "Parent record",

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
