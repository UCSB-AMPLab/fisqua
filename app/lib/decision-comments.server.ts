/**
 * Decision comment mutations — server core.
 *
 * The decision-side twin of `comments.server.ts`'s `updateCommentBody`
 * and `softDeleteComment`, mirroring their check order and copy for
 * comment rows anchored to a pending decision (`comments.decisionId`
 * set) instead of a volume. The two modules deliberately stay
 * separate rather than sharing one polymorphic function:
 * `comments.server.ts` treats a decision-anchored comment as absent —
 * decision threads are ruled through the review queue, not mutated
 * from a volume surface — and this module returns the identical 404
 * for any volume-anchored comment it is handed, so neither side can
 * reach across the boundary by accident.
 *
 * Authorisation here is tenant-scope, not project-role, because
 * decision threads sit on the admin surface. The gate has two layers,
 * matching `requireRulableDecision` one level up in
 * `pending-decisions.server.ts`: the comment's decision must belong to
 * the caller's federation (a decision in another federation does not
 * exist for this caller), and within the federation a comment on a
 * tenant-owned decision (`tenantId` set, copied from the decision at
 * post time) is visible only to that tenant's caller, while a comment
 * on a shared-space decision (`tenantId` NULL) is visible to any
 * federation caller who reaches it. Delete additionally grants an
 * admin override that edit deliberately withholds (no lead override on
 * edit, matching the volume side's stance) so a tenant admin can
 * retract another user's comment, including a label-authored (pipeline)
 * comment, from their own thread — but never rewrite its words.
 *
 * @version v0.7.0
 */
import { and, eq, isNull, or } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { comments, pendingDecisions } from "../db/schema";
import type { Tenant, User } from "../context";

/**
 * Edit a decision comment's body in place. Author-only — there is no
 * admin override here, so a label-authored comment (`authorId` NULL)
 * can never be edited by anyone, including an admin.
 *
 * A no-op save (`newText.trim() === current text`) short-circuits
 * without touching `editedAt` or `updatedAt`, so the "Editado" chip
 * does not appear for cosmetic re-submits — the same discipline
 * `updateCommentBody` applies on the volume side.
 *
 * @throws Response(400) when the trimmed body is empty.
 * @throws Response(404) when the comment does not exist, is
 *   volume-anchored (not this module's territory), or belongs to a
 *   foreign tenant.
 * @throws Response(410) when the comment is already soft-deleted.
 * @throws Response(403) when the caller is not the comment's author.
 */
export async function editDecisionComment(
  db: DrizzleD1Database<any>,
  user: User,
  tenant: Tenant,
  commentId: string,
  newText: string,
  now: number = Date.now(),
): Promise<{ changed: boolean }> {
  const trimmed = newText.trim();
  if (trimmed.length === 0) {
    throw new Response("Comment body cannot be empty", { status: 400 });
  }

  const comment = await db
    .select({
      decisionId: comments.decisionId,
      tenantId: comments.tenantId,
      authorId: comments.authorId,
      deletedAt: comments.deletedAt,
      text: comments.text,
      decisionFederationId: pendingDecisions.federationId,
    })
    .from(comments)
    .leftJoin(pendingDecisions, eq(comments.decisionId, pendingDecisions.id))
    .where(eq(comments.id, commentId))
    .get();

  if (!comment) {
    throw new Response("Comment not found", { status: 404 });
  }

  // Volume-anchored comments are `comments.server.ts`'s territory —
  // indistinguishable from absent here, mirroring the opposite guard
  // `updateCommentBody` runs against decision-anchored rows.
  if (comment.decisionId === null) {
    throw new Response("Comment not found", { status: 404 });
  }

  // Federation scope first, mirroring requireRulableDecision: a
  // decision in another federation does not exist for this caller. A
  // shared-space comment (tenantId NULL) is NOT federation-neutral —
  // without this gate any authenticated tenant anywhere could reach it.
  if (comment.decisionFederationId !== tenant.federationId) {
    throw new Response("Comment not found", { status: 404 });
  }

  // NULL tenantId is a shared-space decision, visible to any caller in
  // the federation who reaches this far; a foreign tenant's thread does
  // not exist for this caller.
  if (comment.tenantId !== null && comment.tenantId !== tenant.id) {
    throw new Response("Comment not found", { status: 404 });
  }

  if (comment.deletedAt !== null) {
    throw new Response("Comment already deleted", { status: 410 });
  }

  if (comment.authorId !== user.id) {
    throw new Response("Only the author can edit their comment", {
      status: 403,
    });
  }

  if (trimmed === comment.text) {
    // No-op: state already matches. Don't bump anything.
    return { changed: false };
  }

  // The isNull(deletedAt) guard mirrors the delete path: a delete
  // landing between the read above and this write must not rewrite a
  // tombstoned row's text.
  await db
    .update(comments)
    .set({ text: trimmed, editedAt: now, updatedAt: now })
    .where(and(eq(comments.id, commentId), isNull(comments.deletedAt)));

  return { changed: true };
}

