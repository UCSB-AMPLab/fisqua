/**
 * Locale-Bound Formatter Hook
 *
 * This hook deals with handing React components the shared
 * formatters from `app/lib/format.ts` already bound to the active UI
 * language and to the reader's time zone, so no component has to read
 * `i18n.language` or the zone itself, or accept either as a prop
 * threaded down from a route.
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
 * The zone is the root loader's `timeZone`: the one the server
 * resolved from the request's `tz` cookie and formatted the page in.
 * The hook reads it with `useRouteLoaderData("root")` rather than from
 * the browser, so the hydrating client formats with the zone the
 * server used and produces the same text, including on a first visit,
 * when no cookie existed yet and the server fell back to its default
 * zone. The hook therefore needs a data router; a router without a
 * root route (a test's route stub) has no root data, and the
 * formatters use that default zone.
 *
 * `relativeTime` is measured from the root loader's `now`, the
 * request time, for the same reason: both renders read one instant
 * from the router state, so a timestamp near a unit boundary reads the
 * same on the server and in the hydrating browser. The text is not
 * advanced by a timer; it moves forward when the root loader next
 * runs, which it does on every navigation. Without root data (a
 * router stub) the clock is read at the time of the call.
 *
 * The same instant is returned as `now`, for the components that
 * compute an age themselves (a count of days, an ETA) instead of going
 * through `relativeTime`. They pass it as the reference time of their
 * calculation, so it agrees between the server render and hydration;
 * it is undefined without root data, and the calculations then read
 * the clock.
 *
 * The returned functions are memoised on the language, the zone and
 * the reference time, so they are stable between renders and safe to
 * list in effect or memo dependency arrays.
 *
 * @version v0.8.0
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useRouteLoaderData } from "react-router";
import {
  formatBytes,
  formatDate,
  formatDateTime,
  formatDuration,
  formatIsoDateTime,
  formatNumber,
  relativeTime,
  toLanguage,
  type Language,
} from "./format";

export interface BoundFormatters {
  /** The resolved UI language these formatters are bound to. */
  language: Language;
  /** The IANA time zone dates are shown in, from the root loader;
   *  undefined without root data, where the default zone applies. */
  timeZone: string | undefined;
  /** The request time in unix ms from the root loader, the reference
   *  for any age computed during render; undefined without root data,
   *  where the clock applies. */
  now: number | undefined;
  /** Relative time, e.g. "hace 3 días" / "3 days ago". */
  relativeTime: (timestamp: number | null) => string;
  /** Long-form date, e.g. "3 de julio de 1593" / "July 3, 1593". */
  formatDate: (timestamp: number) => string;
  /** Date + time of day, e.g. "13 ago 2026, 9:40 p. m." — for
   *  conflict/draft banners where the time tells two saves apart. */
  formatDateTime: (timestamp: number) => string;
  /** Numeric `YYYY-MM-DD HH:MM:SS` in the reader's zone; "—" for a
   *  missing or invalid timestamp. */
  formatIsoDateTime: (timestamp: number | null | undefined) => string;
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
 * Returns the shared formatters bound to the active UI language and
 * the zone the root loader resolved for this request.
 */
export function useFormatters(): BoundFormatters {
  const { i18n } = useTranslation();
  const language = toLanguage(i18n.language);
  const rootData = useRouteLoaderData("root") as
    | { timeZone?: string; now?: number }
    | undefined;
  const timeZone = rootData?.timeZone;
  const now = rootData?.now;

  return useMemo(
    () => ({
      language,
      timeZone,
      now,
      relativeTime: (timestamp: number | null) =>
        relativeTime(timestamp, language, now),
      formatDate: (timestamp: number) =>
        formatDate(timestamp, language, timeZone),
      formatDateTime: (timestamp: number) =>
        formatDateTime(timestamp, language, timeZone),
      formatIsoDateTime: (timestamp: number | null | undefined) =>
        formatIsoDateTime(timestamp, timeZone),
      formatNumber: (n: number) => formatNumber(n, language),
      formatDuration: (startedAt: number | null, completedAt: number | null) =>
        formatDuration(startedAt, completedAt, language),
      formatBytes: (size: number) => formatBytes(size, language),
    }),
    [language, timeZone, now],
  );
}

/* @version v0.8.0 */
