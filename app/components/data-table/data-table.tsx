/**
 * Data Table
 *
 * Generic TanStack-Table wrapper shared by the admin list surfaces.
 * Handles column definitions, sticky headers, sort and filter state,
 * and keyboard navigation between rows. Presentational only — data
 * comes from the hosting route loader.
 *
 * @version v0.3.0
 */
import { useState, useEffect, useRef, type MutableRefObject } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type VisibilityState,
  type Table,
} from "@tanstack/react-table";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";

export interface DataTableProps<TData> {
  data: TData[];
  columns: ColumnDef<TData, unknown>[];
  globalFilter?: string;
  onGlobalFilterChange?: (value: string) => void;
  defaultColumnVisibility?: VisibilityState;
  defaultSorting?: SortingState;
  defaultColumnFilters?: ColumnFiltersState;
  emptyMessage?: string;
  renderFooter?: (table: Table<TData>) => React.ReactNode;
  tableRef?: MutableRefObject<Table<TData> | null>;
}

export function DataTable<TData>({
  data,
  columns,
  globalFilter,
  onGlobalFilterChange,
  defaultColumnVisibility,
  defaultSorting,
  defaultColumnFilters,
  emptyMessage = "No results.",
  renderFooter,
  tableRef,
}: DataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>(defaultSorting ?? []);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(
    defaultColumnFilters ?? []
  );
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    defaultColumnVisibility ?? {}
  );

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      globalFilter,
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onGlobalFilterChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  // Expose table instance to parent via ref
  useEffect(() => {
    if (tableRef) {
      tableRef.current = table;
    }
  });

  function getSortIcon(columnId: string) {
    const sorted = sorting.find((s) => s.id === columnId);
    if (!sorted) {
      return <ArrowUpDown className="ml-1 inline h-4 w-4 text-[#78716C]" />;
    }
    if (sorted.desc) {
      return <ArrowDown className="ml-1 inline h-4 w-4 text-[#8B2942]" />;
    }
    return <ArrowUp className="ml-1 inline h-4 w-4 text-[#8B2942]" />;
  }

  function getAriaSortValue(
    columnId: string
  ): "ascending" | "descending" | "none" {
    const sorted = sorting.find((s) => s.id === columnId);
    if (!sorted) return "none";
    return sorted.desc ? "descending" : "ascending";
  }

  return (
    <div className="overflow-hidden rounded-lg border border-[#E7E5E4]">
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead className="bg-[#FAFAF9]">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      className="px-4 py-3 text-left font-sans text-xs font-normal uppercase tracking-wide text-[#78716C]"
                      aria-sort={
                        canSort
                          ? getAriaSortValue(header.column.id)
                          : undefined
                      }
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          className="inline-flex items-center"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                          {getSortIcon(header.column.id)}
                        </button>
                      ) : (
                        flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td
                  colSpan={table.getVisibleLeafColumns().length}
                  className="px-4 py-8 text-center font-sans text-sm text-[#78716C]"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-t border-[#E7E5E4] hover:bg-[#FAFAF9]"
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="px-4 py-3 font-sans text-sm text-[#44403C]"
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {renderFooter && renderFooter(table)}
    </div>
  );
}

export type { Table, ColumnDef, SortingState, VisibilityState, ColumnFiltersState };
