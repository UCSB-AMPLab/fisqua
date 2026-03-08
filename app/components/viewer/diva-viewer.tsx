import { useRef, useEffect, useState } from "react";

type DivaViewerProps = {
  manifestUrl: string;
  onPageChange?: (pageIndex: number) => void;
  divaRef?: React.MutableRefObject<any>;
};

function loadScript(src: string): Promise<void> {
  // Check if already loaded
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

function loadStylesheet(href: string): void {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

export function DivaViewer({ manifestUrl, onPageChange, divaRef: externalDivaRef }: DivaViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const internalDivaRef = useRef<any>(null);
  const divaRef = externalDivaRef || internalDivaRef;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let destroyed = false;

    async function init() {
      try {
        // Load stylesheet
        loadStylesheet("/diva/diva.css");

        // Load scripts in order: OpenSeadragon must load before diva.js
        await loadScript("/diva/openseadragon.min.js");
        await loadScript("/diva/diva.js");

        if (destroyed || !containerRef.current) return;

        const Diva = (window as any).Diva;
        if (!Diva) {
          setError("Diva.js failed to initialise");
          return;
        }

        // Instantiate diva.js with the manifest URL
        divaRef.current = new Diva(containerRef.current.id, {
          objectData: manifestUrl,
        });

        // Expose scroll-to-page API for Phase 3 validation (VIEW-04)
        (window as any).__divaScrollToPage = (pageIndex: number) => {
          divaRef.current?.app?.ports?.scrollToIndex?.send(pageIndex);
        };

        setLoading(false);
      } catch (err) {
        if (!destroyed) {
          setError(err instanceof Error ? err.message : "Failed to load viewer");
        }
      }
    }

    init();

    return () => {
      destroyed = true;
      divaRef.current?.destroy?.();
      divaRef.current = null;
      delete (window as any).__divaScrollToPage;
    };
  }, [manifestUrl]);

  // Listen for page changes from diva.js
  useEffect(() => {
    if (!onPageChange) return;

    const container = containerRef.current;
    if (!container) return;

    function handlePageChange(event: Event) {
      const customEvent = event as CustomEvent;
      if (customEvent.detail?.pageIndex !== undefined) {
        onPageChange!(customEvent.detail.pageIndex);
      }
    }

    // diva.js v7 dispatches events on the container element
    container.addEventListener("diva-page-change", handlePageChange);

    return () => {
      container.removeEventListener("diva-page-change", handlePageChange);
    };
  }, [onPageChange]);

  return (
    <div className="relative h-full w-full">
      {loading && !error && (
        <div className="flex h-full items-center justify-center text-sm text-stone-500">
          Loading viewer...
        </div>
      )}
      {error && (
        <div className="flex h-full items-center justify-center text-sm text-red-600">
          {error}
        </div>
      )}
      <div
        id="diva-wrapper"
        ref={containerRef}
        className="h-full w-full"
      />
    </div>
  );
}
