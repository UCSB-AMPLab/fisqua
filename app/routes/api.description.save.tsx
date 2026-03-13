/**
 * Description save API endpoint.
 * Action-only route -- no loader, no component.
 *
 * Handles autosave, submit-for-review, approve, and send-back actions.
 */

import { drizzle } from "drizzle-orm/d1";
import { userContext } from "../context";
import { requireDescriptionAccess } from "../lib/permissions.server";
import {
  saveDescription,
  submitForReview,
  approveDescription,
  sendBackDescription,
} from "../lib/description.server";
import type { WorkflowRole } from "../lib/workflow";
import type { Route } from "./+types/api.description.save";

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

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
    const { member } = await requireDescriptionAccess(
      db,
      entryId,
      user.id,
      user.isAdmin
    );
    const role = (member?.role as WorkflowRole) ?? "cataloguer";

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
      const text = await err.text();
      return Response.json({ error: text }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Save failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
