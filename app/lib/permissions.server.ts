/**
 * Access-Control Helpers
 *
 * This module deals with the server-side permission checks that every
 * loader and action relies on to decide whether the current user may
 * see or mutate a given resource. The helpers come in two tiers.
 *
 * User-level guards -- `requireAdmin`, `requireCollabAdmin` -- operate
 * purely on the typed `User` object and throw a 403 `Response` if the
 * needed flag is missing. No DB read is needed. These are used at the
 * top of loaders that gate a whole surface (the entities admin, the
 * project-management pages) where the decision depends only on who the
 * caller is, not on which resource they asked for.
 *
 * Resource-scoped guards -- `requireProjectRole`, `requireEntryAccess`,
 * `requirePageAccess`, `requireDescriptionAccess` -- resolve a given
 * record back to its owning project and then check the caller's
 * membership roles in that project. These are the helpers that stop
 * cross-project tampering from reaching the API surface: a member of
 * project A cannot comment or flag things in project B, regardless of
 * what identifiers they send in the request body.
 *
 * Every resource-scoped guard takes the REQUEST tenant id as its
 * second argument -- `context.get(tenantContext).id`, never
 * `user.tenantId`. Under a federation grant the two routinely differ:
 * a steward's user row still names their home tenant while the request
 * is served on the member tenant's host. `project_members` carries no
 * `tenant_id` of its own, so a membership join can never answer the
 * tenant question; the guards reach the tenant through the owning
 * `projects` row and refuse anything that does not belong to the
 * request tenant.
 *
 * `requireEntryAccess` and `requirePageAccess` are deliberately
 * symmetric. One resolves an entry back to its volume and project; the
 * other resolves a page. Both delegate the final cataloguer / reviewer
 * / lead membership check to `requireProjectRole` so the same role
 * semantics apply whichever resource kind is targeted.
 *
 * Three helpers -- `requireVolumeAccess`, `canDescribe`,
 * `canReviewDescription` -- are pure. They take pre-fetched rows and
 * return the computed access level or boolean. Callers use them both
 * to paint UI (disable a button when the user cannot write) and on the
 * server to gate writes before they hit D1.
 *
 * Role-assignment scope -- `canManageTenantUsers`, `canReachUsersArea`,
 * `assignableRoleFlags`, `canAssignTenantRoles`,
 * `unassignableSubmittedRoleFlags`, `INVITE_ROLE_CHOICES` -- answers a
 * different question from the guards above: not "may this user reach
 * the resource" but "may this user hand out this ROLE". The ten role
 * flags split into tenant-scoped (assignable by a workspace admin, on
 * users of the request tenant) and super-admin-only. Both the form
 * rendering and the actions read the same helper, so the UI can never
 * offer a toggle the server will refuse, and a crafted form body that
 * adds a super-admin-only field is rejected rather than trusted.
 * `canGrantSteward` and `canGrantStaff` answer the same question for
 * the two federation roles: a steward is granted by a super admin at
 * home on the federation's lead workspace, and staff by a federation
 * steward or that same super admin.
 *
 * @version v0.8.0
 */

// --- TEMPLATE INFRASTRUCTURE --- do not modify when extending

import { eq, and } from "drizzle-orm";
import { PROJECT_ROLES } from "./validation/enums";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  federations,
  projects,
  projectMembers,
  entries,
  volumes,
  volumePages,
} from "../db/schema";
import type { DescriptionStatus } from "./description-workflow";
import type { Tenant, User } from "../context";
import { isFederationSteward } from "./federation.server";

/**
 * Throws a 403 Response if the user is not an admin.
 */
export function requireAdmin(user: User): void {
  if (!user.isAdmin) {
    throw new Response("Forbidden", { status: 403 });
  }
}

/**
 * Throws a 403 Response unless the user is a collaborative-cataloguing
 * admin, a tenant admin (`isAdmin`) or a super admin. This is the gate
 * on the cataloguing admin surface: All projects (creating projects)
 * and Team (project memberships). A tenant admin is admitted because
 * the workspace is theirs to run: they can create a project from the
 * dashboard, and Team is where it is staffed.
 *
 * The gate admits to the surface; it grants no role flag. Every flag
 * change goes through `assignableRoleFlags`, on the user detail page.
 */
export function requireCollabAdmin(user: User): void {
  const u = user as User & {
    isCollabAdmin?: boolean;
    isSuperAdmin?: boolean;
  };
  if (!u.isCollabAdmin && !u.isSuperAdmin && !u.isAdmin) {
    throw new Response("Forbidden", { status: 403 });
  }
}

