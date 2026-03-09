/**
 * Status workflow state machine (pure functions).
 *
 * Defines valid status transitions for each role. No side effects --
 * server-side transition execution lives in workflow.server.ts.
 */

export type VolumeStatus =
  | "unstarted"
  | "in_progress"
  | "segmented"
  | "sent_back"
  | "reviewed"
  | "approved";

export type WorkflowRole = "cataloguer" | "reviewer" | "lead";

const TRANSITIONS: Record<
  WorkflowRole,
  Partial<Record<VolumeStatus, VolumeStatus[]>>
> = {
  cataloguer: {
    unstarted: ["in_progress"],
    in_progress: ["segmented"],
    sent_back: ["in_progress"],
  },
  reviewer: {
    segmented: ["reviewed"],
    reviewed: ["approved", "sent_back"],
  },
  lead: {
    unstarted: ["in_progress", "segmented", "sent_back", "reviewed", "approved"],
    in_progress: ["unstarted", "segmented", "sent_back", "reviewed", "approved"],
    segmented: ["unstarted", "in_progress", "sent_back", "reviewed", "approved"],
    sent_back: ["unstarted", "in_progress", "segmented", "reviewed", "approved"],
    reviewed: ["unstarted", "in_progress", "segmented", "sent_back", "approved"],
    approved: ["unstarted", "in_progress", "segmented", "sent_back", "reviewed"],
  },
};

/**
 * Get the list of valid target statuses for a given current status and role.
 */
export function getValidTransitions(
  currentStatus: VolumeStatus,
  role: WorkflowRole
): VolumeStatus[] {
  return TRANSITIONS[role]?.[currentStatus] ?? [];
}

/**
 * Check whether a specific status transition is valid for a given role.
 */
export function canTransition(
  currentStatus: VolumeStatus,
  targetStatus: VolumeStatus,
  role: WorkflowRole
): boolean {
  return getValidTransitions(currentStatus, role).includes(targetStatus);
}
