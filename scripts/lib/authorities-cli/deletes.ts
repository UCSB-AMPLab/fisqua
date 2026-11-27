/**
 * Scripts — deleting records in the command line's authority changes
 *
 * This module reads, plans and writes the two operations of a change
 * file (`./change-file.ts`) that delete a whole record: `delete-entity`
 * and `delete-place`. `./plan.ts` calls it for those rows, and
 * `./statements.ts` places its statements last in the one SQL file.
 * What is written is what the record page's delete writes
 * (`case "delete"` in `app/routes/_auth.admin.entities.$id.tsx` and
 * `app/routes/_auth.admin.places.$id.tsx`): the record's row is
 * deleted, as read and in scope, and one `authority_operations` row of
 * operation `delete` records it, its `source_id` the record's id, its
 * `target_id` NULL and its `detail` `{ snapshot }`, the record's full
 * row by Drizzle key, so the delete can be reconstructed. No changelog
 * row is written, as the page writes none. A deleted entity that held a
 * primary function has the function's term recounted.
 *
 * A row names the record by `authority_code` (its code) and
 * `authority_name` (an entity's display name, a place's label, compared
 * after NFC and trimming). It is refused when the record is not found in
 * the federation, is owned by another tenant or merged away, when the
 * name differs, when it is the survivor of a merge (another record names
 * it in `merged_into`), and when deleting it would take or orphan
 * anything: an entity that holds a link to any description, of any
 * tenant (a document link or a relation side: both are rows of
 * `description_entities`, whose foreign key would refuse the delete), or
 * any function row (`entity_functions` cascades on delete, so the rows
 * would go without a trace); a place that holds a link to any
 * description (`description_places`), or that another place names as its
 * parent (`parent_id` has no foreign key, and the child would name a
 * place that is gone). The page refuses the links and the survivor; this
 * module refuses the functions and the children besides.
 *
 * A record a delete row names may be named by no other row of the file,
 * in any column, and by no second delete row. A file therefore cannot
 * drop a record's links and delete it: every link row names its source
 * in `authority_code`, and a rerun of the file finds no record under
 * that code once it is deleted, so the link rows would read back refused.
 * Drop or move the links in one file, apply it, and delete the record in
 * a later one.
 *
 * Rerun. The ledger row's id is made from the federation, the tenant,
 * the file's name, the operation and the record's code (`newRecordId`),
 * so a run of the same file again finds it. A row is "already deleted"
 * when no record has the code, the ledger row of this file is there, of
 * the row's record type and operation `delete`, in the federation, its
 * snapshot holding the code and the name the row gives, and no record of
 * the table has the id it names. A ledger row of this file while the
 * record is still there, or one recording anything else, refuses the row.
 *
 * Guards. The SQL file opens with guards that each record to delete
 * holds every column as read; that it holds no description link, no
 * function row (an entity) and no child (a place) and is no merge's
 * survivor, all in any tenant; that each ledger id the file writes is
 * absent; and, for a row found done, that its ledger row is as read, and
 * that neither its record's id nor its code is in the table again. Each
 * delete names the record's id, federation, owner (NULL or the acting
 * tenant) and version as read. The file closes with guards that each
 * record deleted is gone and each ledger row is there.
 *
 * @version v0.9.0
 */

import { getTableColumns } from "drizzle-orm";
import { authorityOperations, entities, places } from "../../../app/db/schema";
import { newRecordId, recountStatement, type RowReader } from "../authority-links";
import { chunks, composer, guard, idList, matchingGuards, render, storedValue, typed } from "../authority-merges";
import { blank, sameName, text } from "../entity-splits";
import { escapeSql } from "../sql";
import { DELETE_OPS, KEYED_OPS, PLACE_OPS, targetCodes, type ChangeRow, type Op } from "./change-file";
import { appendAll } from "../arrays";

type Stored = Record<string, string | number | null>;
type Kind = "entity" | "place";

