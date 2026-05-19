/**
 * Stacked Progress Bar
 *
 * This component is the horizontal segmented bar that summarises a
 * collection of volumes by their workflow status — one coloured segment
 * per status, sized proportionally to the volume count in that bucket.
 * The status colour palette is pulled from the same `--*-bg` design
 * tokens the status badges use, so a project card and an assignment
 * filter chip stay in chromatic sync. The bar takes a flat `counts`
 * record keyed by status name, which keeps it reusable across the
 * assignments page (lead-side, per-project) and the lead dashboard
 * (multi-project overview) without any per-caller adaptation. Empty
 * counts render as a single muted track so the layout never collapses
 * to zero height.
 *
 * @version v0.3.0
 */

import { useTranslation } from "react-i18next";

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
  in_progress: "bg-indigo",
  segmented: "bg-saffron-deep",
  sent_back: "bg-indigo",
  reviewed: "bg-sage-deep",
  approved: "bg-verdigris",
};

export function StackedProgressBar({ counts }: StackedProgressBarProps) {
  const { t } = useTranslation("workflow");
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  if (total === 0) {
    return (
      <div className="h-1.5 w-full rounded-full bg-stone-100" />
    );
  }

  return (
    <div className="space-y-2">
      {/* Bar */}
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-stone-100">
        {STATUS_ORDER.map((status) => {
          const count = counts[status] ?? 0;
          if (count === 0) return null;
          const pct = (count / total) * 100;
          const label = t(`status.${status}`);
          return (
            <div
              key={status}
              className={`${SEGMENT_COLORS[status] ?? "bg-stone-300"} transition-all`}
              style={{ width: `${pct}%` }}
              title={`${label}: ${count}`}
            />
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-600">
        {STATUS_ORDER.map((status) => {
          const count = counts[status] ?? 0;
          if (count === 0) return null;
          const label = t(`status.${status}`);
          return (
            <span key={status} className="flex items-center gap-1">
              <span
                className={`inline-block h-2 w-2 rounded-full ${SEGMENT_COLORS[status] ?? "bg-stone-300"}`}
              />
              {label} ({count})
            </span>
          );
        })}
      </div>
    </div>
  );
}