/**
 * Checks that the project belongs to the request tenant AND that the
 * user holds one of the required roles on it. Returns the matching
 * membership rows.
 *
 * `tenantId` is the REQUEST tenant (`context.get(tenantContext).id`).
 * Callers must never pass `user.tenantId`: under a federation grant the
 * caller's home tenant is not the tenant being served.
 *
 * Two distinct failure modes, deliberately given different statuses:
 *
 * - The project does not exist, or belongs to another tenant -> 404.
 *   A 403 would confirm that the id names a real project somewhere on
 *   the platform, which is a disclosure in itself; from this tenant's
 *   point of view a foreign project simply does not exist.
 * - The project is ours but the caller lacks the role -> 403.
 *
 * The tenant assert runs BEFORE the `isAdmin` branch on purpose.
 * `isAdmin` skips the ROLE check, never the SCOPE check: role flags
 * arrive from the grant's effective member-tenant flags, so `isAdmin`
 * means "admin here, for this request" and confers nothing anywhere
 * else.
 */
export async function requireProjectRole(
  db: DrizzleD1Database<any>,
  tenantId: string,
  userId: string,
  projectId: string,
  requiredRoles: string[],
  isAdmin = false
): Promise<typeof projectMembers.$inferSelect[]> {
  const [project] = await db
    .select({ id: projects.id, tenantId: projects.tenantId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .all();

  if (!project || project.tenantId !== tenantId) {
    throw new Response("Not Found", { status: 404 });
  }

  const memberships = await db
    .select()
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId)
      )
    )
    .all();

  if (isAdmin) {
    // Tenant admins may manage any project of the request tenant, so
    // the role check is skipped — but the memberships still come back
    // (they may be empty) because callers derive workflow roles here.
    return memberships;
  }

  const hasRequiredRole = memberships.some((m) =>
    requiredRoles.includes(m.role)
  );

  if (!hasRequiredRole) {
    throw new Response("Forbidden", { status: 403 });
  }

  return memberships;
}

// --- EXTENSION POINT --- domain-specific access control below

// Role-precedence semantics live in the pure, client-safe state
// machine module (app/lib/workflow.ts); re-exported here so server
// code keeps one import site for role decisions.
export { WORKFLOW_ROLE_PRECEDENCE, highestProjectRole } from "./workflow";

// --- Role-assignment scope ---------------------------------------------
//
// Who may hand out which role flag. The ten flags on `users` are not
// one tier: two of them describe standing across the whole platform,
// and the other eight describe standing INSIDE one workspace -- the
// workspace admin, the Reader, the four area admins and the
// cataloguing pair. A workspace admin hands out the eight; only a super
// admin hands out the platform two. A federation steward's effective
// member-tenant flags include `isAdmin` but deliberately NOT
// `isSuperAdmin` (see `grantEffectiveRoleFlags`), so a steward
// onboarding a partner workspace gives its people their workspace roles
// and nothing beyond them.

/**
 * The cataloguing pair. Granted by a workspace admin or a super admin,
 * and written only while the workspace has crowdsourcing on.
 */
export const CATALOGUING_ROLE_FLAGS = ["isCollabAdmin", "isCataloguer"] as const;

/**
 * Roles a workspace admin may assign, on users of their own tenant.
 * Each describes standing inside one workspace and confers nothing
 * anywhere else on the platform.
 */
export const TENANT_SCOPED_ROLE_FLAGS = [
  "isAdmin",
  "isArchiveUser",
  "isRecordsAdmin",
  "isAuthoritiesAdmin",
  "isImportsAdmin",
  "isDigitizationAdmin",
  ...CATALOGUING_ROLE_FLAGS,
] as const;

/**
 * Roles that stay super-admin-only. `isSuperAdmin` is the flag that
 * hands out every other flag, and `isUserManager` reaches the whole
 * user-administration surface; a workspace admin who could set either
 * would be able to escalate themselves out of their own tenant.
 */
export const PLATFORM_SCOPED_ROLE_FLAGS = [
  "isSuperAdmin",
  "isUserManager",
] as const;

/** Every role flag on `users`. */
export const ROLE_FLAGS = [
  ...PLATFORM_SCOPED_ROLE_FLAGS,
  ...TENANT_SCOPED_ROLE_FLAGS,
] as const;

export type RoleFlag = (typeof ROLE_FLAGS)[number];

/** The role-flag subset of `User` the assignment helpers read. */
export type RoleAssigner = Pick<
  User,
  "isAdmin" | "isSuperAdmin" | "isUserManager"
>;

