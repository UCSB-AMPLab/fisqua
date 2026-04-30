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
    <div className="rounded-lg border border-stone-200 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-3 overflow-hidden">
          <Link
            to={`/admin/descriptions/${descriptionId}`}
            className="truncate font-serif text-sm text-stone-700 hover:text-indigo-deep hover:underline"
          >
            {descriptionTitle}
          </Link>
          <span className="whitespace-nowrap font-mono text-xs text-stone-500">
            {referenceCode}
          </span>
          <span className="whitespace-nowrap rounded-full bg-indigo-tint px-2 py-0.5 text-xs font-medium text-indigo-deep">
            {t(`role_${role}`)}
          </span>
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            aria-label={t("edit_link")}
            onClick={() => onEdit(linkId)}
            className="rounded p-1 text-stone-500 hover:bg-stone-100 hover:text-stone-700"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={t("remove_link")}
            onClick={() => onRemove(linkId)}
            className="rounded p-1 text-stone-500 hover:bg-indigo-tint hover:text-madder"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      {roleNote && (
        <p className="mt-1 text-xs text-stone-400">{roleNote}</p>
      )}
    </div>
  );
}
