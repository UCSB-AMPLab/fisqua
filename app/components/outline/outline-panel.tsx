import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Entry, EntryType, BoundaryAction } from "../../lib/boundary-types";
import type { CommentWithAuthor } from "../../lib/description-types";
import { computeAllRefCodes } from "../../lib/reference-codes";
import { OutlineEntry } from "./outline-entry";
import { SubmitDialog } from "../workflow/submit-dialog";
import { SendBackDialog } from "../workflow/send-back-dialog";

type OutlinePanelProps = {
  entries: Entry[];
  volumeRefCode: string;
  currentPageIndex: number;
  totalPages: number;
  onScrollToEntry: (pageIndex: number, yFraction: number) => void;
  dispatch: React.Dispatch<BoundaryAction>;
  accessLevel?: "edit" | "review" | "readonly";
  assignedTo?: string | null;
  volumeStatus?: string;
  volumeId?: string;
  volumeName?: string;
  projectId?: string;
  reviewComment?: string | null;
  viewportYFraction?: number;
  commentsMap?: Record<string, CommentWithAuthor[]>;
  onCommentAdded?: () => void;
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
  accessLevel = "edit",
  assignedTo = null,
  volumeStatus,
  volumeId,
  volumeName,
  projectId,
  reviewComment,
  viewportYFraction: viewportYFractionProp,
  commentsMap = {},
  onCommentAdded,
}: OutlinePanelProps) {
  const { t } = useTranslation(["viewer", "workflow"]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [showSubmitDialog, setShowSubmitDialog] = useState(false);
  const [showSendBackDialog, setShowSendBackDialog] = useState(false);
  const workflowFetcher = useFetcher();
  const acceptFetcher = useFetcher();
  const isUserScrollingRef = useRef(false);
  const userScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const knownIdsRef = useRef<Set<string>>(new Set(entries.map((e) => e.id)));

  // Y-fraction for y-aware current entry detection (received from viewer)
  const viewportYFraction = viewportYFractionProp ?? 0;

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

  const isReadonly = accessLevel === "readonly";

  /** An entry is reviewer-modified when modifiedBy is set and differs from the cataloguer (assignedTo). */
  const isReviewerModified = useCallback(
    (entry: Entry): boolean => {
      return entry.modifiedBy !== null && entry.modifiedBy !== assignedTo;
    },
    [assignedTo]
  );

  const showHint = entries.length <= 1;

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      if (prev.has(id)) {
        // Collapsing: just remove this one
        const next = new Set(prev);
        next.delete(id);
        return next;
      } else {
        // Expanding: accordion — collapse all others, expand only this one
        return new Set([id]);
      }
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
        <h2 className="text-sm font-semibold text-stone-700">{t("viewer:outline.title")}</h2>
        {showHint && (
          <p className="mt-0.5 text-xs text-stone-400">
            {t("viewer:outline.hint")}
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
                  comments={commentsMap[entry.id] || []}
                  onCommentAdded={onCommentAdded}
                  accessLevel={accessLevel}
                  onHeightChange={() => virtualizer.measure()}
                  isReviewerModified={isReviewerModified(entry)}
                  isFirstEntry={entry.position === 0 && entry.parentId === null}
                  onDelete={(entryId) => dispatch({ type: "DELETE_BOUNDARY", entryId })}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer actions */}
      {volumeId && projectId && (
        <div className="shrink-0 border-t border-stone-200 px-3 py-3">
          {/* Cataloguer: submit for review */}
          {accessLevel === "edit" && volumeStatus === "in_progress" && (
            <button
              onClick={() => setShowSubmitDialog(true)}
              className="w-full rounded bg-burgundy-deep px-3 py-2 text-sm font-medium text-white hover:bg-burgundy"
            >
              {t("workflow:action.submit_for_review")}
            </button>
          )}

          {/* Cataloguer: sent back -- show reviewer comment and accept corrections */}
          {accessLevel === "edit" && volumeStatus === "sent_back" && (
            <div className="space-y-3">
              {reviewComment && (
                <div className="rounded border-l-4 border-red-400 bg-red-50 p-3">
                  <p className="text-xs font-medium text-red-700">{t("viewer:outline.reviewer_comment_label")}</p>
                  <p className="mt-1 text-sm text-red-800">{reviewComment}</p>
                </div>
              )}
              <button
                onClick={() => {
                  if (volumeId) {
                    acceptFetcher.submit(
                      { volumeId, _action: "accept-corrections" },
                      { method: "post", action: "/api/entries/save" }
                    );
                  }
                }}
                disabled={acceptFetcher.state !== "idle"}
                className="w-full rounded bg-burgundy-deep px-3 py-2 text-sm font-medium text-white hover:bg-burgundy disabled:opacity-50"
              >
                {acceptFetcher.state !== "idle" ? t("viewer:outline.accepting") : t("workflow:action.accept_corrections")}
              </button>
            </div>
          )}

          {/* Reviewer: approve and send back */}
          {accessLevel === "review" && (
            <div className="flex gap-2">
              <button
                onClick={() => {
                  workflowFetcher.submit(
                    { volumeId, projectId, targetStatus: "approved" },
                    { method: "post", action: "/api/workflow" }
                  );
                }}
                disabled={workflowFetcher.state !== "idle"}
                className="flex-1 rounded bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
              >
                {t("workflow:action.approve")}
              </button>
              <button
                onClick={() => setShowSendBackDialog(true)}
                disabled={workflowFetcher.state !== "idle"}
                className="flex-1 rounded border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                {t("workflow:action.send_back")}
              </button>
            </div>
          )}

          {/* Read-only status message */}
          {accessLevel === "readonly" && (
            <p className="text-center text-xs text-stone-400">
              {volumeStatus === "segmented"
                ? t("viewer:outline.readonly.segmented")
                : volumeStatus === "approved"
                  ? t("viewer:outline.readonly.approved")
                  : t("viewer:outline.readonly.not_assigned")}
            </p>
          )}
        </div>
      )}

      {/* Submit for review dialog */}
      <SubmitDialog
        isOpen={showSubmitDialog}
        onClose={() => setShowSubmitDialog(false)}
        onConfirm={() => {
          setShowSubmitDialog(false);
          if (volumeId && projectId) {
            workflowFetcher.submit(
              {
                volumeId,
                projectId,
                targetStatus: "segmented",
              },
              { method: "post", action: "/api/workflow" }
            );
          }
        }}
        volumeName={volumeName ?? ""}
      />

      {/* Send back dialog */}
      <SendBackDialog
        isOpen={showSendBackDialog}
        onClose={() => setShowSendBackDialog(false)}
        onConfirm={(comment) => {
          setShowSendBackDialog(false);
          if (volumeId && projectId) {
            workflowFetcher.submit(
              {
                volumeId,
                projectId,
                targetStatus: "sent_back",
                comment,
              },
              { method: "post", action: "/api/workflow" }
            );
          }
        }}
        volumeName={volumeName ?? ""}
      />
    </div>
  );
}
