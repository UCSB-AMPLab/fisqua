import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import type { Entry, EntryType, BoundaryAction } from "../../lib/boundary-types";
import { computeAllRefCodes } from "../../lib/reference-codes";
import { OutlineEntry } from "./outline-entry";

type OutlinePanelProps = {
  entries: Entry[];
  volumeRefCode: string;
  currentPageIndex: number;
  totalPages: number;
  onScrollToPage: (pageIndex: number) => void;
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

/** Find the entry whose page range contains the given 1-based page number */
function findCurrentEntry(entries: Entry[], pageNumber: number, totalPages: number): string | null {
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

  // Walk tree to find deepest entry containing this page
  function findInGroup(parentId: string | null): string | null {
    const siblings = childrenByParent.get(parentId);
    if (!siblings) return null;

    for (let i = 0; i < siblings.length; i++) {
      const entry = siblings[i];
      const start = entry.startPage;
      let end: number;
      if (entry.endPage != null) {
        end = entry.endPage;
      } else if (i + 1 < siblings.length) {
        end = siblings[i + 1].startPage - 1;
      } else {
        end = totalPages;
      }

      if (pageNumber >= start && pageNumber <= end) {
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
  onScrollToPage,
  dispatch,
}: OutlinePanelProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const isUserScrollingRef = useRef(false);
  const userScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightedRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Compute tree, ref codes, page ranges
  const tree = useMemo(() => buildTree(entries), [entries]);
  const refCodes = useMemo(() => computeAllRefCodes(entries, volumeRefCode), [entries, volumeRefCode]);
  const pageRanges = useMemo(() => computePageRanges(entries, totalPages), [entries, totalPages]);

  // Current page is 1-based for matching
  const currentPage = currentPageIndex + 1;
  const currentEntryId = useMemo(
    () => findCurrentEntry(entries, currentPage, totalPages),
    [entries, currentPage, totalPages]
  );

  // Track user interaction to suppress auto-scroll
  const handlePanelInteraction = useCallback(() => {
    isUserScrollingRef.current = true;
    if (userScrollTimerRef.current) clearTimeout(userScrollTimerRef.current);
    userScrollTimerRef.current = setTimeout(() => {
      isUserScrollingRef.current = false;
    }, 2000);
  }, []);

  // Auto-scroll to highlighted entry
  useEffect(() => {
    if (!currentEntryId || isUserScrollingRef.current) return;
    highlightedRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currentEntryId]);

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

  function renderNode(node: TreeNode, depth: number, isLast: boolean): React.ReactNode {
    const { entry } = node;
    const isHighlighted = entry.id === currentEntryId;

    return (
      <div
        key={entry.id}
        ref={isHighlighted ? highlightedRef : undefined}
      >
        <OutlineEntry
          entry={entry}
          refCode={refCodes.get(entry.id) || ""}
          pageRange={pageRanges.get(entry.id) || ""}
          depth={depth}
          isLast={isLast}
          isHighlighted={isHighlighted}
          isExpanded={expandedIds.has(entry.id)}
          hasChildren={node.children.length > 0}
          canIndent={canIndentEntry(entry)}
          canOutdent={canOutdentEntry(entry)}
          onToggle={() => toggleExpanded(entry.id)}
          onScrollTo={() => onScrollToPage(entry.startPage - 1)}
          onSetType={(type: EntryType | null) =>
            dispatch({ type: "SET_TYPE", entryId: entry.id, entryType: type })
          }
          onSetTitle={(title: string) =>
            dispatch({ type: "SET_TITLE", entryId: entry.id, title })
          }
          onIndent={() => dispatch({ type: "INDENT", entryId: entry.id })}
          onOutdent={() => dispatch({ type: "OUTDENT", entryId: entry.id })}
        >
          {node.children.map((child, i) =>
            renderNode(child, depth + 1, i === node.children.length - 1)
          )}
        </OutlineEntry>
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      className="flex h-full flex-col overflow-y-auto border-l border-stone-200 bg-white"
      onScroll={handlePanelInteraction}
      onPointerDown={handlePanelInteraction}
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

      {/* Entry list */}
      <div className="flex-1 overflow-y-auto">
        {tree.map((node, i) => renderNode(node, 0, i === tree.length - 1))}
      </div>
    </div>
  );
}
