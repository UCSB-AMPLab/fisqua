/**
 * DismissDialog — the shared ruling confirmation in the decisions flow.
 *
 * Dismissal is never immediate: the card's quiet Dismiss and the
 * detail page's "Don't create" both route through this dialog, and
 * this is the only place madder appears in the flow — destructiveness
 * escalates at the confirmation instead of shouting from the list.
 * The title names the object; the consequence states what happens
 * plainly and does not soften it (the ruling is permanent — the
 * question stays readable in the ruled list, not reopenable).
 *
 * `tone` (from the duplicates design round) picks the confirm colour.
 * The default `"destructive"` tone is unchanged. `"neutral"` swaps the
 * confirm to indigo for rulings that destroy nothing but are still
 * final — "Keep both" on a duplicate pair, "Keep as its own term" on
 * a vocabulary card. Madder would overstate those: nothing is deleted,
 * both records or terms simply stay as they are. Indigo reads as
 * closed-and-final without reading as destroyed, so the same pairing
 * serves both rulings.
 *
 * Title, body, confirm label, and the reason placeholder all take
 * optional overrides so the one dialog shell can carry copy for any
 * ruling; each falls back to the original dismiss-proposal copy, so
 * every existing call site compiles and renders unchanged.
 * `objectName` is now optional — it is only read by the default title
 * fallback, so callers that pass their own `title` need not supply it.
 *
 * Presentational only: the caller owns the submission (a fetcher on
 * the queue, a form submit on the detail page) and receives the typed
 * reason — an empty string if untouched — through `onConfirm`.
 *
 * @version v0.7.0
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

export function DismissDialog({
  objectName,
  tone = "destructive",
  title,
  body,
  confirmLabel,
  reasonPlaceholder,
  pending,
  onCancel,
  onConfirm,
}: {
  objectName?: string;
  tone?: "destructive" | "neutral";
  title?: string;
  body?: string;
  confirmLabel?: string;
  reasonPlaceholder?: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const { t } = useTranslation("decisions");
  const [reason, setReason] = useState("");

  const resolvedTitle = title ?? t("dismissModalTitle", { name: objectName });
  const resolvedBody = body ?? t("dismissModalBody");
  const resolvedConfirmLabel = confirmLabel ?? t("dismissConfirm");
  const resolvedReasonPlaceholder =
    reasonPlaceholder ?? t("rejectReasonPlaceholder");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,32,58,0.42)] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dismiss-dialog-title"
    >
      <div className="w-full max-w-[27rem] rounded-lg border border-stone-200 bg-white p-6 shadow-lg">
        <p
          id="dismiss-dialog-title"
          className="font-serif text-xl font-semibold leading-snug tracking-[-0.005em] text-indigo"
        >
          {resolvedTitle}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-indigo-soft [text-wrap:pretty]">
          {resolvedBody}
        </p>

        <label
          htmlFor="dismiss-dialog-reason"
          className="mt-5 block text-sm font-medium text-stone-700"
        >
          {t("rejectReasonLabel")}
        </label>
        <textarea
          id="dismiss-dialog-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="mt-1.5 h-[76px] w-full resize-none rounded-lg border border-stone-300 px-3 py-2.5 text-sm leading-normal text-stone-700 placeholder:text-stone-400 focus:border-verdigris focus:outline-none focus:ring-1 focus:ring-verdigris"
          placeholder={resolvedReasonPlaceholder}
        />

        <div className="mt-5 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-11 items-center rounded-lg border border-stone-300 bg-white px-4.5 text-15 font-semibold text-indigo hover:border-stone-400 hover:bg-stone-50"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => onConfirm(reason)}
            className={`inline-flex h-11 items-center rounded-lg px-4.5 text-15 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-30 ${
              tone === "neutral"
                ? "bg-indigo hover:bg-indigo-deep"
                : "bg-madder hover:bg-madder-deep"
            }`}
          >
            {resolvedConfirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
