import {
  useRef,
  useEffect,
  useState,
  useMemo,
  useImperativeHandle,
  useCallback,
  forwardRef,
} from "react";
import type { PageData } from "../../routes/_auth.viewer.$projectId.$volumeId";
import type { Entry } from "../../lib/boundary-types";
import { pointerToPagePosition, useAutoScroll } from "../../lib/drag-utils";
import type { PagePosition } from "../../lib/drag-utils";
import { MIN_Y_GAP } from "../../lib/boundary-reducer";
import { BoundaryMarker } from "./boundary-marker";
import { DragOverlay } from "./drag-overlay";
import { PageGap } from "./page-gap";

// How many pages above/below the viewport to pre-render
const BUFFER_PAGES = 2;
const PAGE_GAP = 20; // px between pages (increased for boundary marker hit area)
const DEFAULT_ZOOM = 0.5;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

type IIIFViewerProps = {
  pages: PageData[];
  onPageChange?: (pageIndex: number) => void;
  boundaries?: Entry[];
  onPlaceBoundary?: (startPage: number, startY: number) => void;
  onDeleteBoundary?: (entryId: string) => void;
  onMoveBoundary?: (entryId: string, startPage: number, startY: number) => void;
  /** Set of entry IDs that were modified by a reviewer (rendered with red variant). */
  reviewerModifiedIds?: Set<string>;
};

export type IIIFViewerHandle = {
  zoomIn: () => void;
  zoomOut: () => void;
  scrollToPage: (index: number) => void;
  scrollToPosition: (pageIndex: number, yFraction: number) => void;
};

function loadScript(src: string): Promise<void> {
  const existing = document.querySelector(`script[src="${src}"]`);
  if (existing) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}

type PageLayout = { top: number; displayHeight: number; scale: number };

function computeLayouts(pages: PageData[], containerWidth: number, zoom: number): PageLayout[] {
  let offset = 0;
  return pages.map((page) => {
    const scale = (containerWidth * zoom) / page.width;
    const displayHeight = page.height * scale;
    const top = offset;
    offset += displayHeight + PAGE_GAP;
    return { top, displayHeight, scale };
  });
}

