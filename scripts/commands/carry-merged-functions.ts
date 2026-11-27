#!/usr/bin/env npx tsx
/**
 * Entities — Carry the Functions of Earlier Merges to Their Survivors
 *
 * This script carries the function rows of earlier merges to their
 * survivors. An entity merge moves the merged-away entity's function rows
 * to the survivor; records merged away before merges did so still hold
 * theirs, and the survivor's page and entities.json leave them out. The
 * script moves those rows, once, as a merge moves them: each row keeps its
 * id and columns and names the final survivor (`merged_into` followed to
 * its end), each survivor's `updated_at` moves past the value it held, and
 * each record merged away gets a ledger row naming the rows moved.
 * `scripts/lib/merged-functions-carry.ts` describes the reads, the
 * refusals, the rows written and the guards.
 *
 * A dry run is the default: it reads and prints, per survivor, the rows
 * to move with their function text and the survivor's functions before
 * and after as the export groups them, and writes only the report,
 * `.import/carry-merged-functions_<target>_<timestamp>.{json,md}`. With
 * `--apply` it writes one SQL file next to the report, applies it with
 * `wrangler d1 execute --file`, and re-reads every survivor and every
 * record merged away. `--apply` against production also needs
 * `--confirm-production`. A second run finds nothing to carry and writes
 * nothing. `.import/` is never committed.
 *
 * `--tenant <slug>` names the scope: the federation's shared records and
 * the tenant's own.
 *
 * Credentials: wrangler's own login, for D1.
 *
 * Usage:
 *   npx tsx scripts/commands/carry-merged-functions.ts --target production --tenant neogranadina
 *   npx tsx scripts/commands/carry-merged-functions.ts --target staging --tenant neogranadina --apply
 *   npx tsx scripts/commands/carry-merged-functions.ts --target production --tenant neogranadina --apply --confirm-production
 *
 * @version v0.9.0
 */

import { execFileSync } from "node:child_process";
import { runD1 } from "../lib/d1-cli";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { d1Args, type CommandRunner } from "../lib/tenant-storage";
import { wranglerRows } from "../lib/capture-registration";
import {
  carryMergedFunctions,
  type CarryProviders,
  type Target,
} from "../lib/merged-functions-carry";

export interface CarryCliOptions {
  target: Target;
  tenant: string;
  apply: boolean;
  confirmProduction: boolean;
}

export function parseArgs(argv: string[]): CarryCliOptions {
  let target: string | null = null;
  let tenant = "";
  let apply = false;
  let confirmProduction = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--apply") apply = true;
    else if (a === "--confirm-production") confirmProduction = true;
    else if (a === "--target") target = value();
    else if (a === "--tenant") tenant = value();
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (target !== "staging" && target !== "production") throw new Error("--target is staging or production");
  if (!tenant) throw new Error("--tenant is required");
  if (apply && target === "production" && !confirmProduction) {
    throw new Error("--apply against production also needs --confirm-production");
  }
  return { target, tenant, apply, confirmProduction };
}

const runWrangler: CommandRunner = (command, args, opts) =>
  execFileSync(command, args, {
    encoding: "utf8",
    input: opts.input,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });

function providersFor(options: CarryCliOptions): CarryProviders {
  return {
    rows: wranglerRows(options.target, runWrangler),
    writeFile: (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, "utf8");
    },
    // The file is applied with wrangler's own output and prompts on the terminal.
    applyFile: (file) => {
      runD1([...d1Args(options.target), `--file=${file}`], { stdio: "inherit" });
    },
    now: () => Date.now(),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await carryMergedFunctions(options, providersFor(options), (line) => console.log(line));
  if (!options.apply) console.log("\nDry run: nothing was written to D1. Run with --apply to write.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

// @version v0.9.0
