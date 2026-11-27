/**
 * Scripts — running the command line's export
 *
 * This module deals with running the command line's export:
 *
 *   `export <set> --target staging|production --tenant <slug>
 *    --fonds <reference code> --out <dir> [--confirm-production]`
 *
 * `runExport` reads one set (`./sets.ts`: `descriptions`, `entity-links`,
 * `place-links`, `pool`) from D1 into CSV files in `--out`, read only.
 * `--fonds` is given once, except for `pool`, which takes it any number
 * of times, once for each `links_<x>` column and each row of
 * `link-counts-by-fonds.csv`; two fonds whose codes end in the same part
 * are refused, as their columns would share a name.
 *
 * Before anything is read: production needs `--confirm-production`;
 * every file name the run would write must fit in 200 bytes
 * (`fileSafeName`, `./checkpoint.ts`); the target's lock is taken, a
 * TCP port on 127.0.0.1 the operating system holds for the run, and for
 * each wrangler process the run starts, and frees when they have all
 * ended or died (`./lock.ts`), so one export runs at a time against each
 * target;
 * and a checkpoint in `--out` must have been written by the same set,
 * target, tenant and fonds, or the run refuses. A folder whose export is
 * complete is refused too: each export gets its own folder.
 *
 * Every statement goes through `PacedReader` (`./reader.ts`), which
 * holds the load limits and fetches the sign-in page as it reads:
 * `https://neogranadina.fisqua.org/login` for production, and for
 * staging `https://ahr.staging.fisqua.org/login`, a tenant host the
 * staging Worker serves (the staging apex answers 404 at `/login`, and
 * staging has no `neogranadina` host). The checkpoint is written after
 * every statement, so a stopped run resumes at the page after the last
 * one it kept.
 *
 * When every phase is read, the files are built from the page files and
 * written whole, the page files are removed, the checkpoint is marked
 * complete, and `summary.md` gives the rows of each file, the Worker
 * version the provider reports (the latest deployment's, from
 * `wrangler deployments list`) and each run's time of reading in UTC. A
 * run that stops writes `README.md`: the folder is partial, why it
 * stopped, and that no CSV file is complete, since none is written
 * before every page is read. A later complete run removes it.
 *
 * @version v0.9.0
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  ExportRefusal,
  fileSafeName,
  sameArgs,
  Store,
  type Checkpoint,
  type CheckpointArgs,
  type PhaseState,
  type RunRecord,
} from "./checkpoint";
import { acquirePortLock, LOCK_PORTS } from "./lock";
import { ExportStop, PacedReader, type ReaderProviders } from "./reader";
import { SelectRefusal } from "./select-guard";
import { csvText, ID_CHUNK, SETS, setSpec, shortOf, type ExportSet, type SetSpec } from "./sets";

export { ExportRefusal } from "./checkpoint";
export type { ExportSet } from "./sets";

export type Target = "staging" | "production";

export const LOGIN_URLS: Record<Target, string> = {
  production: "https://neogranadina.fisqua.org/login",
  staging: "https://ahr.staging.fisqua.org/login",
};

export interface ExportArgs {
  set: ExportSet;
  target: Target;
  tenant: string;
  fonds: string[];
  out: string;
  confirmProduction: boolean;
}


export interface ExportProviders extends ReaderProviders {
  /** The lock port of a target; `LOCK_PORTS` by default, other ports in the tests. */
  lockPort?: (target: Target) => number;
  /** The deployed Worker's version, or null when it cannot be read cheaply. */
  workerVersion: () => string | null;
}

export interface ExportResult {
  outcome: "complete" | "stopped";
  reason?: string;
  files: Array<{ name: string; rows: number }>;
  statements: number;
}

const USAGE =
  "Usage: fisqua export descriptions|entity-links|place-links|pool --target staging|production --tenant <slug> " +
  "--fonds <reference code> --out <dir> [--confirm-production]";

