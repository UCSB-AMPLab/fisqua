import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRevalidator } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { userContext } from "../context";
import { requireProjectRole, requireVolumeAccess } from "../lib/permissions.server";
import { loadEntries } from "../lib/entries.server";
import { getCommentsForVolume } from "../lib/comments.server";
import { volumes, volumePages } from "../db/schema";
import { IIIFViewer } from "../components/viewer/iiif-viewer";
import { ViewerBar } from "../components/viewer/viewer-bar";
import { ViewerTopBar } from "../components/viewer/viewer-top-bar";
import { OutlinePanel } from "../components/outline/outline-panel";
import { ResizableDivider } from "../components/outline/resizable-divider";
import { boundaryReducer, createInitialState } from "../lib/boundary-reducer";
import { useUndoableReducer, type UndoRedoAction } from "../lib/use-undoable-reducer";
import { useAutosave } from "../lib/use-autosave";
import type { BoundaryAction } from "../lib/boundary-types";
import type { Route } from "./+types/_auth.viewer.$projectId.$volumeId";

export async function loader({ params, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  // Any project member can access the viewer (access level determined by role + assignment)
  const memberships = await requireProjectRole(
    db, user.id, params.projectId,
    ["lead", "cataloguer", "reviewer"],
    user.isAdmin
  );

  // Fetch volume, verify it belongs to this project
  const volume = await db
    .select()
    .from(volumes)
    .where(
      and(eq(volumes.id, params.volumeId), eq(volumes.projectId, params.projectId))
    )
    .get();

  if (!volume) {
    throw new Response("Volume not found", { status: 404 });
  }

  // Determine user's role on this project (highest privilege: lead > reviewer > cataloguer)
  const roleOrder = ["lead", "reviewer", "cataloguer"] as const;
  const userRole = memberships.length > 0
    ? roleOrder.find((r) => memberships.some((m) => m.role === r)) ?? "cataloguer"
    : "cataloguer";

  // Determine access level (edit, review, readonly)
  const accessLevel = requireVolumeAccess(user.id, volume, userRole, user.isAdmin);

  // Fetch pages with dimensions for virtualised viewer
  const pages = await db
    .select({
      position: volumePages.position,
      label: volumePages.label,
      imageUrl: volumePages.imageUrl,
      width: volumePages.width,
      height: volumePages.height,
    })
    .from(volumePages)
    .where(eq(volumePages.volumeId, params.volumeId))
    .orderBy(volumePages.position)
    .all();

  // Load entries for boundary state
  const entries = await loadEntries(db, params.volumeId);

  // Load comments for all entries in the volume
  const commentsMap = await getCommentsForVolume(db, params.volumeId);

  return {
    volume,
    pages,
    entries,
    commentsMap,
    projectId: params.projectId,
    accessLevel,
    userRole,
    userId: user.id,
  };
}

export type PageData = {
  position: number;
  label: string | null;
  imageUrl: string;
  width: number;
  height: number;
};

export default function ViewerRoute({ loaderData }: Route.ComponentProps) {
  const { volume, pages, entries, commentsMap, projectId, accessLevel, userRole, userId } = loaderData;
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [viewportYFraction, setViewportYFraction] = useState(0);
  const viewerRef = useRef<{ zoomIn: () => void; zoomOut: () => void; scrollToPage: (index: number) => void; scrollToPosition: (pageIndex: number, yFraction: number) => void } | null>(null);

  // Boundary state management with undo/redo
  const { state, dispatch: rawDispatch, canUndo, canRedo } = useUndoableReducer(
    boundaryReducer,
    createInitialState(entries)
  );

  /** Actions that don't carry modifiedBy (meta/control actions). */
  const META_ACTIONS = new Set(["INIT", "MARK_SAVED", "MARK_SAVING", "MARK_DIRTY", "UNDO", "REDO"]);

  // Wrap dispatch to inject modifiedBy when the user is a reviewer
  const dispatch = useCallback(
    (action: BoundaryAction | UndoRedoAction) => {
      if (accessLevel === "review" && !META_ACTIONS.has(action.type)) {
        rawDispatch({ ...action, modifiedBy: userId } as BoundaryAction);
      } else {
        rawDispatch(action);
      }
    },
    [rawDispatch, accessLevel, userId]
  );

  const { saveStatus } = useAutosave(state, rawDispatch, volume.id);
  const revalidator = useRevalidator();
  const handleCommentAdded = useCallback(() => {
    revalidator.revalidate();
  }, [revalidator]);

  // Compute the set of reviewer-modified entry IDs
  const reviewerModifiedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of state.entries) {
      if (entry.modifiedBy !== null && entry.modifiedBy !== volume.assignedTo) {
        ids.add(entry.id);
      }
    }
    return ids;
  }, [state.entries, volume.assignedTo]);

  // Undo/redo keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "UNDO" });
      } else if (e.key === "z" && e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "REDO" });
      } else if (e.key === "y" && !e.metaKey) {
        // Ctrl+Y only (not Cmd+Y on macOS)
        e.preventDefault();
        dispatch({ type: "REDO" });
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dispatch]);

  const handlePageChange = useCallback((pageIndex: number) => {
    setCurrentPageIndex(pageIndex);
  }, []);

  const handlePlaceBoundary = useCallback((startPage: number, startY: number) => {
    dispatch({ type: "ADD_BOUNDARY", startPage, startY });
  }, []);

  const handleMoveBoundary = useCallback((entryId: string, startPage: number, startY: number) => {
    dispatch({ type: "MOVE_BOUNDARY", entryId, startPage, toY: startY });
  }, []);

  const handleDeleteBoundary = useCallback((entryId: string) => {
    dispatch({ type: "DELETE_BOUNDARY", entryId });
  }, []);

  const handleZoomIn = useCallback(() => {
    viewerRef.current?.zoomIn();
  }, []);

  const handleZoomOut = useCallback(() => {
    viewerRef.current?.zoomOut();
  }, []);

  const handleUndo = useCallback(() => {
    dispatch({ type: "UNDO" });
  }, [dispatch]);

  const handleRedo = useCallback(() => {
    dispatch({ type: "REDO" });
  }, [dispatch]);

  // Resizable panel width
  const MIN_PANEL = 280;
  const MAX_PANEL = 720;
  const [panelWidth, setPanelWidth] = useState(480);

  const handleResize = useCallback((deltaX: number) => {
    setPanelWidth((w) => Math.min(MAX_PANEL, Math.max(MIN_PANEL, w + deltaX)));
  }, []);

  const currentPage = pages[currentPageIndex];
  const pageLabel = currentPage?.label || String(currentPage?.position ?? 1);

  return (
    <div className="flex h-screen flex-col">
      <ViewerTopBar
        volumeName={volume.name}
        projectId={projectId}
        saveStatus={saveStatus}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={handleUndo}
        onRedo={handleRedo}
      />
      <div className="flex flex-1 overflow-hidden">
        {/* Viewer panel */}
        <div className="relative flex flex-1 flex-col overflow-hidden">
          <ViewerBar
            pageLabel={pageLabel}
            onZoomIn={handleZoomIn}
            onZoomOut={handleZoomOut}
          />
          <IIIFViewer
            pages={pages}
            onPageChange={handlePageChange}
            ref={viewerRef}
            boundaries={state.entries}
            onPlaceBoundary={accessLevel !== "readonly" ? handlePlaceBoundary : undefined}
            onDeleteBoundary={accessLevel !== "readonly" ? handleDeleteBoundary : undefined}
            onMoveBoundary={accessLevel !== "readonly" ? handleMoveBoundary : undefined}
            reviewerModifiedIds={reviewerModifiedIds}
            onYFractionChange={setViewportYFraction}
          />
        </div>

        {/* Resizable divider */}
        <ResizableDivider onResize={handleResize} />

        {/* Outline panel */}
        <div className="shrink-0" style={{ width: panelWidth }}>
          <OutlinePanel
            entries={state.entries}
            volumeRefCode={volume.referenceCode}
            currentPageIndex={currentPageIndex}
            totalPages={pages.length}
            onScrollToEntry={(pageIndex, yFraction) => viewerRef.current?.scrollToPosition(pageIndex, yFraction)}
            dispatch={dispatch}
            accessLevel={accessLevel}
            assignedTo={volume.assignedTo}
            volumeStatus={volume.status}
            volumeId={volume.id}
            volumeName={volume.name}
            projectId={projectId}
            reviewComment={volume.reviewComment}
            viewportYFraction={viewportYFraction}
            commentsMap={commentsMap}
            onCommentAdded={handleCommentAdded}
          />
        </div>
      </div>
    </div>
  );
}
