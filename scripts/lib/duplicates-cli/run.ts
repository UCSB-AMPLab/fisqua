/**
 * Scripts — the duplicates command
 *
 * This module deals with `duplicates rebuild`, which marks every live
 * entity record (one whose `merged_into` is empty) in `duplicate_recheck`
 * with an empty `description_id`, so that the job that runs every five
 * minutes looks at each of them again and refills `duplicate_candidates`.
 * It writes nothing else.
 *
 * Records are marked in batches by id. Each batch first reads its last
 * id, `SELECT max(id) FROM (the next `--batch` live ids after the
 * cursor)`; the rebuild ends when that is null. Otherwise it runs one
 * `INSERT OR IGNORE` for the ids after the cursor up to and including
 * that last id, and the last id becomes the cursor. The cursor starts
 * empty. A batch whose records are all marked already inserts nothing,
 * and the rebuild goes on, because the read, not the insert, decides
 * when it ends. A record already marked keeps its row and its `seq`.
 *
 * The command waits 2 s before the write of each batch after the first, so the job and
 * the sign-in page are not starved of D1. Each statement is one `wrangler d1 execute`
 * through `runD1`; the reads are retried on an overload and the writes
 * are not. A statement carries the cursor as a quoted literal, because
 * wrangler takes no parameters. Against production the command needs
 * `--confirm-production`, checked before anything is sent. It prints the
 * number of batches and of records marked, and the exec, the wait, the
 * clock and the log are injectable so tests run without wrangler.
 *
 * @version v0.9.0
 */

import { runD1Json, type D1Exec } from "../d1-cli";
import { d1Args } from "../tenant-storage";

export type Target = "staging" | "production";

export interface DuplicatesArgs {
  target: Target;
  confirmProduction: boolean;
  batch: number;
}

/** Ids per batch: the batch is the read's LIMIT, so no more than a production read may ask for. */
export const DEFAULT_BATCH = 1000;
export const BATCH_WAIT_MS = 2000;

/** `duplicates rebuild --target staging|production [--confirm-production] [--batch n]`. */
export function parseDuplicatesArgs(argv: string[]): DuplicatesArgs {
  const [noun, verb, ...rest] = argv;
  if (noun !== "duplicates") throw new Error("Usage: fisqua duplicates rebuild --target staging|production [--confirm-production] [--batch n]");
  if (verb !== "rebuild") throw new Error("duplicates takes rebuild");
  let target: string | null = null;
  let confirmProduction = false;
  let batch = DEFAULT_BATCH;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const value = () => {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--confirm-production") confirmProduction = true;
    else if (a === "--target") target = value();
    else if (a === "--batch") {
      const text = value();
      batch = /^\d+$/.test(text) ? Number(text) : 0;
      if (!Number.isSafeInteger(batch) || batch < 1) throw new Error("--batch is a whole number of at least 1");
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (target !== "staging" && target !== "production") throw new Error("--target is staging or production");
  return { target, confirmProduction, batch };
}

export interface DuplicatesDeps {
  exec?: D1Exec;
  /** Waits this many milliseconds between batches. */
  wait?: (ms: number) => void | Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface RebuildResult {
  batches: number;
  marked: number;
}

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Marks every live entity record, batch by batch; see the module header. */
export async function runDuplicatesRebuild(options: DuplicatesArgs & DuplicatesDeps): Promise<RebuildResult> {
  const { target, confirmProduction, batch } = options;
  if (target === "production" && !confirmProduction) throw new Error("Rebuilding on production also needs --confirm-production");
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((line: string) => console.log(line));
  const d1 = (sql: string) => [...d1Args(target), "--json", "--command", sql];
  let cursor = "";
  let batches = 0;
  let marked = 0;
  for (;;) {
    const sets = runD1Json<{ last: string | null }>(
      d1(`SELECT max(id) AS last FROM (SELECT id FROM entities WHERE merged_into IS NULL AND id > ${quote(cursor)} ORDER BY id LIMIT ${batch})`),
      { exec: options.exec },
    );
    const last = sets[0]?.results?.[0]?.last ?? null;
    if (last === null) break;
    if (batches > 0) await wait(BATCH_WAIT_MS);
    const out = runD1Json<unknown>(
      d1(
        `INSERT OR IGNORE INTO duplicate_recheck (entity_id, description_id, marked_at) SELECT id, '', ${Math.trunc(now())} ` +
          `FROM entities WHERE merged_into IS NULL AND id > ${quote(cursor)} AND id <= ${quote(last)}`,
      ),
      { exec: options.exec },
    );
    const changes = Number(out[0]?.meta?.changes ?? 0);
    batches += 1;
    marked += changes;
    log(`Batch ${batches}: ${changes} marked up to ${last}`);
    cursor = last;
  }
  log(`Done: ${batches} batches, ${marked} records marked.`);
  return { batches, marked };
}

// @version v0.9.0
