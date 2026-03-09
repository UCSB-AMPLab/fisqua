import { useState, useCallback } from "react";
import type { Entry } from "../../lib/boundary-types";

type BoundaryMarkerProps = {
  entry: Entry;
  sequenceLabel: string;
  top: number;
  width: number;
  onDelete: (entryId: string) => void;
  isFirstEntry: boolean;
};

/**
 * Boundary marker rendered between pages.
 * Horizontal coloured line with a sequence badge.
 * Click to toggle delete popover.
 */
export function BoundaryMarker({
  entry,
  sequenceLabel,
  top,
  width,
  onDelete,
  isFirstEntry,
}: BoundaryMarkerProps) {
  const [showPopover, setShowPopover] = useState(false);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
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

  return (
    <div
      style={{
        position: "absolute",
        top: top - 2,
        left: 0,
        width,
        height: 20,
        zIndex: 20,
        cursor: isFirstEntry ? "default" : "pointer",
      }}
      onClick={handleClick}
    >
      {/* Sequence badge */}
      <div className="absolute left-2 top-1/2 z-30 flex -translate-y-1/2 items-center justify-center rounded-full bg-teal-600 px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm">
        {sequenceLabel}
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
