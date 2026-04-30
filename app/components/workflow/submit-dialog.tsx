/**
 * Submit for review confirmation dialog.
 * Warns the cataloguer that editing will be locked until reviewer returns the volume.
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
