/**
 * Tests — the shared `wrangler d1 execute` runner
 *
 * This suite checks the shared `wrangler d1 execute` runner: the read
 * classifier that decides what may be run again, the runner's retries for
 * reads, its refusal to rerun writes, and the error text it surfaces from
 * wrangler's output. Production D1 sometimes refuses a statement with code
 * 7429 ("D1 DB is overloaded") and accepts the same statement seconds
 * later. Every run uses a fake exec and a recording wait, so nothing
 * reaches Cloudflare and nothing sleeps.
 *
 * It also checks the limits on production reads: one reader at a time,
 * held by a loopback port that the lock helper binds for each attempt; at
 * least a second from the end of one production read to the start of the
 * next; a five-minute limit on each attempt; and no chunk above 1,000
 * rows. Most tests give the runner a fake exec, a fake clock and a
 * recording wait, and staging and local reads are shown to take none of
 * these limits. The helper's own tests run it for real, each on a free
 * port of its own and never the production lock's, with node scripts
 * standing in for wrangler. The suite's config sets
 * `FISQUA_D1_PRODUCTION_GUARD=off`; these tests clear it, and set it only
 * to show that it turns the lock and pacing off but not the cap.
 *
 * @version v0.9.0
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  D1CommandError,
  isProductionRun,
  isReadOnlySql,
  LOCK_BUSY_EXIT,
  LOCK_POLL_MS,
  LOCK_TIMEOUT_EXIT,
  PRODUCTION_ATTEMPT_TIMEOUT_MS,
  PRODUCTION_LOCK_HELPER,
  PRODUCTION_LOCK_PORT,
  PRODUCTION_READ_CAP,
  PRODUCTION_READ_GAP_MS,
  runD1,
  runD1Json,
  wranglerFailure,
} from "../../scripts/lib/d1-cli";

describe("isReadOnlySql", () => {
  it.each([
    ["a SELECT", "SELECT id FROM descriptions WHERE tenant_id = 'x'"],
    ["a SELECT with a trailing semicolon", "SELECT 1;"],
    ["lowercase", "select count(*) from entities"],
    ["WITH … SELECT", "WITH t AS (SELECT id FROM places) SELECT count(*) FROM t"],
    ["PRAGMA table_info", "PRAGMA table_info(descriptions);"],
    ["PRAGMA table_info with a quoted name", "PRAGMA table_info('descriptions')"],
    ["several SELECTs", "SELECT 1; SELECT 2;\nSELECT 3"],
    ["a line comment", "-- count the rows\nSELECT count(*) FROM entities"],
    ["a block comment", "/* rows */ SELECT count(*) FROM entities /* done */"],
    ["a semicolon inside a string literal", "SELECT id FROM entities WHERE name = 'a; DELETE FROM entities'"],
    ["an escaped quote inside a literal", "SELECT 'it''s; DROP TABLE x' AS v"],
    ["a write keyword inside a comment", "SELECT 1 -- then DELETE FROM entities\n"],
    ["a write keyword inside a quoted identifier", 'SELECT "delete" FROM t'],
    ["the replace() function", "SELECT replace(name, 'a', 'b') FROM entities"],
    ["column names that contain write words", "SELECT updated_at, created_by, deleted_at FROM entities"],
    ["a leading parenthesis", "(SELECT 1)"],
  ])("accepts %s", (_label, sql) => {
    expect(isReadOnlySql(sql)).toBe(true);
  });

  it.each([
    ["INSERT", "INSERT INTO t (a) VALUES (1)"],
    ["UPDATE", "UPDATE t SET a = 1"],
    ["DELETE", "DELETE FROM t"],
    ["REPLACE INTO", "REPLACE INTO t (a) VALUES (1)"],
    ["CREATE", "CREATE TABLE t (a)"],
    ["DROP", "DROP TABLE t"],
    ["ALTER", "ALTER TABLE t ADD COLUMN b"],
    ["WITH … DELETE", "WITH x AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM x)"],
    ["WITH … INSERT", "WITH x AS (SELECT 1 AS a) INSERT INTO t SELECT a FROM x"],
    ["a SELECT followed by a DELETE", "SELECT 1; DELETE FROM t"],
    ["a write hidden after a comment", "/* SELECT */ DELETE FROM t"],
    ["a SELECT whose comment hides the start of a write", "SELECT 1; -- a note\nUPDATE t SET a = 1"],
    ["a PRAGMA that sets a value", "PRAGMA foreign_keys = OFF"],
    ["a PRAGMA outside the read-only list", "PRAGMA optimize"],
    ["an unterminated string", "SELECT 'abc"],
    ["an unterminated block comment", "SELECT 1 /* never closed"],
    ["an empty command", "   ;  -- nothing\n"],
    ["a transaction", "BEGIN; SELECT 1; COMMIT"],
    ["ATTACH", "ATTACH DATABASE 'x' AS y"],
    ["an INSERT … RETURNING", "INSERT INTO t (a) VALUES (1) RETURNING id"],
  ])("refuses %s", (_label, sql) => {
    expect(isReadOnlySql(sql)).toBe(false);
  });
});

