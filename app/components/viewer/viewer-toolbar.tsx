/**
 * Viewer Toolbar
 *
 * Three-zone toolbar that sits above the IIIF viewer: zoom controls
 * on the left, per-volume metadata in the centre, and the segment /
 * comment / flag affordances on the right. Single entry point for
 * every user-triggered viewer action.
 *
 * @version v0.3.0
 */
import { useTranslation } from "react-i18next";
import {
  CircleDot,
  Hand,
  MapPin,
  Maximize,
  Square,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

export type PinMode = "off" | "point" | "box" | "move";

/**
 * Pure predicate: is the viewer currently in the per-pin move mode
 *? Exported so tests + the overlay + the route can
 * pin the literal without the string leaking outside this file.
 */
export function isMoveMode(pinMode: PinMode): boolean {
  return pinMode === "move";
}

export type ViewerAccessLevel = "edit" | "review" | "readonly";

export type ViewerToolbarProps = {
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  pinMode: PinMode;
  onPinModeChange: (next: PinMode) => void;
  onToggleFullscreen: () => void;
  accessLevel: ViewerAccessLevel;
};

/**
 * Pure helper: given the current pinMode, what does the Annotation-
 * toggle click produce next? Off -> point (default-to-point per
 *); any active mode -> off. Exported so tests pin the rule
 * without rendering; the render body calls this same function.
 */
export function computeNextPinMode(current: PinMode): PinMode {
  if (current === "off") return "point";
  return "off";
}

/**
 * Pure helper: should the Annotation / Marcar problema buttons be
 * enabled? False iff the viewer is in readonly mode for this user
 * (O-03). Exported so tests pin the disable rule without rendering.
 */
export function shouldEnableCreateButtons(
  accessLevel: ViewerAccessLevel,
): boolean {
  return accessLevel !== "readonly";
}

export function ViewerToolbar({
  zoomPercent,
  onZoomIn,
  onZoomOut,
  pinMode,
  onPinModeChange,
  onToggleFullscreen,
  accessLevel,
}: ViewerToolbarProps) {
  const { t } = useTranslation(["viewer"]);
  const createEnabled = shouldEnableCreateButtons(accessLevel);
  const readonlyTooltip = t("viewer:readonlyTooltip", {
 defaultValue: "Solo lectura — no tiene permisos para crear",
  });
  const annotationActive = pinMode !== "off";

  return (
 <div className="flex h-10 shrink-0 items-center gap-2 border-b border-stone-200 bg-white px-3 font-sans">
 {/* Zone 1: zoom controls */}
 <div className="flex items-center gap-1">
 <button
 type="button"
 onClick={onZoomOut}
 aria-label={t("viewer:toolbar.zoomOut", {
 defaultValue: "Reducir zoom",
 })}
 className="flex h-7 w-7 items-center justify-center rounded text-stone-600 hover:bg-stone-100 focus:outline-none focus:ring-2 focus:ring-indigo/40"
 >
 <ZoomOut size={14} aria-hidden="true" />
 </button>
 <span className="min-w-[3ch] text-center text-xs font-medium tabular-nums text-stone-600">
 {zoomPercent}%
 </span>
 <button
 type="button"
 onClick={onZoomIn}
 aria-label={t("viewer:toolbar.zoomIn", {
 defaultValue: "Aumentar zoom",
 })}
 className="flex h-7 w-7 items-center justify-center rounded text-stone-600 hover:bg-stone-100 focus:outline-none focus:ring-2 focus:ring-indigo/40"
 >
 <ZoomIn size={14} aria-hidden="true" />
 </button>
 </div>

 {/* Zone 2: Annotation toggle (+ sub-tools when active) */}
 <div className="flex items-center gap-1">
 <button
 type="button"
 aria-pressed={annotationActive}
 onClick={() => onPinModeChange(computeNextPinMode(pinMode))}
 disabled={accessLevel === "readonly"}
 title={accessLevel === "readonly" ? readonlyTooltip : undefined}
 className={`inline-flex h-7 items-center gap-1.5 rounded border px-2 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-indigo/40 disabled:cursor-not-allowed disabled:opacity-50 ${
 annotationActive
 ? "border-indigo bg-indigo-tint text-indigo"
 : "border-stone-200 bg-white text-stone-700 hover:bg-stone-50"
 }`}
 >
 <MapPin size={14} aria-hidden="true" />
 {t("viewer:toolbar.annotation", { defaultValue: "Annotation" })}
 </button>
 {annotationActive && (
 <>
 <button
 type="button"
 aria-pressed={pinMode === "point"}
 aria-label={t("viewer:toolbar.annotationPoint", {
 defaultValue: "Punto",
 })}
 onClick={() => onPinModeChange("point")}
 disabled={!createEnabled}
 title={!createEnabled ? readonlyTooltip : undefined}
 className={`flex h-7 w-7 items-center justify-center rounded border transition-colors focus:outline-none focus:ring-2 focus:ring-indigo/40 disabled:cursor-not-allowed disabled:opacity-50 ${
 pinMode === "point"
 ? "border-indigo bg-indigo-tint text-indigo"
 : "border-stone-200 bg-white text-stone-600 hover:bg-stone-50"
 }`}
 >
 <CircleDot size={14} aria-hidden="true" />
 </button>
 <button
 type="button"
 aria-pressed={pinMode === "box"}
 aria-label={t("viewer:toolbar.annotationBox", {
 defaultValue: "Recuadro",
 })}
 onClick={() => onPinModeChange("box")}
 disabled={!createEnabled}
 title={!createEnabled ? readonlyTooltip : undefined}
 className={`flex h-7 w-7 items-center justify-center rounded border transition-colors focus:outline-none focus:ring-2 focus:ring-indigo/40 disabled:cursor-not-allowed disabled:opacity-50 ${
 pinMode === "box"
 ? "border-indigo bg-indigo-tint text-indigo"
 : "border-stone-200 bg-white text-stone-600 hover:bg-stone-50"
 }`}
 >
 <Square size={14} aria-hidden="true" />
 </button>
 {/* author move tool. Tool is always available
 for editors; per-pin draggability is enforced at the
 overlay layer (non-authors see their pins at 50% opacity
 with a tooltip). */}
 <button
 type="button"
 aria-pressed={pinMode === "move"}
 aria-label={t("viewer:toolbar.annotationMove", {
 defaultValue: "Mover",
 })}
 onClick={() => onPinModeChange("move")}
 disabled={!createEnabled}
 title={!createEnabled ? readonlyTooltip : undefined}
 className={`flex h-7 w-7 items-center justify-center rounded border transition-colors focus:outline-none focus:ring-2 focus:ring-indigo/40 disabled:cursor-not-allowed disabled:opacity-50 ${
 pinMode === "move"
 ? "border-indigo bg-indigo-tint text-indigo"
 : "border-stone-200 bg-white text-stone-600 hover:bg-stone-50"
 }`}
 >
 <Hand size={14} aria-hidden="true" />
 </button>
 </>
 )}
 </div>

 {/* Zone 3 (right-aligned): Pantalla completa */}
 <div className="ml-auto">
 <button
 type="button"
 onClick={onToggleFullscreen}
 aria-label={t("viewer:toolbar.pantallaCompleta", {
 defaultValue: "Pantalla completa",
 })}
 className="inline-flex h-7 items-center gap-1.5 rounded border border-stone-200 bg-white px-2 text-xs font-semibold text-stone-700 transition-colors hover:bg-stone-50 focus:outline-none focus:ring-2 focus:ring-indigo/40"
 >
 <Maximize size={14} aria-hidden="true" />
 {t("viewer:toolbar.pantallaCompleta", {
 defaultValue: "Pantalla completa",
 })}
 </button>
 </div>
 </div>
  );
}

