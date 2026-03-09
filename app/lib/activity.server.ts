import { eq, desc } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { activityLog } from "../db/schema";

/**
 * Get recent activity log entries for a user.
 */
export async function getActivityForUser(
  db: DrizzleD1Database<any>,
  userId: string,
  limit = 50
) {
  return db
    .select()
    .from(activityLog)
    .where(eq(activityLog.userId, userId))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit)
    .all();
}

/**
 * Get activity log entries for a specific volume.
 */
export async function getActivityForVolume(
  db: DrizzleD1Database<any>,
  volumeId: string,
  limit = 50
) {
  return db
    .select()
    .from(activityLog)
    .where(eq(activityLog.volumeId, volumeId))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit)
    .all();
}

/**
 * Get activity log entries for a project.
 */
export async function getActivityForProject(
  db: DrizzleD1Database<any>,
  projectId: string,
  limit = 50
) {
  return db
    .select()
    .from(activityLog)
    .where(eq(activityLog.projectId, projectId))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit)
    .all();
}
