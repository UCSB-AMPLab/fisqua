/**
 * Volume Status Card
 *
 * Per-volume progress card used across the dashboards: name,
 * segmentation state, entry counts by status, and the cataloguer /
 * reviewer avatars. Clicking the card opens the viewer in the
 * caller's default mode.
 *
 * @version v0.3.0
 */
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Flag } from "lucide-react";
import { StatusBadge } from "../workflow/status-badge";
import { relativeTime } from "~/lib/format";

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
  openQcFlagCount?: number;
};

type VolumeStatusCardProps = {
  volume: VolumeCardData;
};

export function VolumeStatusCard({ volume }: VolumeStatusCardProps) {
  const { t } = useTranslation(["common", "dashboard", "qc_flags"]);
  const openFlagCount = volume.openQcFlagCount ?? 0;

  return (
    <Link
      to={`/projects/${volume.projectId}/volumes/${volume.id}`}
      className="block rounded-lg border border-stone-200 p-4 hover:shadow-sm"
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
        <div className="flex shrink-0 items-center gap-1.5">
          {openFlagCount > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-madder-tint px-2 py-0.5 text-xs font-semibold text-madder-deep"
              title={t("qc_flags:badge.open_count", { count: openFlagCount })}
            >
              <Flag className="h-3 w-3" aria-hidden="true" />
              {t("qc_flags:badge.open_count", { count: openFlagCount })}
            </span>
          )}
          <StatusBadge status={volume.status} />
        </div>
      </div>

      <div className="mt-2 flex items-center gap-3 text-xs text-stone-500">
        <span>{t("common:domain.image_count", { count: volume.pageCount })}</span>
        <span>{t("common:domain.document_count", { count: volume.entryCount })}</span>
        {volume.cataloguerName && (
          <span className="truncate">{t("dashboard:by", { name: volume.cataloguerName })}</span>
        )}
      </div>

      <div className="mt-1 text-xs text-stone-400">
        {relativeTime(volume.updatedAt)}
      </div>

      {volume.status === "sent_back" && volume.reviewComment && (
        <div className="mt-2 rounded border-l-2 border-madder bg-madder-tint px-3 py-2 text-xs text-madder-deep">
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
