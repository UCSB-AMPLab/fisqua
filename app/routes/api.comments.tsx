/**
 * Comments API endpoint.
 * Handles CRUD operations for entry-level description comments.
 */

import { drizzle } from "drizzle-orm/d1";
import { userContext } from "../context";
import { requireEntryAccess } from "../lib/permissions.server";
import {
  createComment,
  getCommentsForEntry,
  deleteComment,
} from "../lib/comments.server";
import { logActivity } from "../lib/workflow.server";
import type { WorkflowRole } from "../lib/workflow";
import type { Route } from "./+types/api.comments";

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  if (request.method === "POST") {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { entryId, parentId, text } = body;

    if (!entryId || !text) {
      return Response.json(
        { error: "entryId and text are required" },
        { status: 400 }
      );
    }

    try {
      const { member, volume } = await requireEntryAccess(
        db,
        entryId,
        user.id,
        user.isAdmin
      );
      const authorRole = (member?.role as WorkflowRole) ?? "cataloguer";

      const result = await createComment(db, {
        entryId,
        parentId: parentId ?? null,
        authorId: user.id,
        authorRole,
        text,
      });

      // Log activity
      await logActivity(db, user.id, "comment_added", {
        projectId: volume.projectId,
        volumeId: volume.id,
        detail: JSON.stringify({ entryId, commentId: result.id }),
      });

      return Response.json({ ok: true, commentId: result.id });
    } catch (err) {
      if (err instanceof Response) {
        const errText = await err.text();
        return Response.json({ error: errText }, { status: err.status });
      }
      const message = err instanceof Error ? err.message : "Failed to create comment";
      return Response.json({ error: message }, { status: 500 });
    }
  }

  if (request.method === "DELETE") {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { commentId } = body;

    if (!commentId) {
      return Response.json(
        { error: "commentId is required" },
        { status: 400 }
      );
    }

    try {
      await deleteComment(db, commentId, user.id);
      return Response.json({ ok: true });
    } catch (err) {
      if (err instanceof Response) {
        const errText = await err.text();
        return Response.json({ error: errText }, { status: err.status });
      }
      const message = err instanceof Error ? err.message : "Failed to delete comment";
      return Response.json({ error: message }, { status: 500 });
    }
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  const url = new URL(request.url);
  const entryId = url.searchParams.get("entryId");

  if (!entryId) {
    return Response.json(
      { error: "entryId query parameter is required" },
      { status: 400 }
    );
  }

  try {
    // Check access
    await requireEntryAccess(db, entryId, user.id, user.isAdmin);

    const comments = await getCommentsForEntry(db, entryId);
    return Response.json({ comments });
  } catch (err) {
    if (err instanceof Response) {
      const errText = await err.text();
      return Response.json({ error: errText }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Failed to load comments";
    return Response.json({ error: message }, { status: 500 });
  }
}