/** Wrangler's `--json` error body for an overloaded database. */
const OVERLOADED = JSON.stringify({
  error: {
    text: "A request to the Cloudflare API (/accounts/a/d1/database/d/query) failed.",
    notes: [{ text: "D1 DB is overloaded. Too many resources consumed within a 10 second window [code: 7429]" }],
    kind: "error",
    name: "APIError",
    code: 7429,
  },
});

/** An error shaped like the one `execFileSync` throws. */
function execError(stdout: string, stderr = "", status = 1): Error {
  return Object.assign(new Error("Command failed: npx wrangler d1 execute fisqua-db --remote"), { stdout, stderr, status });
}

/** A fake exec that throws each queued failure in turn, then prints `result`. */
function fakeExec(failures: Error[], result = JSON.stringify([{ results: [{ n: 1 }] }])) {
  const calls: string[][] = [];
  const exec = (_command: string, args: string[]) => {
    calls.push(args);
    const failure = failures.shift();
    if (failure) throw failure;
    return result;
  };
  return { exec, calls };
}

const waits: number[] = [];
const quiet = { wait: (ms: number) => void waits.push(ms), random: () => 0, log: () => {} };
const read = ["wrangler", "d1", "execute", "fisqua-db", "--remote", "--json", "--command", "SELECT count(*) AS n FROM entities"];
const write = ["wrangler", "d1", "execute", "fisqua-db", "--remote", "--json", "--command", "UPDATE entities SET name = 'x'"];

