/**
 * Status transition API endpoint.
 * Action-only route -- no loader, no component.
 * Accepts POST with form data: volumeId, projectId, targetStatus, comment?
 */

import { userContext } from "../context";
import type { VolumeStatus, WorkflowRole } from "../lib/workflow";
import type { Route } from "./+types/api.workflow";

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const { drizzle } = await import("drizzle-orm/d1");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { transitionVolumeStatus } = await import("../lib/workflow.server");

  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

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
    user.id,
    projectId,
    ["lead", "cataloguer", "reviewer"],
    user.isAdmin
  );

  const userRole: WorkflowRole =
    (memberships[0]?.role as WorkflowRole) ?? "cataloguer";

  try {
    await transitionVolumeStatus(
      db,
      volumeId,
      targetStatus as VolumeStatus,
      user.id,
      userRole,
      comment
    );
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof Response) {
      const text = await err.text();
      return Response.json(
        { ok: false, error: text },
        { status: err.status }
      );
    }
    const message = err instanceof Error ? err.message : "Transition failed";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
