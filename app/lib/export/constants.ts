/**
 * Export Pipeline Constants
 *
 * This module deals with the static lookup tables shared by the
 * per-entity formatters in this directory: the D1 language-code to
 * display-name map and the `modified_at` date every record carries.
 *
 * @version v0.9.0
 */

/**
 * The UTC calendar date (`YYYY-MM-DD`) of a stored `updated_at`, the
 * value of a record's `modified_at`; undefined when the value is null or
 * not finite, so the key is left out. The column holds milliseconds in
 * most rows and seconds in some older ones: a value below 1e11 is read as
 * seconds (1e11 milliseconds is in 1973, 1e11 seconds in the year 5138).
 */
export function modifiedAtDate(stored: number | null | undefined): string | undefined {
  if (stored == null || !Number.isFinite(stored)) return undefined;
  const date = new Date(stored < 1e11 ? stored * 1000 : stored);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

/** Map D1 language codes to display names */
export const LANGUAGE_MAP: Record<string, string> = {
  "192": "Español",
  "173": "Español",
  "195": "Español",
  Spanish: "Español",
};

// @version v0.9.0
