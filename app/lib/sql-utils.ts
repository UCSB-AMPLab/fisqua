/**
 * SQL Utility Helpers
 *
 * This module deals with the small set of SQL-shaped string helpers
 * that the Drizzle-backed search and filter routes reach for when
 * composing query fragments. The single helper today is `escapeLike`
 * — every search route that builds a `LIKE` pattern from
 * user-supplied input runs the input through `escapeLike` first so
 * `%` and `_` characters land as literal matches rather than as
 * wildcards. Without that escape, a user typing `100%` into the
 * entities search would match every row in the table; with it, the
 * search behaves like a plain substring match.
 *
 * The helper is intentionally tiny and dependency-free so it can be
 * imported into hot loader paths without dragging in any of the
 * Drizzle column or schema types.
 *
 * @version v0.3.0
 */

/**
 * Escape SQL LIKE metacharacters (% and _) in user input so they are treated
 * as literal characters inside a LIKE pattern.
 */
export function escapeLike(s: string): string {
  return s.replace(/[%_]/g, "\\$&");
}
