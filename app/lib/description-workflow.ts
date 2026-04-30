/**
 * Description status workflow state machine (pure functions).
 *
 * Parallel to the segmentation workflow in workflow.ts but with per-entry
 * granularity and its own status set. No side effects -- server-side
 * transition execution lives separately.
 */

import type { WorkflowRole } from "./workflow";

export type DescriptionStatus =
  | "unassigned"
  | "assigned"
  | "in_progress"
  | "described"
  | "reviewed"
  | "approved"
  | "sent_back";

const DESC_TRANSITIONS: Record<
  WorkflowRole,
  Partial<Record<DescriptionStatus, DescriptionStatus[]>>
> = {
  cataloguer: {
    assigned: ["in_progress"],
    in_progress: ["described"],
    sent_back: ["in_progress"],
  },
  reviewer: {
    described: ["reviewed", "sent_back"],
  },
  lead: {
    unassigned: ["assigned"],
    assigned: ["in_progress", "described", "reviewed", "approved"],
    in_progress: ["assigned", "described", "reviewed", "approved"],
    described: ["in_progress", "reviewed", "approved", "sent_back"],
    reviewed: ["described", "approved", "sent_back"],
    approved: ["reviewed", "described"],
    sent_back: ["in_progress", "described"],
  },
};

/**
 * Get the list of valid target description statuses for a given current
 * status and role.
 */
export function getValidDescriptionTransitions(
  currentStatus: DescriptionStatus,
  role: WorkflowRole
): DescriptionStatus[] {
  return DESC_TRANSITIONS[role]?.[currentStatus] ?? [];
}

/**
 * Check whether a specific description status transition is valid for a
 * given role.
 */
export function canDescriptionTransition(
  currentStatus: DescriptionStatus,
  targetStatus: DescriptionStatus,
  role: WorkflowRole
): boolean {
  return getValidDescriptionTransitions(currentStatus, role).includes(targetStatus);
}

/**
 * Description status styles -- distinct colour palette from segmentation.
 * Each status maps to Tailwind bg and text classes using Figma design tokens.
 */
export const DESCRIPTION_STATUS_STYLES: Record<
  DescriptionStatus,
  { bg: string; text: string }
> = {
  unassigned: { bg: "bg-[#E7E5E4]", text: "text-[#78716C]" },
  assigned: { bg: "bg-[#DDE3EE]", text: "text-[#1F2E4D]" },
  in_progress: { bg: "bg-[#F5E6C7]", text: "text-[#8B5E14]" },
  described: { bg: "bg-[#E1ECDF]", text: "text-[#3E5C45]" },
  reviewed: { bg: "bg-[#DCEAE6]", text: "text-[#3E7A6E]" },
  approved: { bg: "bg-[#DCEAE6]", text: "text-[#3E7A6E]" },
  sent_back: { bg: "bg-[#DDE3EE]", text: "text-[#1F2E4D]" },
};

/**
 * i18n label keys for description statuses. Use with t(`description:status.${key}`).
 */
export const DESCRIPTION_STATUS_LABELS: Record<DescriptionStatus, string> = {
  unassigned: "status.unassigned",
  assigned: "status.assigned",
  in_progress: "status.in_progress",
  described: "status.described",
  reviewed: "status.reviewed",
  approved: "status.approved",
  sent_back: "status.sent_back",
};
