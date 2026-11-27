/**
 * Scripts — what every noun of the command line shares
 *
 * This module holds the parts of `scripts/fisqua.ts` that do not depend
 * on what a noun changes: the arguments every noun takes, the one check
 * that an apply to production is confirmed, the providers a run is
 * given, the name of a run's files, and the step that hands the SQL file
 * to wrangler only when it holds the SQL the run planned. The nouns
 * (`../authorities-cli/`, `../descriptions-cli/`) read, plan, build their
 * SQL and verify on their own.
 *
 *   `<noun> plan|apply <file> --target staging|production --tenant <slug>
 *    --actor-email <email> [--confirm-production]`
 *
 * The change file is read as bytes and decoded as UTF-8 in fatal mode
 * (`decodeUtf8`, as the import's CSV intake reads): a file in another
 * encoding stops the run before anything is planned, rather than
 * reaching D1 with replacement characters where its accents were.
 *
 * A run's files are `.import/<noun>_<target>_<stamp>-<suffix>.json`,
 * `.md` and `.sql`, the suffix eight random hex characters, so no two
 * runs share a name. The SQL file is created, never replaced, and read
 * back and hashed (SHA-256) just before the apply.
 *
 * @version v0.9.0
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { CsvEncodingError, decodeUtf8 } from "../../../app/lib/import/csv";
import type { RowReader } from "../authority-links";
import { runIdOf } from "../run-id";

export type Target = "staging" | "production";

export interface CliArgs {
  command: "plan" | "apply";
  file: string;
  target: Target;
  tenant: string;
  actorEmail: string;
  confirmProduction: boolean;
}

/** `<noun> plan|apply <file> --target --tenant --actor-email [--confirm-production]`. */
export function parseCliArgs(noun: string, argv: string[]): CliArgs {
  const [given, command, ...rest] = argv;
  if (given !== noun) throw new Error(`Usage: fisqua ${noun} plan|apply <file> --target staging|production --tenant <slug> --actor-email <email>`);
  if (command !== "plan" && command !== "apply") throw new Error(`${noun} takes plan or apply`);
  let file = "";
  let target: string | null = null;
  let tenant = "";
  let actorEmail = "";
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
    else if (a === "--actor-email") actorEmail = value();
    else if (!a.startsWith("--") && !file) file = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!file) throw new Error(`${noun} needs a change file`);
  if (target !== "staging" && target !== "production") throw new Error("--target is staging or production");
  if (!tenant) throw new Error("--tenant <slug> is required");
  if (!actorEmail) throw new Error("--actor-email is required");
  return { command, file, target, tenant, actorEmail, confirmProduction };
}

/** The change file's text, decoded as UTF-8 in fatal mode, without a leading BOM; anything else stops the run. */
export function readChangeFile(file: string, readBytes: (file: string) => Uint8Array = (f) => fs.readFileSync(f)): string {
  let bytes: Uint8Array;
  try {
    bytes = readBytes(file);
  } catch (err) {
    throw new Error(`The file ${file} is not readable: ${(err as Error).message}`);
  }
  try {
    return decodeUtf8(bytes);
  } catch (err) {
    if (err instanceof CsvEncodingError) throw new Error(`The file ${file} is not valid UTF-8; save it as UTF-8 and plan again`);
    throw err;
  }
}

export interface RunOptions {
  target: Target;
  tenant: string;
  actorEmail: string;
  apply: boolean;
  confirmProduction: boolean;
}

export interface RunProviders {
  rows: RowReader;
  /** Writes the report, replacing a file of that name. */
  writeFile: (path: string, text: string) => void;
  /** Creates the SQL file, failing when a file of that name exists. */
  createFile: (path: string, text: string) => void;
  /** Reads a file back, to check the SQL file before it is applied. */
  readFile: (path: string) => string;
  /** A random id; its first eight hex characters make the run's name unique. */
  newId: () => string;
  /** Applies the SQL file with `wrangler d1 execute --file`; `statements` are its statements, in order. */
  applyFile: (path: string, statements: string[]) => Promise<void> | void;
  now: () => number;
}

export const OUTPUT_DIR = ".import";

export type Outcome = "verified" | "not verified" | "refused" | "dry run" | "nothing to write" | "stopped during the write";

/** The exit code: 0 for a dry run without refusals, nothing to write, or a write that read back as planned. */
export function exitCodeOfOutcome(outcome: Outcome): number {
  return outcome === "verified" || outcome === "nothing to write" || outcome === "dry run" ? 0 : 1;
}

/** The one place an apply to production is confirmed; it runs before anything is read. */
export function assertProductionConfirmed(options: RunOptions, stop: (message: string) => Error): void {
  if (options.apply && options.target === "production" && !options.confirmProduction) {
    throw stop("Applying to production also needs --confirm-production");
  }
}

/** The run's stamp, and the path its files share without their extension. */
export function runNameOf(noun: string, target: Target, providers: Pick<RunProviders, "now" | "newId">, now: number): { stamp: string; name: string } {
  // The stamp and a random suffix: two runs started in the same second
  // never share a report or a SQL file.
  const stamp = runIdOf(now, providers.newId());
  return { stamp, name: `${OUTPUT_DIR}/${noun}_${target}_${stamp}` };
}

/**
 * Applies the SQL file, after checking that the file on disk, read just
 * before the apply, hashes to the SQL the run holds; applies nothing
 * otherwise.
 */
export async function applyCheckedSqlFile(
  providers: Pick<RunProviders, "readFile" | "applyFile">,
  sqlFile: string,
  sqlText: string,
  statements: string[],
  log: (line: string) => void,
  stop: (message: string) => Error,
): Promise<void> {
  const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
  if (sha(providers.readFile(sqlFile)) !== sha(sqlText)) {
    throw stop(`${sqlFile} does not hold the SQL this run planned; nothing was applied`);
  }
  log(`\nApplying ${statements.length} statements from ${sqlFile}`);
  await providers.applyFile(sqlFile, statements);
}

// @version v0.9.0
