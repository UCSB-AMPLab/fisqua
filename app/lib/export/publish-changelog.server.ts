/**
 * Publish Pre-flight Counts
 *
 * This module computes what a publish run would change, for the
 * publish page's changelog: per-fonds counts of added, modified and
 * unpublished descriptions, and the number of repositories, entities
 * and places modified since the last completed export. On the
 * federation lead these counts span every member tenant and take
 * several seconds (the distinct linked entities alone took 8 s on
 * production), so the publish page renders without them and fetches
 * them from the `/admin/publish/counts` resource route, which calls
 * `getPublishChangelog` once its own gates have passed.
 *
 * The caller resolves the export scope (`resolveExportScope`, federation
 * spec §9 step 8) and passes its `memberTenantIds`; every count here
 * filters by that set. The reference point is the last completed export
 * of the publishing tenant itself (`publishTenantId`), read from the
 * run's own `tenant_id` (migration 0115). A member that publishes on
 * its own never moves the lead's reference point, so the lead's
 * unpublished changes stay counted.
 * With no completed export every published record counts as added and
 * modified.
 *
 * The authority counts mirror the export read (`exportEntities` /
 * `exportPlaces` in `pipeline.server.ts`): the federation authorities
 * referenced by the scope's published descriptions, through the
 * junction tables, counted DISTINCT because an authority linked from
 * several descriptions exports once, and excluding merged records.
 * They are zero when the tenant has the authorities capability off,
 * because the workflow skips those steps.
 *
 * @version v0.9.0
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";
import { sql, desc, eq, and, isNull, gt, inArray } from "drizzle-orm";
import {
  descriptions,
  repositories,
  entities,
  places,
  descriptionEntities,
  descriptionPlaces,
  exportRuns,
} from "../../db/schema";
import { authorityScope } from "../authority-ownership.server";
import type { ChangelogData } from "../../components/publish/changelog-section";

export interface PublishChangelogScope {
  /** The tenant publishing, the request tenant: its own runs are the reference point. */
  publishTenantId: string;
  /** The export scope's member tenants (`resolveExportScope`). */
  memberTenantIds: string[];
  /** The publishing tenant's federation, which owns the authorities. */
  federationId: string;
  /** The publishing tenant's `authorities` capability. */
  authoritiesEnabled: boolean;
}

export async function getPublishChangelog(
  db: DrizzleD1Database<any>,
  { publishTenantId, memberTenantIds, federationId, authoritiesEnabled }: PublishChangelogScope,
): Promise<ChangelogData> {
  const lastExport = await db
    .select({ completedAt: exportRuns.completedAt })
    .from(exportRuns)
    .where(
      and(
        eq(exportRuns.status, "complete"),
        eq(exportRuns.tenantId, publishTenantId)
      )
    )
    .orderBy(desc(exportRuns.completedAt))
    .limit(1)
    .get();

  const lastExportedAt = lastExport?.completedAt ?? null;

  // Per-fonds counts through `root_description_id`. Descriptions carry
  // no per-record export timestamp, so the last run's `completedAt` is
  // the reference point.
  const fondsChanges = await db.all(sql`
    SELECT
      root.reference_code AS fonds,
      root.title AS fonds_label,
      SUM(CASE
        WHEN d.is_published = 1 AND ${lastExportedAt ? sql`d.updated_at > ${lastExportedAt}` : sql`1 = 1`}
        THEN 1 ELSE 0
      END) AS modified,
      SUM(CASE
        WHEN d.is_published = 1 AND ${lastExportedAt ? sql`d.created_at > ${lastExportedAt}` : sql`1 = 1`}
        THEN 1 ELSE 0
      END) AS added,
      SUM(CASE
        WHEN d.is_published = 0 AND ${lastExportedAt ? sql`d.updated_at > ${lastExportedAt}` : sql`0 = 0`}
        THEN 1 ELSE 0
      END) AS unpublished
    FROM ${descriptions} d
    JOIN ${descriptions} root ON d.root_description_id = root.id
    WHERE root.parent_id IS NULL
      AND d.tenant_id IN (${sql.join(memberTenantIds.map((id) => sql`${id}`), sql`, `)})
      AND root.tenant_id IN (${sql.join(memberTenantIds.map((id) => sql`${id}`), sql`, `)})
    GROUP BY root.reference_code, root.title
    ORDER BY root.reference_code
  `);

  const descriptionChangelog = (fondsChanges as Array<{
    fonds: string;
    fonds_label: string;
    added: number;
    modified: number;
    unpublished: number;
  }>).map((row) => ({
    fonds: row.fonds,
    fondsLabel: row.fonds_label,
    added: Number(row.added),
    modified: Number(row.modified),
    unpublished: Number(row.unpublished),
  }));

  const repoCount = lastExportedAt
    ? await db
        .select({ count: sql<number>`count(*)` })
        .from(repositories)
        .where(
          and(
            inArray(repositories.tenantId, memberTenantIds),
            gt(repositories.updatedAt, lastExportedAt)
          )
        )
        .get()
    : await db
        .select({ count: sql<number>`count(*)` })
        .from(repositories)
        .where(inArray(repositories.tenantId, memberTenantIds))
        .get();

  let entityCount: { count: number } | undefined;
  let placeCount: { count: number } | undefined;
  if (authoritiesEnabled) {
    const entityCountConditions = [
      authorityScope(entities, federationId, memberTenantIds),
      inArray(descriptions.tenantId, memberTenantIds),
      eq(descriptions.isPublished, true),
      isNull(entities.mergedInto),
    ];
    if (lastExportedAt) {
      entityCountConditions.push(gt(entities.updatedAt, lastExportedAt));
    }
    entityCount = await db
      .select({ count: sql<number>`count(DISTINCT ${entities.id})` })
      .from(entities)
      .innerJoin(
        descriptionEntities,
        eq(descriptionEntities.entityId, entities.id)
      )
      .innerJoin(
        descriptions,
        eq(descriptionEntities.descriptionId, descriptions.id)
      )
      .where(and(...entityCountConditions))
      .get();

    const placeCountConditions = [
      authorityScope(places, federationId, memberTenantIds),
      inArray(descriptions.tenantId, memberTenantIds),
      eq(descriptions.isPublished, true),
      isNull(places.mergedInto),
    ];
    if (lastExportedAt) {
      placeCountConditions.push(gt(places.updatedAt, lastExportedAt));
    }
    placeCount = await db
      .select({ count: sql<number>`count(DISTINCT ${places.id})` })
      .from(places)
      .innerJoin(descriptionPlaces, eq(descriptionPlaces.placeId, places.id))
      .innerJoin(
        descriptions,
        eq(descriptionPlaces.descriptionId, descriptions.id)
      )
      .where(and(...placeCountConditions))
      .get();
  }

  return {
    descriptions: descriptionChangelog,
    repositories: { modified: Number(repoCount?.count ?? 0) },
    entities: { modified: Number(entityCount?.count ?? 0) },
    places: { modified: Number(placeCount?.count ?? 0) },
  };
}

// @version v0.9.0
