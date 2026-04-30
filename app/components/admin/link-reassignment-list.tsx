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
          className="text-xs font-medium text-indigo-deep hover:underline"
        >
          {selectAllLabel}
        </button>
        <span className="text-xs text-stone-400">/</span>
        <button
          type="button"
          onClick={onDeselectAll}
          className="text-xs font-medium text-indigo-deep hover:underline"
        >
          {deselectAllLabel}
        </button>
      </div>

      {/* Scrollable list */}
      <div className="max-h-96 overflow-y-auto rounded-lg border border-stone-200">
        {visibleLinks.map((link) => (
          <label
            key={link.id}
            className="font-medium flex cursor-pointer items-center gap-3 border-b border-stone-200 px-3 py-2 last:border-b-0 hover:bg-stone-50"
          >
            <input
              type="checkbox"
              checked={selectedIds.has(link.id)}
              onChange={() => onToggle(link.id)}
              aria-label={link.descriptionTitle}
              className="h-4 w-4 rounded border-stone-200 text-indigo focus:ring-indigo"
            />
            <span className="flex-1 text-sm text-stone-700">
              {link.descriptionTitle}
            </span>
            <span className="rounded bg-stone-100 px-2 py-0.5 text-xs text-stone-700">
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
          className="mt-2 text-sm font-medium text-indigo-deep hover:underline"
        >
          {loadMoreLabel}
        </button>
      )}
    </div>
  );
}
