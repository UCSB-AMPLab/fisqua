#!/usr/bin/env npx tsx
/**
 * Carry Gate Passes — Copy v1.0.0 Gate Passes to Runner v1.1.0
 *
 * This command copies gate passes won on runner v1.0.0 to v1.1.0. A wave
 * needs a gate pass for its recipe declaration on the script version the
 * deployment pins. Migration 0105 copied every pass won on v1.0.0 to
 * v1.1.0 when it ran; this command runs the same statement
 * (`scripts/lib/gate-pass-carry.ts`) again, so a pass won on v1.0.0 after
 * that is carried too. Run it on each environment when its runner pin
 * moves to v1.1.0, and whenever a v1.0.0 pass is recorded while another
 * environment already pins v1.1.0. It runs on the operator's machine.
 *
 * A dry run is the default: it counts the v1.0.0 passes with no v1.1.0
 * pass and writes nothing. `--apply` copies them; `--apply` against
 * production also needs `--confirm-production`. The copy keeps each
 * pass's `passed_by` and `passed_at`, notes why it exists, and names the
 * original in `carried_from`. Running it again copies nothing.
 *
 * Credentials: wrangler's own login, for D1.
 *
 * Usage:
 *   npx tsx scripts/commands/carry-gate-passes.ts --target staging
 *   npx tsx scripts/commands/carry-gate-passes.ts --target staging --apply
 *   npx tsx scripts/commands/carry-gate-passes.ts --target production --apply --confirm-production
 *
 * @version v0.8.0
 */

import { pathToFileURL } from "node:url";
import { d1Args, execCommand } from "../lib/tenant-storage";
import { CARRY_GATE_PASSES_SQL, CARRY_TO_VERSION, PENDING_CARRY_SQL } from "../lib/gate-pass-carry";

export interface CarryGatePassesOptions {
  target: "staging" | "production";
  apply: boolean;
}

export function parseArgs(argv: string[]): CarryGatePassesOptions {
  let target: string | null = null;
  let apply = false;
  let confirmProduction = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--confirm-production") confirmProduction = true;
    else if (a === "--target") {
      target = argv[++i] ?? null;
      if (target === null || target.startsWith("--")) throw new Error("--target needs a value");
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (target !== "staging" && target !== "production") throw new Error("--target is required (staging or production)");
  if (apply && target === "production" && !confirmProduction) {
    throw new Error("--apply against production also needs --confirm-production");
  }
  return { target, apply };
}

/** Runs one statement on the target's D1 and gives its rows. */
export type D1Query = (sql: string) => Array<Record<string, unknown>>;

export async function runCarryGatePasses(
  options: CarryGatePassesOptions,
  query: D1Query,
  log: (line: string) => void,
): Promise<{ pending: number; carried: number }> {
  const count = () => Number(query(PENDING_CARRY_SQL)[0]?.n ?? 0);
  const pending = count();
  log(`${pending} gate pass${pending === 1 ? "" : "es"} on v1.0.0 with no ${CARRY_TO_VERSION} pass (${options.target}).`);
  if (!options.apply) {
    log("Dry run: nothing was written. Run with --apply to copy them.");
    return { pending, carried: 0 };
  }
  if (pending > 0) query(CARRY_GATE_PASSES_SQL);
  const left = count();
  log(`Copied ${pending - left}; ${left} left without a ${CARRY_TO_VERSION} pass.`);
  return { pending, carried: pending - left };
}

function wranglerQuery(target: CarryGatePassesOptions["target"]): D1Query {
  return (sql) => {
    const out = execCommand("npx", [...d1Args(target), "--json", "--command", sql], {});
    const parsed = JSON.parse(out) as Array<{ results: Array<Record<string, unknown>> }>;
    return parsed[0]?.results ?? [];
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await runCarryGatePasses(options, wranglerQuery(options.target), (line) => console.log(line));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

// @version v0.8.0
