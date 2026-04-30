/**
 * Edit Description Link Dialog
 *
 * Modal that lets an operator change which description a given
 * controlled-vocabulary term is linked to. Runs a typeahead against
 * the descriptions index, validates the new target, and returns the
 * pending reassignment to the parent without touching the database
 * directly — commits flow through the surrounding form action.
 *
 * @version v0.3.0
 */

import { useState, useEffect, useRef } from "react";
import { useFetcher } from "react-router";
import type { TFunction } from "i18next";

interface EditDescriptionLinkDialogProps {
  isOpen: boolean;
  onClose: () => void;
  linkId: string;
  currentValues: {
    role: string;
    roleNote: string | null;
    sequence?: number;
    honorific?: string | null;
    function?: string | null;
    nameAsRecorded?: string | null;
  };
  roles: readonly string[];
  showEntityFields: boolean;
  t: TFunction;
}

export function EditDescriptionLinkDialog({
  isOpen,
  onClose,
  linkId,
  currentValues,
  roles,
  showEntityFields,
  t,
}: EditDescriptionLinkDialogProps) {
  const fetcher = useFetcher();
  const dialogRef = useRef<HTMLDivElement>(null);

  const [role, setRole] = useState(currentValues.role);
  const [roleNote, setRoleNote] = useState(currentValues.roleNote ?? "");
  const [sequence, setSequence] = useState(currentValues.sequence ?? 0);
  const [honorific, setHonorific] = useState(currentValues.honorific ?? "");
  const [fn, setFn] = useState(currentValues.function ?? "");
  const [nameAsRecorded, setNameAsRecorded] = useState(
    currentValues.nameAsRecorded ?? ""
  );

  // Reset form values when dialog opens with new data
  useEffect(() => {
    if (isOpen) {
      setRole(currentValues.role);
      setRoleNote(currentValues.roleNote ?? "");
      setSequence(currentValues.sequence ?? 0);
      setHonorific(currentValues.honorific ?? "");
      setFn(currentValues.function ?? "");
      setNameAsRecorded(currentValues.nameAsRecorded ?? "");
    }
  }, [isOpen, currentValues]);

  // Focus dialog
  useEffect(() => {
    if (isOpen && dialogRef.current) {
      dialogRef.current.focus();
    }
  }, [isOpen]);

  // Close on successful save
  useEffect(() => {
    if (
      fetcher.data &&
      "ok" in (fetcher.data as Record<string, unknown>) &&
      (fetcher.data as Record<string, unknown>).ok
    ) {
      onClose();
    }
  }, [fetcher.data, onClose]);

  // Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  function handleSave() {
    const data: Record<string, string> = {
      _action: "edit_description_link",
      linkId,
      role,
      roleNote,
    };
    if (showEntityFields) {
      data.sequence = String(sequence);
      data.honorific = honorific;
      data.function = fn;
      data.nameAsRecorded = nameAsRecorded;
    }
    fetcher.submit(data, { method: "post" });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-labelledby="edit-link-dialog-title"
        tabIndex={-1}
        className="w-full max-w-lg rounded-lg bg-white p-6 shadow-lg focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="edit-link-dialog-title"
          className="font-serif text-lg font-semibold text-stone-700"
        >
          {t("edit_link")}
        </h2>

        <div className="mt-4 space-y-4">
          {/* Role */}
          <div>
            <label className="mb-1 block text-xs font-medium text-indigo">
              {t("select_role")}
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            >
              {roles.map((r) => (
                <option key={r} value={r}>
                  {t(`role_${r}`)}
                </option>
              ))}
            </select>
          </div>

          {/* Role note */}
          <div>
            <label className="mb-1 block text-xs font-medium text-indigo">
              {t("role_note_label")}
            </label>
            <input
              type="text"
              value={roleNote}
              onChange={(e) => setRoleNote(e.target.value)}
              className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            />
          </div>

          {/* Entity-specific fields */}
          {showEntityFields && (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-indigo">
                  {t("sequence_label")}
                </label>
                <input
                  type="number"
                  value={sequence}
                  onChange={(e) => setSequence(parseInt(e.target.value, 10) || 0)}
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-indigo">
                  {t("honorific_label")}
                </label>
                <input
                  type="text"
                  value={honorific}
                  onChange={(e) => setHonorific(e.target.value)}
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-indigo">
                  {t("function_label")}
                </label>
                <input
                  type="text"
                  value={fn}
                  onChange={(e) => setFn(e.target.value)}
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-indigo">
                  {t("name_as_recorded_label")}
                </label>
                <input
                  type="text"
                  value={nameAsRecorded}
                  onChange={(e) => setNameAsRecorded(e.target.value)}
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
                />
              </div>
            </>
          )}
        </div>

        {/* Actions */}
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
          >
            {t("mergeCancel")}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={fetcher.state === "submitting"}
            className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("editSave")}
          </button>
        </div>
      </div>
    </div>
  );
}
