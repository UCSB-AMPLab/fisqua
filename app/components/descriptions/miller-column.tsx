/**
 * Miller Column
 *
 * One column of the Miller-columns explorer. Virtualised so each column
 * scrolls smoothly across thousands of siblings.
 *
 * @version v0.3.0
 */

import { useRef, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { MillerItem } from "./miller-item";
import type { TreeItem } from "./miller-columns";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MillerColumnProps {
  title: string;
  items: TreeItem[];
  filterQuery: string;
  selectedId: string | null;
  ancestorIds: Set<string>;
  onFilterChange: (query: string) => void;
  onItemClick: (item: TreeItem) => void;
}

// ---------------------------------------------------------------------------
// Virtualisation threshold
// ---------------------------------------------------------------------------

const VIRTUAL_THRESHOLD = 100;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MillerColumn({
  title,
  items,
  filterQuery,
  selectedId,
  ancestorIds,
  onFilterChange,
  onItemClick,
}: MillerColumnProps) {
  const { t } = useTranslation("descriptions_admin");
  const listRef = useRef<HTMLDivElement>(null);

  // Client-side filter: match title or referenceCode (case-insensitive)
  const filteredItems = useMemo(() => {
    if (!filterQuery.trim()) return items;
    const q = filterQuery.toLowerCase();
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.referenceCode.toLowerCase().includes(q)
    );
  }, [items, filterQuery]);

  const useVirtual = filteredItems.length > VIRTUAL_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: useVirtual ? filteredItems.length : 0,
    getScrollElement: () => listRef.current,
    estimateSize: () => 56,
    enabled: useVirtual,
  });

  return (
    <div className="flex h-full w-[340px] flex-none flex-col border-r border-stone-200">
      {/* Column header */}
      <div className="flex-none border-b border-stone-200 bg-stone-50 px-4 py-2">
        <p className="truncate font-sans text-sm font-semibold text-stone-900">
          {title}
        </p>
        <input
          type="text"
          value={filterQuery}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder={t("filter_placeholder")}
          className="mt-1 w-full rounded border border-stone-200 px-2 py-1 font-sans text-xs text-stone-700 placeholder:text-stone-500 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
        />
      </div>

      {/* Item list */}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto" role="tree">
        {useVirtual ? (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = filteredItems[virtualRow.index];
              return (
                <div
                  key={item.id}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <MillerItem
                    item={item}
                    isSelected={selectedId === item.id}
                    isAncestor={ancestorIds.has(item.id)}
                    onClick={() => onItemClick(item)}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          filteredItems.map((item) => (
            <MillerItem
              key={item.id}
              item={item}
              isSelected={selectedId === item.id}
              isAncestor={ancestorIds.has(item.id)}
              onClick={() => onItemClick(item)}
            />
          ))
        )}
      </div>
    </div>
  );
}
