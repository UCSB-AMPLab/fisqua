/**
 * Reusable volume status card for dashboard views.
 * Shows volume name, progress info, status badge, and optional reviewer comment.
 */

import { Link } from "react-router";
import { StatusBadge } from "../workflow/status-badge";

export type VolumeCardData = {
  id: string;
  name: string;
  pageCount: number;
  entryCount: number;
  status: string;
  projectId: string;
  projectName: string;
  updatedAt: number;
  reviewComment?: string | null;
  cataloguerName?: string | null;
  assignedReviewerName?: string | null;
};

function relativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  if (days > 0) return rtf.format(-days, "day");
  if (hours > 0) return rtf.format(-hours, "hour");
  if (minutes > 0) return rtf.format(-minutes, "minute");
  return rtf.format(-seconds, "second");
}

type VolumeStatusCardProps = {
  volume: VolumeCardData;
};

export function VolumeStatusCard({ volume }: VolumeStatusCardProps) {
  return (
    <Link
      to={`/projects/${volume.projectId}/volumes/${volume.id}`}
      className="block rounded-lg border border-stone-200 p-4 hover:border-stone-300 hover:shadow-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-medium text-stone-900">
            {volume.name}
          </h3>
          <p className="mt-0.5 text-xs text-stone-500">
            {volume.projectName}
          </p>
        </div>
        <StatusBadge status={volume.status} />
      </div>

      <div className="mt-2 flex items-center gap-3 text-xs text-stone-500">
        <span>{volume.pageCount} pages</span>
        <span>{volume.entryCount} entries</span>
        {volume.cataloguerName && (
          <span className="truncate">by {volume.cataloguerName}</span>
        )}
      </div>

      <div className="mt-1 text-xs text-stone-400">
        {relativeTime(volume.updatedAt)}
      </div>

      {volume.status === "sent_back" && volume.reviewComment && (
        <div className="mt-2 rounded border-l-2 border-red-400 bg-red-50 px-3 py-2 text-xs text-red-700">
          {volume.reviewComment}
        </div>
      )}
    </Link>
  );
}

/**
 * Calculate how many days since a timestamp.
 */
export function daysSince(timestamp: number): number {
  const diff = Date.now() - timestamp;
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}
