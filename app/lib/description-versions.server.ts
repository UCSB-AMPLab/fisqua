/**
 * Description versions in a batch
 *
 * This module deals with two statements that the import, the revert and
 * the description editor put into their batches so a description's
 * version (`updated_at`) stays a true record of its published content.
 *
 * `descriptionsAsReadGuard` fails the batch it opens unless every named
 * description still exists in the tenant at the version the step read.
 * `json()` of text that is not JSON raises the error that fails the
 * batch, and D1 runs a batch as one transaction, so a write that landed
 * between the read and the batch leaves nothing of the batch written.
 * The ids and versions go as one JSON parameter, so a batch of any size
 * binds two parameters.
 *
 * `parentVersionFollows` moves the version of a description's parent,
 * past the version the parent holds (`nextVersionSql`), after a write
 * that changes what the parent publishes: its `children_level` reads its
 * children's level and publication. It names the parent through the
 * child as the child holds `childVersion`, so it moves nothing when the
 * child's write did not land, and nothing for a description at the top
 * of the tree. `parentsVersionFollow` moves a set of parents' versions
 * in one statement; the import and the revert put it at the end of a
 * batch, after every row's own write.
 *
 * @version v0.9.0
 */

import { and, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { BatchItem } from "drizzle-orm/batch";
import { descriptions } from "../db/schema";
import { nextVersionSql } from "./record-version.server";

/** A description as a step read it. */
export interface DescriptionAsRead {
  id: string;
  version: number;
}

/**
 * The statement that fails its batch unless every description in `read`
 * is still in `tenantId` at the version read.
 */
export function descriptionsAsReadGuard(
  db: DrizzleD1Database<any>,
  tenantId: string,
  read: readonly DescriptionAsRead[],
): BatchItem<"sqlite"> {
  const pairs = JSON.stringify(read.map((r) => [r.id, r.version]));
  const changed = sql`EXISTS (
    SELECT 1 FROM json_each(${pairs}) r
    WHERE NOT EXISTS (
      SELECT 1 FROM descriptions d
      WHERE d.id = json_extract(r.value, '$[0]')
        AND d.tenant_id = ${tenantId}
        AND d.updated_at = json_extract(r.value, '$[1]')
    )
  )`;
  return db
    .select({
      asRead: sql<number>`CASE WHEN ${changed} THEN json('a description changed since it was read') ELSE 1 END`,
    })
    .from(sql`(SELECT 1)`);
}

/**
 * The statement that moves the version of `childId`'s parent, while the
 * child holds `childVersion`.
 */
export function parentVersionFollows(
  db: DrizzleD1Database<any>,
  tenantId: string,
  childId: string,
  childVersion: number,
  now: number = Date.now(),
) {
  return db
    .update(descriptions)
    .set({ updatedAt: nextVersionSql(descriptions.updatedAt, now) })
    .where(
      and(
        eq(descriptions.tenantId, tenantId),
        sql`${descriptions.id} = (SELECT c.parent_id FROM descriptions c WHERE c.id = ${childId} AND c.tenant_id = ${tenantId} AND c.updated_at = ${childVersion})`,
      ),
    );
}

/**
 * The statement that moves the version of each of `parentIds` in
 * `tenantId`, past the version it holds. Null when there are none. The
 * ids go as one JSON parameter. A parent written in an earlier batch of
 * the same import, then bumped by a later batch's change to a child's
 * level, is kept by a revert as edited.
 */
export function parentsVersionFollow(
  db: DrizzleD1Database<any>,
  tenantId: string,
  parentIds: readonly string[],
  now: number = Date.now(),
) {
  if (parentIds.length === 0) return null;
  return db
    .update(descriptions)
    .set({ updatedAt: nextVersionSql(descriptions.updatedAt, now) })
    .where(
      and(
        eq(descriptions.tenantId, tenantId),
        sql`${descriptions.id} IN (SELECT value FROM json_each(${JSON.stringify([...new Set(parentIds)])}))`,
      ),
    );
}

// @version v0.9.0
