/**
 * Scheduled dispatch — which jobs a cron tick runs
 *
 * The Worker is woken by two crons declared in `wrangler.jsonc`, and each
 * runs its own work. The five-minute cron runs the duplicate recheck,
 * which brings the stored duplicate candidate pairs up to date after
 * records change. The fifteen-minute cron runs the sweeps: the media
 * pipeline sweep, the review run sweep and the notification sweep. A tick
 * runs the jobs of its own cron only, so the recheck does not wait on the
 * sweeps and the sweeps do not repeat every five minutes. Staging
 * declares the recheck cron alone, so the sweeps never run there.
 *
 * This module holds the two cron strings and the mapping from a cron to
 * its jobs. It imports nothing; `workers/app.ts` calls the jobs. A cron
 * the Worker does not know maps to no jobs.
 *
 * @version v0.9.0
 */

export const DUPLICATE_RECHECK_CRON = "*/5 * * * *";
export const SWEEP_CRON = "*/15 * * * *";

export type ScheduledJob = "duplicates" | "sweeps";

export function scheduledJobs(cron: string): ScheduledJob[] {
  if (cron === DUPLICATE_RECHECK_CRON) return ["duplicates"];
  if (cron === SWEEP_CRON) return ["sweeps"];
  return [];
}

// @version v0.9.0
