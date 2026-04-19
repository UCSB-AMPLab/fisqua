/**
 * Pipeline Column
 *
 * One status column in the pipeline kanban. Lists every entry in
 * that status, sorted by most-recently-touched, and accepts drops
 * from other columns to trigger the workflow transition through
 * the parent form action.
 *
 * @version v0.3.0
 */
import { useTranslation } from "react-i18next";
import { PipelineCard } from "./pipeline-card";
import type { PipelineColumn as PipelineColumnType } from "~/lib/pipeline/pipeline.server";

interface PipelineColumnProps {
  column: PipelineColumnType;
  columnId: string;
  isSuperAdmin: boolean;
  onAssignClick?: (entryId: string, projectId: string) => void;
}

export function PipelineColumn({
  column,
  columnId,
  isSuperAdmin,
  onAssignClick,
}: PipelineColumnProps) {
  const { t } = useTranslation("pipeline");

  return (
    <div className="min-w-[160px] flex-1 rounded-lg bg-[#FAFAF9] p-3">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[#44403C]">
          {t(`col_${columnId}`)}
        </h3>
        <span className="rounded-full bg-[#E7E5E4] px-2 py-0.5 text-xs text-[#78716C]">
          {column.items.length}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {column.items.map((item) => (
          <PipelineCard
            key={item.id}
            item={item}
            columnId={columnId}
            isSuperAdmin={isSuperAdmin}
            onAssignClick={onAssignClick}
          />
        ))}
      </div>
    </div>
  );
}
