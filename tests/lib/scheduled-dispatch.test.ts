/**
 * Tests — which jobs a cron tick runs
 *
 * This suite pins `scheduledJobs` in `app/lib/scheduled-dispatch.ts`.
 * The Worker is invoked by two crons: the five-minute tick runs the
 * duplicate recheck and nothing else, and the fifteen-minute tick runs
 * the pipeline, review run and notification sweeps and nothing else. A
 * cron the Worker does not know runs no job, so a stray trigger cannot
 * start work by accident.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import {
  DUPLICATE_RECHECK_CRON,
  SWEEP_CRON,
  scheduledJobs,
} from "../../app/lib/scheduled-dispatch";

describe("scheduledJobs", () => {
  it("runs only the duplicate recheck on the five-minute cron", () => {
    expect(DUPLICATE_RECHECK_CRON).toBe("*/5 * * * *");
    expect(scheduledJobs(DUPLICATE_RECHECK_CRON)).toEqual(["duplicates"]);
  });

  it("runs only the sweeps on the fifteen-minute cron", () => {
    expect(SWEEP_CRON).toBe("*/15 * * * *");
    expect(scheduledJobs(SWEEP_CRON)).toEqual(["sweeps"]);
  });

  it("runs nothing on any other cron", () => {
    expect(scheduledJobs("0 * * * *")).toEqual([]);
    expect(scheduledJobs("")).toEqual([]);
  });
});

// @version v0.9.0
