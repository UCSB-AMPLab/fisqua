/**
 * D1 CLI — one runner for `wrangler d1 execute`, with retries for reads
 *
 * This module deals with every operator script's access to D1 through
 * wrangler. Production D1 sometimes refuses a statement with code 7429
 * ("D1 DB is overloaded. Too many resources consumed within a 10 second
 * window"), and the same statement succeeds seconds later. A read can be
 * run again safely; a write cannot, because the refusal may have come
 * after the database applied it.
 *
 * `runD1` takes the wrangler arguments (`["wrangler", "d1", "execute",
 * <database>, ...flags]`), runs them through `npx`, and returns wrangler's
 * stdout. When wrangler fails, the error it throws is a `D1CommandError`
 * carrying wrangler's own error text and code, read from its `--json`
 * error body or its plain output, instead of only "Command failed". A
 * read (a `--command` that `isReadOnlySql` accepts) that fails with 7429,
 * or with a message saying the database is overloaded, is run again up to
 * four attempts in all, waiting 5 s, 15 s and 45 s plus up to a fifth more
 * as jitter. Anything else — a `--file`, a command with any statement the
 * classifier does not accept, arguments with neither — is a write: it is
 * run once, and its error adds that the write may or may not have applied
 * and must be checked before it is run again.
 *
 * `runD1Json` runs the same way and parses the `--json` result sets,
 * dropping the status lines wrangler can print before the JSON on a
 * remote database.
 *
 * `isReadOnlySql` is an allowlist. It strips comments, keeps string
 * literals and quoted identifiers out of the keyword scan, splits on
 * top-level semicolons, and accepts the command only if every statement
 * starts with SELECT or WITH and names none of the writing keywords, or
 * is a PRAGMA from a fixed read-only list with no value assigned. The
 * function `replace(` is told apart from `REPLACE INTO` by the
 * parenthesis that follows it. Anything it cannot parse, such as an
 * unterminated string or comment, is a write.
 *
 * Reads against production have four further limits; staging, local
 * and every write have none of them. A run is against production when it
 * passes `--remote`, unless its database, the first argument after
 * `execute` that is neither a flag nor the value of a flag known to take
 * one, is exactly `fisqua-staging-db` and no argument anywhere is exactly
 * `fisqua-db` (`isProductionRun`). The rule fails safe: a flag it does not
 * know, or a name it cannot place, makes the run production. `--env` plays
 * no part: `fisqua-db --remote --env=staging` is production.
 *
 *   - Capped. On a production read every LIMIT must take one of three
 *     plain forms, `LIMIT <n>`, `LIMIT <n> OFFSET <m>` or
 *     `LIMIT <offset>, <n>`, with whole numbers and nothing after them but
 *     the end of the statement or a closing parenthesis; any other LIMIT
 *     (parenthesised, signed, a parameter, an expression) is refused. A
 *     count `n` above `PRODUCTION_READ_CAP` (1,000) is refused too. Both
 *     refusals come before anything is sent or locked. String literals
 *     are not scanned. The cap sees only LIMIT clauses: a read chunked by
 *     an IN list of ids, or a read with no LIMIT at all, carries no size
 *     the runner can see and is not capped.
 *   - One reader at a time, held by the kernel. Each attempt at a
 *     production read runs through the lock helper
 *     (`./d1-production-lock-run.mjs`), which binds the loopback port
 *     127.0.0.1:47393 (`PRODUCTION_LOCK_PORT`) with `exclusive: true`,
 *     runs wrangler, and exits with wrangler's exit code and output. Two
 *     processes cannot hold the bind at once, and the kernel frees it when
 *     the helper and the wrangler process it started have ended, however
 *     they end, so there is no stale lock to detect: the helper's header
 *     says why, after the export's lock (`./export-cli/lock.ts`), whose
 *     port, 47391, is a different one. The helper runs wrangler's
 *     `wrangler-dist/cli.js` with node directly and hands it the socket
 *     as descriptor 3. The lock is held per attempt, so it is free during
 *     the overload backoff. A helper that finds the port held exits with
 *     `LOCK_BUSY_EXIT` (75) without running anything; the runner says
 *     once that it is waiting, waits `LOCK_POLL_MS` (1 s) and tries again,
 *     and such a try does not count as an attempt. Any other bind failure
 *     is an error that names the port.
 *   - Time-limited. The helper stops an attempt that runs longer than
 *     `PRODUCTION_ATTEMPT_TIMEOUT_MS` (5 minutes) and exits with
 *     `LOCK_TIMEOUT_EXIT` (124); the runner reports that as an error and
 *     does not run the read again. The helper enforces the limit, not the
 *     exec, because a caller's own exec may not pass a timeout on.
 *   - Paced, inside the lock. The helper, once it holds the port, reads
 *     the end time of the last production read from `d1-production.last`
 *     in the cache directory (`$XDG_CACHE_HOME/fisqua/`, or
 *     `~/.cache/fisqua/`), waits until `PRODUCTION_READ_GAP_MS` (1 s) has
 *     passed since it, runs wrangler, and writes the new end time before
 *     it exits and the port is freed. Two production reads are therefore
 *     at least 1 s apart, whichever processes ran them. `runD1` does not
 *     pace production reads itself. A failure to read or write the time is
 *     reported on the helper's stderr, never thrown, and never replaces
 *     the read's own error or exit code. The file only paces; it is not
 *     part of the exclusion and needs no stale handling. If a helper is
 *     killed with SIGKILL mid-read, wrangler keeps the port until it exits
 *     but no end time is written, so the next read may start less than 1 s
 *     after that read ends: exclusion still holds, and the gap can be
 *     missed only that once, after a helper is killed by hand.
 *
 * `wranglerFailure` reads the code and text out of the error an exec
 * threw. The exec, the wait, the jitter source and the guard (the pacing
 * file's directory, the gap, the port, the time limit and the command
 * that stands for wrangler) are all options, so tests run without a
 * subprocess and without sleeping; by default the
 * exec is `execFileSync` and the wait blocks the thread, which keeps every
 * caller synchronous. The helper and the pacing are off when the caller
 * passes `guard: false` or when the environment sets
 * `FISQUA_D1_PRODUCTION_GUARD=off`. That variable exists for test suites
 * that drive production paths with a fake exec, so they neither touch the
 * cache directory nor bind the port nor sleep; the import suite's Vitest
 * config sets it. An operator must never set it. The cap holds whatever either says.
 *
 * Readers that make exactly one attempt and so do not go through
 * `runD1`, the export's (`./export-cli/d1.ts`), use the same limits
 * through `guardOf` (the guard in force), `assertProductionReadCap` (the
 * cap, before anything is sent) and `runLockedRead` (one attempt through
 * the helper, waiting while the port is held). `scripts/deploy.mjs`,
 * which cannot import this module, runs the helper itself with the same
 * port, time limit, pacing file and gap; a test keeps them equal.
 *
 * @version v0.9.0
 */
