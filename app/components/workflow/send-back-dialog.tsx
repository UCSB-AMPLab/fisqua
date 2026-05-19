/**
 * Send Back Dialog
 *
 * This dialog is the surface a reviewer hits when they need to return a
 * volume to the cataloguer for revision rather than approve or send it
 * forward. The reviewer cannot send a volume back without leaving a
 * comment — the textarea enforces a minimum of ten characters so the
 * cataloguer always receives something actionable, not a bare `back`
 * verdict. The dialog tracks its own draft comment state and resets on
 * close so a half-typed comment from an earlier dismissal never leaks
 * back into a new send-back. The Confirm button stays disabled until
 * the minimum length is met, and a quiet counter underneath the
 * textarea tells the reviewer how many characters they still owe;
 * `onConfirm` raises the trimmed comment to the parent, where the
 * route fetcher attaches it to the status transition.
 *
 * @version v0.3.0
 */

import { useState, useCallback } from "react";
import { useTranslation, Trans } from "react-i18next";

type SendBackDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (comment: string) => void;
  volumeName: string;
};

const MIN_COMMENT_LENGTH = 10;

export function SendBackDialog({
  isOpen,
  onClose,
  onConfirm,
  volumeName,
}: SendBackDialogProps) {
  const { t } = useTranslation("workflow");
  const [comment, setComment] = useState("");

  const handleConfirm = useCallback(() => {
    if (comment.trim().length >= MIN_COMMENT_LENGTH) {
      onConfirm(comment.trim());
      setComment("");
    }
  }, [comment, onConfirm]);

  const handleClose = useCallback(() => {
    setComment("");
    onClose();
  }, [onClose]);

  if (!isOpen) return null;

  const isValid = comment.trim().length >= MIN_COMMENT_LENGTH;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <h3 className="text-lg font-semibold text-stone-900">
          {t("dialog.send_back_title")}
        </h3>
        <p className="mt-2 text-sm text-stone-600">
          <Trans
            i18nKey="dialog.send_back_body"
            ns="workflow"
            values={{ volumeName }}
            components={{ strong: <strong /> }}
          />
        </p>
        <textarea
          className="mt-3 w-full rounded border border-stone-300 px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 focus:border-madder focus:outline-none focus:ring-1 focus:ring-madder"
          rows={4}
          placeholder={t("dialog.send_back_placeholder")}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        {comment.length > 0 && !isValid && (
          <p className="mt-1 text-xs text-stone-400">
            {t("dialog.send_back_min_chars", {
              min: MIN_COMMENT_LENGTH,
              current: comment.trim().length,
            })}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-3">
          <button
            onClick={handleClose}
            className="rounded px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100"
          >
            {t("common:button.cancel")}
          </button>
          <button
            onClick={handleConfirm}
            disabled={!isValid}
            className="rounded bg-madder px-4 py-2 text-sm font-medium text-parchment hover:bg-madder-deep disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("dialog.send_back_confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
