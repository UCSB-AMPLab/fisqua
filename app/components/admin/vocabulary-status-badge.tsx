/**
 * Vocabulary Status Badge
 *
 * Colour-coded status pill for vocabulary-term rows: active, draft,
 * pending review, rejected, or deprecated. Keeps the colour map in
 * one place so every vocabularies admin surface shows the same
 * visual vocabulary.
 *
 * @version v0.3.0
 */

import { useTranslation } from "react-i18next";

const STATUS_STYLES: Record<string, string> = {
  approved: "bg-[#D6E8DB] text-[#2F6B45]",
  proposed: "bg-[#FEF3C7] text-[#78350F]",
  deprecated: "bg-[#F5F5F4] text-[#78716C]",
};

interface VocabularyStatusBadgeProps {
  status: "approved" | "proposed" | "deprecated";
}

export function VocabularyStatusBadge({ status }: VocabularyStatusBadgeProps) {
  const { t } = useTranslation("vocabularies");
  const style = STATUS_STYLES[status] ?? "";
  const label = t(`status_${status}`);

  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${style}`}
    >
      {label}
    </span>
  );
}
