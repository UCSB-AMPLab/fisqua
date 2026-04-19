import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import type { IdMap, ImportResult } from "../lib/types";
import { escapeSql, generateInserts, writeSqlFiles } from "../lib/sql";
import { generateUniqueCodes } from "../lib/codes";
import { toEpochSeconds } from "../lib/transform";
import { stringifyJsonArray } from "../lib/transform";

const COLUMNS = [
  "id", "entity_code", "display_name", "sort_name", "surname", "given_name",
  "entity_type", "honorific", "primary_function", "name_variants",
  "dates_of_existence", "date_start", "date_end", "history", "legal_status",
  "functions", "sources", "merged_into", "wikidata_id", "viaf_id",
  "created_at", "updated_at",
];

/**
 * Import entities from a JSON export file.
 * Generates UUIDs and ne-xxxxxx codes for each record, resolves merged_into FKs,
 * and produces chunked SQL INSERT files.
 */
export async function importEntities(
  inputPath: string
): Promise<{ result: ImportResult; idMap: IdMap }> {
  const raw = await fs.readFile(inputPath, "utf8");
  const records = JSON.parse(raw) as Record<string, unknown>[];

  const idMap: IdMap = new Map();
  const errors: ImportResult["errors"] = [];

  // Pass 1: Generate UUIDs and codes for all records
  const codes = generateUniqueCodes("ne", records.length);
  const processed: Array<{
    record: Record<string, unknown>;
    newId: string;
    code: string;
    index: number;
  }> = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const oldId = record.id as number;
    const newId = crypto.randomUUID();
    idMap.set(oldId, newId);
    processed.push({ record, newId, code: codes[i], index: i });
  }

  // Pass 2: Resolve merged_into and build SQL rows
  const rows: string[][] = [];

  for (const { record, newId, code, index } of processed) {
    const createdAt = toEpochSeconds(record.created_at as string | null);
    const updatedAt = toEpochSeconds(record.updated_at as string | null);

    if (createdAt === null || updatedAt === null) {
      errors.push({
        table: "entities",
        row: index,
        oldId: record.id as number,
        errors: ["Missing created_at or updated_at timestamp"],
      });
      continue;
    }

    // Resolve merged_into FK
    let mergedInto: string | null = null;
    const mergedIntoOldId = record.merged_into as number | null;
    if (mergedIntoOldId !== null && mergedIntoOldId !== undefined) {
      const resolved = idMap.get(mergedIntoOldId);
      if (resolved) {
        mergedInto = resolved;
      } else {
        console.warn(
          `Warning: Entity ${record.id} merged_into references unknown ID ${mergedIntoOldId}`
        );
      }
    }

    rows.push([
      escapeSql(newId),
      escapeSql(code),
      escapeSql(record.display_name),
      escapeSql(record.sort_name),
      escapeSql(record.surname ?? null),
      escapeSql(record.given_name ?? null),
      escapeSql(record.entity_type),
      escapeSql(record.honorific ?? null),
      escapeSql(record.primary_function ?? null),
      escapeSql(stringifyJsonArray(record.name_variants)),
      escapeSql(record.dates_of_existence ?? null),
      escapeSql(record.date_start ?? null),
      escapeSql(record.date_end ?? null),
      escapeSql(record.history ?? null),
      escapeSql(record.legal_status ?? null),
      escapeSql(record.functions ?? null),
      escapeSql(record.sources ?? null),
      escapeSql(mergedInto),
      escapeSql(record.wikidata_id ?? null),
      escapeSql(record.viaf_id ?? null),
      escapeSql(createdAt),
      escapeSql(updatedAt),
    ]);
  }

  const statements = generateInserts("entities", COLUMNS, rows, 100);
  const sqlFiles = await writeSqlFiles("entities", statements);

  return {
    result: {
      table: "entities",
      total: records.length,
      imported: rows.length,
      skipped: errors.length,
      errors,
      sqlFiles,
    },
    idMap,
  };
}