/**
 * Soft-delete a decision comment, cascading to replies when the row is
 * a root. Authorised for the comment's author OR a tenant admin — the
 * one place this module grants an override edit withholds, so an
 * admin can remove a label-authored (pipeline) comment from their own
 * thread. Decision threads render flat today, but the storage supports
 * replies, so the cascade mirrors `softDeleteComment`'s exactly: a
 * single UPDATE hits the root plus every row whose `parentId` points
 * back at it, guarded `isNull(deletedAt)` for idempotency against a
 * concurrent delete.
 *
 * @throws Response(404) when the comment does not exist, is
 *   volume-anchored, or belongs to a foreign tenant.
 * @throws Response(410) when the comment is already soft-deleted.
 * @throws Response(403) when the caller is neither the author nor an
 *   admin.
 */
export async function deleteDecisionComment(
  db: DrizzleD1Database<any>,
  user: User,
  tenant: Tenant,
  commentId: string,
  now: number = Date.now(),
): Promise<{ cascadedCount: number }> {
  const comment = await db
    .select({
      decisionId: comments.decisionId,
      tenantId: comments.tenantId,
      authorId: comments.authorId,
      parentId: comments.parentId,
      deletedAt: comments.deletedAt,
      decisionFederationId: pendingDecisions.federationId,
    })
    .from(comments)
    .leftJoin(pendingDecisions, eq(comments.decisionId, pendingDecisions.id))
    .where(eq(comments.id, commentId))
    .get();

  if (!comment) {
    throw new Response("Comment not found", { status: 404 });
  }

  if (comment.decisionId === null) {
    throw new Response("Comment not found", { status: 404 });
  }

  // Same two-layer scope as the edit path: federation first, then
  // tenant ownership within it.
  if (comment.decisionFederationId !== tenant.federationId) {
    throw new Response("Comment not found", { status: 404 });
  }

  if (comment.tenantId !== null && comment.tenantId !== tenant.id) {
    throw new Response("Comment not found", { status: 404 });
  }

  if (comment.deletedAt !== null) {
    throw new Response("Comment already deleted", { status: 410 });
  }

  if (comment.authorId !== user.id && !user.isAdmin) {
    throw new Response(
      "Only the author or an admin can delete this comment",
      { status: 403 },
    );
  }

  const isRoot = comment.parentId === null;

  // Cascade on root: single UPDATE touching the row plus any replies
  // whose parent_id points back at it. The isNull(deletedAt) guard
  // keeps the update idempotent if a concurrent delete already
  // soft-deleted some replies.
  const where = isRoot
    ? and(
        isNull(comments.deletedAt),
        or(eq(comments.id, commentId), eq(comments.parentId, commentId)),
      )
    : and(isNull(comments.deletedAt), eq(comments.id, commentId));

  const result: any = await db
    .update(comments)
    .set({ deletedAt: now, deletedBy: user.id, updatedAt: now })
    .where(where);

  // D1 returns `{ meta: { changes } }` on run-equivalent paths. Fall
  // back to 0 when the driver doesn't expose a changes count -- callers
  // treat cascadedCount as best-effort, not load-bearing.
  const affected = Number(result?.meta?.changes ?? result?.changes ?? 0);
  const cascadedCount = isRoot ? Math.max(0, affected - 1) : 0;

  return { cascadedCount };
}
