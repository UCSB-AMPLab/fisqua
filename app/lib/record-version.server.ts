/**
 * Record versions
 *
 * This module deals with record versions. A record's version is its
 * `updated_at`. An edit form carries the version its fields were loaded
 * at, and a save writes only while the record still holds the version the
 * save read: its UPDATE is conditioned on that version and sets the next
 * one. The next version is the time of the save, or one past the version
 * read when the clock has not moved past it, so every save moves the
 * version on and two saves in the same millisecond never leave the record
 * at a version a stale form still holds.
 *
 * A write that moves many records' versions in one statement, without
 * reading them, uses `nextVersionSql`: the same rule computed in the
 * statement from the value each row holds when it is written, so the
 * version moves strictly up whatever lands before it, and a form that
 * read any earlier version fails its check.
 *
 * @version v0.9.0
 */

import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/** The version a save that read `read` writes. */
export function nextVersion(read: number, now: number = Date.now()): number {
  return Math.max(now, read + 1);
}

/** `nextVersion` of the value `column` holds when the statement writes it. */
export function nextVersionSql(column: SQLWrapper, now: number = Date.now()): SQL<number> {
  return sql<number>`CASE WHEN ${column} >= ${now} THEN ${column} + 1 ELSE ${now} END`;
}

// @version v0.9.0
