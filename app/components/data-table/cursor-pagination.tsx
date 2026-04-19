/**
 * Cursor Pagination
 *
 * Previous/next controls for cursor-based data tables. Wraps the
 * pagination state the loader returns — current cursor, next cursor,
 * has-previous flag — so the hosting page never touches those fields
 * directly.
 *
 * @version v0.3.0
 */
import { Link, useSearchParams } from "react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface CursorPaginationProps {
  nextCursor: string | null;
  prevCursor: string | null;
  count: number;
  entityLabel: string;
  baseUrl?: string;
}

export function CursorPagination({
  nextCursor,
  prevCursor,
  count,
  entityLabel,
}: CursorPaginationProps) {
  const [searchParams] = useSearchParams();

  function buildUrl(cursor: string, dir: "next" | "prev"): string {
    const params = new URLSearchParams(searchParams);
    params.set("cursor", cursor);
    params.set("dir", dir);
    return `?${params.toString()}`;
  }

  return (
    <div className="flex items-center justify-between border-t bg-[#FAFAF9] px-4 py-3">
      {prevCursor ? (
        <Link
          to={buildUrl(prevCursor, "prev")}
          className="inline-flex items-center gap-1 rounded-lg border border-[#E7E5E4] px-3 py-2 font-sans text-sm font-semibold text-[#44403C] hover:bg-white"
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
          Previous
        </Link>
      ) : (
        <button
          type="button"
          disabled
          aria-label="Previous page"
          aria-disabled="true"
          className="inline-flex items-center gap-1 rounded-lg border border-[#E7E5E4] px-3 py-2 font-sans text-sm font-semibold text-[#A8A29E] opacity-50"
        >
          <ChevronLeft className="h-4 w-4" />
          Previous
        </button>
      )}

      <span className="text-sm text-stone-500">
        Mostrando {count} {entityLabel}
      </span>

      {nextCursor ? (
        <Link
          to={buildUrl(nextCursor, "next")}
          className="inline-flex items-center gap-1 rounded-lg border border-[#E7E5E4] px-3 py-2 font-sans text-sm font-semibold text-[#44403C] hover:bg-white"
          aria-label="Next page"
        >
          Next
          <ChevronRight className="h-4 w-4" />
        </Link>
      ) : (
        <button
          type="button"
          disabled
          aria-label="Next page"
          aria-disabled="true"
          className="inline-flex items-center gap-1 rounded-lg border border-[#E7E5E4] px-3 py-2 font-sans text-sm font-semibold text-[#A8A29E] opacity-50"
        >
          Next
          <ChevronRight className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
