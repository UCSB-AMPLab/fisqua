import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Entry, EntryType, BoundaryAction } from "../../lib/boundary-types";
import { computeAllRefCodes } from "../../lib/reference-codes";
import { OutlineEntry } from "./outline-entry";

type OutlinePanelProps = {
  entries: Entry[];
  volumeRefCode: string;
  currentPageIndex: number;
  totalPages: number;
  onScrollToEntry: (pageIndex: number, yFraction: number) => void;
  dispatch: React.Dispatch<BoundaryAction>;
};

type TreeNode = {
  entry: Entry;
  children: TreeNode[];
};

function buildTree(entries: Entry[]): TreeNode[] {
  const childrenByParent = new Map<string | null, Entry[]>();
  for (const entry of entries) {
    const key = entry.parentId;
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key)!.push(entry);
  }
  // Sort each group by position
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => a.position - b.position);
  }

  function buildNodes(parentId: string | null): TreeNode[] {
    const children = childrenByParent.get(parentId);
    if (!children) return [];
    return children.map((entry) => ({
      entry,
      children: buildNodes(entry.id),
    }));
  }

  return buildNodes(null);
}

type FlatNode = {
  entry: Entry;
  depth: number;
  isLast: boolean;
  hasChildren: boolean;
};

/**
 * Flatten tree to a list, respecting expanded/collapsed state.
 * Each node includes its depth for indentation.
 */
function flattenTree(
  nodes: TreeNode[],
  expandedIds: Set<string>,
  depth: number
): FlatNode[] {
  const result: FlatNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    result.push({
      entry: node.entry,
      depth,
      isLast,
      hasChildren: node.children.length > 0,
    });
    // Only include children if expanded
    if (expandedIds.has(node.entry.id) && node.children.length > 0) {
      result.push(...flattenTree(node.children, expandedIds, depth + 1));
    }
  }
  return result;
}

function computePageRanges(entries: Entry[], totalPages: number): Map<string, string> {
  const ranges = new Map<string, string>();
  if (entries.length === 0) return ranges;

  // Group by parentId
  const childrenByParent = new Map<string | null, Entry[]>();
  for (const entry of entries) {
    const key = entry.parentId;
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key)!.push(entry);
  }
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => a.position - b.position);
  }

  for (const [, siblings] of childrenByParent) {
    for (let i = 0; i < siblings.length; i++) {
      const entry = siblings[i];
      const start = entry.startPage;
      let end: number;

      if (entry.endPage != null) {
        end = entry.endPage;
      } else if (i + 1 < siblings.length) {
        end = siblings[i + 1].startPage - 1;
      } else {
        // Last sibling: extends to parent's end or totalPages
        end = totalPages;
      }

      if (start === end) {
        ranges.set(entry.id, `p.\u00A0${start}`);
      } else {
        ranges.set(entry.id, `pp.\u00A0${start}\u2013${end}`);
      }
    }
  }

  return ranges;
}

/**
 * Find the deepest entry whose (startPage, startY) to (endPage/nextSibling) range
 * contains the given page number and y-fraction.
 *
 * Y-aware: within a page, the y-fraction determines which entry is active.
 */
function findCurrentEntry(
  entries: Entry[],
  pageNumber: number,
  yFraction: number,
  totalPages: number
): string | null {
  if (entries.length === 0) return null;

  // Group by parentId for sibling ranges
  const childrenByParent = new Map<string | null, Entry[]>();
  for (const entry of entries) {
    const key = entry.parentId;
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key)!.push(entry);
  }
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => a.position - b.position);
  }

  function comparePageY(page1: number, y1: number, page2: number, y2: number): number {
    if (page1 !== page2) return page1 - page2;
    return y1 - y2;
  }

  // Walk tree to find deepest entry containing this position
  function findInGroup(parentId: string | null): string | null {
    const siblings = childrenByParent.get(parentId);
    if (!siblings) return null;

    for (let i = 0; i < siblings.length; i++) {
      const entry = siblings[i];
      const startPage = entry.startPage;
      const startY = entry.startY;

      // Determine the end position for this entry
      let endPage: number;
      let endY: number;
      if (entry.endPage != null) {
        endPage = entry.endPage;
        endY = entry.endY ?? 1;
      } else if (i + 1 < siblings.length) {
        // Extends to just before the next sibling
        endPage = siblings[i + 1].startPage;
        endY = siblings[i + 1].startY;
      } else {
        // Last sibling: extends to end of volume
        endPage = totalPages;
        endY = 1;
      }

      // Check if position is within this entry's range
      const afterStart = comparePageY(pageNumber, yFraction, startPage, startY) >= 0;
      const beforeEnd = comparePageY(pageNumber, yFraction, endPage, endY) < 0;

      if (afterStart && beforeEnd) {
        // Check children for more specific match
        const childMatch = findInGroup(entry.id);
        return childMatch || entry.id;
      }
    }
    return null;
  }

  return findInGroup(null);
}

