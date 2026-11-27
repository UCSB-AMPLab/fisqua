/**
 * Scripts — one guard statement of a SQL file
 *
 * This module deals with the statement every guarded SQL file is built
 * from. `guard` gives a SELECT that returns 1 while `condition` holds
 * and otherwise fails, by calling `json()` on the text `ABORT: <message>`,
 * which is not JSON. D1 applies a `--file` as one unit, so a guard that
 * fails leaves nothing of the file written, and wrangler prints the
 * message.
 *
 * The module imports nothing that needs Node's child processes, so the
 * guards of the command line (`./access-guards.ts`) also load in the
 * Workers test pool, where the capture suites run against a real D1
 * binding. `../authority-merges.ts` re-exports `guard` for the modules
 * that import it from there.
 *
 * @version v0.9.0
 */

import { escapeSql } from "../sql";

/** A SELECT that returns 1 while `condition` holds, and fails with `message` otherwise. */
export function guard(condition: string, message: string): string {
  return `SELECT CASE WHEN ${condition} THEN 1 ELSE json(${escapeSql(`ABORT: ${message}`)}) END AS guard;`;
}

// @version v0.9.0
