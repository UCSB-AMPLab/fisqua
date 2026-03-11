import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { entries } from "../db/schema";
import type { Entry } from "./boundary-types";

/**
 * Load all entries for a volume, ordered by position.
 * If no entries exist, returns a single auto-entry at page 1
 * (initial state per CONTEXT.md -- auto-boundary on page 1, type unset).
 */
export async function loadEntries(
  db: DrizzleD1Database<any>,
  volumeId: string
): Promise<Entry[]> {
  const rows = await db
    .select()
    .from(entries)
    .where(eq(entries.volumeId, volumeId))
    .orderBy(entries.position)
    .all();

  if (rows.length > 0) {
    return rows.map(rowToEntry);
  }

  // No entries -- return default auto-entry at page 1
  const now = Date.now();
  return [
    {
      id: crypto.randomUUID(),
      volumeId,
      parentId: null,
      position: 0,
      startPage: 1,
      startY: 0,
      endPage: null,
      endY: null,
      type: null,
      title: null,
      note: null,
      noteUpdatedBy: null,
      noteUpdatedAt: null,
      reviewerComment: null,
      reviewerCommentUpdatedBy: null,
      reviewerCommentUpdatedAt: null,
      modifiedBy: null,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

/**
 * Batch save entries for a volume.
 * Strategy: DELETE all entries for the volume, then INSERT all provided entries.
 * Chunks into batches of 90 statements if entries exceed D1 batch limit.
 */
export async function saveEntries(
  db: DrizzleD1Database<any>,
  volumeId: string,
  entriesToSave: Entry[]
): Promise<void> {
  // Validate entries shape
  validateEntries(entriesToSave, volumeId);

  const now = Date.now();

  // Build all statements: DELETE + INSERTs
  const deleteStmt = db
    .delete(entries)
    .where(eq(entries.volumeId, volumeId));

  const insertValues = entriesToSave.map((e) => ({
    id: e.id,
    volumeId,
    parentId: e.parentId,
    position: e.position,
    startPage: e.startPage,
    startY: e.startY,
    endPage: e.endPage,
    endY: e.endY,
    type: e.type,
    title: e.title,
    note: e.note,
    noteUpdatedBy: e.noteUpdatedBy,
    noteUpdatedAt: e.noteUpdatedAt,
    reviewerComment: e.reviewerComment,
    reviewerCommentUpdatedBy: e.reviewerCommentUpdatedBy,
    reviewerCommentUpdatedAt: e.reviewerCommentUpdatedAt,
    modifiedBy: e.modifiedBy,
    createdAt: e.createdAt,
    updatedAt: now,
  }));

  // D1 batch limit is ~100 statements. Chunk INSERTs so each batch
  // stays under 90 statements (leaving room for the DELETE).
  const CHUNK_SIZE = 89;

  if (insertValues.length <= CHUNK_SIZE) {
    // Single batch: DELETE + all INSERTs
    const stmts: any[] = [deleteStmt];
    if (insertValues.length > 0) {
      stmts.push(db.insert(entries).values(insertValues));
    }
    await db.batch(stmts as any);
  } else {
    // Multiple batches: first batch has DELETE + first chunk of INSERTs,
    // subsequent batches have only INSERTs
    const chunks: (typeof insertValues)[] = [];
    for (let i = 0; i < insertValues.length; i += CHUNK_SIZE) {
      chunks.push(insertValues.slice(i, i + CHUNK_SIZE));
    }

    // First batch includes the DELETE
    const firstBatch: any[] = [deleteStmt];
    if (chunks[0].length > 0) {
      firstBatch.push(db.insert(entries).values(chunks[0]));
    }
    await db.batch(firstBatch as any);

    // Remaining chunks
    for (let i = 1; i < chunks.length; i++) {
      await db.batch([db.insert(entries).values(chunks[i])] as any);
    }
  }
}

/**
 * Validate that the entries array has the expected shape.
 * Throws if validation fails.
 */
function validateEntries(entriesToSave: Entry[], volumeId: string): void {
  if (!Array.isArray(entriesToSave)) {
    throw new Error("entries must be an array");
  }

  for (const entry of entriesToSave) {
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      throw new Error("each entry must have a non-empty string id");
    }
    if (entry.volumeId !== volumeId) {
      throw new Error("entry volumeId must match the target volumeId");
    }
    if (typeof entry.position !== "number" || entry.position < 0) {
      throw new Error("each entry must have a non-negative position");
    }
    if (typeof entry.startPage !== "number" || entry.startPage < 1) {
      throw new Error("each entry must have a positive startPage");
    }
    if (typeof entry.startY !== "number" || entry.startY < 0 || entry.startY > 1) {
      throw new Error("each entry must have a startY between 0 and 1");
    }
    if (entry.endY !== null && entry.endY !== undefined) {
      if (typeof entry.endY !== "number" || entry.endY < 0 || entry.endY > 1) {
        throw new Error("endY must be a number between 0 and 1, or null");
      }
    }
    if (entry.type !== null && !["item", "blank", "front_matter", "back_matter"].includes(entry.type)) {
      throw new Error(`invalid entry type: ${entry.type}`);
    }
  }
}

/**
 * Convert a DB row to an Entry object.
 */
function rowToEntry(row: typeof entries.$inferSelect): Entry {
  return {
    id: row.id,
    volumeId: row.volumeId,
    parentId: row.parentId,
    position: row.position,
    startPage: row.startPage,
    startY: row.startY,
    endPage: row.endPage,
    endY: row.endY,
    type: row.type,
    title: row.title,
    note: row.note,
    noteUpdatedBy: row.noteUpdatedBy,
    noteUpdatedAt: row.noteUpdatedAt,
    reviewerComment: row.reviewerComment,
    reviewerCommentUpdatedBy: row.reviewerCommentUpdatedBy,
    reviewerCommentUpdatedAt: row.reviewerCommentUpdatedAt,
    modifiedBy: row.modifiedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
