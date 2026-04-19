/**
 * Split Dialog
 *
 * Modal that drives the split-one-record-into-two flow for vocabulary
 * terms. Walks the operator through picking which linked descriptions
 * follow which side of the split, validates both halves are non-empty,
 * and emits the split payload.
 *
 * @version v0.3.0
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Form } from "react-router";
import { useTranslation } from "react-i18next";
import {
  LinkReassignmentList,
  type DescriptionLink,
} from "./link-reassignment-list";

interface SplitDialogProps {
  isOpen: boolean;
  onClose: () => void;
  sourceId: string;
  sourceName: string;
  entityType: "entity" | "place";
  links: DescriptionLink[];
  i18nNamespace: string;
}

export function SplitDialog({
  isOpen,
  onClose,
  sourceId,
  sourceName,
  entityType,
  links,
  i18nNamespace,
}: SplitDialogProps) {
  const { t } = useTranslation(i18nNamespace);
  const dialogRef = useRef<HTMLDivElement>(null);

  const [selectedLinkIds, setSelectedLinkIds] = useState<Set<string>>(
    () => new Set()
  );

  // Reset when dialog opens/closes
  useEffect(() => {
    if (isOpen) {
      setSelectedLinkIds(new Set()); // defaultChecked=false: no links selected by default
    }
  }, [isOpen]);

  // Focus trap
  useEffect(() => {
    if (isOpen && dialogRef.current) {
      dialogRef.current.focus();
    }
  }, [isOpen]);

  // Handle Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  const handleToggleLink = useCallback((id: string) => {
    setSelectedLinkIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedLinkIds(new Set(links.map((l) => l.id)));
  }, [links]);

  const handleDeselectAll = useCallback(() => {
    setSelectedLinkIds(new Set());
  }, []);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-labelledby="split-dialog-title"
        tabIndex={-1}
        className="max-w-2xl rounded-lg bg-white p-6 shadow-xl focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="split-dialog-title"
          className="font-serif text-lg font-semibold text-[#44403C]"
        >
          {t("splitTitle")}
        </h2>
        <p className="mt-1 text-sm text-[#78716C]">
          {t("splitSubtitle", { name: sourceName })}
        </p>

        {links.length > 0 && (
          <div className="mt-4">
            <LinkReassignmentList
              links={links}
              selectedIds={selectedLinkIds}
              onToggle={handleToggleLink}
              defaultChecked={false}
              loadMoreLabel={t("loadMore")}
              selectAllLabel={t("selectAll", { defaultValue: "Select all" })}
              deselectAllLabel={t("deselectAll", {
                defaultValue: "Deselect all",
              })}
              onSelectAll={handleSelectAll}
              onDeselectAll={handleDeselectAll}
            />
          </div>
        )}

        <div className="mt-4 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[#E7E5E4] px-4 py-2 text-sm font-semibold text-[#44403C] hover:bg-[#FAFAF9]"
          >
            {t("splitCancel")}
          </button>
          <Form method="post">
            <input type="hidden" name="_action" value="split" />
            <input
              type="hidden"
              name="linkIds"
              value={JSON.stringify(Array.from(selectedLinkIds))}
            />
            <button
              type="submit"
              className="rounded-lg bg-[#6B1F33] px-4 py-2 text-sm font-semibold text-white hover:bg-[#8B2942]"
            >
              {t("splitConfirm")}
            </button>
          </Form>
        </div>
      </div>
    </div>
  );
}