/**
 * Whether `user` may reach the tenant user-administration surface at
 * all -- the user directory and the per-user detail page. A tenant
 * admin belongs here because on a records-management tenant they are
 * the only person who can put a newly invited colleague to work; a
 * user manager because that is what the flag is for; a super admin
 * because they reach everything.
 *
 * The surface this admits to is already tenant-scoped end to end: both
 * loaders filter `users` by `context.get(tenantContext).id`, so
 * admitting a tenant admin exposes their own tenant's directory and
 * nothing else.
 */
export function canManageTenantUsers(user: RoleAssigner): boolean {
  return user.isSuperAdmin || user.isUserManager || user.isAdmin;
}

/**
 * Whether `user` may reach the users area of `tenant` at all: whoever
 * `canManageTenantUsers` admits, and a steward of the tenant's
 * federation (`isFederationSteward`), who grants and revokes staff. A
 * steward with no workspace flag reaches the list and the detail
 * page's Federation section and nothing else: the profile, the
 * workspace roles, the project memberships and the invitation stay
 * behind `canManageTenantUsers`.
 */
export async function canReachUsersArea(
  db: DrizzleD1Database<any>,
  user: User,
  tenant: Tenant,
): Promise<boolean> {
  return canManageTenantUsers(user) || (await isFederationSteward(db, user, tenant));
}

/**
 * The role flags `user` may assign to somebody else. This is the ONE
 * place the split is decided; the form-rendering code and the action
 * both read it, so the UI can never offer a toggle the action will
 * refuse.
 *
 * A super admin assigns everything. A workspace admin -- which a
 * federation steward's effective member-tenant flags include --
 * assigns the eight tenant-scoped roles and nothing else. Everyone
 * else, area admins and user managers included, assigns nothing.
 *
 * Note what is NOT consulted: the tenant the acting user's row names.
 * Scope of the TARGET is a separate question, enforced by the caller
 * against the REQUEST tenant from `tenantContext`; under a federation
 * grant the two differ, and the acting user's home tenant is never the
 * right answer. Nor is the workspace's capability: whether an area's
 * flag is written at all is the caller's filter, on top of this one.
 */
export function assignableRoleFlags(user: RoleAssigner): readonly RoleFlag[] {
  if (user.isSuperAdmin) return ROLE_FLAGS;
  if (user.isAdmin) return TENANT_SCOPED_ROLE_FLAGS;
  return [];
}

/**
 * Whether `user` may hand out the tenant-scoped roles -- the predicate
 * behind the invite-time role picker.
 */
export function canAssignTenantRoles(user: RoleAssigner): boolean {
  const assignable = assignableRoleFlags(user);
  return TENANT_SCOPED_ROLE_FLAGS.every((flag) => assignable.includes(flag));
}

/**
 * The role flags present in `formData` that `user` may NOT assign.
 *
 * The form is treated as hostile. A checkbox rendered `disabled` is
 * not submitted by the browser at all, and an unchecked one is not
 * submitted either; nor does the page post the shown value
 * (`shown_<flag>`) of a flag the caller cannot change -- so for an
 * actor who is not a super admin, a well-formed post NEVER carries
 * `isSuperAdmin` or `isUserManager`, in either form, as a key.
 * Presence of such a key is therefore not an unchecked box, it is a
 * crafted body, and the action refuses the whole submission rather
 * than silently dropping the field.
 */
export function unassignableSubmittedRoleFlags(
  user: RoleAssigner,
  formData: FormData,
): RoleFlag[] {
  const assignable = assignableRoleFlags(user);
  return ROLE_FLAGS.filter(
    (flag) =>
      !assignable.includes(flag) &&
      (formData.has(flag) || formData.has(`shown_${flag}`)),
  );
}

/**
 * Whether `user` may grant or revoke the `steward` role in `tenant`'s
 * federation, including turning a steward into staff: a super admin at
 * home on the federation's lead workspace, the request served on that
 * workspace. A super admin of another workspace, or one reaching the
 * lead through a grant, may not. The federation must be active, as for
 * `isFederationSteward`.
 */
export async function canGrantSteward(
  db: DrizzleD1Database<any>,
  user: User,
  tenant: Pick<Tenant, "id" | "federationId">,
): Promise<boolean> {
  if (!user.isSuperAdmin || user.tenantId !== tenant.id) return false;
  const fed = await db
    .select({ leadTenantId: federations.leadTenantId, status: federations.status })
    .from(federations)
    .where(eq(federations.id, tenant.federationId))
    .get();
  return !!fed && fed.status === "active" && fed.leadTenantId === tenant.id;
}

