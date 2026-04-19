/**
 * Viewer Top Bar
 *
 * Page-level top bar for the viewer route: volume title, progress
 * breadcrumbs, and the save-status pill. Sits above the viewer
 * toolbar and is scroll-locked to the top of the page.
 *
 * @version v0.3.0
 */
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { SaveStatus } from "./save-status";

type ViewerTopBarProps = {
  volumeName: string;
  projectId: string;
  saveStatus?: "saved" | "saving" | "unsaved";
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
};

export function ViewerTopBar({
  volumeName,
  projectId,
  saveStatus,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: ViewerTopBarProps) {
  const { t } = useTranslation("viewer");

  return (
 <div className="flex h-10 shrink-0 items-center border-b border-stone-200 bg-white px-4">
 {/* Left: back arrow */}
 <Link
 to={`/projects/${projectId}/volumes`}
 className="flex shrink-0 items-center text-stone-500 hover:text-stone-700"
 aria-label={t("toolbar.back_to_volumes")}
 >
 <svg
 className="h-4 w-4"
 fill="none"
 viewBox="0 0 24 24"
 strokeWidth={2}
 stroke="currentColor"
 >
 <path
 strokeLinecap="round"
 strokeLinejoin="round"
 d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"
 />
 </svg>
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
 <svg
 className="h-4 w-4"
 fill="none"
 viewBox="0 0 24 24"
 strokeWidth={2}
 stroke="currentColor"
 >
 <path
 strokeLinecap="round"
 strokeLinejoin="round"
 d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3"
 />
 </svg>
 </button>
 <button
 type="button"
 onClick={onRedo}
 disabled={!canRedo}
 className="flex h-6 w-6 items-center justify-center rounded text-stone-500 hover:bg-stone-100 hover:text-stone-700 disabled:cursor-not-allowed disabled:opacity-30"
 aria-label={t("toolbar.redo")}
 title={t("toolbar.redo_shortcut")}
 >
 <svg
 className="h-4 w-4"
 fill="none"
 viewBox="0 0 24 24"
 strokeWidth={2}
 stroke="currentColor"
 >
 <path
 strokeLinecap="round"
 strokeLinejoin="round"
 d="M15 15l6-6m0 0-6-6m6 6H9a6 6 0 0 0 0 12h3"
 />
 </svg>
 </button>
 {saveStatus && <SaveStatus status={saveStatus} />}
 </div>
 </div>
  );
}
