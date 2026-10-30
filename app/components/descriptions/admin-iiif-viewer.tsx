/**
 * Admin IIIF Viewer
 *
 * This component is the OpenSeadragon viewer embedded in the admin
 * description editor. Renders IIIF tiles at the manifest URL stored on the
 * description and provides basic zoom and page controls. Lighter than the
 * main cataloguing viewer — no boundary editing, no virtualised continuous
 * scroll — because the admin editor only needs to browse the images that
 * back a single ISAD(G) record.
 *
 * The viewer can open at a given page. `initialCanvas` is a 1-based
 * canvas number, taken by the description page from its `?page=` value
 * (`parsePageParam`), which is how a transcript hit links to the image
 * it was read from. Once the manifest has loaded, the viewer shows that
 * canvas, or the last one when the number runs past the end
 * (`initialCanvasIndex`).
 *
 * @version v0.8.0
 */

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

type CanvasInfo = {
  label: string;
  imageUrl: string;
};

function parseManifest(data: unknown): CanvasInfo[] {
  // Support IIIF Presentation API 2.x and 3.0 manifests
  const manifest = data as Record<string, unknown>;
  const canvases: CanvasInfo[] = [];

  // Try v3 first (items array)
  const items = manifest.items as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(items)) {
    for (const canvas of items) {
      const label = extractLabel(canvas.label);
      const imageUrl = extractImageUrlV3(canvas);
      if (imageUrl) canvases.push({ label, imageUrl });
    }
    return canvases;
  }

  // Try v2 (sequences[0].canvases)
  const sequences = manifest.sequences as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(sequences) && sequences.length > 0) {
    const v2Canvases = sequences[0].canvases as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(v2Canvases)) {
      for (const canvas of v2Canvases) {
        const label =
          typeof canvas.label === "string" ? canvas.label : `Page`;
        const imageUrl = extractImageUrlV2(canvas);
        if (imageUrl) canvases.push({ label, imageUrl });
      }
    }
  }

  return canvases;
}

function extractLabel(label: unknown): string {
  if (typeof label === "string") return label;
  if (label && typeof label === "object") {
    // v3 label is { "en": ["..."], "es": ["..."] }
    const obj = label as Record<string, string[]>;
    const values = Object.values(obj);
    if (values.length > 0 && Array.isArray(values[0]) && values[0].length > 0) {
      return values[0][0];
    }
  }
  return "Page";
}

function extractImageUrlV3(canvas: Record<string, unknown>): string | null {
  const items = canvas.items as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(items) || items.length === 0) return null;
  const annoPage = items[0];
  const annotations = annoPage.items as
    | Array<Record<string, unknown>>
    | undefined;
  if (!Array.isArray(annotations) || annotations.length === 0) return null;
  const body = annotations[0].body as Record<string, unknown> | undefined;
  if (!body) return null;
  const id = (body.id ?? body["@id"]) as string | undefined;
  return id ?? null;
}

function extractImageUrlV2(canvas: Record<string, unknown>): string | null {
  const images = canvas.images as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(images) || images.length === 0) return null;
  const resource = images[0].resource as Record<string, unknown> | undefined;
  if (!resource) return null;
  const id = (resource["@id"] ?? resource.id) as string | undefined;
  return id ?? null;
}

/**
 * A `?page=` value as a 1-based canvas number, or undefined when it is
 * missing or not a positive whole number.
 */
export function parsePageParam(raw: string | null): number | undefined {
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= 1 && Number.isSafeInteger(n) ? n : undefined;
}

/**
 * The 0-based canvas to show first: `initialCanvas` (1-based) clamped
 * to the manifest, or the first canvas when no usable number is given.
 */
export function initialCanvasIndex(
  initialCanvas: number | undefined,
  canvasCount: number,
): number {
  if (canvasCount <= 0) return 0;
  if (initialCanvas === undefined || !Number.isFinite(initialCanvas) || initialCanvas < 1) {
    return 0;
  }
  return Math.min(Math.floor(initialCanvas), canvasCount) - 1;
}

