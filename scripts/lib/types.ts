/** Map from old Django integer PK to new UUID */
export type IdMap = Map<number, string>;

/** A single validation/import error for one row */
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

/** Column configuration for a target table */
export interface TableConfig {
  name: string;
  columns: string[];
}
