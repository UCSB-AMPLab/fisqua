import {
  useRef,
  useEffect,
  useState,
  useMemo,
  useImperativeHandle,
  forwardRef,
} from "react";
import type { PageData } from "../../routes/_auth.viewer.$projectId.$volumeId";

// How many pages above/below the viewport to pre-render
const BUFFER_PAGES = 2;
const PAGE_GAP = 8; // px between pages
const DEFAULT_ZOOM = 0.5;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

type IIIFViewerProps = {
  pages: PageData[];
  onPageChange?: (pageIndex: number) => void;
};

export type IIIFViewerHandle = {
  zoomIn: () => void;
  zoomOut: () => void;
  scrollToPage: (index: number) => void;
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
  function IIIFViewer({ pages, onPageChange }, ref) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [zoom, setZoom] = useState(DEFAULT_ZOOM);
    const [visibleRange, setVisibleRange] = useState({ start: 0, end: 5 });
    const [containerWidth, setContainerWidth] = useState(800);
    const [osdReady, setOsdReady] = useState(false);
    const osdInstancesRef = useRef<Map<number, any>>(new Map());
    const lastPageIndexRef = useRef(0);
    const onPageChangeRef = useRef(onPageChange);
    onPageChangeRef.current = onPageChange;

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

    // Memoize page layouts — only recalculates when pages, width, or zoom change
    const layouts = useMemo(
      () => computeLayouts(pages, containerWidth, zoom),
      [pages, containerWidth, zoom]
    );

    const totalHeight = useMemo(() => {
      if (layouts.length === 0) return 0;
      const last = layouts[layouts.length - 1];
      return last.top + last.displayHeight;
    }, [layouts]);

    // Store layouts in a ref so scroll handler doesn't need to be recreated
    const layoutsRef = useRef(layouts);
    layoutsRef.current = layouts;

    // Scroll handler — uses refs to avoid dependency changes
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

        // Determine "current" page — the one most visible in viewport
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
    }, []); // Stable — uses refs for all changing data

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

    return (
      <div className="flex h-full w-full">
        {/* Page label gutter */}
        <div
          ref={scrollRef}
          className="h-full flex-1 overflow-y-auto bg-stone-100"
          style={{ scrollbarGutter: "stable" }}
        >
          <div style={{ height: totalHeight, position: "relative" }}>
            {layouts.map((layout, index) => {
              const isVisible =
                index >= visibleRange.start && index <= visibleRange.end;
              const page = pages[index];

              return (
                <div
                  key={page.position}
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
                    <div className="flex flex-1 justify-center">
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
                    </div>
                  </div>
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
      // Don't destroy here — let the parent manage lifecycle
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
