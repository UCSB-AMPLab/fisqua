/**
 * English translations — repositories namespace
 *
 * This locale namespace carries the English strings for the
 * repositories admin surface — the list page, the create/edit form,
 * the destructive actions, and the fields of the repository's
 * simplified ISDIAH record. Repositories are the top-level
 * institutional anchors the description tree hangs off, so the labels
 * follow ISAAR(CPF)'s phrasing for archival institutions,
 * and the record's fields follow ISDIAH's element names.
 *
 * @version v0.9.0
 */
export default {
  title: "Repositories",
  add: "Add repository",
  create_title: "New repository",
  create_submit: "Create repository",
  save: "Save changes",
  edit: "Edit repository",
  discard: "Discard changes",
  back: "Back to repositories",
  delete: "Delete repository",
  delete_modal_dismiss: "Go back",
  delete_modal_title: "Delete repository",
  delete_modal_body:
    "Are you sure you want to delete {{name}}? This action cannot be undone.",
  delete_modal_confirm_label: 'Type “{{code}}” to confirm',
  delete_blocked: "Cannot delete — {{count}} linked descriptions",
  cascade_warning: "This repository has {{count}} linked descriptions.",
  cascade_examples: "Examples:",
  empty_title: "No repositories",
  empty_body: "Add the first repository to start linking descriptions.",
  search_placeholder: "Search by name or code...",
  filter_enabled: "Enabled",
  filter_disabled: "Disabled",
  filter_all: "All",
  columns_label: "Columns",
  badge_enabled: "Enabled",
  badge_disabled: "Disabled",
  results_count: "Showing {{count}} of {{total}} repositories",
  error_duplicate_code: "A repository with that code already exists.",
  error_generic: "An error occurred. Try again.",
  error_required: "This field is required.",
  success_created: "Repository created.",
  success_updated: "Repository updated.",
  success_deleted: "Repository deleted.",
  section_identity: "Identity area",
  section_contact: "Contact area",
  section_admin: "Administrative",
  "field.code": "Code",
  "field.name": "Name",
  "field.shortName": "Short name",
  "field.countryCode": "Country code",
  country_choose: "Choose a country",
  country_code_help: "Filled from the country (ISO alpha-3); edit it if you need a different value.",
  code_help:
    "A short identifier unique to this workspace: it labels the repository in lists and record pickers, and travels with every exported record. Convention: country prefix plus the initials of the name's significant words, e.g. co-ahrb.",
  code_suggested: "Suggested: {{code}}",
  code_use_suggestion: "Use suggestion",
  single_repo_note:
    "This is a single-repository workspace: its repository is already set up, and every record files under it. Adding more repositories requires the multi-repository capability.",
  short_name_help:
    "A compact display name: record pickers and the published site label the repository with it, falling back to the code and then the full name.",
  website_help: "Shown on the repository's page on the published site.",
  notes_help: "Internal working notes for this workspace — never published or exported.",
  rights_text_help:
    "A short text about reproducing the digitized images. It appears as written on the published site.",
  enabled_help:
    "A disabled repository is hidden from record pickers, import commits, and the published repository index; its existing records stay put.",
  last_repository_note:
    "The workspace's only repository cannot be deleted — records and imports file under it.",
  "field.country": "Country",
  "field.city": "City",
  "field.address": "Address",
  "field.website": "Website",
  "field.notes": "Notes",
  "field.rightsText": "Image reproduction text",
  "field.manifestRights": "Rights URI (IIIF manifest)",
  "field.attributionEn": "Attribution in English (IIIF manifest)",
  "field.attributionEs": "Attribution in Spanish (IIIF manifest)",
  "field.creditStatementEs": "Credit statement (Spanish)",
  "field.creditStatementEn": "Credit statement (English)",
  credit_statement_help:
    "Who digitized the materials, with whom and with whose support. It appears as written in the image attribution line on the published site, between the place and the license.",
  "field.enabled": "Status",

  // Institution record (ISDIAH)
  section_description: "Description area",
  section_access: "Access area",
  section_services: "Services area",
  section_control: "Control area",
  "field.otherNames": "Other forms of name",
  other_names_help: "One name per line.",
  "field.institutionType": "Type of institution",
  "field.region": "Region",
  region_help: "Department, state or province.",
  "field.postalCode": "Postal code",
  "field.telephone": "Telephone",
  "field.email": "Email",
  "field.holdingsEs": "Holdings (Spanish)",
  "field.holdingsEn": "Holdings (English)",
  "field.historyEs": "History of the institution (Spanish)",
  "field.historyEn": "History of the institution (English)",
  "field.openingTimesEs": "Opening times (Spanish)",
  "field.openingTimesEn": "Opening times (English)",
  "field.accessConditionsEs": "Access conditions (Spanish)",
  "field.accessConditionsEn": "Access conditions (English)",
  "field.accessibilityEs": "Accessibility (Spanish)",
  "field.accessibilityEn": "Accessibility (English)",
  "field.reproductionServicesEs": "Reproduction services (Spanish)",
  "field.reproductionServicesEn": "Reproduction services (English)",
  markdown_help:
    "Markdown: paragraphs, lists and links. Raw HTML is not shown on the published site.",
  "field.descriptionLanguage": "Language of description",
  description_language_help:
    "The language this record is written in, as a three-letter code, e.g. spa.",
  "field.catalogueLicenceUri": "Catalogue licence URI",
  catalogue_licence_help:
    "The licence on this repository's descriptions. Its label is derived from the URI.",
  "field.homeOrder": "Home page order",
  home_order_help:
    "The position of this repository's card on the site's home page, in ascending order. Repositories without one come after the rest, sorted by name.",

  // Linked descriptions
  linked_descriptions: "Linked descriptions",
  no_linked_descriptions: "No linked descriptions",
  delete_blocked_inline:
    "Cannot delete: this repository has {{count}} linked descriptions",

  // Display metadata
  display_title_label: "Display title",
  display_title_helper:
    "Overrides name for frontend display. Leave blank to use name.",
  subtitle_label: "Subtitle (Spanish)",
  subtitle_en_label: "Subtitle (English)",
  subtitle_helper: "Shown below the title on the frontend",
  hero_image_url_label: "Hero image URL",
  hero_image_url_helper:
    "URL to header image (R2 bucket or external URL)",

  // Draft/changelog
  commit_note_placeholder: "Note about changes (optional)",
  autosave_saving: "Saving...",
  autosave_saved: "Draft saved",
  conflict_banner:
    "{{name}} has unsaved changes since {{time}}.",
  overwrite_confirm:
    "This record was modified by {{name}} at {{time}}. Do you want to overwrite?",
  overwrite_button: "Overwrite",
  overwrite_cancel: "Cancel",
} as const;

// @version v0.9.0
