/**
 * English translations — promote namespace
 *
 * @version v0.3.0
 */
export default {
  heading: {
    title: "Promote Entries",
  },
  volume: {
    heading: "Select a volume",
    empty: "No volumes have approved entries ready for promotion.",
  },
  table: {
    selectAll: "Select all",
    deselectAll: "Deselect all",
    col: {
      title: "Title",
      pages: "Pages",
      refCode: "Reference Code",
      status: "Status",
    },
    children: "{{count}} sub-entries",
  },
  refCode: {
    patternLabel: "Reference code pattern",
    prefixPlaceholder: "Prefix (e.g. d)",
    applyPattern: "Apply Pattern",
  },
  status: {
    alreadyPromoted: "Already promoted",
  },
  viewer: {
    noManifest: "No manifest available for this volume.",
  },
  action: {
    review: "Review Promotion",
    promote: "Promote {{count}} Entries",
    back: "Back to selection",
  },
  summary: {
    heading: "Promotion Summary",
    col: {
      fields: "Fields Mapped",
      parent: "Parent Description",
    },
  },
  toast: {
    success: "{{count}} entries promoted successfully.",
  },
  error: {
    noParent:
      "No matching parent description found for volume {{code}}. Import the volume description first.",
    generic:
      "Promotion failed. Please try again or contact an administrator.",
    noSelection: "Select at least one entry to promote.",
    duplicateRefCode: 'Reference code "{{code}}" already exists.',
  },
} as const;
