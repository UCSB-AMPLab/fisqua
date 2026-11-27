#!/usr/bin/env npx tsx
/**
 * OCR Budget
 *
 * This script reports how much of a D1 database the OCR transcripts
 * take: page rows, text bytes, the full-text index's own storage, the
 * index's copy of the text when it keeps one, rows abandoned in
 * staging, and the same per workspace. It prints the report as JSON,
 * followed by the ratio of index storage (index plus its text copy) to
 * text, which is the number a projection of future growth needs.
 *
 * The statements are the ones `app/lib/ocr/budget.server.ts` holds, run
 * through `wrangler d1 execute --command --json` by `runD1Json` in
 * `scripts/lib/d1-cli.ts`, so the script and the Worker share one set
 * of SQL. For a remote target the script also prints the database's
 * total size from `wrangler d1 info`.
 *
 * READ-ONLY. The script runs SELECTs only, passed to wrangler as an
 * argument rather than through a file: against a remote database
 * `--file` returns no rows.
 *
 * The reader used to be `wranglerRows` in `scripts/commands/clear.ts`,
 * the Django round's tenant clear. The Django round is retired and
 * `clear.ts` was removed with it, so the script names its own target
 * database and reads through `runD1Json`, which also runs a read again
 * when D1 reports it is overloaded.
 *
 * Usage:
 *   npx tsx scripts/ocr-budget.ts --target local
 *   npx tsx scripts/ocr-budget.ts --target staging
 *   npx tsx scripts/ocr-budget.ts --target production
 *
 * Pre-flight for a remote target: `wrangler` must be authenticated
 * against the account that owns `fisqua-db` (production) or
 * `fisqua-staging-db` (staging).
 *
 * @version v0.9.0
 */

import { execSync } from "node:child_process";
import { collectOcrBudget } from "../app/lib/ocr/budget.server";
import { runD1Json } from "./lib/d1-cli";

type Target = "local" | "staging" | "production";

const TARGETS: readonly Target[] = ["local", "staging", "production"];

/** The database name and flags `wrangler d1 execute` needs for the target. */
function targetArgs(target: Target): string[] {
  if (target === "staging") return ["fisqua-staging-db", "--env=staging", "--remote"];
  if (target === "production") return ["fisqua-db", "--remote"];
  return ["fisqua-db", "--local"];
}

/** Runs one SELECT against the target and returns the rows of its first result set. */
function readRows(target: Target): (sql: string) => Promise<Record<string, unknown>[]> {
  return async (sql) => {
    const sets = runD1Json<Record<string, unknown>>(
      ["wrangler", "d1", "execute", ...targetArgs(target), "--command", sql, "--json"],
      { maxBuffer: 50 * 1024 * 1024 },
    );
    return sets[0]?.results ?? [];
  };
}

function parseTarget(argv: string[]): Target {
  const i = argv.indexOf("--target");
  const value = i >= 0 ? argv[i + 1] : undefined;
  if (!value || !(TARGETS as readonly string[]).includes(value)) {
    throw new Error(`--target must be one of ${TARGETS.join(", ")}`);
  }
  return value as Target;
}

async function main(): Promise<void> {
  const target = parseTarget(process.argv.slice(2));
  const budget = await collectOcrBudget(readRows(target));
  console.log(JSON.stringify(budget, null, 2));

  const indexBytes = budget.ftsIndexBytes + budget.ftsContentBytes;
  const ratio = budget.textBytes > 0 ? indexBytes / budget.textBytes : null;
  console.log(
    `index + content / text: ${ratio === null ? "n/a (no text)" : ratio.toFixed(3)}`,
  );

  if (target !== "local") {
    const dbName = target === "staging" ? "fisqua-staging-db" : "fisqua-db";
    const envFlag = target === "staging" ? " --env=staging" : "";
    console.log(execSync(`npx wrangler d1 info ${dbName}${envFlag}`, { encoding: "utf-8" }));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
