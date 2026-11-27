/**
 * Scripts — carrying the functions of earlier merges to their survivors
 *
 * This module plans and writes the carry of earlier merges' function rows
 * to their survivors, for the command in
 * `scripts/commands/carry-merged-functions.ts`. An entity merge moves the
 * merged-away entity's `entity_functions` rows to the survivor
 * (`app/lib/pair-merge.server.ts`). Records merged away before merges did
 * so still hold theirs, and the survivor's page and entities.json leave
 * them out; the module makes the same move for those records.
 *
 * What is read: the tenant (by slug) and its federation; every entity
 * of that federation, shared or the tenant's own, with `merged_into`
 * set; the records they point at; and the function rows of both. Each
 * merged-away record that still holds rows gives them to its final
 * survivor, found by following `merged_into` to a record not merged
 * away. A chain that loops, or ends at a record missing, merged away
 * out of scope, or outside the tenant's scope, is refused.
 *
 * What is written, as the merge writes it (`planFunctionArrivals`,
 * `arrivingEntityFunctions`): a row of a function the survivor does not
 * hold by then keeps its id, its rowid and every column but `entity_id`;
 * a row of a function the survivor holds, its own or carried by an
 * earlier row or donor (text compared after trimming, collapsing
 * whitespace and case-folding), fills the held row's empty fields, keeps
 * every field the held row has, and is deleted, so the survivor holds
 * each function once; each survivor whose rows change, by a row moved
 * onto it or a fold that fills one of its rows (and only such a
 * survivor) has its `updated_at` become `now`, or one more than the value it
 * holds when that is already at or past `now`, so the publish export's
 * change check sees the move; each record that gives rows (a donor)
 * takes a new `updated_at` the same way, so an editor form loaded on it
 * before the carry fails its version check instead of writing the rows
 * back for a later run to move again; and each donor gets a ledger
 * row of operation `merge` to its final survivor, by `user_001`, whose
 * detail is the merge's (`movedLinks: 0`, `droppedLinks: []`,
 * `movedFunctions`, `foldedFunctions`) plus `carry: "functions"` and the reason. The merge
 * band on the merged-away record skips such rows
 * (`app/lib/authority-workbench.server.ts`).
 *
 * The file opens with guards that every record read still has the
 * `merged_into` read, that each survivor is unmerged and holds the
 * `updated_at` read, that each donor holds the `updated_at` read, and
 * that each donor and each survivor holds exactly the rows read, every
 * column as read; it closes with guards that every moved row names its
 * survivor, every folded row is gone, each survivor holds exactly the
 * rows planned with the fields planned, no donor holds a row, each
 * survivor's and each donor's `updated_at` moved, and the ledger rows
 * are there. D1 applies the file as one unit, so a failing guard leaves
 * nothing written.
 *
 * The report lists, per survivor, the rows to move and the rows to fold
 * with their function text, the fields each fold fills and each field
 * both rows hold with different values, and its functions before and
 * after as the export groups them
 * (`groupFunctions`, over the rows in entry order). A run that finds
 * nothing to carry writes nothing, so a second run is harmless: the
 * donors hold no rows, and their new versions refuse a stale save that
 * would give them rows again.
 *
 * @version v0.9.0
 */

import { and, eq, isNull, or } from "drizzle-orm";
import { entities } from "../../app/db/schema";
import { logAuthorityOperation } from "../../app/lib/authority-operations.server";
import { arrivingEntityFunctions, planFunctionArrivals, type EntityFunctionRow } from "../../app/lib/entity-functions.server";
import { COMPARED_FIELD_COLUMNS, FUNCTION_FIELD_COLUMNS, type FillableFunctionField } from "../../app/lib/function-duplicates";
import { FUNCTION_ROW_COLUMNS, functionRowOf } from "./entity-merges";
import { groupFunctions } from "../../app/lib/export/entities.server";
import { chunks, composer, guard, idList, matchingGuards, render } from "./authority-merges";
import { escapeSql } from "./sql";
import { appendAll } from "./arrays";

export type Target = "staging" | "production";

/** The user the ledger rows are written under, as for the other operator merges. */
export const CARRY_USER = "user_001";

export const CARRY_REASON =
  "Function rows carried to the survivor of a merge made before merges moved them";

export type RowReader = (sql: string) => Promise<Record<string, unknown>[]>;

