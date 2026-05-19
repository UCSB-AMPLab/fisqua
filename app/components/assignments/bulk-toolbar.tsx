/**
 * Bulk Assignment Toolbar
 *
 * This toolbar is the sticky strip that surfaces above the assignment
 * table the moment a lead ticks one or more row checkboxes. It carries a
 * pair of cataloguer / reviewer dropdowns plus Apply and Clear buttons,
 * so the lead can fan out the same pair of assignees across the whole
 * selection in one submission. The selection set lives on the parent
 * page; this component is purely the affordance.
 *
 * @version v0.3.0
 */

import { useFetcher } from "react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MemberOption } from "./assignment-table";

type BulkToolbarProps = {
  selectedCount: number;
  selectedIds: Set<string>;
  cataloguers: MemberOption[];
  reviewers: MemberOption[];
  onClear: () => void;
};

export function BulkToolbar({
  selectedCount,
  selectedIds,
  cataloguers,
  reviewers,
  onClear,
}: BulkToolbarProps) {
  const { t } = useTranslation(["workflow", "common"]);
  const fetcher = useFetcher();
  const [bulkCataloguer, setBulkCataloguer] = useState("");
  const [bulkReviewer, setBulkReviewer] = useState("");

  if (selectedCount === 0) return null;

  function handleApply() {
    fetcher.submit(
      {
        _action: "bulk-assign",
        volumeIds: JSON.stringify(Array.from(selectedIds)),
        cataloguerId: bulkCataloguer,
        reviewerId: bulkReviewer,
      },
      { method: "post" }
    );
    onClear();
    setBulkCataloguer("");
    setBulkReviewer("");
  }

  return (
    <div className="sticky top-0 z-10 flex items-center gap-4 rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 shadow-sm">
      <span className="text-sm font-medium text-stone-700">
        {t("workflow:bulk.selected", { count: selectedCount })}
      </span>

      <select
        value={bulkCataloguer}
        onChange={(e) => setBulkCataloguer(e.target.value)}
        className="rounded border border-stone-200 bg-white px-2 py-1 text-sm text-stone-700"
      >
        <option value="">{t("workflow:dropdown.cataloguer_placeholder")}</option>
        <option value="__unassign__">{t("workflow:action.unassign")}</option>
        {cataloguers.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name ?? m.email}
          </option>
        ))}
      </select>

      <select
        value={bulkReviewer}
        onChange={(e) => setBulkReviewer(e.target.value)}
        className="rounded border border-stone-200 bg-white px-2 py-1 text-sm text-stone-700"
      >
        <option value="">{t("workflow:dropdown.reviewer_placeholder")}</option>
        <option value="__unassign__">{t("workflow:action.unassign")}</option>
        {reviewers.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name ?? m.email}
          </option>
        ))}
      </select>

      <button
        onClick={handleApply}
        disabled={!bulkCataloguer && !bulkReviewer}
        className="rounded bg-indigo px-3 py-1 text-sm font-medium text-parchment hover:bg-indigo-deep disabled:opacity-50"
      >
        {t("common:button.apply")}
      </button>

      <button
        onClick={onClear}
        className="text-sm text-stone-500 hover:text-stone-700"
      >
        {t("common:button.clear")}
      </button>
    </div>
  );
}