export type DeleteStatus = "delete entity" | "delete place" | "already deleted entity" | "already deleted place";

/** The namespace of the ids of the ledger rows the deletes write (`newRecordId`). */
export const DELETE_LEDGER_NAMESPACE = "authorities-delete-ledger";

/** The id of the ledger row a delete row writes: made from the file's name, the operation and the record's code. */
export function deleteLedgerId(federationId: string, tenantId: string, file: string, op: string, code: string): Promise<string> {
  return newRecordId(federationId, tenantId, file, `${op}|${code}`, DELETE_LEDGER_NAMESPACE);
}

/** The columns of a ledger row the plan reads and guards. */
export const DELETE_LEDGER_READ = ["id", "federation_id", "record_type", "operation", "source_id", "target_id", "detail"] as const;

/** Each kind's table: its name, its Drizzle table, its code column, and the columns of its links and children. */
const TABLES = {
  entity: { table: "entities", drizzle: entities, code: "entity_code", name: "display_name", links: "description_entities", pointer: "entity_id" },
  place: { table: "places", drizzle: places, code: "place_code", name: "label", links: "description_places", pointer: "place_id" },
} as const;

/** Every column of a table, by Drizzle key: its SQL name, and whether Drizzle reads it as a boolean. */
function columnsOf(kind: Kind): Array<{ key: string; name: string; boolean: boolean }> {
  return Object.entries(getTableColumns(TABLES[kind].drizzle) as Record<string, { name: string; columnType: string }>)
    .map(([key, c]) => ({ key, name: c.name, boolean: c.columnType === "SQLiteBoolean" }));
}

const kindOf = (op: string): Kind => (op === "delete-place" ? "place" : "entity");
const isDelete = (r: ChangeRow) => (DELETE_OPS as readonly string[]).includes(r.cells.op);
const where = (r: ChangeRow) => `${r.file} line ${r.line}`;
const keyOf = (op: string, code: string) => `${op}|${code}`;

async function readIn(rows: RowReader, ids: string[], query: (part: string) => string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const part of chunks([...new Set(ids)].filter(Boolean), 100)) appendAll(out, await rows(query(idList(part))));
  return out;
}

// ---------------------------------------------------------------------------
// What is read
// ---------------------------------------------------------------------------

export interface DeletesState {
  /** The federation's records of each code a delete row names, every column read. */
  records: Record<Kind, Map<string, Stored>>;
  /** For each record read: its description links, of any tenant. */
  links: Map<string, number>;
  /** For each entity read: its function rows. */
  functions: Map<string, number>;
  /** For each place read: the places that name it as their parent. */
  children: Map<string, number>;
  /** The records read that another names in `merged_into`. */
  survivors: Set<string>;
  /** `op|code` → the id of the ledger row the row writes. */
  ledgerIds: Map<string, string>;
  /** Of those ids, the ledger rows found, as read (`DELETE_LEDGER_READ`). */
  ledger: Map<string, Stored>;
  /** Of the records those ledger rows name, the ids a table still holds. */
  stillThere: Set<string>;
}

