/**
 * Column Toggle
 *
 * Popover that lets the operator show or hide individual columns in
 * a data table. Persists the selection to localStorage keyed by the
 * table id so preferences survive reloads.
 *
 * @version v0.3.0
 */
import { useState, useRef, useEffect } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { Table } from "@tanstack/react-table";

interface ColumnToggleProps<TData> {
  table: Table<TData>;
  label: string;
}

export function ColumnToggle<TData>({
  table,
  label,
}: ColumnToggleProps<TData>) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const toggleableColumns = table
    .getAllLeafColumns()
    .filter((column) => column.getCanHide());

  if (toggleableColumns.length === 0) return null;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        className="inline-flex items-center gap-2 rounded-md border border-stone-200 px-3 py-2 font-sans text-sm font-semibold text-stone-700 hover:bg-stone-50"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <SlidersHorizontal className="h-4 w-4" />
        {label}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-10 mt-1 min-w-48 rounded-lg border border-stone-200 bg-white p-2 shadow-lg"
        >
          {toggleableColumns.map((column) => (
            <label
              key={column.id}
              role="menuitemcheckbox"
              aria-checked={column.getIsVisible()}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 font-sans text-sm font-medium text-indigo hover:bg-stone-50"
            >
              <input
                type="checkbox"
                checked={column.getIsVisible()}
                onChange={column.getToggleVisibilityHandler()}
                className="h-4 w-4 rounded border-stone-200 text-indigo focus:ring-indigo"
              />
              {typeof column.columnDef.header === "string"
                ? column.columnDef.header
                : column.id}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