import { execFileSync, type StdioOptions } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** What the exec receives besides the command and its arguments. */
export interface D1ExecOptions {
  input?: string;
  env?: Record<string, string>;
  stdio?: StdioOptions;
  maxBuffer?: number;
}

/** Runs a command and returns its stdout, or throws as `execFileSync` does. */
export type D1Exec = (command: string, args: string[], options: D1ExecOptions) => string;

export interface D1RunOptions extends D1ExecOptions {
  exec?: D1Exec;
  /** Waits this many milliseconds before the next attempt. */
  wait?: (ms: number) => void;
  /** A number in [0, 1) for the jitter. */
  random?: () => number;
  /** Where the retry and lock notices go. */
  log?: (line: string) => void;
  /** The production read lock and pacing; `false` turns them off (the cap still holds). */
  guard?: Partial<ReadGuard> | false;
}

/** What the production read limits use: where the pacing file lives, the gap, the port, the time limit and the command for wrangler. */
export interface ReadGuard {
  /** The directory that holds `d1-production.last`. */
  dir: string;
  /** The least time, in milliseconds, between two production reads. */
  gapMs: number;
  /** The loopback port the helper binds. */
  port: number;
  /** How long one attempt may run, in milliseconds. */
  timeoutMs: number;
  /** The command and arguments that stand for `wrangler`. */
  wrangler: string[];
}

