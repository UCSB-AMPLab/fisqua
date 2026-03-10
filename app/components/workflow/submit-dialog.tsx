/**
 * Submit for review confirmation dialog.
 * Warns the cataloguer that editing will be locked until reviewer returns the volume.
 */

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
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h3 className="text-lg font-semibold text-stone-900">
          Submit for review
        </h3>
        <p className="mt-2 text-sm text-stone-600">
          Submit <strong>{volumeName}</strong> for review? You will not be able
          to edit until the reviewer returns it.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded bg-burgundy-deep px-4 py-2 text-sm font-medium text-white hover:bg-burgundy"
          >
            Submit for review
          </button>
        </div>
      </div>
    </div>
  );
}
