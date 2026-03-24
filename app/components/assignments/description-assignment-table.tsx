/**
 * Per-entry assignment table for description workflow.
 *
 * Shows entries in a volume with per-entry cataloguer/reviewer assignment,
 * checkbox bulk selection, and a sticky bulk action toolbar.
 */

import { useState } from "react";
import { useFetcher, Link } from "react-router";
import { useTranslation } from "react-i18next";
import { DescriptionStatusBadge } from "../workflow/status-badge";
import type { MemberOption } from "./assignment-table";

export type DescriptionEntryRow = {
  id: string;
  position: number;
  title: string | null;
  translatedTitle: string | null;
  startPage: number;
  endPage: number | null;
  descriptionStatus: string | null;
  assignedDescriber: string | null;
  assignedDescriptionReviewer: string | null;
};

type DescriptionAssignmentTableProps = {
  entries: DescriptionEntryRow[];
  cataloguers: MemberOption[];
  reviewers: MemberOption[];
  projectId: string;
  volumeId: string;
};

export function DescriptionAssignmentTable({
  entries: entryRows,
  cataloguers,
  reviewers,
  projectId,
  volumeId,
}: DescriptionAssignmentTableProps) {
  const { t } = useTranslation("description");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const allSelected =
    entryRows.length > 0 && selectedIds.size === entryRows.length;

  function toggleAll() {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(entryRows.map((e) => e.id)));
    }
  }

  function toggleOne(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
  }

  function selectNextN(n: number) {
    const unselected = entryRows
      .filter((e) => !selectedIds.has(e.id))
      .slice(0, n);
    const next = new Set(selectedIds);
    for (const e of unselected) {
      next.add(e.id);
    }
    setSelectedIds(next);
  }

  function selectUnassigned() {
    const next = new Set(selectedIds);
    for (const e of entryRows) {
      if (!e.assignedDescriber) {
        next.add(e.id);
      }
    }
    setSelectedIds(next);
  }

  if (entryRows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-stone-400">
        {t('no_entries_in_volume')}
      </p>
    );
  }

  return (
    <div>
      {/* Bulk action toolbar */}
      {selectedIds.size > 0 && (
        <BulkActionBar
          selectedIds={selectedIds}
          cataloguers={cataloguers}
          reviewers={reviewers}
          onClear={() => setSelectedIds(new Set())}
        />
      )}

      {/* Bulk selection dropdown */}
      <div className="mb-2 flex items-center gap-2">
        <div className="relative">
          <BulkSelectDropdown
            onSelectNext={() => selectNextN(5)}
            onSelectUnassigned={selectUnassigned}
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-stone-200 text-xs font-medium uppercase tracking-wide text-stone-500">
              <th className="w-8 px-3 py-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="rounded border-stone-300"
                />
              </th>
              <th className="w-12 px-3 py-2">{t("assignment.posicion")}</th>
              <th className="px-3 py-2">{t("assignment.item")}</th>
              <th className="px-3 py-2">{t("assignment.paginas")}</th>
              <th className="px-3 py-2">{t("assignment.catalogador")}</th>
              <th className="px-3 py-2">{t("assignment.revisor")}</th>
              <th className="px-3 py-2">{t("assignment.estado")}</th>
            </tr>
          </thead>
          <tbody>
            {entryRows.map((entry) => (
              <EntryAssignmentRow
                key={entry.id}
                entry={entry}
                cataloguers={cataloguers}
                reviewers={reviewers}
                isSelected={selectedIds.has(entry.id)}
                onToggle={() => toggleOne(entry.id)}
                projectId={projectId}
                volumeId={volumeId}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EntryAssignmentRow({
  entry,
  cataloguers,
  reviewers,
  isSelected,
  onToggle,
  projectId,
  volumeId,
}: {
  entry: DescriptionEntryRow;
  cataloguers: MemberOption[];
  reviewers: MemberOption[];
  isSelected: boolean;
  onToggle: () => void;
  projectId: string;
  volumeId: string;
}) {
  const fetcher = useFetcher();

  function handleAssign(
    field: "describerId" | "reviewerId",
    value: string
  ) {
    fetcher.submit(
      {
        _action: "assign-entry",
        entryId: entry.id,
        [field]: value || "",
      },
      { method: "post" }
    );
  }

  const pageRange = entry.endPage
    ? `${entry.startPage}-${entry.endPage}`
    : `${entry.startPage}`;

  const { t } = useTranslation("description");
  const displayTitle = entry.title || entry.translatedTitle || t('item_position', { position: entry.position });

  return (
    <tr className="border-b border-stone-100 hover:bg-stone-50">
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggle}
          className="rounded border-stone-300"
        />
      </td>
      <td className="px-3 py-2 text-stone-500">{entry.position}</td>
      <td className="px-3 py-2">
        <Link
          to={`/projects/${projectId}/describe/${entry.id}`}
          className="font-medium text-[#8B2942] hover:underline"
        >
          {displayTitle}
        </Link>
      </td>
      <td className="px-3 py-2 text-stone-500">{pageRange}</td>
      <td className="px-3 py-2">
        <select
          value={entry.assignedDescriber ?? ""}
          onChange={(e) => handleAssign("describerId", e.target.value)}
          className="w-full rounded border border-stone-200 bg-white px-2 py-1 text-sm text-stone-700"
        >
          <option value="">{t('assignment.sin_asignar')}</option>
          {cataloguers.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name ?? m.email}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2">
        <select
          value={entry.assignedDescriptionReviewer ?? ""}
          onChange={(e) => handleAssign("reviewerId", e.target.value)}
          className="w-full rounded border border-stone-200 bg-white px-2 py-1 text-sm text-stone-700"
        >
          <option value="">{t('assignment.sin_asignar')}</option>
          {reviewers.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name ?? m.email}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2">
        <DescriptionStatusBadge
          status={entry.descriptionStatus ?? "unassigned"}
        />
      </td>
    </tr>
  );
}

function BulkActionBar({
  selectedIds,
  cataloguers,
  reviewers,
  onClear,
}: {
  selectedIds: Set<string>;
  cataloguers: MemberOption[];
  reviewers: MemberOption[];
  onClear: () => void;
}) {
  const { t } = useTranslation("description");
  const fetcher = useFetcher();
  const [bulkDescriber, setBulkDescriber] = useState("");
  const [bulkReviewer, setBulkReviewer] = useState("");

  function handleBulkAssign() {
    fetcher.submit(
      {
        _action: "bulk-assign-entries",
        entryIds: JSON.stringify(Array.from(selectedIds)),
        describerId: bulkDescriber,
        reviewerId: bulkReviewer,
      },
      { method: "post" }
    );
    onClear();
    setBulkDescriber("");
    setBulkReviewer("");
  }

  return (
    <div className="sticky top-0 z-10 mb-4 flex items-center gap-4 rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 shadow-sm">
      <span className="text-sm font-medium text-stone-700">
        {t("assignment.items_seleccionados", { count: selectedIds.size })}
      </span>

      <select
        value={bulkDescriber}
        onChange={(e) => setBulkDescriber(e.target.value)}
        className="rounded border border-stone-200 bg-white px-2 py-1 text-sm text-stone-700"
      >
        <option value="">{t("assignment.catalogador")}</option>
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
        <option value="">{t("assignment.revisor")}</option>
        {reviewers.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name ?? m.email}
          </option>
        ))}
      </select>

      <button
        onClick={handleBulkAssign}
        disabled={!bulkDescriber && !bulkReviewer}
        className="rounded bg-burgundy-deep px-3 py-1 text-sm font-medium text-white hover:bg-burgundy disabled:opacity-50"
      >
        {t("assignment.asignar")}
      </button>

      <button
        onClick={onClear}
        className="ml-auto text-sm text-stone-500 hover:text-stone-700"
      >
        &times;
      </button>
    </div>
  );
}

function BulkSelectDropdown({
  onSelectNext,
  onSelectUnassigned,
}: {
  onSelectNext: () => void;
  onSelectUnassigned: () => void;
}) {
  const { t } = useTranslation("description");
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex h-8 w-8 items-center justify-center rounded border border-stone-200 bg-white text-stone-500 hover:bg-stone-50"
        title={t('assignment.selection_options')}
      >
        +
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-56 rounded-lg border border-stone-200 bg-white py-1 shadow-lg">
          <button
            onClick={() => {
              onSelectNext();
              setOpen(false);
            }}
            className="block w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
          >
            {t("assignment.seleccionar_siguientes", { count: 5 })}
          </button>
          <button
            onClick={() => {
              onSelectUnassigned();
              setOpen(false);
            }}
            className="block w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
          >
            {t("assignment.seleccionar_no_asignados")}
          </button>
        </div>
      )}
    </div>
  );
}
