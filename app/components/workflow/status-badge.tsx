/**
 * Reusable status badge components for workflow statuses.
 *
 * StatusBadge: segmentation (volume) workflow statuses.
 * DescriptionStatusBadge: description (per-entry) workflow statuses.
 *
 * Each variant has its own colour palette to avoid confusion between the
 * two parallel workflows.
 */

import { useTranslation } from "react-i18next";

/** Segmentation (volume) status styles */
export const STATUS_STYLES: Record<
  string,
  { bg: string; text: string }
> = {
  unstarted: { bg: "bg-stone-100", text: "text-stone-600" },
  in_progress: { bg: "bg-[#E0E7F7]", text: "text-[#3B5A9A]" },
  segmented: { bg: "bg-[#F9EDD4]", text: "text-[#8B6914]" },
  sent_back: { bg: "bg-[#F5E6EA]", text: "text-[#8B2942]" },
  reviewed: { bg: "bg-[#E9D5FF]", text: "text-[#7C3AED]" },
  approved: { bg: "bg-[#D6E8DB]", text: "text-[#2F6B45]" },
};

/** Description (per-entry) status styles -- distinct palette from segmentation */
export const DESCRIPTION_STATUS_STYLES: Record<
  string,
  { bg: string; text: string }
> = {
  unassigned: { bg: "bg-[#E7E5E4]", text: "text-[#78716C]" },
  assigned: { bg: "bg-[#E0E7F7]", text: "text-[#3B5A9A]" },
  in_progress: { bg: "bg-[#F9EDD4]", text: "text-[#8B6914]" },
  described: { bg: "bg-[#E9D5FF]", text: "text-[#7C3AED]" },
  reviewed: { bg: "bg-[#CCF0EB]", text: "text-[#0D9488]" },
  approved: { bg: "bg-[#D6E8DB]", text: "text-[#2F6B45]" },
  sent_back: { bg: "bg-[#F5E6EA]", text: "text-[#8B2942]" },
};

type StatusBadgeProps = {
  status: string;
};

/** Badge for segmentation (volume) workflow statuses */
export function StatusBadge({ status }: StatusBadgeProps) {
  const { t } = useTranslation("workflow");
  const style = STATUS_STYLES[status] ?? {
    bg: "bg-stone-100",
    text: "text-stone-600",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${style.bg} ${style.text}`}
    >
      {t(`status.${status}`)}
    </span>
  );
}

/** Badge for description (per-entry) workflow statuses */
export function DescriptionStatusBadge({ status }: StatusBadgeProps) {
  const { t } = useTranslation("description");
  const style = DESCRIPTION_STATUS_STYLES[status] ?? {
    bg: "bg-[#E7E5E4]",
    text: "text-[#78716C]",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${style.bg} ${style.text}`}
    >
      {t(`status.${status}`)}
    </span>
  );
}
