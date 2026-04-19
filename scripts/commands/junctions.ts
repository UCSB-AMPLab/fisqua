import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import type { IdMap, ImportResult } from "../lib/types";
import { escapeSql, generateInserts, writeSqlFiles } from "../lib/sql";
import { toEpochSeconds } from "../lib/transform";

const DE_COLUMNS = [
  "id", "description_id", "entity_id", "role", "role_note", "sequence",
  "honorific", "function", "name_as_recorded", "created_at",
];

const DP_COLUMNS = [
  "id", "description_id", "place_id", "role", "role_note", "created_at",
];

/**
 * Import description-entity junction records from a JSON export file.
 * Resolves both description_id and entity_id FKs via their respective IdMaps.
 * Missing FK references are logged as errors and the row is skipped.
 */
export async function importDescriptionEntities(
  inputPath: string,
  descIdMap: IdMap,
  entityIdMap: IdMap
): Promise<ImportResult> {
  const raw = await fs.readFile(inputPath, "utf8");
  const records = JSON.parse(raw) as Record<string, unknown>[];

  const rows: string[][] = [];
  const errors: ImportResult["errors"] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const oldId = record.id as number;

    // Resolve description_id FK
    const descOldId = record.description_id as number;
    const descriptionId = descIdMap.get(descOldId);

    if (!descriptionId) {
      errors.push({
        table: "description_entities",
        row: i,
        oldId,
        errors: [`description_id ${descOldId} not found in description IdMap`],
      });
      continue;
    }

    // Resolve entity_id FK
    const entityOldId = record.entity_id as number;
    const entityId = entityIdMap.get(entityOldId);

    if (!entityId) {
      errors.push({
        table: "description_entities",
        row: i,
        oldId,
        errors: [`entity_id ${entityOldId} not found in entity IdMap`],
      });
      continue;
    }

    const createdAt =
      toEpochSeconds(record.created_at as string | null) ??
      Math.floor(Date.now() / 1000);

    const newId = crypto.randomUUID();

    rows.push([
      escapeSql(newId),
      escapeSql(descriptionId),
      escapeSql(entityId),
      escapeSql(record.role),
      escapeSql(record.role_note ?? null),
      escapeSql(record.sequence ?? 0),
      escapeSql(record.honorific ?? null),
      escapeSql(record.function ?? null),
      escapeSql(record.name_as_recorded ?? null),
      escapeSql(createdAt),
    ]);
  }

  const statements = generateInserts("description_entities", DE_COLUMNS, rows, 100);
  const sqlFiles = await writeSqlFiles("description_entities", statements);

  return {
    table: "description_entities",
    total: records.length,
    imported: rows.length,
    skipped: errors.length,
    errors,
    sqlFiles,
  };
}

/**
 * Import description-place junction records from a JSON export file.
 * Resolves both description_id and place_id FKs via their respective IdMaps.
 * Missing FK references are logged as errors and the row is skipped.
 */
export async function importDescriptionPlaces(
  inputPath: string,
  descIdMap: IdMap,
  placeIdMap: IdMap
): Promise<ImportResult> {
  const raw = await fs.readFile(inputPath, "utf8");
  const records = JSON.parse(raw) as Record<string, unknown>[];

  const rows: string[][] = [];
  const errors: ImportResult["errors"] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const oldId = record.id as number;

    // Resolve description_id FK
    const descOldId = record.description_id as number;
    const descriptionId = descIdMap.get(descOldId);

    if (!descriptionId) {
      errors.push({
        table: "description_places",
        row: i,
        oldId,
        errors: [`description_id ${descOldId} not found in description IdMap`],
      });
      continue;
    }

    // Resolve place_id FK
    const placeOldId = record.place_id as number;
    const placeId = placeIdMap.get(placeOldId);

    if (!placeId) {
      errors.push({
        table: "description_places",
        row: i,
        oldId,
        errors: [`place_id ${placeOldId} not found in place IdMap`],
      });
      continue;
    }

    const createdAt =
      toEpochSeconds(record.created_at as string | null) ??
      Math.floor(Date.now() / 1000);

    const newId = crypto.randomUUID();

    rows.push([
      escapeSql(newId),
      escapeSql(descriptionId),
      escapeSql(placeId),
      escapeSql(record.role),
      escapeSql(record.role_note ?? null),
      escapeSql(createdAt),
    ]);
  }

  const statements = generateInserts("description_places", DP_COLUMNS, rows, 100);
  const sqlFiles = await writeSqlFiles("description_places", statements);

  return {
    table: "description_places",
    total: records.length,
    imported: rows.length,
    skipped: errors.length,
    errors,
    sqlFiles,
  };
}
