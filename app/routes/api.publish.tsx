/**
 * Publish Trigger API
 *
 * Both handlers refuse a tenant without the `publish_pipeline`
 * capability with a bare 404, as the publish page and its counts route
 * do, after the superadmin check and before anything is read or written.
 *
 * This API endpoint is the superadmin-only POST that starts a new
 * publish run. The payload is validated against a dynamic schema that
 * only accepts
 * fonds the database actually knows about, then, unless another
 * publish of the tenant is in flight, a fresh row is inserted into
 * `export_runs` and the `PublishExportWorkflow` is
 * instantiated with that row id. The response carries the new run id
 * so the dashboard can navigate into the progress panel.
 *
 * The dynamic fonds list is tenant-scoped via
 * `getFondsList(db, tenant)` so a Tenant A superadmin cannot smuggle
 * a Tenant B fonds reference through the validator. The run row
 * records the request tenant (`export_runs.tenant_id`, migration 0115),
 * which comes from the auth middleware that resolved the request host;
 * the workflow's `load-config`, the in-flight check and the polling
 * below all scope on it, never on the triggering user's stored
 * workspace, which for a platform admin is another workspace.
 *
 * The run's `total_steps` counts what the workflow will mark complete
 * (the length of the plan in `publish-steps.ts`): four steps per fonds and the index when
 * descriptions are selected, one per other type, and one more each for
 * the link files that entities and places bring with them. Entities,
 * places and their link files count only when the tenant has the
 * authorities capability, as the workflow runs them only then.
 *
 * Polling one run returns its selected fonds and data types with the
 * heartbeat columns, from which the progress panel lists the run's
 * whole step plan, and its step log (`step_log`), from which it shows
 * each completed step's duration. The step log is returned only there,
 * for a run of the request tenant, never in the list of recent runs.
 *
 * A tenant has at most one publish in flight. Two publishes of one
 * tenant write the same R2 keys, so the action refuses with 409 while
 * another run of the tenant is pending or running and has written a
 * heartbeat within `PUBLISH_STALE_AFTER_MS`. The check and the insert
 * of the new row are a single conditional INSERT, so concurrent
 * requests cannot both pass it. A run silent for longer than the
 * window does not block; it is presumed dead.
 *
 * The request's schema, the conditional insert and its values, the
 * workflow's parameters and the message a failed create closes the run
 * with are in `app/lib/export/publish-run.ts`, which the command line's
 * `publish start` (`scripts/lib/publish-cli/`) uses too, so a run
 * started from either is the same run.
 *
 * A request may carry `force: true`. The action passes it to the
 * workflow in its parameters, and the run then writes every per-fonds
 * file whatever the fingerprint recorded for it
 * (`app/lib/export/fingerprint.server.ts`); without it, a per-fonds step
 * whose fonds has not changed since it last succeeded writes nothing.
 *
 * @version v0.9.0
 */

import { tenantContext, userContext } from "../context";
import { requireSuperAdmin } from "../lib/superadmin.server";
import { requireCapability } from "../lib/tenant";
import { getScopedFondsList } from "../lib/export/fonds-list.server";
import { resolveExportScope } from "../lib/export/federation-scope.server";
import { countPublishSteps } from "../lib/export/publish-steps";
import {
  INSERT_PUBLISH_RUN_SQL,
  insertPublishRunBinds,
  PUBLISH_IN_PROGRESS_MESSAGE,
  PUBLISH_STALE_AFTER_MS,
  publishRequestSchema,
  publishWorkflowParams,
  workflowCreateFailedMessage,
} from "../lib/export/publish-run";
import type { Route } from "./+types/api.publish";

// The stale window, defined with the insert in `publish-run.ts`.
export { PUBLISH_STALE_AFTER_MS };

/**
 * POST /api/publish — Trigger a new export run.
 * Superadmin only. Inserts an exportRuns row and triggers the
 * PublishExportWorkflow which runs each pipeline step in its own
 * Worker invocation with a fresh runtime budget.
 */
