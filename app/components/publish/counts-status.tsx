/**
 * Publish Counts Status
 *
 * This module holds what the publish page shows in the changelog's
 * place while the pre-flight counts are not there: a progress notice
 * while they load and a retry notice when they fail. The counts come
 * from `/admin/publish/counts` and take several seconds on the
 * federation lead; the rest of the page, the publish form included,
 * works meanwhile.
 *
 * The progress bar is indeterminate: `role="progressbar"` with no
 * value, named by the notice's title, inside a polite live region so
 * the title is announced once. The bar is a full-width indigo track
 * (indigo is the neutral progress dye) that pulses under
 * `motion-safe` and stays still under reduced motion, where the text
 * alone carries the state. The failure notice is neutral, not madder,
 * because madder is reserved for confirm dialogs and nothing here is
 * refused: publishing still works without the counts.
 *
 * `usePublishCounts` does the fetching. It uses `fetch` rather than a
 * React Router fetcher because a failed fetcher load renders the
 * route's error boundary in place of the page. It starts on mount,
 * aborts on unmount, and `retry` starts a new request.
 *
 * @version v0.9.0
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChangelogData } from "./changelog-section";

export type PublishCountsState =
  | { status: "loading" }
  | { status: "ready"; changelog: ChangelogData }
  | { status: "failed" };

/** Fetches the pre-flight counts once mounted; `enabled` false skips it. */
export function usePublishCounts(
  url: string,
  enabled: boolean,
): { state: PublishCountsState; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PublishCountsState>({ status: "loading" });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | { ok: true; changelog: ChangelogData }
          | { ok: false }
          | null;
        if (response.ok && body && body.ok) {
          setState({ status: "ready", changelog: body.changelog });
        } else {
          setState({ status: "failed" });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "failed" });
      });
    return () => controller.abort();
  }, [url, enabled, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}

export function CountsLoading() {
  const { t } = useTranslation("publish");
  return (
    <section
      aria-live="polite"
      className="rounded-lg border border-stone-200 px-4 py-4"
    >
      <p
        id="publish-counts-title"
        className="font-sans text-sm font-medium text-stone-700"
      >
        {t("counts.loadingTitle")}
      </p>
      <p className="mt-1 font-sans text-13 text-stone-500">
        {t("counts.loadingBody")}
      </p>
      <div
        role="progressbar"
        aria-labelledby="publish-counts-title"
        className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-stone-100"
      >
        <div className="h-full w-full rounded-full bg-indigo-soft motion-safe:animate-pulse" />
      </div>
    </section>
  );
}

export function CountsFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation("publish");
  return (
    <section
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-200 px-4 py-3"
    >
      <p className="font-sans text-sm text-stone-700">{t("counts.failed")}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md border border-stone-300 bg-white px-4 py-2 font-sans text-sm font-semibold text-indigo hover:bg-indigo-wash"
      >
        {t("counts.retry")}
      </button>
    </section>
  );
}
