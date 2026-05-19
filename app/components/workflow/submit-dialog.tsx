/**
 * Submit Dialog
 *
 * This dialog is the confirmation step a cataloguer hits when they
 * submit a volume for reviewer pickup. It exists less to confirm the
 * action than to spell out the trade-off — once the volume is in the
 * reviewer's queue, the cataloguer can no longer edit segmentation
 * until the reviewer either approves the volume or sends it back with
 * comments. The dialog is purely presentational: it raises an
 * `onConfirm` callback that the parent route's fetcher uses to POST the
 * status transition. Volume name is passed through so the warning copy
 * reads with the actual title rather than a generic "this volume",
 * which the team found easy to skim past.
 *
 * @version v0.3.0
 */

import { useTranslation, Trans } from "react-i18next";

type SubmitDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  volumeName: string;
};

export function SubmitDialog({
  isOpen,
  onClose,
  onConfirm,
  volumeName,
}: SubmitDialogProps) {
  const { t } = useTranslation("workflow");

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <h3 className="text-lg font-semibold text-stone-900">
          {t("dialog.submit_title")}
        </h3>
        <p className="mt-2 text-sm text-stone-600">
          <Trans
            i18nKey="dialog.submit_body"
            ns="workflow"
            values={{ volumeName }}
            components={{ strong: <strong /> }}
          />
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100"
          >
            {t("common:button.cancel")}
          </button>
          <button
            onClick={onConfirm}
            className="rounded bg-indigo px-4 py-2 text-sm font-medium text-parchment hover:bg-indigo-deep"
          >
            {t("dialog.submit_confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
