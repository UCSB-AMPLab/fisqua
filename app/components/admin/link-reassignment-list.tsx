/**
 * Link Reassignment List
 *
 * Side-panel list that shows every link the operator has queued for
 * reassignment during a merge or split. Each row carries the source,
 * the proposed new target, and an undo button so the batch can be
 * tweaked before commit.
 *
 * @version v0.3.0
 */

import { useState, useCallback } from "react";

export interface DescriptionLink {
  id: string;
  descriptionTitle: string;
  role: string;
}

interface LinkReassignmentListProps {
  links: DescriptionLink[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  defaultChecked: boolean;
  loadMoreLabel: string;
  selectAllLabel: string;
  deselectAllLabel: string;
  onSelectAll: () => void;
  onDeselectAll: () => void;
}

const BATCH_SIZE = 50;

export function LinkReassignmentList({
  links,
  selectedIds,
  onToggle,
  loadMoreLabel,
  selectAllLabel,
  deselectAllLabel,
  onSelectAll,
  onDeselectAll,
}: LinkReassignmentListProps) {
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);

  const visibleLinks = links.slice(0, visibleCount);
  const hasMore = links.length > visibleCount;

  const handleLoadMore = useCallback(() => {
    setVisibleCount((prev) => prev + BATCH_SIZE);
  }, []);

  return (
    <div>
      {/* Select all / Deselect all */}
      <div className="mb-2 flex gap-2">
        <button
          type="button"
          onClick={onSelectAll}
          className="text-xs font-medium text-[#6B1F33] hover:underline"
        >
          {selectAllLabel}
        </button>
        <span className="text-xs text-[#A8A29E]">/</span>
        <button
          type="button"
          onClick={onDeselectAll}
          className="text-xs font-medium text-[#6B1F33] hover:underline"
        >
          {deselectAllLabel}
        </button>
      </div>

      {/* Scrollable list */}
      <div className="max-h-96 overflow-y-auto rounded-lg border border-[#E7E5E4]">
        {visibleLinks.map((link) => (
          <label
            key={link.id}
            className="flex cursor-pointer items-center gap-3 border-b border-[#E7E5E4] px-3 py-2 last:border-b-0 hover:bg-[#FAFAF9]"
          >
            <input
              type="checkbox"
              checked={selectedIds.has(link.id)}
              onChange={() => onToggle(link.id)}
              aria-label={link.descriptionTitle}
              className="h-4 w-4 rounded border-[#E7E5E4] text-[#8B2942] focus:ring-[#8B2942]"
            />
            <span className="flex-1 text-sm text-[#44403C]">
              {link.descriptionTitle}
            </span>
            <span className="rounded bg-[#F5F5F4] px-2 py-0.5 text-xs text-[#44403C]">
              {link.role}
            </span>
          </label>
        ))}
      </div>

      {/* Load more */}
      {hasMore && (
        <button
          type="button"
          onClick={handleLoadMore}
          className="mt-2 text-sm font-medium text-[#6B1F33] hover:underline"
        >
          {loadMoreLabel}
        </button>
      )}
    </div>
  );
}
