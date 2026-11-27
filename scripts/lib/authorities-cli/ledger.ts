/**
 * Scripts — the split and separate ledger rows of the command line's authority changes
 *
 * This module plans and writes the `authority_operations` rows of
 * operation `split` and `separate` that a change file (`./change-file.ts`)
 * gives, so that the record page's split bands, the operation history and
 * the possible-duplicates worklist see what the file did, as they see the
 * workbench's splits and the duplicates worklist's "keep both". Two kinds
 * of row write them.
 *
 * Moves. For each pair of records between which the file's `move-link`
 * (entity) or `move-place-link` (place) rows that write move links, one
 * ledger row, its `source_id` the record the links leave
 * (`authority_code`) and its `target_id` the record they reach:
 *
 *   split     the target is a record the same file creates (`new:<key>`
 *             of a create-entity or create-place row), as the split
 *             workbench records a split of the original into a new record;
 *   separate  the target is an existing record, unless a `merge-entity` or
 *             `merge-place` row of the file joins the two (either
 *             direction), as the duplicates worklist records two records
 *             kept apart. The planner already refuses a link row that
 *             names a record a merge row names, so the exception guards a
 *             case the file cannot reach today.
 *
 * An `add-link` or `add-place-link` to a created record writes no ledger
 * row: a record made and linked without links leaving another is not a
 * split. The detail of a moves row is `{ reason, movedLinks, linkIds,
 * file }`: `movedLinks` the number of links moved, as the workbench
 * writes it (a count, which the history page reads), `linkIds` their
 * ids, `reason` the first moving row's `changelog_note` (or the file and
 * line), and `file` the file's name, as a merge's ledger row names it.
 * The workbench's detail also holds the reviewer's `choices` and the two
 * names after the split (`nameA`, `nameB`); a file has no choices, and
 * no reader reads the names, so they are left out.
 *
 * Backfill. `record-split` and `record-separate` name two existing
 * entities, `authority_code` (with `authority_name`) and one code in
 * `target_codes`, and write one ledger row of that operation, source the
 * first, target the second, detail `{ reason, movedLinks: 0, backfill:
 * true, file }`: for files applied before the moves wrote their ledger
 * rows. A row is refused when either record is missing, out of scope or
 * merged away, when the two are one record, and when the file names the
 * pair twice for one operation or also moves links between them. It is
 * "same" (nothing to write, neither done nor pending) when a ledger row
 * of that operation between the two, in either direction, of any file or
 * of the app, is there and is not this file's; "already recorded" when
 * this file's row is there.
 *
 * A `record-split` row's ledger row takes, as its `created_at`, the time
 * the split happened: the target's `entities.created_at` as read, since
 * the record a split makes is created by it. The handlists read a split
 * as drift only when it is later than the member's arrival
 * (`readSplits` in `app/lib/handlists.server.ts`), so a backfilled split
 * stamped with the run's clock would flag members added after the split.
 * The column holds epoch milliseconds, as the app and this command write
 * it, and seconds in some older rows: a value below 1e11 is read as
 * seconds and multiplied by 1000, as the export reads `updated_at`
 * (`modifiedAtDate`). The value is guarded as read. A `record-separate`
 * row, and every row of the link moves, takes the run's clock.
 *
 * Rerun. Each ledger row's id is made from the federation, the tenant,
 * the file's name, the operation, the record type and the two ids
 * (`ledgerRowId`, `newRecordId`), so a run of the same file again finds
 * it. A pair's moves row is written only by the run whose moves write: a
 * rerun of an applied file finds the moves done and writes nothing, and
 * a pair whose moves would write while this file's ledger row for it is
 * there is refused as changed since it was applied. A file applied before
 * this module wrote its moves rows reruns clean, without them; the
 * backfill rows record them.
 *
 * Guards. The SQL file opens with guards that each ledger id it writes is
 * absent, and that no ledger row of a backfill row's operation is between
 * its two records in either direction, and that the target of each
 * `record-split` row holds the `created_at` read; it closes with guards
 * that each ledger row is there. The records are guarded with the rest
 * (`./statements.ts`, `./places.ts`); every ledger row takes the acting
 * user, and the run's clock (epoch ms) except a backfilled split's.
 *
 * @version v0.9.0
 */

