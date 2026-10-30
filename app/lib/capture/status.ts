/**
 * Capture Link — A Volume's State, as the Unit Sees It
 *
 * This module deals with the one question the Captua link's status
 * call answers: where a volume a unit handed over has
 * got to. Fisqua does not keep that state anywhere as such; it follows
 * from three things it does keep, the volume's latest delivery, its
 * pipeline volume, and the latest run that named the volume, and
 * `captureLinkState` is the single pure function that reads it from
 * them. It reads rows already fetched and touches nothing.
 *
 * The rules, in order:
 *
 *   - no delivery and no pipeline volume: `unknown`;
 *   - a delivery `refused`, `superseded` or `received`: that state, at
 *     the time it was received (superseded: when it was replaced), with
 *     the delivery's problems;
 *   - a pipeline volume `published`: `published`;
 *   - one `prepared` or `ready`: `review_pending`, from when its run
 *     reported; the media pipeline's own review (flags, the recipe's
 *     gate) and the publish step are both still to come;
 *   - one still `received`, with a run that named it:
 *       - the run holds the volume (open, token unexpired) and the
 *         volume's job has not reported: `queued` while its dispatch
 *         chunk is pending or was never sent, `running` once the chunk
 *         has been dispatched (whether or not its result is known);
 *       - the volume's job reported `aborted` or `halted`: `failed`,
 *         with the error class as a problem;
 *       - the run does not hold the volume (it closed, or its token
 *         expired) and the volume's job never reported: `failed`;
 *       - the job reported `prepared` or `review_pending` while the
 *         volume is still `received` (the two writes are made together,
 *         so this is a race read mid-batch): `review_pending`;
 *   - one still `received` with no run: `preparing_review` while the
 *     holding delivery's review run is open, whatever its decisions (a
 *     retake's carried approvals included); otherwise
 *     `retakes_requested` when that delivery has a record `rejected` and
 *     nothing left to approve (`awaitingRetakes`, below); otherwise its
 *     capture QC state when that delivery has decisions (below); otherwise
 *     `in_capture_qc` once its review run has the tiles ready; otherwise
 *     `registered`. A review run that failed changes nothing here: the
 *     unit is told the capture QC state as if no review run had been
 *     tried, and the Volumes screen shows the failure.
 *
 * The states run, in order: `received`, `registered`, then capture QC
 * (`preparing_review`, `in_capture_qc`, `retakes_requested` or
 * `approved`), then processing (`queued`, `running`, `review_pending`
 * for the review of the processed output) and `published`. A volume
 * whose retakes come back is delivered again. Decisions belong to the
 * delivery they were made on, and the new delivery has only the
 * approvals carried over for the openings whose images it did not
 * change: with some, it is `in_capture_qc` (or `approved`, when every
 * opening came over); with none, it starts over at `registered`.
 *
 * Capture QC is supplied as `captureQc`, the state of the holding
 * delivery's decision set (`capture_qc_sets`): `in_capture_qc` while
 * some openings are decided and none rejected, `retakes_requested` once
 * any is rejected, `approved` once every one is approved, each from when
 * the set entered it. Once a run has named the volume, the processing
 * states take over whatever the decisions say. The holding delivery's
 * latest review run is supplied as `review` (`readLatestReviewRuns`).
 *
 * A record `rejected` in the holding delivery's manifest is an opening
 * with a retake the unit owes, whether Fisqua asked for it or the unit
 * marked it. It is not one of the delivery's openings, so the decision
 * set cannot show it, and it holds the volume from processing
 * (`hold.server.ts`). `awaitingRetakes` says when it decides the state:
 * the delivery has such a record (`rejectedRecords`) and every one of its
 * openings is approved, or it has none. The volume is then
 * `retakes_requested`, from when the set was approved, or from when the
 * delivery was received when it has no openings, and not `approved`.
 * While openings are still undecided or rejected, the decision set's
 * state stands, so a volume still under review stays in capture QC.
 *
 * `failed` is not final: Fisqua may run the volume again, and a new run
 * moves it back to `queued`. `problems` carries the delivery's problems
 * (why it was refused, or what its registration reported without
 * refusing it, such as an object in the bucket the manifest does not
 * name) in every state, and the pipeline's error when it failed.
 *
 * @version v0.8.0
 */

import type { CaptureDeliveryState, CaptureLinkState, CaptureQcState } from "../validation/enums";
import type { CaptureProblem } from "./manifest";

export interface StatusDelivery {
  id: string;
  state: CaptureDeliveryState;
  problems: CaptureProblem[];
  receivedAt: number;
  supersededAt: number | null;
  /** The delivery's openings, records `in_review` or `approved`. */
  openings: number;
  /** The delivery's records `rejected`, each a retake the unit owes. */
  rejectedRecords: number;
}

/**
 * The holding delivery waits for retakes and nothing else (module
 * header): it has a rejected record, and its openings are all approved
 * (`approvedAll`) or it has none. The Volumes screen and the capture QC
 * viewer ask it too.
 */
export function awaitingRetakes(
  delivery: Pick<StatusDelivery, "openings" | "rejectedRecords">,
  approvedAll: boolean,
): boolean {
  return delivery.rejectedRecords > 0 && (delivery.openings === 0 || approvedAll);
}

