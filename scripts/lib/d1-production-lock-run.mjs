/**
 * Scripts — the production D1 read lock, held by the kernel for one attempt
 *
 * This script holds the production D1 read lock for one attempt, through
 * the kernel. `runD1` (`./d1-cli.ts`) sends every attempt at a production
 * read through it: `node d1-production-lock-run.mjs <port> <limit-ms>
 * <last-file> <gap-ms> <command> [args…]`. The script binds
 * `127.0.0.1:<port>` (47393, `PRODUCTION_LOCK_PORT`) with `exclusive:
 * true`; then, holding the port, it paces, runs the command, records the
 * end time and exits with the command's exit code. `runD1` is synchronous
 * and Node cannot bind a port synchronously, which is why the lock is held
 * by a process of its own.
 *
 * Why this is complete. The only thing trusted is the kernel's exclusive
 * bind of one address and port, as in the export's lock
 * (`./export-cli/lock.ts`): two listeners cannot hold it at once, and the
 * kernel releases it when every process holding the socket has closed it
 * or exited, however it exits, a kill -9 included. Nothing is written to
 * disk, so there is no stale lock to find or judge. The command is given
 * the listening socket as its file descriptor 3, so the port stays bound
 * until both this script and the command have ended: killing the script
 * does not free the port while the query may still be running. `runD1`
 * runs wrangler's `wrangler-dist/cli.js` with node directly, not npx or
 * the package's bin, because each would put a further process between
 * this one and the one that sends the query, and descriptor 3 would not
 * reach it.
 *
 * Exit codes. A port another process holds (EADDRINUSE) exits with 75
 * and runs nothing; `runD1` then waits and tries again. Any other bind
 * failure exits with 70 and says which port. When the command runs longer
 * than `<limit-ms>` it is sent SIGTERM, then SIGKILL 5 s later, and the
 * script exits with 124 once it has ended. A command ended by a signal
 * exits with 128 plus the signal's number. Otherwise the command's own
 * code is passed on. Its stdin, stdout and stderr are this script's own,
 * so they pass through unchanged. SIGINT, SIGTERM and SIGHUP sent to this
 * script are passed on to the command, and the script keeps the port
 * until the command has ended.
 *
 * Pacing. Once the port is bound, the script reads the end time of the
 * last production read from `<last-file>` (`d1-production.last` in the
 * cache directory) and waits until `<gap-ms>` (1 s,
 * `PRODUCTION_READ_GAP_MS`) has passed since it, so two production reads
 * are at least that far apart whichever processes ran them. When the
 * command has ended it writes the time to the file, through a temporary
 * file and a rename, before it exits and the port is freed. A file that
 * cannot be read is reported on stderr and the command runs without the
 * wait; one that cannot be written is reported on stderr. Neither changes
 * the exit code or the command's output.
 * If this script is killed with SIGKILL mid-read, wrangler keeps the port
 * until it exits but no end time is written, so the next production read
 * may start less than 1 s after that read ends; exclusion still holds, and
 * the gap can be missed only that once, after a helper is killed by hand.
 *
 * The server serves nothing: any connection that arrives is closed at once.
 *
 * @version v0.9.0
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createServer } from "node:net";
import { constants } from "node:os";
import * as path from "node:path";

export const LOCK_HOST = "127.0.0.1";
export const BUSY_EXIT = 75;
export const BIND_ERROR_EXIT = 70;
export const TIMEOUT_EXIT = 124;
const KILL_GRACE_MS = 5_000;

const [portText, limitText, lastFile, gapText, command, ...args] = process.argv.slice(2);
const port = Number(portText);
const limitMs = Number(limitText);
const gapMs = Number(gapText);

if (!command || !lastFile || !Number.isFinite(limitMs) || limitMs <= 0 || !Number.isFinite(gapMs) || gapMs < 0) {
  process.stderr.write("Usage: node d1-production-lock-run.mjs <port> <limit-ms> <last-file> <gap-ms> <command> [args…]\n");
  process.exit(BIND_ERROR_EXIT);
}

/** @param {unknown} err */
const messageOf = (err) => (err instanceof Error ? err.message : String(err));

/** How long to wait before the command starts: the rest of the gap since the last read ended. */
function waitBefore() {
  let last = NaN;
  try {
    last = Number(fs.readFileSync(lastFile, "utf8"));
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") {
      process.stderr.write(`Could not read the time of the last production read from ${lastFile}: ${messageOf(err)}; not waiting for it.\n`);
    }
  }
  if (!Number.isFinite(last)) return 0;
  return Math.max(0, last + gapMs - Date.now());
}

/** Writes the end time of this read; a failure is reported, never thrown. */
function recordEnd() {
  const temp = `${lastFile}.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(lastFile), { recursive: true });
    fs.writeFileSync(temp, String(Date.now()));
    fs.renameSync(temp, lastFile);
  } catch (err) {
    process.stderr.write(`Could not record the end of this production read in ${lastFile}: ${messageOf(err)}.\n`);
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // The notice above says what failed.
    }
  }
}

/**
 * @param {unknown} err
 * @returns {never}
 */
function bindFailed(err) {
  const e = /** @type {NodeJS.ErrnoException | undefined} */ (err);
  if (e && e.code === "EADDRINUSE") process.exit(BUSY_EXIT);
  process.stderr.write(`Could not bind the production D1 read lock ${LOCK_HOST}:${portText}: ${e?.message ?? String(err)}\n`);
  return process.exit(BIND_ERROR_EXIT);
}

const server = createServer((socket) => socket.destroy());
server.once("error", bindFailed);
try {
  server.listen({ host: LOCK_HOST, port, exclusive: true }, () => setTimeout(run, waitBefore()));
} catch (err) {
  bindFailed(err);
}

function run() {
  // Node does not document the descriptor; its handle carries it on Unix.
  const fd = /** @type {{ _handle?: { fd?: unknown } }} */ (/** @type {unknown} */ (server))._handle?.fd;
  if (typeof fd !== "number" || !Number.isInteger(fd) || fd <= 2) {
    return bindFailed(new Error("the bound socket has no descriptor to hand to the command"));
  }
  const child = spawn(command, args, { stdio: ["inherit", "inherit", "inherit", fd] });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.stderr.write(`The production D1 read ran longer than ${limitMs} ms and was stopped.\n`);
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
  }, limitMs);
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) process.on(signal, () => child.kill(signal));
  child.once("error", (err) => {
    clearTimeout(timer);
    process.stderr.write(`Could not run ${command}: ${err.message}\n`);
    process.exit(127);
  });
  child.once("exit", (code, signal) => {
    clearTimeout(timer);
    recordEnd();
    if (timedOut) process.exit(TIMEOUT_EXIT);
    if (signal) process.exit(128 + (constants.signals[/** @type {NodeJS.Signals} */ (signal)] ?? 0));
    process.exit(code ?? 1);
  });
}

// @version v0.9.0
