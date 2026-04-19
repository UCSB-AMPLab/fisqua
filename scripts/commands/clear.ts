import * as fs from "node:fs/promises";
import * as path from "node:path";

const OUTPUT_DIR = ".import";

/**
 * Generate SQL to DELETE all rows in reverse FK order.
 * Does not execute SQL -- writes files for manual execution via wrangler.
 */
export async function generateClearSql(): Promise<string[]> {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const sql = `PRAGMA defer_foreign_keys = true;

DELETE FROM description_places;
DELETE FROM description_entities;
DELETE FROM entity_functions;
DELETE FROM descriptions;
DELETE FROM places;
DELETE FROM entities;
DELETE FROM repositories;
`;

  const filePath = path.join(OUTPUT_DIR, "clear-001.sql");
  await fs.writeFile(filePath, sql, "utf8");
  return [filePath];
}

/**
 * Generate SQL to rebuild FTS5 indexes after data import.
 * Does not execute SQL -- writes files for manual execution via wrangler.
 */
export async function generateFtsRebuild(): Promise<string[]> {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const sql = `INSERT INTO entities_fts(entities_fts) VALUES('rebuild');
INSERT INTO places_fts(places_fts) VALUES('rebuild');
`;

  const filePath = path.join(OUTPUT_DIR, "fts-rebuild-001.sql");
  await fs.writeFile(filePath, sql, "utf8");
  return [filePath];
}
