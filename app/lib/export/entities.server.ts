/**
 * Entity Formatter
 *
 * This module deals with mapping one Drizzle row off `entities` into
 * the shape the published JSON expects. It filters each entity to the
 * descriptions that reference it and are themselves publishable, so
 * unpublished work never leaks through the entity index.
 *
 * Every entity carries `modified_at`, the UTC calendar date of its
 * `updated_at` (`modifiedAtDate`), and none when that is empty.
 *
 * An entity's `functions` come from its `entity_functions` rows,
 * grouped as the 21 April 2026 export grouped them (`groupFunctions`),
 * and its `dbe_id` is written as that export's integer.
 *
 * `gender` is the stored code of the federation's `gender` list, or
 * null; `known_only_from_relation` is the stored flag; `qualified_name`
 * the stored text, or null.
 *
 * @version v0.9.0
 */

import type { ExportEntity } from "./types";
import { modifiedAtDate } from "./constants";

/**
 * Map a D1 entity row to ExportEntity.
 * Key mappings:
 * - entityCode -> entity_code
 * - dateStart -> date_start AND date_earliest (legacy frontend alias)
 * - dateEnd -> date_end AND date_latest (legacy frontend alias)
 * - particle is always null (no D1 column — research assumption A4)
 *
 * `legal_status` was dropped from the entities table (0% populated in
 * production). Preserved as `null` in the export shape for snapshot
 * continuity.
 *
 * `formerCodes` are the codes zasqua.org published the entity under
 * before (`former-codes.server.ts`); `former_codes` is omitted when
 * there are none.
 *
 * `entityFunctions` are the entity's `entity_functions` rows in the
 * order they were entered, the only source of its functions; they give
 * `functions` (`groupFunctions`), which is left out when there are
 * none. The `entities.functions` column is not read.
 */
export function formatEntity(row: {
  entityCode: string | null;
  displayName: string;
  sortName: string;
  givenName: string | null;
  surname: string | null;
  entityType: string;
  honorific: string | null;
  primaryFunction: string | null;
  primaryFunctionCanonical?: string | null;
  nameVariants: string | null;
  datesOfExistence: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  history: string | null;
  entityFunctions?: Array<{ function: string }>;
  sources: string | null;
  wikidataId: string | null;
  viafId: string | null;
  dbeId?: string | null;
  gender?: string | null;
  knownOnlyFromRelation?: boolean | null;
  qualifiedName?: string | null;
  updatedAt?: number | null;
}, formerCodes: string[] = []): ExportEntity {
  const modifiedAt = modifiedAtDate(row.updatedAt);
  return {
    entity_code: row.entityCode,
    display_name: row.displayName,
    sort_name: row.sortName,
    given_name: row.givenName,
    particle: null,
    surname: row.surname,
    entity_type: row.entityType,
    honorific: row.honorific,
    primary_function: row.primaryFunctionCanonical ?? row.primaryFunction,
    name_variants: JSON.parse(row.nameVariants ?? "[]"),
    dates_of_existence: row.datesOfExistence,
    date_earliest: row.dateStart,
    date_latest: row.dateEnd,
    date_start: row.dateStart,
    date_end: row.dateEnd,
    history: row.history,
    // Dropped in 0036 (0% populated); preserved as null in export shape.
    legal_status: null,
    ...(row.entityFunctions && row.entityFunctions.length > 0
      ? { functions: groupFunctions(row.entityFunctions) }
      : {}),
    sources: row.sources,
    wikidata_id: row.wikidataId,
    viaf_id: row.viafId,
    dbe_id: dbeIdValue(row.dbeId),
    gender: row.gender ?? null,
    known_only_from_relation: row.knownOnlyFromRelation === true,
    qualified_name: row.qualifiedName ?? null,
    ...(formerCodes.length > 0 ? { former_codes: formerCodes } : {}),
    ...(modifiedAt ? { modified_at: modifiedAt } : {}),
  };
}

/**
 * The key two spellings of a function share when they differ only in
 * case or accents: compatibility-decomposed (so "nº" reads as "no"),
 * combining marks removed, lower-cased.
 */
export function functionKey(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * An entity's `entity_functions` rows, given in the order they were
 * entered, as `{function, count}` entries, the grouping the 21 April
 * 2026 export made with MySQL's case- and accent-insensitive
 * collation: spellings that differ only in case or accents are one
 * function, named by the first one entered and counted together; the
 * entries run by count, highest first, then by `functionKey` in
 * code-point order. A row whose function is empty or only whitespace
 * is left out: such rows are artefacts of an import, not functions,
 * and the record page drops blank lines the same way.
 */
export function groupFunctions(
  rows: Array<{ function: string }>
): Array<{ function: string; count: number }> {
  const groups = new Map<string, { function: string; count: number }>();
  for (const row of rows) {
    // Empty or whitespace-only: an import artefact, not a function.
    if (!row.function?.trim()) continue;
    const key = functionKey(row.function);
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { function: row.function, count: 1 });
  }
  return [...groups.entries()]
    .sort(([ka, a], [kb, b]) => b.count - a.count || (ka < kb ? -1 : ka > kb ? 1 : 0))
    .map(([, g]) => g);
}

/**
 * `dbe_id` as the engine's contract and the April export give it: the
 * Diccionario Biográfico Español number as an integer, or null when
 * the column is empty or holds anything but digits.
 */
export function dbeIdValue(text: string | null | undefined): number | null {
  const value = text?.trim();
  return value && /^\d+$/.test(value) ? Number(value) : null;
}

/**
 * Filter entities to only those linked to at least one published description.
 * The caller computes linkedEntityIds from descriptionEntities where
 * the description has isPublished=true.
 */
export function filterLinkedEntities<T extends { id: string }>(
  entities: T[],
  linkedEntityIds: Set<string>
): T[] {
  return entities.filter((e) => linkedEntityIds.has(e.id));
}

// @version v0.9.0
