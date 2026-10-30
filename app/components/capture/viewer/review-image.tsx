/**
 * Capture QC Viewer — Review Image
 *
 * This component draws one image of an opening in the capture QC
 * viewer's column. With access to the review tiles (`access`, from
 * `useReviewAccess`) it shows the page's review image, zoomable, in an
 * OpenSeadragon viewer that reads the tiles straight from B2: it
 * fetches the page's `info.json` under `{base}{page key}/` with the
 * token in the query string, and gives OpenSeadragon a tile source from
 * `reviewTileSource`, so every tile address carries the newest token
 * and no literal comma. A page's `info.json` is fetched once per base
 * address for the life of the page.
 *
 * Without access, while the `info.json` is on its way, or when it, the
 * OpenSeadragon script or the image fails, it draws a placeholder: a
 * parchment page at the fixed ratio the layout uses (`PAGE_RATIO`),
 * captioned with its side and page key, so a reviewer can still find
 * their place and record decisions. The image fills its box with no
 * frame, as a page in a scrolling PDF does.
 *
 * A rotation turns the page inside its box rather than resizing the
 * box: the review image turns with the OpenSeadragon viewport
 * (`setRotation`) and is fitted to the box again, and a quarter-turned
 * placeholder is drawn on its side, as wide as the box, with its caption
 * turned too, so turning an image never moves the openings around it.
 * Clicking the image makes its opening current. Every wheel event
 * scrolls the column, not the image (`minScrollDeltaTime` 0, so OSD
 * throttles none of them); a double click or a pinch zooms it. Tile
 * addresses carry the token, so OSD's console is the redacting one
 * `reviewTileSource` puts in place.
 *
 * Only the openings near the screen are mounted (`mountedRange`), so
 * only their images hold a viewer; each viewer is destroyed when its
 * image is unmounted.
 *
 * @version v0.8.0
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PAGE_RATIO, type ViewerImage } from "../../../lib/capture/viewer";
import { reviewTileSource } from "../../../lib/capture/review-tiles";

const OSD_SCRIPT = "/vendor/openseadragon.min.js";

/** Each page's `info.json`, by the page's base address. */
const infoByPage = new Map<string, object>();

/** Loads a script once; a failed tag is removed so a later call tries again. */
function loadScript(src: string): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
  if (existing && (window as any).OpenSeadragon) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => {
      script.remove();
      reject(new Error(`Failed to load script: ${src}`));
    });
    if (!existing) {
      script.src = src;
      document.head.appendChild(script);
    }
  });
}

interface ReviewImageAccess {
  /** `{downloadUrl}/file/{bucket}/{prefix}` of the current delivery. */
  base: string;
  /** The newest download authorisation token. */
  token: () => string | null;
}

export interface ReviewImageProps {
  image: ViewerImage;
  /** The opening's sequence number. */
  n: number;
  width: number;
  height: number;
  quarterTurns: number;
  /** Access to the review tiles; without it the placeholder is drawn. */
  access?: ReviewImageAccess | null;
  onSelect?: () => void;
}

