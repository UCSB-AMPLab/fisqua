import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { volumes, activityLog } from "../db/schema";
import {
  canTransition,
  type VolumeStatus,
  type WorkflowRole,
} from "./workflow";

export type ActivityEvent =
  | "login"
  | "volume_opened"
  | "status_changed"
  | "review_submitted"
  | "assignment_changed"
  | "description_status_changed"
  | "description_assignment_changed"
  | "resegmentation_flagged"
  | "comment_added"
  | "comment_edited"
  | "comment_deleted"
  | "comment_resolved"
  | "comment_unresolved"
  | "comment_region_moved"
  | "qc_flag_raised"
  | "qc_flag_resolved";

/**
 * Transition a volume's status after validating the transition is allowed.
 * Logs the status change as an activity event.
 *
 * @throws Response(400) if the transition is not valid for the given role
 */
export async function transitionVolumeStatus(
  db: DrizzleD1Database<any>,
  volumeId: string,
  targetStatus: VolumeStatus,
  userId: string,
  role: WorkflowRole,
  comment?: string
): Promise<void> {
  // Fetch current volume status
  const [volume] = await db
    .select({ status: volumes.status, projectId: volumes.projectId })
    .from(volumes)
    .where(eq(volumes.id, volumeId))
    .limit(1)
    .all();

  if (!volume) {
    throw new Response("Volume not found", { status: 404 });
  }

  const currentStatus = volume.status as VolumeStatus;

  if (!canTransition(currentStatus, targetStatus, role)) {
    throw new Response(
      `Invalid transition from ${currentStatus} to ${targetStatus} for role ${role}`,
      { status: 400 }
    );
  }

  const now = Date.now();

  // Update volume status and optionally set reviewComment (for sent_back)
  const updateData: Record<string, unknown> = {
    status: targetStatus,
    updatedAt: now,
  };

  if (targetStatus === "sent_back" && comment) {
    updateData.reviewComment = comment;
  } else if (targetStatus !== "sent_back") {
    // Clear reviewComment when moving away from sent_back
    updateData.reviewComment = null;
  }

  await db.update(volumes).set(updateData).where(eq(volumes.id, volumeId));

  // Log the status change
  await logActivity(db, userId, "status_changed", {
    projectId: volume.projectId,
    volumeId,
    detail: JSON.stringify({
      from: currentStatus,
      to: targetStatus,
      comment: comment ?? null,
    }),
  });
}

/**
 * Insert an activity log entry.
 */
export async function logActivity(
  db: DrizzleD1Database<any>,
  userId: string,
  event: ActivityEvent,
  options: {
    projectId?: string;
    volumeId?: string;
    detail?: string;
  } = {}
): Promise<void> {
  await db.insert(activityLog).values({
    id: crypto.randomUUID(),
    userId,
    event,
    projectId: options.projectId ?? null,
    volumeId: options.volumeId ?? null,
    detail: options.detail ?? null,
    createdAt: Date.now(),
  });
}
