#!/usr/bin/env npx tsx
/**
 * Vocabulary — Seed a Federation's Vocabulary
 *
 * This script writes one federation's vocabulary into `vocabulary_values`.
 * Each federation names its own document roles, place roles and the groups
 * they fall into, its relation roles, the attributes a link between a
 * person and a description may carry, and the genders a person may be
 * recorded with; Fisqua names none of them. The values come from a data
 * file under `scripts/data/vocabularies/`, chosen with `--set`:
 * `neogranadina-relations` (relations, attributes, genders),
 * `neogranadina-roles` (Neogranadina's 7 role groups, 33 document roles
 * and 7 place roles) or `starter-roles` (the minimal set a new federation
 * starts from). `scripts/lib/vocabulary-seed.ts` describes the checks, the
 * reads, what each row holds, the guards and the read-back.
 *
 * A plan is the default: it checks the data file, reads the federation's
 * rows of the set's lists (and, for a role set, the codes its links hold),
 * and writes the report (inserts, unchanged rows and conflicts) and the
 * SQL file, `.import/vocabulary_<federation>_<target>_<stamp>-<suffix>.json`,
 * `.md` and `.sql`. It writes nothing to D1. A held row with the same list
 * and code but other values is a conflict: the run is refused and nothing
 * is overwritten. A role set also refuses a run where a link of the
 * federation holds a code in none of its role and relation lists. Role
 * groups a relation set names as existing are never touched. With
 * `--apply` it plans again, applies the SQL file with
 * `wrangler d1 execute --file` as one unit, reads back and plans once
 * more, and exits 1 unless nothing is left to write. A second run writes
 * nothing. `--apply` against production also needs `--confirm-production`,
 * checked before anything is read.
 *
 * Credentials: wrangler's own login, for D1.
 *
 * Usage:
 *   npx tsx scripts/commands/seed-federation-vocabulary.ts --target staging --federation neogranadina --set neogranadina-relations
 *   npx tsx scripts/commands/seed-federation-vocabulary.ts --target staging --federation neogranadina --set neogranadina-roles
 *   npx tsx scripts/commands/seed-federation-vocabulary.ts --target staging --federation neogranadina --set neogranadina-relations --apply
 *   npx tsx scripts/commands/seed-federation-vocabulary.ts --target production --federation neogranadina --set neogranadina-relations \
 *     --apply --confirm-production
 *
 * @version v0.9.0
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { wranglerRows } from "../lib/capture-registration";
import { runD1 } from "../lib/d1-cli";
import { d1Args, type CommandRunner } from "../lib/tenant-storage";
import type { RunProviders } from "../lib/cli/run-file";
import { exitCodeOf, parseSeedArgs, runVocabularySeed, type SeedOptions } from "../lib/vocabulary-seed";

const runWrangler: CommandRunner = (command, args, opts) =>
  execFileSync(command, args, {
    encoding: "utf8",
    input: opts.input,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });

function providersFor(options: SeedOptions): RunProviders {
  return {
    rows: wranglerRows(options.target, runWrangler),
    writeFile: (out, text) => {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, text, "utf8");
    },
    // The SQL file is created, never replaced: a file of that name stops the run.
    createFile: (out, text) => {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, text, { encoding: "utf8", flag: "wx" });
    },
    readFile: (file) => fs.readFileSync(file, "utf8"),
    newId: () => randomUUID(),
    // The file is applied with wrangler's own output and prompts on the terminal.
    applyFile: (sqlFile) => {
      runD1([...d1Args(options.target), `--file=${sqlFile}`, "--yes"], { stdio: "inherit" });
    },
    now: () => Date.now(),
  };
}

async function main(): Promise<void> {
  const options = parseSeedArgs(process.argv.slice(2));
  const report = await runVocabularySeed(options, providersFor(options), (line) => console.log(line));
  if (!options.apply && report.outcome === "dry run") console.log("\nPlan only: nothing was written to D1. Run with --apply to write.");
  process.exitCode = exitCodeOf(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

// @version v0.9.0