/** The most rows one production read may ask for. */
export const PRODUCTION_READ_CAP = 1_000;
/** The least time from the end of one production read to the start of the next. */
export const PRODUCTION_READ_GAP_MS = 1_000;
/** How often a production read waiting for the port tries again. */
export const LOCK_POLL_MS = 1_000;
/** The loopback port that holds the production read lock. */
export const PRODUCTION_LOCK_PORT = 47393;
/** How long one attempt at a production read may run. */
export const PRODUCTION_ATTEMPT_TIMEOUT_MS = 5 * 60_000;
/** The helper's exit code when another process holds the port. */
export const LOCK_BUSY_EXIT = 75;
/** The helper's exit code when the attempt ran past its time limit. */
export const LOCK_TIMEOUT_EXIT = 124;
/** The lock helper. */
export const PRODUCTION_LOCK_HELPER = fileURLToPath(new URL("./d1-production-lock-run.mjs", import.meta.url));

const LAST_NAME = "d1-production.last";

/** The waits before the second, third and fourth attempt at a read. */
export const READ_RETRY_WAITS_MS = [5_000, 15_000, 45_000] as const;

const OVERLOADED_CODE = 7429;

export class D1CommandError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly wranglerText: string,
    readonly attempts: number,
    readonly write: boolean,
  ) {
    super(message);
    this.name = "D1CommandError";
  }
}

// ---------------------------------------------------------------------------
// The read classifier
// ---------------------------------------------------------------------------

/** Pragmas that only report. Any other pragma, or one with `=`, is a write. */
const READ_ONLY_PRAGMAS = new Set([
  "table_info",
  "table_xinfo",
  "table_list",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
  "foreign_key_check",
  "database_list",
  "collation_list",
  "compile_options",
  "function_list",
  "module_list",
  "pragma_list",
  "integrity_check",
  "quick_check",
]);

/** Keywords that make a SELECT or WITH statement a write. */
const WRITE_KEYWORDS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "CREATE",
  "DROP",
  "ALTER",
  "ATTACH",
  "DETACH",
  "VACUUM",
  "REINDEX",
  "ANALYZE",
  "PRAGMA",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
]);

const CLOSERS: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };

/**
 * The statements of `sql` with comments removed and every string literal
 * and quoted identifier replaced by a placeholder, or null when a literal
 * or a comment is never closed.
 */
function statementsOf(sql: string): string[] | null {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      current += " ";
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return null;
      i = end + 2;
      current += " ";
      continue;
    }
    if (c in CLOSERS) {
      const close = CLOSERS[c];
      let j = i + 1;
      for (;;) {
        const end = sql.indexOf(close, j);
        if (end === -1) return null;
        // A doubled quote inside a literal is an escaped quote.
        if (close !== "]" && sql[end + 1] === close) {
          j = end + 2;
          continue;
        }
        i = end + 1;
        break;
      }
      current += c === "'" ? " ? " : " ident ";
      continue;
    }
    if (c === ";") {
      statements.push(current);
      current = "";
      i++;
      continue;
    }
    current += c;
    i++;
  }
  statements.push(current);
  return statements.map((s) => s.trim()).filter((s) => s.length > 0);
}

