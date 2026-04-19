/**
 * Publish Pipeline Steps
 *
 * Every step the publish workflow runs lives in this module, one
 * exported function per Cloudflare Workflow step. The contract each
 * function respects is narrow: read a well-defined slice of D1, format
 * it with the per-entity helpers next to this file, upload a bounded
 * set of R2 objects, and return the record counts the workflow needs
 * to record in its heartbeat row.
 *
 * Memory stays bounded to at most one fonds at a time and R2 PUTs are
 * capped at a few hundred per step, so a single Worker invocation
 * never runs out of its 128 MB / 30 s / 1000-subrequest budget. The
 * orchestration that wires these into a durable workflow — retries,
 * heartbeats, final tombstone writes — lives in
 * `app/workflows/publish-export.ts`.
 *
 * @version v0.3.0
 */

import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  descriptions,
  repositories,
  entities,
  places,
  descriptionEntities,
  descriptionPlaces,
  exportRuns,
  vocabularyTerms,
} from "../../db/schema";
import type { ExportStorage } from "./r2-client.server";
import type { ExportDescription } from "./types";
import { formatDescription } from "./descriptions.server";
import { formatRepositories } from "./repositories.server";
import { formatEntity } from "./entities.server";
import { formatPlace } from "./places.server";
import { generateChildrenMap } from "./children.server";

const CHILDREN_PUT_BATCH = 50;

/**
 * Export descriptions for a single fonds: query, format, upload one per-fonds
 * R2 object, return its record count and serialized byte size.
 *
 * Memory bound: one fonds at a time.
 */
export async function exportFondsDescriptions(
  db: DrizzleD1Database<any>,
  storage: ExportStorage,
  fondsCode: string
): Promise<{ recordCount: number; byteSize: number }> {
  const root = await db
    .select({ id: descriptions.id })
    .from(descriptions)
    .where(eq(descriptions.referenceCode, fondsCode))
    .get();

  if (!root) {
    await storage.putObject(`descriptions-${fondsCode}.json`, "[]");
    return { recordCount: 0, byteSize: 2 };
  }

  const fondsRows = await db
    .select()
    .from(descriptions)
    .where(
      and(
        eq(descriptions.rootDescriptionId, root.id),
        eq(descriptions.isPublished, true)
      )
    )
    .all();

  // Build per-fonds parent/child lookups so formatDescription can resolve
  // parent_reference_code and children_level without leaking out of the fonds.
  const byId = new Map(fondsRows.map((r) => [r.id, r]));
  const childRefsByParent = new Map<string, string[]>();
  for (const row of fondsRows) {
    if (row.parentId) {
      const refs = childRefsByParent.get(row.parentId);
      if (refs) refs.push(row.referenceCode);
      else childRefsByParent.set(row.parentId, [row.referenceCode]);
    }
  }

  // Repository cache scoped to this fonds (almost always one repo per fonds).
  const repoCache = new Map<string, { code: string; country: string | null }>();
  const fondsFormatted: ExportDescription[] = [];

  for (const row of fondsRows) {
    let repo = repoCache.get(row.repositoryId);
    if (!repo) {
      const repoRow = await db
        .select({
          code: repositories.code,
          country: repositories.country,
        })
        .from(repositories)
        .where(eq(repositories.id, row.repositoryId))
        .get();
      repo = repoRow ?? { code: "", country: null };
      repoCache.set(row.repositoryId, repo);
    }

    const parentRefCode = row.parentId
      ? byId.get(row.parentId)?.referenceCode ?? null
      : null;
    const childRefs = childRefsByParent.get(row.id) ?? [];

    fondsFormatted.push(
      formatDescription(row, repo, parentRefCode, childRefs)
    );
  }

  const body = JSON.stringify(fondsFormatted);
  await storage.putObject(`descriptions-${fondsCode}.json`, body);

  return { recordCount: fondsFormatted.length, byteSize: body.length };
}

/**
 * Export the children/{ref}.json files for a single fonds.
 *
 * Crucially, R2 PUTs are batched at CHILDREN_PUT_BATCH (50) concurrently.
 * Even the largest fonds has well under 1000 parents per step, so the
 * subrequest budget is comfortably respected. Higher concurrency would
 * give marginal speed at the cost of backpressure safety.
 *
 * Memory bound: one fonds at a time.
 * Subrequest bound: 1 root query + 1 fonds rows query + N child PUTs.
 */
