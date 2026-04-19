import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import type { IdMap, ImportResult } from "../lib/types";
import { escapeSql, generateInserts, writeSqlFiles } from "../lib/sql";
import { toEpochSeconds, stringifyJsonArray } from "../lib/transform";

/**
 * Rewrite a manifest URL to the canonical Zasqua manifests domain pattern.
 * Returns null if the input URL is null, undefined, or empty.
 */
export function rewriteManifestUrl(
  url: string | null | undefined,
  referenceCode: string
): string | null {
  if (!url) return null;
  const sanitisedRef = referenceCode.replace(/[?#]/g, "");
  return `https://manifests.zasqua.org/${sanitisedRef}/manifest.json`;
}

const COLUMNS = [
  "id", "repository_id", "parent_id", "position", "root_description_id",
  "depth", "child_count", "path_cache", "description_level", "resource_type",
  "genre", "reference_code", "local_identifier", "title", "translated_title",
  "uniform_title", "date_expression", "date_start", "date_end", "date_certainty",
  "extent", "dimensions", "medium", "imprint", "edition_statement",
  "series_statement", "volume_number", "issue_number", "pages", "provenance",
  "scope_content", "ocr_text", "arrangement", "access_conditions",
  "reproduction_conditions", "language", "location_of_originals",
  "location_of_copies", "related_materials", "finding_aids", "section_title",
  "notes", "internal_notes", "creator_display", "place_display",
  "iiif_manifest_url", "has_digital", "is_published", "last_exported_at",
  "created_by", "updated_by", "created_at", "updated_at",
];

interface HierarchyInfo {
  depth: number;
  position: number;
  rootDescriptionId: string;
  childCount: number;
  pathCache: string;
}

/**
 * Import descriptions from a JSON export file.
 * Computes adjacency list hierarchy fields (depth, position, rootDescriptionId,
 * childCount, pathCache) from flat parent_id relationships.
 *
 * Generates UUIDs for each record, resolves repository_id and parent_id FKs,
 * and produces chunked SQL INSERT files.
 */
export async function importDescriptions(
  inputPath: string,
  repoIdMap: IdMap
): Promise<{ result: ImportResult; idMap: IdMap }> {
  const raw = await fs.readFile(inputPath, "utf8");
  const records = JSON.parse(raw) as Record<string, unknown>[];

  const idMap: IdMap = new Map();
  const errors: ImportResult["errors"] = [];

  // Pass 1: Build ID map, index by old ID, and group by parent
  const byOldId = new Map<number, Record<string, unknown>>();
  const byParent = new Map<number | null, Record<string, unknown>[]>();

  for (const record of records) {
    const oldId = record.id as number;
    const newId = crypto.randomUUID();
    idMap.set(oldId, newId);
    byOldId.set(oldId, record);

    const parentId = (record.parent_id as number | null) ?? null;
    if (!byParent.has(parentId)) {
      byParent.set(parentId, []);
    }
    byParent.get(parentId)!.push(record);
  }

  // Sort children within each parent group by local_identifier
  for (const children of byParent.values()) {
    children.sort((a, b) => {
      const aId = (a.local_identifier as string) ?? "";
      const bId = (b.local_identifier as string) ?? "";
      return aId.localeCompare(bId);
    });
  }

  // Pass 2: Compute hierarchy fields iteratively (no recursion)
  const hierarchyCache = new Map<number, HierarchyInfo>();

  function computeHierarchy(oldId: number): HierarchyInfo {
    const cached = hierarchyCache.get(oldId);
    if (cached) return cached;

    const record = byOldId.get(oldId)!;
    const parentOldId = (record.parent_id as number | null) ?? null;
    const title = (record.title as string) ?? "";

    // Compute depth and rootDescriptionId by walking up the parent chain iteratively
    let depth = 0;
    let rootOldId = oldId;
    const pathTitles: string[] = [title];

    let currentParentId = parentOldId;
    // Walk up iteratively, collecting path titles
    const ancestors: number[] = [];
    while (currentParentId !== null) {
      ancestors.push(currentParentId);
      const parentRecord = byOldId.get(currentParentId);
      if (!parentRecord) break;
      pathTitles.push((parentRecord.title as string) ?? "");
      rootOldId = currentParentId;
      currentParentId = (parentRecord.parent_id as number | null) ?? null;
      depth++;
    }

    // Reverse pathTitles so it reads root-to-leaf
    pathTitles.reverse();
    const pathCache = pathTitles.join(" > ");

    const rootDescriptionId = idMap.get(rootOldId)!;

    // Compute position: index within parent's sorted children
    const siblings = byParent.get(parentOldId) ?? [];
    const position = siblings.findIndex((s) => (s.id as number) === oldId);

    // Compute childCount: number of direct children
    const children = byParent.get(oldId);
    const childCount = children ? children.length : 0;

    const info: HierarchyInfo = {
      depth,
      position: position >= 0 ? position : 0,
      rootDescriptionId,
      childCount,
      pathCache,
    };

    hierarchyCache.set(oldId, info);
    return info;
  }

  // Compute hierarchy for all records
  for (const oldId of byOldId.keys()) {
    computeHierarchy(oldId);
  }

  // Pass 3: Transform and generate SQL
  const rows: string[][] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const oldId = record.id as number;
    const newId = idMap.get(oldId)!;
    const hierarchy = hierarchyCache.get(oldId)!;

    // Resolve repository_id FK
    const repoOldId = record.repository_id as number;
    const repositoryId = repoIdMap.get(repoOldId);
    if (!repositoryId) {
      errors.push({
        table: "descriptions",
        row: i,
        oldId,
        errors: [`repository_id ${repoOldId} not found in repository IdMap`],
      });
      idMap.delete(oldId);
      continue;
    }

    // Resolve parent_id FK (null for roots)
    const parentOldId = (record.parent_id as number | null) ?? null;
    const parentId = parentOldId !== null ? idMap.get(parentOldId) ?? null : null;

    const createdAt = toEpochSeconds(record.created_at as string | null);
    const updatedAt = toEpochSeconds(record.updated_at as string | null);

    if (createdAt === null || updatedAt === null) {
      errors.push({
        table: "descriptions",
        row: i,
        oldId,
        errors: ["Missing created_at or updated_at timestamp"],
      });
      idMap.delete(oldId);
      continue;
    }

    rows.push([
      escapeSql(newId),
      escapeSql(repositoryId),
      escapeSql(parentId),
      escapeSql(hierarchy.position),
      escapeSql(hierarchy.rootDescriptionId),
      escapeSql(hierarchy.depth),
      escapeSql(hierarchy.childCount),
      escapeSql(hierarchy.pathCache),
      escapeSql(record.description_level),
      escapeSql(record.resource_type ?? null),
      escapeSql(stringifyJsonArray(record.genre)),
      escapeSql(record.reference_code),
      escapeSql(record.local_identifier),
      escapeSql(record.title),
      escapeSql(record.translated_title ?? null),
      escapeSql(record.uniform_title ?? null),
      escapeSql(record.date_expression ?? null),
      escapeSql(record.date_start ?? null),
      escapeSql(record.date_end ?? null),
      escapeSql(record.date_certainty ?? null),
      escapeSql(record.extent ?? null),
      escapeSql(record.dimensions ?? null),
      escapeSql(record.medium ?? null),
      escapeSql(record.imprint ?? null),
      escapeSql(record.edition_statement ?? null),
      escapeSql(record.series_statement ?? null),
      escapeSql(record.volume_number ?? null),
      escapeSql(record.issue_number ?? null),
      escapeSql(record.pages ?? null),
      escapeSql(record.provenance ?? null),
      escapeSql(record.scope_content ?? null),
      escapeSql((record.ocr_text as string | null | undefined) ?? ""),
      escapeSql(record.arrangement ?? null),
      escapeSql(record.access_conditions ?? null),
      escapeSql(record.reproduction_conditions ?? null),
      escapeSql(record.language ?? null),
      escapeSql(record.location_of_originals ?? null),
      escapeSql(record.location_of_copies ?? null),
      escapeSql(record.related_materials ?? null),
      escapeSql(record.finding_aids ?? null),
      escapeSql(record.section_title ?? null),
      escapeSql(record.notes ?? null),
      escapeSql(record.internal_notes ?? null),
      escapeSql(record.creator_display ?? null),
      escapeSql(record.place_display ?? null),
      escapeSql(rewriteManifestUrl(record.iiif_manifest_url as string | null, record.reference_code as string)),
      escapeSql(record.has_digital ?? false),
      escapeSql(record.is_published ?? true),
      escapeSql(null), // last_exported_at = NULL
      escapeSql(null), // created_by = NULL (per user decision)
      escapeSql(null), // updated_by = NULL (per user decision)
      escapeSql(createdAt),
      escapeSql(updatedAt),
    ]);
  }

  const statements = generateInserts("descriptions", COLUMNS, rows, 1);
  const sqlFiles = await writeSqlFiles("descriptions", statements);

  // Write PK-to-UUID mapping for downstream consumers
  const mapping: Record<string, string> = {};
  for (const [oldId, newId] of idMap.entries()) {
    mapping[String(oldId)] = newId;
  }
  const mappingDir = ".import";
  await fs.mkdir(mappingDir, { recursive: true });
  await fs.writeFile(
    `${mappingDir}/pk-uuid-mapping.json`,
    JSON.stringify({ descriptions: mapping }, null, 2),
    "utf8"
  );

  return {
    result: {
      table: "descriptions",
      total: records.length,
      imported: rows.length,
      skipped: errors.length,
      errors,
      sqlFiles,
    },
    idMap,
  };
}
