import { useState, useCallback, useRef } from "react";
import type { Entry } from "../../lib/boundary-types";

type BoundaryMarkerProps = {
  entry: Entry;
  sequenceLabel: string;
  top: number;
  width: number;
  onMove: (entryId: string, toPage: number) => void;
  onDelete: (entryId: string) => void;
  isFirstEntry: boolean;
  validGapPositions: number[];
  /** Map from page number to the gap's Y position (top) for drag snapping */
  gapPositionMap: Map<number, number>;
  /** Scroll container ref for coordinate translation during drag */
  scrollContainerRef: React.RefObject<HTMLElement | null>;
};

/**
 * Boundary marker rendered between pages.
 * Horizontal coloured line with a sequence badge.
 * Click to toggle delete popover, drag to move to another gap.
 */
export function BoundaryMarker({
  entry,
  sequenceLabel,
  top,
  width,
  onMove,
  onDelete,
  isFirstEntry,
  validGapPositions,
  gapPositionMap,
  scrollContainerRef,
}: BoundaryMarkerProps) {
  const [showPopover, setShowPopover] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [ghostTop, setGhostTop] = useState<number | null>(null);
  const dragTargetPage = useRef<number | null>(null);
  const markerRef = useRef<HTMLDivElement>(null);

  const handleClick = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      if (!isDragging) {
        setShowPopover((prev) => !prev);
      }
    },
    [isDragging]
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setShowPopover(false);
      onDelete(entry.id);
    },
    [entry.id, onDelete]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only drag on left button, and not the first entry
      if (e.button !== 0 || isFirstEntry) return;
      e.stopPropagation();
      e.preventDefault();

      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);

      setIsDragging(true);
      setShowPopover(false);
      dragTargetPage.current = null;
    },
    [isFirstEntry]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging) return;
      e.stopPropagation();
      e.preventDefault();

      const scrollEl = scrollContainerRef.current;
      if (!scrollEl) return;

      // Convert pointer position to scroll-relative Y
      const rect = scrollEl.getBoundingClientRect();
      const y = e.clientY - rect.top + scrollEl.scrollTop;

      // Find the nearest valid gap position
      let bestPage = validGapPositions[0];
      let bestDist = Infinity;

      for (const page of validGapPositions) {
        const gapY = gapPositionMap.get(page);
        if (gapY === undefined) continue;
        const dist = Math.abs(y - gapY);
        if (dist < bestDist) {
          bestDist = dist;
          bestPage = page;
        }
      }

      dragTargetPage.current = bestPage;
      const snapY = gapPositionMap.get(bestPage);
      if (snapY !== undefined) {
        setGhostTop(snapY);
      }
    },
    [isDragging, validGapPositions, gapPositionMap, scrollContainerRef]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging) return;
      e.stopPropagation();
      e.preventDefault();

      const el = e.currentTarget as HTMLElement;
      el.releasePointerCapture(e.pointerId);

      setIsDragging(false);
      setGhostTop(null);

      if (
        dragTargetPage.current !== null &&
        dragTargetPage.current !== entry.startPage
      ) {
        onMove(entry.id, dragTargetPage.current);
      }
      dragTargetPage.current = null;
    },
    [isDragging, entry.id, entry.startPage, onMove]
  );

  return (
    <>
      {/* Main marker */}
      <div
        ref={markerRef}
        style={{
          position: "absolute",
          top: top - 2, // center 3px line on gap center
          left: 0,
          width,
          height: 20,
          zIndex: 20,
          cursor: isFirstEntry ? "default" : "grab",
          touchAction: "none",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sequence badge */}
        <div className="absolute left-2 top-1/2 z-30 flex -translate-y-1/2 items-center justify-center rounded-full bg-teal-600 px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm">
          {sequenceLabel}
        </div>

        {/* Horizontal line */}
        <div className="absolute left-16 right-0 top-1/2 -translate-y-1/2 border-t-[3px] border-teal-500" />

        {/* Click target (covers the full width for click-to-select) */}
        <div
          className="absolute inset-0"
          onPointerUp={handleClick}
        />

        {/* Delete popover */}
        {showPopover && !isFirstEntry && (
          <div
            className="absolute left-16 top-full z-40 mt-1 rounded-md border border-stone-200 bg-white px-3 py-2 shadow-lg"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="whitespace-nowrap text-sm text-red-600 hover:text-red-800"
              onClick={handleDelete}
            >
              Eliminar limite
            </button>
          </div>
        )}
      </div>

      {/* Ghost line during drag */}
      {isDragging && ghostTop !== null && (
        <div
          style={{
            position: "absolute",
            top: ghostTop - 2,
            left: 64, // after gutter
            right: 0,
            height: 3,
            zIndex: 50,
            pointerEvents: "none",
          }}
          className="border-t-[3px] border-dashed border-teal-400 opacity-70"
        />
      )}
    </>
  );
}
