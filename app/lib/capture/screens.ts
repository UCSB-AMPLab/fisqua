/**
 * Digitization Screens — States and Next Steps
 *
 * This module deals with how the Digitization screens (Volumes, and the
 * Capture QC queue) name where a volume stands. The capture link already
 * works out each volume's state as the Captua unit sees it
 * (`captureLinkState` in `status.ts`); these screens show the same state
 * to the people working on the volume, folded into the fewer states a
 * person needs: received, preparing review images, in capture QC,
 * retakes requested, approved, processing and published, plus the three
 * the module's design leaves out (a refused handover, a superseded one,
 * and a failed processing run), and one the screens add to the unit's
 * states: review images failed, when the holding delivery's review run
 * failed and nothing has been decided that would move the volume on.
 * It is pure, so the route loaders, the page components and the tests
 * share one mapping.
 *
 * `screenStateOf` maps a link state to a screen state:
 *
 *   - `received` (a handover still being registered) and `registered`
 *     (registered, no opening decided yet): received;
 *   - `preparing_review`, `in_capture_qc`, `retakes_requested` and
 *     `approved`: themselves;
 *   - `queued`, `running` and `review_pending` (the review of the
 *     processed output): processing;
 *   - `published`, `failed`, `refused` and `superseded`: themselves;
 *   - `unknown`: null, since no handover is known and the screens list
 *     only volumes a scanner handed over.
 *
 * `screenStateFor` applies the review run on top of that mapping. A
 * volume `registered` or `in_capture_qc` whose review run failed is
 * review images failed. A volume still `registered` in a federation with
 * no review-tiles bucket is in capture QC at once, since no review run
 * will come.
 *
 * `nextStepOf` names the one step a person can take next, only where the
 * app can take it. A volume whose review images failed is retried; a
 * registered volume of a federation with a review-tiles bucket whose
 * delivery has no review run yet (one registered from a file) has its
 * review images prepared. A received or in-review volume with no reviewer is
 * assigned one from the queue; with a reviewer, review continues in the
 * viewer. A volume with retakes requested whose holding delivery still
 * has undecided openings is on the queue (`queuedVolume`), so its next
 * step is review in the same way; once every opening is decided, it
 * waits for the scanner. Processing shows that it runs.
 * A published volume opens at its description.
 *
 * A refused handover is explained by its first problem's rule, never
 * by the problem's message, which is English written for the unit
 * (`refusalKey`).
 *
 * The queue holds the volumes waiting for capture review: registered and
 * undecided, preparing review images, or in capture QC (`inQueue`), and
 * a volume with retakes requested whose holding delivery still has
 * undecided openings (`queuedVolume`). The unit is asked for the retakes
 * as soon as an opening is rejected, and the volume stays on the queue
 * until every opening is decided; a volume whose openings are all
 * decided, or that waits for retakes only (every opening approved, or
 * none), is on Retakes and not on the queue.
 * `queueReadinessOf` says whether a queued volume can be reviewed now,
 * from its screen state: ready once it is in capture QC (its review
 * images are ready, or its federation has no review-tiles bucket);
 * preparing while its review run is open; not prepared while its
 * delivery has no review run; failed when its review run failed.
 * A volume with retakes requested has no such screen state, so
 * `queueReadinessFor` reads its readiness from its holding delivery's
 * review images in the same way (`reviewReadinessOf`).
 * `sortQueue` lists the ready volumes first, then those preparing, not
 * prepared and failed, keeping the order it was given within each group.
 * `waitingDays` counts whole days since a delivery was registered.
 *
 * @version v0.9.0
 */

import type { CaptureLinkState } from "../validation/enums";

/** The states the Volumes screen shows, in the order its filters list them. */
export const SCREEN_STATES = [
  "received",
  "preparing_review",
  "in_capture_qc",
  "retakes_requested",
  "approved",
  "processing",
  "published",
  "failed",
  "review_failed",
  "refused",
  "superseded",
] as const;
export type ScreenState = (typeof SCREEN_STATES)[number];

/** The states the module's design draws; the rest get a filter only while a volume is in them. */
export const DRAWN_SCREEN_STATES: readonly ScreenState[] = [
  "received",
  "preparing_review",
  "in_capture_qc",
  "retakes_requested",
  "approved",
  "processing",
  "published",
];

export function screenStateOf(state: CaptureLinkState): ScreenState | null {
  switch (state) {
    case "received":
    case "registered":
      return "received";
    case "preparing_review":
    case "in_capture_qc":
    case "retakes_requested":
    case "approved":
    case "published":
    case "failed":
    case "refused":
    case "superseded":
      return state;
    case "queued":
    case "running":
    case "review_pending":
      return "processing";
    case "unknown":
      return null;
  }
}

/**
 * Where the holding delivery's review run stands for the screens: none
 * yet, open, ready, failed, or `not_applicable` when the federation has
 * no review-tiles bucket.
 */
export type ReviewStep = "none" | "open" | "ready" | "failed" | "not_applicable";

/** The screen state, with the review run applied (module header). */
export function screenStateFor(state: CaptureLinkState, review: ReviewStep = "not_applicable"): ScreenState | null {
  if (review === "failed" && (state === "registered" || state === "in_capture_qc")) return "review_failed";
  if (review === "not_applicable" && state === "registered") return "in_capture_qc";
  return screenStateOf(state);
}

export type NextStep =
  | "prepare_review"
  | "retry_review"
  | "assign_reviewer"
  | "continue_review"
  | "review_opens"
  | "retakes_came_back"
  | "waiting_for_scanner"
  | "running"
  | "open_volume";

