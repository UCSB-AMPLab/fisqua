/**
 * Drafts Server Helpers
 *
 * This module deals with the autosave side of the description, entity,
 * place, and repository admin pages. Every record type stores its
 * in-progress form state as a JSON blob in the `drafts` table so a
 * cataloguer's unsaved edits survive a page reload, a session timeout,
 * or a switch to another machine. The helpers upsert drafts keyed to
 * `(record_id, record_type)`, fetch a user's own draft on page load,
 * and surface draft-conflict state when a different user already has
 * an open draft on the same record. On explicit commit the caller
 * clears the draft through `clearDraft`.
 *
 * @version v0.3.0
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";
import { eq, and, ne } from "drizzle-orm";
import { drafts } from "../db/schema";

/**
 * Save (or upsert) a draft snapshot for a record.
 * Uses the UNIQUE index on (record_id, record_type) — only one draft per record.
 */
export async function saveDraft(
  db: DrizzleD1Database,
  recordId: string,
  recordType: string,
  userId: string,
  snapshot: string
): Promise<void> {
  const existing = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(and(eq(drafts.recordId, recordId), eq(drafts.recordType, recordType)))
    .get();

  if (existing) {
    await db
      .update(drafts)
      .set({ snapshot, userId, updatedAt: Date.now() })
      .where(eq(drafts.id, existing.id));
  } else {
    await db.insert(drafts).values({
      id: crypto.randomUUID(),
      recordId,
      recordType,
      userId,
      snapshot,
      updatedAt: Date.now(),
    });
  }
}

/**
 * Retrieve the current draft for a record, or null if none exists.
 */
export async function getDraft(
  db: DrizzleD1Database,
  recordId: string,
  recordType: string
): Promise<{
  id: string;
  userId: string;
  snapshot: string;
  updatedAt: number;
} | null> {
  return (
    (await db
      .select({
        id: drafts.id,
        userId: drafts.userId,
        snapshot: drafts.snapshot,
        updatedAt: drafts.updatedAt,
      })
      .from(drafts)
      .where(
        and(eq(drafts.recordId, recordId), eq(drafts.recordType, recordType))
      )
      .get()) ?? null
  );
}

/**
 * Check if another user has an active draft on the same record.
 * Returns null if no conflict (no draft, or only current user's draft).
 */
export async function getConflictDraft(
  db: DrizzleD1Database,
  recordId: string,
  recordType: string,
  currentUserId: string
): Promise<{ userId: string; updatedAt: number } | null> {
  return (
    (await db
      .select({ userId: drafts.userId, updatedAt: drafts.updatedAt })
      .from(drafts)
      .where(
        and(
          eq(drafts.recordId, recordId),
          eq(drafts.recordType, recordType),
          ne(drafts.userId, currentUserId)
        )
      )
      .get()) ?? null
  );
}

/**
 * Delete the draft for a record (after successful explicit save).
 */
export async function deleteDraft(
  db: DrizzleD1Database,
  recordId: string,
  recordType: string
): Promise<void> {
  await db
    .delete(drafts)
    .where(
      and(eq(drafts.recordId, recordId), eq(drafts.recordType, recordType))
    );
}
