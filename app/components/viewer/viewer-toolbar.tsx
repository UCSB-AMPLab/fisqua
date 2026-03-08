type ViewerToolbarProps = {
  onZoomIn: () => void;
  onZoomOut: () => void;
};

export function ViewerToolbar({ onZoomIn, onZoomOut }: ViewerToolbarProps) {
  return (
    <div className="absolute bottom-4 right-4 z-10 flex flex-col gap-1">
      <button
        type="button"
        onClick={onZoomIn}
        className="flex h-8 w-8 items-center justify-center rounded bg-white/80 text-stone-700 shadow hover:bg-white"
        aria-label="Zoom in"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
      </button>
      <button
        type="button"
        onClick={onZoomOut}
        className="flex h-8 w-8 items-center justify-center rounded bg-white/80 text-stone-700 shadow hover:bg-white"
        aria-label="Zoom out"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12h-15" />
        </svg>
      </button>
    </div>
  );
}
