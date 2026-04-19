import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import type { IdMap, ImportResult } from "../lib/types";
import { escapeSql, generateInserts, writeSqlFiles } from "../lib/sql";
import { generateUniqueCodes } from "../lib/codes";
import { toEpochSeconds, stringifyJsonArray } from "../lib/transform";

const COLUMNS = [
  "id", "place_code", "label", "display_name", "place_type", "name_variants",
  "parent_id", "latitude", "longitude", "coordinate_precision",
  "historical_gobernacion", "historical_partido", "historical_region",
  "country_code", "admin_level_1", "admin_level_2", "needs_geocoding",
  "merged_into", "tgn_id", "hgis_id", "whg_id", "wikidata_id",
  "created_at", "updated_at",
];

/**
 * Import places from a JSON export file.
 * Two-pass approach: first generate all UUIDs, then resolve parent_id and merged_into FKs.
 * Renames colonial_* fields to historical_* for D1 schema.
 */
export async function importPlaces(
  inputPath: string
): Promise<{ result: ImportResult; idMap: IdMap }> {
  const raw = await fs.readFile(inputPath, "utf8");
  const records = JSON.parse(raw) as Record<string, unknown>[];

  const idMap: IdMap = new Map();
  const errors: ImportResult["errors"] = [];

  // Pass 1: Generate UUIDs and codes for all records
  const codes = generateUniqueCodes("nl", records.length);

  for (let i = 0; i < records.length; i++) {
    const oldId = records[i].id as number;
    const newId = crypto.randomUUID();
    idMap.set(oldId, newId);
  }

  // Pass 2: Resolve FKs and build SQL rows
  const rows: string[][] = [];
  const uuids = [...idMap.values()];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const oldId = record.id as number;
    const newId = idMap.get(oldId)!;

    const createdAt = toEpochSeconds(record.created_at as string | null);
    const updatedAt = toEpochSeconds(record.updated_at as string | null);

    if (createdAt === null || updatedAt === null) {
      errors.push({
        table: "places",
        row: i,
        oldId,
        errors: ["Missing created_at or updated_at timestamp"],
      });
      continue;
    }

    // Resolve parent_id FK
    let parentId: string | null = null;
    const parentOldId = record.parent_id as number | null;
    if (parentOldId !== null && parentOldId !== undefined) {
      const resolved = idMap.get(parentOldId);
      if (resolved) {
        parentId = resolved;
      } else {
        console.warn(
          `Warning: Place ${oldId} parent_id references unknown ID ${parentOldId}`
        );
      }
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
          `Warning: Place ${oldId} merged_into references unknown ID ${mergedIntoOldId}`
        );
      }
    }

    rows.push([
      escapeSql(newId),
      escapeSql(codes[i]),
      escapeSql(record.label),
      escapeSql(record.display_name),
      escapeSql(record.place_type ?? null),
      escapeSql(stringifyJsonArray(record.name_variants)),
      escapeSql(parentId),
      escapeSql(record.latitude ?? null),
      escapeSql(record.longitude ?? null),
      escapeSql(record.coordinate_precision ?? null),
      // Rename colonial_* -> historical_*
      escapeSql(record.colonial_gobernacion ?? null),
      escapeSql(record.colonial_partido ?? null),
      escapeSql(record.colonial_region ?? null),
      escapeSql(record.country_code ?? null),
      escapeSql(record.admin_level_1 ?? null),
      escapeSql(record.admin_level_2 ?? null),
      escapeSql(record.needs_geocoding ?? true),
      escapeSql(mergedInto),
      escapeSql(record.tgn_id ?? null),
      escapeSql(record.hgis_id ?? null),
      escapeSql(record.whg_id ?? null),
      escapeSql(record.wikidata_id ?? null),
      escapeSql(createdAt),
      escapeSql(updatedAt),
    ]);
  }

  const statements = generateInserts("places", COLUMNS, rows, 100);
  const sqlFiles = await writeSqlFiles("places", statements);

  return {
    result: {
      table: "places",
      total: records.length,
      imported: rows.length,
      skipped: errors.length,
      errors,
      sqlFiles,
    },
    idMap,
  };
}
