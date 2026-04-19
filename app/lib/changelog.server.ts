/**
 * Changelog Server Helpers
 *
 * This module deals with the audit-trail side of the description,
 * entity, place, and repository editors. Every explicit save writes a
 * row to the `changelog` table with a JSON diff of which fields
 * changed, the acting user, and an optional note. The record powers
 * the per-record history panel and makes it possible to investigate a
 * bad edit long after it landed without reaching for a database
 * backup.
 *
 * @version v0.3.0
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";
import { changelog } from "../db/schema";

/**
 * Compute a field-level diff between two records.
 * Returns null if no fields changed; otherwise returns
 * { fieldName: { old: value, new: value } } for each changed field.
 */
export function computeDiff(
  original: Record<string, unknown>,
  updated: Record<string, unknown>
): Record<string, { old: unknown; new: unknown }> | null {
  const diff: Record<string, { old: unknown; new: unknown }> = {};
  for (const key of Object.keys(updated)) {
    if (JSON.stringify(original[key]) !== JSON.stringify(updated[key])) {
      diff[key] = { old: original[key], new: updated[key] };
    }
  }
  return Object.keys(diff).length > 0 ? diff : null;
}

/**
 * Create a changelog entry recording a field-level diff.
 */
export async function createChangelogEntry(
  db: DrizzleD1Database,
  recordId: string,
  recordType: string,
  userId: string,
  diff: Record<string, { old: unknown; new: unknown }>,
  note?: string
): Promise<void> {
  await db.insert(changelog).values({
    id: crypto.randomUUID(),
    recordId,
    recordType,
    userId,
    note: note || null,
    diff: JSON.stringify(diff),
    createdAt: Date.now(),
  });
}
