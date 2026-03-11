export default {
  nav: {
    home: "Home",
    projects: "Projects",
    members: "Members",
    my_assignments: "My assignments",
    all_volumes: "All volumes",
    settings: "Settings",
    log_out: "Log out",
    admin: "Admin",
  },
  heading: {
    dashboard: "Home",
    recent_activity: "Recent activity",
    my_work: "My work",
  },
  group: {
    needs_review: "Needs review",
    in_progress: "In progress",
    ready_to_start: "Ready to start",
  },
  empty: {
    no_projects_title: "No projects yet",
    no_projects_body: "Create one to get started.",
    no_assignments_title: "No assignments",
    no_assignments_body: "Wait to be assigned a volume.",
    no_volumes_title: "No volumes yet",
    no_volumes_body: "Add an IIIF manifest to get started.",
  },
  today: "Today",
  days_waiting_one: "{{count}} day waiting",
  days_waiting_other: "{{count}} days waiting",
} as const;
