/**
 * Publish Trigger API
 *
 * Superadmin-only POST endpoint that starts a new publish run. The
 * payload is validated against a dynamic schema that only accepts
 * fonds the database actually knows about, then a fresh row is
 * inserted into `export_runs` and the `PublishExportWorkflow` is
 * instantiated with that row id. The response carries the new run id
 * so the dashboard can navigate into the progress panel.
 *
 * @version v0.3.0
 */

import { z } from "zod";
import { userContext } from "../context";
import { requireSuperAdmin } from "../lib/superadmin.server";
import { getFondsList } from "../lib/export/fonds-list.server";
import type { Route } from "./+types/api.publish";

const VALID_TYPES = ["descriptions", "repositories", "entities", "places"] as const;

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
  requireSuperAdmin(user);

  const { drizzle } = await import("drizzle-orm/d1");
  const { exportRuns } = await import("../db/schema");

  const db = drizzle(context.cloudflare.env.DB);

  // Build dynamic validation schema from DB-derived fonds list
  const fondsList = await getFondsList(db);
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

  // Compute total steps — counts only heartbeat-emitting steps (the ones
  // that advance stepsCompleted via recordStepEnd in PublishExportWorkflow):
  // - if 'descriptions' in selectedTypes:
  //   - N per-fonds descriptions:{fonds} steps
  //   - 1 descriptions:index step
  //   - N per-fonds children:{fonds} steps
  // - 1 each for repositories, entities, places if in selectedTypes
  // The workflow's load-config and finalize steps intentionally do not emit
  // heartbeats, so they are excluded from this total.
  const hasDescriptions = selectedTypes.includes("descriptions");
  const nonDescTypes = selectedTypes.filter((t) => t !== "descriptions");
  const totalSteps =
    (hasDescriptions ? selectedFonds.length * 2 + 1 : 0) + nonDescTypes.length;

  const exportId = crypto.randomUUID();
  const now = Date.now();

  await db.insert(exportRuns).values({
    id: exportId,
    triggeredBy: user.id,
    status: "pending",
    selectedFonds: JSON.stringify(selectedFonds),
    selectedTypes: JSON.stringify(selectedTypes),
    stepsCompleted: 0,
    totalSteps,
    createdAt: now,
  });

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
 * - Without exportId: returns 20 most recent runs
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  requireSuperAdmin(user);

  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, desc } = await import("drizzle-orm");
  const { exportRuns } = await import("../db/schema");

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
      .where(eq(exportRuns.id, exportId))
      .get();

    if (!run) {
      return Response.json({ error: "Export run not found" }, { status: 404 });
    }

    return Response.json(run);
  }

  // Return 20 most recent export runs
  const runs = await db
    .select()
    .from(exportRuns)
    .orderBy(desc(exportRuns.createdAt))
    .limit(20)
    .all();

  return Response.json(runs);
}
