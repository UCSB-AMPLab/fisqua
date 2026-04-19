/**
 * Promotion Summary Panel
 *
 * Pre-flight summary that sits above the promotion table: how many
 * entries are selected, how many fields each one will copy, and the
 * resulting reference-code pattern. Lets the superadmin sanity-check
 * the batch before committing.
 *
 * @version v0.3.0
 */

import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";

interface SummaryEntry {
  entryId: string;
  title: string;
  referenceCode: string;
  parentReferenceCode: string;
  fieldCount: number;
}

interface PromotionSummaryProps {
  entries: SummaryEntry[];
  onConfirm: () => void;
  onBack: () => void;
  isSubmitting: boolean;
}

/** Total mapped fields per entry (the 12 ISAD(G) fields) */
const TOTAL_MAPPED_FIELDS = 12;

export function PromotionSummary({
  entries,
  onConfirm,
  onBack,
  isSubmitting,
}: PromotionSummaryProps) {
  const { t } = useTranslation("promote");

  return (
    <div className="rounded-lg border border-stone-300 bg-stone-50 p-4">
      <h3 className="text-lg font-semibold text-stone-900">
        {t("summary.heading")}
      </h3>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-stone-200">
              <th className="px-4 py-2 text-left text-xs font-normal uppercase tracking-wide text-stone-500">
                {t("table.col.title")}
              </th>
              <th className="px-4 py-2 text-left text-xs font-normal uppercase tracking-wide text-stone-500">
                {t("table.col.refCode")}
              </th>
              <th className="px-4 py-2 text-left text-xs font-normal uppercase tracking-wide text-stone-500">
                {t("summary.col.parent")}
              </th>
              <th className="px-4 py-2 text-left text-xs font-normal uppercase tracking-wide text-stone-500">
                {t("summary.col.fields")}
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr
                key={entry.entryId}
                className="border-b border-stone-100"
              >
                <td className="max-w-xs px-4 py-2 font-sans text-sm text-stone-900">
                  {entry.title}
                </td>
                <td className="px-4 py-2 font-mono text-sm text-stone-700">
                  {entry.referenceCode}
                </td>
                <td className="px-4 py-2 font-mono text-sm text-stone-500">
                  {entry.parentReferenceCode}
                </td>
                <td className="px-4 py-2 font-sans text-sm text-stone-700">
                  {entry.fieldCount}/{TOTAL_MAPPED_FIELDS}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6 flex items-center gap-4">
        <button
          type="button"
          onClick={onConfirm}
          disabled={isSubmitting}
          className="rounded bg-[#6B1F33] px-6 py-2.5 font-semibold text-white hover:bg-[#8B2942] disabled:opacity-50"
        >
          {isSubmitting ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("action.promote", { count: entries.length })}
            </span>
          ) : (
            t("action.promote", { count: entries.length })
          )}
        </button>
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-stone-500 hover:text-stone-700"
        >
          {t("action.back")}
        </button>
      </div>
    </div>
  );
}
