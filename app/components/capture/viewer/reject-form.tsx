/**
 * Capture QC Viewer — Reject for Retake
 *
 * This component is the form that rejects the current opening for
 * retake. It sits in the viewer's rail, below the opening's details,
 * with no card round it; R or the opening's Reject button opens it, and
 * Cancel or Escape closes it. On an opening with two images (`pair`) a
 * required radio fieldset above the reasons asks which side to retake,
 * left, right or both (`capture:side.*`), with none chosen at first, and
 * the form cannot be sent until one is; an opening with one image does
 * not show it. The reasons are a radio fieldset, each
 * with its gloss under it so the reviewer chooses by what the reason
 * means, in the labels and glosses Captua shares (`capture:reason.*`,
 * `capture:reason_gloss.*`). The note is optional except for Other,
 * when it becomes required (`aria-required`) and the form cannot be
 * sent until it holds text (`canSubmitReject`); it takes at most
 * `MAX_NOTE_CHARS` characters, as the decisions route does. The image
 * to retake, the reason and the note go to the scanner with the
 * decision; there is no separate request step.
 *
 * Opened on an opening already rejected, the form starts from its
 * side to retake, reason and note, so changing any of them is the same
 * action.
 *
 * @version v0.8.0
 */

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CAPTURE_QC_REASONS,
  CAPTURE_QC_SIDES,
  type CaptureQcReason,
  type CaptureQcSide,
} from "../../../lib/validation/enums";
import { canSubmitReject, MAX_NOTE_CHARS } from "../../../lib/capture/viewer";

export interface RejectFormProps {
  /** The opening's sequence number. */
  n: number;
  /** Whether the opening has two images, so the side to retake must be chosen. */
  pair?: boolean;
  initialSide?: CaptureQcSide | null;
  initialReason?: CaptureQcReason | null;
  initialNote?: string | null;
  /** `side` is null for an opening with one image. */
  onSubmit: (reason: CaptureQcReason, note: string | null, side: CaptureQcSide | null) => void;
  onCancel: () => void;
}

export function RejectForm({
  n,
  pair = false,
  initialSide = null,
  initialReason = null,
  initialNote = null,
  onSubmit,
  onCancel,
}: RejectFormProps) {
  const { t } = useTranslation("capture");
  const id = useId();
  const [side, setSide] = useState<CaptureQcSide | null>(pair ? initialSide : null);
  const [reason, setReason] = useState<CaptureQcReason | null>(initialReason);
  const [note, setNote] = useState(initialNote ?? "");
  const required = reason === "other";
  const ready = canSubmitReject(reason, note, pair, side);
  // The first control takes focus: the side when it is still to choose.
  const focusSide = pair && side === null;
  const noteId = `${id}-note`;
  const helperId = `${id}-helper`;

  return (
    <form
      aria-label={t("viewer.reject_opening", { n })}
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || reason === null) return;
        const trimmed = note.trim();
        onSubmit(reason, trimmed.length > 0 ? trimmed : null, pair ? side : null);
      }}
    >
      {pair ? (
        <fieldset>
          <legend className="font-sans text-sm font-semibold text-indigo">{t("viewer.reject.side_legend")}</legend>
          <div className="mt-2 flex flex-wrap gap-1">
            {CAPTURE_QC_SIDES.map((s, i) => {
              const inputId = `${id}-side-${s}`;
              return (
                <div
                  key={s}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${side === s ? "bg-madder-tint" : ""}`}
                >
                  <input
                    id={inputId}
                    type="radio"
                    name={`${id}-side`}
                    value={s}
                    checked={side === s}
                    onChange={() => setSide(s)}
                    required
                    autoFocus={focusSide ? i === 0 : false}
                    className="accent-madder"
                  />
                  <label
                    htmlFor={inputId}
                    className={`font-sans text-sm font-semibold ${side === s ? "text-madder-deep" : "text-stone-700"}`}
                  >
                    {t(`side.${s}`)}
                  </label>
                </div>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <fieldset>
        <legend className="font-sans text-sm font-semibold text-indigo">{t("viewer.reject.legend")}</legend>
        <div className="mt-2 space-y-1">
          {CAPTURE_QC_REASONS.map((r, i) => {
            const inputId = `${id}-${r}`;
            const glossId = `${inputId}-gloss`;
            return (
              <div
                key={r}
                className={`flex items-start gap-2 rounded-md px-2 py-1.5 ${reason === r ? "bg-madder-tint" : ""}`}
              >
                <input
                  id={inputId}
                  type="radio"
                  name={`${id}-reason`}
                  value={r}
                  checked={reason === r}
                  onChange={() => setReason(r)}
                  aria-describedby={glossId}
                  autoFocus={focusSide ? false : reason === null ? i === 0 : reason === r}
                  className="mt-1 accent-madder"
                />
                <label htmlFor={inputId} className="min-w-0 font-sans text-sm">
                  <span className={`block font-semibold ${reason === r ? "text-madder-deep" : "text-stone-700"}`}>
                    {t(`reason.${r}`)}
                  </span>
                  <span id={glossId} className="block text-xs text-stone-500">
                    {t(`reason_gloss.${r}`)}
                  </span>
                </label>
              </div>
            );
          })}
        </div>
      </fieldset>

      <div>
        <label htmlFor={noteId} className="font-sans text-sm font-medium text-indigo">
          {t("viewer.reject.note")}{" "}
          <span className="font-normal text-stone-500">
            {required ? t("viewer.reject.note_required") : t("viewer.reject.note_optional")}
          </span>
        </label>
        <textarea
          id={noteId}
          rows={3}
          value={note}
          maxLength={MAX_NOTE_CHARS}
          onChange={(e) => setNote(e.target.value)}
          aria-required={required ? "true" : undefined}
          aria-describedby={helperId}
          className={`mt-1 w-full rounded-md border bg-white px-3 py-2 font-sans text-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo ${
            required ? "border-madder ring-1 ring-madder" : "border-stone-200"
          }`}
        />
        <p id={helperId} className="mt-1 font-sans text-xs text-stone-500">
          {t("viewer.reject.helper")}
        </p>
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-stone-200 bg-white px-4 py-2 font-sans text-sm font-semibold text-indigo hover:bg-stone-50"
        >
          {t("viewer.reject.cancel")}
        </button>
        <button
          type="submit"
          disabled={!ready}
          className="rounded-md bg-madder px-4 py-2 font-sans text-sm font-semibold text-parchment hover:bg-madder-deep disabled:cursor-not-allowed disabled:opacity-30"
        >
          {t("viewer.reject.submit")}
        </button>
      </div>
    </form>
  );
}

// @version v0.8.0
