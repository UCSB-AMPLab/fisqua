/**
 * Publish Export History
 *
 * This table is the compact list of recent publish runs shown below the
 * live progress panel — status, who triggered, selected fonds and types,
 * record counts, and start/finish timestamps. Each row deep-links to the
 * per-run detail page.
 *
 * The `~/lib/format-date` import is intentionally written as a
 * relative path so the module loads cleanly under the workers
 * vitest pool (which does not alias `~/`).
 *
 * @version v0.7.0
 */

import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { formatIsoDateTime } from "../../lib/format-date";
import { useFormatters } from "../../lib/use-formatters";

export interface ExportHistoryRow {
  id: string;
  status: string;
  triggeredBy: string | null;
  selectedFonds: string;
  selectedTypes: string;
  recordCounts: string | null;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
}

interface ExportHistoryProps {
  history: ExportHistoryRow[];
}

interface RecordTotals {
  descriptions: number;
  entities: number;
  places: number;
  repositories: number;
}

/**
 * Break a record_counts JSON into per-category totals. The raw record_counts
 * map mixes per-fonds description keys, a descriptions:index duplicate total,
 * per-fonds children keys, and single category counts. Summing all values
 * double-counts descriptions (both as per-fonds entries and as the :index
 * total) and mixes entities/places with descriptions.
 *
 * This helper only counts per-fonds description keys for the descriptions
 * total and reads entities/places/repositories directly. Children are
 * intentionally excluded (they are metadata files, not records).
 */
function parseRecordTotals(recordCounts: string | null): RecordTotals | null {
  if (!recordCounts) return null;
  let counts: Record<string, number>;
  try {
    counts = JSON.parse(recordCounts) as Record<string, number>;
  } catch {
    return null;
  }

  let descriptions = 0;
  for (const [key, value] of Object.entries(counts)) {
    if (
      key.startsWith("descriptions:") &&
      key !== "descriptions:index" &&
      key !== "descriptions:combined"
    ) {
      descriptions += Number(value) || 0;
    }
  }
  return {
    descriptions,
    entities: Number(counts.entities) || 0,
    places: Number(counts.places) || 0,
    repositories: Number(counts.repositories) || 0,
  };
}

const STATUS_STYLES: Record<string, string> = {
  complete: "bg-verdigris-tint text-verdigris-deep",
  error: "bg-madder-tint text-madder-deep",
  running: "bg-saffron-tint text-saffron-deep",
  pending: "bg-stone-100 text-stone-600",
};

export function ExportHistory({ history }: ExportHistoryProps) {
  const { t } = useTranslation("publish");
  const { formatNumber, formatDuration } = useFormatters();

  if (history.length === 0) {
    return (
      <section>
        <h2 className="font-sans text-lg font-semibold text-stone-800">
          {t("history.title")}
        </h2>
        <p className="mt-2 font-sans text-sm text-stone-400">
          {t("history.noHistory")}
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2 className="font-sans text-lg font-semibold text-stone-800">
        {t("history.title")}
      </h2>

      <div className="mt-4 overflow-hidden rounded-lg border border-stone-200">
        <table className="min-w-full divide-y divide-stone-200">
          <thead className="bg-stone-50">
            <tr>
              <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                {t("history.date")}
              </th>
              <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                {t("history.status")}
              </th>
              <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                {t("history.triggeredBy")}
              </th>
              <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                {t("history.duration")}
              </th>
              <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                {t("history.records")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {history.map((run) => (
              <tr key={run.id}>
                <td className="px-4 py-3 font-sans text-sm text-stone-700">
                  <Link
                    to={`/admin/publish/runs/${run.id}`}
                    className="underline decoration-stone-300 underline-offset-2 hover:decoration-stone-900"
                  >
                    {formatIsoDateTime(run.createdAt)}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 font-sans text-xs font-medium ${
                      STATUS_STYLES[run.status] ?? STATUS_STYLES.pending
                    }`}
                  >
                    {t(`history.${run.status}` as const)}
                  </span>
                </td>
                <td className="px-4 py-3 font-sans text-sm text-stone-600">
                  {run.triggeredBy ?? "\u2014"}
                </td>
                <td className="px-4 py-3 font-sans text-sm text-stone-600">
                  {formatDuration(run.startedAt, run.completedAt)}
                </td>
                <td className="px-4 py-3 font-sans text-xs text-stone-600">
                  {(() => {
                    const totals = parseRecordTotals(run.recordCounts);
                    if (!totals) return "\u2014";
                    const parts: string[] = [];
                    if (totals.descriptions > 0)
                      parts.push(
                        t("history.recordsDescriptions_count", {
                          count: totals.descriptions,
                          formattedCount: formatNumber(totals.descriptions),
                        })
                      );
                    if (totals.entities > 0)
                      parts.push(
                        t("history.recordsEntities_count", {
                          count: totals.entities,
                          formattedCount: formatNumber(totals.entities),
                        })
                      );
                    if (totals.places > 0)
                      parts.push(
                        t("history.recordsPlaces_count", {
                          count: totals.places,
                          formattedCount: formatNumber(totals.places),
                        })
                      );
                    if (totals.repositories > 0)
                      parts.push(
                        t("history.recordsRepositories_count", {
                          count: totals.repositories,
                          formattedCount: formatNumber(totals.repositories),
                        })
                      );
                    return parts.length > 0 ? parts.join(" · ") : "\u2014";
                  })()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
