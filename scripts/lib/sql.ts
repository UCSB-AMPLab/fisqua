import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImportResult } from "./types";

/**
 * Escape a value for safe inclusion in a SQL statement.
 *
 * - null/undefined -> NULL
 * - boolean -> 1/0
 * - number -> string representation
 * - string -> single-quoted with internal quotes doubled
 */
export function escapeSql(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  // String: escape single quotes by doubling them
  const str = String(value).replace(/'/g, "''");
  return `'${str}'`;
}

/**
 * Generate batched INSERT statements.
 *
 * @param tableName - Target table
 * @param columns - Column names
 * @param rows - Each row is an array of already-escaped SQL value strings
 * @param batchSize - Max rows per INSERT statement (default 100)
 * @returns Array of complete INSERT statements
 */
export function generateInserts(
  tableName: string,
  columns: string[],
  rows: string[][],
  batchSize = 100
): string[] {
  const statements: string[] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const valueRows = batch
      .map((row) => `  (${row.join(", ")})`)
      .join(",\n");
    statements.push(
      `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES\n${valueRows};`
    );
  }
  return statements;
}

/**
 * Write SQL statements to chunked files in an output directory.
 *
 * Each file starts with `PRAGMA defer_foreign_keys = true;` to allow
 * FK-dependent inserts within each file.
 *
 * @param tableName - Used for file naming: {tableName}-001.sql
 * @param statements - Array of SQL INSERT statements
 * @param statementsPerFile - Max statements per file (default 50)
 * @param outputDir - Output directory (default .import/)
 * @returns Array of created file paths
 */
export async function writeSqlFiles(
  tableName: string,
  statements: string[],
  statementsPerFile = 50,
  outputDir = ".import"
): Promise<string[]> {
  await fs.mkdir(outputDir, { recursive: true });

  const files: string[] = [];
  for (let i = 0; i < statements.length; i += statementsPerFile) {
    const chunk = statements.slice(i, i + statementsPerFile);
    const fileNum = Math.floor(i / statementsPerFile) + 1;
    const fileName = `${tableName}-${String(fileNum).padStart(3, "0")}.sql`;
    const filePath = path.join(outputDir, fileName);

    const content = `PRAGMA defer_foreign_keys = true;\n\n${chunk.join("\n\n")}\n`;
    await fs.writeFile(filePath, content, "utf8");
    files.push(filePath);
  }
  return files;
}