/**
 * Whether `user` may grant or revoke the `staff` role in `tenant`'s
 * federation: a steward of that federation (`isFederationSteward`, with
 * the request's effective flags), or whoever may grant stewards.
 */
export async function canGrantStaff(
  db: DrizzleD1Database<any>,
  user: User,
  tenant: Tenant,
): Promise<boolean> {
  return (
    (await isFederationSteward(db, user, tenant)) ||
    (await canGrantSteward(db, user, tenant))
  );
}

/**
 * The role a new account may be given at invite time, keyed by the
 * value the invite form posts. `null` is the "no role" choice, which
 * leaves every flag false.
 *
 * Only workspace roles appear: the workspace admin, the four area
 * admins and the Reader. `records_admin` names the records area's
 * admin; the workspace admin is `workspace_admin`. An area's value is
 * accepted only while the workspace has that area (`INVITE_ROLE_AREAS`).
 * A platform role is not offered to anyone at invite time --
 * promoting somebody to super admin or user manager is a deliberate
 * second step on the user detail page, not a side effect of sending an
 * email -- so any other value is an invalid request, whoever sent it.
 */
export const INVITE_ROLE_CHOICES: Readonly<
  Record<
    string,
    | "isAdmin"
    | "isRecordsAdmin"
    | "isAuthoritiesAdmin"
    | "isDigitizationAdmin"
    | "isImportsAdmin"
    | "isArchiveUser"
    | null
  >
> = {
  none: null,
  workspace_admin: "isAdmin",
  records_admin: "isRecordsAdmin",
  authorities_admin: "isAuthoritiesAdmin",
  digitization_admin: "isDigitizationAdmin",
  imports_admin: "isImportsAdmin",
  archive_user: "isArchiveUser",
};

/**
 * The tenant capability an invite value needs, for the values that
 * belong to an optional area of the workspace.
 */
export const INVITE_ROLE_AREAS: Readonly<
  Record<string, "authoritiesEnabled" | "digitizationEnabled" | "importsEnabled">
> = {
  authorities_admin: "authoritiesEnabled",
  digitization_admin: "digitizationEnabled",
  imports_admin: "importsEnabled",
};

/**
 * Determine the access level for a user on a specific volume.
 * Pure function — no DB query, takes pre-fetched volume data.
 *
 * Returns:
 * - "edit": user can modify boundaries and metadata
 * - "review": user can review and edit (reviewer role)
 * - "readonly": user can view but not modify
 */
export function requireVolumeAccess(
  userId: string,
  volume: {
    assignedTo: string | null;
    assignedReviewer: string | null;
    status: string;
  },
  userRole: string,
  isAdmin: boolean
): "edit" | "review" | "readonly" {
  if (isAdmin || userRole === "lead") return "edit";

  if (userRole === "cataloguer") {
    if (volume.assignedTo !== userId) return "readonly";
    if (["unstarted", "in_progress", "sent_back"].includes(volume.status)) {
      return "edit";
    }
    return "readonly";
  }

  if (userRole === "reviewer") {
    if (volume.assignedReviewer !== userId) return "readonly";
    if (["segmented", "reviewed"].includes(volume.status)) return "review";
    return "readonly";
  }

  return "readonly";
}

// --- Description-specific access control ---

/**
 * Load an entry, find its volume and project, check tenant and
 * membership. Returns { entry, volume, memberships } or throws
 * 403/404. All membership rows come back (a user can hold several
 * roles on one project); use highestProjectRole to derive an effective
 * role — never a single row, whose position carries no meaning.
 *
 * `entryId` is attacker-chosen, so the project it resolves to is the
 * only project that may be authorised against. Callers that also
 * receive a project id from the request must compare it against
 * `volume.projectId` themselves — this guard answers for the RESOLVED
 * project, never the claimed one.
 */
export async function requireEntryAccess(
  db: DrizzleD1Database<any>,
  tenantId: string,
  entryId: string,
  userId: string,
  isAdmin = false
): Promise<{
  entry: typeof entries.$inferSelect;
  volume: typeof volumes.$inferSelect;
  memberships: (typeof projectMembers.$inferSelect)[];
}> {
  const [entry] = await db
    .select()
    .from(entries)
    .where(eq(entries.id, entryId))
    .limit(1)
    .all();

  if (!entry) {
    throw new Response("Entry not found", { status: 404 });
  }

  const [volume] = await db
    .select()
    .from(volumes)
    .where(eq(volumes.id, entry.volumeId))
    .limit(1)
    .all();

  if (!volume) {
    throw new Response("Volume not found", { status: 404 });
  }

  const memberships = await requireProjectRole(
    db,
    tenantId,
    userId,
    volume.projectId,
    [...PROJECT_ROLES],
    isAdmin
  );

  return { entry, volume, memberships };
}

