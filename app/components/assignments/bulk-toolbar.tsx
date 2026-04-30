/**
 * Bulk assignment toolbar. Appears when volumes are selected.
 * Provides cataloguer/reviewer dropdowns and Apply/Clear buttons.
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
