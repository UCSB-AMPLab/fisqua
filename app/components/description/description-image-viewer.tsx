import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";

type Page = {
  position: number;
  imageUrl: string;
  label: string | null;
  width: number;
  height: number;
};

type DescriptionImageViewerProps = {
  pages: Page[];
  currentEntryStartPage: number;
  currentEntryEndPage: number | null;
  manifestUrl?: string;
};

function ZoomOutIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}

function ZoomInIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="11" y1="8" x2="11" y2="14" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

export function DescriptionImageViewer({
  pages,
  currentEntryStartPage,
  currentEntryEndPage,
}: DescriptionImageViewerProps) {
  const { t } = useTranslation("description");
  const [zoom, setZoom] = useState(100);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const firstCurrentRef = useRef<HTMLDivElement>(null);

  const effectiveEndPage = currentEntryEndPage ?? currentEntryStartPage;

  const isCurrentPage = useCallback(
    (position: number) => {
      return position >= currentEntryStartPage && position <= effectiveEndPage;
    },
    [currentEntryStartPage, effectiveEndPage]
  );

  // Auto-scroll to first page of current entry on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      firstCurrentRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 100);
    return () => clearTimeout(timer);
  }, [currentEntryStartPage]);

  const handleZoomIn = useCallback(() => {
    setZoom((z) => Math.min(200, z + 25));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((z) => Math.max(25, z - 25));
  }, []);

  const handleFullscreen = useCallback(() => {
    if (panelRef.current) {
      panelRef.current.requestFullscreen?.();
    }
  }, []);

  return (
    <div ref={panelRef} className="flex h-full flex-col bg-[#F5F5F4]">
      {/* Zoom bar */}
      <div className="flex h-[48px] shrink-0 items-center gap-1 border-b border-[#E7E5E4] bg-white px-3">
        <button
          type="button"
          onClick={handleZoomOut}
          className="flex h-8 w-8 items-center justify-center rounded text-[#78716C] hover:bg-[#F5F5F4]"
          aria-label="Zoom out"
        >
          <ZoomOutIcon />
        </button>
        <span className="min-w-[3.5rem] text-center font-sans text-[0.875rem] text-[#78716C]">
          {zoom}%
        </span>
        <button
          type="button"
          onClick={handleZoomIn}
          className="flex h-8 w-8 items-center justify-center rounded text-[#78716C] hover:bg-[#F5F5F4]"
          aria-label="Zoom in"
        >
          <ZoomInIcon />
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={handleFullscreen}
          className="flex h-8 items-center gap-1.5 rounded px-2 text-[#78716C] hover:bg-[#F5F5F4]"
        >
          <MaximizeIcon />
          <span className="font-sans text-[0.875rem]">
            {t("editor.pantalla_completa")}
          </span>
        </button>
      </div>

      {/* Scrollable page display */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-8">
        <div
          className="mx-auto space-y-4"
          style={{ transform: `scale(${zoom / 100})`, transformOrigin: "top center" }}
        >
          {pages.map((page, idx) => {
            const isCurrent = isCurrentPage(page.position);
            const isFirst =
              isCurrent && page.position === currentEntryStartPage;
            return (
              <div
                key={page.position}
                ref={isFirst ? firstCurrentRef : undefined}
                className={`flex gap-4 ${isCurrent ? "" : "opacity-40"}`}
              >
                {/* Label column */}
                <div
                  className={`w-4 shrink-0 pt-1 font-sans text-[0.875rem] ${
                    isCurrent
                      ? "font-semibold text-[#14B8A6]"
                      : "text-[#A8A29E]"
                  }`}
                >
                  <span className="writing-mode-vertical whitespace-nowrap">
                    img {page.position}
                  </span>
                </div>

                {/* Page image */}
                <div
                  className={`overflow-hidden rounded-lg ${
                    isCurrent ? "border-2 border-[#14B8A6]" : ""
                  }`}
                >
                  <img
                    src={page.imageUrl}
                    alt={page.label || `Page ${page.position}`}
                    className="max-w-full"
                    loading="lazy"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
