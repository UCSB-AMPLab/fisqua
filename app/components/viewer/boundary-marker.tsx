import { useState, useCallback } from "react";
import type { Entry } from "../../lib/boundary-types";
import { useDragOrClick } from "../../lib/drag-utils";

type BoundaryMarkerProps = {
  entry: Entry;
  sequenceLabel: string;
  top: number;
  width: number;
  onDelete: (entryId: string) => void;
  isFirstEntry: boolean;
  onDragStart?: (entryId: string) => void;
  onDragMove?: (clientY: number) => void;
  onDragEnd?: (entryId: string, clientY: number) => void;
  isDragFaded?: boolean;
};

/**
 * Boundary marker rendered at a position in the viewer.
 * Horizontal coloured line with a sequence badge.
 * Click to toggle delete popover, drag to move (unless first entry).
 */
export function BoundaryMarker({
  entry,
  sequenceLabel,
  top,
  width,
  onDelete,
  isFirstEntry,
  onDragStart,
  onDragMove,
  onDragEnd,
  isDragFaded,
}: BoundaryMarkerProps) {
  const [showPopover, setShowPopover] = useState(false);

  const handleClick = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      if (!isFirstEntry) {
        setShowPopover((prev) => !prev);
      }
    },
    [isFirstEntry]
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setShowPopover(false);
      onDelete(entry.id);
    },
    [entry.id, onDelete]
  );

  const canDrag = !isFirstEntry && !!onDragStart;

  const { handlePointerDown, handlePointerMove, handlePointerUp } = useDragOrClick({
    onDragStart: canDrag
      ? () => {
          setShowPopover(false);
          onDragStart?.(entry.id);
        }
      : undefined,
    onDragMove: canDrag
      ? (pos) => onDragMove?.(pos.y)
      : undefined,
    onDragEnd: canDrag
      ? (pos) => onDragEnd?.(entry.id, pos.y)
      : undefined,
    onClick: handleClick,
  });

  // Determine cursor style
  let cursor = "pointer";
  if (isFirstEntry) {
    cursor = "default";
  } else if (canDrag) {
    cursor = "grab";
  }

  return (
    <div
      style={{
        position: "absolute",
        top: top - 2,
        left: 0,
        width,
        height: 20,
        zIndex: 20,
        cursor,
        opacity: isDragFaded ? 0.3 : 1,
        transition: "opacity 0.15s ease",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {/* Sequence badge */}
      <div className="absolute left-2 top-1/2 z-30 flex -translate-y-1/2 items-center justify-center rounded-full bg-teal-600 px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm">
        {sequenceLabel}
        {/* Lock indicator for first entry */}
        {isFirstEntry && (
          <svg
            className="ml-1 h-2.5 w-2.5"
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-1.5V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z"
              clipRule="evenodd"
            />
          </svg>
        )}
      </div>

      {/* Horizontal line */}
      <div className="absolute left-16 right-0 top-1/2 -translate-y-1/2 border-t-[3px] border-teal-500" />

      {/* Delete popover */}
      {showPopover && !isFirstEntry && (
        <div
          className="absolute left-16 top-full z-40 mt-1 rounded-md border border-stone-200 bg-white px-3 py-2 shadow-lg"
          onClick={(e) => e.stopPropagation()}
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
  );
}
