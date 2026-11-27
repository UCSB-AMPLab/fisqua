/**
 * Digitization Queue — States and Levels
 *
 * This module deals with the parts of the digitization queue that need
 * no database: the states an entry can be in, how each is read, and how
 * a description's level is named in the contract's `containerPath`. It
 * is pure, so the queue screen, the unit endpoints and the tests share
 * one mapping.
 *
 * An entry's state is read, never set by hand (`queueStateOf`):
 *
 *   - `retakes_requested` while the volume has retakes outstanding,
 *     whatever else holds;
 *   - otherwise, from the handover of its reference code, as the
 *     Volumes screen derives it (`handoverQueueState`), when that
 *     handover was received at or after the entry was added: received,
 *     preparing review images or review images failed read as
 *     `captured`; in capture QC as `in_review`; retakes requested as
 *     `retakes_requested`; approved, processing, published and a failed
 *     run as `approved`. A refused or superseded handover counts as none.
 *     A handover from before the entry was added belongs to an earlier
 *     capture, so a volume queued again for a rescan reads as queued
 *     until the new capture is handed over;
 *   - otherwise `skipped` when the unit's latest acknowledgement skipped
 *     it, `on_unit` when the unit applied it, and `queued` before either.
 *
 * `containerLevelOf` maps a description level to the contract's
 * `containerPath` levels: fonds, series and volume as themselves, a file
 * (Unidad documental compuesta) as `folder`, and every other level as
 * `other`.
 *
 * @version v0.9.0
 */

import type { ScreenState } from "./screens";

/** The states the queue screen shows, in the order its filter lists them. */
export const QUEUE_STATES = [
  "queued",
  "on_unit",
  "captured",
  "in_review",
  "retakes_requested",
  "approved",
  "skipped",
] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

/** The queue state a handover's screen state stands for, or null for none. */
export function handoverQueueState(state: ScreenState): QueueState | null {
  switch (state) {
    case "received":
    case "preparing_review":
    case "review_failed":
      return "captured";
    case "in_capture_qc":
      return "in_review";
    case "retakes_requested":
      return "retakes_requested";
    case "approved":
    case "processing":
    case "published":
    case "failed":
      return "approved";
    case "refused":
    case "superseded":
      return null;
  }
}

export interface QueueStateInput {
  addedAt: number;
  appliedAt: number | null;
  skippedAt: number | null;
  /** Whether the volume has retakes outstanding. */
  retakes: boolean;
  /** The reference code's handover, as the Volumes screen reads it. */
  handover: { state: ScreenState; receivedAt: number } | null;
}

export function queueStateOf(e: QueueStateInput): QueueState {
  if (e.retakes) return "retakes_requested";
  if (e.handover && e.handover.receivedAt >= e.addedAt) {
    const fromHandover = handoverQueueState(e.handover.state);
    if (fromHandover) return fromHandover;
  }
  if (e.skippedAt !== null && (e.appliedAt === null || e.skippedAt >= e.appliedAt)) return "skipped";
  if (e.appliedAt !== null) return "on_unit";
  return "queued";
}

export const CONTAINER_LEVELS = ["fonds", "series", "box", "folder", "volume", "other"] as const;
export type ContainerLevel = (typeof CONTAINER_LEVELS)[number];

export function containerLevelOf(level: string): ContainerLevel {
  switch (level) {
    case "fonds":
    case "series":
    case "volume":
      return level;
    case "file":
      return "folder";
    default:
      return "other";
  }
}

/**
 * The reasons a unit gives for skipping a queue item (`skipped[].reason`
 * in the queue acknowledgement). The queue screen names each in words;
 * a reason outside this list is shown as the unit sent it.
 */
export const SKIP_REASONS = [
  "item_not_an_object", "missing_reference_code", "invalid_reference_code",
  "reference_code_padded", "reference_code_duplicated_in_list", "missing_filename_stem",
  "filename_stem_not_a_slug", "filename_stem_too_long", "filename_stem_differs_from_reference_code",
  "filename_stem_duplicated_in_list", "missing_title", "invalid_title",
  "invalid_dates", "end_date_before_start", "invalid_sequence",
  "invalid_assignee", "invalid_retakes", "reference_code_on_unit",
  "filename_stem_on_unit", "filename_stem_is_project_directory", "filename_stem_directory_occupied",
  "filename_stem_held_offsite", "kept_on_unit", "withdrawn_not_on_unit",
  "list_name_refused", "mode_changed", "refused_by_database",
  "reference_code_reserved", "filename_stem_reserved", "title_reserved",
  "testing_space_refused",
] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

/** The reason as a known code, or null when the unit sent something else. */
export function knownSkipReason(reason: string): SkipReason | null {
  return (SKIP_REASONS as readonly string[]).includes(reason) ? (reason as SkipReason) : null;
}

// @version v0.9.0
