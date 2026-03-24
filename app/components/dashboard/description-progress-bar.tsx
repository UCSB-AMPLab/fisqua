/**
 * Stacked progress bar for description workflow statuses.
 * Parallel to StackedProgressBar but uses description status colours.
 */

import { useTranslation } from "react-i18next";

type DescriptionProgressBarProps = {
  counts: Record<string, number>;
};

const DESC_STATUS_ORDER = [
  "unassigned",
  "assigned",
  "in_progress",
  "described",
  "reviewed",
  "approved",
  "sent_back",
];

/** Map description status -> Tailwind bg class for bar segments */
const DESC_SEGMENT_COLORS: Record<string, string> = {
  unassigned: "bg-[#78716C]",
  assigned: "bg-[#3B5A9A]",
  in_progress: "bg-[#8B6914]",
  described: "bg-[#7C3AED]",
  reviewed: "bg-[#0D9488]",
  approved: "bg-[#2F6B45]",
  sent_back: "bg-[#8B2942]",
};

export function DescriptionProgressBar({ counts }: DescriptionProgressBarProps) {
  const { t } = useTranslation("description");
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const approved = counts["approved"] ?? 0;

  if (total === 0) {
    return (
      <div className="h-3 w-full rounded-full bg-stone-100" />
    );
  }

  return (
    <div className="space-y-1">
      {/* Label */}
      <div className="flex items-center justify-between">
        <span className="text-[0.8125rem] font-semibold uppercase text-[#78716C]">
          {t("tabs.descripcion")}
        </span>
        <span className="text-xs text-stone-500">
          {t("progress.items_approved", { approved, total })}
        </span>
      </div>

      {/* Bar */}
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-stone-100">
        {DESC_STATUS_ORDER.map((status) => {
          const count = counts[status] ?? 0;
          if (count === 0) return null;
          const pct = (count / total) * 100;
          const label = t(`status.${status}`);
          return (
            <div
              key={status}
              className={`${DESC_SEGMENT_COLORS[status] ?? "bg-stone-300"} transition-all`}
              style={{ width: `${pct}%` }}
              title={`${label}: ${count}`}
            />
          );
        })}
      </div>
    </div>
  );
}
