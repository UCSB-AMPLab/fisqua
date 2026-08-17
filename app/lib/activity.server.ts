/**
 * Activity Feed Server Helpers
 *
 * This module deals with reading rows out of the `activity_log` table
 * for the three surfaces that render an activity feed: the per-user
 * dashboard, the per-volume side panel in the segmentation viewer, and
 * the per-project overview. Each helper is a thin Drizzle select that
 * scopes by the relevant foreign key (`userId`, `volumeId`, or
 * `projectId`), orders by `createdAt` descending so newest events
 * surface first, and caps the result with a caller-supplied `limit`
 * defaulting to fifty rows.
 *
 * Writes to `activity_log` live elsewhere — this module is read-only
 * and exists to keep the SELECT shapes in one testable place so the
 * three feeds stay consistent in ordering and column projection.
 *
 * Each helper takes the REQUEST tenant id first. The `userId`,
 * `volumeId` and `projectId` keys all arrive from the request, so
 * none of them bounds the read to the tenant being served; the
 * `tenant_id` column the rows carry does.
 *
 * @version v0.7.0
 */
import { and, eq, desc } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { activityLog } from "../db/schema";

/**
 * Get recent activity log entries for a user, within one tenant.
 *
 * `tenantId` is the REQUEST tenant. A user id alone spans every
 * tenant the account has ever worked in -- under a federation grant
 * that is routinely more than one -- so the trail is cut to the
 * tenant being served. `activity_log` carries its own `tenant_id`
 * (migration 0042), inherited from the volume or project the event
 * happened in, so no join is needed to reach it.
 */
export async function getActivityForUser(
  db: DrizzleD1Database<any>,
  tenantId: string,
  userId: string,
  limit = 50
) {
  return db
    .select()
    .from(activityLog)
    .where(
      and(
        eq(activityLog.tenantId, tenantId),
        eq(activityLog.userId, userId)
      )
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(limit)
    .all();
}

/**
 * Get activity log entries for a specific volume, within one tenant.
 * The volume id arrives from a request, so it does not establish
 * scope on its own.
 */
export async function getActivityForVolume(
  db: DrizzleD1Database<any>,
  tenantId: string,
  volumeId: string,
  limit = 50
) {
  return db
    .select()
    .from(activityLog)
    .where(
      and(
        eq(activityLog.tenantId, tenantId),
        eq(activityLog.volumeId, volumeId)
      )
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(limit)
    .all();
}

/**
 * Get activity log entries for a project, within one tenant. Same
 * reasoning as the volume feed: the project id is caller-supplied.
 */
export async function getActivityForProject(
  db: DrizzleD1Database<any>,
  tenantId: string,
  projectId: string,
  limit = 50
) {
  return db
    .select()
    .from(activityLog)
    .where(
      and(
        eq(activityLog.tenantId, tenantId),
        eq(activityLog.projectId, projectId)
      )
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(limit)
    .all();
}
