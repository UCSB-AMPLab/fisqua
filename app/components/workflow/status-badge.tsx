/**
 * Reusable status badge component for volume workflow statuses.
 * Renders a small pill/badge with background and text colour per status.
 */

export const STATUS_STYLES: Record<
  string,
  { bg: string; text: string; label: string }
> = {
  unstarted: { bg: "bg-stone-100", text: "text-stone-600", label: "Unstarted" },
  in_progress: { bg: "bg-[#E0E7F7]", text: "text-[#3B5A9A]", label: "In progress" },
  segmented: { bg: "bg-[#F9EDD4]", text: "text-[#8B6914]", label: "Segmented" },
  sent_back: { bg: "bg-[#F5E6EA]", text: "text-[#8B2942]", label: "Needs revision" },
  reviewed: { bg: "bg-[#E9D5FF]", text: "text-[#7C3AED]", label: "Reviewed" },
  approved: { bg: "bg-[#D6E8DB]", text: "text-[#2F6B45]", label: "Approved" },
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
