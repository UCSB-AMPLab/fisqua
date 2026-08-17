/**
 * Description Save API
 *
 * This API endpoint is the workflow spine for the entry description
 * editor. Action-only — no loader, no component. The editor POSTs
 * here with a `_action` discriminator that selects between four
 * workflow operations: autosave (forgiving snapshot), submit for
 * review (cataloguer hands off to reviewer), approve (reviewer
 * promotes to approved), and send back (reviewer returns to the
 * cataloguer with feedback).
 *
 * Each operation routes through a dedicated helper in
 * `description.server` so the workflow state machine — and the audit
 * row that accompanies every transition — stays in one place rather
 * than smeared across the route. The single shared guard is
 * `requireDescriptionAccess`, which checks both project-role and the
 * caller's specific role-vs-status fit (a reviewer cannot autosave
 * over a cataloguer's draft, a cataloguer cannot approve their own
 * entry, etc.).
 *
 * @version v0.7.0
 */

import { userContext, tenantContext } from "../context";
import { requireCapability } from "../lib/tenant";
import type { WorkflowRole } from "../lib/workflow";
import type { Route } from "./+types/api.description.save";

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { drizzle } = await import("drizzle-orm/d1");
  const { requireDescriptionAccess, highestProjectRole } = await import("../lib/permissions.server");
  const {
    saveDescription,
    submitForReview,
    approveDescription,
    sendBackDescription,
  } = await import("../lib/description.server");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const db = drizzle(context.cloudflare.env.DB);

  // Crowdsourcing endpoint: 404 where the tenant does not have the
  // module, matching the member routes that call it.
  requireCapability(tenant, "crowdsourcing");

  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { entryId, fields, action: actionType, comment } = body;

  if (!entryId) {
    return Response.json({ error: "entryId is required" }, { status: 400 });
  }

  try {
    // Check description access
    const { memberships } = await requireDescriptionAccess(
      db,
      tenant.id,
      entryId,
      user.id,
      user.isAdmin
    );
    const role: WorkflowRole = highestProjectRole(memberships) ?? "cataloguer";

    // Handle action types
    if (actionType === "submit") {
      const result = await submitForReview(db, entryId, user.id, role);
      if (!result.ok) {
        return Response.json(
          { error: "Validation failed", validationErrors: result.validationErrors },
          { status: 422 }
        );
      }
      return Response.json({ ok: true });
    }

    if (actionType === "approve") {
      await approveDescription(db, entryId, user.id, role);
      return Response.json({ ok: true });
    }

    if (actionType === "send_back") {
      if (!comment) {
        return Response.json(
          { error: "comment is required for send_back action" },
          { status: 400 }
        );
      }
      await sendBackDescription(db, entryId, user.id, role, comment);
      return Response.json({ ok: true });
    }

    // Default: autosave (no status change)
    if (!fields) {
      return Response.json(
        { error: "fields object is required for autosave" },
        { status: 400 }
      );
    }
    await saveDescription(db, entryId, fields);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof Response) {
      const { apiErrorToken } = await import("../lib/api-error.server");
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