export interface NextStepInput {
  linkState: CaptureLinkState;
  /** Whether the volume has a pipeline volume a reviewer can be assigned to. */
  registered: boolean;
  hasReviewer: boolean;
  /** Whether an earlier handover of the volume was superseded by this one (a retake). */
  hasEarlierDelivery: boolean;
  /** The holding delivery's review run; absent counts as `not_applicable`. */
  review?: ReviewStep;
  /** The holding delivery's openings and how many are decided; absent counts as all decided. */
  openings?: number;
  decided?: number;
}

export function nextStepOf(v: NextStepInput): NextStep | null {
  const review = v.review ?? "not_applicable";
  if (v.registered && review === "failed" && (v.linkState === "registered" || v.linkState === "in_capture_qc")) {
    return "retry_review";
  }
  if (v.registered && review === "none" && v.linkState === "registered") return "prepare_review";
  switch (v.linkState) {
    case "registered":
    case "in_capture_qc":
      if (!v.registered) return null;
      return v.hasReviewer ? "continue_review" : "assign_reviewer";
    case "preparing_review":
      return v.hasEarlierDelivery ? "retakes_came_back" : "review_opens";
    case "retakes_requested":
      if (v.registered && (v.decided ?? 0) < (v.openings ?? 0)) {
        return v.hasReviewer ? "continue_review" : "assign_reviewer";
      }
      return "waiting_for_scanner";
    case "running":
      return "running";
    case "published":
      return "open_volume";
    default:
      return null;
  }
}

/** Link states of the volumes waiting for capture review. */
export const QUEUE_LINK_STATES: readonly CaptureLinkState[] = ["registered", "preparing_review", "in_capture_qc"];

export function inQueue(state: CaptureLinkState): boolean {
  return QUEUE_LINK_STATES.includes(state);
}

/**
 * Whether a volume is on the queue (module header): its link state is a
 * queue state, or it is `retakes_requested` while its holding delivery
 * still has undecided openings.
 */
export function queuedVolume(v: { linkState: CaptureLinkState; openings: number; decided: number }): boolean {
  return inQueue(v.linkState) || (v.linkState === "retakes_requested" && v.decided < v.openings);
}

/** Whether a queued volume can be reviewed now, in the order the queue lists them. */
export const QUEUE_READINESS = ["ready", "preparing", "not_prepared", "failed"] as const;
export type QueueReadiness = (typeof QUEUE_READINESS)[number];

/** A queued volume's readiness, from its screen state (module header). */
export function queueReadinessOf(state: ScreenState): QueueReadiness {
  switch (state) {
    case "in_capture_qc":
      return "ready";
    case "preparing_review":
      return "preparing";
    case "review_failed":
      return "failed";
    default:
      return "not_prepared";
  }
}

/** A volume's readiness from its holding delivery's review images alone. */
export function reviewReadinessOf(review: ReviewStep): QueueReadiness {
  switch (review) {
    case "ready":
    case "not_applicable":
      return "ready";
    case "open":
      return "preparing";
    case "failed":
      return "failed";
    default:
      return "not_prepared";
  }
}

/**
 * A queued volume's readiness (module header): from its review images
 * while it is `retakes_requested`, from its screen state otherwise.
 */
export function queueReadinessFor(v: {
  linkState: CaptureLinkState;
  state: ScreenState;
  reviewStep: ReviewStep;
}): QueueReadiness {
  return v.linkState === "retakes_requested" ? reviewReadinessOf(v.reviewStep) : queueReadinessOf(v.state);
}

/** The ready volumes first; the order given is kept within each readiness. */
export function sortQueue<T extends { readiness: QueueReadiness }>(rows: T[]): T[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => QUEUE_READINESS.indexOf(a.row.readiness) - QUEUE_READINESS.indexOf(b.row.readiness) || a.i - b.i)
    .map(({ row }) => row);
}

/**
 * The rules a refused handover can carry (the Captua exchange
 * contract's, and the registration's own), each shown as a translated
 * sentence under `capture:problem.<rule with underscores>`. Any other
 * rule is shown as `problem.unknown`, so a new rule never shows raw
 * English.
 */
export const REFUSAL_RULES: readonly string[] = [
  "malformed",
  "envelope",
  "version",
  "shape",
  "field-too-long",
  "volume-count",
  "transfer-root",
  "reference-code",
  "description",
  "not-handed-over",
  "run-started",
  "not-volume-run",
  "registered-otherwise",
  "pages",
  "no-pages",
  "stem",
  "sequence",
  "duplicate-record",
  "filename",
  "page-key",
  "object-key",
  "capture-key",
  "preview-key",
  "preview-missing",
  "roles",
  "object-missing",
  "missing-object",
  "calibration-object",
  "calibration-applies-from",
  "calibration-identity",
  "calibration-key",
  "rotate-deg",
  "missing-side",
  "already-registered",
  "id-reused",
  "too-large",
];

/** The locale key, in the capture namespace, of a refusal's rule. */
export function refusalKey(rule: string): string {
  return REFUSAL_RULES.includes(rule) ? `problem.${rule.replace(/-/g, "_")}` : "problem.unknown";
}

/** The characters of a pipeline error shown in a row; the whole text is in its title. */
export const PIPELINE_ERROR_CHARS = 200;

/** A pipeline error cut to `PIPELINE_ERROR_CHARS`, with an ellipsis when cut. */
export function shortError(message: string): string {
  const chars = Array.from(message);
  return chars.length > PIPELINE_ERROR_CHARS ? `${chars.slice(0, PIPELINE_ERROR_CHARS).join("")}\u2026` : message;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from `since` to `now`, never negative. */
export function waitingDays(since: number, now: number): number {
  return Math.max(0, Math.floor((now - since) / DAY_MS));
}

// @version v0.9.0
