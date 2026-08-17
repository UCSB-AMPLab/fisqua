/**
 * Locale-Bound Formatter Hook
 *
 * This hook deals with handing React components the shared
 * formatters from `app/lib/format.ts` already bound to the active UI
 * language, so no component has to read `i18n.language` itself or
 * accept the language as a prop threaded down from a route.
 *
 * The bare helpers take the language as a required argument
 * (deliberately — see the header of `app/lib/format.ts`). That is the
 * right contract for loaders and other server-side callers, which
 * read the language from `getLocale(context)`, but it is the wrong
 * ergonomics inside a component tree where the language is already
 * available on the live i18next instance. Two call sites reading the
 * same value two different ways is exactly how the previous
 * hardcoded-`es-CO` bug spread, so components get one way in:
 *
 *   const { formatDate } = useFormatters();
 *   …
 *   {formatDate(project.createdAt)}
 *
 * The returned functions are memoised on the language, so they are
 * stable between renders and safe to list in effect or memo
 * dependency arrays.
 *
 * @version v0.7.0
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  formatBytes,
  formatDate,
  formatDateTime,
  formatDuration,
  formatNumber,
  relativeTime,
  toLanguage,
  type Language,
} from "./format";

export interface BoundFormatters {
  /** The resolved UI language these formatters are bound to. */
  language: Language;
  /** Relative time, e.g. "hace 3 días" / "3 days ago". */
  relativeTime: (timestamp: number | null) => string;
  /** Long-form date, e.g. "3 de julio de 1593" / "July 3, 1593". */
  formatDate: (timestamp: number) => string;
  /** Date + time of day, e.g. "13 ago 2026, 9:40 p. m." — for
   *  conflict/draft banners where the time tells two saves apart. */
  formatDateTime: (timestamp: number) => string;
  /** Grouped number, e.g. "20.545" / "20,545". */
  formatNumber: (n: number) => string;
  /** Elapsed duration between two unix-ms stamps, e.g. "5m 30s" /
   *  "5 min 30 s"; "—" when either endpoint is missing. */
  formatDuration: (
    startedAt: number | null,
    completedAt: number | null,
  ) => string;
  /** Byte size in locale unit notation, e.g. "1.5kB" / "1,5kB". */
  formatBytes: (size: number) => string;
}

/**
 * Returns the shared formatters bound to the active UI language.
 */
export function useFormatters(): BoundFormatters {
  const { i18n } = useTranslation();
  const language = toLanguage(i18n.language);

  return useMemo(
    () => ({
      language,
      relativeTime: (timestamp: number | null) =>
        relativeTime(timestamp, language),
      formatDate: (timestamp: number) => formatDate(timestamp, language),
      formatDateTime: (timestamp: number) =>
        formatDateTime(timestamp, language),
      formatNumber: (n: number) => formatNumber(n, language),
      formatDuration: (startedAt: number | null, completedAt: number | null) =>
        formatDuration(startedAt, completedAt, language),
      formatBytes: (size: number) => formatBytes(size, language),
    }),
    [language],
  );
}

/* @version v0.7.0 */