export interface StatusVolume {
  id: string;
  state: string;
  createdAt: number;
  updatedAt: number;
  heldByRunId: string | null;
}

/** The latest run that named the volume, with this volume's row in it. */
export interface StatusRun {
  runId: string;
  /** Whether the run still holds volumes: open and its token unexpired. */
  holds: boolean;
  createdAt: number;
  dispatchedAt: number | null;
  completedAt: number | null;
  /** The volume's run row. */
  volumeStatus: string;
  volumeReportedAt: number | null;
  /** The run volume's error class, if it recorded one. */
  volumeErrorClass: string | null;
  /** The volume's dispatch chunk. */
  chunkStatus: string | null;
  chunkDispatchedAt: number | null;
}

/**
 * Where the volume stands in capture QC: the state of the holding
 * delivery's decision set and when the set entered it, or null when no
 * opening of that delivery is decided.
 */
export interface StatusCaptureQc {
  state: CaptureQcState;
  enteredAt: number;
}

/** The holding delivery's latest review run, as `readLatestReviewRuns` weighs it. */
export interface StatusReview {
  state: "open" | "ready" | "failed";
  enteredAt: number;
}

export interface StatusInput {
  delivery: StatusDelivery | null;
  volume: StatusVolume | null;
  run: StatusRun | null;
  /** Null or absent while no opening of the holding delivery is decided. */
  captureQc?: StatusCaptureQc | null;
  /** Null or absent while the holding delivery has no review run. */
  review?: StatusReview | null;
}

export interface LinkState {
  state: CaptureLinkState;
  /** When the volume entered the state, in ms; null when nothing says. */
  enteredAt: number | null;
  problems: CaptureProblem[];
}

export function captureLinkState(input: StatusInput): LinkState {
  const { delivery, volume, run } = input;
  const notes = delivery?.problems ?? [];
  if (delivery === null && volume === null) return { state: "unknown", enteredAt: null, problems: [] };

  if (delivery !== null) {
    if (delivery.state === "refused") return { state: "refused", enteredAt: delivery.receivedAt, problems: notes };
    if (delivery.state === "superseded") {
      return { state: "superseded", enteredAt: delivery.supersededAt ?? delivery.receivedAt, problems: notes };
    }
    if (delivery.state === "received") return { state: "received", enteredAt: delivery.receivedAt, problems: notes };
  }
  if (volume === null) return { state: "unknown", enteredAt: null, problems: notes };

  if (volume.state === "published") return { state: "published", enteredAt: volume.updatedAt, problems: notes };
  if (volume.state === "prepared" || volume.state === "ready") {
    return { state: "review_pending", enteredAt: run?.volumeReportedAt ?? volume.updatedAt, problems: notes };
  }

  if (run !== null) {
    if (run.volumeStatus === "aborted" || run.volumeStatus === "halted") {
      return {
        state: "failed",
        enteredAt: run.volumeReportedAt ?? run.completedAt,
        problems: [...notes, pipelineProblem(run.volumeErrorClass)],
      };
    }
    if (run.volumeStatus === "prepared" || run.volumeStatus === "review_pending") {
      return { state: "review_pending", enteredAt: run.volumeReportedAt, problems: notes };
    }
    // The job has not reported.
    if (run.holds && volume.heldByRunId === run.runId) {
      if (run.chunkStatus === null || run.chunkStatus === "pending" || run.chunkStatus === "not_sent") {
        return { state: "queued", enteredAt: run.createdAt, problems: notes };
      }
      return { state: "running", enteredAt: run.chunkDispatchedAt ?? run.dispatchedAt ?? run.createdAt, problems: notes };
    }
    return {
      state: "failed",
      enteredAt: run.completedAt,
      problems: [...notes, pipelineProblem(run.volumeErrorClass ?? "unreported")],
    };
  }

  // Before processing: the review run while it is open, then the
  // decisions, then the review images being ready.
  if (input.review?.state === "open") {
    return { state: "preparing_review", enteredAt: input.review.enteredAt, problems: notes };
  }
  if (delivery?.state === "registered" && awaitingRetakes(delivery, input.captureQc?.state === "approved")) {
    const since = input.captureQc?.state === "approved" ? input.captureQc.enteredAt : delivery.receivedAt;
    return { state: "retakes_requested", enteredAt: since, problems: notes };
  }
  if (input.captureQc) return { state: input.captureQc.state, enteredAt: input.captureQc.enteredAt, problems: notes };
  if (input.review?.state === "ready") {
    return { state: "in_capture_qc", enteredAt: input.review.enteredAt, problems: notes };
  }

  return { state: "registered", enteredAt: delivery?.receivedAt ?? volume.createdAt, problems: notes };
}

function pipelineProblem(errorClass: string | null): CaptureProblem {
  const cls = errorClass ?? "internal";
  return {
    rule: "pipeline",
    message:
      cls === "unreported"
        ? "The media pipeline run ended without the volume reporting"
        : `The media pipeline stopped the volume (${cls})`,
    errorClass: cls,
  };
}

// @version v0.8.0
