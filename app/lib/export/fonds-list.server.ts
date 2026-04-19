/**
 * Fonds List Lookup
 *
 * Queries the distinct set of fonds reference codes that have at least
 * one publishable description. Used by the publish dashboard to build
 * the fonds selector dropdown and by the validation layer in
 * `api.publish` to reject requests that target unknown fonds.
 *
 * @version v0.3.0
 */

import { isNull } from "drizzle-orm";
import { descriptions } from "../../db/schema";
import type { DrizzleD1Database } from "drizzle-orm/d1";

/**
 * Query distinct root description reference codes from the database.
 * Root descriptions are those with no parent (parentId IS NULL).
 * Returns sorted reference codes, filtering out any null values.
 */
export async function getFondsList(
  db: DrizzleD1Database<any>
): Promise<string[]> {
  const roots = await db
    .select({ referenceCode: descriptions.referenceCode })
    .from(descriptions)
    .where(isNull(descriptions.parentId))
    .orderBy(descriptions.referenceCode)
    .all();
  return roots.map((r) => r.referenceCode).filter(Boolean) as string[];
}
