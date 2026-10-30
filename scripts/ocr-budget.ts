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
 * through `wrangler d1 execute --command --json` by `wranglerRows` in
 * `scripts/commands/clear.ts`, so the CLI and the Worker share one set
 * of SQL. For a remote target the script also prints the database's
 * total size from `wrangler d1 info`.
 *
 * READ-ONLY. The script runs SELECTs only, passed to wrangler as an
 * argument rather than through a file, as the clear's count snapshot
 * does: against a remote database `--file` returns no rows.
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
 * @version v0.8.0
 */

import { execSync } from "node:child_process";
import { collectOcrBudget } from "../app/lib/ocr/budget.server";
import { wranglerRows, type ClearTarget } from "./commands/clear";

const TARGETS: readonly ClearTarget[] = ["local", "staging", "production"];

function parseTarget(argv: string[]): ClearTarget {
  const i = argv.indexOf("--target");
  const value = i >= 0 ? argv[i + 1] : undefined;
  if (!value || !(TARGETS as readonly string[]).includes(value)) {
    throw new Error(`--target must be one of ${TARGETS.join(", ")}`);
  }
  return value as ClearTarget;
}

async function main(): Promise<void> {
  const target = parseTarget(process.argv.slice(2));
  const read = wranglerRows(target);
  const budget = await collectOcrBudget(
    async (statement) => (await read(statement)) as Record<string, unknown>[],
  );
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
