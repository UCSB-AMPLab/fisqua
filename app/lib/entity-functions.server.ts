/**
 * Entity Functions
 *
 * This module deals with reading and writing an entity's functions,
 * the offices and occupations a person or body held. They live only in
 * `entity_functions`: one row per occurrence, in the order the rows were
 * entered (rowid). The `entities.functions` column is not read or
 * written. The publish export groups the rows into `{function, count}`
 * entries; the entity pages, the canonical CSV and the workspace JSON
 * show them one per line.
 *
 * `entityFunctionsReplacement` gives the statements that replace an
 * entity's set with a list of lines, for the caller to run in one
 * batch with its own update of the entity. A line matches an existing
 * row when it equals the row's trimmed text: the row keeps its id, its
 * other columns (honorific, dates, certainty, source, notes) and its
 * stored text. A line that matches none adds a row, a row that no line
 * matches is removed, and every row is entered again in the order of
 * the lines, so the rowid order is the order given.
 *
 * Every statement is conditional on the entity still holding the
 * version the caller read (`updated_at`), and the entity update the
 * caller puts last in the batch must be too: a save that loses a race
 * then changes nothing, and the caller tells it from the update's
 * changes count. The entity update also sets the new `updated_at`,
 * which the publish export compares before it completes entities.json.
 *
 * A record holds each function once (`./function-duplicates.ts`). A
 * save keeps only the editor's lines that add no function the record
 * keeps or adds already (`distinctFunctionLines`); a new entity's lines
 * and a split's copy are folded the same way.
 *
 * A merge moves the function rows of the entity merged away to the
 * survivor (`arrivingEntityFunctions`, planned by
 * `planFunctionArrivals`): a row of a function the survivor does not
 * hold keeps its id, its rowid and every other column, and only
 * `entity_id` changes (`movedEntityFunctions`); a row of a function the
 * survivor holds, or that an earlier row of the merge brought, fills the
 * held row's empty fields and is deleted. The merge's ledger row names
 * the rows moved (`movedFunctions`) and the rows folded, each in full
 * with the row it folded into and the fields it filled
 * (`foldedFunctions`), and `composeMergedFunctionsReturn` reads both to
 * give the rows back to the entity merged away and clear the fields
 * the fold filled. All are scoped like the merge's own statements: a
 * row moves only while both entities satisfy the scope the caller
 * passes.
 *
 * A merge composed in the app reads the loser's rows before its batch,
 * so the batch opens with `entitiesAsReadGuard`: the statement fails,
 * and D1 rolls the whole batch back, unless both records are still
 * unmerged, the loser still holds the version and the number of rows
 * read and the survivor the version read. After the moves, `entityLeftWithoutFunctionsGuard` fails the
 * batch unless the loser holds no rows, which catches a row replaced
 * without a change of version or count. Every save of an entity's
 * functions moves its `updated_at` past the version it read, so the
 * first guard catches any save that lands between the reads and the
 * batch; the second holds whatever the clock does. Either way no row is
 * left on the loser that the move does not name.
 * `entitiesStillAsRead` tells such a failure from any other by re-reading
 * the versions and the loser's row ids.
 *
 * A hard delete of an entity cascades to its function rows, so it runs
 * behind `entitiesAsReadGuard` on the version it read and
 * `entityNotMergeSurvivorGuard`: a record others were merged into is
 * not deleted, whether the merge landed before the delete read it or
 * between the reads and the batch.
 *
 * Every write that changes an entity's function rows or its merge state
 * gives it `nextVersion`: the clock, or one past the version read when
 * the clock has not passed it. A save that read the old version then
 * fails its version check whichever of the two lands first.
 *
 * A vocabulary merge or split moves many entities from one primary
 * function term to another in one statement. It reads the entities it
 * moves first (`readEntitiesOnTerm`), and its batch opens with
 * `entitiesOnTermAsReadGuards`: the statements fail the batch unless each
 * entity read still holds the version read and still names the term,
 * and, for a merge that moves every entity on the term, unless no other
 * entity within the scope has come to name it. The ids and versions go
 * as JSON parameters of at most `ENTITIES_PER_STATEMENT` entities each,
 * one statement per chunk, so no bound string reaches D1's size limit
 * however many entities move. `entitiesOnTermStillAsRead` evaluates the
 * same conditions, to tell such a failure from any other.
 *
 * @version v0.9.0
 */

