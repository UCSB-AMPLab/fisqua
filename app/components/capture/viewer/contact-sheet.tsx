/**
 * Capture QC Viewer — Contact Sheet
 *
 * This component is the capture QC viewer's contact sheet, a mode of
 * the same viewer (G, or the Contact sheet toggle): every opening the
 * filter shows as a small tile, its pages side by side, over a line in
 * the decision's colour and a label with its number and, for a
 * rejection, the reason and the side to retake, when the rejection
 * names one. Clicking a tile makes the opening current and
 * returns to Spreads at it. Each tile has a checkbox, so a reviewer can
 * pick several openings and approve them together from the toolbar
 * ("Approve selected"); a selected tile is outlined in indigo.
 *
 * Each page is a box at the layout's page ratio, sized with the zoom.
 * With access to the review tiles (`access`) it holds the page's
 * thumbnail from those tiles, `full/200,/0/default.jpg`, or `full/96,`
 * when the box times the screen's pixel ratio is at most 96 pixels,
 * through `reviewTileUrl`, so the comma is written `%2C` and the token
 * travels in the query string. The address is fixed when the thumbnail
 * is mounted, so a refreshed token never makes it load again. A
 * thumbnail that fails to load is tried once more at `full/max`, then
 * gives way to the parchment placeholder, which is also what a sheet
 * without access shows. The image is contained in its box, turned by
 * the opening's quarter-turns, and loaded lazily.
 *
 * @version v0.8.0
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  imageKey,
  PAGE_RATIO,
  type OpeningState,
  type ViewerImage,
  type ViewerOpening,
} from "../../../lib/capture/viewer";
import { reviewTileUrl } from "../../../lib/capture/review-tiles";
import { decisionKey, ruleClass } from "./opening-row";
import type { ReviewImageProps } from "./review-image";

export interface ContactSheetProps {
  openings: ViewerOpening[];
  states: Map<number, OpeningState>;
  currentId: number | null;
  zoom: number;
  selected: Set<number>;
  canDecide: boolean;
  /** Access to the review tiles; without it every page is a placeholder. */
  access?: ReviewImageProps["access"];
  onOpen: (captuaRecordId: number) => void;
  onToggle: (captuaRecordId: number) => void;
}

/** A thumbnail's width at a zoom, between 28 and 96 pixels. */
export function thumbWidth(zoom: number): number {
  return Math.round(Math.min(96, Math.max(28, 88 * zoom)));
}

/**
 * One page's thumbnail, or its placeholder. The first address is taken
 * at mount; a failure tries `full/max` once, a second one leaves the
 * placeholder.
 */
function Thumbnail({
  image,
  width,
  height,
  quarterTurns,
  access,
}: {
  image: ViewerImage;
  width: number;
  height: number;
  quarterTurns: number;
  access: NonNullable<ReviewImageProps["access"]>;
}) {
  const id = `${access.base}${encodeURIComponent(image.pageKey)}`;
  const [attempt, setAttempt] = useState<{ src: string | null; tries: number }>(() => {
    const token = access.token();
    if (!token) return { src: null, tries: 2 };
    const ratio = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    return { src: reviewTileUrl(id, "full", width * ratio <= 96 ? "96," : "200,", token), tries: 0 };
  });
  const placeholder = <span className="block bg-parchment-deep" style={{ width, height }} />;
  if (attempt.src === null) return placeholder;
  const sideways = quarterTurns % 2 === 1;
  return (
    <span className="relative block overflow-hidden bg-parchment-deep" style={{ width, height }}>
      <img
        src={attempt.src}
        alt=""
        loading="lazy"
        decoding="async"
        data-thumbnail=""
        onError={() =>
          setAttempt((a) => {
            const token = access.token();
            return a.tries === 0 && token ? { src: reviewTileUrl(id, "full", "max", token), tries: 1 } : { src: null, tries: 2 };
          })
        }
        className="absolute left-1/2 top-1/2 max-w-none object-contain"
        style={{
          width: sideways ? height : width,
          height: sideways ? width : height,
          transform: `translate(-50%, -50%) rotate(${quarterTurns * 90}deg)`,
        }}
      />
    </span>
  );
}

export function ContactSheet({ openings, states, currentId, zoom, selected, canDecide, access, onOpen, onToggle }: ContactSheetProps) {
  const { t } = useTranslation("capture");
  const w = thumbWidth(zoom);
  const h = Math.round(w * PAGE_RATIO);

  return (
    <ul aria-label={t("viewer.sheet.label")} className="flex flex-wrap gap-x-[18px] gap-y-4 px-4 py-4">
      {openings.map((o) => {
        const state = states.get(o.captuaRecordId);
        const decision = state?.decision ?? null;
        const n = o.sequence;
        const current = o.captuaRecordId === currentId;
        const isSelected = selected.has(o.captuaRecordId);
        return (
          <li key={o.captuaRecordId} data-opening={n}>
            <button
              type="button"
              onClick={() => onOpen(o.captuaRecordId)}
              aria-label={t("viewer.sheet.open", { n, decision: t(decisionKey(decision)) })}
              className={`block rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo ${
                isSelected ? "outline outline-[1.5px] outline-offset-2 outline-indigo" : ""
              }`}
            >
              <span className="flex gap-0.5">
                {o.images.map((image) =>
                  access ? (
                    <Thumbnail
                      key={`${access.base}:${imageKey(image)}`}
                      image={image}
                      width={w}
                      height={h}
                      quarterTurns={state?.turns[imageKey(image)] ?? 0}
                      access={access}
                    />
                  ) : (
                    <span key={imageKey(image)} className="block bg-parchment-deep" style={{ width: w, height: h }} />
                  ),
                )}
              </span>
              <span className={`mt-1 block rounded-full ${ruleClass(decision, current)}`} aria-hidden="true" />
            </button>
            <span className="mt-1 flex items-center gap-1.5 font-sans text-11">
              {canDecide ? (
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggle(o.captuaRecordId)}
                  aria-label={t("viewer.sheet.select", { n })}
                  className="accent-indigo"
                />
              ) : null}
              <span className={`tabular-nums ${current ? "font-bold text-indigo" : "font-semibold text-stone-700"}`}>{n}</span>
              {decision?.decision === "rejected" && decision.reason ? (
                <span className="text-madder-deep">{t(`reason.${decision.reason}`)}</span>
              ) : null}
              {decision?.decision === "rejected" && decision.side ? (
                <span className="text-madder-deep">{t(`side.${decision.side}`)}</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// @version v0.8.0