describe("runD1", () => {
  it("runs a read again after 7429 and returns the third attempt's output", () => {
    waits.length = 0;
    const { exec, calls } = fakeExec([execError(OVERLOADED), execError(OVERLOADED)]);
    const rows = runD1Json<{ n: number }>(read, { ...quiet, exec });
    expect(rows[0].results).toEqual([{ n: 1 }]);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([5000, 15000]);
  });

  it("adds jitter to each wait", () => {
    waits.length = 0;
    const { exec } = fakeExec([execError(OVERLOADED)]);
    runD1(read, { ...quiet, random: () => 0.5, exec });
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(5000);
    expect(waits[0]).toBeLessThan(7000);
  });

  it("gives up on a read after four attempts and names the code", () => {
    waits.length = 0;
    const { exec, calls } = fakeExec([1, 2, 3, 4, 5].map(() => execError(OVERLOADED)));
    expect(() => runD1(read, { ...quiet, exec })).toThrow(/7429/);
    expect(calls).toHaveLength(4);
    expect(waits).toEqual([5000, 15000, 45000]);
  });

  it("retries a read on an 'overloaded' message that carries no code", () => {
    const { exec, calls } = fakeExec([execError("", "✘ [ERROR] D1 DB is overloaded. Try again later.")]);
    runD1(read, { ...quiet, exec });
    expect(calls).toHaveLength(2);
  });

  it("never runs a write again, and says it may or may not have applied", () => {
    const { exec, calls } = fakeExec([execError(OVERLOADED), execError(OVERLOADED)]);
    let thrown: unknown;
    try {
      runD1(write, { ...quiet, exec });
    } catch (err) {
      thrown = err;
    }
    expect(calls).toHaveLength(1);
    expect(thrown).toBeInstanceOf(D1CommandError);
    const e = thrown as D1CommandError;
    expect(e.code).toBe(7429);
    expect(e.message).toContain("7429");
    expect(e.message).toContain("D1 DB is overloaded");
    expect(e.message).toContain("may or may not have applied");
  });

  it("treats a --file run as a write", () => {
    const { exec, calls } = fakeExec([execError(OVERLOADED)]);
    expect(() =>
      runD1(["wrangler", "d1", "execute", "fisqua-db", "--remote", "--file=/tmp/x.sql"], { ...quiet, exec }),
    ).toThrow(/may or may not have applied/);
    expect(calls).toHaveLength(1);
  });

  it("treats a --command= read as a read", () => {
    const { exec, calls } = fakeExec([execError(OVERLOADED)]);
    runD1(["wrangler", "d1", "execute", "fisqua-db", "--remote", "--json", "--command=SELECT 1"], { ...quiet, exec });
    expect(calls).toHaveLength(2);
  });

  it("does not retry another error, and surfaces its text", () => {
    const body = JSON.stringify({ error: { text: "no such column: nonsense", code: 7500 } });
    const { exec, calls } = fakeExec([execError(body)]);
    let thrown: unknown;
    try {
      runD1(read, { ...quiet, exec });
    } catch (err) {
      thrown = err;
    }
    expect(calls).toHaveLength(1);
    const e = thrown as D1CommandError;
    expect(e.code).toBe(7500);
    expect(e.message).toContain("no such column: nonsense");
    expect(e.message).not.toContain("may or may not have applied");
  });

  it("surfaces a failure whose output is not JSON", () => {
    const { exec } = fakeExec([execError("", "✘ [ERROR] Authentication error [code: 10000]\n")]);
    expect(() => runD1(read, { ...quiet, exec })).toThrow(/Authentication error \[code: 10000\]/);
  });

  it("names the statement it failed on", () => {
    const { exec } = fakeExec([execError("", "boom")]);
    expect(() => runD1(read, { ...quiet, exec })).toThrow(/SELECT count\(\*\) AS n FROM entities/);
  });

  it("strips status lines before the JSON", () => {
    const { exec } = fakeExec([], `Executing on remote database fisqua-db:\n[{"results":[{"n":2}]}]`);
    expect(runD1Json<{ n: number }>(read, { ...quiet, exec })[0].results).toEqual([{ n: 2 }]);
  });

  it("refuses arguments that are not a d1 execute", () => {
    const { exec } = fakeExec([]);
    expect(() => runD1(["wrangler", "deploy"], { ...quiet, exec })).toThrow(/d1 execute/);
  });
});

describe("wranglerFailure", () => {
  it("reads a top-level code and message", () => {
    const f = wranglerFailure(execError(JSON.stringify({ code: 7403, message: "account not valid or not authorized" })));
    expect(f).toEqual({ code: 7403, text: expect.stringContaining("account not valid") });
  });

  it("reads the code from the text when the JSON has none", () => {
    const f = wranglerFailure(execError("", "D1 DB is overloaded [code: 7429]"));
    expect(f.code).toBe(7429);
  });

  it("falls back to the exec error's message when there is no output", () => {
    const f = wranglerFailure(new Error("Command failed: npx wrangler d1 execute"));
    expect(f.code).toBeNull();
    expect(f.text).toContain("Command failed");
  });
});

// ---------------------------------------------------------------------------
// Production reads: one at a time, paced, capped
// ---------------------------------------------------------------------------

const STAGING = ["wrangler", "d1", "execute", "fisqua-staging-db", "--env", "staging", "--remote"];
const LOCAL = ["wrangler", "d1", "execute", "fisqua-db", "--local"];
const PRODUCTION = ["wrangler", "d1", "execute", "fisqua-db", "--remote"];
const readOn = (base: string[], sql = "SELECT count(*) AS n FROM entities") => [...base, "--json", "--command", sql];

