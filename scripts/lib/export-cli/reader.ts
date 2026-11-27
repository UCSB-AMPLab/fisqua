/**
 * Scripts — the export's reader, one statement at a time
 *
 * This module deals with the export's reader, which sends one statement at
 * a time. `PacedReader.select` is the only way the export reaches D1.
 * Reads of wide joins and correlated counts, sent page after page and sent
 * again on every overload, can overload production D1, and while it is
 * overloaded every workspace sign-in answers 500. The reader holds these
 * limits:
 *
 *   - every statement passes `assertSelectOnly` (`./select-guard.ts`)
 *     before anything is sent;
 *   - one statement at a time (the caller awaits each), and at least
 *     `GAP_MS` (1 s) from the end of one statement, answered or refused,
 *     to the start of the next;
 *   - the sign-in page is fetched before the first statement and before
 *     every twentieth after it (`LOGIN_EVERY`); anything but 200, a
 *     redirect included, or a fetch that fails stops the run;
 *   - D1's overload refusal, recognised by `OVERLOADED` (the wording
 *     `app/lib/d1-overload.ts` matches), is waited out once: the first
 *     in a run waits `OVERLOAD_WAIT_MS` (3 minutes), fetches the sign-in
 *     page again and sends that statement once more; a second overload
 *     anywhere in the run stops it. Any other refusal stops the run, and
 *     an `ExportStop` the runner throws (`./d1.ts`, for a production read
 *     stopped at its time limit) stops it at once, never read as an
 *     overload.
 *
 * The D1 runner it is given must make exactly one attempt per call:
 * the CLI's runner (`./d1.ts`, `scripts/fisqua.ts`) calls wrangler
 * once, not through `runD1`, whose reads are retried on overload. On
 * production that call goes through the production read lock every
 * command-line production read takes (`../d1-production-lock-run.mjs`),
 * which may wait for another reader before it sends anything and keeps
 * 1 s between production reads across processes; the gap above is the
 * reader's own and holds on staging too.
 * A stop is an `ExportStop`, which the run turns into a README.md that
 * says the folder is partial.
 *
 * @version v0.9.0
 */

import { assertSelectOnly } from "./select-guard";

export type Row = Record<string, unknown>;

export interface ReaderProviders {
  /** Sends one statement to D1, once, and returns its rows; `lockFd` is the lock's descriptor, for the process that sends it. */
  d1: (sql: string, lockFd?: number | null) => Promise<Row[]>;
  /** Fetches the sign-in page; the status is all that is read. */
  fetch: (url: string) => Promise<{ status: number }>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

export const GAP_MS = 1_000;
export const LOGIN_EVERY = 20;
export const OVERLOAD_WAIT_MS = 180_000;
export const OVERLOADED = /D1 DB is overloaded|\[code:\s*7429\]/i;

/** Stops the run; the folder is left partial and the checkpoint lets a later run resume. */
export class ExportStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportStop";
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class PacedReader {
  /** Statements sent in this run, retries included. */
  sent = 0;
  overloads = 0;
  loginChecks = 0;
  private lastEnd: number | null = null;

  constructor(
    private readonly p: ReaderProviders,
    readonly loginUrl: string,
  ) {}

  /** Sends one SELECT under the limits in the module header and returns its rows. */
  async select(sql: string): Promise<Row[]> {
    assertSelectOnly(sql);
    return this.send(sql, false);
  }

  private async send(sql: string, retry: boolean): Promise<Row[]> {
    if (retry || this.sent % LOGIN_EVERY === 0) await this.checkLogin();
    if (this.lastEnd !== null) {
      const wait = this.lastEnd + GAP_MS - this.p.now();
      if (wait > 0) await this.p.sleep(wait);
    }
    this.sent++;
    try {
      const rows = await this.p.d1(sql);
      this.lastEnd = this.p.now();
      return rows;
    } catch (err) {
      this.lastEnd = this.p.now();
      // A runner's own stop (a production read stopped at its time limit) is final.
      if (err instanceof ExportStop) throw err;
      const message = messageOf(err);
      if (!OVERLOADED.test(message)) throw new ExportStop(`D1 refused a read: ${message.slice(0, 600)}`);
      this.overloads++;
      if (this.overloads > 1) {
        throw new ExportStop(`D1 refused a read as overloaded (7429) for the second time in this run: ${message.slice(0, 300)}`);
      }
      this.p.log(`D1 is overloaded (7429); waiting ${OVERLOAD_WAIT_MS / 1000} s, then sending that statement once more.`);
      await this.p.sleep(OVERLOAD_WAIT_MS);
      return this.send(sql, true);
    }
  }

  private async checkLogin(): Promise<void> {
    this.loginChecks++;
    let status: number;
    try {
      status = (await this.p.fetch(this.loginUrl)).status;
    } catch (err) {
      throw new ExportStop(`The sign-in page ${this.loginUrl} could not be fetched: ${messageOf(err)}`);
    }
    if (status !== 200) throw new ExportStop(`The sign-in page ${this.loginUrl} answered ${status}, not 200`);
  }
}

// @version v0.9.0
