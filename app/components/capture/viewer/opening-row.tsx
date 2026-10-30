/**
 * Capture QC Viewer — One Opening in the Column
 *
 * This component draws one opening of the capture QC viewer's scrolling
 * column: its images, as a pair side by side (Spreads) or stacked
 * (Single pages), or a single image, with no card or frame round them.
 * Above them runs a line in the decision's colour, verdigris for
 * approved, madder for rejected for retake and stone for undecided,
 * thicker for the current opening; it carries the opening's number,
 * its page keys and, for a rejection, the reason and the image to
 * retake, when the rejection names one.
 *
 * The controls sit in the margins as marginalia. The left margin holds
 * the opening's number (a button that makes it current), Approve (a
 * toggle, `aria-pressed`), Reject for retake, which opens the reject
 * form in the rail, and the turn of the left or single image; the right
 * margin holds the turn of the right image of a pair. A turned image's
 * button shows in saffron. Under them, Clear decision returns a decided
 * opening to undecided while the unit has not yet fetched its decision
 * (`sentAt` null); once it has, the control is not offered and the
 * reviewer changes the decision instead. Pages narrower than
 * `ACTIONS_MIN_WIDTH` lose their margins and controls, and the number
 * moves onto the line, so the sequence stays legible at every zoom. A
 * reviewer who may not decide sees the number and no decision controls.
 *
 * An opening an earlier handover rejected and this one brought back
 * with new images (`opening.earlier`) has an Earlier images toggle at
 * the foot of its left margin, with no key. Pressed (`comparing`), it
 * draws the rejected images in place of the current ones, in the same
 * box, so the row keeps its size, and the line names the handover and
 * the rejection's reason and side; pressed again it shows the current
 * images. The rejected images are read with that delivery's access
 * (`earlierAccess`).
 *
 * The opening is a `role="group"` named by its number and decision.
 *
 * @version v0.8.0
 */

import { useTranslation } from "react-i18next";
import { Check, Eraser, History, RotateCw, X } from "lucide-react";
import { BADGE_SHAPE } from "../../workflow/status-badge";
import {
  imageForSide,
  imageKey,
  isPair,
  MARGIN_LEFT,
  MARGIN_RIGHT,
  NARROW_MARGIN,
  PAIR_GAP,
  pageHeight,
  ROW_GAP,
  showsActions,
  type OpeningState,
  type ViewerDecision,
  type ViewerOpening,
} from "../../../lib/capture/viewer";
import { ReviewImage, type ReviewImageProps } from "./review-image";

/** One opening's decision as a word, under `capture:viewer.decision_*`. */
export function decisionKey(decision: ViewerDecision | null): string {
  if (decision?.decision === "approved") return "viewer.decision_approved";
  if (decision?.decision === "rejected") return "viewer.decision_rejected";
  return "viewer.decision_undecided";
}

/** The line's colour and weight: thicker for the current opening, thinnest for an undecided one. */
export function ruleClass(decision: ViewerDecision | null, current: boolean): string {
  const colour =
    decision?.decision === "approved"
      ? "bg-verdigris"
      : decision?.decision === "rejected"
        ? "bg-madder"
        : "bg-stone-300";
  const weight = current ? "h-[3px]" : decision ? "h-0.5" : "h-px";
  return `${colour} ${weight}`;
}

export interface OpeningRowProps {
  opening: ViewerOpening;
  state: OpeningState;
  view: "spreads" | "pages";
  pw: number;
  width: number;
  height: number;
  current: boolean;
  canDecide: boolean;
  /** Access to the review tiles, passed to each image. */
  access?: ReviewImageProps["access"];
  /** Whether the earlier handover's rejected images are shown in place of the current ones. */
  comparing?: boolean;
  /** Access to the review tiles of the earlier handover's delivery. */
  earlierAccess?: ReviewImageProps["access"];
  onCurrent: () => void;
  onApprove: () => void;
  onReject: () => void;
  onRotate: (side: "left" | "right") => void;
  /** Clears the opening's decision; without it the control is not offered. */
  onClear?: () => void;
  /** Switches between the current images and the earlier rejected ones. */
  onCompare?: () => void;
}

