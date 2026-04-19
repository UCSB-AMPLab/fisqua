/**
 * SQL utility helpers for Drizzle ORM queries.
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