/**
 * Like requireEntryAccess but also checks that the user is the assigned
 * describer, assigned reviewer, or a lead. Tenant scope is enforced by
 * the delegated requireEntryAccess call.
 */
export async function requireDescriptionAccess(
  db: DrizzleD1Database<any>,
  tenantId: string,
  entryId: string,
  userId: string,
  isAdmin = false
): Promise<{
  entry: typeof entries.$inferSelect;
  volume: typeof volumes.$inferSelect;
  memberships: (typeof projectMembers.$inferSelect)[];
}> {
  const { entry, volume, memberships } = await requireEntryAccess(
    db,
    tenantId,
    entryId,
    userId,
    isAdmin
  );

  if (isAdmin) return { entry, volume, memberships };

  // Any lead membership counts — a lead holding a second role must not
  // lose lead access to whichever row the DB returns first.
  const isLead = memberships.some((m) => m.role === "lead");
  const isAssignedDescriber = entry.assignedDescriber === userId;
  const isAssignedReviewer = entry.assignedDescriptionReviewer === userId;

  if (!isLead && !isAssignedDescriber && !isAssignedReviewer) {
    throw new Response(
      "You must be the assigned describer, reviewer, or a lead",
      { status: 403 }
    );
  }

  return { entry, volume, memberships };
}

/**
 * Check if a user can edit description fields for an entry.
 * Must be assigned describer or lead, and entry must be in an editable status.
 */
export function canDescribe(
  member: { role: string; userId: string },
  entry: {
    assignedDescriber: string | null;
    descriptionStatus: string | null;
  }
): boolean {
  const role = member.role;
  const editableStatuses = ["assigned", "in_progress", "sent_back"];
  const statusOk = editableStatuses.includes(entry.descriptionStatus ?? "");

  if (role === "lead") return statusOk;
  if (
    role === "cataloguer" &&
    entry.assignedDescriber === member.userId &&
    statusOk
  ) {
    return true;
  }
  return false;
}

/**
 * Check if a user can review a description.
 * Must be assigned reviewer or lead, and entry must be in "described" status.
 */
export function canReviewDescription(
  member: { role: string; userId: string },
  entry: {
    assignedDescriptionReviewer: string | null;
    descriptionStatus: string | null;
  }
): boolean {
  if (entry.descriptionStatus !== "described") return false;

  const role = member.role;
  if (role === "lead") return true;
  if (
    role === "reviewer" &&
    entry.assignedDescriptionReviewer === member.userId
  ) {
    return true;
  }
  return false;
}

/**
 * Load a page, find its volume and project, check membership.
 *
 * Mirrors `requireEntryAccess` but keyed to a `volume_pages.id` rather
 * than an `entries.id`. Any of lead / cataloguer / reviewer on the
 * parent project may view or mutate the page; the caller is free to
 * narrow further — for example, the QC-flag resolve action separately
 * enforces lead-only via `requireProjectRole`.
 *
 * Returns the minimal page and volume records needed by callers to
 * cross-check a client-supplied `volumeId` against the server-derived
 * `volume.id`. Throws a 404 Response if the page or its volume is
 * missing or the resolved project belongs to another tenant, and a 403
 * Response (via `requireProjectRole`) if the user is not a member of
 * the project.
 */
export async function requirePageAccess(
  db: DrizzleD1Database<any>,
  tenantId: string,
  pageId: string,
  userId: string,
  isAdmin = false
): Promise<{
  volume: { id: string; projectId: string };
  page: { id: string; volumeId: string; position: number };
}> {
  const [page] = await db
    .select({
      id: volumePages.id,
      volumeId: volumePages.volumeId,
      position: volumePages.position,
    })
    .from(volumePages)
    .where(eq(volumePages.id, pageId))
    .limit(1)
    .all();

  if (!page) {
    throw new Response("Page not found", { status: 404 });
  }

  const [volume] = await db
    .select({ id: volumes.id, projectId: volumes.projectId })
    .from(volumes)
    .where(eq(volumes.id, page.volumeId))
    .limit(1)
    .all();

  if (!volume) {
    throw new Response("Volume not found", { status: 404 });
  }

  await requireProjectRole(
    db,
    tenantId,
    userId,
    volume.projectId,
    [...PROJECT_ROLES],
    isAdmin
  );

  return { volume, page };
}

// @version v0.8.0
