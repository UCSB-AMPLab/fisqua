#!/usr/bin/env npx tsx
/**
 * Capture QC — Record Rejections in Bulk from a List
 *
 * Capture QC sends openings back to a Captua unit for retake one at a
 * time, from the viewer or the Capture QC screen. Sometimes the openings
 * to retake are already known from elsewhere, as when an archive's
 * digitisation list names the folios of volumes rebuilt from earlier
 * captures that must be shot again. This command takes such a list and
 * records a capture QC rejection for each opening it names, so that
 * each opening is recorded exactly as if a reviewer had rejected it on
 * the screen: the unit fetches the decisions over the link like any
 * other, and the volume is held from processing until the retakes are
 * approved. It runs on the operator's machine.
 *
 * The list is a TSV file with a header row (or a `.json` array of
 * objects with the same keys), one opening per row:
 *
 *   stem              the volume's stem, its reference code
 *   pairId            the opening's pair id as the capture manifest gives it
 *   sequence          optional: the record's sequence, checked against Fisqua's
 *   side              left, right or both for an opening with two images;
 *                     single or empty for one with one image
 *   reason            a contract reason code (blur, glare, ..., other)
 *   note              free text, up to 2,000 characters; required for other
 *   captua_record_id  optional: the unit's record id, checked against Fisqua's
 *
 * The opening is found by stem and pair id in the volume's current
 * delivery. Each row is reported `[decide]`, `[same]` (an identical
 * rejection is already recorded; nothing is written, so the list can be
 * run again), `[conflict]` (a different decision is already recorded, or
 * Fisqua's record disagrees with the row; never overwritten), `[missing]`
 * (no such volume, delivery or opening) or `[locked]` (a pipeline run has
 * claimed or named the volume). A list whose shape is wrong is refused
 * whole. The rules and the rows written are those of the Capture QC
 * screen; `scripts/lib/qc-decisions.ts` describes both.
 *
 * A dry run is the default: it reads and prints, and writes only the
 * report, `.import/qc-decisions_<list id>.json`, the list id being the
 * start of the SHA-256 of the list's text. With `--apply`, any conflict,
 * missing or locked row stops the command before anything is written;
 * otherwise it writes the decisions to one SQL file,
 * `.import/qc-decisions_<list id>.sql`, applies it with
 * `wrangler d1 execute --file`, and re-reads each decision set.
 * `--apply` against production also needs `--confirm-production`.
 * `.import/` is never committed.
 *
 * `--decided-by` names the user the decisions are recorded for, by
 * email: a user of the tenant with digitization admin rights (or
 * workspace or super admin), or a steward of the tenant's federation.
 * The unit is told their display name. `--source-record` picks the
 * database read and written, `production` (the default) or `staging`.
 *
 * Credentials: wrangler's own login, for D1.
 *
 * Usage:
 *   npx tsx scripts/commands/record-qc-decisions.ts --list <file.tsv> --tenant <slug> --decided-by <email>
 *   npx tsx scripts/commands/record-qc-decisions.ts --list <file.tsv> --tenant <slug> --decided-by <email> --source-record staging --apply
 *   npx tsx scripts/commands/record-qc-decisions.ts --list <file.tsv> --tenant <slug> --decided-by <email> --apply --confirm-production
 *
 * @version v0.8.0
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { d1Args, type CommandRunner } from "../lib/tenant-storage";
import { wranglerRows } from "../lib/capture-registration";
import {
  listIdOf,
  parseQcList,
  QcDecisionStop,
  recordQcDecisions,
  type QcDecisionProviders,
  type QcDecisionReport,
  type SourceRecord,
} from "../lib/qc-decisions";

export interface QcDecisionCliOptions {
  list: string;
  tenant: string;
  decidedBy: string;
  sourceRecord: SourceRecord;
  apply: boolean;
  confirmProduction: boolean;
}

export function parseArgs(argv: string[]): QcDecisionCliOptions {
  let list = "";
  let tenant = "";
  let decidedBy = "";
  let sourceRecord: SourceRecord = "production";
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
    else if (a === "--list") list = value();
    else if (a === "--tenant") tenant = value();
    else if (a === "--decided-by") decidedBy = value();
    else if (a === "--source-record") {
      const v = value();
      if (v !== "production" && v !== "staging") throw new Error("--source-record is production or staging");
      sourceRecord = v;
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (!list) throw new Error("--list is required");
  if (!tenant) throw new Error("--tenant is required");
  if (!decidedBy) throw new Error("--decided-by is required");
  if (apply && sourceRecord === "production" && !confirmProduction) {
    throw new Error("--apply against production also needs --confirm-production");
  }
  return { list, tenant, decidedBy, sourceRecord, apply, confirmProduction };
}

/** The list file's text and the format its extension names. */
function readList(file: string): { text: string; format: "tsv" | "json" } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new QcDecisionStop(`The list ${file} is not readable: ${(err as Error).message}`);
  }
  return { text, format: file.toLowerCase().endsWith(".json") ? "json" : "tsv" };
}

/** Runs wrangler with room for a large answer: a delivery's records can pass the default 1 MB. */
const runWrangler: CommandRunner = (command, args, opts) =>
  execFileSync(command, args, {
    encoding: "utf8",
    input: opts.input,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });

function providersFor(options: QcDecisionCliOptions): QcDecisionProviders {
  return {
    rows: wranglerRows(options.sourceRecord, runWrangler),
    writeFile: (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, "utf8");
    },
    // The file is applied with wrangler's own output and prompts on the terminal.
    applyFile: (file) => {
      execFileSync("npx", [...d1Args(options.sourceRecord), `--file=${file}`], { stdio: "inherit" });
    },
    now: () => Date.now(),
    newId: () => randomUUID(),
  };
}

/** Runs the command with the options and providers given. */
export async function runQcDecisionCommand(
  options: QcDecisionCliOptions,
  providers: QcDecisionProviders,
  log: (line: string) => void,
): Promise<QcDecisionReport> {
  const { text, format } = readList(options.list);
  const rows = parseQcList(text, format);
  const report = await recordQcDecisions(
    rows,
    {
      slug: options.tenant,
      decidedBy: options.decidedBy,
      sourceRecord: options.sourceRecord,
      apply: options.apply,
      listId: await listIdOf(text),
    },
    providers,
    log,
  );
  if (!options.apply) log("\nDry run: nothing was written to D1. Run with --apply to write.");
  return report;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await runQcDecisionCommand(options, providersFor(options), (line) => console.log(line));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

// @version v0.8.0