export interface CarryProviders {
  rows: RowReader;
  /** Writes a local file (the report, the SQL file). */
  writeFile: (path: string, text: string) => void;
  /** Applies the SQL file with `wrangler d1 execute --file`; `statements` are its statements, in order. */
  applyFile: (path: string, statements: string[]) => Promise<void> | void;
  now: () => number;
}

export interface CarryOptions {
  tenant: string;
  target: Target;
  apply: boolean;
}

/** A refusal or a failure that stops the command before anything is written. */
export class CarryStop extends Error {}

export interface FunctionGroup {
  function: string;
  count: number;
}

export interface CarryMove {
  loserId: string;
  loserCode: string;
  loserName: string;
  /** Codes from the loser to the survivor, both included. */
  chain: string[];
  /** The rows that move, of functions the survivor does not hold by then. */
  rows: Array<{ id: string; function: string }>;
  /** The rows that fold into the survivor's row of the same function: the fields filled and those both hold with different values. */
  folded: Array<{ id: string; function: string; into: string; filled: string[]; conflicts: Array<{ field: string; held: string; incoming: string }> }>;
}

export interface SurvivorPlan {
  survivorId: string;
  survivorCode: string;
  survivorName: string;
  updatedAtBefore: number;
  moves: CarryMove[];
  before: FunctionGroup[];
  after: FunctionGroup[];
  /** After an apply: whether the re-read matches the plan. */
  verified?: boolean;
}

export interface CarryReport {
  target: Target;
  tenant: string;
  generatedAt: string;
  apply: boolean;
  applied: boolean;
  verified: boolean | null;
  counts: {
    /** Records merged away in the tenant's scope. */
    mergedRecords: number;
    losersWithFunctions: number;
    rowsToMove: number;
    /** Rows that fold into a survivor's row of the same function instead of moving. */
    rowsToFold: number;
    survivors: number;
    refusals: number;
  };
  refusals: string[];
  survivors: SurvivorPlan[];
}

interface EntityRead {
  id: string;
  federationId: string;
  tenantId: string | null;
  code: string;
  name: string;
  mergedInto: string | null;
  updatedAt: number;
}

type FunctionRead = EntityFunctionRow & { rowid: number };

const READ_CHUNK = 90;
const ENTITY_COLUMNS = "id, federation_id, tenant_id, entity_code, display_name, merged_into, updated_at";

const text = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

function entityOf(r: Record<string, unknown>): EntityRead {
  return {
    id: String(r.id),
    federationId: String(r.federation_id),
    tenantId: text(r.tenant_id),
    code: String(r.entity_code ?? ""),
    name: String(r.display_name ?? ""),
    mergedInto: text(r.merged_into),
    updatedAt: Number(r.updated_at),
  };
}

async function readFunctions(rows: RowReader, ids: string[]): Promise<FunctionRead[]> {
  const out: FunctionRead[] = [];
  for (const part of chunks(ids, READ_CHUNK)) {
    for (const r of await rows(
      `SELECT rowid AS rowid, ${FUNCTION_ROW_COLUMNS.join(", ")} FROM entity_functions WHERE entity_id IN (${idList(part)}) ORDER BY rowid`,
    )) {
      out.push({ ...functionRowOf(r), rowid: Number(r.rowid) });
    }
  }
  return out.sort((a, b) => a.rowid - b.rowid);
}

/** A folded row, for the report and the log. */
const foldLine = (f: CarryMove["folded"][number]) =>
  `${f.id} ${f.function} folds into ${f.into}: ${f.filled.length > 0 ? `filled ${f.filled.join(", ")}` : "skipped, nothing to fill"}` +
  (f.conflicts.length > 0 ? `; kept the held ${f.conflicts.map((c) => `${c.field} ${JSON.stringify(c.held)} (the row has ${JSON.stringify(c.incoming)})`).join(", ")}` : "");

const groupsLine = (groups: FunctionGroup[]) =>
  groups.length === 0 ? "(none)" : groups.map((g) => `${g.function} ${g.count}`).join("; ");

/** The report's path, without extension. */
export function reportBase(target: Target, now: number): string {
  const stamp = new Date(now).toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
  return `.import/carry-merged-functions_${target}_${stamp}`;
}

