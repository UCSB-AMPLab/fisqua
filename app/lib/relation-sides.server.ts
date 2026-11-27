/**
 * Relation sides — which links the link forms must leave alone
 *
 * This module deals with the links that the link forms must leave alone. A
 * relation stated in a document is two links to the description, one for
 * each person, each naming the other in `related_to` (migration 0125). The
 * link forms of the description page and the entity page have no notion of
 * relations: their role lists are the document roles, and removing a link
 * there keeps no other link to repoint the partner to. Until the
 * cataloguing interface for relations exists, those forms refuse a link
 * that is a relation side or that another link names, so a save never
 * turns a relation side into a document role and a removal never leaves a
 * link naming a link that is gone.
 *
 * What holds the invariant is the database: `related_to` is a foreign
 * key to `description_entities(id)` (migration 0125), and D1 enforces
 * it, so D1 refuses every write that would leave a link naming a link
 * that is gone, whatever path makes it and in whatever order writes from
 * different sessions land. The helpers here, and the merges' guards in
 * `pair-merge.server.ts`, exist to turn those cases into a clean refusal
 * the page can show, not to hold the invariant themselves. A removal and
 * an edit carry their condition in their own statement
 * (`deleteLinkAsRead`, `updateLinkAsRead`), so the refusal they give
 * matches what the statement found.
 *
 * The condition is the link's relation as the form read it
 * (`relation-as-read.ts`): the link it names and the links naming it.
 * A repoint writes only the link, so no entity's version tells the form
 * that the relation changed; the statement compares the relation as read
 * with the relation as stored, and writes nothing when they differ. The
 * forms send only a relation outside every relation, since they refuse a
 * relation side before writing; a request that sends none is held to
 * that too. `relationRefusal` tells the page why a statement wrote
 * nothing: the link was a relation side as the form read it, or its
 * relation changed after the read. `namedBySql` is the loaders' read of
 * the links naming each link, for the relation the forms send, and
 * `relatedToSql` its read of the link each one names: a `related_to`
 * naming a link outside the row's description is stale data and is
 * given as none. `relationSideSql` reads only whether a link is a
 * relation side, by the same two reads, for the pages that label a role
 * and need no link id.
 *
 * A link names another as its relation side only on the same
 * description, so the links naming a link are read on its description
 * alone, and no id from another description, or another tenant's, is
 * given to a page. The write condition still counts every link naming
 * the link wherever it is: such a link makes the write refuse, with the
 * generic refusal, since the relation as read cannot name it.
 *
 * @version v0.9.0
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { descriptionEntities } from "../db/schema";
import { OUTSIDE_RELATIONS, isRelationSide, namedByList, sameRelation, type RelationAsRead, type RelationRefusal } from "./relation-as-read";

/**
 * The condition that the link's relation is the one read: it names
 * `asRead.relatedTo` (none when null), and the links naming it are
 * exactly `asRead.namedBy`.
 */
function relationIs(linkId: string, asRead: RelationAsRead): SQL {
  const naming = sql`(SELECT naming.id FROM description_entities AS naming WHERE naming.related_to = ${linkId})`;
  return and(
    sql`COALESCE(${descriptionEntities.relatedTo}, '') = ${asRead.relatedTo ?? ""}`,
    asRead.namedBy.length === 0
      ? sql`NOT EXISTS ${naming}`
      : sql`(SELECT count(*) FROM description_entities AS naming WHERE naming.related_to = ${linkId}) = ${asRead.namedBy.length}
          AND NOT EXISTS (SELECT 1 FROM description_entities AS naming WHERE naming.related_to = ${linkId}
            AND naming.id NOT IN (SELECT value FROM json_each(${JSON.stringify(asRead.namedBy)})))`,
  )!;
}

/**
 * Delete one link only while its relation is the one read, and say
 * whether it was deleted. This is the delete for every removal that is
 * not part of a guarded repoint (the description page's
 * `remove_entity_link` and the entity page's `unlink_description`),
 * which pass a relation outside every relation.
 *
 * The condition is in the DELETE itself:
 *
 *   DELETE FROM description_entities
 *   WHERE id = ? AND <the page's scope> AND COALESCE(related_to, '') = ''
 *     AND NOT EXISTS (SELECT naming.id FROM description_entities AS naming WHERE naming.related_to = ?)
 *
 * Completeness rests on the foreign key on `related_to`: D1 refuses a
 * DELETE of a link that another link names, and refuses a `related_to`
 * naming a link that does not exist, so no order of writes leaves a
 * dangling reference. A repoint that lands before this statement makes
 * the DELETE match nothing; one that lands after it names a link that is
 * gone and fails on the foreign key (a merge's guard reports that as
 * stale data first). The condition in the DELETE is there so that this
 * path answers with the page's refusal rather than a constraint error;
 * a check made by an earlier read could not give that, because a write
 * can land between the read and the DELETE.
 *
 * `scope` is the page's own condition on the row (its description, or
 * its entity). When nothing is deleted the caller refuses, with
 * `relationRefusal`'s answer.
 */
export async function deleteLinkAsRead(
  db: DrizzleD1Database<any>,
  linkId: string,
  scope: SQL | undefined,
  asRead: RelationAsRead,
): Promise<boolean> {
  const deleted = await db
    .delete(descriptionEntities)
    .where(and(eq(descriptionEntities.id, linkId), scope, relationIs(linkId, asRead)))
    .returning({ id: descriptionEntities.id });
  return deleted.length === 1;
}

/** `deleteLinkAsRead` for a link outside every relation. */
export function deleteLinkOutsideRelations(db: DrizzleD1Database<any>, linkId: string, scope: SQL | undefined): Promise<boolean> {
  return deleteLinkAsRead(db, linkId, scope, OUTSIDE_RELATIONS);
}

