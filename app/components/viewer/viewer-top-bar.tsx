import { Link } from "react-router";
import { SaveStatus } from "./save-status";

type ViewerTopBarProps = {
  volumeName: string;
  projectId: string;
  pageLabel?: string;
  saveStatus?: "saved" | "saving" | "unsaved";
};

export function ViewerTopBar({ volumeName, projectId, pageLabel, saveStatus }: ViewerTopBarProps) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b border-stone-200 bg-white px-4">
      <Link
        to={`/projects/${projectId}/volumes`}
        className="flex items-center text-stone-500 hover:text-stone-700"
        aria-label="Back to volumes"
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
      <h1 className="truncate text-sm font-medium text-stone-900">
        {volumeName}
      </h1>
      {pageLabel && (
        <span className="text-xs text-stone-500">
          {pageLabel}
        </span>
      )}
      <span className="ml-auto">
        {saveStatus && <SaveStatus status={saveStatus} />}
      </span>
    </div>
  );
}
