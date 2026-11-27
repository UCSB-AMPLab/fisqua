/**
 * Scripts — the export's one call to wrangler per statement
 *
 * This module deals with the export's one call to wrangler per statement.
 * `exportD1(target)` gives the D1 runner that `PacedReader`
 * (`./reader.ts`) sends every statement through: one wrangler process per
 * call, running `d1 execute <database> … --json --command <sql>` with the
 * target's database flags from `d1Args` (`../tenant-storage.ts`). It never
 * sends a statement twice. `runD1` (`../d1-cli.ts`) is not used, because
 * it sends a read again on an overload, and the export's overload rule
 * (wait 3 minutes, one more attempt, stop at the second) belongs to the
 * reader alone.
 *
 * The process is node running wrangler's `wrangler-dist/cli.js`, found
 * from `wrangler/package.json` (its `main`), with the two flags the
 * package's bin gives it (`--no-warnings --experimental-vm-modules`).
 * Neither npx nor the bin is used: each would put a further process
 * between this one and the one that sends the query. The export lock's
 * descriptor is handed to the process this module starts as its
 * descriptor 3, so that process holds the export lock's port for as long
 * as it runs (`./lock.ts`).
 *
 * Production statements take the production read lock that `runD1`
 * takes, as well as the export lock. Each is checked against the
 * 1,000-row cap before anything is sent (`assertProductionReadCap`), then
 * sent through the lock helper (`runLockedRead`,
 * `../d1-production-lock-run.mjs`): the process this module starts is the
 * helper, holding the export lock's descriptor as its descriptor 3; the
 * helper binds 127.0.0.1:47393, waits until 1 s has passed since the last
 * production read ended, whichever process ran it, and runs cli.js with
 * the read lock's socket as cli.js's descriptor 3. So an export's
 * production statement and any other command-line production read never
 * run at once. While another process holds 47393 the call waits and tries
 * again; that try sends nothing. An attempt the helper stops at its time
 * limit (5 minutes) is thrown as an `ExportStop`, which the reader passes
 * on without reading it for an overload, so the run stops and the
 * statement is not sent again even when its output mentions one. The helper passes cli.js's stdout and stderr through unchanged, so
 * the output read here is the same. When `FISQUA_D1_PRODUCTION_GUARD=off`
 * (the import suite's tests) or `guard: false`, production statements are
 * capped but sent as staging ones are. Staging statements are unchanged.
 *
 * A failure is thrown as `wrangler d1 execute failed [code: N]: <text>`,
 * the code and text read by `wranglerFailure`, so the reader recognises
 * a 7429 by D1's own wording. Wrangler's status lines before the JSON
 * are dropped, and the first result set's rows are returned.
 *
 * The exec, the read lock's guard, its wait and its log are injectable,
 * so the tests count calls without a subprocess.
 *
 * @version v0.9.0
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import {
  assertProductionReadCap,
  D1CommandError,
  guardOf,
  runLockedRead,
  wranglerFailure,
  type D1Exec,
  type D1ExecOptions,
  type D1RunOptions,
} from "../d1-cli";
import { d1Args } from "../tenant-storage";
import { ExportStop, type Row } from "./reader";

const defaultExec: D1Exec = (command, args, options) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["pipe", "pipe", "pipe"],
    maxBuffer: options.maxBuffer,
  });

/** The path of wrangler's `cli.js`, the process that sends the query. */
export function wranglerCliPath(): string {
  const pkgPath = createRequire(import.meta.url).resolve("wrangler/package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { main?: string };
  return path.join(path.dirname(pkgPath), pkg.main ?? "wrangler-dist/cli.js");
}

/** What `exportD1` passes on to the production read lock; see the module header. */
export type ExportReadLockOptions = Pick<D1RunOptions, "guard" | "wait" | "log">;

/** The D1 runner for `target`: one exec per call, holding `lockFd` as its descriptor 3; `cli` is replaced only in tests. */
export function exportD1(
  target: "staging" | "production",
  exec: D1Exec = defaultExec,
  cli: string = wranglerCliPath(),
  options: ExportReadLockOptions = {},
): (sql: string, lockFd?: number | null) => Promise<Row[]> {
  const node = [process.execPath, "--no-warnings", "--experimental-vm-modules", cli];
  return async (sql, lockFd) => {
    const args = [...d1Args(target), "--json", "--command", sql];
    const execOptions: D1ExecOptions = {
      stdio: lockFd === null || lockFd === undefined ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", lockFd],
      maxBuffer: 256 * 1024 * 1024,
    };
    const g = target === "production" ? guardOf(options.guard) : null;
    if (target === "production") assertProductionReadCap(sql);
    let out: string;
    try {
      out = g
        ? runLockedRead({ ...g, wrangler: node }, args, { exec, wait: options.wait, log: options.log, ...execOptions })
        : exec(node[0], [...node.slice(1), ...args.slice(1)], execOptions);
    } catch (err) {
      // A stop at the time limit is final: it is never sent again, whatever its output says.
      if (err instanceof D1CommandError) throw new ExportStop(`D1 refused a read: ${err.message.slice(0, 600)}`);
      const failure = wranglerFailure(err);
      throw new Error(`wrangler d1 execute failed${failure.code === null ? "" : ` [code: ${failure.code}]`}: ${failure.text}`);
    }
    const start = out.search(/[[{]/);
    if (start < 0) throw new Error(`wrangler produced no JSON output: ${out.slice(0, 200)}`);
    const parsed = JSON.parse(out.slice(start)) as Array<{ results?: Row[] }>;
    return parsed[0]?.results ?? [];
  };
}

// @version v0.9.0
