/**
 * Region Pin Overlay
 *
 * Absolute-positioned overlay that sits on top of a IIIF page and
 * renders one pin per region-anchored comment. Pins respond to
 * hover and click by surfacing the thread and by broadcasting the
 * selected comment id through the search params.
 *
 * @version v0.3.0
 */
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { MapPin } from "lucide-react";

/**
 * A single region pin's data. Coordinates are normalised into [0, 1]
 * relative to the page image's rendered box; `w === 0 && h === 0` is
 * the semantic marker for a point pin (the server-side clamp preserves
 * this exact shape via `clamp01`). `authorId` is
 * the id of the user who created the comment — required for
 * per-pin move-mode gating; optional so draft pins (which have no
 * commit yet) compile without it.
 */
export type RegionPin = {
  commentId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  draft?: boolean;
  authorId?: string;
};

export type RegionPinOverlayProps = {
  pins: RegionPin[];
  onPinClick?: (commentId: string) => void;
  /** When equal to a pin's `commentId`, that pin gains a burgundy ring. */
  highlightedCommentId?: string | null;
  /** viewer is in the per-pin move mode. */
  moveMode?: boolean;
  /** Current user's id, for per-pin author-gated draggability. */
  currentUserId?: string | null;
  /** Fires on pointerup at the end of a drag with the new region. */
  onPinMove?: (
 commentId: string,
 region: { x: number; y: number; w: number; h: number },
  ) => void;
  /** Tooltip on non-author pins in move mode (parent supplies i18n). */
  notAuthorTooltip?: string;
};

/**
 * Pure predicate: is this a point pin (no width / height)? Extracted so
 * tests can exercise the classification separately from the render body.
 */
export function isPointPin(pin: Pick<RegionPin, "w" | "h">): boolean {
  return pin.w === 0 && pin.h === 0;
}

/**
 * Pure predicate: is this pin draggable in the current move mode? True
 * only when move mode is on, the pin is committed (not draft), and
 * `pin.authorId` equals `currentUserId`. Server's `requireCommentAuthor`
 * is the authoritative gate; this predicate mirrors it on the client so
 * non-authors can't even start a drag (and see the not-allowed cursor).
 */
export function canMovePin(args: {
  moveMode: boolean;
  pin: Pick<RegionPin, "authorId" | "draft">;
  currentUserId: string | null | undefined;
}): boolean {
  if (!args.moveMode) return false;
  if (args.pin.draft) return false;
  if (args.pin.authorId == null) return false;
  if (args.currentUserId == null) return false;
  return args.pin.authorId === args.currentUserId;
}

/**
 * Pure function: compute the normalised delta from a drag start/current
 * client-space pointer pair, given the overlay's bounding rect. dx/dy
 * are in [0, 1] and can be negative (for leftward/upward drags).
 */
export function computeMoveDelta(
  start: { clientX: number; clientY: number },
  current: { clientX: number; clientY: number },
  overlayRect: { width: number; height: number },
): { dx: number; dy: number } {
  if (overlayRect.width <= 0 || overlayRect.height <= 0) {
 return { dx: 0, dy: 0 };
  }
  return {
 dx: (current.clientX - start.clientX) / overlayRect.width,
 dy: (current.clientY - start.clientY) / overlayRect.height,
  };
}

/**
 * Pure function: apply a normalised delta to a pin's starting region,
 * clamping so the shape stays fully inside [0, 1]. Point pins clamp
 * (x, y) to [0, 1]; box pins clamp so `x + w ≤ 1` and `y + h ≤ 1`.
 * Shape-preserving: w and h are NEVER changed — task 15 is move-only.
 */
export function applyMoveDelta(
  startPin: { x: number; y: number; w: number; h: number },
  delta: { dx: number; dy: number },
): { x: number; y: number; w: number; h: number } {
  const isPoint = startPin.w === 0 && startPin.h === 0;
  if (isPoint) {
 return {
 x: Math.max(0, Math.min(1, startPin.x + delta.dx)),
 y: Math.max(0, Math.min(1, startPin.y + delta.dy)),
 w: 0,
 h: 0,
 };
  }
  const maxX = 1 - startPin.w;
  const maxY = 1 - startPin.h;
  return {
 x: Math.max(0, Math.min(maxX, startPin.x + delta.dx)),
 y: Math.max(0, Math.min(maxY, startPin.y + delta.dy)),
 w: startPin.w,
 h: startPin.h,
  };
}

