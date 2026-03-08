// --- TEMPLATE INFRASTRUCTURE --- do not modify when extending

import { eq, and } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { projectMembers } from "../db/schema";
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
