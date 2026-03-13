/**
 * Comment CRUD operations for entry-level description comments.
 *
 * Supports unlimited nesting via parentId references.
 */

import { eq, and, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { comments, entries, users } from "../db/schema";
import type { WorkflowRole } from "./workflow";

/**
 * Create a new comment on an entry.
 * parentId null for top-level, references existing comment id for replies.
 */
export async function createComment(
  db: DrizzleD1Database<any>,
  data: {
    entryId: string;
    parentId: string | null;
    authorId: string;
    authorRole: WorkflowRole;
    text: string;
  }
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const now = Date.now();

  await db.insert(comments).values({
    id,
    entryId: data.entryId,
    parentId: data.parentId ?? null,
    authorId: data.authorId,
    authorRole: data.authorRole,
    text: data.text,
    createdAt: now,
    updatedAt: now,
  });

  return { id };
}

/**
 * Get all comments for an entry, ordered by createdAt ascending.
 * Includes author email via join with users table.
 */
export async function getCommentsForEntry(
  db: DrizzleD1Database<any>,
  entryId: string
) {
  return db
    .select({
      id: comments.id,
      entryId: comments.entryId,
      parentId: comments.parentId,
      authorId: comments.authorId,
      authorRole: comments.authorRole,
      text: comments.text,
      createdAt: comments.createdAt,
      updatedAt: comments.updatedAt,
      authorEmail: users.email,
      authorName: users.name,
    })
    .from(comments)
    .leftJoin(users, eq(comments.authorId, users.id))
    .where(eq(comments.entryId, entryId))
    .orderBy(comments.createdAt)
    .all();
}

/**
 * Get all comments for all entries in a volume, grouped by entryId.
 * Returns a Record<entryId, CommentWithAuthor[]>.
 */
export async function getCommentsForVolume(
  db: DrizzleD1Database<any>,
  volumeId: string
) {
  // Get all entry IDs for this volume
  const entryRows = await db
    .select({ id: entries.id })
    .from(entries)
    .where(eq(entries.volumeId, volumeId))
    .all();

  if (entryRows.length === 0) return {};

  const entryIds = entryRows.map((r) => r.id);

  const rows = await db
    .select({
      id: comments.id,
      entryId: comments.entryId,
      parentId: comments.parentId,
      authorId: comments.authorId,
      authorRole: comments.authorRole,
      text: comments.text,
      createdAt: comments.createdAt,
      updatedAt: comments.updatedAt,
      authorEmail: users.email,
      authorName: users.name,
    })
    .from(comments)
    .leftJoin(users, eq(comments.authorId, users.id))
    .where(inArray(comments.entryId, entryIds))
    .orderBy(comments.createdAt)
    .all();

  const map: Record<string, typeof rows> = {};
  for (const row of rows) {
    if (!map[row.entryId]) map[row.entryId] = [];
    map[row.entryId].push(row);
  }
  return map;
}

/**
 * Delete a comment. Only the author can delete their own comment.
 */
export async function deleteComment(
  db: DrizzleD1Database<any>,
  commentId: string,
  userId: string
): Promise<void> {
  const [comment] = await db
    .select({ authorId: comments.authorId })
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1)
    .all();

  if (!comment) {
    throw new Response("Comment not found", { status: 404 });
  }

  if (comment.authorId !== userId) {
    throw new Response("Only the author can delete their comment", {
      status: 403,
    });
  }

  await db.delete(comments).where(eq(comments.id, commentId));
}
