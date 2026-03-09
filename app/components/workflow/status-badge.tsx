/**
 * Reusable status badge component for volume workflow statuses.
 * Renders a small pill/badge with background and text colour per status.
 */

export const STATUS_STYLES: Record<
  string,
  { bg: string; text: string; label: string }
> = {
  unstarted: { bg: "bg-stone-100", text: "text-stone-600", label: "Unstarted" },
  in_progress: { bg: "bg-blue-100", text: "text-blue-700", label: "In progress" },
  segmented: { bg: "bg-amber-100", text: "text-amber-700", label: "Segmented" },
  sent_back: { bg: "bg-red-100", text: "text-red-700", label: "Needs revision" },
  reviewed: { bg: "bg-purple-100", text: "text-purple-700", label: "Reviewed" },
  approved: { bg: "bg-green-100", text: "text-green-700", label: "Approved" },
};

type StatusBadgeProps = {
  status: string;
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const style = STATUS_STYLES[status] ?? {
    bg: "bg-stone-100",
    text: "text-stone-600",
    label: status,
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${style.bg} ${style.text}`}
    >
      {style.label}
    </span>
  );
}
