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
 * age out. It measures against a reference time: the optional `now`
 * argument, or the clock when none is passed. Components pass the
 * request time the root loader returned (see `useFormatters`), so the
 * server render and the hydrating browser measure from the same
 * instant and agree near a unit boundary ("hace 59 min" against
 * "hace 1 hora"); a read of the clock during render would differ
 * between the two and make React report a hydration mismatch.
 * `formatDate` renders a full long-form date for
 * archival-facing surfaces, and `formatNumber` applies the language's
 * grouping conventions (Colombian Spanish separates thousands with a
 * period, US English with a comma) for tallies on dashboards.
 * `formatDateTime` adds the time of day, and `formatIsoDateTime`
 * renders the fixed numeric `YYYY-MM-DD HH:MM:SS` form the
 * operational histories use (import runs, publish runs, QC cards).
 *
 * Dates and times of day are shown in the reader's own time zone. The
 * browser records its IANA zone in the `tz` cookie (written in
 * `app/entry.client.tsx`); `requestTimeZone` reads and validates that
 * cookie for a request, and the root loader hands the result to the
 * client as `timeZone`, so the server render and the hydrating
 * browser format with the same zone and produce the same text. A
 * request without a valid cookie (the first page of a first visit, or
 * a value `Intl` does not accept) is formatted in
 * `America/Los_Angeles`, which is also the zone every date formatter
 * here uses when no zone is passed. The zone is never left to the
 * process: the Worker runs in UTC and a browser in its own zone, and
 * text formatted in either would differ near midnight and make React
 * report a hydration mismatch.
 *
 * `formatDuration` and `formatBytes` render elapsed run times and
 * staged-file sizes through `Intl` unit notation rather than
 * hardcoded English abbreviations. Null and undefined inputs collapse
 * to the em-dash glyph so empty cells render uniformly across tables.
 *
 * @version v0.8.0
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
 * The zone dates and times of day are shown in when the request
 * carries no valid `tz` cookie, and when a caller passes no zone.
 */
const DEFAULT_TIME_ZONE = "America/Los_Angeles";

/**
 * The Intl tag behind `formatIsoDateTime`. Its output is the same in
 * either UI language, so it is not derived from the active language;
 * it is fixed so a runtime's default locale cannot bring in another
 * calendar or other digits and make the server and browser disagree.
 * Only the numeric parts are read, never the tag's punctuation.
 */
const ISO_PARTS_TAG = INTL_TAGS.en;

/** The cookie the browser writes its IANA time zone to. */
const TIME_ZONE_COOKIE = "tz";

/** Whether `Intl.DateTimeFormat` accepts `zone` as a time zone. */
function isTimeZone(zone: string): boolean {
  if (zone.length === 0 || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The time zone to format a request's dates in: the `tz` cookie when
 * it names a zone `Intl` accepts, otherwise `America/Los_Angeles`.
 */
export function requestTimeZone(request: Request): string {
  const header = request.headers.get("Cookie");
  if (!header) return DEFAULT_TIME_ZONE;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== TIME_ZONE_COOKIE) continue;
    let value: string;
    try {
      value = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return DEFAULT_TIME_ZONE;
    }
    return isTimeZone(value) ? value : DEFAULT_TIME_ZONE;
  }
  return DEFAULT_TIME_ZONE;
}

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
 * "3 days ago"), measured from `now` (unix ms), which is the clock
 * when omitted. Returns "—" for null or undefined values.
 */
export function relativeTime(
  timestamp: number | null,
  language: Language,
  now: number = Date.now(),
): string {
  if (!timestamp) return "—";

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
 * "July 3, 1593"), on the calendar of `timeZone`.
 */
export function formatDate(
  timestamp: number,
  language: Language,
  timeZone: string = DEFAULT_TIME_ZONE,
): string {
  return new Intl.DateTimeFormat(INTL_TAGS[language], {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone,
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
  timeZone: string = DEFAULT_TIME_ZONE,
): string {
  return new Intl.DateTimeFormat(INTL_TAGS[language], {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(timestamp));
}

/**
 * Format a unix-ms timestamp as `YYYY-MM-DD HH:MM:SS` in `timeZone`,
 * with a 24-hour clock and no locale punctuation, so the string is the
 * same in either UI language and its leading slices are usable on
 * their own: `.slice(0, 10)` is the reader's calendar day,
 * `.slice(0, 16)` the day and minute, `.slice(11, 16)` the time of
 * day. Null, undefined and NaN render as the em dash.
 */
export function formatIsoDateTime(
  ts: number | null | undefined,
  timeZone: string = DEFAULT_TIME_ZONE,
): string {
  if (ts === null || ts === undefined) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const parts: Record<string, string> = {};
  for (const { type, value } of new Intl.DateTimeFormat(ISO_PARTS_TAG, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d)) {
    parts[type] = value;
  }
  const year = parts.year.padStart(4, "0");
  return (
    `${year}-${parts.month}-${parts.day} ` +
    `${parts.hour}:${parts.minute}:${parts.second}`
  );
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

/* @version v0.8.0 */