import { authorityOperations } from "../../../app/db/schema";
import { newRecordId, type RowReader } from "../authority-links";
import { chunks, composer, guard, idList, matchingGuards, render, storedValue, typed } from "../authority-merges";
import { text } from "../entity-splits";
import { escapeSql } from "../sql";
import { LEDGER_OPS, targetCodes, type ChangeRow } from "./change-file";
import { changedSince } from "./places";
import type { LinkMovesPlan } from "./link-moves";
import { appendAll } from "../arrays";

type Stored = Record<string, string | number | null>;
type Kind = "entity" | "place";
type Operation = "split" | "separate";

export type LedgerStatus = "record split" | "record separate" | "already recorded split" | "already recorded separate";

/** The namespace of the ids of the split and separate ledger rows (`newRecordId`). */
export const LEDGER_NAMESPACE = "authorities-split-separate-ledger";

/** The id of a split or separate ledger row: made from the file's name, the operation, the record type and the two records. */
export function ledgerRowId(
  federationId: string, tenantId: string, file: string, operation: Operation, kind: Kind, sourceId: string, targetId: string,
): Promise<string> {
  return newRecordId(federationId, tenantId, file, `${operation}|${kind}|${sourceId}|${targetId}`, LEDGER_NAMESPACE);
}

/** The columns of a ledger row the plan reads. */
export const LEDGER_READ = ["id", "federation_id", "record_type", "operation", "source_id", "target_id"] as const;

const isMove = (op: string) => op === "move-link" || op === "move-place-link";
const isLedgerOp = (op: string) => (LEDGER_OPS as readonly string[]).includes(op);
export const ledgerOperationOf = (op: string): Operation => (op === "record-split" || op === "split" ? "split" : "separate");
const keyOf = (operation: Operation, kind: Kind, sourceId: string, targetId: string) => `${operation}|${kind}|${sourceId}|${targetId}`;
/** A pair of records under one operation, either direction. */
const pairOf = (operation: string, kind: string, a: string, b: string) => `${operation}|${kind}|${a < b ? `${a}|${b}` : `${b}|${a}`}`;

// ---------------------------------------------------------------------------
// What is read
// ---------------------------------------------------------------------------

export interface LedgerState {
  /** `operation|kind|source|target` → the id of the ledger row this file writes for it. */
  ids: Map<string, string>;
  /** Of those ids, the ledger rows found, as read (`LEDGER_READ`). */
  found: Map<string, Stored>;
  /** For the pairs the backfill rows name: the ledger rows of each operation between them, either direction, any file. */
  between: Map<string, Stored[]>;
  /** The `created_at` of each target a `record-split` row names, as read. */
  createdAt: Map<string, number>;
}

/** The ids the records a row names resolve to before planning. */
export interface LedgerIds {
  entityId: (code: string) => string;
  entityKeyId: (key: string) => Promise<string>;
  placeId: (code: string) => string;
  placeKeyId: (key: string) => string;
}

