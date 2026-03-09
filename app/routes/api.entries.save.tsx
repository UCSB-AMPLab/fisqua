import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { userContext } from "../context";
import {
  requireProjectRole,
  requireVolumeAccess,
} from "../lib/permissions.server";
import { saveEntries } from "../lib/entries.server";
import { logActivity } from "../lib/workflow.server";
import { volumes } from "../db/schema";
import type { Route } from "./+types/api.entries.save";

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  const formData = await request.formData();
  const volumeId = formData.get("volumeId") as string;
  const entriesJson = formData.get("entries") as string;

  if (!volumeId || !entriesJson) {
    return Response.json(
      { error: "volumeId and entries are required" },
      { status: 400 }
    );
  }

  // Look up volume to get projectId, status, and assignment info
  const volume = await db
    .select({
      projectId: volumes.projectId,
      status: volumes.status,
      assignedTo: volumes.assignedTo,
      assignedReviewer: volumes.assignedReviewer,
    })
    .from(volumes)
    .where(eq(volumes.id, volumeId))
    .get();

  if (!volume) {
    return Response.json({ error: "Volume not found" }, { status: 404 });
  }

  // Extend access: lead, cataloguer, and reviewer can save (not just lead)
  const memberships = await requireProjectRole(
    db,
    user.id,
    volume.projectId,
    ["lead", "cataloguer", "reviewer"],
    user.isAdmin
  );

  const userRole = memberships[0]?.role ?? "cataloguer";

  // Check volume-level access: only "edit" or "review" can save
  const accessLevel = requireVolumeAccess(
    user.id,
    volume,
    userRole,
    user.isAdmin
  );

  if (accessLevel === "readonly") {
    return Response.json(
      { error: "You do not have edit access to this volume" },
      { status: 403 }
    );
  }

  // Parse and save entries
  let parsedEntries;
  try {
    parsedEntries = JSON.parse(entriesJson);
  } catch {
    return Response.json({ error: "Invalid entries JSON" }, { status: 400 });
  }

  try {
    await saveEntries(db, volumeId, parsedEntries);

    // Auto-transition: if volume is "unstarted", move to "in_progress"
    // Uses conditional UPDATE to handle race conditions atomically
    if (volume.status === "unstarted") {
      const result = await db
        .update(volumes)
        .set({ status: "in_progress", updatedAt: Date.now() })
        .where(
          and(eq(volumes.id, volumeId), eq(volumes.status, "unstarted"))
        );

      // Log the auto-transition
      await logActivity(db, user.id, "status_changed", {
        projectId: volume.projectId,
        volumeId,
        detail: JSON.stringify({
          from: "unstarted",
          to: "in_progress",
          auto: true,
        }),
      });
    }

    return Response.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Save failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