export async function exportFondsChildren(
  db: DrizzleD1Database<any>,
  storage: ExportStorage,
  fondsCode: string
): Promise<{ parentCount: number; putCount: number }> {
  const root = await db
    .select({ id: descriptions.id })
    .from(descriptions)
    .where(eq(descriptions.referenceCode, fondsCode))
    .get();

  if (!root) return { parentCount: 0, putCount: 0 };

  const fondsRows = await db
    .select({
      id: descriptions.id,
      parentId: descriptions.parentId,
      referenceCode: descriptions.referenceCode,
      title: descriptions.title,
      descriptionLevel: descriptions.descriptionLevel,
      dateExpression: descriptions.dateExpression,
      childCount: descriptions.childCount,
      hasDigital: descriptions.hasDigital,
      position: descriptions.position,
    })
    .from(descriptions)
    .where(
      and(
        eq(descriptions.rootDescriptionId, root.id),
        eq(descriptions.isPublished, true)
      )
    )
    .all();

  const childrenMap = generateChildrenMap(fondsRows);
  const entries = Array.from(childrenMap.entries());
  let putCount = 0;

  for (let i = 0; i < entries.length; i += CHILDREN_PUT_BATCH) {
    const slice = entries.slice(i, i + CHILDREN_PUT_BATCH);
    await Promise.all(
      slice.map(([refCode, children]) =>
        storage.putObject(
          `children/${refCode}.json`,
          JSON.stringify(children)
        )
      )
    );
    putCount += slice.length;
  }

  return { parentCount: entries.length, putCount };
}

/**
 * Export repositories.json. Builds repository_count via a lightweight
 * GROUP BY query — does NOT depend on allFormattedDescriptions being in
 * memory. Only the (small) set of root descriptions is fetched in full.
 */
export async function exportRepositories(
  db: DrizzleD1Database<any>,
  storage: ExportStorage
): Promise<{ count: number }> {
  const allRepos = await db
    .select()
    .from(repositories)
    .where(eq(repositories.enabled, true))
    .all();

  // Lightweight count: id + repositoryId + isPublished only.
  const countRows = await db
    .select({
      repositoryId: descriptions.repositoryId,
      n: sql<number>`COUNT(*)`,
    })
    .from(descriptions)
    .where(eq(descriptions.isPublished, true))
    .groupBy(descriptions.repositoryId)
    .all();

  const repoIdToCount = new Map(countRows.map((r) => [r.repositoryId, Number(r.n)]));
  const repoIdToCode = new Map(allRepos.map((r) => [r.id, r.code]));
  const descriptionCountByRepoCode = new Map<string, number>();
  for (const [repoId, n] of repoIdToCount) {
    const code = repoIdToCode.get(repoId);
    if (code) descriptionCountByRepoCode.set(code, n);
  }

  // Root descriptions: small set (one per fonds), safe to format in full.
  const rootRows = await db
    .select()
    .from(descriptions)
    .where(
      and(
        eq(descriptions.isPublished, true),
        isNull(descriptions.parentId)
      )
    )
    .all();

  const formattedRoots: ExportDescription[] = [];
  for (const row of rootRows) {
    const repo = allRepos.find((r) => r.id === row.repositoryId);
    formattedRoots.push(
      formatDescription(
        row,
        { code: repo?.code ?? "", country: repo?.country ?? null },
        null,
        []
      )
    );
  }

  const formatted = formatRepositories(
    allRepos,
    descriptionCountByRepoCode,
    formattedRoots
  );
  await storage.putObject("repositories.json", JSON.stringify(formatted));

  return { count: formatted.length };
}

/**
 * Export entities.json. Includes only entities linked to published
 * descriptions and not merged into another entity.
 *
 * Implementation: a single JOIN query with DISTINCT, instead of the earlier
 * two-query "collect IDs, then inArray" pattern. The old pattern blew past
 * D1's SQL variable limit (~100) once the linked-id set grew to tens of
 * thousands (SQLITE_TOOBIG at 81k IDs during Task 4 verification).
 */