export function OpeningRow({
  opening,
  state,
  view,
  pw,
  width,
  height,
  current,
  canDecide,
  access,
  comparing = false,
  earlierAccess,
  onCurrent,
  onApprove,
  onReject,
  onRotate,
  onClear,
  onCompare,
}: OpeningRowProps) {
  const { t } = useTranslation("capture");
  const n = opening.sequence;
  const decision = state.decision;
  const actions = showsActions(pw);
  const ph = pageHeight(pw);
  const pair = isPair(opening);
  const leftImage = imageForSide(opening, "left");
  const rightImage = pair ? imageForSide(opening, "right") : null;
  const turnsOf = (image: { captureId: string; role: string } | null) => (image ? state.turns[imageKey(image)] ?? 0 : 0);

  const roundButton =
    "flex h-10 w-10 items-center justify-center rounded-full shadow-sm ring-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo";
  const idle = "bg-white/90 text-stone-500 ring-stone-200 hover:text-indigo";

  const rotateButton = (side: "left" | "right", image: { captureId: string; role: string } | null) =>
    image ? (
      <button
        type="button"
        onClick={() => {
          onCurrent();
          onRotate(side);
        }}
        aria-label={t(side === "right" ? "viewer.rotate_right" : pair ? "viewer.rotate_left" : "viewer.rotate_single", { n })}
        className={`${roundButton} ${idle}`}
      >
        <RotateCw className={`h-5 w-5 ${turnsOf(image) > 0 ? "text-saffron-deep" : ""}`} strokeWidth={1.5} aria-hidden="true" />
      </button>
    ) : null;

  const keys = opening.images.map((i) => i.pageKey).join(" / ");
  const earlier = opening.earlier;
  const showEarlier = comparing && earlier !== null;
  const clearable = canDecide && decision !== null && (decision.sentAt ?? null) === null && onClear !== undefined;

  // The earlier images share the current images' box, so the row keeps its size.
  const count = opening.images.length;
  const areaWidth = view === "pages" || count < 2 ? pw : 2 * pw + PAIR_GAP;
  const areaHeight = view === "pages" ? count * ph + (count - 1) * ROW_GAP : ph;
  const shown = showEarlier ? earlier.images : opening.images;
  const k = Math.max(1, shown.length);
  const gap = view === "pages" ? ROW_GAP : PAIR_GAP;
  const imageWidth = showEarlier && view !== "pages" ? Math.floor((areaWidth - (k - 1) * gap) / k) : pw;
  const imageHeight = showEarlier && view === "pages" ? Math.floor((areaHeight - (k - 1) * gap) / k) : ph;
  const earlierDecision = earlier?.decision ?? null;

  return (
    <div
      role="group"
      aria-label={t("viewer.opening", { n, decision: t(decisionKey(decision)) })}
      aria-current={current ? "true" : undefined}
      data-opening={n}
      className="shrink-0"
      style={{ width, height }}
    >
      {/* The line above the opening, in the decision's colour. */}
      <div
        className="flex h-5 items-center gap-2"
        style={{
          paddingLeft: actions ? MARGIN_LEFT : NARROW_MARGIN,
          paddingRight: actions ? MARGIN_RIGHT : NARROW_MARGIN,
        }}
      >
        {!actions ? (
          <button
            type="button"
            onClick={onCurrent}
            aria-label={t("viewer.make_current", { n })}
            className={`font-sans text-11 tabular-nums ${current ? "font-bold text-indigo" : "font-medium text-stone-500"}`}
          >
            {n}
          </button>
        ) : showEarlier ? null : (
          <span className="min-w-0 max-w-[60%] truncate font-mono text-[10px] text-stone-500">{keys}</span>
        )}
        {showEarlier ? (
          <span data-earlier-caption="" className="flex min-w-0 shrink items-center gap-2 truncate font-sans text-11 text-madder-deep">
            <span className="truncate">
              {t("viewer.compare.caption", {
                n: earlier.handover,
                reason: earlierDecision?.reason ? t(`reason.${earlierDecision.reason}`) : "",
              })}
            </span>
            {earlierDecision?.side ? (
              <span className={`${BADGE_SHAPE} shrink-0 bg-madder-tint text-madder-deep`}>{t(`side.${earlierDecision.side}`)}</span>
            ) : null}
          </span>
        ) : null}
        {!showEarlier && decision?.decision === "rejected" && decision.reason ? (
          <span className={`${BADGE_SHAPE} shrink-0 bg-madder-tint text-madder-deep`}>{t(`reason.${decision.reason}`)}</span>
        ) : null}
        {!showEarlier && decision?.decision === "rejected" && decision.side ? (
          <span className={`${BADGE_SHAPE} shrink-0 bg-madder-tint text-madder-deep`}>{t(`side.${decision.side}`)}</span>
        ) : null}
        <span className={`min-w-4 flex-1 rounded-full ${ruleClass(decision, current)}`} aria-hidden="true" />
      </div>

      <div className="flex items-start">
        {/* Left margin. */}
        <div
          className="flex shrink-0 flex-col items-end gap-2 pr-3"
          style={{ width: actions ? MARGIN_LEFT : NARROW_MARGIN }}
        >
          {actions ? (
            <>
              <button
                type="button"
                onClick={onCurrent}
                aria-label={t("viewer.make_current", { n })}
                className={`font-sans text-base tabular-nums ${current ? "font-bold text-indigo" : "font-medium text-stone-500"}`}
              >
                {n}
              </button>
              {canDecide ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      onCurrent();
                      onApprove();
                    }}
                    aria-pressed={decision?.decision === "approved"}
                    aria-label={t("viewer.approve_opening", { n })}
                    className={`${roundButton} ${
                      decision?.decision === "approved" ? "bg-verdigris text-parchment ring-verdigris" : idle
                    }`}
                  >
                    <Check className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onCurrent();
                      onReject();
                    }}
                    aria-label={t("viewer.reject_opening", { n })}
                    className={`${roundButton} ${
                      decision?.decision === "rejected" ? "bg-madder text-parchment ring-madder" : idle
                    }`}
                  >
                    <X className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />
                  </button>
                  {rotateButton("left", leftImage)}
                  {clearable ? (
                    <button
                      type="button"
                      onClick={() => {
                        onCurrent();
                        onClear?.();
                      }}
                      aria-label={t("viewer.clear_decision")}
                      title={t("viewer.clear_decision")}
                      className={`${roundButton} ${idle}`}
                    >
                      <Eraser className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />
                    </button>
                  ) : null}
                </>
              ) : null}
              {earlier !== null && onCompare ? (
                <button
                  type="button"
                  onClick={() => {
                    onCurrent();
                    onCompare();
                  }}
                  data-compare=""
                  className={`flex flex-col items-center gap-0.5 rounded px-1 py-0.5 text-center font-sans text-[10px] font-semibold leading-tight focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo ${
                    showEarlier ? "bg-madder-tint text-madder-deep" : "text-stone-500 hover:text-indigo"
                  }`}
                >
                  <History className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
                  {t(showEarlier ? "viewer.compare.hide" : "viewer.compare.show")}
                </button>
              ) : null}
            </>
          ) : null}
        </div>

        {/* The images. */}
        <div
          className={view === "pages" ? "flex flex-col" : "flex"}
          style={showEarlier ? { gap, width: areaWidth, height: areaHeight } : { gap }}
        >
          {shown.map((image) => (
            <ReviewImage
              key={`${showEarlier ? earlier.deliveryId : "current"}:${imageKey(image)}`}
              image={image}
              n={n}
              width={imageWidth}
              height={imageHeight}
              quarterTurns={showEarlier ? 0 : turnsOf(image)}
              access={showEarlier ? earlierAccess : access}
              onSelect={onCurrent}
            />
          ))}
        </div>

        {/* Right margin. */}
        {/* In Single pages the right image is the second one down, and its turn sits beside it. */}
        <div
          className="flex shrink-0 flex-col items-start pl-2"
          style={{ width: actions ? MARGIN_RIGHT : NARROW_MARGIN, paddingTop: view === "pages" && pair ? ph + ROW_GAP : 0 }}
        >
          {actions && canDecide && rightImage ? rotateButton("right", rightImage) : null}
        </div>
      </div>
    </div>
  );
}

// @version v0.8.0
