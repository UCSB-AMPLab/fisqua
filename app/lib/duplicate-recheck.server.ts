/**
 * Duplicate recheck — the job that keeps the stored candidate pairs current
 *
 * This module deals with the job that keeps the stored candidate pairs
 * current. The marking triggers of migration 0129 add a row to
 * `duplicate_recheck` for every entity record whose duplicate candidates a
 * write could have changed. `runDuplicateRecheck` takes a batch of those
 * marks, recomputes the candidate pairs of the marked records, and
 * replaces their rows in `duplicate_candidates`. A scheduled handler calls
 * it; it is safe to call again at any point, because every write it makes
 * is a function of the data it reads.
 *
 * One run takes batches one after another. It stops when the queue is
 * empty, after `maxBatches` batches (10), once `timeBudgetMs` (about 120
 * seconds) has passed since it began, when D1 refuses a statement as
 * overloaded, or before it would pass `statementBudget` (800 statements;
 * D1 allows 1,000 queries per Worker invocation); between two batches
 * it waits `pauseMs` (one second). A
 * batch that read fewer than `batchSize` marks and marked no other
 * record has taken the whole queue, so the run ends without a pause.
 * The wait and the clock are options, so tests never sleep.
 *
 * Each batch takes these steps, in this order:
 *
 *   1. Read marks: up to `batchSize` rows of `duplicate_recheck` (200),
 *      in `seq` order. A record marked again gets a higher `seq`, so the
 *      oldest marks are taken first.
 *   2. Expand link marks: for each mark that names a description, every
 *      other entity linked to that description (relation sides excepted)
 *      is marked with an empty description, by `INSERT OR IGNORE`, and
 *      counted in `expanded`. A link change alters the associates of the
 *      other records on the description, and those records are rechecked
 *      by a later batch. The records of the batch are not marked, also
 *      when the batch is taken in pieces or one record at a time: each
 *      is rechecked in the batch and reads the links itself.
 *   3. Key the marked records: a live record gets its `name_key`
 *      (`normaliseName` of its display name) and its rows of
 *      `duplicate_name_deletions` replaced; a missing or merged record
 *      loses its deletions and its candidate rows. Each chunk of records
 *      takes one batch of set-based statements: one DELETE of the
 *      chunk's deletions, one UPDATE of the keys, the INSERT of the new
 *      deletions, and one DELETE of the dead records' pairs. The key is
 *      written only when it differs, because every update of `entities`
 *      also rewrites the record's search-index row (`entities_fts_au`).
 *   4. Find candidates: first the estimate of the unit's candidate pairs
 *      (see "Pair budget" below), then the records of the same
 *      federation that share a deletion with a marked record, read and
 *      kept when live and when their normalised names are equal or one
 *      edit apart (`isEditDistanceOne`). Two different names pair only
 *      when at least one contains a space (`nearPairAllowed`): a near
 *      spelling between two one-word names, such as "juan" and "juana",
 *      is not a candidate. A record never pairs with itself, and an
 *      empty key has no candidates.
 *   5. Read the inputs, for the records in at least one pair only:
 *      their function rows; their non-relation links joined to
 *      `descriptions` for the workspace and title, and the other
 *      non-relation links and the place links on those descriptions
 *      (a record linked to more than `coLinkMaxDescriptions` (2,000)
 *      descriptions of a workspace has none of its links read there, so
 *      it pairs there on its offices alone; the counts that decide it
 *      stop at 2,001, over all workspaces first and then per workspace
 *      for the records over the line, because each 100 descriptions
 *      read costs statements and a batch of very common records would
 *      pass D1's limit on queries per invocation);
 *      the description totals of the associates and places the two
 *      records of a pair share (a place counts in a workspace only when
 *      the workspace can see it: the record's federation, and shared or
 *      its own); the names and codes of those
 *      associates; the relations between them; and the `separate` and
 *      `split` operations between them.
 *   6. Compute and write: the workspaces of each federation are read
 *      once, before the reads of step 5, so the estimate of the writes
 *      knows them. For each pair and each workspace of its federation that can
 *      see both records (`tenant_id` null or that workspace),
 *      `computePairFacts` gives the facts or null. Document, associate
 *      and place facts use only that workspace's descriptions; offices
 *      hold in every workspace. One `db.batch` deletes the marked
 *      records' existing rows and inserts the qualifying ones.
 *   7. Clear the handled marks by `seq`. A mark made while the run was
 *      going has a new `seq` and is kept for the next run.
 *
 * Every read of a list of ids or keys goes in chunks of at most
 * `chunkSize`, each passed as one JSON parameter and expanded with
 * `json_each`, so no statement comes near D1's limit of 100 bound
 * parameters. Rows written from a JSON array (deletions, pairs) go in
 * runs of at most 500,000 bytes of JSON per statement, well under D1's
 * limit on a bound string. A full batch therefore sends tens of
 * statements, not one per record. Totals are read only for the associates and places that
 * both records of some pair hold, because `computePairFacts` consults a
 * total only for an id in both records' links; an id in one record's
 * links alone can never be shared.
 *
 * When D1 refuses a statement as overloaded (`isD1Overloaded`), the run
 * stops and returns `stopped: "overload"`. Writes already made stand and
 * the marks not yet cleared stay, so the next run does the work again.
 * When a batch fails with any other error, its marks are taken again one
 * record at a time; a record that fails again has its marks cleared by
 * `seq` (a mark made after the read is kept), is counted in `skipped`
 * and logged as `duplicate recheck skipped: entity=<id> <cause>`; then
 * the run goes on. Its pairs stay as they were until it is marked again.
 * An overload during the retry stops the run as above. An error reading
 * the marks, or clearing a skipped record's marks, that is not an
 * overload is rethrown, and `recheckFailureLine` gives the line the
 * caller logs for it: `duplicate recheck failed: <cause>`. The cause is
 * `describeD1Error` (`./d1-error-cause`): the error's name, the step
 * that failed (`marks` reading the next marks, `clear` clearing a
 * skipped record's marks, `unit` a recheck unit, `other` anything
 * else), the D1 error code when the error carries one, and a category
 * word, as in `Error step=marks code=7500 kind=connection`. It is never
 * the message, which carries SQL and bound values. A rethrown error is
 * wrapped in a `RecheckStepError`, whose `step` names the step and whose
 * `cause` is the error the statement threw; `recheckFailureLine` reads
 * the name, code and kind from that cause, and gives `step=other` for
 * an error that reaches it unwrapped.
 *
 * Statement budget. Every statement the run sends is counted, each
 * member of a `db.batch` included, through a D1 handle that refuses a
 * statement that would pass the budget before sending it. A unit of
 * work (a batch, a piece of one, or one record's marks) is estimated
 * before it starts and again before its costly reads: the deletion
 * reads, one per `chunkSize` deletions; the co-link and place reads,
 * two per `chunkSize` distinct descriptions, from the exact list of the
 * records' descriptions; the totals and names, two per `chunkSize`
 * shared associates and one per `chunkSize` shared places; then the
 * relation and operation reads, the writes and the clearing of the
 * marks. When the rest would pass the budget, the unit stops. A unit
 * that would fit a run of its own ends the run with `stopped: "budget"`
 * and leaves its marks. A batch that could never fit one run is split
 * by record into halves, and a piece that does not fit what is left is
 * split again, down to one record; one record that could never fit a
 * run is skipped as `duplicate recheck skipped: entity=<id> budget`, and
 * so is one that does not fit what is left when the run has yet to
 * handle or skip any record, so a record at the head of the queue can
 * never block it.
 * The per-record retry after an error keeps to both budgets. Writes a
 * stopped unit already made stand, as on an overload.
 *
 * Pair budget. Before a unit builds its candidate sets and pairs, it
 * estimates them: for each marked record, its same-key group (live
 * records with the same `name_key`) plus, for each of its deletions,
 * the holders of that deletion outside the group, which is at least the
 * number of its candidates because every record of the group holds every
 * deletion of the key. Both counts are indexed reads that stop at
 * `pairBudget + 1` (default 20,000). A unit over `pairBudget` is split by
 * record into halves as for the statement budget, and one record whose
 * candidates alone pass it is skipped as `duplicate recheck skipped:
 * entity=<id> pairs`. A large same-name group therefore never fills a
 * Worker's memory with pairs, whatever the batch size.
 *
 * The counts are totals over the run's batches: `handled` the marks
 * rechecked and cleared, `pairsWritten` the rows inserted and
 * `pairsRemoved` the rows deleted, so a pair written back counts in
 * both; `batches` the batches that read a mark, `statements` the
 * statements sent, `mostPairs` the most candidate pairs one unit built. A batch that fails adds
 * no counts, though its writes so far stand. `formatRecheckResult` gives
 * the run's log line.
 *
 * @version v0.9.0
 */

