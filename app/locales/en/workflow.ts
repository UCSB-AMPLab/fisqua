export default {
  status: {
    unstarted: "Unstarted",
    in_progress: "In progress",
    segmented: "Segmented",
    sent_back: "Sent back",
    reviewed: "Reviewed",
    approved: "Approved",
  },
  action: {
    assign: "Assign",
    approve: "Approve",
    send_back: "Send back",
    submit_for_review: "Submit for review",
    accept_corrections: "Accept corrections",
    unassign: "Unassign",
  },
  role: {
    lead: "Lead",
    cataloguer: "Cataloguer",
    reviewer: "Reviewer",
  },
  bulk: {
    selected_one: "{{count}} volume selected",
    selected_other: "{{count}} volumes selected",
  },
  dropdown: {
    cataloguer_placeholder: "Cataloguer...",
    reviewer_placeholder: "Reviewer...",
    unassigned: "Unassigned",
  },
  dialog: {
    confirm_assign: "Assign volume",
    confirm_unassign: "Unassign volume",
    confirm_approve: "Approve volume",
    confirm_send_back: "Send back volume",
  },
} as const;
