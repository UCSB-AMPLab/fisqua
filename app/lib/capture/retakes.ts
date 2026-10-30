/**
 * Capture QC — Where a Retake Stands
 *
 * This module deals with the one question the Retakes screen answers
 * for each opening rejected in capture QC: how far its retake has got.
 * Fisqua keeps no such state; it follows from the decisions of the
 * volume's deliveries, from whether a newer delivery brought the opening
 * back with new images, and from the decision sets the unit has fetched
 * (`capture_qc_fetches`). `retakeStateOf` is the pure function that
 * reads it, so the loader and the tests share one rule.
 *
 * A rejection reaches the unit at its next fetch of the decisions; there
 * is no step that sends it. The rejection that counts is the opening's
 * decision in the current delivery, or, when the current delivery has
 * not decided it, the latest earlier delivery's decision on it. Then:
 *
 *   - the opening is not among the current delivery's openings, and the
 *     latest earlier decision rejected it: `missing`;
 *   - the rejection is the current delivery's, or an earlier delivery's
 *     whose images the current delivery brought back unchanged (the same
 *     capture ids, roles, sha256 digests and rotations, so not shot or
 *     turned again):
 *     `requested` until a fetch of the delivery that made it carries it,
 *     then `sent`, from the first such fetch;
 *   - the rejection is an earlier delivery's and the current delivery
 *     brought the opening back with new images: `replaced`, until it is
 *     decided there;
 *   - anything else (approved in the current delivery, never rejected,
 *     or approved by the latest earlier decision): not a retake.
 *
 * A fetch carries a rejection when the set it answered was at the
 * rejection's revision or later. Each write to a set raises its revision
 * inside the write's own batch, and stamps the decisions it writes with
 * that revision (`set_revision`), so revisions follow the order in which
 * writes commit. The clock does not: two writes read it before their
 * batches, and the later reading can commit first. A rejection changed
 * after a fetch (another reason, a new note) carries a later revision and
 * is requested again until the unit fetches it.
 *
 * @version v0.8.0
 */

export const RETAKE_STATES = ["requested", "sent", "replaced", "missing"] as const;
export type RetakeState = (typeof RETAKE_STATES)[number];

/** The states of a retake's way through, in order; `missing` stands apart. */
export const RETAKE_FLOW: readonly RetakeState[] = ["requested", "sent", "replaced"];

/** One fetch of a delivery's decision set by the unit. */
export interface DecisionFetch {
  /** The set's revision as the unit read it. */
  setRevision: number;
  firstFetchedAt: number;
}

export interface RetakeDecision {
  decision: "approved" | "rejected";
  /** The set revision of the write that last wrote the decision. */
  setRevision: number;
}

export interface RetakeInput {
  /** Whether the opening is among the current delivery's openings. */
  inCurrent: boolean;
  /** The opening's decision in the current delivery, if any. */
  current: RetakeDecision | null;
  /** The current delivery's fetches. */
  currentFetches: DecisionFetch[];
  /** The decision of the latest earlier delivery that decided the opening, if any. */
  earlier:
    | (RetakeDecision & {
        /** Whether the current delivery brought the opening's images back unchanged. */
        sameImages: boolean;
        /** That earlier delivery's fetches. */
        fetches: DecisionFetch[];
      })
    | null;
}

export interface RetakeStanding {
  state: RetakeState;
  /** When the unit first fetched the rejection; set only for `sent`. */
  sentAt: number | null;
  /** Whether the rejection is an earlier delivery's rather than the current one's. */
  fromEarlier: boolean;
}

/** When the unit first fetched a set carrying a decision written at `setRevision`, or null. */
export function sentAt(setRevision: number, fetches: DecisionFetch[]): number | null {
  let first: number | null = null;
  for (const f of fetches) {
    if (f.setRevision >= setRevision && (first === null || f.firstFetchedAt < first)) first = f.firstFetchedAt;
  }
  return first;
}

function sending(revision: number, fetches: DecisionFetch[], fromEarlier: boolean): RetakeStanding {
  const at = sentAt(revision, fetches);
  return at === null ? { state: "requested", sentAt: null, fromEarlier } : { state: "sent", sentAt: at, fromEarlier };
}

export function retakeStateOf(input: RetakeInput): RetakeStanding | null {
  const { current, earlier } = input;
  if (!input.inCurrent) {
    return earlier?.decision === "rejected" ? { state: "missing", sentAt: null, fromEarlier: true } : null;
  }
  if (current !== null) {
    return current.decision === "rejected" ? sending(current.setRevision, input.currentFetches, false) : null;
  }
  if (earlier?.decision !== "rejected") return null;
  if (earlier.sameImages) return sending(earlier.setRevision, earlier.fetches, true);
  return { state: "replaced", sentAt: null, fromEarlier: true };
}

// @version v0.8.0