/**
 * Pure function: compute the inline style for a single pin. Point pins
 * anchor their bottom-centre on (x, y) via `translate(-50%, -100%)` so
 * the `MapPin` tip lands on the click point. Box pins use
 * left/top/width/height as percentages with no transform.
 */
export function computePinInlineStyle(pin: RegionPin): CSSProperties {
  if (isPointPin(pin)) {
 return {
 position: "absolute",
 left: `${pin.x * 100}%`,
 top: `${pin.y * 100}%`,
 transform: "translate(-50%, -100%)",
 };
  }
  return {
 position: "absolute",
 left: `${pin.x * 100}%`,
 top: `${pin.y * 100}%`,
 width: `${pin.w * 100}%`,
 height: `${pin.h * 100}%`,
  };
}

/**
 * Pure function: compute the className for a single pin, branching on
 * point vs box and draft vs final. Exported so tests can assert the
 * exact class strings without rendering. Final pins render in indigo
 * (`#1F2E4D`); draft pins render in saffron (`#C68A2E`) so an
 * unsaved annotation reads as in-progress against the document tile.
 */
export function computePinClassName(
  pin: RegionPin,
  options: { highlighted?: boolean } = {},
): string {
  const { highlighted = false } = options;
  const isDraft = pin.draft === true;
  const isPoint = isPointPin(pin);

  if (isPoint) {
 // Point pins render a MapPin icon; the className controls cursor,
 // focus outline, and the highlight ring only. The icon colour is
 // set on the <MapPin> element below.
 const base =
 "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-indigo";
 const draftClasses = isDraft ? "text-saffron" : "text-indigo";
 const highlightClasses = highlighted ? "ring-2 ring-indigo/50" : "";
 return [base, draftClasses, highlightClasses].filter(Boolean).join(" ");
  }

  // Box pins. Committed-box fill + border both burgundy `#1F2E4D`
  // (fill at 15%). Ties to the annotation card's burgundy palette after
  // the 2026-04-18 palette flip (annotations = burgundy, comments =
  // cream). Draft amber, hover ring, highlight ring all unchanged.
  const base =
 "cursor-pointer rounded outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-indigo hover:ring-2 hover:ring-indigo/50";
  const variantClasses = isDraft
 ? "border-2 border-dashed border-saffron bg-saffron/10"
 : "border-2 border-indigo bg-indigo/15";
  const highlightClasses = highlighted ? "ring-2 ring-indigo/50" : "";
  return [base, variantClasses, highlightClasses].filter(Boolean).join(" ");
}

type DragState = {
  commentId: string;
  startClient: { clientX: number; clientY: number };
  startPin: { x: number; y: number; w: number; h: number };
  currentRegion: { x: number; y: number; w: number; h: number };
  moved: boolean;
};

const DRAG_THRESHOLD_PX = 3;

