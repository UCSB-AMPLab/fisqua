/**
 * useRunPoll — a running export, kept current without a page reload
 *
 * A run is measured in seconds to minutes and lands in a row before
 * the work starts, so both the dialog and an in-progress history row
 * need the same thing: the row as it stands now. This hook is that,
 * and it is deliberately the imports pattern rather than a socket —
 * an interval and a fetcher against a tenant-scoped resource route,
 * which is what the rest of the app already does for work handed to
 * `waitUntil`.
 *
 * IT STOPS AS SOON AS THE RUN DOES. The interval is torn down the
 * moment the row reports anything but `running`, so a completed dialog
 * left open on a desk overnight is not still asking. It also never
 * starts for a row that arrived finished, which is every row but the
 * newest one on a typical history.
 *
 * The initial row wins until the first poll answers, so the hook is
 * safe to render server-side: the loader's row is the first paint and
 * the fetcher only ever replaces it with something newer.
 *
 * @version v0.7.0
 */
import { useEffect, useRef } from "react";
import { useFetcher } from "react-router";
import type { ExportRunView } from "~/lib/export/run.server";

/** How often a running row asks. Slow enough not to be a load, fast
 *  enough that a two-minute run visibly moves. */
const POLL_MS = 2500;

/**
 * How long is left, from what has happened so far. Honest rather than
 * clever: elapsed over done, extrapolated, and offered only once there
 * is enough of a run to extrapolate from and enough left to be worth
 * saying. Null means "say nothing" — a guess dressed as a number is
 * worse than silence on a page whose whole claim is exact counts.
 */
export function etaMinutes(run: ExportRunView, now: number): number | null {
  const done = run.progressDone ?? 0;
  const total = run.progressTotal ?? 0;
  if (done < 20 || total <= done) return null;
  const elapsed = now - run.startedAt;
  if (elapsed < 3000) return null;
  const remaining = ((total - done) * elapsed) / done;
  if (remaining < 45_000) return null;
  return Math.max(1, Math.round(remaining / 60_000));
}

export function useRunPoll(initial: ExportRunView): ExportRunView {
  const fetcher = useFetcher<{ run: ExportRunView | null }>();
  const live = fetcher.data?.run ?? initial;
  const running = live.status === "running";

  // `fetcher.load` is not a stable identity across renders, and an
  // effect that re-registered its interval on every render would fire
  // far more often than the interval says.
  const loadRef = useRef(fetcher.load);
  loadRef.current = fetcher.load;

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      loadRef.current(`/admin/exports/runs/${initial.id}`);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [running, initial.id]);

  return live;
}

/* @version v0.7.0 */
