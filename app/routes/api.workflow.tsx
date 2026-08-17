/**
 * Volume Workflow API
 *
 * This API endpoint is the volume-level status-transition spine.
 * Action-only — no loader, no component. POST accepts a form body
 * carrying `volumeId`, `projectId`, `targetStatus`, and an optional
 * `comment`, then delegates to `transitionVolumeStatus` which runs
 * the workflow state-machine check (only certain transitions are
 * allowed, only from certain roles), writes the new status to the
 * `volumes` row, and records an audit-log entry so the lead can see
 * who moved the volume and when.
 *
 * Submit-for-review dialogs, the lead's overview kanban, and the
 * reviewer footer actions all post here rather than mutating
 * `volumes` directly — keeping every status change behind one
 * guarded handler is what lets the state machine stay enforceable.
 *
 * @version v0.7.0
 */

import { userContext, tenantContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { apiErrorToken } from "../lib/api-error.server";
import type { VolumeStatus, WorkflowRole } from "../lib/workflow";
import { PROJECT_ROLES } from "../lib/validation/enums";
import type { Route } from "./+types/api.workflow";

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and } = await import("drizzle-orm");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { WORKFLOW_ROLE_PRECEDENCE } = await import("../lib/workflow");
  const { transitionVolumeStatus } = await import("../lib/workflow.server");
  const { volumes } = await import("../db/schema");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const db = drizzle(context.cloudflare.env.DB);

  // Crowdsourcing endpoint: 404 where the tenant does not have the
  // module, matching the member routes that call it.
  requireCapability(tenant, "crowdsourcing");

  const formData = await request.formData();
  const volumeId = formData.get("volumeId") as string;
  const projectId = formData.get("projectId") as string;
  const targetStatus = formData.get("targetStatus") as string;
  const comment = (formData.get("comment") as string) || undefined;

  if (!volumeId || !projectId || !targetStatus) {
    return Response.json(
      { ok: false, error: "volumeId, projectId, and targetStatus are required" },
      { status: 400 }
    );
  }

  // Get user's role on this project
  const memberships = await requireProjectRole(
    db,
    tenant.id,
    user.id,
    projectId,
    [...PROJECT_ROLES],
    user.isAdmin
  );

  // Both identifiers arrive in the request body, so nothing so far
  // ties them together: without this check a member of any project can
  // send their own projectId plus a foreign volumeId and drive that
  // volume through the state machine. The resulting activity_log row
  // is stamped with the VOLUME's tenant_id, so the forged transition
  // reads as native activity in the victim tenant.
  const [linkedVolume] = await db
    .select({ id: volumes.id })
    .from(volumes)
    .where(and(eq(volumes.id, volumeId), eq(volumes.projectId, projectId)))
    .limit(1)
    .all();

  if (!linkedVolume) {
    return Response.json(
      { ok: false, error: "Volume not found" },
      { status: 404 }
    );
  }

  // All held roles, not the first row: previously a user holding both
  // reviewer and cataloguer memberships got whichever role the DB
  // returned first, making transition permissions row-order-dependent.
  // The transition machine is role-partitioned, so every held role is
  // passed and a move is allowed if any of them permits it.
  const heldRoles: WorkflowRole[] = WORKFLOW_ROLE_PRECEDENCE.filter((r) =>
    memberships.some((m) => m.role === r)
  );
  const userRoles: WorkflowRole[] =
    heldRoles.length > 0 ? heldRoles : ["cataloguer"];

  try {
    await transitionVolumeStatus(
      db,
      volumeId,
      targetStatus as VolumeStatus,
      user.id,
      userRoles,
      comment
    );
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof Response) {
      return Response.json(
        { ok: false, error: apiErrorToken(err.status) },
        { status: err.status }
      );
    }
    // Server internals never reach the client: the 500 carries the
    // same stable token the catch helper uses for unknown statuses.
    return Response.json({ ok: false, error: "generic" }, { status: 500 });
  }
}
