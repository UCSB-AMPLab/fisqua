/**
 * Promoted Badge
 *
 * Small pill shown next to a volume entry once it has been promoted
 * into a published description. Makes the promotion status
 * scannable at a glance in the promotion table.
 *
 * @version v0.3.0
 */

import { useTranslation } from "react-i18next";

interface PromotedBadgeProps {
  referenceCode?: string;
  descriptionLink?: string;
}

export function PromotedBadge({
  referenceCode,
  descriptionLink,
}: PromotedBadgeProps) {
  const { t } = useTranslation("promote");

  const badge = (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#E0E7F7] px-2 py-0.5 text-xs font-semibold text-[#3B5A9A]">
      {t("status.alreadyPromoted")}
      {referenceCode && (
        <span className="font-mono">&rarr; {referenceCode}</span>
      )}
    </span>
  );

  if (descriptionLink) {
    return (
      <a
        href={descriptionLink}
        className="text-[#6B1F33] hover:underline"
      >
        {badge}
      </a>
    );
  }

  return badge;
}
