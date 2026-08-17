/**
 * Admin — bulk action bar (browse surfaces)
 *
 * The bar that appears above a list once rows are ticked, carrying the
 * two errands a selection is on: keep it (add to a handlist) or take
 * it somewhere (send to export). It is the browse-time twin of the
 * search page's selection bar, and it deliberately reads the same —
 * the same count sentence, the same two actions, Clear at the tail —
 * because a cataloguer who learns the gesture on one surface should
 * not have to learn it again on the other.
 *
 * ONE COLUMN, MORE THAN ONE JOB. The authority lists already ticked
 * rows for the two-record merge before they ticked them for anything
 * else. Rather than a second checkbox column, the surface keeps one
 * selection and this bar carries both errands: whatever the caller
 * passes as `extraActions` (the merge affordance, enabled at exactly
 * two) sits beside the handlist and export actions, which work at any
 * count. A record is ticked once and the bar offers what that number
 * of ticks can actually do.
 *
 * WHAT IT DOES NOT OFFER is "select all matching". A list ticks the
 * rows it is showing; the promise of a whole result set belongs to the
 * search page, which holds the query that could re-run it. Offering it
 * here would mean claiming a count this surface cannot stand behind.
 *
 * @version v0.7.0
 */

import type { ReactNode } from "react";
import { useFetcher } from "react-router";
import { Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { HandlistPicker } from "~/components/handlists/handlist-picker";
import type { HandlistPickerType } from "~/components/handlists/handlist-picker";

/** Per-kind count sentences, composed whole rather than assembled. */
const COUNT_KEYS: Record<HandlistPickerType, string> = {
  records: "bulkCountRecords",
  entities: "bulkCountEntities",
  places: "bulkCountPlaces",
};

export function BulkActionBar({
  recordType,
  selectedIds,
  label,
  onClear,
  extraActions,
}: {
  /** What the ticked rows are — it types the handlist and the scope. */
  recordType: HandlistPickerType;
  selectedIds: string[];
  /**
   * Where the selection was made, in the reader's own language. It
   * becomes the carried scope's single pill on the export page, so it
   * should name the surface ("Descriptions", "Entities"), not the
   * action.
   */
  label: string;
  onClear: () => void;
  /** Surface-specific actions — the authority lists' merge. */
  extraActions?: ReactNode;
}) {
  const { t } = useTranslation("authorities");
  const carry = useFetcher();
  const count = selectedIds.length;
  if (count === 0) return null;

  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-indigo-tint bg-indigo-wash px-4 py-2">
      <span className="text-13 nums font-semibold text-indigo">
        {t(COUNT_KEYS[recordType], { count })}
      </span>
      <div className="flex flex-wrap items-center gap-3">
        {extraActions}
        <button
          type="button"
          onClick={onClear}
          className="text-13 font-semibold text-indigo hover:underline"
        >
          {t("bulkClear")}
        </button>
        <HandlistPicker
          recordType={recordType}
          memberIds={selectedIds}
          intent="save"
          triggerLabel={t("bulkAddToHandlist")}
          triggerClassName="inline-flex items-center gap-2 rounded-md border border-indigo-tint bg-parchment px-4 py-2 text-13 font-semibold text-indigo hover:bg-indigo-tint"
        />
        {/* The carry is a POST because it creates a stash the export
            page then spends; the redirect it answers with lands on the
            same carried tile the search page's own carry lands on. */}
        <carry.Form method="post" action="/admin/exports/carry">
          <input type="hidden" name="recordType" value={recordType} />
          <input
            type="hidden"
            name="memberIds"
            value={JSON.stringify(selectedIds)}
          />
          <input type="hidden" name="label" value={label} />
          <button
            type="submit"
            disabled={carry.state !== "idle"}
            className="inline-flex items-center gap-2 rounded-md bg-indigo px-4 py-2 text-13 font-semibold text-parchment hover:bg-indigo-deep disabled:opacity-40"
          >
            <Upload className="h-4 w-4" strokeWidth={1.5} />
            {t("bulkSendToExport")}
          </button>
        </carry.Form>
      </div>
    </div>
  );
}

/* @version v0.7.0 */
