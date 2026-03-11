import { useTranslation } from "react-i18next";

type ViewerBarProps = {
  pageLabel: string;
  onZoomIn: () => void;
  onZoomOut: () => void;
};

export function ViewerBar({ pageLabel, onZoomIn, onZoomOut }: ViewerBarProps) {
  const { t } = useTranslation("viewer");

  return (
    <div className="flex h-8 shrink-0 items-center justify-between border-b border-stone-200 bg-stone-50 px-3">
      {/* Left: page label */}
      <span className="text-xs font-medium text-stone-500">{pageLabel}</span>

      {/* Right: zoom controls */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onZoomOut}
          className="flex h-6 w-6 items-center justify-center rounded text-stone-600 hover:bg-stone-200"
          aria-label={t("toolbar.zoom_out")}
        >
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12h-15" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onZoomIn}
          className="flex h-6 w-6 items-center justify-center rounded text-stone-600 hover:bg-stone-200"
          aria-label={t("toolbar.zoom_in")}
        >
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </button>
      </div>
    </div>
  );
}
