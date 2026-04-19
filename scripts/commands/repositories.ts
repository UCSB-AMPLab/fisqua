import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import type { IdMap, ImportResult } from "../lib/types";
import { escapeSql, generateInserts, writeSqlFiles } from "../lib/sql";
import { toEpochSeconds } from "../lib/transform";

const COLUMNS = [
  "id", "code", "name", "short_name", "country_code", "country",
  "city", "address", "website", "notes", "enabled", "created_at", "updated_at",
];

/**
 * Import repositories from a JSON export file.
 * Generates UUIDs for each record and produces chunked SQL INSERT files.
 */
export async function importRepositories(
  inputPath: string
): Promise<{ result: ImportResult; idMap: IdMap }> {
  const raw = await fs.readFile(inputPath, "utf8");
  const records = JSON.parse(raw) as Record<string, unknown>[];

  const idMap: IdMap = new Map();
  const rows: string[][] = [];
  const errors: ImportResult["errors"] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const oldId = record.id as number;
    const newId = crypto.randomUUID();
    idMap.set(oldId, newId);

    const createdAt = toEpochSeconds(record.created_at as string | null);
    const updatedAt = toEpochSeconds(record.updated_at as string | null);

    if (createdAt === null || updatedAt === null) {
      errors.push({
        table: "repositories",
        row: i,
        oldId,
        errors: ["Missing created_at or updated_at timestamp"],
      });
      idMap.delete(oldId);
      continue;
    }

    rows.push([
      escapeSql(newId),
      escapeSql(record.code),
      escapeSql(record.name),
      escapeSql(record.short_name ?? null),
      escapeSql(record.country_code ?? "COL"),
      escapeSql(record.country ?? null),
      escapeSql(record.city ?? null),
      escapeSql(record.address ?? null),
      escapeSql(record.website ?? null),
      escapeSql(record.notes ?? null),
      escapeSql(record.enabled ?? true),
      escapeSql(createdAt),
      escapeSql(updatedAt),
    ]);
  }

  const statements = generateInserts("repositories", COLUMNS, rows, 100);
  const sqlFiles = await writeSqlFiles("repositories", statements);

  return {
    result: {
      table: "repositories",
      total: records.length,
      imported: rows.length,
      skipped: errors.length,
      errors,
      sqlFiles,
    },
    idMap,
  };
}
