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
 * @version v0.7.0
 */

// --- TEMPLATE INFRASTRUCTURE --- do not modify when extending

import { eq, and } from "drizzle-orm";
import { PROJECT_ROLES } from "./validation/enums";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  projects,
  projectMembers,
  entries,
  volumes,
  volumePages,
} from "../db/schema";
import type { DescriptionStatus } from "./description-workflow";
import type { User } from "../context";

/**
 * Throws a 403 Response if the user is not an admin.
 */
export function requireAdmin(user: User): void {
  if (!user.isAdmin) {
    throw new Response("Forbidden", { status: 403 });
  }
}

/**
 * Throws a 403 Response if the user is not a collaborative-cataloguing
 * admin or superadmin. Plain archive admins (`isAdmin` only) are
 * rejected here -- the archive-admin tier and the collab-admin tier
 * are intentionally walled off so that a user who curates archival
 * descriptions cannot automatically invite cataloguers or reassign
 * volumes.
 */
export function requireCollabAdmin(user: User): void {
  const u = user as User & {
    isCollabAdmin?: boolean;
    isSuperAdmin?: boolean;
  };
  if (!u.isCollabAdmin && !u.isSuperAdmin) {
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