/** `export <set> --target --tenant --fonds --out [--confirm-production]`. */
export function parseExportArgs(argv: string[]): ExportArgs {
  const [noun, set, ...rest] = argv;
  if (noun !== "export") throw new Error(USAGE);
  if (!SETS.includes(set as ExportSet)) throw new Error(`export takes descriptions, entity-links, place-links or pool\n${USAGE}`);
  let target: string | null = null;
  let tenant = "";
  let out = "";
  const fonds: string[] = [];
  let confirmProduction = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const value = () => {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--confirm-production") confirmProduction = true;
    else if (a === "--target") target = value();
    else if (a === "--tenant") tenant = value();
    else if (a === "--fonds") fonds.push(value());
    else if (a === "--out") out = value();
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (target !== "staging" && target !== "production") throw new Error("--target is staging or production");
  const args: ExportArgs = { set: set as ExportSet, target, tenant, fonds, out, confirmProduction };
  checkArgs(args);
  return args;
}

function checkArgs(args: ExportArgs): void {
  if (!args.tenant) throw new ExportRefusal("--tenant <slug> is required");
  if (!args.out) throw new ExportRefusal("--out <dir> is required");
  if (args.set !== "pool" && args.fonds.length !== 1) {
    throw new ExportRefusal(args.fonds.length === 0 ? "--fonds <reference code> is required" : `${args.set} takes --fonds once`);
  }
  const shorts = args.fonds.map(shortOf);
  if (new Set(shorts).size !== shorts.length || new Set(args.fonds).size !== args.fonds.length) {
    throw new ExportRefusal(`Two --fonds would share a column name (links_${shorts.join(", links_")})`);
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Reads every phase of the set not yet done, writing the checkpoint after each statement. */
async function readPhases(spec: SetSpec, cp: Checkpoint, store: Store, reader: PacedReader, run: RunRecord, log: (l: string) => void) {
  const load = (name: string) => store.read(name);
  for (const phase of spec.phases) {
    const state: PhaseState = (cp.phases[phase.name] ??= { done: false, after: "", chunk: 0, pages: 0, rows: 0, bytes: 0 });
    if (state.done) continue;
    const step = phase.step(load);
    const read = async (sql: string) => {
      const rows = await reader.select(sql);
      const kept = rows
        .map((r) => (phase.keepWith ? phase.keepWith(r, load) : phase.keep ? phase.keep(r) : r))
        .filter((r): r is NonNullable<typeof r> => r !== null);
      state.bytes = store.append(phase.name, kept);
      state.rows += kept.length;
      state.pages++;
      run.statements = reader.sent;
      return rows;
    };
    const save = () => store.save(cp);
    if (step.kind === "one") {
      const rows = await read(step.sql);
      if (rows.length === 0) throw new ExportStop(step.missing);
      state.done = true;
      save();
    } else if (step.kind === "pages") {
      for (;;) {
        const rows = await read(step.sql(state.after));
        if (rows.length > 0) state.after = String(rows[rows.length - 1].id);
        if (rows.length < step.size) state.done = true;
        save();
        if (state.done) break;
      }
    } else {
      const chunks = Math.ceil(step.ids.length / ID_CHUNK);
      while (state.chunk < chunks) {
        const ids = step.ids.slice(state.chunk * ID_CHUNK, (state.chunk + 1) * ID_CHUNK);
        const rows = await read(step.sql(ids, state.after));
        if (step.size !== null && rows.length >= step.size) {
          state.after = String(rows[rows.length - 1].id);
        } else {
          state.chunk++;
          state.after = "";
        }
        save();
      }
      state.done = true;
      save();
    }
    log(`${phase.name}: ${state.rows} rows in ${state.pages} statements`);
  }
}

function summaryOf(args: ExportArgs, cp: Checkpoint, files: ExportResult["files"], worker: string | null): string {
  const lines = [
    `# Fisqua export: ${args.set}`,
    "",
    `Read-only export from the ${args.target} D1 database.`,
    "",
    `- Tenant: ${args.tenant}`,
    `- Fonds: ${args.fonds.length ? args.fonds.join(", ") : "none"}`,
    `- Worker version: ${worker ?? "not read (wrangler deployments list gave no answer)"}`,
    `- Statements sent: ${cp.runs.reduce((n, r) => n + r.statements, 0)}`,
    "",
    "Time of reading (UTC):",
    "",
    ...cp.runs.map(
      (r, i) => `${i + 1}. ${r.startedAt} to ${r.endedAt ?? "?"}, ${r.statements} statements, ${r.outcome}${r.reason ? `: ${r.reason}` : ""}`,
    ),
    "",
    "| File | Rows |",
    "|---|---:|",
    ...files.map((f) => `| ${f.name} | ${f.rows} |`),
    "",
  ];
  return lines.join("\n");
}

function readmeOf(args: ExportArgs, spec: SetSpec, cp: Checkpoint, when: string, reason: string): string {
  const pages = Object.values(cp.phases).reduce((n, s) => n + s.pages, 0);
  return [
    "# Partial export",
    "",
    `This folder is partial. \`fisqua export ${args.set}\` (${args.target}, tenant ${args.tenant}, fonds ${args.fonds.join(", ") || "none"}) stopped at ${when} UTC because:`,
    "",
    `> ${reason.replace(/\n/g, " ")}`,
    "",
    `Complete files: none. The files of this set (${spec.fileNames.join(", ")}) are written only once every page has been read.`,
    "",
    `The checkpoint, \`export-checkpoint.json\`, records ${pages} statements whose rows were kept. Running the same command again resumes after the last of them.`,
    "",
  ].join("\n");
}

/** Runs one export; see the module header. Refusals before reading throw `ExportRefusal`. */
export async function runExport(args: ExportArgs, p: ExportProviders): Promise<ExportResult> {
  checkArgs(args);
  if (args.target === "production" && !args.confirmProduction) {
    throw new ExportRefusal("Reading production also needs --confirm-production");
  }
  // Every file name is checked before the lock is taken or anything read.
  const spec = setSpec(args.set, args.tenant, args.fonds);
  for (const phase of spec.phases) fileSafeName(phase.name);
  const lock = await acquirePortLock(args.target, (p.lockPort ?? ((t) => LOCK_PORTS[t]))(args.target));
  try {
    const key: CheckpointArgs = { set: args.set, target: args.target, tenant: args.tenant, fonds: [...args.fonds] };
    const store = new Store(args.out);
    let cp = store.load();
    if (cp && !sameArgs(cp.args, key)) {
      throw new ExportRefusal(
        `The checkpoint in ${args.out} belongs to another export (${cp.args.set}, ${cp.args.target}, tenant ${cp.args.tenant}, ` +
          `fonds ${cp.args.fonds.join(", ") || "none"}); give this one its own --out`,
      );
    }
    if (cp?.complete) throw new ExportRefusal(`The export in ${args.out} is complete; give a new export its own --out`);
    cp ??= { format: 1, args: key, phases: {}, runs: [], complete: false };
    // Rows written after the checkpoint was last saved are dropped.
    for (const phase of spec.phases) store.truncate(phase.name, cp.phases[phase.name]?.bytes ?? 0);
    const run: RunRecord = { startedAt: iso(p.now()), endedAt: null, statements: 0, outcome: "running" };
    cp.runs.push(run);
    store.save(cp);

    // Every statement's runner is handed the lock's descriptor (`./lock.ts`).
    const reader = new PacedReader({ ...p, d1: (sql) => p.d1(sql, lock.fd) }, LOGIN_URLS[args.target]);
    const readme = path.join(args.out, "README.md");
    try {
      await readPhases(spec, cp, store, reader, run, p.log);
    } catch (err) {
      const stopped = err instanceof ExportStop || err instanceof SelectRefusal;
      const reason = err instanceof Error ? err.message : String(err);
      run.statements = reader.sent;
      run.endedAt = iso(p.now());
      run.outcome = "stopped";
      run.reason = reason;
      store.save(cp);
      fs.writeFileSync(readme, readmeOf(args, spec, cp, run.endedAt, reason), "utf8");
      if (!stopped) throw err;
      p.log(`Stopped: ${reason}\nThe folder ${args.out} is partial; run the same command again to resume.`);
      return { outcome: "stopped", reason, files: [], statements: reader.sent };
    }

    const built = spec.build((name) => store.read(name));
    for (const f of built) fs.writeFileSync(path.join(args.out, f.name), csvText(f), "utf8");
    const files = built.map((f) => ({ name: f.name, rows: f.rows.length }));
    run.statements = reader.sent;
    run.endedAt = iso(p.now());
    run.outcome = "complete";
    cp.complete = true;
    store.save(cp);
    store.removeParts();
    fs.rmSync(readme, { force: true });
    let worker: string | null = null;
    try {
      worker = p.workerVersion();
    } catch {
      worker = null;
    }
    fs.writeFileSync(path.join(args.out, "summary.md"), summaryOf(args, cp, files, worker), "utf8");
    for (const f of files) p.log(`${f.name}: ${f.rows} rows`);
    return { outcome: "complete", files, statements: reader.sent };
  } finally {
    await lock.release();
  }
}

// @version v0.9.0
