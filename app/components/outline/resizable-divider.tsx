import { useRef, useCallback } from "react";

type ResizableDividerProps = {
  onResize: (deltaX: number) => void;
};

export function ResizableDivider({ onResize }: ResizableDividerProps) {
  const startXRef = useRef(0);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      startXRef.current = e.clientX;
      (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
    },
    []
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!(e.target as HTMLDivElement).hasPointerCapture(e.pointerId)) return;
      const delta = startXRef.current - e.clientX;
      startXRef.current = e.clientX;
      onResize(delta);
    },
    [onResize]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      (e.target as HTMLDivElement).releasePointerCapture(e.pointerId);
    },
    []
  );

  return (
    <div
      className="w-1 shrink-0 cursor-col-resize bg-stone-300 transition-colors hover:bg-blue-400 active:bg-blue-400"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    />
  );
}
