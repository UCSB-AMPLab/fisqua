#!/usr/bin/env npx tsx
/**
 * Institution Records — Fill the Repository, Publisher and Vocabulary Records
 *
 * This script fills, once, the publisher record, the ISDIAH repository
 * fields, each federation's controlled lists and its authority sources,
 * which migration 0119 added empty. It takes their values from those the
 * Neogranadina instance hard-codes today (held in
 * `scripts/data/institution-records/`), from the reproduction sentence and
 * funder named in the repositories' own text, and from Fisqua's
 * enumerations and locale files. `scripts/lib/institution-records-fill.ts`
 * describes the reads, the values, the guards and the gaps.
 *
 * A dry run is the default: it reads with SELECTs only and writes the SQL
 * file, the report and the hero upload plan,
 * `<out>/fill-institution-records_<federation>_<target>_<timestamp>.{sql,json,md}`
 * and `…_heroes.{json,md}`, to `.import/` unless `--out` names another
 * directory. With `--apply` it applies the SQL file with
 * `wrangler d1 execute --file` and re-reads, and exits 1 when the re-read
 * still finds something to write; `--apply` against production
 * also needs `--confirm-production`. A second run finds nothing to write.
 *
 * Hero images are never uploaded by this command. The upload plan names
 * each file, its digest, and its key in the federation's manifests bucket;
 * after the upload, a run with `--with-heroes` checks each object at its
 * public address and writes `hero_image_url` for those that match.
 *
 * Credentials: wrangler's own login, for D1.
 *
 * Usage:
 *   npx tsx scripts/commands/fill-institution-records.ts --target production --federation neogranadina
 *   npx tsx scripts/commands/fill-institution-records.ts --target local --federation neogranadina --apply
 *   npx tsx scripts/commands/fill-institution-records.ts --target production --federation neogranadina --apply --confirm-production
 *   npx tsx scripts/commands/fill-institution-records.ts --target production --federation neogranadina --with-heroes --apply --confirm-production
 *
 * @version v0.9.0
 */

import { execFileSync } from "node:child_process";
import { runD1 } from "../lib/d1-cli";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { d1Args, type CommandRunner } from "../lib/tenant-storage";
import { wranglerRows } from "../lib/capture-registration";
import {
  fillInstitutionRecords,
  selectOnly,
  type FillOptions,
  type FillProviders,
  type FillReport,
  type Target,
} from "../lib/institution-records-fill";

/** The exit code for a finished run: 1 when an apply's re-read did not match the plan. */
export function exitCode(report: FillReport): number {
  return report.applied && report.verified === false ? 1 : 0;
}

export function parseArgs(argv: string[]): FillOptions & { confirmProduction: boolean } {
  let target: string | null = null;
  let federation = "";
  let apply = false;
  let withHeroes = false;
  let confirmProduction = false;
  let outDir = ".import";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--apply") apply = true;
    else if (a === "--with-heroes") withHeroes = true;
    else if (a === "--confirm-production") confirmProduction = true;
    else if (a === "--target") target = value();
    else if (a === "--federation") federation = value();
    else if (a === "--out") outDir = value();
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (target !== "local" && target !== "staging" && target !== "production") {
    throw new Error("--target is local, staging or production");
  }
  if (!federation) throw new Error("--federation is required");
  if (apply && target === "production" && !confirmProduction) {
    throw new Error("--apply against production also needs --confirm-production");
  }
  return { target: target as Target, federation, apply, withHeroes, confirmProduction, outDir };
}

const runWrangler: CommandRunner = (command, args, opts) =>
  execFileSync(command, args, {
    encoding: "utf8",
    input: opts.input,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });

function providersFor(options: FillOptions): FillProviders {
  return {
    rows: selectOnly(wranglerRows(options.target, runWrangler)),
    writeFile: (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, "utf8");
    },
    // The file is applied with wrangler's own output and prompts on the terminal.
    applyFile: (file) => {
      runD1([...d1Args(options.target), `--file=${file}`], { stdio: "inherit" });
    },
    fetchObject: async (url) => {
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    now: () => Date.now(),
    newId: () => randomUUID(),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await fillInstitutionRecords(options, providersFor(options), (line) => console.log(line));
  if (!options.apply) console.log("\nDry run: nothing was written to D1. Run with --apply to write.");
  if (exitCode(report) !== 0) {
    console.error("The re-read after the apply does not match the plan; the report records it.");
    process.exitCode = exitCode(report);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

// @version v0.9.0
