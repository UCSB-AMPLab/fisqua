/**
 * Linked Descriptions Card
 *
 * Read-only card that lists the descriptions currently linked to an
 * entity, place, or vocabulary term. Collapses to a summary count
 * when long and expands on click; each row deep-links into the
 * description detail page.
 *
 * @version v0.3.0
 */

import { Link } from "react-router";
import { Pencil, X } from "lucide-react";
import type { TFunction } from "i18next";

interface LinkedDescriptionCardProps {
  linkId: string;
  descriptionId: string;
  descriptionTitle: string;
  referenceCode: string;
  descriptionLevel: string;
  role: string;
  roleNote?: string | null;
  sequence?: number;
  honorific?: string | null;
  function?: string | null;
  nameAsRecorded?: string | null;
  onEdit: (linkId: string) => void;
  onRemove: (linkId: string) => void;
  t: TFunction;
}

export function LinkedDescriptionsCard({
  linkId,
  descriptionId,
  descriptionTitle,
  referenceCode,
  role,
  roleNote,
  onEdit,
  onRemove,
  t,
}: LinkedDescriptionCardProps) {
  return (
    <div className="rounded-lg border border-[#E7E5E4] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-3 overflow-hidden">
          <Link
            to={`/admin/descriptions/${descriptionId}`}
            className="truncate font-serif text-sm text-[#44403C] hover:text-[#6B1F33] hover:underline"
          >
            {descriptionTitle}
          </Link>
          <span className="whitespace-nowrap font-mono text-xs text-[#78716C]">
            {referenceCode}
          </span>
          <span className="whitespace-nowrap rounded-full bg-[#F5E6EA] px-2 py-0.5 text-xs font-medium text-[#6B1F33]">
            {t(`role_${role}`)}
          </span>
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            aria-label={t("edit_link")}
            onClick={() => onEdit(linkId)}
            className="rounded p-1 text-[#78716C] hover:bg-[#F5F5F4] hover:text-[#44403C]"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={t("remove_link")}
            onClick={() => onRemove(linkId)}
            className="rounded p-1 text-[#78716C] hover:bg-[#F5E6EA] hover:text-[#DC2626]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      {roleNote && (
        <p className="mt-1 text-xs text-[#A8A29E]">{roleNote}</p>
      )}
    </div>
  );
}
