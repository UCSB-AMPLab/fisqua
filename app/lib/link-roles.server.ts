/**
 * Link roles — writing a link's role only when the federation approves it
 *
 * This module deals with the check every write of a document or place
 * link's role passes: the code must be approved in the federation's
 * `entity_role` or `place_role` list, or, on an edit, be the code the
 * link already holds. Fisqua names no role of its own, so the
 * federation's list is the only authority, and the check is part of the
 * write statement itself: a code deprecated between the page's read and
 * the write is refused, because no earlier read can see a change that
 * lands after it.
 *
 * The pieces:
 *
 *   - `roleApprovedSql(federationId, list, code)`: the condition
 *     `EXISTS (SELECT 1 FROM vocabulary_values WHERE federation_id = ?
 *     AND list = ? AND code = ? AND status = 'approved')`, which the
 *     unique index on `(federation_id, list, code)` serves.
 *   - `roleKeptOrApprovedSql(column, ...)`: the edit's condition, the
 *     link's current code or an approved one. A link keeps its code on
 *     an edit even when the list has deprecated it.
 *   - `isRoleApproved`: the same condition read on its own, for a writer
 *     that must refuse before it writes anything else (the decision
 *     ruling, which refuses before it mints a record).
 *   - `insertEntityLink` and `insertPlaceLink`: the inserts, written as
 *     `INSERT … SELECT … WHERE EXISTS (…)`. Each answers whether it wrote
 *     the row; a duplicate of an existing link is the unique index's
 *     error, which the pages report as a duplicate. Each is one literal
 *     statement, so the journal coverage scan
 *     (`tests/lib/journal-coverage.test.ts`) sees both.
 *   - `entityLinkInsertOrFail` and `placeLinkInsertOrFail`: the same
 *     insert as a statement for a caller's batch, which must fail the
 *     batch, and so every write in it, when the role is not approved.
 *     The role is written as `(select code from vocabulary_values …)`,
 *     which is NULL for a code the list does not approve, and the role
 *     column's NOT NULL constraint refuses the row; a duplicate of an
 *     existing link is ignored. `isRefusedLinkRole` tells that refusal
 *     from any other error.
 *
 * A caller that writes nothing answers with its page's generic refusal.
 *
 * @version v0.9.0
 */
import { sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { BatchItem } from "drizzle-orm/batch";
import { descriptionEntities, descriptionPlaces } from "../db/schema";

export type LinkRoleList = "entity_role" | "place_role";

/** Whether the federation's list holds the code approved, as a condition of the statement it is part of. */
export function roleApprovedSql(federationId: string, list: LinkRoleList, code: string): SQL {
  return sql`exists (select 1 from "vocabulary_values" where "federation_id" = ${federationId} and "list" = ${list} and "code" = ${code} and "status" = 'approved')`;
}

/** An edit's condition: the link holds the code already, or the federation's list approves it. */
export function roleKeptOrApprovedSql(column: SQLiteColumn, federationId: string, list: LinkRoleList, code: string): SQL {
  return sql`(${column} = ${code} or ${roleApprovedSql(federationId, list, code)})`;
}

/** The same condition, read on its own. */
export async function isRoleApproved(
  db: DrizzleD1Database<any>,
  federationId: string,
  list: LinkRoleList,
  code: string,
): Promise<boolean> {
  const row = await db.get<{ ok: number }>(sql`select ${roleApprovedSql(federationId, list, code)} as ok`);
  return Number(row?.ok) === 1;
}

export interface EntityLinkRow {
  id: string;
  descriptionId: string;
  entityId: string;
  role: string;
  roleNote?: string | null;
  roleRaw?: string | null;
  sequence?: number;
  honorific?: string | null;
  nameAsRecorded?: string | null;
  attributes?: string;
  createdAt: number;
}

export interface PlaceLinkRow {
  id: string;
  descriptionId: string;
  placeId: string;
  role: string;
  roleNote?: string | null;
  roleRaw?: string | null;
  createdAt: number;
}

/** Insert a description–entity link, only while the federation's list approves its role. */
export async function insertEntityLink(
  db: DrizzleD1Database<any>,
  federationId: string,
  row: EntityLinkRow,
): Promise<boolean> {
  const rows = await db.all<{ id: string }>(sql`INSERT INTO description_entities
    (id, description_id, entity_id, role, role_note, role_raw, sequence, honorific, name_as_recorded, attributes, created_at)
    SELECT ${row.id}, ${row.descriptionId}, ${row.entityId}, ${row.role}, ${row.roleNote ?? null}, ${row.roleRaw ?? null},
      ${row.sequence ?? 0}, ${row.honorific ?? null}, ${row.nameAsRecorded ?? null}, ${row.attributes ?? "{}"}, ${row.createdAt}
    WHERE ${roleApprovedSql(federationId, "entity_role", row.role)} RETURNING id`);
  return rows.length === 1;
}

/** Insert a description–place link, only while the federation's list approves its role. */
export async function insertPlaceLink(
  db: DrizzleD1Database<any>,
  federationId: string,
  row: PlaceLinkRow,
): Promise<boolean> {
  const rows = await db.all<{ id: string }>(sql`INSERT INTO description_places
    (id, description_id, place_id, role, role_note, role_raw, created_at)
    SELECT ${row.id}, ${row.descriptionId}, ${row.placeId}, ${row.role}, ${row.roleNote ?? null}, ${row.roleRaw ?? null}, ${row.createdAt}
    WHERE ${roleApprovedSql(federationId, "place_role", row.role)} RETURNING id`);
  return rows.length === 1;
}

/** The approved code itself, or NULL: the role a batch's insert writes. */
function approvedCodeSql(federationId: string, list: LinkRoleList, code: string): SQL {
  return sql`(select "code" from "vocabulary_values" where "federation_id" = ${federationId} and "list" = ${list} and "code" = ${code} and "status" = 'approved')`;
}

/** An entity link insert for a batch, failing the batch when the role is not approved. */
export function entityLinkInsertOrFail(db: DrizzleD1Database<any>, federationId: string, row: EntityLinkRow): BatchItem<"sqlite"> {
  return db
    .insert(descriptionEntities)
    .values({
      id: row.id,
      descriptionId: row.descriptionId,
      entityId: row.entityId,
      role: approvedCodeSql(federationId, "entity_role", row.role) as unknown as (typeof descriptionEntities.$inferInsert)["role"],
      roleNote: row.roleNote ?? null,
      roleRaw: row.roleRaw ?? null,
      sequence: row.sequence ?? 0,
      honorific: row.honorific ?? null,
      nameAsRecorded: row.nameAsRecorded ?? null,
      attributes: row.attributes ?? "{}",
      createdAt: row.createdAt,
    })
    .onConflictDoNothing();
}

/** A place link insert for a batch, failing the batch when the role is not approved. */
export function placeLinkInsertOrFail(db: DrizzleD1Database<any>, federationId: string, row: PlaceLinkRow): BatchItem<"sqlite"> {
  return db
    .insert(descriptionPlaces)
    .values({
      id: row.id,
      descriptionId: row.descriptionId,
      placeId: row.placeId,
      role: approvedCodeSql(federationId, "place_role", row.role) as unknown as (typeof descriptionPlaces.$inferInsert)["role"],
      roleNote: row.roleNote ?? null,
      roleRaw: row.roleRaw ?? null,
      createdAt: row.createdAt,
    })
    .onConflictDoNothing();
}

/** Whether an error is the refusal of `entityLinkInsertOrFail` or `placeLinkInsertOrFail`. */
export function isRefusedLinkRole(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth += 1) {
    const message = e instanceof Error ? e.message : String(e);
    if (/NOT NULL constraint failed: description_(entities|places)\.role/.test(message)) return true;
  }
  return false;
}

// @version v0.9.0