export function OutlinePanel({
  entries,
  volumeRefCode,
  currentPageIndex,
  totalPages,
  onScrollToEntry,
  dispatch,
}: OutlinePanelProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const isUserScrollingRef = useRef(false);
  const userScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const knownIdsRef = useRef<Set<string>>(new Set(entries.map((e) => e.id)));

  // Track viewport y-fraction for y-aware current entry detection
  const [viewportYFraction, setViewportYFraction] = useState(0);

  // Auto-expand newly added entries
  useEffect(() => {
    const currentIds = new Set(entries.map((e) => e.id));
    const newIds: string[] = [];
    for (const id of currentIds) {
      if (!knownIdsRef.current.has(id)) newIds.push(id);
    }
    knownIdsRef.current = currentIds;
    if (newIds.length > 0) {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        for (const id of newIds) next.add(id);
        return next;
      });
    }
  }, [entries]);

  // Compute tree, ref codes, page ranges
  const tree = useMemo(() => buildTree(entries), [entries]);
  const refCodes = useMemo(() => computeAllRefCodes(entries, volumeRefCode), [entries, volumeRefCode]);
  const pageRanges = useMemo(() => computePageRanges(entries, totalPages), [entries, totalPages]);

  // Flatten tree for virtualisation
  const flatNodes = useMemo(() => flattenTree(tree, expandedIds, 0), [tree, expandedIds]);

  // Current page is 1-based for matching
  const currentPage = currentPageIndex + 1;
  const currentEntryId = useMemo(
    () => findCurrentEntry(entries, currentPage, viewportYFraction, totalPages),
    [entries, currentPage, viewportYFraction, totalPages]
  );

  // Virtualiser
  const virtualizer = useVirtualizer({
    count: flatNodes.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 36,
    overscan: 5,
  });

  // Track user interaction to suppress auto-scroll
  const handlePanelInteraction = useCallback(() => {
    isUserScrollingRef.current = true;
    if (userScrollTimerRef.current) clearTimeout(userScrollTimerRef.current);
    userScrollTimerRef.current = setTimeout(() => {
      isUserScrollingRef.current = false;
    }, 2000);
  }, []);

  // Auto-scroll to highlighted entry in the virtual list
  useEffect(() => {
    if (!currentEntryId || isUserScrollingRef.current) return;
    const index = flatNodes.findIndex((n) => n.entry.id === currentEntryId);
    if (index >= 0) {
      virtualizer.scrollToIndex(index, { align: "auto", behavior: "smooth" });
    }
  }, [currentEntryId, flatNodes, virtualizer]);

  const showHint = entries.length <= 1;

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Check if entry can indent (not first sibling)
  const canIndentEntry = useCallback(
    (entry: Entry): boolean => {
      const siblings = entries.filter((e) => e.parentId === entry.parentId);
      siblings.sort((a, b) => a.position - b.position);
      return siblings.length > 0 && siblings[0].id !== entry.id;
    },
    [entries]
  );

  // Check if entry can outdent (has a parent)
  const canOutdentEntry = useCallback(
    (entry: Entry): boolean => {
      return entry.parentId !== null;
    },
    []
  );

  return (
    <div
      className="flex h-full flex-col border-l border-stone-200 bg-white"
    >
      {/* Header */}
      <div className="shrink-0 border-b border-stone-200 px-3 py-2">
        <h2 className="text-sm font-semibold text-stone-700">Estructura</h2>
        {showHint && (
          <p className="mt-0.5 text-xs text-stone-400">
            Haz clic entre paginas para agregar limites
          </p>
        )}
      </div>

      {/* Virtualised entry list */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto"
        onScroll={handlePanelInteraction}
        onPointerDown={handlePanelInteraction}
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const node = flatNodes[virtualItem.index];
            const { entry, depth, isLast, hasChildren } = node;
            const isHighlighted = entry.id === currentEntryId;

            return (
              <div
                key={entry.id}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualItem.start}px)`,
                }}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
              >
                <OutlineEntry
                  entry={entry}
                  refCode={refCodes.get(entry.id) || ""}
                  pageRange={pageRanges.get(entry.id) || ""}
                  depth={depth}
                  isLast={isLast}
                  isHighlighted={isHighlighted}
                  isExpanded={expandedIds.has(entry.id)}
                  hasChildren={hasChildren}
                  canIndent={canIndentEntry(entry)}
                  canOutdent={canOutdentEntry(entry)}
                  onToggle={() => toggleExpanded(entry.id)}
                  onScrollTo={() => onScrollToEntry(entry.startPage - 1, entry.startY)}
                  onSetType={(type: EntryType | null) =>
                    dispatch({ type: "SET_TYPE", entryId: entry.id, entryType: type })
                  }
                  onSetTitle={(title: string) =>
                    dispatch({ type: "SET_TITLE", entryId: entry.id, title })
                  }
                  onIndent={() => dispatch({ type: "INDENT", entryId: entry.id })}
                  onOutdent={() => dispatch({ type: "OUTDENT", entryId: entry.id })}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