export async function exportEntities(
  db: DrizzleD1Database<any>,
  storage: ExportStorage
): Promise<{ count: number }> {
  const entityRows = await db
    .selectDistinct({
      id: entities.id,
      entityCode: entities.entityCode,
      displayName: entities.displayName,
      sortName: entities.sortName,
      givenName: entities.givenName,
      surname: entities.surname,
      entityType: entities.entityType,
      honorific: entities.honorific,
      primaryFunction: entities.primaryFunction,
      primaryFunctionId: entities.primaryFunctionId,
      nameVariants: entities.nameVariants,
      datesOfExistence: entities.datesOfExistence,
      dateStart: entities.dateStart,
      dateEnd: entities.dateEnd,
      history: entities.history,
      legalStatus: entities.legalStatus,
      functions: entities.functions,
      sources: entities.sources,
      wikidataId: entities.wikidataId,
      viafId: entities.viafId,
      mergedInto: entities.mergedInto,
    })
    .from(entities)
    .innerJoin(
      descriptionEntities,
      eq(descriptionEntities.entityId, entities.id)
    )
    .innerJoin(
      descriptions,
      eq(descriptionEntities.descriptionId, descriptions.id)
    )
    .where(
      and(eq(descriptions.isPublished, true), isNull(entities.mergedInto))
    )
    .all();

  // Resolve vocabulary term canonical names in a separate query to avoid
  // selectDistinct + leftJoin chain incompatibility in D1's Drizzle adapter
  const termIds = [...new Set(entityRows.map((r) => r.primaryFunctionId).filter(Boolean))] as string[];
  const termMap = new Map<string, string>();
  if (termIds.length > 0) {
    const terms = await db
      .select({ id: vocabularyTerms.id, canonical: vocabularyTerms.canonical })
      .from(vocabularyTerms)
      .where(inArray(vocabularyTerms.id, termIds))
      .all();
    for (const t of terms) termMap.set(t.id, t.canonical);
  }

  if (entityRows.length === 0) {
    await storage.putObject("entities.json", "[]");
    return { count: 0 };
  }

  const formatted = entityRows.map((row) =>
    formatEntity({
      ...row,
      primaryFunctionCanonical: row.primaryFunctionId
        ? termMap.get(row.primaryFunctionId) ?? null
        : null,
    })
  );
  await storage.putObject("entities.json", JSON.stringify(formatted));
  return { count: formatted.length };
}

/**
 * Export places.json. Includes only places linked to published descriptions
 * and not merged into another place.
 *
 * Same JOIN-based implementation as exportEntities — see the comment there
 * for the SQLITE_TOOBIG rationale.
 */
export async function exportPlaces(
  db: DrizzleD1Database<any>,
  storage: ExportStorage
): Promise<{ count: number }> {
  const placeRows = await db
    .selectDistinct({
      id: places.id,
      placeCode: places.placeCode,
      label: places.label,
      displayName: places.displayName,
      placeType: places.placeType,
      nameVariants: places.nameVariants,
      latitude: places.latitude,
      longitude: places.longitude,
      coordinatePrecision: places.coordinatePrecision,
      historicalGobernacion: places.historicalGobernacion,
      historicalPartido: places.historicalPartido,
      historicalRegion: places.historicalRegion,
      countryCode: places.countryCode,
      adminLevel1: places.adminLevel1,
      adminLevel2: places.adminLevel2,
      tgnId: places.tgnId,
      hgisId: places.hgisId,
      whgId: places.whgId,
      wikidataId: places.wikidataId,
      mergedInto: places.mergedInto,
    })
    .from(places)
    .innerJoin(
      descriptionPlaces,
      eq(descriptionPlaces.placeId, places.id)
    )
    .innerJoin(
      descriptions,
      eq(descriptionPlaces.descriptionId, descriptions.id)
    )
    .where(
      and(eq(descriptions.isPublished, true), isNull(places.mergedInto))
    )
    .all();

  if (placeRows.length === 0) {
    await storage.putObject("places.json", "[]");
    return { count: 0 };
  }

  const formatted = placeRows.map(formatPlace);
  await storage.putObject("places.json", JSON.stringify(formatted));
  return { count: formatted.length };
}

/**
 * Heartbeat helpers — write the new export_runs columns from migration 0019
 * so the operator can watch a long publish run advance through its steps.
 */
export async function recordStepStart(
  db: DrizzleD1Database<any>,
  exportId: string,
  stepName: string
): Promise<void> {
  const now = Date.now();
  await db
    .update(exportRuns)
    .set({
      currentStep: stepName,
      currentStepStartedAt: now,
      currentStepCompletedAt: null,
      lastHeartbeatAt: now,
    })
    .where(eq(exportRuns.id, exportId));
}

export async function recordStepEnd(
  db: DrizzleD1Database<any>,
  exportId: string,
  stepName: string,
  counts: Record<string, number>
): Promise<void> {
  const now = Date.now();
  await db
    .update(exportRuns)
    .set({
      currentStep: stepName,
      currentStepCompletedAt: now,
      lastHeartbeatAt: now,
      stepsCompleted: sql`${exportRuns.stepsCompleted} + 1`,
      recordCounts: JSON.stringify(counts),
    })
    .where(eq(exportRuns.id, exportId));
}