/** Reads the ledger rows an earlier run of this file wrote, and those between the pairs the backfill rows name. */
export async function readLedgerState(
  rows: RowReader,
  input: { file: string; rows: ChangeRow[] },
  scope: { tenantId: string; federationId: string },
  ids: LedgerIds,
): Promise<LedgerState> {
  const state: LedgerState = { ids: new Map(), found: new Map(), between: new Map(), createdAt: new Map() };
  const F = scope.federationId;
  const remember = async (operation: Operation, kind: Kind, source: string, target: string) => {
    const k = keyOf(operation, kind, source, target);
    if (source && target && !state.ids.has(k)) state.ids.set(k, await ledgerRowId(F, scope.tenantId, input.file, operation, kind, source, target));
  };
  const backfilled: string[] = [];
  const splitTargets: string[] = [];
  for (const r of input.rows) {
    const c = r.cells;
    const codes = targetCodes(r);
    if (codes.length !== 1) continue;
    if (isMove(c.op)) {
      const kind: Kind = c.op === "move-place-link" ? "place" : "entity";
      const source = kind === "entity" ? ids.entityId(c.authority_code) : ids.placeId(c.authority_code);
      const created = codes[0].startsWith("new:");
      const key = codes[0].slice("new:".length);
      const target = created
        ? (kind === "entity" ? await ids.entityKeyId(key) : ids.placeKeyId(key))
        : (kind === "entity" ? ids.entityId(codes[0]) : ids.placeId(codes[0]));
      await remember(created ? "split" : "separate", kind, source, target);
    } else if (isLedgerOp(c.op)) {
      const source = ids.entityId(c.authority_code);
      const target = ids.entityId(codes[0]);
      await remember(ledgerOperationOf(c.op), "entity", source, target);
      if (source && target) backfilled.push(source, target);
      if (target && c.op === "record-split") splitTargets.push(target);
    }
  }
  for (const part of chunks([...new Set(state.ids.values())], 100)) {
    for (const r of await rows(`SELECT ${typed(LEDGER_READ)} FROM authority_operations WHERE id IN (${idList(part)})`)) {
      const s: Stored = Object.fromEntries(LEDGER_READ.map((c) => [c, storedValue(r, c)]));
      state.found.set(text(s.id), s);
    }
  }
  for (const part of chunks([...new Set(splitTargets)], 100)) {
    for (const r of await rows(`SELECT id, CAST(created_at AS INTEGER) AS created_at FROM entities WHERE id IN (${idList(part)})`)) {
      state.createdAt.set(String(r.id), Number(r.created_at));
    }
  }
  const seen = new Set<string>();
  for (const part of chunks([...new Set(backfilled)], 100)) {
    for (const end of ["source_id", "target_id"]) {
      const found = await rows(
        `SELECT ${typed(LEDGER_READ)} FROM authority_operations WHERE ${end} IN (${idList(part)}) AND federation_id = ${escapeSql(F)} ` +
          `AND record_type = 'entity' AND operation IN ('split', 'separate')`,
      );
      for (const r of found) {
        const s: Stored = Object.fromEntries(LEDGER_READ.map((c) => [c, storedValue(r, c)]));
        if (seen.has(text(s.id)) || text(s.target_id) === "") continue;
        seen.add(text(s.id));
        const k = pairOf(text(s.operation), "entity", text(s.source_id), text(s.target_id));
        state.between.set(k, [...(state.between.get(k) ?? []), s]);
      }
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface LedgerRowPlan {
  id: string;
  kind: Kind;
  operation: Operation;
  sourceId: string;
  targetId: string;
  detail: Record<string, unknown>;
  /** A `record-split` row's: the target's `created_at` as read, and in epoch ms, the ledger row's `created_at`. */
  targetCreatedAt?: { read: number; ms: number };
  /** The rows that write it: a pair's moving rows, or the one backfill row. */
  rows: ChangeRow[];
  backfill: boolean;
}

export interface LedgerPlan {
  rows: LedgerRowPlan[];
}

/**
 * The ledger rows of the moves that write: one per pair of records and
 * record type. Returns the rows to write and the moving rows refused,
 * whose status the caller sets.
 */
export function planMoveLedger(
  input: { file: string; rows: ChangeRow[] },
  moves: LinkMovesPlan,
  state: LedgerState,
  /** The id of a record a merge row names, or ''. */
  idOf: (kind: Kind, code: string) => string,
  refuse: (where: string, reason: string) => void,
): { rows: LedgerRowPlan[]; refused: ChangeRow[] } {
  const merged = new Set<string>();
  for (const r of input.rows) {
    if (r.cells.op !== "merge-entity" && r.cells.op !== "merge-place") continue;
    const kind: Kind = r.cells.op === "merge-place" ? "place" : "entity";
    const a = idOf(kind, r.cells.authority_code);
    for (const code of targetCodes(r)) {
      const b = idOf(kind, code);
      if (a && b) merged.add(pairOf("merge", kind, a, b));
    }
  }
  const groups = new Map<string, { kind: Kind; operation: Operation; sourceId: string; targetId: string; rows: ChangeRow[]; linkIds: string[]; note: string }>();
  for (const p of moves.rows) {
    if (p.status !== "move link" || !p.targetId) continue;
    const operation: Operation = targetCodes(p.row)[0]?.startsWith("new:") ? "split" : "separate";
    if (operation === "separate" && merged.has(pairOf("merge", p.kind, p.sourceId, p.targetId))) continue;
    const k = keyOf(operation, p.kind, p.sourceId, p.targetId);
    const g = groups.get(k) ?? { kind: p.kind, operation, sourceId: p.sourceId, targetId: p.targetId, rows: [], linkIds: [], note: p.note };
    g.rows.push(p.row);
    g.linkIds.push(String(p.link.id));
    groups.set(k, g);
  }
  const out: LedgerRowPlan[] = [];
  const refused: ChangeRow[] = [];
  for (const [k, g] of groups) {
    const id = state.ids.get(k);
    if (!id) throw new Error(`no ledger id was made for ${k}`);
    if (state.found.has(id)) {
      const r = g.rows[0];
      refuse(`${r.file} line ${r.line}`, changedSince(r, `the ${g.operation} ledger row ${id} of this file is in D1, and the row would still move a link`));
      refused.push(...g.rows);
      continue;
    }
    out.push({
      id, kind: g.kind, operation: g.operation, sourceId: g.sourceId, targetId: g.targetId, rows: g.rows, backfill: false,
      detail: { reason: g.note, movedLinks: g.linkIds.length, linkIds: g.linkIds, file: input.file },
    });
  }
  return { rows: out, refused };
}

/**
 * Plans one backfill row whose two records the caller has resolved (in
 * scope, not merged away, not the same): its status, or the reason it is
 * refused.
 */
export function planBackfillRow(
  r: ChangeRow,
  sourceId: string,
  targetId: string,
  state: LedgerState,
  ctx: { federationId: string; note: string; file: string },
  /** The pairs already named: by an earlier backfill row of the same operation, or moved between by the file. */
  taken: Map<string, string>,
): { status: LedgerStatus | "same"; plan?: LedgerRowPlan } | string {
  const operation = ledgerOperationOf(r.cells.op);
  const pair = pairOf(operation, "entity", sourceId, targetId);
  const by = taken.get(pair);
  if (by) return `the ${operation} of ${r.cells.authority_code} and ${targetCodes(r)[0]} is recorded by ${by} as well`;
  taken.set(pair, `line ${r.line}`);
  const id = state.ids.get(keyOf(operation, "entity", sourceId, targetId));
  if (!id) throw new Error(`no ledger id was made for line ${r.line}`);
  const own = state.found.get(id);
  if (own) {
    const holds = text(own.federation_id) === ctx.federationId && text(own.record_type) === "entity" && text(own.operation) === operation &&
      text(own.source_id) === sourceId && text(own.target_id) === targetId;
    if (!holds) return `the ledger row ${id} of this file records another operation`;
    return { status: operation === "split" ? "already recorded split" : "already recorded separate" };
  }
  if ((state.between.get(pair) ?? []).length > 0) return { status: "same" };
  const read = state.createdAt.get(targetId);
  if (operation === "split" && (read === undefined || !Number.isFinite(read))) return `the creation time of ${targetCodes(r)[0]} was not read`;
  return {
    status: operation === "split" ? "record split" : "record separate",
    plan: {
      id, kind: "entity", operation, sourceId, targetId, rows: [r], backfill: true,
      ...(operation === "split" ? { targetCreatedAt: { read: read!, ms: epochMs(read!) } } : {}),
      detail: { reason: ctx.note, movedLinks: 0, backfill: true, file: ctx.file },
    },
  };
}

/** A stored time in epoch ms: a value below 1e11 is seconds (1e11 ms is in 1973, 1e11 s in the year 5138). */
export const epochMs = (stored: number) => (stored < 1e11 ? stored * 1000 : stored);

/** The pairs the moves' ledger rows name, for the backfill rows' check. */
export function movedPairs(rows: LedgerRowPlan[]): Map<string, string> {
  return new Map(rows.filter((p) => p.kind === "entity").map((p) => [pairOf(p.operation, p.kind, p.sourceId, p.targetId), `the moves of line ${p.rows[0].line}`]));
}

// ---------------------------------------------------------------------------
// The statements
// ---------------------------------------------------------------------------

export interface LedgerBuild {
  before: string[];
  writes: string[];
  after: string[];
  splits: number;
  separates: number;
}

/** The guards, writes and closing guards of the split and separate ledger rows. */
export function buildLedgerStatements(plan: LedgerPlan, opts: { userId: string; now: number; federationId: string }): LedgerBuild {
  const db = composer();
  const out: LedgerBuild = { before: [], writes: [], after: [], splits: 0, separates: 0 };
  const F = escapeSql(opts.federationId);
  for (const part of chunks(plan.rows.map((p) => p.id), 200)) {
    out.before.push(guard(`NOT EXISTS (SELECT 1 FROM authority_operations WHERE id IN (${idList(part)}))`, "a ledger id the file writes is taken"));
  }
  // A backfill row writes only while no row of its operation is between its two records, either direction.
  const backfill = plan.rows.filter((p) => p.backfill);
  for (const part of chunks(backfill, 100)) {
    const values = part.flatMap((p) => [[p.operation, p.sourceId, p.targetId], [p.operation, p.targetId, p.sourceId]])
      .map((v) => `(${v.map(escapeSql).join(", ")})`).join(", ");
    out.before.push(guard(
      `NOT EXISTS (SELECT 1 FROM authority_operations t JOIN (VALUES ${values}) v ON t.operation = v.column1 AND t.source_id = v.column2 ` +
        `AND t.target_id = v.column3 WHERE t.federation_id = ${F} AND t.record_type = 'entity')`,
      "a pair a backfill row records already has a ledger row of that operation",
    ));
  }
  // A backfilled split takes its target's creation time: the target holds it as read.
  const stamped = plan.rows.filter((p) => p.targetCreatedAt);
  appendAll(out.before, matchingGuards("entities", ["id", "created_at"], stamped.map((p) => [p.targetId, p.targetCreatedAt!.read]),
    "the creation time of a record a backfilled split names has changed since it was read"));
  for (const p of plan.rows) {
    out.writes.push(render(db.insert(authorityOperations).values({
      id: p.id, federationId: opts.federationId, recordType: p.kind, operation: p.operation, sourceId: p.sourceId, targetId: p.targetId,
      userId: opts.userId, detail: JSON.stringify(p.detail), createdAt: p.targetCreatedAt?.ms ?? opts.now,
    })));
    if (p.operation === "split") out.splits++;
    else out.separates++;
  }
  appendAll(out.after, matchingGuards("authority_operations", ["id", "record_type", "operation", "source_id", "target_id"],
    plan.rows.map((p) => [p.id, p.kind, p.operation, p.sourceId, p.targetId]), "a ledger row the file writes is missing"));
  return out;
}

/** Whether a row records a split or a separate. */
export const isLedgerRowOp = isLedgerOp;

// @version v0.9.0
