#!/usr/bin/env npx tsx
/**
 * Re-source Truncated Transcripts
 *
 * This script restores the full OCR transcripts of fourteen descriptions
 * from a local JSON file of the full originals, shaped `{
 * "<reference_code>": "<full text>" }`. The original import clipped those
 * transcripts to fit D1's statement limit, and marked each one with an
 * `ocr-truncated` entry in `legacy_ids` that records how many bytes the
 * full text had.
 *
 * It reads the clipped page-1 rows, checks each supplied original
 * against the byte count in its marker, and prints three lists: the
 * rows it would restore, the rows with no original, and the rows whose
 * original has a different length. Without `--apply` it stops there and
 * writes nothing.
 *
 * With `--apply` it first confirms that `descriptions.ocr_text` is gone
 * from the target database, which happens when migration 0087 has been
 * applied. It then writes each restoration's statements to
 * `.import/ocr-restore-<timestamp>.sql`, runs that file with
 * `wrangler d1 execute --file`, and re-reads the byte length of every
 * restored page to print beside the marker's count. The SQL file holds
 * the restored text; it stays under `.import/`, which is never
 * committed, and should be deleted once the byte counts are recorded.
 * The `ocr-truncated` marker itself is left in place.
 *
 * Usage:
 *   npx tsx scripts/ocr-resource-truncated.ts --originals <file.json>
 *   npx tsx scripts/ocr-resource-truncated.ts --originals <file.json> --target staging --apply
 *
 * Flags: `--target local|staging|production` (default `local`),
 * `--originals <file>` (required), `--apply`. Staging and production
 * need `wrangler` authenticated against the Cloudflare account.
 *
 * @version v0.9.0
 */
import { runD1 } from "./lib/d1-cli";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  assertColumnRetired,
  planResourcing,
  restorationSql,
  type ClippedRow,
} from "./commands/ocr-resource-truncated";

type Target = "local" | "staging" | "production";

const OUTPUT_DIR = ".import";

const CLIPPED_QUERY =
  "SELECT d.id AS id, d.tenant_id AS tenantId, d.reference_code AS referenceCode, " +
  "d.legacy_ids AS legacyIds, p.text AS text " +
  "FROM descriptions d JOIN ocr_pages p ON p.description_id = d.id " +
  "AND p.tenant_id = d.tenant_id AND p.page_seq = 1 AND p.run_id IS NULL " +
  "WHERE d.legacy_ids LIKE '%\"ocr-truncated\"%';";

function parseArgs(): { target: Target; originalsPath: string; apply: boolean } {
  const argv = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const target = (value("--target") ?? "local") as Target;
  if (!["local", "staging", "production"].includes(target)) {
    throw new Error(`--target must be local, staging or production (got ${JSON.stringify(target)})`);
  }
  const originalsPath = value("--originals");
  if (!originalsPath) throw new Error("--originals <file.json> is required");
  return { target, originalsPath, apply: argv.includes("--apply") };
}

/** The database name and flags for a target, mapped the way `clear.ts` maps them. */
function targetArgs(target: Target): string[] {
  if (target === "staging") return ["fisqua-staging-db", "--env=staging", "--remote"];
  if (target === "production") return ["fisqua-db", "--remote"];
  return ["fisqua-db", "--local"];
}

/** Wrangler arguments for a SQL file, mapped the way `clear.ts` maps targets. */
function wranglerFileArgs(target: Target, sqlFilePath: string): string[] {
  return ["wrangler", "d1", "execute", ...targetArgs(target), `--file=${sqlFilePath}`, "--json"];
}

/**
 * Run one read query and return its rows. Reads go through `--command`:
 * against a remote database `--file` is an import, which reports what it
 * executed but returns no rows. The arguments are passed as an array, so
 * the query needs no shell quoting. Wrangler prefixes remote `--json`
 * output with status lines, so everything before the first JSON token is
 * dropped.
 */
function runSql<T>(target: Target, sql: string, label: string): T[] {
  const out = runD1(["wrangler", "d1", "execute", ...targetArgs(target), "--command", sql, "--json"], {
    maxBuffer: 200 * 1024 * 1024,
  });
  const start = out.search(/[[{]/);
  if (start < 0) throw new Error(`wrangler produced no JSON output for ${label}: ${out}`);
  const parsed = JSON.parse(out.slice(start)) as { results?: T[] }[];
  return parsed[0]?.results ?? [];
}

function main(): void {
  const { target, originalsPath, apply } = parseArgs();
  const originals = JSON.parse(fs.readFileSync(originalsPath, "utf8")) as Record<string, string>;

  const rows = runSql<ClippedRow>(target, CLIPPED_QUERY, "ocr-clipped");
  const plan = planResourcing(rows, originals);

  console.log(`Target: ${target}. Clipped rows found: ${rows.length}.`);
  console.log(`Would restore (${plan.update.length}):`);
  for (const u of plan.update) {
    const code = rows.find((r) => r.id === u.descriptionId)?.referenceCode;
    console.log(`  ${code}`);
  }
  console.log(`Missing original (${plan.missing.length}): ${plan.missing.join(", ") || "none"}`);
  console.log(`Length mismatch (${plan.mismatched.length}): ${plan.mismatched.join(", ") || "none"}`);

  if (!apply) {
    console.log("Dry run: nothing written. Pass --apply to restore.");
    return;
  }
  if (plan.update.length === 0) {
    console.log("Nothing to restore.");
    return;
  }

  const columns = runSql<{ name: string }>(target, "PRAGMA table_info(descriptions);", "ocr-columns").map(
    (c) => c.name,
  );
  assertColumnRetired(columns);

  const now = Date.now();
  const statements = plan.update.flatMap((u) => restorationSql(u, randomUUID(), now));
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const restorePath = path.join(OUTPUT_DIR, `ocr-restore-${now}.sql`);
  fs.writeFileSync(restorePath, statements.join("\n") + "\n", "utf8");
  console.log(`Wrote ${statements.length} statements to ${restorePath}`);

  runD1(wranglerFileArgs(target, restorePath), {
    maxBuffer: 200 * 1024 * 1024,
    stdio: "inherit",
  });

  const ids = plan.update.map((u) => `'${u.descriptionId.replace(/'/g, "''")}'`).join(", ");
  const check = runSql<{ id: string; referenceCode: string; bytes: number; legacyIds: string }>(
    target,
    "SELECT d.id AS id, d.reference_code AS referenceCode, d.legacy_ids AS legacyIds, " +
      "length(CAST(p.text AS BLOB)) AS bytes FROM descriptions d JOIN ocr_pages p " +
      "ON p.description_id = d.id AND p.tenant_id = d.tenant_id AND p.page_seq = 1 AND p.run_id IS NULL " +
      `WHERE d.id IN (${ids});`,
    "ocr-verify",
  );
  console.log("Restored byte counts (stored / marker):");
  for (const r of check) {
    const mark = (JSON.parse(r.legacyIds) as { provider: string; id: unknown }[]).find(
      (e) => e.provider === "ocr-truncated",
    );
    console.log(`  ${r.referenceCode}: ${r.bytes} / ${mark?.id}`);
  }
  console.log(`Delete ${restorePath} once the counts are recorded.`);
}

main();

// Version: v0.9.0