interface AdminIiifViewerProps {
  manifestUrl: string;
  /** 1-based canvas to open at once the manifest loads. */
  initialCanvas?: number;
}

export function AdminIiifViewer({ manifestUrl, initialCanvas }: AdminIiifViewerProps) {
  const { t } = useTranslation("descriptions_admin");
  const [canvases, setCanvases] = useState<CanvasInfo[]>([]);
  const [currentPage, setCurrentPage] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(manifestUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        const parsed = parseManifest(data);
        if (parsed.length === 0) {
          setError("empty_manifest");
        } else {
          setCanvases(parsed);
          setCurrentPage(initialCanvasIndex(initialCanvas, parsed.length));
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError("manifest_load_error");
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // The manifest is fetched once per URL; a later change of
    // initialCanvas is handled by the effect below, without a refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifestUrl]);

  // A new `?page=` on the same manifest moves the viewer to that page.
  useEffect(() => {
    if (canvases.length === 0) return;
    setCurrentPage(initialCanvasIndex(initialCanvas, canvases.length));
  }, [initialCanvas, canvases.length]);

  const handleZoomIn = useCallback(() => {
    setZoom((z) => Math.min(200, z + 25));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((z) => Math.max(25, z - 25));
  }, []);

  const handlePrev = useCallback(() => {
    setCurrentPage((p) => Math.max(0, p - 1));
  }, []);

  const handleNext = useCallback(() => {
    setCurrentPage((p) => Math.min(canvases.length - 1, p + 1));
  }, [canvases.length]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-stone-100">
        <p className="text-sm text-stone-500">{t("loading_manifest")}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-stone-100">
        <p className="text-sm text-stone-500">{t(error)}</p>
      </div>
    );
  }

  const canvas = canvases[currentPage];
  if (!canvas) return null;

  return (
    <div className="flex h-full flex-col bg-stone-100">
      {/* Toolbar */}
      <div className="flex h-[48px] shrink-0 items-center gap-1 border-b border-stone-200 bg-white px-3">
        <button
          type="button"
          onClick={handleZoomOut}
          className="flex h-8 w-8 items-center justify-center rounded text-stone-500 hover:bg-stone-100"
          aria-label={t("zoom_out")}
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <span className="min-w-[3.5rem] text-center font-sans text-sm text-stone-500">
          {zoom}%
        </span>
        <button
          type="button"
          onClick={handleZoomIn}
          className="flex h-8 w-8 items-center justify-center rounded text-stone-500 hover:bg-stone-100"
          aria-label={t("zoom_in")}
        >
          <ZoomIn className="h-4 w-4" />
        </button>

        <div className="mx-2 h-5 w-px bg-stone-200" />

        {/* Page navigation */}
        <button
          type="button"
          onClick={handlePrev}
          disabled={currentPage === 0}
          className="flex h-8 w-8 items-center justify-center rounded text-stone-500 hover:bg-stone-100 disabled:opacity-30"
          aria-label={t("prev_page")}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="min-w-[4rem] text-center font-sans text-sm text-stone-500">
          {currentPage + 1} / {canvases.length}
        </span>
        <button
          type="button"
          onClick={handleNext}
          disabled={currentPage === canvases.length - 1}
          className="flex h-8 w-8 items-center justify-center rounded text-stone-500 hover:bg-stone-100 disabled:opacity-30"
          aria-label={t("next_page")}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* Image display */}
      <div className="flex-1 overflow-auto p-4">
        <div
          className="mx-auto"
          style={{
            transform: `scale(${zoom / 100})`,
            transformOrigin: "top center",
          }}
        >
          <img
            src={canvas.imageUrl}
            alt={canvas.label}
            className="max-w-full"
            loading="lazy"
          />
        </div>
      </div>
    </div>
  );
}
