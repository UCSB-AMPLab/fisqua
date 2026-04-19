/**
 * ISO-like Date Formatting
 *
 * Formats a unix-ms timestamp as `YYYY-MM-DD HH:MM:SS` in UTC. Used on
 * the publish dashboard and anywhere else archival precision matters more
 * than locale formatting. Single source of truth — do not re-implement
 * elsewhere.
 *
 * @version v0.3.0
 */
export function formatIsoDateTime(
  ts: number | null | undefined
): string {
  if (ts === null || ts === undefined) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}
