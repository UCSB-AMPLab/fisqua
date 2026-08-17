/**
 * Locale-Aware Formatting Helpers
 *
 * This module deals with the small set of locale-aware formatting
 * primitives the UI reaches for when rendering timestamps and numbers.
 * Everything routes through `Intl.RelativeTimeFormat`,
 * `Intl.DateTimeFormat`, and `Intl.NumberFormat`, and every helper
 * takes the active UI language as a **required** argument. The
 * language is the app's own two-value union (`"en" | "es"`, the pair
 * the i18next middleware detects); this module owns the mapping onto
 * concrete Intl tags — `es` renders as `es-CO` and `en` as `en-US`.
 *
 * The parameter is required rather than defaulted on purpose. These
 * helpers were previously pinned to a module-level `es-CO` constant,
 * which was defensible while Fisqua served a single Spanish-speaking
 * institution and wrong from the moment it served more than one: an
 * English-language partner archive saw Spanish long-form dates on
 * every surface. A default would let that failure survive silently at
 * any call site nobody revisits, so callers must state the language
 * and the compiler flags the ones that do not.
 *
 * React components should not thread the language by hand — the
 * `useFormatters` hook in `app/lib/use-formatters.ts` reads it off the
 * live i18next instance and returns these functions pre-bound.
 * Loaders and other server-side callers read it via
 * `getLocale(context)` from `app/middleware/i18next.ts`.
 *
 * `relativeTime` collapses a unix-ms timestamp into "hace 3 días" /
 * "3 days ago"-style copy, picking the largest non-zero unit (day,
 * hour, minute, or second) so the surface stays readable as values
 * age out. `formatDate` renders a full long-form date for
 * archival-facing surfaces, and `formatNumber` applies the language's
 * grouping conventions (Colombian Spanish separates thousands with a
 * period, US English with a comma) for tallies on dashboards.
 * `formatDuration` and `formatBytes` render elapsed run times and
 * staged-file sizes through `Intl` unit notation rather than
 * hardcoded English abbreviations. Null and undefined inputs collapse
 * to the em-dash glyph so empty cells render uniformly across tables.
 *
 * @version v0.7.0
 */

/**
 * The app's UI language union — the two languages the i18next
 * middleware detects (`app/middleware/i18next.ts`).
 */
export type Language = "en" | "es";

/**
 * Concrete Intl tag per UI language. Colombian Spanish and US English
 * are the two regional conventions Fisqua renders; keeping the map
 * here means call sites never spell a BCP 47 tag themselves.
 */
const INTL_TAGS: Record<Language, string> = {
  en: "en-US",
  es: "es-CO",
};

/**
 * Narrow an arbitrary i18next language string (which may carry a
 * region subtag, e.g. `en-GB`) onto the app's two-value union.
 * Anything unrecognised resolves to `"es"`, mirroring the middleware's
 * `fallbackLanguage`.
 */
export function toLanguage(language: string | undefined | null): Language {
  return language?.toLowerCase().startsWith("en") ? "en" : "es";
}

/**
 * Format a timestamp as relative time (e.g., "hace 3 días" /
 * "3 days ago"). Returns "—" for null or undefined values.
 */
export function relativeTime(
  timestamp: number | null,
  language: Language,
): string {
  if (!timestamp) return "—";

  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const rtf = new Intl.RelativeTimeFormat(INTL_TAGS[language], {
    numeric: "auto",
  });

  if (days > 0) return rtf.format(-days, "day");
  if (hours > 0) return rtf.format(-hours, "hour");
  if (minutes > 0) return rtf.format(-minutes, "minute");
  return rtf.format(0, "second");
}

/**
 * Format a timestamp as a full date (e.g., "3 de julio de 1593" /
 * "July 3, 1593").
 */
export function formatDate(timestamp: number, language: Language): string {
  return new Intl.DateTimeFormat(INTL_TAGS[language], {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(timestamp));
}

/**
 * Format a timestamp as a date with time of day (e.g.,
 * "13 ago 2026, 9:40 p. m." / "Aug 13, 2026, 9:40 PM"). This is the
 * conflict/draft-banner formatter: those sentences interpolate a save
 * timestamp, and the time of day is what tells two saves apart.
 */
export function formatDateTime(
  timestamp: number,
  language: Language,
): string {
  return new Intl.DateTimeFormat(INTL_TAGS[language], {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

/**
 * Format a number with the language's grouping conventions
 * (20545 -> "20.545" in Spanish, "20,545" in English).
 */
export function formatNumber(n: number, language: Language): string {
  return new Intl.NumberFormat(INTL_TAGS[language]).format(n);
}

/**
 * Format the elapsed time between two unix-ms timestamps as
 * minutes/seconds in the language's unit notation (e.g. "5m 30s" /
 * "5 min 30 s"). Returns "—" when either endpoint is missing, matching
 * the empty-cell convention above.
 */
export function formatDuration(
  startedAt: number | null,
  completedAt: number | null,
  language: Language,
): string {
  if (!startedAt || !completedAt) return "—";
  const unit = (value: number, name: "minute" | "second") =>
    new Intl.NumberFormat(INTL_TAGS[language], {
      style: "unit",
      unit: name,
      unitDisplay: "narrow",
    }).format(value);
  const seconds = Math.round((completedAt - startedAt) / 1000);
  if (seconds < 60) return unit(seconds, "second");
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${unit(minutes, "minute")} ${unit(remainder, "second")}`;
}

/**
 * Format a byte size in the language's unit notation (e.g. "1.5kB" /
 * "1,5kB"). Thresholds are binary (1024), matching the staged-upload
 * sizes the imports surfaces report.
 */
export function formatBytes(size: number, language: Language): string {
  const unit = (
    value: number,
    name: "byte" | "kilobyte" | "megabyte",
    digits: number,
  ) =>
    new Intl.NumberFormat(INTL_TAGS[language], {
      style: "unit",
      unit: name,
      unitDisplay: "narrow",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  if (size < 1024) return unit(size, "byte", 0);
  if (size < 1024 * 1024) return unit(size / 1024, "kilobyte", 1);
  return unit(size / (1024 * 1024), "megabyte", 1);
}

/* @version v0.7.0 */
