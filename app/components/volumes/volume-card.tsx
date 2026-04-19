/**
 * Volume Card
 *
 * Per-volume card used on the project volumes page and on the lead
 * dashboard. Surfaces the volume name, status, assigned cataloguer
 * and reviewer, entry counts by status, and any open QC flag count.
 * Clicking the card opens the viewer at the first unresolved page.
 *
 * @version v0.3.0
 */
import { Form, Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Flag } from "lucide-react";

type VolumeCardProps = {
  volume: {
    id: string;
    name: string;
    referenceCode: string;
    pageCount: number;
    status: string;
    assignedTo: string | null;
    firstPageImageUrl: string | null;
    openQcFlagCount?: number;
  };
  projectId: string;
};

const statusBadgeColors: Record<string, string> = {
  unstarted: "bg-[#E7E5E4] text-[#78716C]",
  in_progress: "bg-[#F9EDD4] text-[#8B6914]",
  segmented: "bg-[#E9D5FF] text-[#7C3AED]",
  reviewed: "bg-[#CCF0EB] text-[#0D9488]",
  approved: "bg-[#D6E8DB] text-[#2F6B45]",
  sent_back: "bg-[#F5E6EA] text-[#8B2942]",
};

export function VolumeCard({ volume, projectId }: VolumeCardProps) {
  const { t } = useTranslation(["project", "workflow", "common", "qc_flags"]);
  const thumbnailUrl = volume.firstPageImageUrl
    ? `${volume.firstPageImageUrl}/full/200,/0/default.jpg`
    : null;

  const canDelete = !volume.assignedTo && volume.status === "unstarted";
  const openFlagCount = volume.openQcFlagCount ?? 0;

  return (
    <div className="group relative overflow-hidden rounded-lg border border-[#E7E5E4] bg-white shadow-sm transition-shadow hover:shadow-md">
      <Link
        to={`/projects/${projectId}/volumes/${volume.id}/manage`}
        className="block"
      >
        {/* Thumbnail */}
        <div className="flex h-40 items-center justify-center bg-[#FAFAF9]">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt={t("project:volume_card.first_page_alt", { name: volume.name })}
              className="h-full w-full rounded-t-lg object-cover"
            />
          ) : (
            <svg
              className="h-12 w-12 text-stone-300"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
              />
            </svg>
          )}
        </div>

        {/* Body */}
        <div className="p-3">
          <h3 className="truncate font-serif text-sm font-semibold text-[#44403C]">
            {volume.name}
          </h3>
          <p className="mt-0.5 font-mono text-xs text-[#78716C]">{volume.referenceCode}</p>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="font-sans text-xs text-[#78716C]">
              {t("common:domain.image_count", { count: volume.pageCount })}
            </span>
            <div className="flex items-center gap-1.5">
              {openFlagCount > 0 && (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 font-sans text-xs font-semibold text-red-700"
                  title={t("qc_flags:badge.open_count", { count: openFlagCount })}
                >
                  <Flag className="h-3 w-3" aria-hidden="true" />
                  {t("qc_flags:badge.open_count", { count: openFlagCount })}
                </span>
              )}
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 font-sans text-xs font-semibold ${statusBadgeColors[volume.status] || "bg-[#E7E5E4] text-[#78716C]"}`}
              >
                {t(`workflow:status.${volume.status}`)}
              </span>
            </div>
          </div>
        </div>
      </Link>

      {/* Hover delete button for unassigned volumes */}
      {canDelete && (
        <Form
          method="post"
          className="absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100"
          onSubmit={(e) => {
            if (
              !window.confirm(
                t("project:volume_card.delete_confirm")
              )
            ) {
              e.preventDefault();
            }
          }}
        >
          <input type="hidden" name="_action" value="delete-volume" />
          <input type="hidden" name="volumeId" value={volume.id} />
          <button
            type="submit"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/90 backdrop-blur-sm transition-colors hover:bg-white"
            title={t("common:button.delete")}
          >
            <svg className="h-4 w-4 text-[#8B2942]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
            </svg>
          </button>
        </Form>
      )}
    </div>
  );
}

