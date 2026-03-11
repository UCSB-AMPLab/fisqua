export default {
  settings: {
    project_name: "Project name",
    manifest_url: "Manifest URL",
    email: "Email address",
    role: "Role",
  },
  action: {
    invite_member: "Invite member",
  },
  tab: {
    settings: "Settings",
    members: "Members",
    volumes: "Volumes",
  },
  table: {
    volume: "Volume",
    images: "Images",
    cataloguer: "Cataloguer",
    reviewer: "Reviewer",
    status: "Status",
    last_updated: "Last updated",
    entries: "Entries",
  },
  team: {
    heading: "Team progress",
    empty: "No team members assigned yet.",
    completed_of: "{{completed}} / {{total}} completed",
    entries: "entries",
  },
  empty: {
    no_volumes: "No volumes in this project yet.",
  },
  volume_card: {
    first_page_alt: "First page of {{name}}",
    delete_confirm: "Delete this volume? This cannot be undone.",
  },
} as const;