function markdown(r: CarryReport): string {
  const lines = [
    `# Carry merged entities' functions — ${r.target}${r.apply ? "" : " (dry run)"}`,
    "",
    `Generated ${r.generatedAt} for the tenant ${r.tenant}.`,
    "",
    "| Count | |",
    "|---|---|",
    `| Records merged away in scope | ${r.counts.mergedRecords} |`,
    `| Of them still holding functions | ${r.counts.losersWithFunctions} |`,
    `| Function rows to move | ${r.counts.rowsToMove} |`,
    `| Function rows to fold into a survivor's row of the same function | ${r.counts.rowsToFold} |`,
    `| Survivors receiving them | ${r.counts.survivors} |`,
    `| Refusals | ${r.counts.refusals} |`,
    "",
    "## Refusals",
    "",
    ...(r.refusals.length === 0 ? ["None."] : r.refusals.map((x) => `- ${x}`)),
    "",
    "## Survivors",
    "",
  ];
  for (const s of r.survivors) {
    lines.push(`### ${s.survivorCode} ${s.survivorName}`, "");
    for (const m of s.moves) {
      const via = m.chain.length > 2 ? ` (via ${m.chain.slice(1, -1).join(", ")})` : "";
      lines.push(`- from ${m.loserCode}${via} ${m.loserName}: ${m.rows.map((x) => x.function).join("; ") || "(none moved)"}`);
      for (const f of m.folded) lines.push(`  - ${foldLine(f)}`);
    }
    lines.push("", `- before: ${groupsLine(s.before)}`, `- after: ${groupsLine(s.after)}`, "");
  }
  return lines.join("\n") + "\n";
}

/**
 * Plan the carry for the tenant's scope and, with `apply`, write it.
 * Logs a line per survivor and returns the report, which it also writes.
 */
