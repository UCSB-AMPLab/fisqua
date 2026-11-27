/**
 * Add to digitization queue — the button
 *
 * This component is the one control that puts descriptions in the
 * workspace's digitization queue, wherever a person asks for it: a
 * description's page (the description, or everything below it), the
 * actions menu and preview pane of the Descriptions screen, the search
 * page's selection bar, and a handlist's page. It posts to
 * `/admin/capture/queue/add` with exactly one of `descriptionIds`, `below`
 * or `handlistId`; for every result of a search (`searchQuery`, with the
 * count the button shows as `expected`) it posts to the search page's own
 * action (`queueAll`), which resolves the query. It says what happened
 * beside itself: how many went in and how many were queued already (or
 * that every one was), or why nothing did, in the reader's language from
 * the capture namespace. The caller renders it only on a tenant with the
 * digitization capability, for a person who manages capture work.
 * `className` styles the button and `wrapperClassName` the box that holds
 * it and its message, so a menu can lay it out as a full-width item.
 *
 * @version v0.9.0
 */

import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { ScanLine } from "lucide-react";

type AddAnswer = { ok: true; added: number; alreadyQueued: number } | { ok: false; error: string };

export type AddToQueueTarget =
  | { descriptionIds: string[] }
  | { below: string }
  | { handlistId: string }
  | { searchQuery: string; expected: number };

const ERRORS = ["not-found", "ceiling", "below-limit", "results-limit", "results-changed", "invalid"];

export function AddToQueueButton({
  target,
  label,
  className,
  wrapperClassName,
}: {
  target: AddToQueueTarget;
  label: string;
  className?: string;
  wrapperClassName?: string;
}) {
  const { t } = useTranslation("capture");
  const fetcher = useFetcher<AddAnswer>();
  const busy = fetcher.state !== "idle";
  const answer = fetcher.state === "idle" ? fetcher.data : undefined;

  const submit = () => {
    if ("searchQuery" in target) {
      fetcher.submit(
        { _action: "queueAll", recordType: "records", query: target.searchQuery, expected: String(target.expected) },
        { method: "post", action: "/search" },
      );
      return;
    }
    const form: Record<string, string> = {};
    if ("descriptionIds" in target) form.descriptionIds = JSON.stringify(target.descriptionIds);
    else if ("below" in target) form.below = target.below;
    else form.handlistId = target.handlistId;
    fetcher.submit(form, { method: "post", action: "/admin/capture/queue/add" });
  };

  let message: string | null = null;
  if (answer?.ok) {
    message =
      answer.added === 0 && answer.alreadyQueued > 0
        ? t("dqueue.all_already_queued")
        : answer.alreadyQueued > 0
          ? t("dqueue.added_with_already", { count: answer.added, already: answer.alreadyQueued })
          : t("dqueue.added", { count: answer.added });
  } else if (answer && !answer.ok) {
    message = t(`dqueue.add_error.${ERRORS.includes(answer.error) ? answer.error.replace(/-/g, "_") : "generic"}`);
  }

  return (
    <span className={wrapperClassName ?? "inline-flex flex-col items-start"}>
      <button
        type="button"
        disabled={busy}
        onClick={submit}
        className={
          className ??
          "inline-flex items-center gap-2 rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50 disabled:cursor-wait disabled:opacity-50"
        }
      >
        <ScanLine className="h-4 w-4" strokeWidth={1.5} />
        {label}
      </button>
      {message ? (
        <span role="status" className={`mt-1 text-xs ${answer?.ok ? "text-stone-600" : "text-madder-deep"}`}>
          {message}
          {answer?.ok ? (
            <>
              {" "}
              <a href="/admin/capture/queue" className="font-semibold text-indigo hover:underline">
                {t("dqueue.open_queue")}
              </a>
            </>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

// @version v0.9.0
