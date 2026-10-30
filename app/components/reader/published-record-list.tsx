/**
 * Published Record List (Reader)
 *
 * This component renders one page of published records as the Reader
 * pages list them: on `/records`, the entry points into the published
 * tree, and on a record's own page, its published children. Each row
 * links to the record's page under `/records/`, never to an admin
 * surface, and shows the title, the description level, the date
 * expression and the reference code (in mono, as codes are set across
 * the app).
 *
 * Paging is by `?page=`, with Previous and Next links from the common
 * pagination strings, shown only when there is more than one page. The
 * caller supplies the rows, the total and the current page; the list
 * holds no state.
 *
 * @version v0.8.0
 */

import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";

export interface PublishedRecordListRow {
  id: string;
  title: string;
  referenceCode: string;
  descriptionLevel: string;
  dateExpression: string | null;
}

export function PublishedRecordList({
  rows,
  total,
  page,
  pageSize,
}: {
  rows: PublishedRecordListRow[];
  total: number;
  page: number;
  pageSize: number;
}) {
  const { t } = useTranslation("descriptions_admin");
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 bg-white">
        {rows.map((row) => (
          <li key={row.id}>
            <Link
              to={`/records/${row.id}`}
              className="flex items-baseline justify-between gap-4 px-4 py-3 hover:bg-stone-50"
            >
              <span className="min-w-0">
                <span className="block font-serif text-15 text-indigo">
                  {row.title}
                </span>
                <span className="mt-0.5 block font-sans text-xs text-stone-500">
                  {t(`level_${row.descriptionLevel}`)}
                  {row.dateExpression ? ` · ${row.dateExpression}` : ""}
                </span>
              </span>
              <span className="shrink-0 font-mono text-xs text-stone-500">
                {row.referenceCode}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="font-sans text-sm text-stone-500">
            {t("common:pagination.page_of", { current: page, total: totalPages })}
          </p>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                to={`?page=${page - 1}`}
                className="inline-flex items-center gap-1 rounded-md border border-stone-200 px-3 py-1.5 font-sans text-sm text-stone-700 hover:bg-stone-50"
              >
                <ChevronLeft className="h-4 w-4" />
                {t("common:pagination.previous")}
              </Link>
            )}
            {page < totalPages && (
              <Link
                to={`?page=${page + 1}`}
                className="inline-flex items-center gap-1 rounded-md border border-stone-200 px-3 py-1.5 font-sans text-sm text-stone-700 hover:bg-stone-50"
              >
                {t("common:pagination.next")}
                <ChevronRight className="h-4 w-4" />
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// @version v0.8.0
