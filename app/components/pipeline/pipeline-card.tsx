/**
 * Pipeline Card
 *
 * Single card in the pipeline kanban: entry reference code, current
 * status, describer and reviewer avatars, open QC flags, and the
 * lead-only assignment affordance. Draggable between columns to move
 * the entry through the workflow.
 *
 * @version v0.3.0
 */
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ArrowRight, Plus } from "lucide-react";
import type { PipelineItem } from "~/lib/pipeline/pipeline.server";

interface PipelineCardProps {
  item: PipelineItem;
  columnId: string;
  isSuperAdmin: boolean;
  onAssignClick?: (entryId: string, projectId: string) => void;
}

export function PipelineCard({
  item,
  columnId,
  isSuperAdmin,
  onAssignClick,
}: PipelineCardProps) {
  const { t } = useTranslation("pipeline");

  const daysSinceUpdate = Math.floor(
    (Date.now() / 1000 - item.updatedAt) / 86400
  );
  const timeLabel =
    daysSinceUpdate < 1
      ? t("time_today")
      : t("time_days", { count: daysSinceUpdate });

  return (
    <div
      className={`rounded-lg border border-stone-200 bg-white p-3 hover:shadow-sm ${ item.isSentBack ? "border-l-2 border-l-indigo" : "" }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="truncate text-sm text-stone-700">{item.name}</p>

        {columnId === "ready_to_describe" && onAssignClick && (
          <button
            type="button"
            onClick={() => onAssignClick(item.id, item.projectId)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-dashed border-stone-400 text-stone-400 hover:border-indigo hover:text-indigo"
            aria-label={t("assign_describer")}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}

        {columnId === "ready_to_promote" && isSuperAdmin && (
          <Link
            to="/admin/cataloguing/promote"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-stone-400 hover:text-indigo"
            aria-label={t("go_to_promote")}
          >
            <ArrowRight className="h-4 w-4" />
          </Link>
        )}
      </div>

      <div className="mt-1.5 flex items-center gap-2">
        <span className="text-xs text-stone-500">
          {item.assignee ?? "-"}
        </span>
        <span className="text-xs text-stone-400">{item.projectName}</span>
        <span className="text-xs text-stone-400">{timeLabel}</span>
      </div>

      {item.isSentBack && (
        <span className="mt-1.5 inline-block rounded bg-indigo-tint px-1.5 py-0.5 text-xs text-indigo">
          {t("sent_back")}
        </span>
      )}
    </div>
  );
}