const dirs: string[] = [];
// The import suite's config turns the lock and pacing off; these tests turn them back on.
const SWITCH = "FISQUA_D1_PRODUCTION_GUARD";
const switchAsConfigured = process.env[SWITCH];
/** Clears the switch for each test of the block that calls it, and puts it back after. */
function switchCleared() {
  beforeEach(() => {
    delete process.env[SWITCH];
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    if (switchAsConfigured === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = switchAsConfigured;
  });
}

/** A guard over a fresh directory, a fake clock and a recording wait; the exec is a fake unless a test gives one. */
function guarded(dir?: string) {
  const at = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "d1-guard-"));
  if (!dir) dirs.push(at);
  const clock = { t: 1_000_000 };
  const waited: number[] = [];
  const lines: string[] = [];
  const options = {
    random: () => 0,
    log: (l: string) => void lines.push(l),
    wait: (ms: number) => {
      waited.push(ms);
      clock.t += ms;
      // A test that would wait for ever fails instead.
      if (waited.length > 50) throw new Error("waited more than 50 times");
    },
    guard: { dir: at, port: 47999, timeoutMs: 300_000 } as Record<string, unknown>,
  };
  return { dir: at, clock, waited, lines, options };
}

/** An error shaped like the one `execFileSync` throws for a process that exited with `status`. */
const exitError = (status: number, stderr = "") =>
  Object.assign(new Error(`Command failed with exit code ${status}`), { status, stdout: "", stderr });

describe("isProductionRun", () => {
  it("tells production from staging and local", () => {
    expect(isProductionRun(readOn(PRODUCTION))).toBe(true);
    expect(isProductionRun(["wrangler", "d1", "execute", "fisqua-db", "--remote", "--json", "--command=SELECT 1"])).toBe(true);
    expect(isProductionRun(readOn(STAGING))).toBe(false);
    expect(isProductionRun(["wrangler", "d1", "execute", "fisqua-staging-db", "--remote", "--env=staging", "--command=SELECT 1"])).toBe(false);
    expect(isProductionRun(readOn(LOCAL))).toBe(false);
    expect(isProductionRun(["wrangler", "d1", "execute", "fisqua-db", "--command", "SELECT 1"])).toBe(false);
  });

  it("fails safe: staging only for exactly fisqua-staging-db with no fisqua-db anywhere", () => {
    // --cwd takes a value, so the database here is fisqua-db.
    expect(isProductionRun(["wrangler", "d1", "execute", "--cwd", "fisqua-staging-db", "fisqua-db", "--remote", "--command=SELECT 1"])).toBe(true);
    // An unknown flag that takes a value, before the name: whatever it swallows, fisqua-db is named.
    expect(isProductionRun(["wrangler", "d1", "execute", "--some-new-flag", "fisqua-staging-db", "fisqua-db", "--remote", "--command=SELECT 1"])).toBe(true);
    // An unknown flag's value read as the database name is not fisqua-staging-db, so the run is production.
    expect(isProductionRun(["wrangler", "d1", "execute", "--some-new-flag", "x", "fisqua-staging-db", "--remote", "--command=SELECT 1"])).toBe(true);
    expect(isProductionRun(["wrangler", "d1", "execute", "fisqua-staging-db", "--remote", "--command=SELECT 1", "--yes", "fisqua-db"])).toBe(true);
    expect(isProductionRun(["wrangler", "d1", "execute", "fisqua-staging-db", "--env", "staging", "--remote", "--command=SELECT 1"])).toBe(false);
  });

  it("ignores --env and reads the database name wherever it stands", () => {
    expect(isProductionRun(["wrangler", "d1", "execute", "fisqua-db", "--remote", "--env=staging", "--command=SELECT 1"])).toBe(true);
    expect(isProductionRun(["wrangler", "d1", "execute", "fisqua-db", "--remote", "-e", "staging", "--command=SELECT 1"])).toBe(true);
    expect(isProductionRun(["wrangler", "d1", "execute", "--remote", "fisqua-staging-db", "--command=SELECT 1"])).toBe(false);
    expect(isProductionRun(["wrangler", "d1", "execute", "--env", "staging", "--remote", "fisqua-staging-db", "--json"])).toBe(false);
    expect(isProductionRun(["wrangler", "d1", "execute", "--env", "staging", "fisqua-db", "--remote", "--json"])).toBe(true);
  });
});