export const IIIFViewer = forwardRef<IIIFViewerHandle, IIIFViewerProps>(
  function IIIFViewer({ pages, onPageChange, boundaries, onPlaceBoundary, onDeleteBoundary, onMoveBoundary, reviewerModifiedIds }, ref) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [zoom, setZoom] = useState(DEFAULT_ZOOM);
    const [visibleRange, setVisibleRange] = useState({ start: 0, end: 5 });
    const [containerWidth, setContainerWidth] = useState(800);
    const [osdReady, setOsdReady] = useState(false);
    const osdInstancesRef = useRef<Map<number, any>>(new Map());
    const lastPageIndexRef = useRef(0);
    const onPageChangeRef = useRef(onPageChange);
    onPageChangeRef.current = onPageChange;

    // Hover preview state: y-pixel position in absolute coordinates (null = not hovering)
    const [hoverPreviewTop, setHoverPreviewTop] = useState<number | null>(null);

    // Drag state for boundary drag-to-move
    const [dragState, setDragState] = useState<{
      entryId: string | null;
      ghostTop: number | null;
      isInvalid: boolean;
    }>({ entryId: null, ghostTop: null, isInvalid: false });

    // Auto-scroll during drag
    const { startAutoScroll, stopAutoScroll } = useAutoScroll(scrollRef);

    // Store boundary callbacks in refs to avoid recreating scroll handler
    const onPlaceBoundaryRef = useRef(onPlaceBoundary);
    onPlaceBoundaryRef.current = onPlaceBoundary;
    const onDeleteBoundaryRef = useRef(onDeleteBoundary);
    onDeleteBoundaryRef.current = onDeleteBoundary;
    const onMoveBoundaryRef = useRef(onMoveBoundary);
    onMoveBoundaryRef.current = onMoveBoundary;

    // Build boundary lookup: startPage -> Entry[] for multiple entries per page
    const boundaryMap = useMemo(() => {
      const map = new Map<number, Entry[]>();
      if (!boundaries) return map;
      for (const entry of boundaries) {
        if (!map.has(entry.startPage)) map.set(entry.startPage, []);
        map.get(entry.startPage)!.push(entry);
      }
      // Sort entries within each page by startY
      for (const entries of map.values()) {
        entries.sort((a, b) => a.startY - b.startY);
      }
      return map;
    }, [boundaries]);

    // Build sorted sibling position labels (position + 1)
    const sequenceLabels = useMemo(() => {
      const labels = new Map<string, string>();
      if (!boundaries) return labels;
      // Group by parentId for sibling numbering
      const groups = new Map<string | null, Entry[]>();
      for (const entry of boundaries) {
        const key = entry.parentId;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(entry);
      }
      for (const siblings of groups.values()) {
        siblings.sort((a, b) => a.position - b.position);
        for (const entry of siblings) {
          labels.set(entry.id, String(entry.position + 1));
        }
      }
      return labels;
    }, [boundaries]);

    // Memoize page layouts -- only recalculates when pages, width, or zoom change
    const layouts = useMemo(
      () => computeLayouts(pages, containerWidth, zoom),
      [pages, containerWidth, zoom]
    );

    // Load OpenSeadragon script
    useEffect(() => {
      loadScript("/vendor/openseadragon.min.js")
        .then(() => setOsdReady(true))
        .catch((err) => console.error(err));
    }, []);

    // Observe container width
    useEffect(() => {
      const el = scrollRef.current;
      if (!el) return;
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setContainerWidth(entry.contentRect.width);
        }
      });
      observer.observe(el);
      return () => observer.disconnect();
    }, []);

    const totalHeight = useMemo(() => {
      if (layouts.length === 0) return 0;
      const last = layouts[layouts.length - 1];
      return last.top + last.displayHeight;
    }, [layouts]);

    // Store layouts in a ref so scroll handler doesn't need to be recreated
    const layoutsRef = useRef(layouts);
    layoutsRef.current = layouts;

    // Scroll handler -- uses refs to avoid dependency changes
    useEffect(() => {
      const el = scrollRef.current;
      if (!el) return;

      function onScroll() {
        const currentLayouts = layoutsRef.current;
        if (currentLayouts.length === 0) return;

        const scrollTop = el!.scrollTop;
        const viewportHeight = el!.clientHeight;
        const scrollBottom = scrollTop + viewportHeight;

        let start = 0;
        let end = 0;

        for (let i = 0; i < currentLayouts.length; i++) {
          const { top, displayHeight } = currentLayouts[i];
          if (top + displayHeight >= scrollTop) {
            start = i;
            break;
          }
        }

        for (let i = start; i < currentLayouts.length; i++) {
          end = i;
          if (currentLayouts[i].top > scrollBottom) break;
        }

        const bufferedStart = Math.max(0, start - BUFFER_PAGES);
        const bufferedEnd = Math.min(currentLayouts.length - 1, end + BUFFER_PAGES);

        setVisibleRange((prev) => {
          if (prev.start === bufferedStart && prev.end === bufferedEnd) return prev;
          return { start: bufferedStart, end: bufferedEnd };
        });

        // Determine "current" page -- the one most visible in viewport
        let bestIndex = start;
        let bestOverlap = 0;
        for (let i = start; i <= end && i < currentLayouts.length; i++) {
          const { top, displayHeight } = currentLayouts[i];
          const overlapTop = Math.max(scrollTop, top);
          const overlapBottom = Math.min(scrollBottom, top + displayHeight);
          const overlap = Math.max(0, overlapBottom - overlapTop);
          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestIndex = i;
          }
        }

        if (bestIndex !== lastPageIndexRef.current) {
          lastPageIndexRef.current = bestIndex;
          onPageChangeRef.current?.(bestIndex);
        }
      }

      el.addEventListener("scroll", onScroll, { passive: true });
      // Initial calculation
      onScroll();
      return () => el.removeEventListener("scroll", onScroll);
    }, []); // Stable -- uses refs for all changing data

    // Re-trigger visible range calculation when layouts change (zoom/resize)
    useEffect(() => {
      const el = scrollRef.current;
      if (!el) return;
      // Dispatch a synthetic scroll to recalculate visible range
      el.dispatchEvent(new Event("scroll"));
    }, [layouts]);

    // Expose imperative handle
    useImperativeHandle(ref, () => ({
      zoomIn: () => setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP)),
      zoomOut: () => setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP)),
      scrollToPage: (index: number) => {
        const currentLayouts = layoutsRef.current;
        if (index >= 0 && index < currentLayouts.length && scrollRef.current) {
          scrollRef.current.scrollTo({ top: currentLayouts[index].top, behavior: "smooth" });
        }
      },
      scrollToPosition: (pageIndex: number, yFraction: number) => {
        const currentLayouts = layoutsRef.current;
        if (pageIndex >= 0 && pageIndex < currentLayouts.length && scrollRef.current) {
          const layout = currentLayouts[pageIndex];
          const targetTop = layout.top + yFraction * layout.displayHeight;
          scrollRef.current.scrollTo({ top: targetTop, behavior: "smooth" });
        }
      },
    }));

    // Expose scroll-to-page API on window for Phase 3 validation (VIEW-04)
    useEffect(() => {
      (window as any).__scrollToPage = (index: number) => {
        const currentLayouts = layoutsRef.current;
        if (index >= 0 && index < currentLayouts.length && scrollRef.current) {
          scrollRef.current.scrollTo({ top: currentLayouts[index].top, behavior: "smooth" });
        }
      };
      return () => {
        delete (window as any).__scrollToPage;
      };
    }, []);

    // Cleanup OSD instances that are out of range
    useEffect(() => {
      const instances = osdInstancesRef.current;
      for (const [idx, viewer] of instances.entries()) {
        if (idx < visibleRange.start || idx > visibleRange.end) {
          viewer.destroy();
          instances.delete(idx);
        }
      }
    }, [visibleRange]);

    // Cleanup all OSD instances on unmount
    useEffect(() => {
      return () => {
        for (const viewer of osdInstancesRef.current.values()) {
          viewer.destroy();
        }
        osdInstancesRef.current.clear();
      };
    }, []);

    // Click-to-place handler for page image overlays
    const handlePageOverlayClick = useCallback(
      (e: React.MouseEvent, pageIndex: number) => {
        if (!onPlaceBoundaryRef.current || !scrollRef.current) return;
        const layout = layoutsRef.current[pageIndex];
        if (!layout) return;

        const containerTop = scrollRef.current.getBoundingClientRect().top;
        const result = pointerToPagePosition(
          e.clientY,
          scrollRef.current.scrollTop,
          containerTop,
          layoutsRef.current,
          pages
        );

        if (result) {
          onPlaceBoundaryRef.current(result.pageNumber, result.yFraction);
        }
      },
      [pages]
    );

    // Hover preview handler for page image overlays
    const handlePageOverlayMouseMove = useCallback(
      (e: React.MouseEvent) => {
        if (!scrollRef.current) return;
        const containerTop = scrollRef.current.getBoundingClientRect().top;
        const absoluteY = e.clientY - containerTop + scrollRef.current.scrollTop;
        setHoverPreviewTop(absoluteY);
      },
      []
    );

    const handlePageOverlayMouseLeave = useCallback(() => {
      setHoverPreviewTop(null);
    }, []);

    // --- Drag-to-move handlers ---

    /**
     * Resolve a clientY to a page position, including gap areas.
     * If pointer is in a gap, targets the next page at y=0.
     */
    const resolveDropPosition = useCallback(
      (clientY: number): PagePosition | null => {
        if (!scrollRef.current) return null;
        const containerTop = scrollRef.current.getBoundingClientRect().top;
        const currentLayouts = layoutsRef.current;

        // First try: is the pointer on a page?
        const pagePos = pointerToPagePosition(
          clientY,
          scrollRef.current.scrollTop,
          containerTop,
          currentLayouts,
          pages
        );
        if (pagePos) return pagePos;

        // Pointer is in a gap -- find which gap
        const absoluteY = clientY - containerTop + scrollRef.current.scrollTop;
        for (let i = 0; i < currentLayouts.length - 1; i++) {
          const gapStart = currentLayouts[i].top + currentLayouts[i].displayHeight;
          const gapEnd = currentLayouts[i + 1].top;
          if (absoluteY >= gapStart && absoluteY < gapEnd) {
            return { pageNumber: pages[i + 1].position, yFraction: 0 };
          }
        }

        return null;
      },
      [pages]
    );

    /**
     * Validate whether a drag target position is valid for the given entry.
     * Checks: min gap, parent containment, parent-outside-children.
     */
    const isDragPositionValid = useCallback(
      (entryId: string, targetPage: number, targetY: number): boolean => {
        if (!boundaries) return true;
        const entry = boundaries.find(e => e.id === entryId);
        if (!entry) return false;

        // Min gap check: any other entry on the same page too close?
        for (const e of boundaries) {
          if (e.id === entryId) continue;
          if (e.startPage === targetPage && Math.abs(e.startY - targetY) < MIN_Y_GAP) {
            return false;
          }
        }

        // Child containment: if entry has a parent, must stay within parent range
        if (entry.parentId !== null) {
          const parent = boundaries.find(e => e.id === entry.parentId);
          if (parent) {
            // Child must be >= parent's (page, y)
            if (targetPage < parent.startPage) return false;
            if (targetPage === parent.startPage && targetY < parent.startY) return false;
          }
        }

        // Parent check: if entry has children, cannot move past its own children
        const children = boundaries.filter(e => e.parentId === entryId);
        if (children.length > 0) {
          const firstChild = children.reduce((min, c) => {
            if (c.startPage < min.startPage) return c;
            if (c.startPage === min.startPage && c.startY < min.startY) return c;
            return min;
          });
          // Parent must be <= first child's (page, y)
          if (targetPage > firstChild.startPage) return false;
          if (targetPage === firstChild.startPage && targetY > firstChild.startY) return false;
        }

        return true;
      },
      [boundaries]
    );

    const handleBoundaryDragStart = useCallback((entryId: string) => {
      setDragState({ entryId, ghostTop: null, isInvalid: false });
      setHoverPreviewTop(null); // hide hover preview during drag
    }, []);

    const handleBoundaryDragMove = useCallback(
      (clientY: number) => {
        if (!scrollRef.current) return;

        // Auto-scroll near edges
        startAutoScroll(clientY);

        const target = resolveDropPosition(clientY);
        if (!target) {
          // Outside all pages and gaps
          const containerTop = scrollRef.current.getBoundingClientRect().top;
          const absoluteY = clientY - containerTop + scrollRef.current.scrollTop;
          setDragState(prev => ({ ...prev, ghostTop: absoluteY, isInvalid: true }));
          return;
        }

        // Compute ghost pixel position
        const currentLayouts = layoutsRef.current;
        const pageIndex = pages.findIndex(p => p.position === target.pageNumber);
        if (pageIndex < 0) return;
        const layout = currentLayouts[pageIndex];

        let ghostTop: number;
        if (target.yFraction === 0 && pageIndex > 0) {
          ghostTop = layout.top - PAGE_GAP / 2;
        } else {
          ghostTop = layout.top + target.yFraction * layout.displayHeight;
        }

        const isInvalid = dragState.entryId
          ? !isDragPositionValid(dragState.entryId, target.pageNumber, target.yFraction)
          : true;

        setDragState(prev => ({ ...prev, ghostTop, isInvalid }));
      },
      [pages, startAutoScroll, resolveDropPosition, isDragPositionValid, dragState.entryId]
    );

    const handleBoundaryDragEnd = useCallback(
      (entryId: string, clientY: number) => {
        stopAutoScroll();

        const target = resolveDropPosition(clientY);
        if (target && isDragPositionValid(entryId, target.pageNumber, target.yFraction)) {
          onMoveBoundaryRef.current?.(entryId, target.pageNumber, target.yFraction);
        }
        // Reset drag state (snap back if invalid)
        setDragState({ entryId: null, ghostTop: null, isInvalid: false });
      },
      [resolveDropPosition, isDragPositionValid, stopAutoScroll]
    );

    return (
      <div className="flex h-full w-full">
        {/* Page label gutter */}
        <div
          ref={scrollRef}
          className="h-full flex-1 overflow-y-auto bg-stone-100"
          style={{ scrollbarGutter: "stable" }}
        >
          <div style={{ height: totalHeight, position: "relative" }}>
            {/* Drag ghost overlay */}
            {dragState.entryId && dragState.ghostTop !== null && (
              <DragOverlay
                visible={true}
                top={dragState.ghostTop}
                width={containerWidth}
                isInvalid={dragState.isInvalid}
              />
            )}
            {/* Hover preview dashed line (hidden during drag) */}
            {hoverPreviewTop !== null && !dragState.entryId && (
              <div
                style={{
                  position: "absolute",
                  top: hoverPreviewTop,
                  left: 0,
                  width: containerWidth,
                  height: 0,
                  zIndex: 15,
                  pointerEvents: "none",
                }}
              >
                <div className="absolute left-16 right-0 top-0 border-t-2 border-dashed border-teal-300 opacity-60" />
              </div>
            )}
            {layouts.map((layout, index) => {
              const isVisible =
                index >= visibleRange.start && index <= visibleRange.end;
              const page = pages[index];
              // Get all entries starting on this page
              const pageEntries = boundaryMap.get(page.position) || [];
              // The gap after this page (before next page)
              const nextPage = pages[index + 1];
              // Check if any y=0 boundary exists at the next page (page-gap boundary)
              const nextPageEntries = nextPage ? (boundaryMap.get(nextPage.position) || []) : [];
              const hasGapBoundary = nextPageEntries.some(e => e.startY === 0);
              const gapCenterY = layout.top + layout.displayHeight + PAGE_GAP / 2;

              return (
                <div key={page.position}>
                  {/* Boundary markers for all entries on this page */}
                  {pageEntries.map((entry) => {
                    const isFirstEntry = entry.position === 0 && entry.parentId === null;
                    let markerTop: number;

                    if (entry.startY === 0 && index > 0) {
                      // y=0 entries on pages after the first: position in the gap
                      markerTop = layout.top - PAGE_GAP / 2;
                    } else if (entry.startY === 0 && index === 0) {
                      // First page, y=0: position at top of page
                      markerTop = layout.top;
                    } else {
                      // Within-page: position at the y-fraction of the page
                      markerTop = layout.top + entry.startY * layout.displayHeight;
                    }

                    return (
                      <BoundaryMarker
                        key={entry.id}
                        entry={entry}
                        sequenceLabel={sequenceLabels.get(entry.id) || "?"}
                        top={markerTop}
                        width={containerWidth}
                        onDelete={(entryId) => onDeleteBoundaryRef.current?.(entryId)}
                        isFirstEntry={isFirstEntry}
                        onDragStart={handleBoundaryDragStart}
                        onDragMove={handleBoundaryDragMove}
                        onDragEnd={handleBoundaryDragEnd}
                        isDragFaded={dragState.entryId === entry.id}
                        variant={reviewerModifiedIds?.has(entry.id) ? "reviewer" : "cataloguer"}
                      />
                    );
                  })}
                  {/* Page slot */}
                  <div
                    style={{
                      position: "absolute",
                      top: layout.top,
                      height: layout.displayHeight,
                      width: "100%",
                    }}
                  >
                    <div className="flex h-full">
                      {/* Label gutter */}
                      <div className="flex w-16 shrink-0 items-start justify-end pr-3 pt-2">
                        <span className="text-xs font-medium text-stone-500">
                          {page.label || page.position}
                        </span>
                      </div>
                      {/* Page image */}
                      <div className="relative flex flex-1 justify-center">
                        <div
                          style={{
                            width: page.width * layout.scale,
                            height: layout.displayHeight,
                          }}
                        >
                          {isVisible && osdReady ? (
                            <OSDPage
                              page={page}
                              width={page.width * layout.scale}
                              height={layout.displayHeight}
                              instancesRef={osdInstancesRef}
                              index={index}
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center bg-stone-200 text-xs text-stone-400">
                              {page.label || `Page ${page.position}`}
                            </div>
                          )}
                        </div>
                        {/* Transparent click overlay for within-page boundary placement */}
                        {onPlaceBoundaryRef.current && (
                          <div
                            style={{
                              position: "absolute",
                              top: 0,
                              left: 0,
                              width: "100%",
                              height: "100%",
                              zIndex: 15,
                              cursor: "crosshair",
                            }}
                            onClick={(e) => handlePageOverlayClick(e, index)}
                            onMouseMove={handlePageOverlayMouseMove}
                            onMouseLeave={handlePageOverlayMouseLeave}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                  {/* Gap between pages: PageGap (clickable) or nothing if y=0 boundary exists at next page */}
                  {nextPage && !hasGapBoundary && onPlaceBoundaryRef.current && (
                    <PageGap
                      pageNumber={nextPage.position}
                      onPlace={(startPage, startY) => onPlaceBoundaryRef.current?.(startPage, startY)}
                      top={gapCenterY}
                      width={containerWidth}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }
);

// Individual page rendered with OpenSeadragon
function OSDPage({
  page,
  width,
  height,
  instancesRef,
  index,
}: {
  page: PageData;
  width: number;
  height: number;
  instancesRef: React.MutableRefObject<Map<number, any>>;
  index: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !(window as any).OpenSeadragon) return;

    // Don't re-create if already exists
    if (instancesRef.current.has(index)) return;

    const viewer = new (window as any).OpenSeadragon({
      element: el,
      tileSources: `${page.imageUrl}/info.json`,
      showNavigationControl: false,
      animationTime: 0.3,
      immediateRender: true,
      minZoomImageRatio: 1,
      maxZoomPixelRatio: 4,
      visibilityRatio: 1,
      constrainDuringPan: true,
      gestureSettingsMouse: {
        scrollToZoom: false,
        clickToZoom: false,
        dblClickToZoom: true,
        dragToPan: true,
      },
      gestureSettingsTouch: {
        pinchToZoom: true,
        dragToPan: true,
      },
      crossOriginPolicy: "Anonymous",
    });

    // Disable OSD's inner scroll handler so page scroll works normally
    viewer.innerTracker.scrollHandler = false;

    instancesRef.current.set(index, viewer);

    return () => {
      // Don't destroy here -- let the parent manage lifecycle
    };
  }, [page.imageUrl, index, instancesRef]);

  return (
    <div
      ref={containerRef}
      style={{ width, height }}
      className="bg-white shadow-sm"
    />
  );
}
