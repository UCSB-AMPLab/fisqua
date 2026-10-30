/**
 * Viewer Top Bar
 *
 * This component is the page-level top bar for the full-height viewers —
 * a back link, the volume's title, undo and redo, and the save-status
 * pill. It sits above the viewer toolbar and is scroll-locked to the top
 * of the page. Two viewers use it: the segmentation viewer, whose back
 * link returns to the project's volumes, and the capture QC viewer,
 * whose back link returns to the capture QC queue; each passes where
 * the link goes (`backTo`) and what it is called (`backLabel`). The
 * arrow, undo and redo icons are Lucide's, as everywhere in the app.
 *
 * The shared `<SaveStatus>` component is i18n-agnostic; this top bar
 * resolves the four state labels (saved / saving / unsaved / error)
 * and the retry-affordance label from the `viewer` namespace's nested
 * `save_status.*` shape and passes them down as props. The capture QC
 * viewer reaches the `error` state when its saves run out of retries,
 * and passes `onRetrySave` for the pill's retry link.
 *
 * The top bar also renders a visible "Save now" button next to the
 * SaveStatus pill (the manual-save escape hatch) when the viewer
 * passes one. The segmentation viewer's click handler is forwarded
 * via the optional `onSaveNow`
 * prop; the route owns the `flush()` binding (see
 * `_auth.viewer.$projectId.$volumeId.tsx`'s `handleSaveNow`). Keeping
 * the click closure in the route rather than passing `flush` itself
 * down preserves the top bar's ignorance of `useAutosave` internals.
 * The button is rendered alongside the pill rather than passed as a
 * prop to the shared `<SaveStatus>` component, because the
 * labels-as-props contract keeps that component presentation-only.
 *
 * @version v0.8.0
 */
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Redo2, Undo2 } from "lucide-react";
import { SaveStatus, type SaveStatusValue } from "./save-status";

type ViewerTopBarProps = {
  volumeName: string;
  /** Where the back link goes. */
  backTo: string;
  /** The back link's accessible name. */
  backLabel: string;
  saveStatus?: SaveStatusValue;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onRetrySave?: () => void;
  /**
   * Click handler for the "Save now" button rendered next to the
   * SaveStatus pill. Wired by the viewer route to `flush()` from
   * `useAutosave`. Optional so the prop type does not break any
   * future call site that does not yet thread a flush callable down.
   */
  onSaveNow?: () => void;
};

export function ViewerTopBar({
  volumeName,
  backTo,
  backLabel,
  saveStatus,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onRetrySave,
  onSaveNow,
}: ViewerTopBarProps) {
  const { t } = useTranslation("viewer");
  const saveStatusLabels: Record<SaveStatusValue, string> = {
    saved: t("save_status.saved"),
    saving: t("save_status.saving"),
    unsaved: t("save_status.unsaved"),
    error: t("save_status.error"),
  };

  return (
 <div className="flex h-10 shrink-0 items-center border-b border-stone-200 bg-white px-4">
 {/* Left: back link */}
 <Link
 to={backTo}
 className="flex shrink-0 items-center text-stone-500 hover:text-stone-700"
 aria-label={backLabel}
 >
 <ArrowLeft className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
 </Link>

 {/* Centre: volume name */}
 <h1 className="min-w-0 flex-1 truncate text-center text-sm font-medium text-stone-900">
 {volumeName}
 </h1>

 {/* Right: undo/redo + save status */}
 <div className="flex shrink-0 items-center gap-2">
 <button
 type="button"
 onClick={onUndo}
 disabled={!canUndo}
 className="flex h-6 w-6 items-center justify-center rounded text-stone-500 hover:bg-stone-100 hover:text-stone-700 disabled:cursor-not-allowed disabled:opacity-30"
 aria-label={t("toolbar.undo")}
 title={t("toolbar.undo_shortcut")}
 >
 <Undo2 className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
 </button>
 <button
 type="button"
 onClick={onRedo}
 disabled={!canRedo}
 className="flex h-6 w-6 items-center justify-center rounded text-stone-500 hover:bg-stone-100 hover:text-stone-700 disabled:cursor-not-allowed disabled:opacity-30"
 aria-label={t("toolbar.redo")}
 title={t("toolbar.redo_shortcut")}
 >
 <Redo2 className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
 </button>
 {saveStatus && (
 <SaveStatus
 status={saveStatus}
 labels={saveStatusLabels}
 retryLabel={t("save_status.save_failed_retry")}
 onRetry={onRetrySave}
 />
 )}
 {onSaveNow && (
 <button
 type="button"
 onClick={onSaveNow}
 className="font-sans text-xs font-medium text-stone-600 underline-offset-2 hover:text-stone-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-verdigris"
 >
 {t("save_status.save_now")}
 </button>
 )}
 </div>
 </div>
  );
}

// @version v0.8.0