export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  requireSuperAdmin(user);
  requireCapability(tenant, "publish_pipeline");

  const { drizzle } = await import("drizzle-orm/d1");

  const db = drizzle(context.cloudflare.env.DB);

  // Build dynamic validation schema from DB-derived fonds list,
  // scoped to the calling tenant so a Tenant A superadmin cannot
  // smuggle a Tenant B fonds reference past the validator.
  //
  // `tenant.descriptiveStandard` being null is a schema-invariant
  // violation (the CHECK in drizzle/0034_tenants_table.sql forbids
  // it when `kind = 'tenant'`). The workflow's load-config correctly
  // throws on this case; the route fails just as loudly rather than
  // silently masking a corrupted tenant row by defaulting to ISAD(G)
  // shape (which would route DACS or RAD tenants to the wrong EAD
  // profile if a future refactor reads this from the same `tenant`
  // object).
  if (!tenant.descriptiveStandard) {
    throw new Error(
      `Tenant ${tenant.slug} has no descriptive_standard (kind=platform tenants cannot publish)`
    );
  }
  // Resolve the export scope (federation spec §9 step 8). When this
  // route runs on the federation LEAD host the scope aggregates every
  // member tenant, so the validator accepts fonds from ANY member (the
  // lead publishes all members); a non-lead tenant sees only its own.
  // The same resolution the workflow uses — so a fonds that validates
  // here is one the workflow can read.
  const scope = await resolveExportScope(db, {
    id: tenant.id,
    federationId: tenant.federationId,
    slug: tenant.slug,
    descriptiveStandard: tenant.descriptiveStandard,
  });
  const fondsList = await getScopedFondsList(db, scope.memberTenantIds);
  const PublishRequestSchema = publishRequestSchema(fondsList);

  // Parse and validate request body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = PublishRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { selectedFonds, selectedTypes, force } = parsed.data;

  // Count only the steps the workflow marks complete. Entities, places
  // and their link files are left out when the tenant lacks the
  // authorities capability, as the workflow skips them on the same flag.
  const totalSteps = countPublishSteps({
    selectedFonds,
    selectedTypes,
    authoritiesEnabled: scope.authoritiesEnabled,
  });

  const exportId = crypto.randomUUID();
  const now = Date.now();

  // Insert the run only when no other publish of this tenant is in
  // flight. The check and the insert are one statement, so two requests
  // that arrive together cannot both pass the check: D1 runs each
  // statement atomically, and the second one sees the first one's row.
  // The run records the request tenant, and the check reads the runs
  // of that tenant, as the loader below and the workflow's load-config
  // do. A federation publish runs on the lead host and writes under the
  // lead's slug, so the lead tenant is the one checked.
  // The statement and its values are shared with the command line's
  // `publish start` (`app/lib/export/publish-run.ts`).
  const inserted = await context.cloudflare.env.DB.prepare(INSERT_PUBLISH_RUN_SQL)
    .bind(
      ...insertPublishRunBinds({
        exportId,
        triggeredBy: user.id,
        tenantId: tenant.id,
        selectedFonds,
        selectedTypes,
        federationId: scope.federationId,
        totalSteps,
        now,
      })
    )
    .run();

  if (inserted.meta.changes === 0) {
    return Response.json(
      { error: PUBLISH_IN_PROGRESS_MESSAGE },
      { status: 409 }
    );
  }

  // Trigger the publish-export workflow. Each step runs in its own Worker
  // invocation, so the 212k-record dataset no longer needs to fit inside one
  // waitUntil budget. The workflow id is the export id, so the existing
  // GET /api/publish?exportId=... polling continues to work without changes.
  //
  // Defer the .create() call via ctx.waitUntil so this handler returns the
  // 202 immediately. In wrangler dev local, awaiting .create() can block the
  // response until the whole workflow finishes — which makes the dashboard
  // look frozen on "Processing…" until the run is already done.
  context.cloudflare.ctx.waitUntil(
    context.cloudflare.env.PUBLISH_EXPORT.create({
      id: exportId,
      params: publishWorkflowParams(exportId, force),
    })
      .then(() => undefined)
      .catch(async (err) => {
        const { exportRuns: runs } = await import("../db/schema");
        const { eq } = await import("drizzle-orm");
        await db
          .update(runs)
          .set({
            status: "error",
            errorMessage: workflowCreateFailedMessage(err),
            completedAt: Date.now(),
          })
          .where(eq(runs.id, exportId));
      })
  );

  return Response.json({ exportId }, { status: 202 });
}

