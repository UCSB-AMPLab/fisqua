// --- TEMPLATE INFRASTRUCTURE --- do not modify when extending

import { eq, and } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { projectMembers, entries, volumes } from "../db/schema";
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
 * Checks that the user has one of the required roles on the given project.
 * Admins bypass role checks entirely.
 * Returns the matching membership rows.
 * Throws 403 if no matching role found.
 */
export async function requireProjectRole(
  db: DrizzleD1Database<any>,
  userId: string,
  projectId: string,
  requiredRoles: string[],
  isAdmin = false
): Promise<typeof projectMembers.$inferSelect[]> {
  if (isAdmin) {
    // Admins bypass -- return any existing memberships (may be empty)
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
    return memberships;
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

  const hasRequiredRole = memberships.some((m) =>
    requiredRoles.includes(m.role)
  );

  if (!hasRequiredRole) {
    throw new Response("Forbidden", { status: 403 });
  }

  return memberships;
}

// --- EXTENSION POINT --- domain-specific access control below

/**
 * Determine the access level for a user on a specific volume.
 * Pure function -- no DB query, takes pre-fetched volume data.
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
 * Load an entry, find its volume and project, check membership.
 * Returns { entry, volume, member } or throws 403/404.
 */
export async function requireEntryAccess(
  db: DrizzleD1Database<any>,
  entryId: string,
  userId: string,
  isAdmin = false
): Promise<{
  entry: typeof entries.$inferSelect;
  volume: typeof volumes.$inferSelect;
  member: typeof projectMembers.$inferSelect;
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
    userId,
    volume.projectId,
    ["lead", "cataloguer", "reviewer"],
    isAdmin
  );

  return { entry, volume, member: memberships[0] };
}

/**
 * Like requireEntryAccess but also checks that the user is the assigned
 * describer, assigned reviewer, or a lead.
 */
export async function requireDescriptionAccess(
  db: DrizzleD1Database<any>,
  entryId: string,
  userId: string,
  isAdmin = false
): Promise<{
  entry: typeof entries.$inferSelect;
  volume: typeof volumes.$inferSelect;
  member: typeof projectMembers.$inferSelect;
}> {
  const { entry, volume, member } = await requireEntryAccess(
    db,
    entryId,
    userId,
    isAdmin
  );

  if (isAdmin) return { entry, volume, member };

  const role = member?.role;
  const isLead = role === "lead";
  const isAssignedDescriber = entry.assignedDescriber === userId;
  const isAssignedReviewer = entry.assignedDescriptionReviewer === userId;

  if (!isLead && !isAssignedDescriber && !isAssignedReviewer) {
    throw new Response(
      "You must be the assigned describer, reviewer, or a lead",
      { status: 403 }
    );
  }

  return { entry, volume, member };
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
