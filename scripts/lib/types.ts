/**
 * Scripts — import types
 *
 * This module deals with the result shape the SQL-writing commands
 * return. `ImportResult` is one table's outcome: how many rows the
 * command read, wrote and skipped, the per-row `ImportError`s, and the
 * SQL files it wrote. `scripts/commands/vocabulary-terms.ts` and
 * `scripts/commands/vocabulary-migration.ts` return it, and
 * `scripts/lib/sql.ts` is written against it.
 *
 * The Django round import is retired, and the shapes only its row
 * builders and orchestrator used were removed with it: `IdMap` (Django primary key to UUID),
 * `TableConfig`, `RunManifest`, `FailureReport`, `CountSnapshot` and
 * `ClearAssertion`, together with the cascade-skip fields
 * (`rootCauseTable`, `cascadedFrom`) that `ImportError` carried for the
 * junction rows.
 *
 * @version v0.9.0
 */

/** A single validation/import error for one row. */
export interface ImportError {
  table: string;
  row: number;
  oldId: number | string;
  errors: string[];
}

/** Summary result for one table's import */
export interface ImportResult {
  table: string;
  total: number;
  imported: number;
  skipped: number;
  errors: ImportError[];
  sqlFiles: string[];
}

// Version: v0.9.0
