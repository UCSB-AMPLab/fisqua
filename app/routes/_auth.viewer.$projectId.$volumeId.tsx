import { useState, useEffect, useRef, useCallback } from "react";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { userContext } from "../context";
import { requireProjectRole } from "../lib/permissions.server";
import { loadEntries } from "../lib/entries.server";
import { volumes, volumePages } from "../db/schema";
import { IIIFViewer } from "../components/viewer/iiif-viewer";
import { ViewerBar } from "../components/viewer/viewer-bar";
import { ViewerTopBar } from "../components/viewer/viewer-top-bar";
import { OutlinePanel } from "../components/outline/outline-panel";
import { ResizableDivider } from "../components/outline/resizable-divider";
import { boundaryReducer, createInitialState } from "../lib/boundary-reducer";
import { useUndoableReducer } from "../lib/use-undoable-reducer";
import { useAutosave } from "../lib/use-autosave";
import type { Route } from "./+types/_auth.viewer.$projectId.$volumeId";

export async function loader({ params, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  // Lead-only access (admins bypass)
  await requireProjectRole(db, user.id, params.projectId, ["lead"], user.isAdmin);

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

  return { volume, pages, entries, projectId: params.projectId };
}

export type PageData = {
  position: number;
  label: string | null;
  imageUrl: string;
  width: number;
  height: number;
};

export default function ViewerRoute({ loaderData }: Route.ComponentProps) {
  const { volume, pages, entries, projectId } = loaderData;
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const viewerRef = useRef<{ zoomIn: () => void; zoomOut: () => void; scrollToPage: (index: number) => void; scrollToPosition: (pageIndex: number, yFraction: number) => void } | null>(null);

  // Boundary state management with undo/redo
  const { state, dispatch, canUndo, canRedo } = useUndoableReducer(
    boundaryReducer,
    createInitialState(entries)
  );
  const { saveStatus } = useAutosave(state, dispatch, volume.id);

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
            onPlaceBoundary={handlePlaceBoundary}
            onDeleteBoundary={handleDeleteBoundary}
            onMoveBoundary={handleMoveBoundary}
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
          />
        </div>
      </div>
    </div>
  );
}
