/**
 * Resizable Pane
 *
 * Two-pane split layout with a draggable divider. Used to balance the
 * IIIF viewer and the description form in the editor.
 *
 * @version v0.3.0
 */

import { useState, useRef, type ReactNode, type PointerEvent } from "react";

interface ResizablePaneProps {
  left: ReactNode;
  right: ReactNode;
  defaultSplit?: number;
  minLeftWidth?: number;
  minRightWidth?: number;
}

export function ResizablePane({
  left,
  right,
  defaultSplit = 60,
  minLeftWidth = 400,
  minRightWidth = 300,
}: ResizablePaneProps) {
  const [splitPercent, setSplitPercent] = useState(defaultSplit);
  const containerRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startSplit = splitPercent;
    const container = containerRef.current;
    if (!container) return;
    const containerWidth = container.offsetWidth;

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const newSplit = startSplit + (dx / containerWidth) * 100;
      const minLeft = (minLeftWidth / containerWidth) * 100;
      const maxLeft = 100 - (minRightWidth / containerWidth) * 100;
      const clamped = Math.max(minLeft, Math.min(maxLeft, newSplit));
      setSplitPercent(clamped);
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  return (
    <div
      ref={containerRef}
      className="flex h-[calc(100vh-12rem)]"
    >
      {/* Left pane */}
      <div
        className="overflow-y-auto p-6"
        style={{ flexBasis: `${splitPercent}%`, minWidth: `${minLeftWidth}px` }}
      >
        {left}
      </div>

      {/* Drag handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        className="w-2 flex-none cursor-col-resize bg-stone-200 hover:bg-stone-400"
        onPointerDown={handlePointerDown}
      />

      {/* Right pane */}
      <div
        className="flex-1 overflow-y-auto border-l border-stone-200 bg-stone-100"
        style={{ minWidth: `${minRightWidth}px`, maxWidth: "60%" }}
      >
        {right}
      </div>
    </div>
  );
}
