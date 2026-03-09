import { useState, useCallback } from "react";

/**
 * Send-back dialog with mandatory comment field.
 * Used by reviewers to return a volume to the cataloguer for revision.
 */

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
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h3 className="text-lg font-semibold text-stone-900">
          Send back for revision
        </h3>
        <p className="mt-2 text-sm text-stone-600">
          Explain what needs to be corrected in{" "}
          <strong>{volumeName}</strong>:
        </p>
        <textarea
          className="mt-3 w-full rounded border border-stone-300 px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 focus:border-red-400 focus:outline-none focus:ring-1 focus:ring-red-400"
          rows={4}
          placeholder="Describe the issues that need correction..."
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        {comment.length > 0 && !isValid && (
          <p className="mt-1 text-xs text-stone-400">
            Minimum {MIN_COMMENT_LENGTH} characters ({comment.trim().length}/{MIN_COMMENT_LENGTH})
          </p>
        )}
        <div className="mt-4 flex justify-end gap-3">
          <button
            onClick={handleClose}
            className="rounded px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!isValid}
            className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Send back
          </button>
        </div>
      </div>
    </div>
  );
}