describe("production reads, one at a time", () => {
  switchCleared();

  it("runs each production attempt through the lock helper, bound to the guard's port, with the time limit", () => {
    const g = guarded();
    const calls: { command: string; args: string[] }[] = [];
    runD1(readOn(PRODUCTION), { ...g.options, exec: (command, args) => (calls.push({ command, args }), "[]") });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(process.execPath);
    expect(calls[0].args[0]).toBe(PRODUCTION_LOCK_HELPER);
    expect(calls[0].args.slice(1, 5)).toEqual(["47999", "300000", path.join(g.dir, "d1-production.last"), "1000"]);
    expect(calls[0].args.slice(-7)).toEqual(readOn(PRODUCTION).slice(1));
    expect(PRODUCTION_LOCK_PORT).toBe(47393);
    expect(PRODUCTION_ATTEMPT_TIMEOUT_MS).toBe(300_000);
  });

  it("waits and tries again while another process holds the port, saying so once", () => {
    const g = guarded();
    let n = 0;
    const exec = () => {
      n++;
      if (n <= 3) throw exitError(LOCK_BUSY_EXIT);
      return "[]";
    };
    expect(runD1(readOn(PRODUCTION), { ...g.options, exec })).toBe("[]");
    expect(n).toBe(4);
    expect(g.waited.filter((ms) => ms === LOCK_POLL_MS).length).toBeGreaterThanOrEqual(3);
    expect(g.lines.filter((l) => /waiting/i.test(l))).toHaveLength(1);
    expect(g.lines.join("\n")).toContain("47999");
  });

  it("does not count a wait for the port as an attempt, and frees the port during an overload's backoff", () => {
    const g = guarded();
    const seen: string[] = [];
    const exec = () => {
      seen.push("call");
      if (seen.length === 1) throw execError(OVERLOADED);
      if (seen.length === 2) throw exitError(LOCK_BUSY_EXIT);
      return "[]";
    };
    runD1(readOn(PRODUCTION), { ...g.options, exec });
    expect(seen).toHaveLength(3);
    expect(g.waited).toContain(5000);
  });

  it("names the port when the helper cannot bind it for another reason", () => {
    const g = guarded();
    const exec = () => {
      throw exitError(70, "Could not bind the production D1 read lock 127.0.0.1:47999: EACCES");
    };
    expect(() => runD1(readOn(PRODUCTION), { ...g.options, exec })).toThrow(/127\.0\.0\.1:47999/);
  });

  it("treats an attempt that ran out of time as an error, not a retry", () => {
    const g = guarded();
    let n = 0;
    const exec = () => {
      n++;
      throw exitError(LOCK_TIMEOUT_EXIT, "The production D1 read ran longer than 300000 ms and was stopped.");
    };
    expect(() => runD1(readOn(PRODUCTION), { ...g.options, exec })).toThrow(/time limit/);
    expect(n).toBe(1);
  });

  it("leaves writes alone: no helper, no wait", () => {
    const g = guarded();
    const commands: string[] = [];
    runD1([...PRODUCTION, "--file", "/tmp/x.sql", "--yes"], { ...g.options, exec: (c) => (commands.push(c), "[]") });
    runD1([...PRODUCTION, "--file", "/tmp/x.sql", "--yes"], { ...g.options, exec: (c) => (commands.push(c), "[]") });
    expect(commands).toEqual(["npx", "npx"]);
    expect(g.waited).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The lock helper, run for real against a port of each test's own
// ---------------------------------------------------------------------------

/** A free loopback port, found by binding port 0. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** True when the port can be bound now. */
async function portFree(port: number): Promise<boolean> {
  const server = net.createServer();
  return new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A stand-in for wrangler: records when it started and ended, sleeps, prints JSON. */
function fakeWrangler(dir: string): string {
  const file = path.join(dir, "fake-wrangler.mjs");
  fs.writeFileSync(
    file,
    [
      'import * as fs from "node:fs";',
      "const [log, ms] = [process.env.FAKE_LOG, Number(process.env.FAKE_MS ?? 0)];",
      'fs.appendFileSync(log, `start ${Date.now()}\\n`);',
      "setTimeout(() => {",
      '  fs.appendFileSync(log, `end ${Date.now()}\\n`);',
      '  process.stdout.write(JSON.stringify([{ results: [{ n: 1 }] }]));',
      "}, ms);",
    ].join("\n"),
  );
  return file;
}

const realExec = (env: Record<string, string>) => (command: string, args: string[], opts: { maxBuffer?: number; input?: string }) =>
  execFileSync(command, args, { encoding: "utf8", env: { ...process.env, ...env }, input: opts.input, maxBuffer: opts.maxBuffer });

/** A last-read file in a fresh directory, for helper runs whose pacing does not matter. */
function noLast(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d1-last-"));
  dirs.push(dir);
  return path.join(dir, "d1-production.last");
}

describe("the production lock helper", () => {
  switchCleared();
  const helper = PRODUCTION_LOCK_HELPER;

  it("passes stdin, stdout, stderr and the exit code through unchanged", async () => {
    const port = await freePort();
    const r = spawnSync(
      process.execPath,
      [helper, String(port), "5000", noLast(), "0", process.execPath, "-e",
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write('out:'+s);process.stderr.write('err');process.exit(3)})"],
      { input: "in", encoding: "utf8" },
    );
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("out:in");
    expect(r.stderr).toBe("err");
    expect(await portFree(port)).toBe(true);
  });

  it("exits with the busy code and runs nothing while another process holds the port", async () => {
    const port = await freePort();
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve()));
    try {
      const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "d1-helper-")), "ran");
      const r = spawnSync(process.execPath, [helper, String(port), "5000", noLast(), "0", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`], {
        encoding: "utf8",
      });
      expect(r.status).toBe(LOCK_BUSY_EXIT);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  it("names the port when the bind fails for another reason", () => {
    const r = spawnSync(process.execPath, [helper, "99999", "5000", noLast(), "0", process.execPath, "-e", "0"], { encoding: "utf8" });
    expect(r.status).toBe(70);
    expect(r.stderr).toContain("127.0.0.1:99999");
  });

  it("stops the command after its time limit and exits with the time-limit code", async () => {
    const port = await freePort();
    const started = Date.now();
    const r = spawnSync(process.execPath, [helper, String(port), "300", noLast(), "0", process.execPath, "-e", "setTimeout(() => {}, 20000)"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(LOCK_TIMEOUT_EXIT);
    expect(r.stderr).toMatch(/300 ms/);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await portFree(port)).toBe(true);
  });

  it("leaves no stale state when killed mid-read: the port is free once the command it ran has ended", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [helper, String(port), "60000", noLast(), "0", process.execPath, "-e", "setTimeout(() => {}, 1500)"], {
      stdio: "ignore",
    });
    await until(async () => !(await portFree(port)));
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    // The command still holds the port it was handed until it ends; then the kernel frees it.
    await until(() => portFree(port), 10_000);
    expect(await portFree(port)).toBe(true);
  }, 20_000);

  it("makes a second runD1 reader wait until the first reader's helper has exited", async () => {
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d1-two-"));
    dirs.push(dir);
    const wrangler = fakeWrangler(dir);
    const logA = path.join(dir, "a.log");
    const logB = path.join(dir, "b.log");
    // Reader A: a helper in another process, holding the port for 1.5 s.
    const a = spawn(process.execPath, [helper, String(port), "60000", path.join(dir, "d1-production.last"), "0", process.execPath, wrangler], {
      stdio: "ignore",
      env: { ...process.env, FAKE_LOG: logA, FAKE_MS: "1500" },
    });
    await until(() => fs.existsSync(logA));
    // Reader B: runD1 in this process, through the real helper.
    const lines: string[] = [];
    const out = runD1(readOn(PRODUCTION), {
      exec: realExec({ FAKE_LOG: logB, FAKE_MS: "0" }),
      wait: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(ms, 100)),
      log: (l) => void lines.push(l),
      guard: { dir, port, timeoutMs: 60_000, gapMs: 0, wrangler: [process.execPath, wrangler] },
    });
    await new Promise((r) => (a.exitCode === null ? a.once("exit", r) : r(null)));
    expect(JSON.parse(out)[0].results).toEqual([{ n: 1 }]);
    const time = (file: string, what: string) => Number(fs.readFileSync(file, "utf8").match(new RegExp(`${what} (\\d+)`))![1]);
    expect(time(logB, "start")).toBeGreaterThanOrEqual(time(logA, "end"));
    expect(lines.filter((l) => /waiting/i.test(l))).toHaveLength(1);
  }, 20_000);
});

describe("production reads, paced inside the lock", () => {
  switchCleared();
  const helper = PRODUCTION_LOCK_HELPER;

  it("starts two back-to-back reads through real helpers at least a second apart", async () => {
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d1-pace-"));
    dirs.push(dir);
    const wrangler = fakeWrangler(dir);
    const log = path.join(dir, "reads.log");
    const options = {
      exec: realExec({ FAKE_LOG: log, FAKE_MS: "0" }),
      log: () => {},
      guard: { dir, port, timeoutMs: 60_000, wrangler: [process.execPath, wrangler] },
    };
    runD1(readOn(PRODUCTION), options);
    runD1(readOn(PRODUCTION), options);
    const times = (what: string) => [...fs.readFileSync(log, "utf8").matchAll(new RegExp(`${what} (\\d+)`, "g"))].map((m) => Number(m[1]));
    const [, start2] = times("start");
    const [end1] = times("end");
    expect(start2 - end1).toBeGreaterThanOrEqual(PRODUCTION_READ_GAP_MS);
    expect(PRODUCTION_READ_GAP_MS).toBe(1000);
  }, 20_000);

  it("writes the end time of the read to the last-read file", async () => {
    const port = await freePort();
    const last = noLast();
    const r = spawnSync(process.execPath, [helper, String(port), "5000", last, "0", process.execPath, "-e", "0"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(Number(fs.readFileSync(last, "utf8"))).toBeGreaterThan(0);
    expect(await portFree(port)).toBe(true);
  });

  it("logs a last-read time it cannot write, and keeps the command's exit code and output", async () => {
    const port = await freePort();
    const last = noLast();
    fs.mkdirSync(last);
    const r = spawnSync(
      process.execPath,
      [helper, String(port), "5000", last, "0", process.execPath, "-e", "process.stdout.write('out'); process.exit(4)"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(4);
    expect(r.stdout).toBe("out");
    expect(r.stderr).toMatch(/could not record/i);
  });

  it("logs a last-read time it cannot read, and runs without waiting", async () => {
    const port = await freePort();
    const last = noLast();
    fs.mkdirSync(last);
    const started = Date.now();
    const r = spawnSync(process.execPath, [helper, String(port), "5000", last, "60000", process.execPath, "-e", "0"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/could not read/i);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("runD1 itself does not pace production reads: the helper does", () => {
    const g = guarded();
    let n = 0;
    runD1(readOn(PRODUCTION), { ...g.options, exec: () => (n++, "[]") });
    runD1(readOn(PRODUCTION), { ...g.options, exec: () => (n++, "[]") });
    expect(n).toBe(2);
    expect(g.waited).toEqual([]);
  });
});

describe("production reads, capped", () => {
  switchCleared();
  it("refuses a chunk above 1,000 rows before it runs, naming the cap", () => {
    expect(PRODUCTION_READ_CAP).toBe(1000);
    for (const sql of [
      "SELECT id FROM entities ORDER BY id LIMIT 1001",
      "SELECT id FROM entities ORDER BY id limit 5000 OFFSET 10",
      "SELECT id FROM entities ORDER BY id LIMIT 10, 2000",
      "SELECT max(id) FROM (SELECT id FROM entities ORDER BY id LIMIT 2000)",
    ]) {
      const g = guarded();
      let ran = false;
      expect(() => runD1(readOn(PRODUCTION, sql), { ...g.options, exec: () => ((ran = true), "[]") })).toThrow(/1,000/);
      expect(ran).toBe(false);
      expect(fs.readdirSync(g.dir)).toEqual([]);
    }
  });

  it("refuses any LIMIT that is not a plain number, naming the forms it takes", () => {
    for (const sql of [
      "SELECT id FROM entities LIMIT (2000)",
      "SELECT id FROM entities LIMIT -1",
      "SELECT id FROM entities LIMIT 500 + 600",
      "SELECT id FROM entities LIMIT '5000'",
      "SELECT id FROM entities LIMIT 10 OFFSET 5 * 2",
      "SELECT id FROM entities LIMIT (SELECT count(*) FROM places)",
    ]) {
      const g = guarded();
      let ran = false;
      expect(() => runD1(readOn(PRODUCTION, sql), { ...g.options, exec: () => ((ran = true), "[]") }), sql).toThrow(
        /LIMIT <n> OFFSET <m>/,
      );
      expect(ran).toBe(false);
    }
  });

  it("allows a chunk of exactly 1,000, and ignores LIMIT inside a string", () => {
    for (const sql of [
      "SELECT id FROM entities ORDER BY id LIMIT 1000",
      "SELECT id FROM entities ORDER BY id LIMIT 1000 OFFSET 20000",
      "SELECT max(id) FROM (SELECT id FROM entities ORDER BY id LIMIT 1000)",
      "SELECT id FROM entities ORDER BY id LIMIT 5000, 1000",
      "SELECT id FROM entities WHERE name = 'LIMIT 5000'",
    ]) {
      const g = guarded();
      let ran = false;
      runD1(readOn(PRODUCTION, sql), { ...g.options, exec: () => ((ran = true), "[]") });
      expect(ran).toBe(true);
    }
  });

  it("holds the cap even when the helper and pacing are off", () => {
    expect(() =>
      runD1(readOn(PRODUCTION, "SELECT id FROM entities LIMIT 1001"), { ...quiet, guard: false, exec: () => "[]" }),
    ).toThrow(/1,000/);
    process.env[SWITCH] = "off";
    const g = guarded();
    expect(() => runD1(readOn(PRODUCTION, "SELECT id FROM entities LIMIT 1001"), { ...g.options, exec: () => "[]" })).toThrow(
      /1,000/,
    );
  });

  it("skips the helper and the pacing when FISQUA_D1_PRODUCTION_GUARD=off", () => {
    process.env[SWITCH] = "off";
    const g = guarded();
    const commands: string[] = [];
    const exec = (c: string) => (commands.push(c), "[]");
    runD1(readOn(PRODUCTION), { ...g.options, exec });
    runD1(readOn(PRODUCTION), { ...g.options, exec });
    expect(commands).toEqual(["npx", "npx"]);
    expect(g.waited).toEqual([]);
    expect(fs.readdirSync(g.dir)).toEqual([]);
  });
});

describe("staging and local reads", () => {
  switchCleared();
  it.each([
    ["staging", STAGING],
    ["local", LOCAL],
  ])("on %s take no helper, no pacing and no cap", (_label, base) => {
    const g = guarded();
    const commands: string[] = [];
    const exec = (c: string) => (commands.push(c), "[]");
    runD1(readOn(base, "SELECT id FROM entities LIMIT 5000"), { ...g.options, exec });
    runD1(readOn(base, "SELECT id FROM entities LIMIT 5000"), { ...g.options, exec });
    expect(commands).toEqual(["npx", "npx"]);
    expect(g.waited).toEqual([]);
    expect(fs.readdirSync(g.dir)).toEqual([]);
  });
});
