/**
 * Publish Confirmation Modal
 *
 * The confirm-before-kicking-off dialog for the Publish button.
 * Autofocus lands on Cancel — requiring a deliberate commit — and
 * Escape dismisses. Surfaces the total record count so operators can
 * sanity-check the scope of what they are about to regenerate.
 *
 * @version v0.3.0
 */

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

interface PublishWarningModalProps {
  open: boolean;
  totalRecordCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation modal shown before kicking off a publish run.
 *
 * Purpose: make it impossible to accidentally start a multi-minute operation.
 * Autofocus lands on the Cancel button (safer default — requires deliberate
 * commit) and Escape dismisses the modal.
 */
export function PublishWarningModal({
  open,
  totalRecordCount,
  onConfirm,
  onCancel,
}: PublishWarningModalProps) {
  const { t } = useTranslation("publish");
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onCancel]);

  if (!open) return null;

  // Estimate: one minute per 50k records, minimum one minute. Matches the
  // observed Workflows step wall clock at verification time.
  const minutes = Math.max(1, Math.ceil(totalRecordCount / 50000));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="publish-warning-title"
    >
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl">
        <h2
          id="publish-warning-title"
          className="font-display text-2xl font-semibold text-[#44403C]"
        >
          {t("warning.title")}
        </h2>
        <p className="mt-3 font-sans text-sm text-stone-600">
          {t("warning.body")}
        </p>
        <p className="mt-3 font-sans text-sm font-medium text-stone-800">
          {t("warning.estimate", { minutes })}
        </p>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            ref={cancelRef}
            onClick={onCancel}
            className="rounded-lg border border-stone-300 bg-white px-4 py-2 font-sans text-sm font-semibold text-stone-700 hover:bg-stone-50 focus:outline-none focus:ring-2 focus:ring-stone-400"
          >
            {t("warning.cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-lg bg-[#8B2942] px-4 py-2 font-sans text-sm font-semibold text-white hover:bg-[#7a2439] focus:outline-none focus:ring-2 focus:ring-[#8B2942]"
          >
            {t("warning.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