/**
 * Update one link only while its relation is the one read, and say
 * whether it was updated. This is the write for the link forms' edits
 * (the description page's `update_entity_link` and the entity page's
 * `edit_description_link`), whose role lists are document roles only,
 * and which pass a relation outside every relation.
 *
 * The condition is in the UPDATE itself, as in `deleteLinkAsRead`: the
 * decision and the write are one statement, so a repoint that makes a
 * link name this one, or this one name another, either commits first,
 * and the UPDATE changes nothing, or after, onto a link that already
 * holds the edit. A document role is never written onto a link that a
 * relation names. (The foreign key does not cover this case: an edit
 * leaves no dangling reference, only a wrong role.)
 */
export async function updateLinkAsRead(
  db: DrizzleD1Database<any>,
  linkId: string,
  scope: SQL | undefined,
  asRead: RelationAsRead,
  set: Partial<typeof descriptionEntities.$inferInsert> | Record<string, unknown>,
): Promise<boolean> {
  const updated = await db
    .update(descriptionEntities)
    .set(set as Partial<typeof descriptionEntities.$inferInsert>)
    .where(and(eq(descriptionEntities.id, linkId), scope, relationIs(linkId, asRead)))
    .returning({ id: descriptionEntities.id });
  return updated.length === 1;
}

/** `updateLinkAsRead` for a link outside every relation. */
export function updateLinkOutsideRelations(
  db: DrizzleD1Database<any>,
  linkId: string,
  scope: SQL | undefined,
  set: Partial<typeof descriptionEntities.$inferInsert> | Record<string, unknown>,
): Promise<boolean> {
  return updateLinkAsRead(db, linkId, scope, OUTSIDE_RELATIONS, set);
}

/**
 * For a query on `description_entities`: the link the row names in
 * `related_to`, when that link is on the same description; null
 * otherwise. A `related_to` naming a link elsewhere is stale data: it is
 * never given to a page, so the relation as read is "outside every
 * relation", the write condition (which reads the stored column) does
 * not hold, and the save or removal is refused with the generic refusal.
 * The loaders and `readRelation` read through it; the row's own
 * description is the tenant's in every one of them.
 */
export const relatedToSql = (): SQL<string | null> =>
  sql<string | null>`(CASE WHEN (SELECT named.description_id FROM description_entities AS named WHERE named.id = ${outer("related_to")})
    = ${outer("description_id")} THEN ${outer("related_to")} END)`;

/**
 * A column of the outer `description_entities` row, qualified by the
 * table's name. Drizzle leaves a column unqualified in a query on one
 * table, and inside a subquery on the same table an unqualified name
 * would name the subquery's row instead.
 */
const outer = (column: "id" | "description_id" | "related_to") => sql.raw(`"description_entities"."${column}"`);

/**
 * For a query on `description_entities`: the ids of the links naming the
 * row, comma-separated, or null. A loader selects it beside
 * `related_to` and gives the pages the relation as read
 * (`namedByList` turns it into the sorted list).
 */
export const namedBySql = (): SQL<string | null> =>
  sql<string | null>`(SELECT group_concat(naming.id) FROM description_entities AS naming
    WHERE naming.related_to = ${outer("id")} AND naming.description_id = ${outer("description_id")})`;

/**
 * For a query on `description_entities`: whether the row is a relation
 * side, that is, it names a link of its own description or a link of
 * its description names it. It carries no link id, so a page that only
 * labels a role (the Reader page, the workbench cards, the unfolded
 * panel) learns which list to label it from and nothing more.
 */
export const relationSideSql = (): SQL<boolean> =>
  sql<number>`(CASE WHEN ${relatedToSql()} IS NOT NULL OR ${namedBySql()} IS NOT NULL THEN 1 ELSE 0 END)`.mapWith(
    (v: unknown) => Number(v) === 1,
  ) as unknown as SQL<boolean>;

/** The link's relation as stored, or null when no link in `scope` has the id. */
export async function readRelation(db: DrizzleD1Database<any>, linkId: string, scope: SQL | undefined): Promise<RelationAsRead | null> {
  const row = await db
    .select({
      relatedTo: relatedToSql(),
      namedBy: sql<string | null>`(SELECT group_concat(naming.id) FROM description_entities AS naming
        WHERE naming.related_to = ${linkId} AND naming.description_id = ${outer("description_id")})`,
    })
    .from(descriptionEntities)
    .where(and(eq(descriptionEntities.id, linkId), scope))
    .get();
  return row ? { relatedTo: row.relatedTo ?? null, namedBy: namedByList(row.namedBy) } : null;
}

/**
 * Why a link form's save or removal wrote nothing, as the page's
 * refusal. `asRead` is the relation the form sent (null when it sent
 * none). A link that was a relation side as read is refused as one
 * (`relation_side_*`); a link the form read outside every relation whose
 * relation is now another was changed after the read
 * (`relation_changed_*`); a request that sent no relation, for a link
 * that is a relation side, is refused as a relation side. Null when the
 * link is not there; `generic` when nothing about its relation explains
 * the refusal.
 */
export async function relationRefusal(
  db: DrizzleD1Database<any>,
  linkId: string,
  scope: SQL | undefined,
  asRead: RelationAsRead | null,
  action: "save" | "remove",
): Promise<RelationRefusal | "generic" | null> {
  if (asRead && isRelationSide(asRead)) return `relation_side_${action}`;
  const stored = await readRelation(db, linkId, scope);
  if (!stored) return null;
  if (asRead && !sameRelation(asRead, stored)) return `relation_changed_${action}`;
  if (isRelationSide(stored)) return `relation_side_${action}`;
  return "generic";
}

// @version v0.9.0
