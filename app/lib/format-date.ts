/**
 * ISO-like Date Formatting
 *
 * This module is the import path for `formatIsoDateTime`, the
 * `YYYY-MM-DD HH:MM:SS` formatter the publish dashboard, the import
 * histories and other surfaces use where archival precision matters
 * more than locale formatting. The formatter lives in
 * `app/lib/format.ts` beside the other date formatters, because it
 * shares their time-zone handling: it renders in the zone it is given,
 * the reader's own, and falls back to the same default zone they do.
 * Components take it pre-bound to the reader's zone from
 * `useFormatters()`; loaders pass `requestTimeZone(request)`.
 *
 * @version v0.8.0
 */
export { formatIsoDateTime } from "./format";

/* @version v0.8.0 */
