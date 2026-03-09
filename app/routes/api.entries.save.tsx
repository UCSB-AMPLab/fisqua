import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { userContext } from "../context";
import { requireProjectRole } from "../lib/permissions.server";
import { saveEntries } from "../lib/entries.server";
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

  // Look up volume to get projectId
  const volume = await db
    .select({ projectId: volumes.projectId })
    .from(volumes)
    .where(eq(volumes.id, volumeId))
    .get();

  if (!volume) {
    return Response.json({ error: "Volume not found" }, { status: 404 });
  }

  // Lead-only access (admins bypass)
  await requireProjectRole(db, user.id, volume.projectId, ["lead"], user.isAdmin);

  // Parse and save entries
  let parsedEntries;
  try {
    parsedEntries = JSON.parse(entriesJson);
  } catch {
    return Response.json({ error: "Invalid entries JSON" }, { status: 400 });
  }

  try {
    await saveEntries(db, volumeId, parsedEntries);
    return Response.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Save failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
