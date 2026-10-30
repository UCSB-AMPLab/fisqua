/**
 * Publish Trigger API
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
 * a Tenant B fonds reference through the validator. The workflow
 * itself resolves the tenant from
 * `exportRuns.triggeredBy → users.tenantId` inside `load-config`;
 * this route's tenant context comes from the auth middleware that
 * resolved the request host.
 *
 * The run's `total_steps` counts what the workflow will mark complete
 * (see `publish-steps.ts`): five steps per fonds and the index when
 * descriptions are selected, one per other type, and one more each for
 * the link files that entities and places bring with them. Entities,
 * places and their link files count only when the tenant has the
 * authorities capability, as the workflow runs them only then.
 *
 * A tenant has at most one publish in flight. Two publishes of one
 * tenant write the same R2 keys, so the action refuses with 409 while
 * another run of the tenant is pending or running and has written a
 * heartbeat within `PUBLISH_STALE_AFTER_MS`. The check and the insert
 * of the new row are a single conditional INSERT, so concurrent
 * requests cannot both pass it. A run silent for longer than the
 * window no longer blocks; it is presumed dead.
 *
 * @version v0.8.0
 */

import { z } from "zod";
import { tenantContext, userContext } from "../context";
import { requireSuperAdmin } from "../lib/superadmin.server";
import { getScopedFondsList } from "../lib/export/fonds-list.server";
import { resolveExportScope } from "../lib/export/federation-scope.server";
import { countPublishSteps } from "../lib/export/publish-steps";
import type { Route } from "./+types/api.publish";

const VALID_TYPES = ["descriptions", "repositories", "entities", "places"] as const;

/**
 * How long an unfinished run blocks a new publish of the same tenant,
 * counted from its last heartbeat (or its start, or its creation, when
 * it has not yet written one). The workflow sets no step timeouts of
 * its own, and every step writes a heartbeat, so a pending or running
 * row that has been silent this long is presumed dead: a run killed
 * without reaching its error handler would otherwise block publishing
 * for good.
 */
export const PUBLISH_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

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
  const PublishRequestSchema = z.object({
    selectedFonds: z
      .array(
        z.string().refine((val) => fondsList.includes(val), {
          message: "Invalid fonds code",
        })
      )
      .nonempty("selectedFonds must contain at least one fonds code"),
    selectedTypes: z
      .array(z.enum(VALID_TYPES))
      .nonempty("selectedTypes must contain at least one type"),
  });

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

  const { selectedFonds, selectedTypes } = parsed.data;

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
  // export_runs has no tenant column, so the tenant comes from the
  // triggering user, as in the loader below and the workflow's
  // load-config. A federation publish runs on the lead host and writes
  // under the lead's slug, so the lead tenant is the one checked.
  const inserted = await context.cloudflare.env.DB.prepare(
    `INSERT INTO export_runs (
       id, triggered_by, status, selected_fonds, selected_types,
       federation_id, steps_completed, total_steps, created_at
     )
     SELECT ?1, ?2, 'pending', ?3, ?4, ?5, 0, ?6, ?7
     WHERE NOT EXISTS (
       SELECT 1 FROM export_runs r
       INNER JOIN users u ON u.id = r.triggered_by
       WHERE u.tenant_id = ?8
         AND r.status IN ('pending', 'running')
         AND COALESCE(r.last_heartbeat_at, r.started_at, r.created_at) > ?9
     )`
  )
    .bind(
      exportId,
      user.id,
      JSON.stringify(selectedFonds),
      JSON.stringify(selectedTypes),
      // Federation this run publishes (migration 0055). Recorded at
      // insert so the run history is federation-attributed even before
      // the workflow's load-config runs.
      scope.federationId ?? null,
      totalSteps,
      now,
      tenant.id,
      now - PUBLISH_STALE_AFTER_MS
    )
    .run();

  if (inserted.meta.changes === 0) {
    return Response.json(
      {
        error:
          "Another publish for this tenant is still in progress. Wait for it to finish before starting a new one.",
      },
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
      params: { exportId },
    })
      .then(() => undefined)
      .catch(async (err) => {
        const { exportRuns: runs } = await import("../db/schema");
        const { eq } = await import("drizzle-orm");
        const message =
          err instanceof Error ? err.message : "failed to create workflow";
        await db
          .update(runs)
          .set({
            status: "error",
            errorMessage: `workflow create failed: ${message}`,
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
 * recent runs platform-wide. `exportRuns` carries no `tenantId`
 * column (the schema add was deliberately deferred to v0.5+), so
 * tenant scoping is enforced by joining `exportRuns.triggeredBy →
 * users.tenantId` and filtering by the route's `tenantContext`. This
 * mirrors the workflow's `load-config` pattern.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  requireSuperAdmin(user);

  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, desc } = await import("drizzle-orm");
  const { exportRuns, users } = await import("../db/schema");

  const db = drizzle(context.cloudflare.env.DB);
  const url = new URL(request.url);
  const exportId = url.searchParams.get("exportId");

  if (exportId) {
    const run = await db
      .select({
        id: exportRuns.id,
        status: exportRuns.status,
        currentStep: exportRuns.currentStep,
        stepsCompleted: exportRuns.stepsCompleted,
        totalSteps: exportRuns.totalSteps,
        recordCounts: exportRuns.recordCounts,
        errorMessage: exportRuns.errorMessage,
        startedAt: exportRuns.startedAt,
        completedAt: exportRuns.completedAt,
        currentStepStartedAt: exportRuns.currentStepStartedAt,
        currentStepCompletedAt: exportRuns.currentStepCompletedAt,
        lastHeartbeatAt: exportRuns.lastHeartbeatAt,
      })
      .from(exportRuns)
      .innerJoin(users, eq(exportRuns.triggeredBy, users.id))
      .where(and(eq(exportRuns.id, exportId), eq(users.tenantId, tenant.id)))
      .get();

    if (!run) {
      return Response.json({ error: "Export run not found" }, { status: 404 });
    }

    return Response.json(run);
  }

  // Return 20 most recent export runs scoped to this tenant. The
  // explicit column projection avoids `users.*` leaking into the
  // response body.
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
    .innerJoin(users, eq(exportRuns.triggeredBy, users.id))
    .where(eq(users.tenantId, tenant.id))
    .orderBy(desc(exportRuns.createdAt))
    .limit(20)
    .all();

  return Response.json(runs);
}
