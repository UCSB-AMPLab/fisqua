import { useCallback } from "react";

type PageGapProps = {
  pageNumber: number;
  onPlace: (startPage: number, startY: number) => void;
  top: number;
  width: number;
};

/**
 * Clickable gap area between pages where no boundary exists.
 * Shows a dashed line on hover to indicate "click to place boundary".
 * Hit area is 24px tall (larger than the visual gap) for comfortable clicking.
 * Clicking places a y=0 boundary (page-gap boundary).
 */
export function PageGap({ pageNumber, onPlace, top, width }: PageGapProps) {
  const handleClick = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      onPlace(pageNumber, 0);
    },
    [pageNumber, onPlace]
  );

  return (
    <div
      style={{
        position: "absolute",
        top: top - 8, // center 24px hit area on the gap
        left: 0,
        width,
        height: 24,
        zIndex: 10,
        cursor: "pointer",
      }}
      className="group"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={handleClick}
    >
      {/* Dashed line visible on hover */}
      <div
        className="pointer-events-none absolute left-16 right-0 top-1/2 -translate-y-1/2 border-t-2 border-dashed border-stone-300 opacity-0 transition-opacity group-hover:opacity-100"
      />
    </div>
  );
}
