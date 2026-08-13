/**
 * Locale-Bound Formatter Hook
 *
 * This hook deals with handing React components the three shared
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
  formatDate,
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
  /** Grouped number, e.g. "20.545" / "20,545". */
  formatNumber: (n: number) => string;
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
      formatNumber: (n: number) => formatNumber(n, language),
    }),
    [language],
  );
}

/* @version v0.7.0 */
