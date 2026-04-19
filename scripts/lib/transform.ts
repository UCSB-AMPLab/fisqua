/**
 * Convert an ISO datetime string to Unix epoch seconds.
 * Returns null for null/undefined input.
 */
export function toEpochSeconds(
  isoString: string | null | undefined
): number | null {
  if (isoString === null || isoString === undefined) return null;
  return Math.floor(new Date(isoString).getTime() / 1000);
}

/**
 * Pass through a date string (YYYY-MM-DD or partial YYYY / YYYY-MM).
 * Returns null for null/undefined input.
 */
export function toIsoDate(
  value: string | null | undefined
): string | null {
  if (value === null || value === undefined) return null;
  return value;
}

/**
 * Convert a value to a JSON array string.
 * - Array -> JSON.stringify
 * - String -> return as-is (assumed already JSON)
 * - null/undefined -> "[]"
 */
export function stringifyJsonArray(value: unknown): string {
  if (value === null || value === undefined) return "[]";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return JSON.stringify(value);
  return "[]";
}