export function RegionPinOverlay({
  pins,
  onPinClick,
  highlightedCommentId = null,
  moveMode = false,
  currentUserId = null,
  onPinMove,
  notAuthorTooltip,
}: RegionPinOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);

  return (
 <div
 ref={overlayRef}
 className="pointer-events-none absolute inset-0"
 style={{ zIndex: 20 }}
 data-testid="region-pin-overlay"
 >
 {pins.map((pin) => {
 const highlighted = pin.commentId === highlightedCommentId;
 const movable = canMovePin({ moveMode, pin, currentUserId });
 const isDraggingThisPin = dragState?.commentId === pin.commentId;
 // Live drag position: render the pin at its drag-updated coords
 // so the UI feels direct. On commit (pointerup) the parent
 // revalidates and the server-confirmed coords replace these.
 const effectivePin: RegionPin = isDraggingThisPin
 ? { ...pin, ...dragState.currentRegion }
 : pin;
 const style = computePinInlineStyle(effectivePin);
 const baseClassName = computePinClassName(effectivePin, { highlighted });
 const isPoint = isPointPin(effectivePin);

 // Move-mode visual gating: non-movable pins dim + show a
 // not-allowed cursor + tooltip so the user understands why.
 const nonMovableInMoveMode = moveMode && !movable && !pin.draft;
 const gatedClasses = nonMovableInMoveMode
 ? "opacity-50 cursor-not-allowed"
 : movable
 ? isDraggingThisPin
 ? "cursor-grabbing"
 : "cursor-grab"
 : "";
 // `cursor-pointer` from computePinClassName fights cursor-grab /
 // cursor-not-allowed; scrub it when move mode overrides.
 const className = moveMode
 ? baseClassName.replace(/\bcursor-pointer\b/g, "").trim() +
 " " + gatedClasses
 : baseClassName;

 const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
 if (e.key === "Enter" || e.key === " ") {
 e.preventDefault();
 onPinClick?.(pin.commentId);
 }
 };

 const handlePointerDown = (e: PointerEvent<HTMLElement>) => {
 if (!movable) return;
 e.stopPropagation();
 (e.target as HTMLElement).setPointerCapture(e.pointerId);
 setDragState({
 commentId: pin.commentId,
 startClient: { clientX: e.clientX, clientY: e.clientY },
 startPin: { x: pin.x, y: pin.y, w: pin.w, h: pin.h },
 currentRegion: { x: pin.x, y: pin.y, w: pin.w, h: pin.h },
 moved: false,
 });
 };

 const handlePointerMove = (e: PointerEvent<HTMLElement>) => {
 if (!isDraggingThisPin || !overlayRef.current) return;
 const rect = overlayRef.current.getBoundingClientRect();
 const delta = computeMoveDelta(
 dragState.startClient,
 { clientX: e.clientX, clientY: e.clientY },
 rect,
 );
 const currentRegion = applyMoveDelta(dragState.startPin, delta);
 const totalMove =
 Math.abs(e.clientX - dragState.startClient.clientX) +
 Math.abs(e.clientY - dragState.startClient.clientY);
 setDragState({
 ...dragState,
 currentRegion,
 moved: dragState.moved || totalMove > DRAG_THRESHOLD_PX,
 });
 };

 const handlePointerUp = (e: PointerEvent<HTMLElement>) => {
 if (!isDraggingThisPin) return;
 (e.target as HTMLElement).releasePointerCapture(e.pointerId);
 const { moved, currentRegion } = dragState;
 setDragState(null);
 if (moved) {
 onPinMove?.(pin.commentId, currentRegion);
 } else {
 // Treat a no-move pointerup as a click (scroll-to-region).
 onPinClick?.(pin.commentId);
 }
 };

 const handlePointerCancel = (e: PointerEvent<HTMLElement>) => {
 if (!isDraggingThisPin) return;
 (e.target as HTMLElement).releasePointerCapture(e.pointerId);
 setDragState(null);
 };

 const title = nonMovableInMoveMode ? notAuthorTooltip : undefined;

 if (isPoint) {
 return (
 <span
 key={pin.commentId}
 role="button"
 tabIndex={0}
 aria-label="region-pin"
 title={title}
 className={`${className} pointer-events-auto`}
 style={style}
 onClick={(e) => {
 // In move mode, click is routed via pointerup (to
 // distinguish drag from click via the moved flag).
 if (moveMode) return;
 e.stopPropagation();
 onPinClick?.(pin.commentId);
 }}
 onPointerDown={handlePointerDown}
 onPointerMove={handlePointerMove}
 onPointerUp={handlePointerUp}
 onPointerCancel={handlePointerCancel}
 onKeyDown={handleKeyDown}
 >
 <MapPin
 size={20}
 strokeWidth={2}
 fill={
 pin.draft
 ? "rgba(198, 138, 46, 0.2)" /* saffron at 20% */
 : "rgba(31, 46, 77, 0.2)" /* indigo at 20% */
 }
 aria-hidden="true"
 />
 </span>
 );
 }
 return (
 <div
 key={pin.commentId}
 role="button"
 tabIndex={0}
 aria-label="region-pin"
 title={title}
 className={`${className} pointer-events-auto`}
 style={style}
 onClick={(e) => {
 if (moveMode) return;
 e.stopPropagation();
 onPinClick?.(pin.commentId);
 }}
 onPointerDown={handlePointerDown}
 onPointerMove={handlePointerMove}
 onPointerUp={handlePointerUp}
 onPointerCancel={handlePointerCancel}
 onKeyDown={handleKeyDown}
 />
 );
 })}
 </div>
  );
}

