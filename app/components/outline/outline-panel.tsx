/**
 * Outline Panel
 *
 * Right-side pane in the viewer that lists the volume's segmented
 * entries in page order. Scrolls the viewer when an entry is
 * selected, surfaces comments, and — when a reviewer triggers a
 * resegmentation flag — surfaces the `ResegmentationCard` inline.
 *
 * @version v0.3.0
 */
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useFetcher, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Entry, EntryType, BoundaryAction } from "../../lib/boundary-types";
import type { CommentWithAuthor } from "../../lib/description-types";
import { computeAllRefCodes } from "../../lib/reference-codes";
import { findCurrentEntry } from "../../lib/entry-ownership";
import { parseCommentsParam } from "../../lib/comments-panel-url";
import {
  buildOutlineItems,
  findOutlineItemIndex,
  outlineItemKey,
  type OutlineItem,
  type DraftCommentState,
} from "../../lib/outline-items";
import { OutlineEntry } from "./outline-entry";
import { OutlineCommentCard } from "./outline-comment-card";
import type { ResegmentationCardFlag } from "./resegmentation-card";
import { SubmitDialog } from "../workflow/submit-dialog";
import { SendBackDialog } from "../workflow/send-back-dialog";
import { InlineCommentComposer } from "../comments/inline-comment-composer";

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
  /**
 * open resegmentation flags keyed by
 * entryId, sourced from the viewer loader (). When an entry
 * id is present in this map, its header pill renders AND the
 * ResegmentationCard is rendered inside the expanded body.
 */
  openResegFlagsByEntry?: Record<string, ResegmentationCardFlag>;
  /**
 * the draft region produced by the viewer's
 * pin-drop. Only forwarded to the matching entry (draftRegion.entryId
 * === entry.id); other entries see null.
 */
  draftRegion?: {
 entryId: string;
 pageId: string;
 region: { x: number; y: number; w: number; h: number };
  } | null;
  /**
 * chip-click handler. Bubbles up to the
 * viewer route which scrolls IIIFViewer to the pin's page and
 * highlights the pin for ~1s.
 */
  onScrollToRegion?: (commentId: string) => void;
  /**
 * page-number lookup keyed by commentId.
 * Built in the viewer route from regionsByPage + pages so
 * region-anchored CommentCards can label their chip "Región · p. N".
 */
  pageNumberByCommentId?: Record<string, number>;
  /**
 * CTA wiring for ResegmentationCard.
 * Callers decide whether to open FlagResegmentationDialog or
 * surface a read-only view. When omitted, the CTA is a no-op.
 */
  onOpenResegDialog?: (flagId: string) => void;
  /**
 * post-Wave-2: per-project Colombian Spanish document
 * subtype list. Threaded into every `OutlineEntry` for the two-step
 * type picker. Falls back to `DEFAULT_DOCUMENT_SUBTYPES` when the
 * caller does not supply one.
 */
  documentSubtypes?: readonly string[];
  /**
 * (13.E plumbing): who is looking. Used by
 * OutlineCommentCard in 13.F for kebab author/lead gating. Pass
 * through when available; both optional so legacy callers (e.g.
 * description editor) keep compiling.
 */
  currentUserId?: string;
  currentUserIsLead?: boolean;
  /**
 * handlers: edit, delete, resolve. Threaded through to each
 * OutlineCommentCard's kebab menu. Undefined handlers hide the
 * corresponding kebab items.
 */
  onEditComment?: (commentId: string, newText: string) => void;
  onDeleteComment?: (commentId: string) => void;
  onResolveComment?: (commentId: string, resolved: boolean) => void;
  /**
 * opens the mandatory-comment prompt
 * for an entry-level comment. Panel-level callback; the panel binds
 * the entry id before handing it to each OutlineEntry row.
 */
  onOpenEntryCommentPrompt?: (entryId: string) => void;
  /**
 * per-entry count of attached comments (row-level,
 * no region) that will be deleted with the entry. Threaded to
 * OutlineEntry so the delete-confirm copy can surface the exact N.
 */
  commentCountByEntry_attached?: Record<string, number>;
  /**
 * per-entry count of anchored comments (region/
 * point) that CURRENTLY resolve to this entry via and will
 * SURVIVE the entry delete and re-parent on next render. Shown in the
 * delete-confirm copy so the user sees what is preserved.
 */
  commentCountByEntry_anchored?: Record<string, number>;
  /**
 * follow-up (2026-04-18): the active draft-comment anchor.
 * When non-null, buildOutlineItems emits a draft-comment row under the
 * owning entry and renders InlineCommentComposer in place of a modal.
 */
  draftCommentState?: DraftCommentState | null;
  /** Fires when the inline draft is cancelled (removes amber pin too). */
  onCancelDraft?: () => void;
  /** Fires after a draft submit succeeds so the caller can revalidate. */
  onDraftCreated?: () => void;
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
 ranges.set(entry.id, `img\u00A0${start}`);
 } else {
 ranges.set(entry.id, `img\u00A0${start}\u2013${end}`);
 }
 }
  }

  return ranges;
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
  openResegFlagsByEntry = {},
  draftRegion = null,
  onScrollToRegion,
  pageNumberByCommentId,
  onOpenResegDialog,
  documentSubtypes,
  onOpenEntryCommentPrompt,
  commentCountByEntry_attached = {},
  commentCountByEntry_anchored = {},
  draftCommentState = null,
  onCancelDraft,
  onDraftCreated,
  currentUserId,
  currentUserIsLead,
  onEditComment,
  onDeleteComment,
  onResolveComment,
}: OutlinePanelProps) {
  const { t } = useTranslation(["viewer", "workflow"]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // which outline comment cards are expanded. Seeded from the
  // URL's `?comments=comment:<id>` or `region:<id>` arm on load so deep
  // links expand the target card automatically.
  const [expandedCommentIds, setExpandedCommentIds] = useState<Set<string>>(
 new Set(),
  );
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

  // subscribe to `?comments=entry:<id>`. When the
  // URL flips to an entry selection, add that entry to the expanded set
  // so its card opens in place. The scroll-to-index effect reacts to
  // `urlSelectedEntryId` further down (after `flatNodes` is built).
  const urlSelectedEntryId = useMemo(() => {
 const sel = parseCommentsParam(searchParams.get("comments"));
 if (!sel) return null;
 if (sel.kind !== "entry") return null;
 // Ignore stale selections that don't exist in the current entry set.
 if (!entries.some((e) => e.id === sel.entryId)) return null;
 return sel.entryId;
  }, [searchParams, entries]);

  // URL selection that targets a specific comment (either the
  // plain `comment:<id>` arm from an outline-card click, or the legacy
  // `region:<id>` arm from a viewer pin click). Both expand the card on
  // load — the region arm additionally pulses the pin via the existing
  // viewer-side scroll-to-region handler.
  const urlSelectedCommentId = useMemo(() => {
 const sel = parseCommentsParam(searchParams.get("comments"));
 if (!sel) return null;
 if (sel.kind !== "comment" && sel.kind !== "region") return null;
 return sel.commentId;
  }, [searchParams]);

  useEffect(() => {
 if (!urlSelectedEntryId) return;
 setExpandedIds((prev) => {
 if (prev.has(urlSelectedEntryId)) return prev;
 // Accordion-style -- opening from the URL replaces any manual open
 // state, matching `toggleExpanded`'s "expand one at a time" rule.
 return new Set([urlSelectedEntryId]);
 });
  }, [urlSelectedEntryId]);

  useEffect(() => {
 if (!urlSelectedCommentId) return;
 setExpandedCommentIds((prev) => {
 if (prev.has(urlSelectedCommentId)) return prev;
 const next = new Set(prev);
 next.add(urlSelectedCommentId);
 return next;
 });
  }, [urlSelectedCommentId]);

  // Compute tree, ref codes, page ranges
  const tree = useMemo(() => buildTree(entries), [entries]);
  const refCodes = useMemo(() => computeAllRefCodes(entries, volumeRefCode), [entries, volumeRefCode]);
  const pageRanges = useMemo(() => computePageRanges(entries, totalPages), [entries, totalPages]);

  // Flatten tree for virtualisation
  const flatNodes = useMemo(() => flattenTree(tree, expandedIds, 0), [tree, expandedIds]);

  // interleave top-level comment items between entries so the
  // outline is a mixed-item list (entries + comment cards). Replies ride
  // along with their parent comment — they never become their own item.
  const flatItems: OutlineItem[] = useMemo(
 () => buildOutlineItems(flatNodes, commentsMap, draftCommentState),
 [flatNodes, commentsMap, draftCommentState],
  );

  // Current page is 1-based for matching
  const currentPage = currentPageIndex + 1;
  const currentEntryId = useMemo(
 () => findCurrentEntry(entries, currentPage, viewportYFraction, totalPages),
 [entries, currentPage, viewportYFraction, totalPages]
  );

  // Virtualiser — count grows with comment items. Overscan bumped from
  // 5 to 10 because a dense outline can carry 3-5× more rows now.
  const virtualizer = useVirtualizer({
 count: flatItems.length,
 getScrollElement: () => scrollContainerRef.current,
 estimateSize: () => 46,
 overscan: 10,
 getItemKey: (index) => outlineItemKey(flatItems[index]),
  });

  // Hold the latest virtualizer in a ref so the row-wrapper ref
  // callback can stay identity-stable across renders. Without this,
  // `ref={(el) => virtualizer.measureElement(el)}` was a fresh function
  // on every render, which (a) made React invoke it (with null then the
  // element) on every commit and (b) re-armed the ResizeObserver
  // pathway repeatedly. Combined with `virtualizer.measure()` calls
  // from `onHeightChange`, this caused the scroll-back cascade — see
  // `.planning/debug/resolved/outline-scroll-snaps-back.md`.
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;
  const measureRowRef = useCallback((el: HTMLDivElement | null) => {
 if (el) virtualizerRef.current.measureElement(el);
  }, []);

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
 const index = findOutlineItemIndex(flatItems, {
 kind: "entry",
 entryId: currentEntryId,
 });
 if (index >= 0) {
 virtualizer.scrollToIndex(index, { align: "auto", behavior: "smooth" });
 }
  }, [currentEntryId, flatItems, virtualizer]);

  // when the URL selects an entry, scroll the
  // virtualiser to that entry's flat-list index. Runs after the
  // auto-expand effect committed so the flat list is already up-to-date.
  // Centred alignment so the card's expanded body is fully visible.
  useEffect(() => {
 if (!urlSelectedEntryId) return;
 const index = findOutlineItemIndex(flatItems, {
 kind: "entry",
 entryId: urlSelectedEntryId,
 });
 if (index >= 0) {
 virtualizer.scrollToIndex(index, {
 align: "center",
 behavior: "smooth",
 });
 }
  }, [urlSelectedEntryId, flatItems, virtualizer]);

  // URL-selected comment card — scroll the expanded card into
  // view. Also centred so the thread footer is visible.
  useEffect(() => {
 if (!urlSelectedCommentId) return;
 const index = findOutlineItemIndex(flatItems, {
 kind: "comment",
 commentId: urlSelectedCommentId,
 });
 if (index >= 0) {
 virtualizer.scrollToIndex(index, {
 align: "center",
 behavior: "smooth",
 });
 }
  }, [urlSelectedCommentId, flatItems, virtualizer]);

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
 className="flex-1 overflow-y-auto px-3 pb-4 pt-1"
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
 const item = flatItems[virtualItem.index];
 const key = outlineItemKey(item);

 return (
 <div
 key={key}
 style={{
 position: "absolute",
 top: 0,
 left: 0,
 width: "100%",
 transform: `translateY(${virtualItem.start}px)`,
 }}
 data-index={virtualItem.index}
 // Stable ref callback (see `measureRowRef` above). Identity is
 // pinned across renders so React only invokes it on actual
 // mount/unmount, not on every commit. The wrapped form (no
 // return value) also keeps React 19's ref-cleanup contract
 // happy.
 ref={measureRowRef}
 >
 {item.kind === "entry" ? (
 (() => {
 const { entry, depth, isLast, hasChildren } = item.node;
 const isHighlighted = entry.id === currentEntryId;
 return (
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
 onScrollTo={() =>
 onScrollToEntry(entry.startPage - 1, entry.startY)
 }
 onSetType={(type: EntryType | null) =>
 dispatch({
 type: "SET_TYPE",
 entryId: entry.id,
 entryType: type,
 })
 }
 onSetSubtype={(subtype: string | null) =>
 dispatch({
 type: "SET_SUBTYPE",
 entryId: entry.id,
 subtype,
 })
 }
 onSetTitle={(title: string) =>
 dispatch({
 type: "SET_TITLE",
 entryId: entry.id,
 title,
 })
 }
 documentSubtypes={documentSubtypes}
 onIndent={() =>
 dispatch({ type: "INDENT", entryId: entry.id })
 }
 onOutdent={() =>
 dispatch({ type: "OUTDENT", entryId: entry.id })
 }
 volumeId={volumeId}
 accessLevel={accessLevel}
 isReviewerModified={isReviewerModified(entry)}
 isFirstEntry={
 entry.position === 0 && entry.parentId === null
 }
 onDelete={(entryId) =>
 dispatch({
 type: "DELETE_BOUNDARY",
 entryId,
 })
 }
 openResegFlag={openResegFlagsByEntry[entry.id] ?? null}
 onOpenResegDialog={onOpenResegDialog}
 onOpenCommentPrompt={
 onOpenEntryCommentPrompt
 ? () => onOpenEntryCommentPrompt(entry.id)
 : undefined
 }
 attachedCommentCount={
 commentCountByEntry_attached[entry.id] ?? 0
 }
 anchoredCommentCount={
 commentCountByEntry_anchored[entry.id] ?? 0
 }
 />
 );
 })()
 ) : item.kind === "comment" ? (
 <OutlineCommentCard
 comment={item.comment}
 replies={item.replies}
 entrySequence={item.entrySequence}
 ownerEntryId={item.entryId}
 volumeId={volumeId ?? ""}
 isHighlighted={
 urlSelectedCommentId === item.comment.id
 }
 isExpanded={expandedCommentIds.has(item.comment.id)}
 pageNumber={pageNumberByCommentId?.[item.comment.id]}
 onToggleExpand={() => {
 setExpandedCommentIds((prev) => {
 const next = new Set(prev);
 if (next.has(item.comment.id)) {
 next.delete(item.comment.id);
 } else {
 next.add(item.comment.id);
 }
 return next;
 });
 // Note: no `virtualizer.measure()` here — see resolved
 // debug session outline-scroll-snaps-back. ResizeObserver
 // installed by `measureElement` on the row wrapper picks
 // up the expand/collapse height change automatically.
 }}
 onScrollToRegion={onScrollToRegion}
 onReplyCreated={onDraftCreated}
 currentUserId={currentUserId}
 currentUserIsLead={currentUserIsLead}
 onEditComment={onEditComment}
 onDeleteComment={onDeleteComment}
 onResolveComment={onResolveComment}
 />
 ) : (
 // follow-up (2026-04-18): inline draft composer
 // sits as a sibling row under the owning entry.
 <InlineCommentComposer
 entryId={item.entryId}
 region={item.region}
 volumeId={volumeId ?? ""}
 onCancel={() => onCancelDraft?.()}
 onCreated={() => onDraftCreated?.()}
 />
 )}
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
 className="w-full rounded bg-indigo px-3 py-2 text-sm font-medium text-parchment hover:bg-indigo-deep"
 >
 {t("workflow:action.submit_for_review")}
 </button>
 )}

 {/* Cataloguer: sent back -- show reviewer comment and accept corrections */}
 {accessLevel === "edit" && volumeStatus === "sent_back" && (
 <div className="space-y-3">
 {reviewComment && (
 <div className="rounded border-l-2 border-madder bg-madder-tint p-3">
 <p className="text-xs font-medium text-madder-deep">{t("viewer:outline.reviewer_comment_label")}</p>
 <p className="mt-1 text-sm text-madder-deep">{reviewComment}</p>
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
 className="w-full rounded bg-indigo px-3 py-2 text-sm font-medium text-parchment hover:bg-indigo-deep disabled:opacity-50"
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
 className="flex-1 rounded bg-verdigris px-3 py-2 text-sm font-medium text-parchment hover:bg-verdigris-deep disabled:opacity-50"
 >
 {t("workflow:action.approve")}
 </button>
 <button
 onClick={() => setShowSendBackDialog(true)}
 disabled={workflowFetcher.state !== "idle"}
 className="flex-1 rounded border border-madder px-3 py-2 text-sm font-medium text-madder-deep hover:bg-madder-tint disabled:opacity-50"
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