export async function carryMergedFunctions(
  options: CarryOptions,
  providers: CarryProviders,
  log: (line: string) => void,
): Promise<CarryReport> {
  const { rows } = providers;
  const now = providers.now();

  const tenants = await rows(`SELECT id, federation_id FROM tenants WHERE slug = ${escapeSql(options.tenant)}`);
  if (tenants.length !== 1) throw new CarryStop(`No tenant ${options.tenant} on ${options.target}. Nothing written.`);
  const tenantId = String(tenants[0].id);
  const federationId = String(tenants[0].federation_id);
  if ((await rows(`SELECT id FROM users WHERE id = ${escapeSql(CARRY_USER)}`)).length !== 1) {
    throw new CarryStop(`No ${CARRY_USER} on ${options.target}; the ledger needs a user. Nothing written.`);
  }
  const inScope = (e: EntityRead) => e.federationId === federationId && (e.tenantId === null || e.tenantId === tenantId);

  // Every record merged away in scope, and every record they point at.
  const merged = new Map<string, EntityRead>();
  for (const r of await rows(
    `SELECT ${ENTITY_COLUMNS} FROM entities WHERE merged_into IS NOT NULL AND federation_id = ${escapeSql(federationId)} ` +
      `AND (tenant_id IS NULL OR tenant_id = ${escapeSql(tenantId)}) ORDER BY entity_code, id`,
  )) {
    const e = entityOf(r);
    merged.set(e.id, e);
  }
  const pointed = [...new Set([...merged.values()].map((e) => e.mergedInto!))].filter((id) => !merged.has(id));
  const targets = new Map<string, EntityRead>();
  for (const part of chunks(pointed, READ_CHUNK)) {
    for (const r of await rows(`SELECT ${ENTITY_COLUMNS} FROM entities WHERE id IN (${idList(part)})`)) {
      const e = entityOf(r);
      targets.set(e.id, e);
    }
  }

  const functions = await readFunctions(rows, [...merged.keys()]);
  const byLoser = new Map<string, FunctionRead[]>();
  for (const f of functions) byLoser.set(f.entityId, [...(byLoser.get(f.entityId) ?? []), f]);

  // Follow each loser that holds rows to its final survivor.
  const refusals: string[] = [];
  const plans = new Map<string, SurvivorPlan>();
  for (const loser of merged.values()) {
    const held = byLoser.get(loser.id);
    if (!held || held.length === 0) continue;
    const chain = [loser];
    const seen = new Set([loser.id]);
    let cur = loser.mergedInto!;
    let survivor: EntityRead | null = null;
    for (;;) {
      if (seen.has(cur)) {
        refusals.push(`${loser.code}: its merged_into chain loops (${chain.map((e) => e.code).join(" → ")})`);
        break;
      }
      seen.add(cur);
      const next = merged.get(cur);
      if (next) {
        chain.push(next);
        cur = next.mergedInto!;
        continue;
      }
      const end = targets.get(cur);
      if (!end) refusals.push(`${loser.code}: its merged_into chain ends at ${cur}, which is not there`);
      else if (end.mergedInto) refusals.push(`${loser.code}: its chain ends at ${end.code}, merged away outside ${options.tenant}'s scope`);
      else if (!inScope(end)) refusals.push(`${loser.code}: its survivor ${end.code} is outside ${options.tenant}'s scope`);
      else survivor = end;
      break;
    }
    if (!survivor) continue;
    let plan = plans.get(survivor.id);
    if (!plan) {
      plan = {
        survivorId: survivor.id,
        survivorCode: survivor.code,
        survivorName: survivor.name,
        updatedAtBefore: survivor.updatedAt,
        moves: [],
        before: [],
        after: [],
      };
      plans.set(survivor.id, plan);
    }
    plan.moves.push({
      loserId: loser.id,
      loserCode: loser.code,
      loserName: loser.name,
      chain: [...chain.map((e) => e.code), survivor.code],
      rows: held.map((f) => ({ id: f.id, function: f.function })),
      folded: [],
    });
  }

  // What each donor's rows do on arrival, donor by donor in plan order: move, or fold into the row of
  // that function the survivor holds by then. Before and after, as the export groups the rows: in entry order.
  const survivorRows = await readFunctions(rows, [...plans.keys()]);
  const arrivals = new Map<string, ReturnType<typeof planFunctionArrivals>>();
  const rowidOf = new Map(functions.concat(survivorRows).map((f) => [f.id, f.rowid]));
  const survivorAfter = new Map<string, EntityFunctionRow[]>();
  for (const plan of plans.values()) {
    const own = survivorRows.filter((f) => f.entityId === plan.survivorId);
    plan.before = groupFunctions(own);
    let held: EntityFunctionRow[] = own;
    for (const m of plan.moves) {
      const a = planFunctionArrivals(held, byLoser.get(m.loserId) ?? []);
      arrivals.set(m.loserId, a);
      m.rows = a.moved.map((id) => ({ id, function: functions.find((f) => f.id === id)!.function }));
      m.folded = a.folded.map((f) => ({
        id: f.row.id, function: f.row.function, into: f.into,
        filled: Object.keys(f.filled).map((k) => FUNCTION_FIELD_COLUMNS[k as FillableFunctionField]),
        conflicts: (a.conflicts.get(f.row.id) ?? []).map((c) => ({ field: COMPARED_FIELD_COLUMNS[c.field], held: c.held, incoming: c.incoming })),
      }));
      held = a.after;
    }
    survivorAfter.set(plan.survivorId, held);
    plan.after = groupFunctions([...held].sort((x, y) => rowidOf.get(x.id)! - rowidOf.get(y.id)!));
  }
  const survivors = [...plans.values()].sort((a, b) => (a.survivorCode < b.survivorCode ? -1 : a.survivorCode > b.survivorCode ? 1 : 0));
  const moves = survivors.flatMap((s) => s.moves.map((m) => ({ ...m, survivorId: s.survivorId })));

  const report: CarryReport = {
    target: options.target,
    tenant: options.tenant,
    generatedAt: new Date(now).toISOString(),
    apply: options.apply,
    applied: false,
    verified: null,
    counts: {
      mergedRecords: merged.size,
      losersWithFunctions: [...byLoser.keys()].length,
      rowsToMove: moves.reduce((n, m) => n + m.rows.length, 0),
      rowsToFold: moves.reduce((n, m) => n + m.folded.length, 0),
      survivors: survivors.length,
      refusals: refusals.length,
    },
    refusals,
    survivors,
  };

  log(`Carry merged entities' functions — ${options.target}${options.apply ? "" : " (dry run)"}, tenant ${options.tenant}`);
  log(
    `  ${report.counts.mergedRecords} record(s) merged away in scope; ${report.counts.losersWithFunctions} still hold functions; ` +
      `${report.counts.rowsToMove} row(s) to move and ${report.counts.rowsToFold} to fold, to ${report.counts.survivors} survivor(s)`,
  );
  for (const s of survivors) {
    const n = s.moves.reduce((k, m) => k + m.rows.length + m.folded.length, 0);
    log("");
    log(`${s.survivorCode} ${s.survivorName}: ${n} row(s) from ${s.moves.length} merged record(s)`);
    for (const m of s.moves) {
      const via = m.chain.length > 2 ? ` (via ${m.chain.slice(1, -1).join(", ")})` : "";
      log(`  from ${m.loserCode}${via} ${m.loserName}: ${m.rows.map((r) => r.function).join("; ") || "(none moved)"}`);
      for (const f of m.folded) log(`    ${foldLine(f)}`);
    }
    log(`  before: ${groupsLine(s.before)}`);
    log(`  after:  ${groupsLine(s.after)}`);
  }
  for (const r of refusals) log(`  refused ${r}`);

  const base = reportBase(options.target, now);
  const writeReport = () => {
    providers.writeFile(`${base}.json`, JSON.stringify(report, null, 2) + "\n");
    providers.writeFile(`${base}.md`, markdown(report));
  };
  writeReport();
  log("");
  log(`Report: ${base}.md`);

  if (refusals.length > 0) {
    if (options.apply) throw new CarryStop(`${refusals.length} refusal(s); nothing written.`);
    return report;
  }
  if (moves.length === 0) {
    log("Nothing to carry.");
    return report;
  }
  if (!options.apply) return report;

  // The file: guards on what was read, the moves, the bumps, the ledger, guards on the result.
  const db = composer();
  const scope = and(
    eq(entities.federationId, federationId),
    or(isNull(entities.tenantId), eq(entities.tenantId, tenantId)),
  );
  const losers = moves.map((m) => merged.get(m.loserId)!);
  const chained = [...new Set(moves.flatMap((m) => m.chain))];
  const chainRecords = [...merged.values()].filter((e) => chained.includes(e.code));
  const sql: string[] = [];
  appendAll(sql, matchingGuards(
    "entities",
    ["id", "merged_into"],
    chainRecords.map((e) => [e.id, e.mergedInto]),
    "a merged record's merged_into has changed since it was read",
  ));
  appendAll(sql, matchingGuards(
    "entities",
    ["id", "merged_into", "updated_at"],
    survivors.map((s) => [s.survivorId, null, s.updatedAtBefore]),
    "a survivor has changed since it was read",
  ));
  appendAll(sql, matchingGuards(
    "entities",
    ["id", "updated_at"],
    losers.map((l) => [l.id, l.updatedAt]),
    "a merged record has changed since it was read",
  ));
  for (const part of chunks(losers.map((l) => l.id), 200)) {
    const n = part.reduce((k, id) => k + (byLoser.get(id)?.length ?? 0), 0);
    sql.push(guard(`(SELECT count(*) FROM entity_functions WHERE entity_id IN (${idList(part)})) = ${n}`, "a merged record's functions have changed since they were read"));
  }
  // What moves and what folds depends on every row of the donors and the survivors, every column as read.
  for (const part of chunks(survivors.map((s) => s.survivorId), 200)) {
    const n = survivorRows.filter((f) => part.includes(f.entityId)).length;
    sql.push(guard(`(SELECT count(*) FROM entity_functions WHERE entity_id IN (${idList(part)})) = ${n}`, "a survivor's functions have changed since they were read"));
  }
  const values = (f: EntityFunctionRow) => [
    f.id, f.entityId, f.honorific, f.function, f.dateStart, f.dateEnd, f.dateNote, f.certainty, f.source, f.notes, f.createdAt, f.updatedAt,
  ];
  appendAll(sql, matchingGuards(
    "entity_functions",
    FUNCTION_ROW_COLUMNS,
    [...losers.flatMap((l) => byLoser.get(l.id) ?? []), ...survivorRows].map(values),
    "a merged record's functions have changed since they were read",
  ));
  for (const m of moves) {
    appendAll(sql, arrivingEntityFunctions(db, m.loserId, m.survivorId, arrivals.get(m.loserId)!, scope, now).map((s) => render(s as any)));
  }
  // A survivor takes a new version only when its rows change: a row moves onto it, or a fold fills one.
  const changed = survivors.filter((s) => s.moves.some((m) => m.rows.length > 0 || m.folded.some((f) => f.filled.length > 0)));
  for (const s of changed) {
    sql.push(
      `UPDATE entities SET updated_at = CASE WHEN updated_at >= ${now} THEN updated_at + 1 ELSE ${now} END ` +
        `WHERE id = ${escapeSql(s.survivorId)} AND federation_id = ${escapeSql(federationId)} ` +
        `AND (tenant_id IS NULL OR tenant_id = ${escapeSql(tenantId)}) AND merged_into IS NULL;`,
    );
  }
  // Each donor's version moves as the survivors' do.
  const bumped = (v: number) => (v >= now ? v + 1 : now);
  for (const part of chunks(losers.map((l) => l.id), 200)) {
    sql.push(
      `UPDATE entities SET updated_at = CASE WHEN updated_at >= ${now} THEN updated_at + 1 ELSE ${now} END ` +
        `WHERE id IN (${idList(part)}) AND federation_id = ${escapeSql(federationId)} ` +
        `AND (tenant_id IS NULL OR tenant_id = ${escapeSql(tenantId)}) AND merged_into IS NOT NULL;`,
    );
  }
  for (const m of moves) {
    sql.push(render(logAuthorityOperation(db, {
      federationId,
      recordType: "entity",
      operation: "merge",
      sourceId: m.loserId,
      targetId: m.survivorId,
      userId: CARRY_USER,
      detail: {
        reason: CARRY_REASON,
        carry: "functions",
        movedLinks: 0,
        droppedLinks: [],
        addVariants: false,
        leftBehind: 0,
        movedFunctions: m.rows.map((r) => r.id),
        foldedFunctions: arrivals.get(m.loserId)!.folded,
      },
      now,
    }) as any));
  }
  appendAll(sql, matchingGuards(
    "entity_functions",
    ["id", "entity_id"],
    moves.flatMap((m) => m.rows.map((r) => [r.id, m.survivorId])),
    "a carried function does not name its survivor",
  ));
  for (const part of chunks(losers.map((l) => l.id), 200)) {
    sql.push(guard(`(SELECT count(*) FROM entity_functions WHERE entity_id IN (${idList(part)})) = 0`, "a merged record still holds functions"));
  }
  // Each survivor holds exactly the rows planned, with the fields the folds filled.
  for (const part of chunks(survivors.map((s) => s.survivorId), 200)) {
    const n = part.reduce((k, id) => k + (survivorAfter.get(id)?.length ?? 0), 0);
    sql.push(guard(`(SELECT count(*) FROM entity_functions WHERE entity_id IN (${idList(part)})) = ${n}`, "a survivor does not hold the planned function rows"));
  }
  appendAll(sql, matchingGuards(
    "entity_functions",
    ["id", "entity_id", "function", "honorific", "date_start", "date_end", "date_note", "source", "notes"],
    survivors.flatMap((s) => (survivorAfter.get(s.survivorId) ?? []).map((f) => [
      f.id, s.survivorId, f.function, f.honorific, f.dateStart, f.dateEnd, f.dateNote, f.source, f.notes,
    ])),
    "a survivor's function row does not hold the planned fields",
  ));
  for (const s of changed) {
    sql.push(guard(
      `(SELECT updated_at FROM entities WHERE id = ${escapeSql(s.survivorId)}) > ${s.updatedAtBefore} ` +
        `AND (SELECT updated_at FROM entities WHERE id = ${escapeSql(s.survivorId)}) >= ${now}`,
      "a survivor's updated_at did not move",
    ));
  }
  appendAll(sql, matchingGuards(
    "entities",
    ["id", "updated_at"],
    losers.map((l) => [l.id, bumped(l.updatedAt)]),
    "a merged record's updated_at did not move",
  ));
  sql.push(guard(
    `(SELECT count(*) FROM authority_operations WHERE operation = 'merge' AND created_at = ${now} ` +
      `AND user_id = ${escapeSql(CARRY_USER)} AND detail LIKE '%"carry":"functions"%') = ${moves.length}`,
    "the ledger rows are not all there",
  ));

  const file = `${base}.sql`;
  providers.writeFile(file, sql.join("\n") + "\n");
  log("");
  log(`Wrote ${sql.length} statements to ${file}`);
  await providers.applyFile(file, sql);
  report.applied = true;

  // Re-read: each survivor's functions as the export groups them, and the losers' rows.
  const left = await readFunctions(rows, losers.map((l) => l.id));
  const after = await readFunctions(rows, survivors.map((s) => s.survivorId));
  log("");
  log("Re-read");
  for (const s of survivors) {
    const held = groupFunctions(after.filter((f) => f.entityId === s.survivorId));
    s.verified = JSON.stringify(held) === JSON.stringify(s.after);
    log(`  [${s.verified ? "ok" : "differs"}] ${s.survivorCode}: ${groupsLine(held)}`);
  }
  log(`  merged records still holding functions: ${new Set(left.map((f) => f.entityId)).size}`);
  report.verified = left.length === 0 && survivors.every((s) => s.verified);
  writeReport();
  return report;
}

// @version v0.9.0