import { and, eq, exists, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { authorityOperations, entities, entityFunctions } from "../db/schema";
import { distinctFunctionLines, foldFunctionRows, type FillableFunctionField, type FunctionFill } from "./function-duplicates";

export type EntityFunctionRow = typeof entityFunctions.$inferSelect;

/** Rows per INSERT: 13 values each and the two of the version check, within D1's 100 bound parameters. */
const ROWS_PER_INSERT = 7;

/** Entity ids per read of several entities' rows, within D1's 100 bound parameters. */
const IDS_PER_READ = 90;

/** Row ids per move, within D1's 100 bound parameters with the scope's. */
const IDS_PER_MOVE = 80;

/**
 * The functions a text field holds: one per line, trimmed. Blank and
 * whitespace-only lines are left out; they are not functions.
 */
export function functionLines(text: string | null | undefined): string[] {
  return (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** An entity's function rows, in the order they were entered. */
export async function readEntityFunctionRows(
  db: DrizzleD1Database<any>,
  entityId: string
): Promise<EntityFunctionRow[]> {
  return db
    .select()
    .from(entityFunctions)
    .where(eq(entityFunctions.entityId, entityId))
    .orderBy(sql`${entityFunctions}.rowid`)
    .all();
}

/** An entity's functions as the pages show them: one per line, or null when it has none. */
export function functionsText(rows: Array<{ function: string }>): string | null {
  return rows.length > 0 ? rows.map((r) => r.function).join("\n") : null;
}

/**
 * The functions of each of `entityIds`, one per line in entry order,
 * for the exports that show them as text. An entity with none is
 * absent from the map.
 */
export async function readFunctionsTextByEntity(
  db: DrizzleD1Database<any>,
  entityIds: string[]
): Promise<Map<string, string>> {
  const rowsByEntity = new Map<string, Array<{ function: string }>>();
  for (let i = 0; i < entityIds.length; i += IDS_PER_READ) {
    const rows = await db
      .select({ entityId: entityFunctions.entityId, function: entityFunctions.function })
      .from(entityFunctions)
      .where(inArray(entityFunctions.entityId, entityIds.slice(i, i + IDS_PER_READ)))
      .orderBy(entityFunctions.entityId, sql`${entityFunctions}.rowid`)
      .all();
    for (const r of rows) {
      const list = rowsByEntity.get(r.entityId) ?? [];
      list.push({ function: r.function });
      rowsByEntity.set(r.entityId, list);
    }
  }
  const out = new Map<string, string>();
  for (const [id, rows] of rowsByEntity) out.set(id, functionsText(rows)!);
  return out;
}

/** The entity still holds `version`. */
function atVersion(db: DrizzleD1Database<any>, entityId: string, version: number) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(entities)
      .where(and(eq(entities.id, entityId), eq(entities.updatedAt, version)))
  );
}

/**
 * The statements that insert `rows` for `entityId`, in the order given,
 * each only while the entity holds `version`.
 */
function insertRowsAtVersion(
  db: DrizzleD1Database<any>,
  entityId: string,
  rows: EntityFunctionRow[],
  version: number
): BatchItem<"sqlite">[] {
  const statements: BatchItem<"sqlite">[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const values = rows.slice(i, i + ROWS_PER_INSERT).map(
      (r, n) =>
        sql`(${r.id}, ${r.entityId}, ${r.honorific}, ${r.function}, ${r.dateStart}, ${r.dateEnd}, ${r.dateNote}, ${r.certainty}, ${r.source}, ${r.notes}, ${r.createdAt}, ${r.updatedAt}, ${i + n})`
    );
    // The columns in table order, which the INSERT names; column13 is
    // the position, which keeps the entry order.
    statements.push(
      db.insert(entityFunctions).select(
        sql`SELECT column1, column2, column3, column4, column5, column6, column7, column8, column9, column10, column11, column12 FROM (VALUES ${sql.join(values, sql`, `)}) WHERE EXISTS (SELECT 1 FROM ${entities} WHERE ${entities.id} = ${entityId} AND ${entities.updatedAt} = ${version}) ORDER BY column13`
      )
    );
  }
  return statements;
}

/**
 * The statements that make `lines` the entity's function rows while it
 * holds `version`, and `touch`, the update that moves it from `version`
 * to `now`. A caller that updates the entity itself puts its own update,
 * with the same version condition, last in the batch instead of
 * `touch`. When the lines equal the rows' trimmed text, in order, there
 * are no function statements.
 */
export function entityFunctionsReplacement(
  db: DrizzleD1Database<any>,
  entityId: string,
  lines: string[],
  existing: EntityFunctionRow[],
  version: number,
  now: number
): { functionStatements: BatchItem<"sqlite">[]; touch: BatchItem<"sqlite"> } {
  const touch = db
    .update(entities)
    .set({ updatedAt: now })
    .where(and(eq(entities.id, entityId), eq(entities.updatedAt, version)));
  // A line that would add a function the record keeps or adds already is dropped.
  lines = distinctFunctionLines(lines, existing);
  const unchanged =
    lines.length === existing.length && lines.every((line, i) => existing[i].function.trim() === line);
  if (unchanged) return { functionStatements: [], touch };

  // Each line takes the first unused existing row with its trimmed text.
  const unused = [...existing];
  const rows: EntityFunctionRow[] = lines.map((line) => {
    const at = unused.findIndex((r) => r.function.trim() === line);
    if (at >= 0) return unused.splice(at, 1)[0];
    return {
      id: crypto.randomUUID(),
      entityId,
      honorific: null,
      function: line,
      dateStart: null,
      dateEnd: null,
      dateNote: null,
      certainty: "probable",
      source: null,
      notes: null,
      createdAt: now,
      updatedAt: now,
    };
  });

  return {
    functionStatements: [
      db
        .delete(entityFunctions)
        .where(and(eq(entityFunctions.entityId, entityId), atVersion(db, entityId, version))),
      ...insertRowsAtVersion(db, entityId, rows, version),
    ],
    touch,
  };
}

/**
 * The statements that give a new entity `entityId` the function lines
 * of a form, for the batch that inserts it at `version`.
 */
export function newEntityFunctions(
  db: DrizzleD1Database<any>,
  entityId: string,
  lines: string[],
  version: number
): BatchItem<"sqlite">[] {
  return insertRowsAtVersion(
    db,
    entityId,
    distinctFunctionLines(lines, []).map((line) => ({
      id: crypto.randomUUID(),
      entityId,
      honorific: null,
      function: line,
      dateStart: null,
      dateEnd: null,
      dateNote: null,
      certainty: "probable",
      source: null,
      notes: null,
      createdAt: version,
      updatedAt: version,
    })),
    version
  );
}

/**
 * The statements that copy `rows`, another entity's function rows in
 * entry order, to `entityId`, new ids and all other columns kept, for
 * the batch that inserts it at `version`.
 */
export function copiedEntityFunctions(
  db: DrizzleD1Database<any>,
  entityId: string,
  rows: EntityFunctionRow[],
  version: number
): BatchItem<"sqlite">[] {
  // The source's own duplicates fold into their first row, which takes their empty fields.
  const { after } = foldFunctionRows([], rows);
  return insertRowsAtVersion(
    db,
    entityId,
    after.map((r) => ({ ...r, id: crypto.randomUUID(), entityId })),
    version
  );
}

/**
 * The statements that move the rows `rowIds` from entity `fromId` to
 * entity `toId`, ids and all other columns kept. A row moves only
 * while it is still `fromId`'s and both entities satisfy `scope`, the
 * predicate on `entities` the caller's own merge statements carry.
 */
export function movedEntityFunctions(
  db: DrizzleD1Database<any>,
  fromId: string,
  toId: string,
  rowIds: string[],
  scope: SQL | undefined
): BatchItem<"sqlite">[] {
  const inScope = (id: string) =>
    exists(
      db
        .select({ one: sql`1` })
        .from(entities)
        .where(and(scope, eq(entities.id, id)))
    );
  const statements: BatchItem<"sqlite">[] = [];
  for (let i = 0; i < rowIds.length; i += IDS_PER_MOVE) {
    statements.push(
      db
        .update(entityFunctions)
        .set({ entityId: toId })
        .where(
          and(
            eq(entityFunctions.entityId, fromId),
            inArray(entityFunctions.id, rowIds.slice(i, i + IDS_PER_MOVE)),
            inScope(fromId),
            inScope(toId)
          )
        )
    );
  }
  return statements;
}

/** A row a merge folds into a row the survivor holds: the row in full, the row it folds into and the fields it fills. */
export interface FoldedFunction {
  row: EntityFunctionRow;
  into: string;
  filled: Partial<Record<FillableFunctionField, string>>;
  /** The fields the row and the held row both hold with different values, certainty among them; the held value stays. */
  conflicts: FunctionFill["conflicts"];
}

/** What a merge does with the loser's rows: those that move, those that fold, and the survivor's rows after. */
export interface FunctionArrivals {
  moved: string[];
  folded: FoldedFunction[];
  /** The fields each held row takes, all folds into it together. */
  fills: Map<string, Partial<Record<FillableFunctionField, string>>>;
  /** For each folded row by id: the fields it and the row it folds into both hold, with different values; the held value stays. */
  conflicts: Map<string, FunctionFill["conflicts"]>;
  after: EntityFunctionRow[];
}

/**
 * How the rows `incoming`, in entry order, arrive on a survivor holding
 * `held`: a row of a function the survivor does not hold by then moves;
 * any other folds into the row of that function, filling its empty
 * fields (`foldFunctionRows`).
 */
export function planFunctionArrivals(
  held: readonly EntityFunctionRow[],
  incoming: readonly EntityFunctionRow[]
): FunctionArrivals {
  const { arrive, folded, after } = foldFunctionRows(held, incoming);
  const fills = new Map<string, Partial<Record<FillableFunctionField, string>>>();
  for (const f of folded) {
    if (Object.keys(f.set).length > 0) fills.set(f.into, { ...(fills.get(f.into) ?? {}), ...f.set });
  }
  return {
    moved: arrive.map((r) => r.id),
    folded: folded.map((f) => ({ row: f.row, into: f.into, filled: f.set, conflicts: f.conflicts })),
    fills,
    conflicts: new Map(folded.filter((f) => f.conflicts.length > 0).map((f) => [f.row.id, f.conflicts])),
    after,
  };
}

/**
 * The statements that carry out `arrivals` from `fromId` to `toId`:
 * the moves first (`movedEntityFunctions`), then each fill of a row the
 * survivor holds by then, which also takes `now` as the row's
 * `updated_at`, then the deletes of the rows folded. Each runs only
 * while both entities satisfy `scope`.
 */
export function arrivingEntityFunctions(
  db: DrizzleD1Database<any>,
  fromId: string,
  toId: string,
  arrivals: FunctionArrivals,
  scope: SQL | undefined,
  now: number
): BatchItem<"sqlite">[] {
  const inScope = (id: string) =>
    exists(
      db
        .select({ one: sql`1` })
        .from(entities)
        .where(and(scope, eq(entities.id, id)))
    );
  const statements = movedEntityFunctions(db, fromId, toId, arrivals.moved, scope);
  for (const [into, set] of arrivals.fills) {
    statements.push(
      db
        .update(entityFunctions)
        .set({ ...set, updatedAt: now })
        .where(and(eq(entityFunctions.id, into), eq(entityFunctions.entityId, toId), inScope(fromId), inScope(toId)))
    );
  }
  const ids = arrivals.folded.map((f) => f.row.id);
  for (let i = 0; i < ids.length; i += IDS_PER_MOVE) {
    statements.push(
      db
        .delete(entityFunctions)
        .where(
          and(
            eq(entityFunctions.entityId, fromId),
            inArray(entityFunctions.id, ids.slice(i, i + IDS_PER_MOVE)),
            inScope(fromId),
            inScope(toId)
          )
        )
    );
  }
  return statements;
}

/** The version rule every record write uses, defined once in record-version.server.ts. */
export { nextVersion } from "./record-version.server";

/**
 * An entity as a merge read it: its version, whether it must still be
 * unmerged (`merged_into` NULL) and, when given, the ids of its function
 * rows.
 */
export interface EntityAsRead {
  id: string;
  version: number;
  unmerged?: boolean;
  functionIds?: string[];
}

/** json() of text that is not JSON raises the error that fails the batch. */
const failUnless = (condition: SQL, message: string) =>
  sql<number>`CASE WHEN ${condition} THEN 1 ELSE json(${sql.raw(`'${message}'`)}) END`;

/**
 * The statement that fails the batch it is in unless every entity of
 * `read` still holds the version read, is still unmerged where that is
 * asked, and, where ids are given, holds as many function rows. D1 runs
 * a batch as one transaction, so the failure leaves nothing of it
 * written. Two bound parameters per check, one for the unmerged check.
 */
export function entitiesAsReadGuard(db: DrizzleD1Database<any>, read: EntityAsRead[]): BatchItem<"sqlite"> {
  const checks = read.flatMap((e) => [
    sql`(SELECT ${entities.updatedAt} FROM ${entities} WHERE ${entities.id} = ${e.id}) = ${e.version}`,
    ...(e.unmerged
      ? [sql`(SELECT ${entities.mergedInto} FROM ${entities} WHERE ${entities.id} = ${e.id}) IS NULL`]
      : []),
    ...(e.functionIds === undefined
      ? []
      : [sql`(SELECT count(*) FROM ${entityFunctions} WHERE ${entityFunctions.entityId} = ${e.id}) = ${e.functionIds.length}`]),
  ]);
  return db
    .select({ asRead: failUnless(sql.join(checks, sql` AND `), "an entity changed since it was read") })
    .from(sql`(SELECT 1)`);
}

/**
 * The statement that fails the batch it is in unless `entityId` holds no
 * function rows: put after a merge's moves, it fails the merge when the
 * loser holds a row the moves did not name. One bound parameter.
 */
export function entityLeftWithoutFunctionsGuard(db: DrizzleD1Database<any>, entityId: string): BatchItem<"sqlite"> {
  return db
    .select({
      empty: failUnless(
        sql`NOT EXISTS (SELECT 1 FROM ${entityFunctions} WHERE ${entityFunctions.entityId} = ${entityId})`,
        "a function row was left on the merged entity",
      ),
    })
    .from(sql`(SELECT 1)`);
}

/**
 * The statement that fails the batch it is in unless no entity names
 * `entityId` in its `merged_into`: put before a hard delete, it fails
 * the delete of a record others were merged into, whose foreign-key
 * cascade would take the function rows the merges moved onto it and
 * leave the merged records pointing at nothing. One bound parameter.
 */
export function entityNotMergeSurvivorGuard(db: DrizzleD1Database<any>, entityId: string): BatchItem<"sqlite"> {
  return db
    .select({
      notSurvivor: failUnless(
        sql`NOT EXISTS (SELECT 1 FROM ${entities} WHERE ${entities.mergedInto} = ${entityId})`,
        "the entity is the survivor of a merge",
      ),
    })
    .from(sql`(SELECT 1)`);
}

/** Whether any entity names `entityId` in its `merged_into`. */
export async function isMergeSurvivor(db: DrizzleD1Database<any>, entityId: string): Promise<boolean> {
  const row = await db
    .select({ id: entities.id })
    .from(entities)
    .where(eq(entities.mergedInto, entityId))
    .limit(1)
    .get();
  return row !== undefined;
}

/** Whether every entity of `read` still holds the version, the unmerged state and the function row ids read. */
export async function entitiesStillAsRead(db: DrizzleD1Database<any>, read: EntityAsRead[]): Promise<boolean> {
  for (const e of read) {
    const row = await db
      .select({ updatedAt: entities.updatedAt, mergedInto: entities.mergedInto })
      .from(entities)
      .where(eq(entities.id, e.id))
      .get();
    if (!row || row.updatedAt !== e.version) return false;
    if (e.unmerged && row.mergedInto !== null) return false;
    if (e.functionIds !== undefined) {
      const held = (
        await db
          .select({ id: entityFunctions.id })
          .from(entityFunctions)
          .where(eq(entityFunctions.entityId, e.id))
          .all()
      )
        .map((r) => r.id)
        .sort();
      const wanted = [...e.functionIds].sort();
      if (held.length !== wanted.length || held.some((id, i) => id !== wanted[i])) return false;
    }
  }
  return true;
}

/**
 * The ids of the function rows the merges of `loserId` into
 * `survivorId` moved, in the order moved, as their ledger rows name
 * them (`detail.movedFunctions`). Function-carry rows count here: each
 * names rows it moved from `loserId` to `survivorId`.
 */
export async function mergeMovedFunctionIds(
  db: DrizzleD1Database<any>,
  federationId: string,
  loserId: string,
  survivorId: string
): Promise<string[]> {
  const ids: string[] = [];
  for (const detail of await mergeDetails(db, federationId, loserId, survivorId)) {
    const moved = detail?.movedFunctions;
    if (Array.isArray(moved)) {
      for (const id of moved) if (typeof id === "string" && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/**
 * The rows the merges of `loserId` into `survivorId` folded into rows
 * the survivor held, as their ledger rows give them
 * (`detail.foldedFunctions`), in the order folded.
 */
export async function mergeFoldedFunctions(
  db: DrizzleD1Database<any>,
  federationId: string,
  loserId: string,
  survivorId: string
): Promise<FoldedFunction[]> {
  const out: FoldedFunction[] = [];
  for (const detail of await mergeDetails(db, federationId, loserId, survivorId)) {
    const folded = detail?.foldedFunctions;
    if (!Array.isArray(folded)) continue;
    for (const f of folded) {
      if (f && typeof f === "object" && f.row && typeof f.row.id === "string" && typeof f.into === "string") {
        if (!out.some((x) => x.row.id === f.row.id)) out.push({ row: f.row, into: f.into, filled: f.filled ?? {}, conflicts: f.conflicts ?? [] });
      }
    }
  }
  return out;
}

/** The parsed details of the merge ledger rows of `loserId` into `survivorId`, oldest first. */
async function mergeDetails(
  db: DrizzleD1Database<any>,
  federationId: string,
  loserId: string,
  survivorId: string
): Promise<any[]> {
  const rows = await db
    .select({ detail: authorityOperations.detail })
    .from(authorityOperations)
    .where(
      and(
        eq(authorityOperations.federationId, federationId),
        eq(authorityOperations.recordType, "entity"),
        eq(authorityOperations.operation, "merge"),
        eq(authorityOperations.sourceId, loserId),
        eq(authorityOperations.targetId, survivorId)
      )
    )
    .orderBy(authorityOperations.createdAt)
    .all();
  return rows.map((r) => {
    try {
      return r.detail ? JSON.parse(r.detail) : null;
    } catch {
      return null;
    }
  });
}

/**
 * The statements that reverse the function moves of the merges of
 * `loserId` into `survivorId`: the rows their ledger rows name go back
 * to the loser, if the survivor still holds them; each row they folded
 * is entered on the loser again, in full under its own id, unless a row
 * of that id exists, and each field the fold filled on a survivor's row
 * is cleared while it still holds the value filled, before any row moves
 * back, so a moved loser row that a fold filled gets its own value back
 * too; both entities take
 * `now` as their `updated_at`. Rows the survivor held of its own, or
 * gained later, stay.
 */
export async function composeMergedFunctionsReturn(
  db: DrizzleD1Database<any>,
  args: {
    federationId: string;
    loserId: string;
    survivorId: string;
    scope: SQL | undefined;
    now: number;
  }
): Promise<BatchItem<"sqlite">[]> {
  const ids = await mergeMovedFunctionIds(db, args.federationId, args.loserId, args.survivorId);
  const folded = await mergeFoldedFunctions(db, args.federationId, args.loserId, args.survivorId);
  const inScope = (id: string) =>
    sql`EXISTS (SELECT 1 FROM ${entities} WHERE ${and(args.scope, eq(entities.id, id))})`;
  const returned: BatchItem<"sqlite">[] = folded.map(({ row: r }) =>
    db.insert(entityFunctions).select(
      sql`SELECT column1, column2, column3, column4, column5, column6, column7, column8, column9, column10, column11, column12 FROM (VALUES (${r.id}, ${args.loserId}, ${r.honorific ?? null}, ${r.function}, ${r.dateStart ?? null}, ${r.dateEnd ?? null}, ${r.dateNote ?? null}, ${r.certainty ?? null}, ${r.source ?? null}, ${r.notes ?? null}, ${r.createdAt}, ${r.updatedAt})) WHERE ${inScope(args.loserId)} AND ${inScope(args.survivorId)} AND NOT EXISTS (SELECT 1 FROM ${entityFunctions} WHERE ${entityFunctions.id} = ${r.id})`
    )
  );
  const cleared: BatchItem<"sqlite">[] = folded.flatMap((f) =>
    (Object.entries(f.filled) as Array<[FillableFunctionField, string]>).map(([field, value]) =>
      db
        .update(entityFunctions)
        .set({ [field]: null })
        .where(
          and(
            eq(entityFunctions.id, f.into),
            eq(entityFunctions.entityId, args.survivorId),
            eq(entityFunctions[field], value),
            exists(db.select({ one: sql`1` }).from(entities).where(and(args.scope, eq(entities.id, args.survivorId))))
          )
        )
    )
  );
  // The fills are cleared first, while every row they filled is still the survivor's: a loser row
  // that moved may have taken a field from a duplicate folded into it.
  return [
    ...cleared,
    ...movedEntityFunctions(db, args.survivorId, args.loserId, ids, args.scope),
    ...returned,
    db
      .update(entities)
      .set({ updatedAt: args.now })
      .where(and(args.scope, inArray(entities.id, [args.loserId, args.survivorId]))),
  ];
}

/** An entity as a vocabulary merge or split read it: its id and version. */
export interface EntityVersionAsRead {
  id: string;
  version: number;
}

/**
 * The most entities one guard or move statement names. Each goes into a
 * bound JSON parameter as its id and version, about 55 bytes, so a chunk
 * stays far below D1's 2,000,000-byte limit on a bound string however
 * many entities a term holds.
 */
export const ENTITIES_PER_STATEMENT = 2000;

/** `items` in runs of at most `ENTITIES_PER_STATEMENT`. */
export function entityChunks<T>(items: T[]): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += ENTITIES_PER_STATEMENT) {
    chunks.push(items.slice(i, i + ENTITIES_PER_STATEMENT));
  }
  return chunks;
}

/**
 * The entities within `scope` whose primary function is `termId`, with
 * their versions; when `ids` is given, only those of them, each once
 * however often it is repeated. The ids go in chunks, one JSON parameter
 * each.
 */
export async function readEntitiesOnTerm(
  db: DrizzleD1Database<any>,
  termId: string,
  scope: SQL | undefined,
  ids?: string[]
): Promise<EntityVersionAsRead[]> {
  const read = (only?: string[]) =>
    db
      .select({ id: entities.id, version: entities.updatedAt })
      .from(entities)
      .where(
        and(
          scope,
          eq(entities.primaryFunctionId, termId),
          only === undefined
            ? undefined
            : sql`${entities.id} IN (SELECT value FROM json_each(${JSON.stringify(only)}))`
        )
      )
      .all();
  if (ids === undefined) return read();
  const rows: EntityVersionAsRead[] = [];
  // A repeated id is read once, as one `IN` over the whole list would.
  for (const chunk of entityChunks([...new Set(ids)])) rows.push(...(await read(chunk)));
  return rows;
}

/** The ids and versions of `read` as the JSON a guard binds. */
const versionPairs = (read: EntityVersionAsRead[]) => JSON.stringify(read.map((r) => [r.id, r.version]));

/**
 * Whether each entity of `chunk`, at most `ENTITIES_PER_STATEMENT` of
 * them, still holds the version read and names `termId`.
 */
function chunkOnTermAsRead(termId: string, chunk: EntityVersionAsRead[]): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM json_each(${versionPairs(chunk)}) r
    WHERE NOT EXISTS (
      SELECT 1 FROM ${entities}
      WHERE ${entities.id} = json_extract(r.value, '$[0]')
        AND ${entities.updatedAt} = json_extract(r.value, '$[1]')
        AND ${entities.primaryFunctionId} = ${termId}
    )
  )`;
}

/** Whether the entities within `whole` naming `termId` number `count`. */
function termCountAsRead(termId: string, count: number, whole: SQL): SQL {
  return sql`(SELECT count(*) FROM ${entities} WHERE ${whole} AND ${entities.primaryFunctionId} = ${termId}) = ${count}`;
}

/**
 * The conditions that together hold when each entity of `read` still
 * holds the version read and names `termId`, and, when `whole` is given,
 * the entities within that scope naming `termId` are still exactly those
 * read: one per chunk of `read`, and the count when `whole` is given.
 * Since each entity read must still name the term, an equal count means
 * no other entity has come to name it.
 */
function entitiesOnTermAsRead(termId: string, read: EntityVersionAsRead[], whole?: SQL): SQL[] {
  const conditions = entityChunks(read).map((chunk) => chunkOnTermAsRead(termId, chunk));
  if (whole !== undefined) conditions.push(termCountAsRead(termId, read.length, whole));
  return conditions;
}

/**
 * The condition naming the entities of `chunk`, at most
 * `ENTITIES_PER_STATEMENT` of them, for a statement that moves exactly
 * those. One bound parameter. A move of more entities takes one
 * statement per `entityChunks` chunk.
 */
export function entityIdsRead(chunk: EntityVersionAsRead[]): SQL {
  return sql`${entities.id} IN (SELECT json_extract(value, '$[0]') FROM json_each(${versionPairs(chunk)}))`;
}

/**
 * The statements that fail the batch they are in unless each entity of
 * `read` still holds the version read and names `termId` as its primary
 * function, and, when `whole` is given, no other entity within that
 * scope names it. One statement per chunk of `read`, and one for the
 * count when `whole` is given.
 */
export function entitiesOnTermAsReadGuards(
  db: DrizzleD1Database<any>,
  termId: string,
  read: EntityVersionAsRead[],
  whole?: SQL
): BatchItem<"sqlite">[] {
  return entitiesOnTermAsRead(termId, read, whole).map((condition) =>
    db
      .select({ asRead: failUnless(condition, "an entity changed since it was read") })
      .from(sql`(SELECT 1)`)
  );
}

/** Whether `entitiesOnTermAsReadGuards` of the same arguments would all pass now. */
export async function entitiesOnTermStillAsRead(
  db: DrizzleD1Database<any>,
  termId: string,
  read: EntityVersionAsRead[],
  whole?: SQL
): Promise<boolean> {
  for (const condition of entitiesOnTermAsRead(termId, read, whole)) {
    const row = await db
      .select({ asRead: sql<number>`CASE WHEN ${condition} THEN 1 ELSE 0 END` })
      .from(sql`(SELECT 1)`)
      .get();
    if (row?.asRead !== 1) return false;
  }
  return true;
}

// @version v0.9.0