function isReadStatement(statement: string): boolean {
  const words = [...statement.matchAll(/[A-Za-z_][A-Za-z0-9_$]*/g)];
  if (words.length === 0) return false;
  const first = words[0][0].toUpperCase();
  if (first === "PRAGMA") {
    if (statement.includes("=")) return false;
    const m = /^PRAGMA\s+(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*(\(\s*[^()]*\))?$/i.exec(statement);
    return m !== null && READ_ONLY_PRAGMAS.has(m[1].toLowerCase());
  }
  if (first !== "SELECT" && first !== "WITH") return false;
  // Only parentheses may come before the first keyword: `(SELECT …)`.
  if (!/^[(\s]*$/.test(statement.slice(0, words[0].index))) return false;
  for (const w of words) {
    const word = w[0].toUpperCase();
    if (!WRITE_KEYWORDS.has(word)) continue;
    // replace(x, y, z) is the string function, not REPLACE INTO.
    if (word === "REPLACE" && /^\s*\(/.test(statement.slice((w.index ?? 0) + w[0].length))) continue;
    return false;
  }
  return true;
}

/** True when every statement in `sql` only reads. */
export function isReadOnlySql(sql: string): boolean {
  const statements = statementsOf(sql);
  if (statements === null || statements.length === 0) return false;
  return statements.every(isReadStatement);
}

// ---------------------------------------------------------------------------
// Wrangler's error output
// ---------------------------------------------------------------------------

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return "";
}

/** The JSON value that starts at the first `{` or `[` in `text`, if one parses. */
function jsonIn(text: string): unknown | undefined {
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  const body = text.slice(start).trim();
  const ends = [body.lastIndexOf("}"), body.lastIndexOf("]")].filter((n) => n >= 0).sort((a, b) => b - a);
  for (const end of ends) {
    try {
      return JSON.parse(body.slice(0, end + 1));
    } catch {
      // Try the other closing bracket.
    }
  }
  return undefined;
}

/** The code and the messages found anywhere in a parsed error body. */
function collect(value: unknown, into: { code: number | null; texts: string[] }, depth = 0): void {
  if (depth > 5 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) collect(v, into, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  if (into.code === null && typeof record.code === "number") into.code = record.code;
  for (const key of ["text", "message", "error"]) {
    const v = record[key];
    if (typeof v === "string" && v.trim() && !into.texts.includes(v.trim())) into.texts.push(v.trim());
  }
  for (const key of ["error", "errors", "notes"]) collect(record[key], into, depth + 1);
}

/** Wrangler's error code and text, read from what a failed exec threw. */
export function wranglerFailure(err: unknown): { code: number | null; text: string } {
  const e = (err ?? {}) as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const stdout = asText(e.stdout).trim();
  const stderr = asText(e.stderr).trim();
  const found = { code: null as number | null, texts: [] as string[] };
  for (const output of [stdout, stderr]) {
    const parsed = jsonIn(output);
    if (parsed !== undefined) collect(parsed, found);
  }
  let text = found.texts.join(" — ");
  if (!text) text = [stderr, stdout].filter(Boolean).join("\n");
  if (!text) text = typeof e.message === "string" ? e.message : String(err);
  if (found.code === null) {
    const m = /\[code:\s*(\d+)\]/.exec(`${text}\n${stderr}\n${stdout}`);
    if (m) found.code = Number(m[1]);
  }
  return { code: found.code, text: text.slice(0, 4000) };
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

const defaultExec: D1Exec = (command, args, opts) =>
  execFileSync(command, args, {
    encoding: "utf8",
    input: opts.input,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    stdio: opts.stdio,
    maxBuffer: opts.maxBuffer,
  }) ?? "";

/** Blocks the thread: the scripts that call this are synchronous. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The value of a flag given as `--flag value` or `--flag=value`, or null. */
function flagValue(args: string[], flag: string): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) return args[i + 1] ?? null;
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
  }
  return null;
}

/** True when the arguments run only reads, so a refusal may be run again. */
export function isReadOnlyRun(args: string[]): boolean {
  if (flagValue(args, "--file") !== null) return false;
  const sql = flagValue(args, "--command");
  return sql !== null && isReadOnlySql(sql);
}

/** Wrangler flags of `d1 execute` that take a value as the next argument. */
const VALUE_FLAGS = new Set(["--command", "--file", "--env", "-e", "--config", "-c", "--persist-to", "--env-file", "--cwd"]);

/** The database the arguments name: the first argument after `execute` that is neither a flag nor a flag's value. */
function databaseName(args: string[]): string | null {
  for (let i = 3; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) {
      if (!a.includes("=") && VALUE_FLAGS.has(a)) i++;
      continue;
    }
    return a;
  }
  return null;
}

/** True when the arguments run against production D1; see the module header. */
export function isProductionRun(args: string[]): boolean {
  if (!args.some((a) => a === "--remote" || a === "--remote=true")) return false;
  const staging = databaseName(args) === "fisqua-staging-db" && !args.includes("fisqua-db");
  return !staging;
}

const LIMIT_FORMS = "LIMIT <n>, LIMIT <n> OFFSET <m> or LIMIT <offset>, <n>";

/**
 * The largest row count the LIMIT clauses in `sql` ask for (null when
 * there is none), or the first LIMIT that is not in a plain form.
 */
