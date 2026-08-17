/**
 * Resegmentation Flags API
 *
 * This API endpoint is the back-end for the resegmentation-request
 * workflow — the affordance a cataloguer uses to ask a lead to
 * redraw the boundaries of one or more entries in a volume. POST
 * creates a new flag (problem type, affected entries, optional free
 * text description) anchored to a volume; PATCH resolves an open
 * flag once the lead has acted on it; GET lists open flags for a
 * volume so the segmentation viewer can surface them in the
 * outline.
 *
 * Every mutation is gated by `requireEntryAccess` so only members of
 * the project the entry belongs to can raise or resolve a flag, and
 * each transition writes to the activity log so the lead's
 * dashboard reflects the request without a separate write path.
 *
 * PATCH takes only a flag id, which proves nothing about the caller,
 * so it resolves the flag to its entry and runs the same guard the
 * other branches run. This header claimed that gating before the
 * PATCH branch actually did it (fixed in 0.7.0): the guard must be
 * reachable from the identifier the request supplies, not assumed
 * from the identifier the caller happens to have used elsewhere.
 *
 * @version v0.7.0
 */

import { userContext, tenantContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { apiErrorToken } from "../lib/api-error.server";
import { PROJECT_ROLES } from "../lib/validation/enums";
import type { Route } from "./+types/api.resegmentation";

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { requireEntryAccess } = await import("../lib/permissions.server");
  const { createResegmentationFlag, resolveResegmentationFlag } = await import(
    "../lib/resegmentation.server"
  );
  const { logActivity } = await import("../lib/workflow.server");
  const { volumes, resegmentationFlags } = await import("../db/schema");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const db = drizzle(context.cloudflare.env.DB);

  // Crowdsourcing endpoint: 404 where the tenant does not have the
  // module, matching the member routes that call it.
  requireCapability(tenant, "crowdsourcing");

  if (request.method === "POST") {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { volumeId, entryId, problemType, affectedEntryIds, description } =
      body;

    if (!volumeId || !entryId || !problemType || !description) {
      return Response.json(
        {
          error:
            "volumeId, entryId, problemType, and description are required",
        },
        { status: 400 }
      );
    }

    try {
      // Verify entry access
      const { volume } = await requireEntryAccess(
        db,
        tenant.id,
        entryId,
        user.id,
        user.isAdmin
      );

      const result = await createResegmentationFlag(db, {
        volumeId,
        entryId,
        reportedBy: user.id,
        problemType,
        affectedEntryIds: affectedEntryIds ?? "[]",
        description,
      });

      // Log activity
      await logActivity(db, user.id, "resegmentation_flagged", {
        projectId: volume.projectId,
        volumeId,
        detail: JSON.stringify({
          entryId,
          flagId: result.id,
          problemType,
        }),
      });

      return Response.json({ ok: true, flagId: result.id });
    } catch (err) {
      if (err instanceof Response) {
        return Response.json(
          { error: apiErrorToken(err.status) },
          { status: err.status }
        );
      }
            // Server internals never reach the client: the 500 carries the
      // same stable token the catch helper uses for unknown statuses.
      return Response.json({ error: "generic" }, { status: 500 });
    }
  }

  if (request.method === "PATCH") {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { flagId } = body;

    if (!flagId) {
      return Response.json(
        { error: "flagId is required" },
        { status: 400 }
      );
    }

    try {
      // The flag id arrives from the request body, so it proves nothing
      // about who may resolve it. Resolve the flag to its entry first
      // and let requireEntryAccess run the tenant assert and the
      // membership check on the owning project — without this, any
      // authenticated user could resolve any flag in any tenant.
      const [flag] = await db
        .select({ entryId: resegmentationFlags.entryId })
        .from(resegmentationFlags)
        .where(eq(resegmentationFlags.id, flagId))
        .limit(1)
        .all();

      if (!flag) {
        throw new Response("Not Found", { status: 404 });
      }

      await requireEntryAccess(db, tenant.id, flag.entryId, user.id, user.isAdmin);

      await resolveResegmentationFlag(db, flagId, user.id);
      return Response.json({ ok: true });
    } catch (err) {
      if (err instanceof Response) {
        return Response.json(
          { error: apiErrorToken(err.status) },
          { status: err.status }
        );
      }
            // Server internals never reach the client: the 500 carries the
      // same stable token the catch helper uses for unknown statuses.
      return Response.json({ error: "generic" }, { status: 500 });
    }
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { getOpenFlags } = await import("../lib/resegmentation.server");
  const { volumes } = await import("../db/schema");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const db = drizzle(context.cloudflare.env.DB);

  // Crowdsourcing endpoint: 404 where the tenant does not have the
  // module, matching the member routes that call it.
  requireCapability(tenant, "crowdsourcing");

  const url = new URL(request.url);
  const volumeId = url.searchParams.get("volumeId");

  if (!volumeId) {
    return Response.json(
      { error: "volumeId query parameter is required" },
      { status: 400 }
    );
  }

  try {
    // Verify volume access
    const [volume] = await db
      .select({ projectId: volumes.projectId })
      .from(volumes)
      .where(eq(volumes.id, volumeId))
      .limit(1)
      .all();

    if (!volume) {
      return Response.json({ error: "Volume not found" }, { status: 404 });
    }

    await requireProjectRole(
      db,
      tenant.id,
      user.id,
      volume.projectId,
      [...PROJECT_ROLES],
      user.isAdmin
    );

    const flags = await getOpenFlags(db, volumeId);
    const isPaused = flags.length > 0;

    return Response.json({ flags, isPaused });
  } catch (err) {
    if (err instanceof Response) {
      return Response.json(
        { error: apiErrorToken(err.status) },
        { status: err.status }
      );
    }
        // Server internals never reach the client: the 500 carries the
    // same stable token the catch helper uses for unknown statuses.
    return Response.json({ error: "generic" }, { status: 500 });
  }
}
