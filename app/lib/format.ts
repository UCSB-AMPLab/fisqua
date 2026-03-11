const LOCALE = "es-CO";

/**
 * Format a timestamp as relative time (e.g., "hace 3 dias").
 * Returns "—" for null or undefined values.
 */
export function relativeTime(timestamp: number | null): string {
  if (!timestamp) return "\u2014";

  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });

  if (days > 0) return rtf.format(-days, "day");
  if (hours > 0) return rtf.format(-hours, "hour");
  if (minutes > 0) return rtf.format(-minutes, "minute");
  return rtf.format(0, "second");
}

/**
 * Format a timestamp as a full date (e.g., "3 de julio de 1593").
 */
export function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(timestamp));
}

/**
 * Format a number with Colombian conventions (e.g., 20545 -> "20.545").
 */
export function formatNumber(n: number): string {
  return new Intl.NumberFormat(LOCALE).format(n);
}
