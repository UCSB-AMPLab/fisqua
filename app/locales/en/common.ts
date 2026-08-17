/**
 * English translations — common namespace
 *
 * This locale namespace carries the cross-cutting English strings
 * every other namespace builds on top of — the app brand name and the
 * shared button vocabulary (Save, Cancel, Create, Delete, Apply,
 * Clear). i18next loads it as the default namespace, so bare keys
 * like `t("button.save")` resolve here without an explicit prefix.
 *
 * @version v0.7.0
 */
export default {
  app_name: "Fisqua",
  button: {
    save: "Save",
    cancel: "Cancel",
    create: "Create",
    delete: "Delete",
    apply: "Apply",
    clear: "Clear",
  },
  label: {
    loading: "Loading...",
    search: "Search",
    actions: "Actions",
    name: "Name",
    email: "Email",
    role: "Role",
    status: "Status",
    none: "None",
    yes: "Yes",
    no: "No",
    back: "Back",
    close: "Close",
    confirm: "Confirm",
    edit: "Edit",
    details: "Details",
  },
  collapse: "Collapse",
  expand: "Expand",
  field_required: "This field is required",
  aria: {
    breadcrumb: "Breadcrumb",
    main_navigation: "Main navigation",
  },
  help: {
    openDocs: "Open the guide for this screen",
  },
  // Shared save-feedback vocabulary for the admin forms. `saved` and
  // `failed` are the fallbacks the banner uses when an action reports
  // its outcome without a message of its own; `saving` is the busy
  // label the submit button swaps to while a submission is in flight.
  save: {
    saved: "Changes saved",
    saving: "Saving...",
    failed: "Changes were not saved",
  },
  domain: {
    document_count_one: "{{count}} document",
    document_count_other: "{{count}} documents",
    image_count_one: "{{count}} image",
    image_count_other: "{{count}} images",
    volume_count_one: "{{count}} volume",
    volume_count_other: "{{count}} volumes",
    volume_count_full_one: "{{count}} volume",
    volume_count_full_other: "{{count}} volumes",
  },
  error: {
    generic_title: "Something went wrong",
    generic_detail: "An unexpected error occurred.",
    // 404 copy deliberately covers both the nonexistent and the
    // cross-tenant case (foreign resources answer 404 by design) —
    // it must never imply the thing exists somewhere else.
    not_found_title: "Nothing at this address",
    not_found:
      "There's no page at this address in this workspace. Check the address, or go back to the workspace and carry on from there.",
    forbidden_title: "You don't have access to this",
    forbidden:
      "Your role in this workspace doesn't allow this action. If you need it, ask a workspace administrator.",
    server_error_title: "Something went wrong on our side",
    server_error:
      "The request didn't complete. Try again — and if it keeps failing, tell a workspace administrator what you were doing and when.",
    back_home: "Back to the workspace",
    try_again: "Try again",
  },
  pagination: {
    previous: "Previous",
    next: "Next",
    previous_page: "Previous page",
    next_page: "Next page",
    page_of: "Page {{current}} of {{total}}",
    // `label` carries the already-pluralised entity noun, so both
    // plural forms share one shape.
    showing_one: "Showing {{count}} {{label}}",
    showing_other: "Showing {{count}} {{label}}",
  },
} as const;