function limitsOf(sql: string): { rows: number | null; unplain: string | null } {
  let rows: number | null = null;
  for (const statement of statementsOf(sql) ?? []) {
    for (const m of statement.matchAll(/\bLIMIT\b/gi)) {
      const rest = statement.slice((m.index ?? 0) + m[0].length);
      const plain = /^\s+(\d+)(?:\s*,\s*(\d+)|\s+OFFSET\s+\d+)?\s*(?=\)|$)/i.exec(rest);
      if (!plain) return { rows, unplain: `LIMIT${rest}`.replace(/\s+/g, " ").slice(0, 60) };
      const n = Number(plain[2] ?? plain[1]);
      if (rows === null || n > rows) rows = n;
    }
  }
  return { rows, unplain: null };
}

/** Wrangler's `cli.js`, run by node directly so that it holds the lock's socket. */
function wranglerCommand(): string[] {
  const pkgPath = createRequire(import.meta.url).resolve("wrangler/package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { main?: string };
  return [process.execPath, "--no-warnings", "--experimental-vm-modules", path.join(path.dirname(pkgPath), pkg.main ?? "wrangler-dist/cli.js")];
}

/** The guard in force for these options, or null when the helper and pacing are off. */
export function guardOf(option: D1RunOptions["guard"]): ReadGuard | null {
  if (option === false || process.env.FISQUA_D1_PRODUCTION_GUARD === "off") return null;
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return {
    dir: option?.dir ?? path.join(cache, "fisqua"),
    gapMs: option?.gapMs ?? PRODUCTION_READ_GAP_MS,
    port: option?.port ?? PRODUCTION_LOCK_PORT,
    timeoutMs: option?.timeoutMs ?? PRODUCTION_ATTEMPT_TIMEOUT_MS,
    wrangler: option?.wrangler ?? wranglerCommand(),
  };
}

const exitStatus = (err: unknown) => (err as { status?: unknown })?.status;

/**
 * One attempt at a production read through the lock helper, which paces
 * it; waits while another process holds the port.
 */
function lockedAttempt(
  g: ReadGuard,
  args: string[],
  what: string,
  exec: D1Exec,
  wait: (ms: number) => void,
  log: (line: string) => void,
  execOptions: D1ExecOptions,
  state: { waiting: boolean },
): string {
  const helperArgs = [
    PRODUCTION_LOCK_HELPER,
    String(g.port),
    String(g.timeoutMs),
    path.join(g.dir, LAST_NAME),
    String(g.gapMs),
    ...g.wrangler,
    ...args.slice(1),
  ];
  for (;;) {
    try {
      return exec(process.execPath, helperArgs, execOptions);
    } catch (err) {
      const status = exitStatus(err);
      if (status === LOCK_BUSY_EXIT) {
        if (!state.waiting) {
          log(`Another process is reading production D1 (it holds 127.0.0.1:${g.port}); waiting for it to finish.`);
          state.waiting = true;
        }
        wait(LOCK_POLL_MS);
        continue;
      }
      if (status === LOCK_TIMEOUT_EXIT) {
        const text = wranglerFailure(err).text;
        throw new D1CommandError(
          `The production read ran past its time limit of ${Math.round(g.timeoutMs / 1000)} s and was stopped; ` +
            `it is not run again: ${text}\nOn: ${what.slice(0, 300)}`,
          null,
          text,
          1,
          false,
        );
      }
      throw err;
    }
  }
}

function isOverloaded(failure: { code: number | null; text: string }): boolean {
  return failure.code === OVERLOADED_CODE || /overloaded/i.test(failure.text);
}

/** Throws, before anything is sent or locked, when a production read's LIMIT is not plain or asks for more than the cap. */
export function assertProductionReadCap(command: string, what: string = command): void {
  const { rows, unplain } = limitsOf(command);
  if (unplain !== null) {
    throw new Error(
      `Production reads take LIMIT only as ${LIMIT_FORMS}, with whole numbers; this read has "${unplain}". ` +
        `Nothing was sent.\nOn: ${what.slice(0, 300)}`,
    );
  }
  if (rows !== null && rows > PRODUCTION_READ_CAP) {
    throw new Error(
      `Production reads are capped at ${PRODUCTION_READ_CAP.toLocaleString("en-US")} rows per chunk; ` +
        `this read asks for ${rows.toLocaleString("en-US")}. Nothing was sent. Read in chunks of ` +
        `${PRODUCTION_READ_CAP.toLocaleString("en-US")} rows or fewer.\nOn: ${what.slice(0, 300)}`,
    );
  }
}

/**
 * One attempt at a production read under the lock helper, for a reader
 * that makes its own single attempt and does not go through `runD1`: it
 * waits while another process holds the port, and throws a
 * `D1CommandError` when the helper stops the attempt at its time limit.
 * `args` start with `"wrangler"`, which `g.wrangler` stands for.
 */
export function runLockedRead(
  g: ReadGuard,
  args: string[],
  options: Pick<D1RunOptions, "exec" | "wait" | "log"> & D1ExecOptions = {},
): string {
  const { exec = defaultExec, wait = sleep, log = (l) => console.error(l), ...execOptions } = options;
  const what = flagValue(args, "--command") ?? args.slice(1).join(" ");
  return lockedAttempt(g, args, what, exec, wait, log, execOptions, { waiting: false });
}

/** Runs `wrangler d1 execute` and returns its stdout; see the module header for retries and production limits. */
export function runD1(args: string[], options: D1RunOptions = {}): string {
  if (args[0] !== "wrangler" || args[1] !== "d1" || args[2] !== "execute") {
    throw new Error(`runD1 runs "wrangler d1 execute", not: ${args.slice(0, 3).join(" ")}`);
  }
  const {
    exec = defaultExec,
    wait = sleep,
    random = Math.random,
    log = (l) => console.error(l),
    guard: guardOption,
    ...execOptions
  } = options;
  const read = isReadOnlyRun(args);
  const command = flagValue(args, "--command");
  const what = command ?? `--file ${flagValue(args, "--file") ?? ""}`;
  if (!read || !isProductionRun(args)) return attempt(args, read, what, exec, wait, random, log, execOptions);
  assertProductionReadCap(command ?? "", what);
  const g = guardOf(guardOption);
  if (g === null) return attempt(args, read, what, exec, wait, random, log, execOptions);
  const state = { waiting: false };
  return attempt(args, read, what, exec, wait, random, log, execOptions, () =>
    lockedAttempt(g, args, what, exec, wait, log, execOptions, state),
  );
}

/** Runs the statement, running a read again on an overload; see the module header. */
function attempt(
  args: string[],
  read: boolean,
  what: string,
  exec: D1Exec,
  wait: (ms: number) => void,
  random: () => number,
  log: (line: string) => void,
  execOptions: D1ExecOptions,
  run: () => string = () => exec("npx", args, execOptions),
): string {
  const attempts = read ? READ_RETRY_WAITS_MS.length + 1 : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return run();
    } catch (err) {
      if (err instanceof D1CommandError) throw err;
      const failure = wranglerFailure(err);
      if (read && isOverloaded(failure) && attempt < attempts) {
        const base = READ_RETRY_WAITS_MS[attempt - 1];
        const ms = base + Math.floor(random() * base * 0.2);
        log(
          `D1 is overloaded${failure.code === null ? "" : ` (code ${failure.code})`}; ` +
            `running the read again in ${(ms / 1000).toFixed(1)} s (attempt ${attempt + 1} of ${attempts}).`,
        );
        wait(ms);
        continue;
      }
      const lines = [
        `wrangler d1 execute failed${failure.code === null ? "" : ` [code: ${failure.code}]`}` +
          `${attempt > 1 ? ` after ${attempt} attempts` : ""}: ${failure.text}`,
        `On: ${what.slice(0, 300)}`,
      ];
      if (!read) {
        lines.push("This was a write: it may or may not have applied. Check the database before running it again.");
      }
      throw new D1CommandError(lines.join("\n"), failure.code, failure.text, attempt, !read);
    }
  }
}

/** One result set of wrangler's `--json` output. */
export interface D1ResultSet<T> {
  results?: T[];
  success?: boolean;
  meta?: Record<string, unknown>;
}

/** Runs `wrangler d1 execute … --json` and returns its result sets. */
export function runD1Json<T>(args: string[], options: D1RunOptions = {}): D1ResultSet<T>[] {
  const out = runD1(args, options);
  const start = out.search(/[[{]/);
  if (start < 0) throw new Error(`wrangler produced no JSON output: ${out.slice(0, 200)}`);
  return JSON.parse(out.slice(start)) as D1ResultSet<T>[];
}
