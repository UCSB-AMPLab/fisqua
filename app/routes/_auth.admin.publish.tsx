/**
 * Publish Admin Dashboard
 *
 * The superadmin-only page for triggering a new publish run and
 * watching it progress. Loader derives the pre-flight changelog —
 * what would be added, modified, or unpublished for every fonds and
 * every other data type — and an in-flight runs is passed to the
 * progress panel so the page can poll until completion. Recent runs
 * appear in the history table below, each linking into the per-run
 * detail page.
 *
 * @version v0.3.0
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { userContext } from "../context";
import { ChangelogSection } from "../components/publish/changelog-section";
import { ExportControls } from "../components/publish/export-controls";
import { ExportProgress } from "../components/publish/export-progress";
import { ExportHistory } from "../components/publish/export-history";
import type { ChangelogData } from "../components/publish/changelog-section";
import type { Route } from "./+types/_auth.admin.publish";

export interface ExportRunRow {
  id: string;
  status: string;
  triggeredBy: string;
  selectedFonds: string;
  selectedTypes: string;
  currentStep: string | null;
  stepsCompleted: number;
  totalSteps: number;
  recordCounts: string | null;
  errorMessage: string | null;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
}

export async function loader({ context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { sql, desc, eq, and, isNull, gt } = await import("drizzle-orm");
  const { descriptions, repositories, entities, places, exportRuns, users } =
    await import("../db/schema");

  const user = context.get(userContext);

  if (!user.isSuperAdmin) {
    return {
      authorized: false as const,
      fondsList: [] as string[],
      changelog: null,
      activeExport: null,
      history: [],
    };
  }

  const { getFondsList } = await import("../lib/export/fonds-list.server");

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const fondsList = await getFondsList(db);

  // Find the last completed export timestamp
  const lastExport = await db
    .select({ completedAt: exportRuns.completedAt })
    .from(exportRuns)
    .where(eq(exportRuns.status, "complete"))
    .orderBy(desc(exportRuns.completedAt))
    .limit(1)
    .get();

  const lastExportedAt = lastExport?.completedAt ?? null;

  // Description changelog: per-fonds counts using rootDescriptionId join
  // Since lastExportedAt column doesn't exist on descriptions, we use the
  // last export run's completedAt as the reference point.
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

  // Repository/entity/place changelog: count modified since last export
  const repoCount = lastExportedAt
    ? await db
        .select({ count: sql<number>`count(*)` })
        .from(repositories)
        .where(gt(repositories.updatedAt, lastExportedAt))
        .get()
    : await db
        .select({ count: sql<number>`count(*)` })
        .from(repositories)
        .get();

  const entityCount = lastExportedAt
    ? await db
        .select({ count: sql<number>`count(*)` })
        .from(entities)
        .where(gt(entities.updatedAt, lastExportedAt))
        .get()
    : await db
        .select({ count: sql<number>`count(*)` })
        .from(entities)
        .get();

  const placeCount = lastExportedAt
    ? await db
        .select({ count: sql<number>`count(*)` })
        .from(places)
        .where(gt(places.updatedAt, lastExportedAt))
        .get()
    : await db
        .select({ count: sql<number>`count(*)` })
        .from(places)
        .get();

  const changelog: ChangelogData = {
    descriptions: descriptionChangelog,
    repositories: { modified: Number(repoCount?.count ?? 0) },
    entities: { modified: Number(entityCount?.count ?? 0) },
    places: { modified: Number(placeCount?.count ?? 0) },
  };

  // Active export (running or pending)
  const activeExport = await db
    .select()
    .from(exportRuns)
    .where(
      sql`${exportRuns.status} IN ('running', 'pending')`
    )
    .orderBy(desc(exportRuns.createdAt))
    .limit(1)
    .get();

  // Export history: 20 most recent
  const historyRows = await db
    .select({
      id: exportRuns.id,
      status: exportRuns.status,
      triggeredBy: users.email,
      selectedFonds: exportRuns.selectedFonds,
      selectedTypes: exportRuns.selectedTypes,
      currentStep: exportRuns.currentStep,
      stepsCompleted: exportRuns.stepsCompleted,
      totalSteps: exportRuns.totalSteps,
      recordCounts: exportRuns.recordCounts,
      errorMessage: exportRuns.errorMessage,
      startedAt: exportRuns.startedAt,
      completedAt: exportRuns.completedAt,
      createdAt: exportRuns.createdAt,
    })
    .from(exportRuns)
    .leftJoin(users, eq(exportRuns.triggeredBy, users.id))
    .orderBy(desc(exportRuns.createdAt))
    .limit(20)
    .all();

  return {
    authorized: true as const,
    fondsList,
    changelog,
    activeExport: activeExport
      ? { id: activeExport.id, status: activeExport.status }
      : null,
    history: historyRows,
  };
}

export default function PublishPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("publish");
  const { authorized, fondsList, changelog, activeExport, history } = loaderData;

  const [activeExportId, setActiveExportId] = useState<string | null>(
    activeExport?.id ?? null
  );
  const [isExporting, setIsExporting] = useState(false);

  // Rough total: sum of all per-fonds description added/modified, plus the
  // repo/entity/place modified counts. Used to estimate the publish duration
  // in the warning modal.
  const totalRecordCount =
    (changelog?.descriptions.reduce(
      (sum, f) => sum + f.added + f.modified,
      0
    ) ?? 0) +
    (changelog?.repositories.modified ?? 0) +
    (changelog?.entities.modified ?? 0) +
    (changelog?.places.modified ?? 0);

  if (!authorized) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
        <p className="font-sans text-sm text-amber-800">
          {t("superadminRequired")}
        </p>
      </div>
    );
  }

  async function handleExport(
    selectedFonds: string[],
    selectedTypes: string[]
  ) {
    setIsExporting(true);
    try {
      const response = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedFonds, selectedTypes }),
      });
      if (response.ok) {
        const data = (await response.json()) as { exportId: string };
        setActiveExportId(data.exportId);
      }
    } finally {
      setIsExporting(false);
    }
  }

  // Lazy-load sub-components to avoid circular imports
  // They will be created in Task 2
  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-4xl font-semibold text-[#44403C]">
          {t("title")}
        </h1>
        <p className="mt-2 font-sans text-sm text-stone-500">
          {t("subtitle")}
        </p>
      </div>

      {changelog && <ChangelogSection changelog={changelog} />}

      <ExportControls
        fondsList={fondsList}
        disabled={isExporting || !!activeExportId}
        totalRecordCount={totalRecordCount}
        onExport={handleExport}
      />

      {activeExportId && <ExportProgress exportId={activeExportId} />}

      <ExportHistory history={history} />
    </div>
  );
}