/**
 * GET /api/publish — Poll export progress or list recent runs.
 * Superadmin only.
 * - With ?exportId=X: returns single run progress
 * - Without exportId: returns 20 most recent runs (this tenant only)
 *
 * Both branches must be tenant-scoped: an unscoped query against the
 * global `exportRuns` table would let a Tenant A superadmin read any
 * Tenant B run by id, and the list branch would return the 20 most
 * recent runs platform-wide. Both filter on `export_runs.tenant_id`,
 * the tenant the run was started in, against the route's
 * `tenantContext`, as the workflow's `load-config` reads it.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  requireSuperAdmin(user);
  requireCapability(tenant, "publish_pipeline");

  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, desc } = await import("drizzle-orm");
  const { exportRuns } = await import("../db/schema");

  const db = drizzle(context.cloudflare.env.DB);
  const url = new URL(request.url);
  const exportId = url.searchParams.get("exportId");

  if (exportId) {
    const run = await db
      .select({
        id: exportRuns.id,
        status: exportRuns.status,
        // The run's selection, from which the progress panel lists
        // every step of the plan before the first one starts.
        selectedFonds: exportRuns.selectedFonds,
        selectedTypes: exportRuns.selectedTypes,
        currentStep: exportRuns.currentStep,
        stepsCompleted: exportRuns.stepsCompleted,
        totalSteps: exportRuns.totalSteps,
        recordCounts: exportRuns.recordCounts,
        // Each plan step's start and end (migration 0117), for the
        // panel's durations; the run is this tenant's, as below.
        stepLog: exportRuns.stepLog,
        errorMessage: exportRuns.errorMessage,
        startedAt: exportRuns.startedAt,
        completedAt: exportRuns.completedAt,
        currentStepStartedAt: exportRuns.currentStepStartedAt,
        currentStepCompletedAt: exportRuns.currentStepCompletedAt,
        lastHeartbeatAt: exportRuns.lastHeartbeatAt,
      })
      .from(exportRuns)
      .where(and(eq(exportRuns.id, exportId), eq(exportRuns.tenantId, tenant.id)))
      .get();

    if (!run) {
      return Response.json({ error: "Export run not found" }, { status: 404 });
    }

    return Response.json(run);
  }

  // Return 20 most recent export runs scoped to this tenant, with an
  // explicit column projection.
  const runs = await db
    .select({
      id: exportRuns.id,
      triggeredBy: exportRuns.triggeredBy,
      status: exportRuns.status,
      selectedFonds: exportRuns.selectedFonds,
      selectedTypes: exportRuns.selectedTypes,
      currentStep: exportRuns.currentStep,
      stepsCompleted: exportRuns.stepsCompleted,
      totalSteps: exportRuns.totalSteps,
      recordCounts: exportRuns.recordCounts,
      workflowInstanceId: exportRuns.workflowInstanceId,
      currentStepStartedAt: exportRuns.currentStepStartedAt,
      currentStepCompletedAt: exportRuns.currentStepCompletedAt,
      lastHeartbeatAt: exportRuns.lastHeartbeatAt,
      errorMessage: exportRuns.errorMessage,
      startedAt: exportRuns.startedAt,
      completedAt: exportRuns.completedAt,
      createdAt: exportRuns.createdAt,
    })
    .from(exportRuns)
    .where(eq(exportRuns.tenantId, tenant.id))
    .orderBy(desc(exportRuns.createdAt))
    .limit(20)
    .all();

  return Response.json(runs);
}

// @version v0.9.0
