/**
 * Promotion Table
 *
 * Row-per-entry table of the currently promotable crowdsourcing entries
 * in the selected volume. Each row shows the reference code, the field
 * fill rate, the current promotion state, and a checkbox to include
 * it in the batch. Rows already promoted render the PromotedBadge and
 * their checkboxes are disabled.
 *
 * @version v0.3.0
 */

import { useTranslation } from "react-i18next";
import { PromotedBadge } from "./promoted-badge";

interface EntryRow {
  id: string;
  title: string | null;
  startPage: number;
  endPage: number | null;
  parentId: string | null;
  promotedDescriptionId: string | null;
  childCount?: number;
}

interface PromotionTableProps {
  entries: EntryRow[];
  alreadyPromoted: EntryRow[];
  selectedIds: Set<string>;
  referenceCodes: Record<string, string>;
  onToggle: (entryId: string) => void;
  onToggleAll: () => void;
  onRefCodeChange: (entryId: string, code: string) => void;
  onEntryClick?: (entry: EntryRow) => void;
  activeEntryId?: string | null;
}

export function PromotionTable({
  entries,
  alreadyPromoted,
  selectedIds,
  referenceCodes,
  onToggle,
  onToggleAll,
  onRefCodeChange,
  onEntryClick,
  activeEntryId,
}: PromotionTableProps) {
  const { t } = useTranslation("promote");

  const allSelected =
    entries.length > 0 && entries.every((e) => selectedIds.has(e.id));
  const allEntries = [...entries, ...alreadyPromoted];

  return (
    <div className="overflow-x-auto rounded-lg border border-stone-300">
      <table className="w-full">
        <thead>
          <tr className="bg-stone-50">
            <th className="w-10 px-3 py-2">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={onToggleAll}
                className="accent-[#8B2942]"
              />
            </th>
            <th className="px-4 py-2 text-left text-xs font-normal uppercase tracking-wide text-stone-500">
              {t("table.col.title")}
            </th>
            <th className="px-4 py-2 text-left text-xs font-normal uppercase tracking-wide text-stone-500">
              {t("table.col.pages")}
            </th>
            <th className="px-4 py-2 text-left text-xs font-normal uppercase tracking-wide text-stone-500">
              {t("table.col.refCode")}
            </th>
            <th className="px-4 py-2 text-left text-xs font-normal uppercase tracking-wide text-stone-500">
              {t("table.col.status")}
            </th>
          </tr>
          <tr className="border-b border-stone-200 bg-stone-50">
            <td colSpan={5} className="px-4 py-1">
              <button
                type="button"
                onClick={onToggleAll}
                className="cursor-pointer text-sm text-[#8B2942]"
              >
                {allSelected ? t("table.deselectAll") : t("table.selectAll")}
              </button>
            </td>
          </tr>
        </thead>
        <tbody>
          {allEntries.map((entry) => {
            const isPromoted = !!entry.promotedDescriptionId;
            const isSelected = selectedIds.has(entry.id);
            const isActive = activeEntryId === entry.id;

            return (
              <tr
                key={entry.id}
                className={`border-b border-stone-100 transition-colors ${
                  isPromoted ? "opacity-60" : "hover:bg-stone-50"
                } ${isActive ? "border-l-2 border-l-[#8B2942]" : ""}`}
                onClick={() => !isPromoted && onEntryClick?.(entry)}
              >
                <td className="px-3 py-2 text-center">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onToggle(entry.id)}
                    disabled={isPromoted}
                    className="accent-[#8B2942]"
                  />
                </td>
                <td className="max-w-xs px-4 py-2">
                  <p className="line-clamp-2 font-sans text-sm text-stone-900">
                    {entry.title || "Untitled"}
                  </p>
                  {(entry.childCount ?? 0) > 0 && (
                    <span className="text-xs text-stone-400">
                      {t("table.children", { count: entry.childCount })}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2 font-sans text-sm text-stone-700">
                  {entry.startPage}
                  {entry.endPage != null && entry.endPage !== entry.startPage
                    ? `\u2013${entry.endPage}`
                    : ""}
                </td>
                <td className="px-4 py-2">
                  {isPromoted ? (
                    <PromotedBadge
                      referenceCode={
                        referenceCodes[entry.id] || undefined
                      }
                    />
                  ) : (
                    <input
                      type="text"
                      value={referenceCodes[entry.id] || ""}
                      onChange={(e) =>
                        onRefCodeChange(entry.id, e.target.value)
                      }
                      className="w-full rounded border border-stone-300 px-2 py-1 font-mono text-sm focus:border-[#8B2942] focus:ring-[#8B2942] focus:outline-none"
                    />
                  )}
                </td>
                <td className="px-4 py-2">
                  {isPromoted && (
                    <PromotedBadge
                      descriptionLink={
                        entry.promotedDescriptionId
                          ? `/descriptions/${entry.promotedDescriptionId}`
                          : undefined
                      }
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