import { sql, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { isEditDistanceOne, normaliseName } from "./authority-duplicates.server";
import { describeD1Error } from "./d1-error-cause";
import { isD1Overloaded } from "./d1-overload";
import {
  computePairFacts,
  DUPLICATE_LIMITS,
  nameDeletions,
  nearPairAllowed,
  pairWeight,
  type FactRecord,
  type WorkspaceLinks,
} from "./duplicate-facts";

export interface DuplicateRecheckResult {
  handled: number;
  pairsWritten: number;
  pairsRemoved: number;
  expanded: number;
  /** Records whose marks were cleared without a recheck, after their retry failed. */
  skipped: number;
  /** Batches that read at least one mark. */
  batches: number;
  /** Statements the run sent to D1, batch members included. */
  statements: number;
  /** The most candidate pairs one unit of the run built. */
  mostPairs: number;
  /** Why the run ended: the queue emptied, D1 refused a statement as
   * overloaded, the statement budget, the time budget, or the batch count. */
  stopped: "done" | "overload" | "budget" | "time" | "batches";
}

export interface DuplicateRecheckOptions {
  now: number;
  /** Marks read per batch. */
  batchSize?: number;
  /** Ids or keys per JSON list in one statement. */
  chunkSize?: number;
  /** Batches one run takes at most. */
  maxBatches?: number;
  /** Milliseconds to wait between two batches. */
  pauseMs?: number;
  /** Milliseconds after the run began past which no new batch starts. */
  timeBudgetMs?: number;
  /** Descriptions in a workspace past which a record's links there are not read. */
  coLinkMaxDescriptions?: number;
  /** D1 statements one run may send, batch members included. */
  statementBudget?: number;
  /** Candidate pairs one unit may build. */
  pairBudget?: number;
  /** Waits `ms`; tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
  /** The time in milliseconds, for the time budget. */
  clock?: () => number;
}

/** The defaults of one run: 200 marks a batch, up to ten batches a second apart, about 120 s of work. */
export const DUPLICATE_RECHECK_DEFAULTS = {
  batchSize: 200,
  chunkSize: 100,
  maxBatches: 10,
  pauseMs: 1000,
  timeBudgetMs: 120_000,
  statementBudget: 800,
  pairBudget: 20_000,
} as const;

/** The one log line of a run, totals across its batches. */
export function formatRecheckResult(r: DuplicateRecheckResult): string {
  return (
    `duplicate recheck: handled=${r.handled} written=${r.pairsWritten} ` +
    `removed=${r.pairsRemoved} expanded=${r.expanded} skipped=${r.skipped} ` +
    `batches=${r.batches} statements=${r.statements} stopped=${r.stopped}`
  );
}

/** The part of a run a rethrown error failed in. */
export type RecheckStep = "marks" | "clear" | "unit" | "other";

/**
 * An error a run rethrows, wrapped with the step it failed at. `cause`
 * is the error the statement threw; the message names only the step.
 */
export class RecheckStepError extends Error {
  constructor(
    readonly step: RecheckStep,
    cause: unknown,
  ) {
    super(`duplicate recheck failed at ${step}`, { cause });
    this.name = "RecheckStepError";
  }
}

/**
 * The line to log for an error a run rethrew: the name of the error the
 * statement threw, the step it failed at (`other` for an error that is
 * not a `RecheckStepError`), its D1 code and its kind, and never its
 * message.
 */
export function recheckFailureLine(err: unknown): string {
  const cause = err instanceof RecheckStepError ? describeD1Error(err.cause, err.step) : describeD1Error(err, "other");
  return `duplicate recheck failed: ${cause}`;
}

interface MarkRow {
  seq: number;
  entity_id: string;
  description_id: string;
}

interface EntityRow {
  id: string;
  federation_id: string;
  tenant_id: string | null;
  entity_code: string | null;
  display_name: string;
  dates_of_existence: string | null;
  date_start: string | null;
  date_end: string | null;
  merged_into: string | null;
}

interface CandidateRow {
  id_a: string;
  id_b: string;
  federation_id: string;
  tenant_id: string;
  facts: string;
  weight: number;
  computed_at: number;
}

type Db = DrizzleD1Database<any>;

/** A write for one D1 batch, and whether the rows it deletes are candidate pairs. */
type Write = { query: SQL; removesPairs: boolean };

const dialect = new SQLiteAsyncDialect();

/**
 * The most bytes of JSON one written row array may hold. D1 takes a bound
 * string of up to 2,000,000 bytes; this stays well under it.
 */
const MAX_WRITE_JSON_BYTES = 500_000;

/** `items` in runs whose JSON stays under `MAX_WRITE_JSON_BYTES`. */
function byteChunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let bytes = 2;
  for (const item of items) {
    const size = new TextEncoder().encode(JSON.stringify(item)).length + 1;
    if (current.length > 0 && bytes + size > MAX_WRITE_JSON_BYTES) {
      out.push(current);
      current = [];
      bytes = 2;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `(SELECT value FROM json_each(?))` over one chunk, for an `IN`. */
function list(values: readonly (string | number)[]): SQL {
  return sql`(SELECT value FROM json_each(${JSON.stringify(values)}))`;
}

/** Runs `read` over `ids` in chunks and concatenates the rows. */
async function chunkedAll<T>(ids: string[], size: number, read: (part: SQL) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunks(ids, size)) out.push(...(await read(list(part))));
  return out;
}

function changes(result: unknown): number {
  return (result as { meta?: { changes?: number } })?.meta?.changes ?? 0;
}

function emptyLinks(): WorkspaceLinks {
  return { descriptions: new Map(), associates: new Map(), places: new Map() };
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

function factRecord(e: EntityRow): FactRecord {
  const span = [e.date_start, e.date_end].filter(Boolean).join("–");
  return {
    id: e.id,
    name: e.display_name,
    code: e.entity_code,
    dateStart: e.date_start,
    dateEnd: e.date_end,
    dates: e.dates_of_existence || span || null,
  };
}

function isLive(e: EntityRow | undefined): e is EntityRow {
  return e !== undefined && e.merged_into === null;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** The links of one record without its pair partner among the associates. */
function withoutPartner(links: WorkspaceLinks, partner: string): WorkspaceLinks {
  if (!links.associates.has(partner)) return links;
  const associates = new Map(links.associates);
  associates.delete(partner);
  return { ...links, associates };
}

/**
 * Runs the writes as one D1 batch, which D1 applies as one transaction,
 * and adds the pair rows they delete to the result. Drizzle's own batch
 * cannot carry raw SQL with parameters, so the statements go to the D1
 * binding behind `db`.
 */
async function batchWrites(db: Db, writes: Write[], result: DuplicateRecheckResult): Promise<unknown[]> {
  if (writes.length === 0) return [];
  const d1 = (db as unknown as { $client: D1Database }).$client;
  const results = await d1.batch(
    writes.map((w) => {
      const q = dialect.sqlToQuery(w.query);
      return d1.prepare(q.sql).bind(...q.params);
    }),
  );
  writes.forEach((w, i) => {
    if (w.removesPairs) result.pairsRemoved += changes(results[i]);
  });
  return results;
}

async function readEntities(db: Db, ids: string[], size: number): Promise<EntityRow[]> {
  return chunkedAll(ids, size, (part) =>
    db.all<EntityRow>(sql`
      SELECT id, federation_id, tenant_id, entity_code, display_name,
             dates_of_existence, date_start, date_end, merged_into
      FROM entities WHERE id IN ${part}`),
  );
}

export async function runDuplicateRecheck(db: Db, opts: DuplicateRecheckOptions): Promise<DuplicateRecheckResult> {
  const batchSize = opts.batchSize ?? DUPLICATE_RECHECK_DEFAULTS.batchSize;
  const maxBatches = opts.maxBatches ?? DUPLICATE_RECHECK_DEFAULTS.maxBatches;
  const pauseMs = opts.pauseMs ?? DUPLICATE_RECHECK_DEFAULTS.pauseMs;
  const timeBudgetMs = opts.timeBudgetMs ?? DUPLICATE_RECHECK_DEFAULTS.timeBudgetMs;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const run: Run = {
    ctx: {
      now: opts.now,
      size: opts.chunkSize ?? DUPLICATE_RECHECK_DEFAULTS.chunkSize,
      coLinkMax: opts.coLinkMaxDescriptions ?? DUPLICATE_LIMITS.recordMaxDescriptions,
    },
    db,
    budget: opts.statementBudget ?? DUPLICATE_RECHECK_DEFAULTS.statementBudget,
    pairBudget: opts.pairBudget ?? DUPLICATE_RECHECK_DEFAULTS.pairBudget,
    spent: 0,
    unitStart: 0,
    outOfTime: () => clock() - started >= timeBudgetMs,
  };
  run.db = countingDb(db, run);
  const result: DuplicateRecheckResult = { ...emptyResult(), stopped: "done" };

  for (;;) {
    run.unitStart = run.spent;
    if (run.spent + 1 > run.budget) {
      result.stopped = "budget";
      break;
    }
    let marks: MarkRow[];
    try {
      marks = await run.db.all<MarkRow>(sql`
        SELECT seq, entity_id, description_id FROM duplicate_recheck
        ORDER BY seq LIMIT ${batchSize}`);
    } catch (err) {
      if (!isD1Overloaded(err)) throw new RecheckStepError("marks", err);
      result.stopped = "overload";
      break;
    }
    if (marks.length === 0) break;
    result.batches += 1;
    const expandedBefore = result.expanded;
    const batchIds = [...new Set(marks.map((m) => m.entity_id))].sort();
    const outcome = await recheckUnit(run, marks, batchIds, result, { top: true, retry: false, piece: false });
    if (outcome === "overload" || outcome === "budget") {
      result.stopped = outcome;
      break;
    }
    if (outcome === "time") {
      result.stopped = "time";
      break;
    }
    // A short batch that marked no other record took the whole queue.
    if (marks.length < batchSize && result.expanded === expandedBefore) break;
    if (result.batches >= maxBatches) {
      result.stopped = "batches";
      break;
    }
    if (run.outOfTime()) {
      result.stopped = "time";
      break;
    }
    await sleep(pauseMs);
    if (run.outOfTime()) {
      result.stopped = "time";
      break;
    }
  }
  result.statements = run.spent;
  return result;
}

interface BatchContext {
  now: number;
  size: number;
  coLinkMax: number;
}

/** The state of one run: its D1 handle, which counts statements, and its budgets. */
interface Run {
  ctx: BatchContext;
  db: Db;
  budget: number;
  pairBudget: number;
  /** Statements sent so far. */
  spent: number;
  /** `spent` when the unit being rechecked began. */
  unitStart: number;
  outOfTime: () => boolean;
}

type Outcome = "ok" | "overload" | "budget" | "time";

/**
 * Thrown before a statement that would pass the run's statement budget.
 * `needed` is what the unit has sent plus what it would still send, so a
 * unit with `needed` over the whole budget can never fit one run.
 */
class StatementBudgetExceeded extends Error {
  constructor(readonly needed: number) {
    super("duplicate recheck statement budget");
    this.name = "StatementBudgetExceeded";
  }
}

/**
 * Thrown before a unit builds its candidate pairs when the estimate of
 * them passes the pair budget.
 */
class PairBudgetExceeded extends Error {
  constructor(readonly estimate: number) {
    super("duplicate recheck pair budget");
    this.name = "PairBudgetExceeded";
  }
}

/** The budget refusal in `err` or its `.cause` chain (drizzle wraps what the driver throws). */
function budgetRefusal(err: unknown): StatementBudgetExceeded | null {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e; depth++) {
    if (e instanceof StatementBudgetExceeded) return e;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** Refuses the unit when `rest` more statements would pass the budget. */
function reserve(run: Run, rest: number): void {
  if (run.spent + rest > run.budget) throw new StatementBudgetExceeded(run.spent - run.unitStart + rest);
}

/**
 * `db` over a D1 binding that counts every statement against the run,
 * batch members included, and refuses one that would pass the budget
 * before it is sent.
 */
function countingDb(db: Db, run: Run): Db {
  const inner = (db as unknown as { $client: D1Database }).$client;
  const take = (k: number) => {
    if (run.spent + k > run.budget) throw new StatementBudgetExceeded(run.spent - run.unitStart + k);
    run.spent += k;
  };
  const wrap = (st: D1PreparedStatement): D1PreparedStatement =>
    ({
      __inner: st,
      bind: (...values: unknown[]) => wrap(st.bind(...values)),
      first: (col?: string) => (take(1), col === undefined ? st.first() : st.first(col)),
      all: () => (take(1), st.all()),
      run: () => (take(1), st.run()),
      raw: (o?: { columnNames?: boolean }) => (take(1), st.raw(o as never)),
    }) as unknown as D1PreparedStatement;
  const client = {
    prepare: (q: string) => wrap(inner.prepare(q)),
    batch: (stmts: D1PreparedStatement[]) => {
      take(stmts.length);
      return inner.batch(stmts.map((st) => (st as unknown as { __inner: D1PreparedStatement }).__inner));
    },
    exec: (q: string) => inner.exec(q),
    dump: () => inner.dump(),
    withSession: (c?: string) => inner.withSession(c as never),
  } as unknown as D1Database;
  return drizzle(client);
}

const up = (n: number, size: number) => Math.ceil(n / size);

/**
 * The statements a unit sends whatever the data: the link expansion, the
 * read and the keying of its records, the delete of their pairs and the
 * clearing of its marks.
 */
function unitFloor(marks: MarkRow[], size: number): number {
  const ids = new Set(marks.map((m) => m.entity_id)).size;
  const described = new Set(marks.map((m) => m.description_id).filter((d) => d !== "")).size;
  return up(described, size) + 4 * up(ids, size) + up(marks.length, size);
}

/** Adds the counts of one finished recheck to the run's totals. */
function addCounts(total: DuplicateRecheckResult, part: DuplicateRecheckResult): void {
  total.handled += part.handled;
  total.pairsWritten += part.pairsWritten;
  total.pairsRemoved += part.pairsRemoved;
  total.expanded += part.expanded;
  total.mostPairs = Math.max(total.mostPairs, part.mostPairs);
}

function emptyResult(): DuplicateRecheckResult {
  return {
    handled: 0,
    pairsWritten: 0,
    pairsRemoved: 0,
    expanded: 0,
    skipped: 0,
    batches: 0,
    statements: 0,
    mostPairs: 0,
    stopped: "done",
  };
}

/** The marks grouped by record, in the order of each record's first mark. */
function byRecord(marks: MarkRow[]): MarkRow[][] {
  const out = new Map<string, MarkRow[]>();
  for (const m of marks) {
    const own = out.get(m.entity_id) ?? [];
    own.push(m);
    out.set(m.entity_id, own);
  }
  return [...out.values()];
}

/**
 * Rechecks one unit of marks: a batch, half of one, or one record's.
 *
 * Before the unit, and at points inside it, the statements it would
 * still send are estimated; when they would pass the budget it stops.
 * A unit that would fit a run of its own ends the run with `budget`,
 * leaving its marks for the next run. A unit that could never fit one
 * run is split by record into halves, taken one after the other, down
 * to one record; one record that alone passes the budget has its marks
 * cleared and is logged as skipped. After an error that is not an
 * overload, a unit's records are taken again one at a time, and a
 * record that fails again is skipped. A piece of a split batch that
 * does not fit what is left of the budget is split again, so a batch
 * that never fits is worked through while the run lasts. `batchIds`
 * are the records of the batch the unit came from, which its link
 * expansion leaves alone.
 */
async function recheckUnit(
  run: Run,
  marks: MarkRow[],
  batchIds: string[],
  result: DuplicateRecheckResult,
  how: { top: boolean; retry: boolean; piece: boolean },
): Promise<Outcome> {
  if (!how.top) {
    if (run.outOfTime()) return "time";
    run.unitStart = run.spent;
  }
  const floor = unitFloor(marks, run.ctx.size);
  if (run.spent + floor > run.budget) {
    return overBudget(run, marks, batchIds, result, run.spent - run.unitStart + floor, how.piece);
  }
  try {
    const part = emptyResult();
    await recheck(run, marks, batchIds, part);
    addCounts(result, part);
    return "ok";
  } catch (err) {
    if (isD1Overloaded(err)) return "overload";
    const refusal = budgetRefusal(err);
    if (refusal) return overBudget(run, marks, batchIds, result, refusal.needed, how.piece);
    if (err instanceof PairBudgetExceeded) {
      return byRecord(marks).length === 1 ? skip(run, marks, result, "pairs") : splitInHalves(run, marks, batchIds, result);
    }
    if (how.retry) return skip(run, marks, result, describeD1Error(err, "unit"));
    for (const own of byRecord(marks)) {
      const outcome = await recheckUnit(run, own, batchIds, result, { top: false, retry: true, piece: how.piece });
      if (outcome !== "ok") return outcome;
    }
    return "ok";
  }
}

/**
 * A unit refused for the budget. One record that could never fit a run
 * is skipped. One that could fit ends the run, unless the run has yet to
 * handle or skip any record: then it is skipped too. Splits take the
 * left half first, so that record heads the batch, and the next run
 * would read the same batch and stop at it again. Skipping it lets
 * every run handle or skip at least one record. More records are split
 * in half when they could never fit a run, or when they are already a
 * piece of a split batch; otherwise the run ends and they wait.
 */
async function overBudget(
  run: Run,
  marks: MarkRow[],
  batchIds: string[],
  result: DuplicateRecheckResult,
  needed: number,
  piece: boolean,
): Promise<Outcome> {
  const records = byRecord(marks);
  if (records.length === 1) {
    const noProgress = result.handled === 0 && result.skipped === 0;
    return needed > run.budget || noProgress ? skip(run, marks, result, "budget") : "budget";
  }
  if (needed <= run.budget && !piece) return "budget";
  return splitInHalves(run, marks, batchIds, result);
}

/** Rechecks the unit's records in two halves, by record, one after the other. */
async function splitInHalves(
  run: Run,
  marks: MarkRow[],
  batchIds: string[],
  result: DuplicateRecheckResult,
): Promise<Outcome> {
  const records = byRecord(marks);
  const mid = Math.ceil(records.length / 2);
  for (const half of [records.slice(0, mid), records.slice(mid)]) {
    const outcome = await recheckUnit(run, half.flat(), batchIds, result, { top: false, retry: false, piece: true });
    if (outcome !== "ok") return outcome;
  }
  return "ok";
}

/**
 * Clears one record's marks by `seq` without a recheck and logs it with
 * `reason`: an error's cause from `describeD1Error`, never its message,
 * which carries SQL and bound values, `budget` or `pairs`. A failure to
 * clear that is not an overload or a budget refusal is rethrown as
 * failing at `clear`.
 */
async function skip(run: Run, marks: MarkRow[], result: DuplicateRecheckResult, reason: string): Promise<Outcome> {
  run.unitStart = run.spent;
  try {
    await clearMarks(run.db, marks, run.ctx.size);
  } catch (err) {
    if (isD1Overloaded(err)) return "overload";
    if (budgetRefusal(err)) return "budget";
    throw new RecheckStepError("clear", err);
  }
  result.skipped += 1;
  console.error(`duplicate recheck skipped: entity=${marks[0].entity_id} ${reason}`);
  return "ok";
}

/** Deletes the marks by `seq`, so a mark made after they were read is kept. */
async function clearMarks(db: Db, marks: MarkRow[], size: number): Promise<void> {
  for (const part of chunks(marks.map((m) => m.seq), size)) {
    await db.run(sql`DELETE FROM duplicate_recheck WHERE seq IN ${list(part)}`);
  }
}

/** A conservative size, in bytes of JSON, of one stored candidate row. */
const ROW_BYTES_ESTIMATE = 2_000;

async function recheck(run: Run, marks: MarkRow[], batchIds: string[], result: DuplicateRecheckResult): Promise<void> {
  const db = run.db;
  const ctx = run.ctx;
  const { now, size } = ctx;
  const markedIds = [...new Set(marks.map((m) => m.entity_id))].sort();

  // 2. Expand link marks to the other records on the description. The
  // records of the batch the unit came from are left alone: each is
  // rechecked in this batch, before or after this unit, and reads the
  // links itself. `batchIds` holds at most `batchSize` ids, one JSON
  // parameter.
  const markedDescriptions = [...new Set(marks.map((m) => m.description_id).filter((d) => d !== ""))].sort();
  for (const part of chunks(markedDescriptions, size)) {
    const res = await db.run(sql`
      INSERT OR IGNORE INTO duplicate_recheck (entity_id, description_id, marked_at)
      SELECT DISTINCT de.entity_id, '', ${now}
      FROM description_entities de
      WHERE de.description_id IN ${list(part)}
        AND de.related_to IS NULL
        AND de.entity_id NOT IN ${list(batchIds)}`);
    result.expanded += changes(res);
  }

  // 3. Key the marked records, a few set-based statements per chunk.
  const records = new Map<string, EntityRow>();
  for (const e of await readEntities(db, markedIds, size)) records.set(e.id, e);
  const keys = new Map<string, string>(); // live marked id -> name key
  for (const part of chunks(markedIds, size)) {
    const live: Array<{ id: string; k: string }> = [];
    const deletionRows: Array<[string, string, string]> = [];
    const dead: string[] = [];
    for (const id of part) {
      const e = records.get(id);
      if (isLive(e)) {
        const key = normaliseName(e.display_name);
        keys.set(id, key);
        live.push({ id, k: key });
        for (const d of nameDeletions(key)) deletionRows.push([e.federation_id, d, id]);
      } else {
        dead.push(id);
      }
    }
    const writes: Write[] = [
      { query: sql`DELETE FROM duplicate_name_deletions WHERE entity_id IN ${list(part)}`, removesPairs: false },
    ];
    if (live.length > 0) {
      const keyed = JSON.stringify(live);
      const keyOf = sql`(SELECT json_extract(value, '$.k') FROM json_each(${keyed}) WHERE json_extract(value, '$.id') = entities.id)`;
      writes.push({
        query: sql`UPDATE entities SET name_key = ${keyOf}
          WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(${keyed})) AND name_key IS NOT ${keyOf}`,
        removesPairs: false,
      });
    }
    for (const rowsPart of byteChunks(deletionRows)) {
      writes.push({
        query: sql`
          INSERT OR IGNORE INTO duplicate_name_deletions (federation_id, deletion, entity_id)
          SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]')
          FROM json_each(${JSON.stringify(rowsPart)})`,
        removesPairs: false,
      });
    }
    if (dead.length > 0) {
      writes.push({
        query: sql`DELETE FROM duplicate_candidates WHERE id_a IN ${list(dead)} OR id_b IN ${list(dead)}`,
        removesPairs: true,
      });
    }
    await batchWrites(db, writes, result);
  }

  // 4. Find candidates through the shared deletions.
  const holders = new Map<string, Map<string, Set<string>>>(); // federation -> deletion -> marked ids
  for (const [id, key] of keys) {
    if (key === "") continue;
    const fed = records.get(id)!.federation_id;
    const byDeletion = holders.get(fed) ?? new Map<string, Set<string>>();
    holders.set(fed, byDeletion);
    for (const d of nameDeletions(key)) addTo(byDeletion, d, id);
  }
  // The tail every unit sends: the delete of the marked records' pairs, at
  // least one insert, and the clearing of the marks.
  const tail = up(markedIds.length, size) + 1 + up(marks.length, size);
  let deletionReads = 0;
  for (const byDeletion of holders.values()) deletionReads += up(byDeletion.size, size);
  let keyReads = 0;
  for (const fed of holders.keys()) {
    keyReads += up(new Set([...keys].filter(([id, k]) => k !== "" && records.get(id)!.federation_id === fed).map(([, k]) => k)).size, size);
  }
  // The counts below, then the deletion reads and the read of the candidates.
  reserve(run, deletionReads + keyReads + deletionReads + 1 + tail);

  // Estimate the candidate pairs before building them. Every record with
  // the same key holds every deletion of that key, so the candidates of a
  // record are at most its same-key group plus, for each of its
  // deletions, the holders outside that group. Both counts are indexed
  // and stop at `pairBudget + 1`.
  const cap = run.pairBudget + 1;
  let estimate = 0;
  for (const [fed, byDeletion] of holders) {
    const holding = new Map<string, number>();
    for (const part of chunks([...byDeletion.keys()].sort(), size)) {
      for (const row of await db.all<{ v: string; n: number }>(sql`
        SELECT j.value AS v,
               (SELECT count(*) FROM (
                  SELECT 1 FROM duplicate_name_deletions
                  WHERE federation_id = ${fed} AND deletion = j.value LIMIT ${cap})) AS n
        FROM json_each(${JSON.stringify(part)}) j`)) holding.set(row.v, row.n);
    }
    const fedKeys = [...new Set([...keys].filter(([id, k]) => k !== "" && records.get(id)!.federation_id === fed).map(([, k]) => k))].sort();
    const sameKey = new Map<string, number>();
    for (const part of chunks(fedKeys, size)) {
      for (const row of await db.all<{ v: string; n: number }>(sql`
        SELECT j.value AS v,
               (SELECT count(*) FROM (
                  SELECT 1 FROM entities
                  WHERE federation_id = ${fed} AND name_key = j.value AND merged_into IS NULL LIMIT ${cap})) AS n
        FROM json_each(${JSON.stringify(part)}) j`)) sameKey.set(row.v, row.n);
    }
    for (const [id, key] of keys) {
      if (key === "" || records.get(id)!.federation_id !== fed) continue;
      const deletions = nameDeletions(key);
      const group = Math.min(sameKey.get(key) ?? 0, ...deletions.map((d) => holding.get(d) ?? 0));
      estimate += group;
      for (const d of deletions) estimate += Math.max(0, (holding.get(d) ?? 0) - group);
    }
  }
  if (estimate > run.pairBudget) throw new PairBudgetExceeded(estimate);

  const found = new Map<string, Set<string>>(); // marked id -> candidate ids
  for (const [fed, byDeletion] of holders) {
    const hits = await chunkedAll([...byDeletion.keys()].sort(), size, (part) =>
      db.all<{ deletion: string; entity_id: string }>(sql`
        SELECT deletion, entity_id FROM duplicate_name_deletions
        WHERE federation_id = ${fed} AND deletion IN ${part}`),
    );
    for (const hit of hits) {
      for (const id of byDeletion.get(hit.deletion) ?? []) {
        if (hit.entity_id !== id) addTo(found, id, hit.entity_id);
      }
    }
  }
  const unread = [...new Set([...found.values()].flatMap((s) => [...s]))].filter((id) => !records.has(id)).sort();
  for (const e of await readEntities(db, unread, size)) records.set(e.id, e);

  const pairs = new Map<string, [string, string]>();
  for (const [id, candidates] of found) {
    const key = keys.get(id)!;
    const fed = records.get(id)!.federation_id;
    for (const other of candidates) {
      const c = records.get(other);
      if (!isLive(c) || c.federation_id !== fed) continue;
      const otherKey = normaliseName(c.display_name);
      if (otherKey === "" || (otherKey !== key && !isEditDistanceOne(key, otherKey))) continue;
      if (!nearPairAllowed(key, otherKey)) continue;
      const [a, b] = id < other ? [id, other] : [other, id];
      pairs.set(pairKey(a, b), [a, b]);
    }
  }

  result.mostPairs = Math.max(result.mostPairs, pairs.size);

  // 5. Read the inputs, for the records in at least one pair.
  const involved = [...new Set([...pairs.values()].flat())].sort();
  const workspaces = new Map<string, string[]>(); // federation -> workspace ids
  if (pairs.size > 0) {
    for (const t of await db.all<{ id: string; federation_id: string }>(sql`
      SELECT id, federation_id FROM tenants WHERE federation_id IS NOT NULL ORDER BY id`)) {
      const ws = workspaces.get(t.federation_id) ?? [];
      ws.push(t.id);
      workspaces.set(t.federation_id, ws);
    }
  }
  let mostWorkspaces = 1;
  for (const ws of workspaces.values()) mostWorkspaces = Math.max(mostWorkspaces, ws.length);
  const rowWrites = Math.max(1, Math.ceil((pairs.size * mostWorkspaces * ROW_BYTES_ESTIMATE) / MAX_WRITE_JSON_BYTES));
  const functions = new Map<string, string[]>();
  const recordLinks = new Map<string, Map<string, WorkspaceLinks>>(); // entity -> workspace -> links
  const relatedPairs = new Set<string>();
  const separatedPairs = new Set<string>();
  const linkTotals = new Map<string, number>();
  const names = new Map<string, string>();
  const codes = new Map<string, string | null>();

  if (involved.length > 0) {
    for (const row of await chunkedAll(involved, size, (part) =>
      db.all<{ entity_id: string; function: string }>(sql`
        SELECT entity_id, function FROM entity_functions WHERE entity_id IN ${part}`),
    )) {
      const fns = functions.get(row.entity_id) ?? [];
      fns.push(row.function);
      functions.set(row.entity_id, fns);
    }

    // A record linked to more than `coLinkMax` descriptions of a workspace
    // has no links read there. Each count stops at `coLinkMax + 1`: first
    // over all workspaces, then per workspace for the records over it.
    const cap = ctx.coLinkMax + 1;
    const overAll: string[] = [];
    for (const part of chunks(involved, size)) {
      for (const row of await db.all<{ id: string; n: number }>(sql`
        SELECT j.value AS id,
               (SELECT count(*) FROM (
                  SELECT DISTINCT description_id FROM description_entities
                  WHERE entity_id = j.value AND related_to IS NULL LIMIT ${cap})) AS n
        FROM json_each(${JSON.stringify(part)}) j`)) {
        if (row.n > ctx.coLinkMax) overAll.push(row.id);
      }
    }
    const crowded: string[] = []; // "<entity id>|<workspace id>"
    for (const row of await chunkedAll(overAll, size, (part) =>
      db.all<{ id: string; ws: string; n: number }>(sql`
        SELECT e.id AS id, t.id AS ws,
               (SELECT count(*) FROM (
                  SELECT DISTINCT de.description_id FROM description_entities de
                  JOIN descriptions d ON d.id = de.description_id
                  WHERE de.entity_id = e.id AND de.related_to IS NULL AND d.tenant_id = t.id
                  LIMIT ${cap})) AS n
        FROM entities e JOIN tenants t ON t.federation_id = e.federation_id
        WHERE e.id IN ${part}`),
    )) {
      if (row.n > ctx.coLinkMax) crowded.push(`${row.id}|${row.ws}`);
    }
    const notCrowded = crowded.length === 0 ? sql`` : sql` AND (de.entity_id || '|' || d.tenant_id) NOT IN ${list(crowded)}`;

    const links = await chunkedAll(involved, size, (part) =>
      db.all<{ entity_id: string; description_id: string; tenant_id: string; title: string | null }>(sql`
        SELECT de.entity_id, de.description_id, d.tenant_id, d.title
        FROM description_entities de JOIN descriptions d ON d.id = de.description_id
        WHERE de.entity_id IN ${part} AND de.related_to IS NULL${notCrowded}`),
    );
    const descriptionIds = [...new Set(links.map((l) => l.description_id))].sort();
    // Before the co-links: two reads (links and places) per `size`
    // descriptions, then the relation and operation reads and the writes.
    const restAfterTotals = 2 * up(involved.length, size) + up(markedIds.length, size) + rowWrites + up(marks.length, size);
    reserve(run, 2 * up(descriptionIds.length, size) + restAfterTotals);
    const coLinks = await chunkedAll(descriptionIds, size, (part) =>
      db.all<{ description_id: string; entity_id: string }>(sql`
        SELECT description_id, entity_id FROM description_entities
        WHERE description_id IN ${part} AND related_to IS NULL`),
    );
    const placeLinks = await chunkedAll(descriptionIds, size, (part) =>
      db.all<{ description_id: string; place_id: string; display_name: string; federation_id: string; tenant_id: string | null }>(sql`
        SELECT dp.description_id, dp.place_id, p.display_name, p.federation_id, p.tenant_id
        FROM description_places dp JOIN places p ON p.id = dp.place_id
        WHERE dp.description_id IN ${part}`),
    );

    const entitiesOn = new Map<string, Set<string>>();
    for (const l of coLinks) addTo(entitiesOn, l.description_id, l.entity_id);
    const placesOn = new Map<string, Set<string>>();
    const placeScope = new Map<string, { federation: string; owner: string | null }>();
    for (const p of placeLinks) {
      addTo(placesOn, p.description_id, p.place_id);
      placeScope.set(p.place_id, { federation: p.federation_id, owner: p.tenant_id });
    }
    // A place counts in a workspace only when the workspace can see it:
    // the record's federation, and shared or the workspace's own, as
    // `authorityScope` reads it. A place private to another workspace
    // never reaches this workspace's facts, its name included.
    const placeVisible = (place: string, federation: string, ws: string) => {
      const scope = placeScope.get(place);
      return scope !== undefined && scope.federation === federation && (scope.owner === null || scope.owner === ws);
    };
    for (const l of links) {
      const byWorkspace = recordLinks.get(l.entity_id) ?? new Map<string, WorkspaceLinks>();
      recordLinks.set(l.entity_id, byWorkspace);
      const w = byWorkspace.get(l.tenant_id) ?? emptyLinks();
      byWorkspace.set(l.tenant_id, w);
      w.descriptions.set(l.description_id, l.title);
      for (const other of entitiesOn.get(l.description_id) ?? []) {
        if (other !== l.entity_id) addTo(w.associates, other, l.description_id);
      }
      const federation = records.get(l.entity_id)!.federation_id;
      for (const place of placesOn.get(l.description_id) ?? []) {
        if (placeVisible(place, federation, l.tenant_id)) addTo(w.places, place, l.description_id);
      }
    }

    // The associates and places both records of some pair hold, in any workspace.
    const idsIn = (id: string, pick: (w: WorkspaceLinks) => Map<string, Set<string>>) => {
      const out = new Set<string>();
      for (const w of recordLinks.get(id)?.values() ?? []) for (const k of pick(w).keys()) out.add(k);
      return out;
    };
    const sharedAssociates = new Set<string>();
    const sharedPlaces = new Set<string>();
    for (const [a, b] of pairs.values()) {
      const bAssociates = idsIn(b, (w) => w.associates);
      for (const x of idsIn(a, (w) => w.associates)) {
        if (x !== a && x !== b && bAssociates.has(x)) sharedAssociates.add(x);
      }
      const bPlaces = idsIn(b, (w) => w.places);
      for (const p of idsIn(a, (w) => w.places)) if (bPlaces.has(p)) sharedPlaces.add(p);
    }
    for (const p of placeLinks) if (sharedPlaces.has(p.place_id)) names.set(p.place_id, p.display_name);
    const associateIds = [...sharedAssociates].sort();
    // Before the totals: two reads per `size` associates, one per `size` places.
    reserve(run, 2 * up(associateIds.length, size) + up(sharedPlaces.size, size) + restAfterTotals);

    for (const row of await chunkedAll(associateIds, size, (part) =>
      db.all<{ id: string; n: number }>(sql`
        SELECT entity_id AS id, count(DISTINCT description_id) AS n FROM description_entities
        WHERE entity_id IN ${part} AND related_to IS NULL GROUP BY entity_id`),
    )) linkTotals.set(row.id, row.n);
    for (const row of await chunkedAll([...sharedPlaces].sort(), size, (part) =>
      db.all<{ id: string; n: number }>(sql`
        SELECT place_id AS id, count(DISTINCT description_id) AS n FROM description_places
        WHERE place_id IN ${part} GROUP BY place_id`),
    )) linkTotals.set(row.id, row.n);
    for (const row of await chunkedAll(associateIds, size, (part) =>
      db.all<{ id: string; display_name: string; entity_code: string | null }>(sql`
        SELECT id, display_name, entity_code FROM entities WHERE id IN ${part}`),
    )) {
      names.set(row.id, row.display_name);
      codes.set(row.id, row.entity_code);
    }

    // A relation is two rows of one description, each naming the other.
    for (const row of await chunkedAll(involved, size, (part) =>
      db.all<{ a: string; b: string }>(sql`
        SELECT x.entity_id AS a, y.entity_id AS b
        FROM description_entities x JOIN description_entities y ON y.id = x.related_to
        WHERE x.entity_id IN ${part}`),
    )) relatedPairs.add(pairKey(row.a, row.b));

    for (const row of await chunkedAll(involved, size, (part) =>
      db.all<{ source_id: string; target_id: string }>(sql`
        SELECT source_id, target_id FROM authority_operations
        WHERE record_type = 'entity' AND operation IN ('separate', 'split') AND target_id IS NOT NULL
          AND (source_id IN ${part} OR target_id IN ${part})`),
    )) separatedPairs.add(pairKey(row.source_id, row.target_id));
  }

  // 6. Compute each pair for each workspace that can see both records, and write.
  const rows: CandidateRow[] = [];
  for (const [key, [a, b]] of [...pairs.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const ra = records.get(a)!;
    const rb = records.get(b)!;
    for (const ws of workspaces.get(ra.federation_id) ?? []) {
      if ((ra.tenant_id !== null && ra.tenant_id !== ws) || (rb.tenant_id !== null && rb.tenant_id !== ws)) continue;
      const facts = computePairFacts(
        {
          a: factRecord(ra),
          b: factRecord(rb),
          related: relatedPairs.has(key),
          separated: separatedPairs.has(key),
          aFunctions: functions.get(a) ?? [],
          bFunctions: functions.get(b) ?? [],
          aLinks: withoutPartner(recordLinks.get(a)?.get(ws) ?? emptyLinks(), b),
          bLinks: withoutPartner(recordLinks.get(b)?.get(ws) ?? emptyLinks(), a),
          linkTotals,
        },
        names,
        codes,
      );
      if (!facts) continue;
      rows.push({
        id_a: a,
        id_b: b,
        federation_id: ra.federation_id,
        tenant_id: ws,
        facts: JSON.stringify(facts),
        weight: pairWeight(facts),
        computed_at: now,
      });
    }
  }

  const writes: Write[] = [];
  for (const part of chunks(markedIds, size)) {
    writes.push({
      query: sql`DELETE FROM duplicate_candidates WHERE id_a IN ${list(part)} OR id_b IN ${list(part)}`,
      removesPairs: true,
    });
  }
  for (const part of byteChunks(rows)) {
    writes.push({
      query: sql`
        INSERT OR REPLACE INTO duplicate_candidates (id_a, id_b, federation_id, tenant_id, facts, weight, computed_at)
        SELECT json_extract(value, '$.id_a'), json_extract(value, '$.id_b'),
               json_extract(value, '$.federation_id'), json_extract(value, '$.tenant_id'),
               json_extract(value, '$.facts'), json_extract(value, '$.weight'),
               json_extract(value, '$.computed_at')
        FROM json_each(${JSON.stringify(part)})`,
      removesPairs: false,
    });
  }
  reserve(run, writes.length + up(marks.length, size));
  const written = await batchWrites(db, writes, result);
  writes.forEach((w, i) => {
    if (!w.removesPairs) result.pairsWritten += changes(written[i]);
  });

  // 7. Clear the handled marks by seq.
  await clearMarks(db, marks, size);
  result.handled += marks.length;
}

// @version v0.9.0
