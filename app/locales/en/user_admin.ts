/**
 * English translations — user_admin namespace
 *
 * This locale namespace carries the English strings for the
 * `/admin/users/*` surface: the list's summary line, search, area
 * filter, badge legend and the table of people from the federation;
 * the area names; the role labels and descriptions of the detail
 * page's sections (Platform, Federation, Records management,
 * Authorities, Cataloguing, Digitization, Imports and exports); the
 * project and reviewed-volume tables; the access history; and the
 * notices, tooltips, errors and confirmations of both pages.
 *
 * @version v0.8.0
 */
export default {
  people_count_one: "{{count}} person in this workspace",
  people_count_other: "{{count}} people in this workspace",
  federation_people_count: "{{number}} from {{federation}}",
  search_label: "Search by name or email",
  search_placeholder: "Name or email",
  area_label: "Area",
  area_all: "All areas",
  area_platform: "Platform",
  area_federation: "Federation",
  area_records: "Records management",
  area_authorities: "Authorities",
  area_cataloguing: "Cataloguing",
  area_digitization: "Digitization",
  area_imports: "Imports and exports",
  legend_area: "Area",
  legend_administers: "administers the area",
  legend_works: "works in the area",
  no_matches: "No one matches this search.",
  col_access: "Access",
  col_last_active: "Last active",
  no_access_yet: "No access yet",
  badge_reader: "Reader",
  federation_heading: "From {{federation}}",
  federation_intro:
    "Members of other workspaces in the federation who work here. Their profiles are managed in their own workspace.",
  col_home_workspace: "Home workspace",
  col_access_here: "Access here",
  federation_role_steward: "Federation steward",
  federation_role_staff: "Federation staff",
  reviews_volumes_one: "reviews {{count}} volume",
  reviews_volumes_other: "reviews {{count}} volumes",
  role_super_admin: "Super admin",
  role_user_manager: "User manager",
  role_steward: "Steward",
  role_staff: "Staff",
  role_workspace_admin: "Workspace admin",
  role_records_admin: "Records admin",
  role_archive_user: "Reader",
  role_authorities_admin: "Authorities admin",
  role_cataloguing_admin: "Cataloguing admin",
  role_cataloguer: "Cataloguer",
  role_digitization_admin: "Digitization admin",
  role_imports_admin: "Imports admin",
  super_admin_description:
    "Full access to all areas, including user management and system settings",
  user_manager_description:
    "Invite users, edit profiles, and assign them to projects",
  steward_description:
    "Granted by a super admin. Runs storage, the media pipeline, and shared authorities for the federation",
  staff_description:
    "Granted by a steward. Works across the federation's workspaces",
  workspace_admin_description:
    "Administer every area of this workspace, its projects, and its users",
  records_admin_description:
    "Manage descriptions, repositories, and vocabularies",
  archive_user_description: "Read-only access to this workspace's published records",
  authorities_admin_description:
    "Manage entities, places, and pending decisions",
  cataloguing_admin_description:
    "Manage projects, team members, and promote entries to descriptions",
  cataloguer_description:
    "Can be assigned to cataloguing projects and access the cataloguing area",
  digitization_admin_description:
    "Manage capture volumes, the scanner, and reviewer assignment",
  imports_admin_description:
    "Run imports into this workspace and download its machine-readable exports",
  scope_platform: "All workspaces",
  scope_workspace: "This workspace",
  last_active_on: "Last active {{date}}",
  never_active: "Never active",
  joined_on: "Joined {{date}}",
  section_profile: "Profile",
  section_access_history: "Access history",
  history_role_granted: "{{role}} granted by {{actor}}",
  history_role_revoked: "{{role}} revoked by {{actor}}",
  history_federation_granted: "Federation {{role}} granted by {{actor}}",
  history_federation_revoked: "Federation {{role}} revoked by {{actor}}",
  history_project_added: "Added to {{project}} as {{role}} by {{actor}}",
  history_project_changed: "Role in {{project}} changed to {{role}} by {{actor}}",
  history_project_removed: "Removed from {{project}} by {{actor}}",
  history_invited: "Invited as {{role}} by {{actor}}",
  history_invited_no_role: "Invited by {{actor}}",
  history_empty: "No changes to this person's access are recorded yet.",
  projects_heading: "Projects",
  col_project_role: "Project role",
  col_actions: "Actions",
  project_role_for: "Project role in {{project}}",
  col_volume_reviewed: "Volume reviewed",
  col_status: "Status",
  no_reviewed_volumes: "Not reviewing any volumes.",
  reviewers_assigned_note: "Reviewers are assigned on the Capture QC screen.",
  self_warning:
    "This is your own account. Role changes are disabled to prevent accidental self-demotion.",
  non_superadmin_notice: "Only a super admin or a workspace admin can change roles.",
  tenant_admin_roles_notice:
    "You can grant the roles for this workspace. Super admin and user manager can only be granted by a super admin.",
  self_role_badge_tooltip: "You cannot change your own roles",
  platform_role_tooltip: "Only a super admin can grant this role",
  workspace_role_tooltip: "Only a workspace admin can grant this role",
  steward_grant_tooltip:
    "Only a super admin of the federation's lead workspace can grant this role",
  staff_grant_tooltip: "Only a federation steward can grant this role",
  invite_role_label: "Initial role",
  invite_role_none: "No role",
  invite_role_hint:
    "Without a role, the new user signs in to an empty dashboard.",
  name_label: "Name",
  email_label: "Email",
  never: "Never",
  save_profile: "Save profile",
  save_roles: "Save roles",
  assign_to_project: "+ Assign to project",
  cancel: "Cancel",
  project_label: "Project",
  role_label: "Role",
  select_project: "Select project...",
  select_role: "Select role...",
  role_lead: "Lead",
  role_reviewer: "Reviewer",
  assign: "Assign",
  remove: "Remove",
  remove_confirm: "Remove from {{project}}?",
  no_memberships: "Not a member of any project",
  error_email_required: "Email is required",
  error_email_duplicate: "Another user already has this email",
  error_invalid_request: "Invalid request",
  error_cannot_change_own_roles: "You cannot change your own roles",
  error_role_not_assignable:
    "That request included a role you cannot grant. No roles were changed.",
  error_already_member: "Already a member of this project",
  error_roles_changed:
    "Someone changed this person's access after you opened the page. Reload the page and try again.",
  error_last_workspace_admin:
    "This workspace needs at least one workspace admin. Make someone else workspace admin first.",
  error_operator_no_grants: "Roles cannot be changed during an operator session.",
  error_forbidden: "Forbidden",
  success_profile_updated: "Profile updated",
  success_roles_updated: "Roles updated",
  success_assigned: "Assigned to project",
  success_role_updated: "Role updated",
  success_removed: "Removed from project",
} as const;

// @version v0.8.0
