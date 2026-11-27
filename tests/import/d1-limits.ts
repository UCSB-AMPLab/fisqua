/**
 * Tests — D1's limits on the reads a command-line plan makes
 *
 * This module deals with D1's limits on the reads a command-line plan
 * makes, for the suites that test plans against an in-memory database. The
 * plans read D1 through wrangler, and D1 refuses a statement whose result
 * has more than 100 columns ("too many columns in result set"). SQLite
 * allows far more, so a plan tested only against an in-memory database can
 * pass here and fail on every remote run. `d1Read` prepares the statement
 * against the test database and refuses it, as D1 would, when its result
 * has more columns than D1 returns, before running it.
 *
 * @version v0.9.0
 */

import type { DatabaseSync } from "node:sqlite";

/** Most result columns D1 returns for one statement. */
export const D1_RESULT_COLUMNS = 100;

/** Run a read as D1 would: refused when its result has more columns than D1 returns. */
export function d1Read(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  const statement = db.prepare(sql);
  const columns = statement.columns().length;
  if (columns > D1_RESULT_COLUMNS) {
    throw new Error(`too many columns in result set: ${columns} (D1 returns at most ${D1_RESULT_COLUMNS})`);
  }
  return statement.all() as Record<string, unknown>[];
}

// @version v0.9.0
