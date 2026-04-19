/**
 * Metadata Preview
 *
 * Summary card rendered alongside the description form that shows the
 * record's repository, parent, level, and key identifiers at a glance.
 *
 * @version v0.3.0
 */

import { useState } from "react";
import { Link, type FetcherWithComponents } from "react-router";
import { useTranslation } from "react-i18next";
import { ArrowUp, ArrowDown } from "lucide-react";
import { MoveDialog } from "~/components/descriptions/move-dialog";
import { StatusBadge } from "~/components/descriptions/status-badges";
import type { TreeItem } from "./miller-columns";

// ---------------------------------------------------------------------------
// Level badge colours (same as miller-item)
// ---------------------------------------------------------------------------

const LEVEL_BADGE_STYLES: Record<string, string> = {
  fonds: "bg-[#E0E7F7] text-[#3B5A9A]",
  subfonds: "bg-[#CCF0EB] text-[#0D9488]",
  collection: "bg-[#CCF0EB] text-[#0D9488]",
  series: "bg-[#F5E6EA] text-[#8B2942]",
  subseries: "bg-[#FEF3C7] text-[#78350F]",
  section: "bg-[#FEF3C7] text-[#78350F]",
  volume: "bg-[#F5F5F4] text-[#44403C]",
  file: "bg-[#F5F5F4] text-[#44403C]",
  item: "bg-[#F5F5F4] text-[#78716C]",
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MetadataPreviewProps {
  item: TreeItem | null;
  onNavigateAway?: () => void;
  fetcher?: FetcherWithComponents<unknown>;
  onItemDeleted?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MetadataPreview({
  item,
  onNavigateAway,
  fetcher,
  onItemDeleted,
}: MetadataPreviewProps) {
  const { t } = useTranslation("descriptions_admin");
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  if (!item) return null;
  // Repositories are pure navigation containers — no metadata to show.
  if (item.kind === "repository") return null;

  const badgeStyle =
    LEVEL_BADGE_STYLES[item.descriptionLevel] || "bg-[#F5F5F4] text-[#78716C]";
  const levelLabel = t(`level_${item.descriptionLevel}`, {
    defaultValue: item.descriptionLevel,
  });

  const scopeContent = item.scopeContent
    ? item.scopeContent.length > 150
      ? `${item.scopeContent.substring(0, 150)}...`
      : item.scopeContent
    : "\u2014";

  const hasChildren = item.childCount > 0;

  // -----------------------------------------------------------------------
  // Action handlers
  // -----------------------------------------------------------------------

  const handleReorder = (direction: "up" | "down") => {
    if (!fetcher) return;
    fetcher.submit(
      { _action: "reorder", descriptionId: item.id, direction },
      { method: "post" }
    );
  };

  const handleMove = (newParentId: string) => {
    if (!fetcher) return;
    fetcher.submit(
      { _action: "move", descriptionId: item.id, newParentId },
      { method: "post" }
    );
    setShowMoveDialog(false);
  };

  const handleDelete = () => {
    if (!fetcher) return;
    fetcher.submit(
      { _action: "delete", descriptionId: item.id },
      { method: "post" }
    );
    setShowDeleteConfirm(false);
    onItemDeleted?.();
  };

  return (
    <>
      <div className="border-t border-[#E7E5E4] bg-[#FAFAF9] px-4 py-3">
        <div className="grid grid-cols-[1fr_auto] gap-6">
          {/* Left: metadata fields */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            <div>
              <span className="font-sans text-xs text-[#78716C]">
                {t("field_referenceCode")}
              </span>
              <p className="font-sans text-sm text-[#44403C]">
                {item.referenceCode}
              </p>
            </div>
            <div>
              <span className="font-sans text-xs text-[#78716C]">
                {t("field_descriptionLevel")}
              </span>
              <p className="mt-0.5">
                <span
                  className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${badgeStyle}`}
                >
                  {levelLabel}
                </span>
              </p>
            </div>
            <div>
              <span className="font-sans text-xs text-[#78716C]">
                {t("field_dateExpression")}
              </span>
              <p className="font-sans text-sm text-[#44403C]">
                {item.dateExpression || "\u2014"}
              </p>
            </div>
            <div>
              <span className="font-sans text-xs text-[#78716C]">
                {t("field_childCount")}
              </span>
              <p className="font-sans text-sm text-[#44403C]">
                {item.childCount}
              </p>
            </div>
            <div className="col-span-2">
              <span className="font-sans text-xs text-[#78716C]">
                {t("field_scopeContent")}
              </span>
              <p className="font-sans text-sm text-[#44403C]">{scopeContent}</p>
            </div>
            <div>
              <span className="font-sans text-xs text-[#78716C]">
                {t("published_badge")}
              </span>
              <p className="mt-0.5">
                <StatusBadge
                  isPublished={item.isPublished}
                  lastExportedAt={null}
                  updatedAt={0}
                />
              </p>
            </div>
          </div>

          {/* Right: action buttons */}
          <div className="flex flex-col gap-2">
            <Link
              to={`/admin/descriptions/${item.id}`}
              onClick={onNavigateAway}
              className="inline-flex items-center justify-center rounded-lg bg-[#6B1F33] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#8B2942]"
            >
              {t("edit")}
            </Link>
            <Link
              to={`/admin/descriptions/new?parentId=${item.id}`}
              onClick={onNavigateAway}
              className="inline-flex items-center justify-center rounded-lg border border-[#E7E5E4] bg-white px-3 py-1.5 text-sm font-semibold text-[#44403C] hover:bg-[#FAFAF9]"
            >
              {t("add_child")}
            </Link>
            <button
              type="button"
              onClick={() => setShowMoveDialog(true)}
              className="inline-flex items-center justify-center rounded-lg border border-[#E7E5E4] bg-white px-3 py-1.5 text-sm font-semibold text-[#44403C] hover:bg-[#FAFAF9]"
            >
              {t("move_button")}
            </button>
            {/* Reorder up/down */}
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => handleReorder("up")}
                aria-label={t("aria_move_up")}
                className="inline-flex flex-1 items-center justify-center rounded-lg border border-[#E7E5E4] bg-white px-3 py-1.5 text-sm font-semibold text-[#44403C] hover:bg-[#FAFAF9]"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => handleReorder("down")}
                aria-label={t("aria_move_down")}
                className="inline-flex flex-1 items-center justify-center rounded-lg border border-[#E7E5E4] bg-white px-3 py-1.5 text-sm font-semibold text-[#44403C] hover:bg-[#FAFAF9]"
              >
                <ArrowDown className="h-4 w-4" />
              </button>
            </div>
            <button
              type="button"
              onClick={() => !hasChildren && setShowDeleteConfirm(true)}
              disabled={hasChildren}
              title={
                hasChildren
                  ? t("error_delete_blocked", { count: item.childCount })
                  : undefined
              }
              className={
                hasChildren
                  ? "inline-flex cursor-not-allowed items-center justify-center rounded-lg border border-[#E7E5E4] bg-white px-3 py-1.5 text-sm font-semibold text-red-600 opacity-50"
                  : "inline-flex items-center justify-center rounded-lg border border-[#E7E5E4] bg-white px-3 py-1.5 text-sm font-semibold text-red-600 hover:bg-red-50"
              }
            >
              {t("delete_description")}
            </button>
          </div>
        </div>
      </div>

      {/* Move dialog */}
      {showMoveDialog && (
        <MoveDialog
          description={{
            id: item.id,
            title: item.title,
            referenceCode: item.referenceCode,
            descriptionLevel: item.descriptionLevel,
            childCount: item.childCount,
          }}
          currentParentId={null}
          onClose={() => setShowMoveDialog(false)}
          onConfirm={handleMove}
        />
      )}

      {/* Delete confirmation dialog */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-[#44403C]">
              {t("delete_description")}
            </h2>
            <p className="mt-2 text-sm text-[#78716C]">
              {t("error_delete_confirm", { title: item.title })}
            </p>
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                className="rounded-lg border border-[#E7E5E4] px-4 py-2 text-sm font-semibold text-[#44403C] hover:bg-[#FAFAF9]"
              >
                {t("delete_cancel")}
              </button>
              <button
                type="button"
                onClick={handleDelete}
                className="rounded-lg bg-[#DC2626] px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
              >
                {t("delete_description")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
