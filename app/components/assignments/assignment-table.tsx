/**
 * Volume assignment table with per-row dropdowns for cataloguer and reviewer.
 * Each row has a checkbox for bulk selection and uses useFetcher for individual assignment.
 */

import { useFetcher } from "react-router";
import { StatusBadge } from "../workflow/status-badge";

export type VolumeRow = {
  id: string;
  name: string;
  pageCount: number;
  status: string;
  assignedTo: string | null;
  assignedReviewer: string | null;
};

export type MemberOption = {
  id: string;
  name: string | null;
  email: string;
};

type AssignmentTableProps = {
  volumes: VolumeRow[];
  cataloguers: MemberOption[];
  reviewers: MemberOption[];
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
};

export function AssignmentTable({
  volumes,
  cataloguers,
  reviewers,
  selectedIds,
  onSelectionChange,
}: AssignmentTableProps) {
  const allSelected = volumes.length > 0 && selectedIds.size === volumes.length;

  function toggleAll() {
    if (allSelected) {
      onSelectionChange(new Set());
    } else {
      onSelectionChange(new Set(volumes.map((v) => v.id)));
    }
  }

  function toggleOne(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onSelectionChange(next);
  }

  if (volumes.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-stone-400">
        No volumes in this project yet.
      </p>
    );
  }

  return (
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
            <th className="px-3 py-2">Volume</th>
            <th className="px-3 py-2 text-right">Pages</th>
            <th className="px-3 py-2">Cataloguer</th>
            <th className="px-3 py-2">Reviewer</th>
            <th className="px-3 py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {volumes.map((vol) => (
            <AssignmentRow
              key={vol.id}
              volume={vol}
              cataloguers={cataloguers}
              reviewers={reviewers}
              isSelected={selectedIds.has(vol.id)}
              onToggle={() => toggleOne(vol.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AssignmentRow({
  volume,
  cataloguers,
  reviewers,
  isSelected,
  onToggle,
}: {
  volume: VolumeRow;
  cataloguers: MemberOption[];
  reviewers: MemberOption[];
  isSelected: boolean;
  onToggle: () => void;
}) {
  const fetcher = useFetcher();

  function handleAssign(field: "cataloguerId" | "reviewerId", value: string) {
    fetcher.submit(
      {
        _action: "assign",
        volumeId: volume.id,
        [field]: value || "",
      },
      { method: "post" }
    );
  }

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
      <td className="px-3 py-2 font-medium text-stone-900">{volume.name}</td>
      <td className="px-3 py-2 text-right text-stone-500">{volume.pageCount}</td>
      <td className="px-3 py-2">
        <select
          value={volume.assignedTo ?? ""}
          onChange={(e) => handleAssign("cataloguerId", e.target.value)}
          className="w-full rounded border border-stone-200 bg-white px-2 py-1 text-sm text-stone-700"
        >
          <option value="">Unassigned</option>
          {cataloguers.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name ?? m.email}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2">
        <select
          value={volume.assignedReviewer ?? ""}
          onChange={(e) => handleAssign("reviewerId", e.target.value)}
          className="w-full rounded border border-stone-200 bg-white px-2 py-1 text-sm text-stone-700"
        >
          <option value="">Unassigned</option>
          {reviewers.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name ?? m.email}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2">
        <StatusBadge status={volume.status} />
      </td>
    </tr>
  );
}