/** Reads the records the delete rows name, what would stop each delete, and the ledger rows an earlier run wrote. */
export async function readDeletesState(
  rows: RowReader,
  input: { file: string; rows: ChangeRow[] },
  scope: { tenantId: string; federationId: string },
): Promise<DeletesState> {
  const state: DeletesState = {
    records: { entity: new Map(), place: new Map() }, links: new Map(), functions: new Map(), children: new Map(), survivors: new Set(),
    ledgerIds: new Map(), ledger: new Map(), stillThere: new Set(),
  };
  const deletes = input.rows.filter(isDelete);
  if (deletes.length === 0) return state;
  const F = escapeSql(scope.federationId);
  const count = (into: Map<string, number>) => (r: Record<string, unknown>) => into.set(String(r.id), Number(r.n));
  for (const kind of ["entity", "place"] as const) {
    const t = TABLES[kind];
    const codes = deletes.filter((r) => kindOf(r.cells.op) === kind).map((r) => r.cells.authority_code);
    const columns = columnsOf(kind).map((c) => c.name);
    for (const r of await readIn(rows, codes, (p) => `SELECT ${typed(columns)} FROM ${t.table} WHERE federation_id = ${F} AND ${t.code} IN (${p})`)) {
      const s: Stored = Object.fromEntries(columns.map((c) => [c, storedValue(r, c)]));
      state.records[kind].set(text(s[t.code]), s);
    }
    const ids = [...state.records[kind].values()].map((s) => text(s.id));
    for (const r of await readIn(rows, ids, (p) => `SELECT ${t.pointer} AS id, count(*) AS n FROM ${t.links} WHERE ${t.pointer} IN (${p}) GROUP BY ${t.pointer}`)) {
      count(state.links)(r);
    }
    for (const r of await readIn(rows, ids, (p) => `SELECT DISTINCT merged_into AS id FROM ${t.table} WHERE merged_into IN (${p})`)) state.survivors.add(String(r.id));
    if (kind === "entity") {
      for (const r of await readIn(rows, ids, (p) => `SELECT entity_id AS id, count(*) AS n FROM entity_functions WHERE entity_id IN (${p}) GROUP BY entity_id`)) {
        count(state.functions)(r);
      }
    } else {
      for (const r of await readIn(rows, ids, (p) => `SELECT parent_id AS id, count(*) AS n FROM places WHERE parent_id IN (${p}) GROUP BY parent_id`)) {
        count(state.children)(r);
      }
    }
  }
  for (const r of deletes) {
    const k = keyOf(r.cells.op, r.cells.authority_code);
    if (r.cells.authority_code !== "" && !state.ledgerIds.has(k)) {
      state.ledgerIds.set(k, await deleteLedgerId(scope.federationId, scope.tenantId, input.file, r.cells.op, r.cells.authority_code));
    }
  }
  for (const r of await readIn(rows, [...state.ledgerIds.values()], (p) => `SELECT ${typed(DELETE_LEDGER_READ)} FROM authority_operations WHERE id IN (${p})`)) {
    const s: Stored = Object.fromEntries(DELETE_LEDGER_READ.map((c) => [c, storedValue(r, c)]));
    state.ledger.set(text(s.id), s);
  }
  for (const kind of ["entity", "place"] as const) {
    const named = [...state.ledger.values()].filter((x) => text(x.record_type) === kind).map((x) => text(x.source_id));
    for (const r of await readIn(rows, named, (p) => `SELECT id FROM ${TABLES[kind].table} WHERE id IN (${p})`)) state.stillThere.add(String(r.id));
  }
  return state;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface DeletePlan {
  row: ChangeRow;
  kind: Kind;
  status: DeleteStatus;
  id: string;
  code: string;
  /** The record's row as read, by column. */
  record: Stored;
  ledgerId: string;
  /** The ledger row's snapshot: the record's row by Drizzle key, as the record page's delete writes it. */
  snapshot: Record<string, unknown>;
}

export interface DeletesPlan {
  rows: DeletePlan[];
  /** The ledger rows of the rows found done, as read, with the code and table each names. */
  done: Array<{ kind: Kind; code: string; ledger: Stored }>;
}

/** The snapshot of a record's row, by Drizzle key, as Drizzle reads it. */
function snapshotOf(kind: Kind, s: Stored): Record<string, unknown> {
  return Object.fromEntries(columnsOf(kind).map((c) => [c.key, c.boolean && s[c.name] !== null ? Boolean(s[c.name]) : s[c.name]]));
}

/** The snapshot a ledger row's detail holds, or null. */
function ledgerSnapshot(x: Stored): Record<string, unknown> | null {
  try {
    const d = JSON.parse(text(x.detail));
    return d && typeof d === "object" && d.snapshot && typeof d.snapshot === "object" ? d.snapshot : null;
  } catch {
    return null;
  }
}

/** The codes of the records each row of the file names, entity and place, with the line that names each first. */
function namedByRows(rows: ChangeRow[]): Record<Kind, Map<string, number>> {
  const out: Record<Kind, Map<string, number>> = { entity: new Map(), place: new Map() };
  const name = (kind: Kind, code: string, line: number) => {
    if (code && code !== "NULL" && !code.startsWith("new:") && !out[kind].has(code)) out[kind].set(code, line);
  };
  for (const r of rows) {
    const c = r.cells;
    if (isDelete(r)) continue;
    const onPlace = (PLACE_OPS as readonly string[]).includes(c.op) || c.op === "move-place-link" || c.op === "drop-place-link";
    const kind: Kind = onPlace ? "place" : "entity";
    if (!(KEYED_OPS as readonly Op[]).includes(c.op as Op)) name(kind, c.authority_code, r.line);
    for (const t of targetCodes(r)) name(kind, t, r.line);
    for (const code of [c.entity, c.a_entity, c.b_entity]) name("entity", code, r.line);
    name("place", c.place, r.line);
    name("place", c.parent, r.line);
  }
  return out;
}

/** Checks the delete rows against what was read and plans each. */
export function planDeletes(
  input: { file: string; rows: ChangeRow[] },
  state: DeletesState,
  ctx: { tenantId: string; federationId: string },
  refuse: (where: string, reason: string) => void,
  /** Every row of the file, for the records other rows name. */
  all: ChangeRow[],
): { plan: DeletesPlan; statuses: Map<ChangeRow, DeleteStatus | "refused"> } {
  const statuses = new Map<ChangeRow, DeleteStatus | "refused">();
  const plan: DeletesPlan = { rows: [], done: [] };
  const named = namedByRows(all);
  const deleted = new Map<string, number>();
  for (const r of input.rows) {
    if (!isDelete(r)) continue;
    statuses.set(r, "refused");
    const c = r.cells;
    const no = (reason: string) => refuse(where(r), reason);
    const kind = kindOf(c.op);
    const t = TABLES[kind];
    const what = kind === "entity" ? "entity" : "place";
    if (c.authority_code === "") { no(`${c.op} names no authority_code`); continue; }
    const twice = deleted.get(`${kind}|${c.authority_code}`);
    if (twice !== undefined) { no(`${c.authority_code} is deleted by line ${twice} as well`); continue; }
    deleted.set(`${kind}|${c.authority_code}`, r.line);
    const by = named[kind].get(c.authority_code);
    if (by !== undefined) {
      no(`${c.authority_code} is named by line ${by}, so the file may not also delete it; apply that row in one file and delete the ${what} in a later one`);
      continue;
    }
    const ledgerId = state.ledgerIds.get(keyOf(c.op, c.authority_code))!;
    const ledger = state.ledger.get(ledgerId);
    const s = state.records[kind].get(c.authority_code);

    if (!s) {
      if (!ledger) { no(`no ${what} has the code ${c.authority_code} in the federation`); continue; }
      // Done before: this file's ledger row records the deletion of the record the row names, which is gone.
      const snap = ledgerSnapshot(ledger);
      const codeKey = kind === "entity" ? "entityCode" : "placeCode";
      const nameKey = kind === "entity" ? "displayName" : "label";
      const problem =
        text(ledger.record_type) !== kind || text(ledger.operation) !== "delete" || text(ledger.federation_id) !== ctx.federationId || !blank(ledger.target_id)
          ? "records another operation"
          : !snap || text(snap[codeKey]) !== c.authority_code || text(snap.id) !== text(ledger.source_id)
            ? `does not record the deletion of ${c.authority_code}`
            : !sameName(c.authority_name, text(snap[nameKey]))
              ? `records the deletion of ${JSON.stringify(text(snap[nameKey]))}, not ${JSON.stringify(c.authority_name)}`
              : state.stillThere.has(text(ledger.source_id))
                ? `records the deletion of ${text(ledger.source_id)}, which is still there`
                : "";
      if (problem) { no(`the ledger row ${ledgerId} of this file ${problem}`); continue; }
      statuses.set(r, kind === "entity" ? "already deleted entity" : "already deleted place");
      plan.done.push({ kind, code: c.authority_code, ledger });
      continue;
    }
    const id = text(s.id);
    if (ledger) {
      no(`line ${r.line} was applied before and has changed since: put new changes in a new file (the ledger row ${ledgerId} of this file records a deletion, and ${c.authority_code} is there)`);
      continue;
    }
    if (!blank(s.tenant_id) && text(s.tenant_id) !== ctx.tenantId) { no(`${c.authority_code} is owned by another tenant`); continue; }
    if (!blank(s.merged_into)) { no(`${c.authority_code} is merged into ${text(s.merged_into)}`); continue; }
    if (!sameName(c.authority_name, text(s[t.name]))) {
      no(`authority_name ${JSON.stringify(c.authority_name)} is not the stored ${kind === "entity" ? "name" : "label"} ${JSON.stringify(text(s[t.name]))}`);
      continue;
    }
    if (state.survivors.has(id)) { no(`${c.authority_code} is the survivor of a merge: the records merged into it name it`); continue; }
    const links = state.links.get(id) ?? 0;
    if (links > 0) {
      no(`${c.authority_code} holds ${links} description link${links === 1 ? "" : "s"}${kind === "entity" ? " (document links and relation sides)" : ""}; drop or move ${links === 1 ? "it" : "them"} in an earlier file`);
      continue;
    }
    const functions = state.functions.get(id) ?? 0;
    if (functions > 0) {
      no(`${c.authority_code} holds ${functions} function row${functions === 1 ? "" : "s"}, which the delete would remove with it; move or delete ${functions === 1 ? "it" : "them"} in an earlier file`);
      continue;
    }
    const children = state.children.get(id) ?? 0;
    if (children > 0) { no(`${c.authority_code} is the parent of ${children} place${children === 1 ? "" : "s"}, which would name a place that is gone`); continue; }
    const status: DeleteStatus = kind === "entity" ? "delete entity" : "delete place";
    statuses.set(r, status);
    plan.rows.push({ row: r, kind, status, id, code: c.authority_code, record: s, ledgerId, snapshot: snapshotOf(kind, s) });
  }
  return { plan, statuses };
}

// ---------------------------------------------------------------------------
// The statements
// ---------------------------------------------------------------------------

export interface DeletesBuild {
  before: string[];
  writes: string[];
  after: string[];
  entitiesDeleted: number;
  placesDeleted: number;
}

/** The guards, writes and closing guards of the deletes. */
export function buildDeleteStatements(
  plan: DeletesPlan,
  opts: { userId: string; now: number; tenantId: string; federationId: string },
): DeletesBuild {
  const db = composer();
  const out: DeletesBuild = { before: [], writes: [], after: [], entitiesDeleted: 0, placesDeleted: 0 };
  const F = escapeSql(opts.federationId);
  const T = escapeSql(opts.tenantId);
  for (const kind of ["entity", "place"] as const) {
    const t = TABLES[kind];
    const rows = plan.rows.filter((p) => p.kind === kind);
    const columns = columnsOf(kind).map((c) => c.name);
    const ids = rows.map((p) => p.id);
    // Opening guards: each record as read, nothing holding it, and no merge naming it.
    appendAll(out.before, matchingGuards(t.table, columns, rows.map((p) => columns.map((c) => p.record[c])), `a ${kind} the file deletes has changed since it was read`));
    for (const part of chunks(ids, 200)) {
      out.before.push(guard(`NOT EXISTS (SELECT 1 FROM ${t.links} WHERE ${t.pointer} IN (${idList(part)}))`, `a ${kind} the file deletes holds a description link`));
      out.before.push(guard(`NOT EXISTS (SELECT 1 FROM ${t.table} WHERE merged_into IN (${idList(part)}))`, `a ${kind} the file deletes is the survivor of a merge`));
      out.before.push(kind === "entity"
        ? guard(`NOT EXISTS (SELECT 1 FROM entity_functions WHERE entity_id IN (${idList(part)}))`, "an entity the file deletes holds a function row")
        : guard(`NOT EXISTS (SELECT 1 FROM places WHERE parent_id IN (${idList(part)}))`, "a place the file deletes is the parent of a place"));
    }
    // A row found done: its ledger row as read, and its record neither back under its id nor its code.
    const done = plan.done.filter((x) => x.kind === kind);
    appendAll(out.before, matchingGuards("authority_operations", DELETE_LEDGER_READ, done.map((x) => DELETE_LEDGER_READ.map((c) => x.ledger[c])),
      "a ledger row an earlier run of this file wrote has changed since it was read"));
    for (const part of chunks(done.map((x) => text(x.ledger.source_id)), 200)) {
      out.before.push(guard(`NOT EXISTS (SELECT 1 FROM ${t.table} WHERE id IN (${idList(part)}))`, `a ${kind} an earlier run of this file deleted is there again`));
    }
    for (const part of chunks(done.map((x) => x.code), 200)) {
      out.before.push(guard(`NOT EXISTS (SELECT 1 FROM ${t.table} WHERE federation_id = ${F} AND ${t.code} IN (${idList(part)}))`,
        `the code of a ${kind} an earlier run of this file deleted is in use again`));
    }

    // Writes: the record as read, in scope, then its ledger row.
    for (const p of rows) {
      out.writes.push(
        `DELETE FROM ${t.table} WHERE id = ${escapeSql(p.id)} AND federation_id = ${F} AND (tenant_id IS NULL OR tenant_id = ${T}) ` +
          `AND updated_at = ${escapeSql(p.record.updated_at)};`,
      );
      out.writes.push(render(db.insert(authorityOperations).values({
        id: p.ledgerId, federationId: opts.federationId, recordType: kind, operation: "delete", sourceId: p.id, targetId: null, userId: opts.userId,
        detail: JSON.stringify({ snapshot: p.snapshot }), createdAt: opts.now,
      })));
      // The term a deleted entity's primary function pointed at counts one record fewer.
      if (kind === "entity" && !blank(p.record.primary_function_id)) {
        out.writes.push(recountStatement(text(p.record.primary_function_id), opts.federationId, opts.tenantId, opts.now));
      }
      if (kind === "entity") out.entitiesDeleted++;
      else out.placesDeleted++;
    }

    // Closing guards: each record gone, each ledger row there.
    for (const part of chunks(ids, 200)) {
      out.after.push(guard(`(SELECT count(*) FROM ${t.table} WHERE id IN (${idList(part)})) = 0`, `a ${kind} the file deletes is still there`));
    }
    appendAll(out.after, matchingGuards("authority_operations", ["id", "record_type", "operation", "source_id"], rows.map((p) => [p.ledgerId, kind, "delete", p.id]),
      "a ledger row the file writes is missing"));
  }
  const ledgerIds = plan.rows.map((p) => p.ledgerId);
  for (const part of chunks(ledgerIds, 200)) {
    out.before.push(guard(`NOT EXISTS (SELECT 1 FROM authority_operations WHERE id IN (${idList(part)}))`, "a ledger id the file writes is taken"));
  }
  return out;
}

/** Whether a row deletes a record. */
export const isDeleteOp = (op: string) => (DELETE_OPS as readonly string[]).includes(op);

// @version v0.9.0
