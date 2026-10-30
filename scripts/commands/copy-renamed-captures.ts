#!/usr/bin/env npx tsx
/**
 * Rename Copy — Copy Pre-Contract Captures into the Masters Bucket Under Contract Names
 *
 * Images a Captua appliance shot before it named files by the exchange
 * contract (every Rionegro volume) take their contract names when they
 * are copied into the federation's masters bucket, not on the card.
 * Captua writes one rename map per volume: each image's
 * old key in a source bucket, the contract key it takes under
 * `{slug}/<stem>/`, and its size and checksums. This command reads one
 * map and copies each image within B2, server side, so nothing passes
 * through the operator's machine. It runs on the operator's machine.
 *
 * It refuses the whole map when the envelope or the shape is wrong, the
 * destination is not the tenant's prefix in its federation's masters
 * bucket, the volume's stem is not its reference code, an ordinal is
 * above the volume's capture counter, a destination key is not the
 * contract's name, a key or an (ordinal, camera, kind) appears twice, or
 * a file is over the 5 GB one copy call can carry. The tenant and its
 * federation's record are read through wrangler, read only, from the
 * database `--source-record` names (`production` by default, or
 * `staging`, which holds the same record before production is
 * migrated); the command never writes D1. B2 is one account for both
 * environments, so the copy itself does not depend on it.
 *
 * Each entry is reported `[copy]`, `[exists]` (already copied, skipped),
 * `[conflict]` (something else at the destination; never overwritten) or
 * `[missing]` (the source is absent or not as the map says). A dry run
 * is the default and copies nothing. With `--apply`, any conflict or
 * missing entry stops the command before it copies anything; otherwise
 * it copies the `[copy]` entries, four at a time, and checks each copy's
 * size and SHA1 against the source. A run that stopped part way is
 * finished by running it again. Nothing is ever deleted.
 *
 * Every run writes `.import/rename-copy_<map id>.json` with every entry
 * and its outcome, and prints counts and bytes. `.import/` is never
 * committed.
 *
 * Credentials, read from the operator's environment:
 *   B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY   a B2 key with read and write on both buckets
 *   wrangler's own login                         D1, production, read only
 * The key's values are never printed.
 *
 * Usage:
 *   npx tsx scripts/commands/copy-renamed-captures.ts --map <file.json> --tenant <slug>
 *   npx tsx scripts/commands/copy-renamed-captures.ts --map <file.json> --tenant <slug> --apply
 *   npx tsx scripts/commands/copy-renamed-captures.ts --map <file.json> --tenant <slug> --source-record staging
 *
 * @version v0.8.0
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { b2FromEnv, execCommand, wranglerD1 } from "../lib/tenant-storage";
import { RegistrationStop } from "../lib/capture-registration";
import {
  copyRenamedCaptures,
  parseRenameMap,
  type RenameCopyProviders,
  type RenameCopyReport,
} from "../lib/rename-copy";

export interface RenameCopyCliOptions {
  map: string;
  tenant: string;
  apply: boolean;
  sourceRecord: "production" | "staging";
}

export function parseArgs(argv: string[]): RenameCopyCliOptions {
  let map = "";
  let tenant = "";
  let apply = false;
  let sourceRecord: "production" | "staging" = "production";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--apply") apply = true;
    else if (a === "--map") map = value();
    else if (a === "--tenant") tenant = value();
    else if (a === "--source-record") {
      const v = value();
      if (v !== "production" && v !== "staging") throw new Error("--source-record is production or staging");
      sourceRecord = v;
    }
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!map) throw new Error("--map is required");
  if (!tenant) throw new Error("--tenant is required");
  return { map, tenant, apply, sourceRecord };
}

/** Reads and parses the map file; a file that is not JSON is refused whole. */
export function readMap(file: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new RegistrationStop(`The rename map ${file} is not readable JSON: ${(err as Error).message}`);
  }
  return parseRenameMap(raw);
}

function providersFor(env: NodeJS.ProcessEnv, sourceRecord: "production" | "staging"): RenameCopyProviders {
  const fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  return {
    // The tenant and its federation's record; read only.
    d1: wranglerD1(sourceRecord, execCommand),
    b2: b2FromEnv(env, fetchImpl),
    writeFile: (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, "utf8");
    },
  };
}

/** Runs the command with the options and providers given. */
export async function runRenameCopyCommand(
  options: RenameCopyCliOptions,
  providers: RenameCopyProviders,
  log: (line: string) => void,
): Promise<RenameCopyReport> {
  const map = readMap(options.map);
  const report = await copyRenamedCaptures(map, { slug: options.tenant, apply: options.apply }, providers, log);
  if (!options.apply) log("\nDry run: nothing was copied. Run with --apply to copy.");
  return report;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await runRenameCopyCommand(options, providersFor(process.env, options.sourceRecord), (line) => console.log(line));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

// @version v0.8.0
