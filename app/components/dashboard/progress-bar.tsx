/**
 * Stacked progress bar showing volume counts by workflow status.
 * Renders coloured segments proportional to counts.
 * Reusable across assignments page and lead dashboard.
 */

import { STATUS_STYLES } from "../workflow/status-badge";

type StackedProgressBarProps = {
  counts: Record<string, number>;
};

const STATUS_ORDER = [
  "unstarted",
  "in_progress",
  "segmented",
  "sent_back",
  "reviewed",
  "approved",
];

/** Map status -> Tailwind bg class for bar segments (darker than badge bg) */
const SEGMENT_COLORS: Record<string, string> = {
  unstarted: "bg-stone-300",
  in_progress: "bg-[#3B5A9A]",
  segmented: "bg-[#8B6914]",
  sent_back: "bg-[#8B2942]",
  reviewed: "bg-[#7C3AED]",
  approved: "bg-[#2F6B45]",
};

export function StackedProgressBar({ counts }: StackedProgressBarProps) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  if (total === 0) {
    return (
      <div className="h-3 w-full rounded-full bg-stone-100" />
    );
  }

  return (
    <div className="space-y-2">
      {/* Bar */}
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-stone-100">
        {STATUS_ORDER.map((status) => {
          const count = counts[status] ?? 0;
          if (count === 0) return null;
          const pct = (count / total) * 100;
          return (
            <div
              key={status}
              className={`${SEGMENT_COLORS[status] ?? "bg-stone-300"} transition-all`}
              style={{ width: `${pct}%` }}
              title={`${STATUS_STYLES[status]?.label ?? status}: ${count}`}
            />
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-600">
        {STATUS_ORDER.map((status) => {
          const count = counts[status] ?? 0;
          if (count === 0) return null;
          const style = STATUS_STYLES[status];
          return (
            <span key={status} className="flex items-center gap-1">
              <span
                className={`inline-block h-2 w-2 rounded-full ${SEGMENT_COLORS[status] ?? "bg-stone-300"}`}
              />
              {style?.label ?? status} ({count})
            </span>
          );
        })}
      </div>
    </div>
  );
}
