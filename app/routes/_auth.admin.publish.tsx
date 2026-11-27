/**
 * Publish Admin Dashboard
 *
 * This page is the superadmin-only surface for triggering a new
 * publish run and watching it progress. The loader returns what is
 * cheap to read: the fonds list for the controls, the in-flight run
 * (passed to the progress panel so the page can poll until
 * completion) and the recent runs for the history table, each linking
 * into the per-run detail page. It sits in the sidebar's Import and
 * export group, beside Exports.
 *
 * The pre-flight changelog — what would be added, modified or
 * unpublished for every fonds and every other data type — is not in
 * the loader. On the federation lead its counts take several seconds,
 * so the page renders without them and fetches them after mount from
 * `/admin/publish/counts` (`_auth.admin.publish.counts.tsx`, which
 * calls `getPublishChangelog`). Meanwhile the changelog's place holds
 * an indeterminate progress notice, and a retry notice if the counts
 * fail. The publish controls work throughout; the confirm dialog
 * leaves out its time estimate until the counts are there.
 *
 * Tenant attribution comes from request context, populated by
 * `authMiddleware`. `resolveExportScope` then expands it to the export
 * SCOPE (federation spec §9 step 8): on the federation LEAD host the
 * scope is every member tenant (the lead publishes all members), so the
 * dropdown and the changelog's counts span the federation; a non-lead
 * tenant sees only its own. A publish run belongs to the tenant it ran
 * in, so the active run and the history are this tenant's own runs
 * (`export_runs.tenant_id = tenant.id`), as polling and the run detail
 * page read them; the counts route resolves the same scope and takes
 * its reference point from this tenant's runs alone.
 *
 * Capability gate runs before everything else. The loader calls
 * `requireCapability(tenant, "publish_pipeline")` as the first
 * data-access action, throwing a bare `Response(null, {status: 404})`
 * when the tenant has the `publish_pipeline` flag off. The gate
 * precedes the superadmin-only check so a tenant on a publish-off
 * configuration 404s for everyone, never falling through to the
 * "superadmin required" page.
 *
 * @version v0.9.0
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { ChangelogSection } from "../components/publish/changelog-section";
import { ExportControls } from "../components/publish/export-controls";
import { ExportProgress } from "../components/publish/export-progress";
import { ExportHistory } from "../components/publish/export-history";
import {
  CountsFailed,
  CountsLoading,
  usePublishCounts,
} from "../components/publish/counts-status";
import type { Route } from "./+types/_auth.admin.publish";
import { pageMeta, heading } from "../lib/page-title";

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

export function meta(args: Route.MetaArgs) {
  return pageMeta(
    args,
    heading("publish:title"),
  );
}

export async function loader({ context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { sql, desc, eq, and } = await import("drizzle-orm");
  const { exportRuns, users } = await import("../db/schema");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "publish_pipeline");

  if (!user.isSuperAdmin) {
    return {
      authorized: false as const,
      fondsList: [] as string[],
      activeExport: null,
      history: [],
    };
  }

  const { getScopedFondsList } = await import("../lib/export/fonds-list.server");
  const { resolveExportScope } = await import(
    "../lib/export/federation-scope.server"
  );

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // `getFondsList` is tenant-scoped so cataloguers on Tenant A never
  // see Tenant B's fonds in the dropdown. The route is already gated
  // to `kind = 'tenant'` via `requireCapability` above, so
  // `descriptiveStandard` is non-null in practice.
  //
  // A nullable `descriptiveStandard` is a schema-invariant violation
  // (the CHECK in drizzle/0034_tenants_table.sql forbids it when
  // `kind = 'tenant'`); the workflow's load-config correctly throws
  // in that case, and we do the same here rather than silently
  // coercing a corrupted tenant row to ISAD(G) shape.
  if (!tenant.descriptiveStandard) {
    throw new Error(
      `Tenant ${tenant.slug} has no descriptive_standard (kind=platform tenants cannot publish)`
    );
  }
  // Resolve the export scope (federation spec §9 step 8). On the
  // federation LEAD host the scope aggregates every member tenant, so
  // the dropdown offers fonds from ALL members (the lead publishes all
  // members); a non-lead tenant sees only its own. `memberTenantIds`
  // drives every scoped query below.
  const scope = await resolveExportScope(db, {
    id: tenant.id,
    federationId: tenant.federationId,
    slug: tenant.slug,
    descriptiveStandard: tenant.descriptiveStandard,
  });
  const memberTenantIds = scope.memberTenantIds;
  const fondsList = await getScopedFondsList(db, memberTenantIds);

  // Active export (running or pending) — scoped to this tenant.
  // A global query would let a Tenant A superadmin landing on
  // /admin/publish while a Tenant B run was in flight see the Tenant
  // B run's id and let the polling ExportProgress panel chain into
  // the (also-leaked) GET /api/publish body. The scope is the run's
  // own `tenant_id`, the tenant it was started in (migration 0115),
  // against this tenant alone, not the export scope's members: polling
  // and the run detail page read only this tenant's runs, so a member's
  // run taken up here would 404 on every poll.
  const activeExport = await db
    .select({
      id: exportRuns.id,
      status: exportRuns.status,
    })
    .from(exportRuns)
    .where(
      and(
        sql`${exportRuns.status} IN ('running', 'pending')`,
        eq(exportRuns.tenantId, tenant.id)
      )
    )
    .orderBy(desc(exportRuns.createdAt))
    .limit(1)
    .get();

  // Export history: 20 most recent — this tenant's own runs, on the
  // run's own `tenant_id`, so every row links to a run detail page this
  // tenant can open. The join on `users` only reads the triggering
  // user's email.
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
    .innerJoin(users, eq(exportRuns.triggeredBy, users.id))
    .where(eq(exportRuns.tenantId, tenant.id))
    .orderBy(desc(exportRuns.createdAt))
    .limit(20)
    .all();

  return {
    authorized: true as const,
    fondsList,
    activeExport: activeExport
      ? { id: activeExport.id, status: activeExport.status }
      : null,
    history: historyRows,
  };
}

export default function PublishPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("publish");
  const { authorized, fondsList, activeExport, history } = loaderData;
  const counts = usePublishCounts("/admin/publish/counts", authorized);
  const changelog =
    counts.state.status === "ready" ? counts.state.changelog : null;

  const [activeExportId, setActiveExportId] = useState<string | null>(
    activeExport?.id ?? null
  );
  const [isExporting, setIsExporting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Rough total: sum of all per-fonds description added/modified, plus the
  // repo/entity/place modified counts. Used to estimate the publish duration
  // in the warning modal; null until the counts are there.
  const totalRecordCount = changelog
    ? changelog.descriptions.reduce((sum, f) => sum + f.added + f.modified, 0) +
      changelog.repositories.modified +
      changelog.entities.modified +
      changelog.places.modified
    : null;

  if (!authorized) {
    return (
      <div className="rounded-lg border border-saffron bg-saffron-tint px-4 py-3">
        <p className="font-sans text-sm text-saffron-deep">
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
    setStartError(null);
    try {
      const response = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedFonds, selectedTypes }),
      });
      if (response.ok) {
        const data = (await response.json()) as { exportId: string };
        setActiveExportId(data.exportId);
      } else {
        setStartError(
          response.status === 409 ? t("publish_in_progress") : t("publish_start_failed")
        );
      }
    } catch {
      setStartError(t("publish_start_failed"));
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-4xl font-semibold text-stone-700">
          {t("title")}
        </h1>
        <p className="mt-2 font-sans text-sm text-stone-500">
          {t("subtitle")}
        </p>
      </div>

      {counts.state.status === "loading" && <CountsLoading />}
      {counts.state.status === "failed" && (
        <CountsFailed onRetry={counts.retry} />
      )}
      {changelog && <ChangelogSection changelog={changelog} />}

      <ExportControls
        fondsList={fondsList}
        disabled={isExporting || !!activeExportId}
        totalRecordCount={totalRecordCount}
        onExport={handleExport}
      />

      {startError && (
        <p role="alert" className="font-sans text-sm text-madder-deep">
          {startError}
        </p>
      )}

      {activeExportId && <ExportProgress exportId={activeExportId} />}

      <ExportHistory history={history} />
    </div>
  );
}