export function ReviewImage({ image, n, width, height, quarterTurns, access, onSelect }: ReviewImageProps) {
  const { t } = useTranslation("capture");
  const pageBase = access ? `${access.base}${encodeURIComponent(image.pageKey)}` : null;
  const [loaded, setLoaded] = useState<{ page: string; info: object } | null>(null);
  const [failedPage, setFailedPage] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const tokenRef = useRef<() => string | null>(() => null);
  tokenRef.current = access?.token ?? (() => null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const turnsRef = useRef(quarterTurns);
  turnsRef.current = quarterTurns;

  const info = pageBase !== null && loaded?.page === pageBase ? loaded.info : null;
  const showImage = info !== null && failedPage !== pageBase;

  // The page's info.json, fetched with the token in the query string.
  useEffect(() => {
    if (pageBase === null) return;
    const cached = infoByPage.get(pageBase);
    if (cached) {
      setLoaded({ page: pageBase, info: cached });
      return;
    }
    const token = tokenRef.current();
    if (!token) return;
    let live = true;
    fetch(`${pageBase}/info.json?Authorization=${encodeURIComponent(token)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: unknown) => {
        if (typeof body !== "object" || body === null) throw new Error("info.json");
        infoByPage.set(pageBase, body);
        if (live) setLoaded({ page: pageBase, info: body });
      })
      .catch(() => {
        if (live) setFailedPage(pageBase);
      });
    return () => {
      live = false;
    };
  }, [pageBase]);

  // The viewer, made once the info.json is in hand and destroyed with the image.
  useEffect(() => {
    const element = containerRef.current;
    if (!element || info === null || pageBase === null) return;
    let live = true;
    let viewer: any = null;
    loadScript(OSD_SCRIPT)
      .then(() => {
        const OSD = (window as any).OpenSeadragon;
        if (!live || !OSD) return;
        viewer = OSD({
          element,
          tileSources: reviewTileSource(OSD, info, `${pageBase}/info.json`, () => tokenRef.current() ?? ""),
          degrees: turnsRef.current * 90,
          showNavigationControl: false,
          animationTime: 0.3,
          immediateRender: true,
          minZoomImageRatio: 1,
          maxZoomPixelRatio: 4,
          visibilityRatio: 1,
          constrainDuringPan: true,
          gestureSettingsMouse: { scrollToZoom: false, clickToZoom: false, dblClickToZoom: true, dragToPan: true },
          gestureSettingsTouch: { pinchToZoom: true, dragToPan: true },
          crossOriginPolicy: "Anonymous",
          // Every wheel event reaches the canvas-scroll handler below. With
          // OSD's default of 50 ms, events between throttled ones skip the
          // handler and OSD cancels them, so the column would not scroll.
          minScrollDeltaTime: 0,
        });
        // Let wheel events reach the column so it scrolls. OSD's
        // canvas-scroll handler cancels the native wheel event even with
        // scrollToZoom off, so its own action is skipped and the event
        // left uncancelled, through the documented event contract.
        viewer.addHandler("canvas-scroll", (event: { preventDefaultAction: boolean; preventDefault: boolean }) => {
          event.preventDefaultAction = true;
          event.preventDefault = false;
        });
        viewer.addHandler("canvas-click", (event: { quick: boolean }) => {
          if (event.quick) onSelectRef.current?.();
        });
        viewer.addHandler("open-failed", () => {
          if (live) setFailedPage(pageBase);
        });
        viewerRef.current = viewer;
      })
      .catch(() => {
        if (live) setFailedPage(pageBase);
      });
    return () => {
      live = false;
      viewerRef.current = null;
      viewer?.destroy();
    };
  }, [info, pageBase]);

  // A new turn rotates the viewport and fits the page to the box again.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer?.viewport) return;
    viewer.viewport.setRotation(quarterTurns * 90, true);
    viewer.viewport.goHome(true);
  }, [quarterTurns]);

  const sideways = quarterTurns % 2 === 1;
  // A page on its side keeps the page's own ratio, as wide as the box.
  const pageW = width;
  const pageH = sideways ? Math.round(width / PAGE_RATIO) : height;
  const showCaption = width >= 72;

  return (
    <div
      role="img"
      aria-label={t(`viewer.image_${image.role}`, { n })}
      onClick={onSelect}
      className="relative flex shrink-0 items-center justify-center"
      style={{ width, height }}
      data-page-key={image.pageKey}
    >
      {showImage ? (
        <div ref={containerRef} className="absolute inset-0" data-review-image="" />
      ) : (
        <div className="flex items-center justify-center bg-parchment-deep" style={{ width: pageW, height: pageH }}>
          {showCaption ? (
            <span
              className="flex max-w-full flex-col items-center gap-0.5 px-2 text-center font-sans text-11 text-stone-500"
              style={{ transform: `rotate(${quarterTurns * 90}deg)` }}
              aria-hidden="true"
            >
              <span>{t(`viewer.rotation.${image.role}`)}</span>
              <span className="max-w-full truncate font-mono text-[10px] text-stone-400">{image.pageKey}</span>
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

// @version v0.8.0
