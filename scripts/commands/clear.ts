/**
 * Tenant-Scoped Clear + Count Snapshot + FTS Rebuild
 *
 * This module deals with the tenant-scoped clear-and-reimport that touches
 * Neogranadina's domain rows and the derived junctions only. Every DELETE filters by tenant_id. Order:
 *   descriptions    -> cascade kills description_entities + description_places
 *                      (FK ON DELETE CASCADE on the description side)
 *   entity_functions -> JOIN-DELETE through entities WHERE tenant_id
 *                      (entity_functions has no tenant_id of its own; it
 *                       inherits via entity_id FK with ON DELETE CASCADE)
 *   entities, places, repositories -> tenant-scoped DELETE
 *
 * `snapshotCounts` pre-clear + `assertPostClearInvariants` post-clear
 * is the runtime check that catches a missing WHERE tenant_id = clause
 * before any data loss. Mirrors the test-time meta-grep posture of
 * tests/db/cross-tenant-coverage.test.ts.
 *
 * Three invariants are enforced as throws; no flag disables them:
 *   (a) every non-Neogranadina tenant's domain counts unchanged
 *   (b) Neogranadina domain counts all 0 post-clear
 *   (c) ancillary tables (audit_log/drafts/changelog/comments) unchanged
 *
 * `generateFtsRebuild` emits THREE rebuild statements
 * (entities_fts + places_fts + descriptions_fts). Migration 0024 added
 * descriptions_fts after an earlier clear was written; the rebuild
 * list catches up so search is not silently broken after a
 * clear-and-reimport.
 *
 * `snapshotCounts` and the guard's reads pass their SQL to `wrangler d1
 * execute --command` as one element of an argument array, so no shell
 * sees the newlines and quotes. They do not use `--file`: against a
 * remote database that runs as an import and returns no rows.
 *
 * Target enum drives the wrangler invocation:
 *   target=local      -> fisqua-db --local
 *   target=staging    -> fisqua-staging-db --env=staging --remote
 *   target=production -> fisqua-db --remote
 * database_name is always passed explicitly.
 *
 * The clear refuses while it would lose state the reimport cannot
 * restore. Deleting a tenant's descriptions cascades into their
 * `ocr_pages` rows. Pages a pipeline run wrote exist only for published
 * volumes, which cannot be regenerated. Pipeline volumes and recipe
 * declarations are production state that no import holds. So
 * `refuseUnsafeTenantClear` refuses, before any DELETE runs, while the
 * tenant has pipeline pages, page rows without a run id in any shape
 * other than the migrated page 1, pipeline volumes or recipe
 * declarations, and its message names each count. The page-1 rows
 * migration 0086 backfilled from the old `ocr_text` column (page 1, no
 * run id, no source or ALTO key) do not block the clear: the importer
 * writes the same rows again from the dump's `ocr_text`. The guard
 * returns their count for the operator.
 *
 * The clear SQL deletes those migrated rows itself, in four statements
 * split by rowid as 0086 inserted them, before it deletes the
 * descriptions. Each deleted row removes its entry from the full-text
 * index through the delete trigger, and a quarter of the rows per
 * statement keeps that work inside D1's per-statement budget. The
 * descriptions DELETE then cascades over an empty page set.
 *
 * The guard also refuses when the database has no `ocr_pages` table,
 * since it then cannot show which pages it would delete, and when a
 * count cannot be read. It does not look for the `descriptions.ocr_text`
 * column: neither importer writes to it, so a database without it can
 * take the reimport. It reads the database in two statements:
 * `clearGuardProbeSql` finds which of these tables exist, and
 * `clearGuardCountsSql` counts the tenant's rows in the tables that do;
 * a pipeline table that does not exist holds no rows. `wranglerRows` is
 * the production reader it is given.
 *
 * @version v0.8.0
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { NEOGRANADINA_TENANT_ID } from "../../app/lib/tenant";
import { escapeSql } from "../lib/sql";
import type { CountSnapshot, ClearAssertion } from "../lib/types";

const DEFAULT_OUTPUT_DIR = ".import";

/** The shape of a page-1 row migrated from the old column (module header). */
const MIGRATED_PAGE =
  "run_id IS NULL AND page_seq = 1 AND source_key IS NULL AND alto_key IS NULL";

/**
 * Generate the tenant-scoped clear SQL. Writes a single .sql file under
 * `opts.outputDir` (default `.import/`, the production CLI's unchanged
 * root; tests pass a per-suite temp dir) and returns its path in a
 * one-element array (so callers can iterate uniformly over a list of
 * generated SQL files).
 *
 * Defaults to NEOGRANADINA_TENANT_ID; the optional `tenantId` override is
 * used by tests/import/clear-isolation.test.ts so the keystone fixture can
 * pass the constant explicitly. Production callers (the import
 * orchestrator) pass nothing and inherit the Neogranadina default.
 *
 * Order matters:
 *   0. ocr_pages        -- the tenant's migrated page-1 rows, in four
 *                         rowid chunks (module header); the guard has
 *                         already refused any other page row
 *   1. descriptions    -- cascade kills description_entities +
 *                         description_places via ON DELETE CASCADE on
 *                         their description_id FK
 *   2. entity_functions -- JOIN-DELETE through entities WHERE tenant_id
 *                         (entity_functions itself has no tenant_id)
 *   3. entities         -- tenant-scoped
 *   4. places           -- tenant-scoped
 *   5. repositories     -- tenant-scoped
 *
 * Other tenants' rows are untouched. The four ancillary tables
 * (audit_log/drafts/changelog/comments) are NOT touched; they are not
 * tenant-scoped today and live outside the per-tenant import workflow.
 */
export async function generateTenantScopedClearSql(
  opts: { tenantId?: string; outputDir?: string } = {},
): Promise<string[]> {
  const tenantId = opts.tenantId ?? NEOGRANADINA_TENANT_ID;
  const outputDir = opts.outputDir ?? DEFAULT_OUTPUT_DIR;
  await fs.mkdir(outputDir, { recursive: true });

  const sql = `PRAGMA defer_foreign_keys = true;

-- Tenant-scoped clear. Order matters -- the migrated page-1 OCR rows
-- first, in four rowid chunks so each statement's index deletes stay
-- small; then descriptions (cascade kills description_entities +
-- description_places); entity_functions next via JOIN-DELETE (no
-- tenant_id column); then entities, places, repositories. Other
-- tenants' rows are untouched.
${[0, 1, 2, 3].map((r) => `DELETE FROM ocr_pages WHERE tenant_id = '${tenantId}' AND ${MIGRATED_PAGE} AND rowid % 4 = ${r};`).join("\n")}
DELETE FROM descriptions WHERE tenant_id = '${tenantId}';
DELETE FROM entity_functions WHERE entity_id IN (
  SELECT id FROM entities WHERE tenant_id = '${tenantId}'
);
DELETE FROM entities WHERE tenant_id = '${tenantId}';
DELETE FROM places WHERE tenant_id = '${tenantId}';
DELETE FROM repositories WHERE tenant_id = '${tenantId}';
`;

  const filePath = path.join(outputDir, "clear-001.sql");
  await fs.writeFile(filePath, sql, "utf8");
  return [filePath];
}

/**
 * Generate the FTS5 rebuild SQL. Three lines, one per FTS5 table:
 *   - entities_fts      (migration 0012)
 *   - places_fts        (migration 0012)
 *   - descriptions_fts  (migration 0024 -- the one previously missed)
 *
 * An earlier rebuild list only included the first two tables. After
 * migration 0024 added descriptions_fts the list went stale, leaving
 * search silently broken for the descriptions table after a
 * clear-and-reimport until the next row write touched the FTS
 * triggers. The current list catches up.
 *
 * Writes under `outputDir` (default `.import/`, the production CLI's
 * unchanged root; tests pass a per-suite temp dir).
 */
export async function generateFtsRebuild(
  outputDir: string = DEFAULT_OUTPUT_DIR,
): Promise<string[]> {
  await fs.mkdir(outputDir, { recursive: true });

  const sql = `INSERT INTO entities_fts(entities_fts) VALUES('rebuild');
INSERT INTO places_fts(places_fts) VALUES('rebuild');
INSERT INTO descriptions_fts(descriptions_fts) VALUES('rebuild');
`;

  const filePath = path.join(outputDir, "fts-rebuild-001.sql");
  await fs.writeFile(filePath, sql, "utf8");
  return [filePath];
}

// ---------------------------------------------------------------------------
// Cross-tenant invariant helpers: snapshotCounts + assertPostClearInvariants
// ---------------------------------------------------------------------------

export type ClearTarget = "local" | "staging" | "production";

/**
 * Build the wrangler arguments that name the target database for
 * `d1 execute`. database_name + --env + --remote are each
 * constructed from the target enum -- never partial. Staging needs
 * both --env=staging AND --remote (the staging deploy's D1 lives on
 * the staging worker env, not on the default env's --remote).
 */
function wranglerTargetArgs(target: ClearTarget): string[] {
  if (target === "staging") return ["fisqua-staging-db", "--env=staging", "--remote"];
  if (target === "production") return ["fisqua-db", "--remote"];
  return ["fisqua-db", "--local"];
}

/**
 * Run a single SQL string against the target D1 and return the rows
 * from the first statement.
 *
 * Reads go through `--command`, with the SQL passed as one element of
 * an argument array, so no shell sees it and multi-line UNION ALL SQL
 * needs no quoting. `--file` is not used for reads: against a remote
 * database it runs as an import and returns only what it executed
 * ("Total queries executed", "Rows read"), never the rows.
 */
async function wranglerJson(target: ClearTarget, sql: string, label: string): Promise<unknown[]> {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", ...wranglerTargetArgs(target), "--command", sql, "--json"],
    { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
  );
  // Remote `--json` output can be preceded by status lines; `--local`
  // output is not. Discard everything before the first JSON token so
  // both targets parse the same way.
  const jsonStart = out.search(/[[{]/);
  if (jsonStart < 0) {
    throw new Error(`wrangler --json produced no JSON output for ${label}: ${out}`);
  }
  const parsed = JSON.parse(out.slice(jsonStart)) as Array<{ results?: unknown[] }>;
  return parsed[0]?.results ?? [];
}

/**
 * The SQL that finds which of the tables the guard counts exist. One
 * row, each value 0 or 1.
 */
export function clearGuardProbeSql(): string {
  const table = (name: string) =>
    `(SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = '${name}') AS ${name}`;
  return `SELECT ${table("ocr_pages")}, ${table("pipeline_volumes")}, ${table("pipeline_recipe_declarations")};`;
}

/**
 * The SQL that counts the tenant's page rows and pipeline rows: pages a
 * pipeline run wrote (`run_id IS NOT NULL`), page-1 rows migrated from
 * the old column, other page rows without a run id, and, when the
 * pipeline tables exist, pipeline volumes and recipe declarations. One
 * row.
 */
export function clearGuardCountsSql(
  tenantId: string,
  opts: { pipelineTables: boolean },
): string {
  const t = escapeSql(tenantId);
  const counts = [
    `(SELECT count(*) FROM ocr_pages WHERE tenant_id = ${t} AND run_id IS NOT NULL) AS pipeline_pages`,
    `(SELECT count(*) FROM ocr_pages WHERE tenant_id = ${t} AND ${MIGRATED_PAGE}) AS migrated_pages`,
    `(SELECT count(*) FROM ocr_pages WHERE tenant_id = ${t} AND run_id IS NULL AND NOT (${MIGRATED_PAGE})) AS other_pages`,
    opts.pipelineTables
      ? `(SELECT count(*) FROM pipeline_volumes WHERE tenant_id = ${t}) AS pipeline_volumes`
      : `0 AS pipeline_volumes`,
    opts.pipelineTables
      ? `(SELECT count(*) FROM pipeline_recipe_declarations WHERE tenant_id = ${t}) AS recipe_declarations`
      : `0 AS recipe_declarations`,
  ];
  return `SELECT ${counts.join(",\n  ")};`;
}

/** Reads the named numeric fields of the first row, or null if any is missing. */
function readCounts<K extends string>(rows: unknown[], keys: K[]): Record<K, number> | null {
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const out = {} as Record<K, number>;
  for (const key of keys) {
    const n = Number(row[key]);
    if (row[key] === null || row[key] === undefined || !Number.isFinite(n)) return null;
    out[key] = n;
  }
  return out;
}

/**
 * Refuse the tenant-scoped clear while it would lose OCR pages or
 * pipeline state the reimport cannot restore. `countRows` runs one SQL
 * statement and returns its rows; anything it returns that is not a
 * readable count refuses as well. When the clear may go ahead, returns
 * the number of migrated page-1 rows it will delete and the reimport
 * writes again.
 */
export async function refuseUnsafeTenantClear(
  tenantId: string,
  countRows: (sql: string) => Promise<unknown[]>,
): Promise<{ migratedPages: number }> {
  const refused = (why: string) => new Error(`Tenant ${tenantId}: ${why} Clear refused.`);

  const probe = readCounts(await countRows(clearGuardProbeSql()), [
    "ocr_pages", "pipeline_volumes", "pipeline_recipe_declarations",
  ]);
  if (!probe) throw refused("could not read which OCR and pipeline tables the database has.");
  if (!probe.ocr_pages) {
    throw refused("the database has no ocr_pages table, so the clear cannot show which OCR pages it would delete.");
  }

  const pipelineTables = probe.pipeline_volumes > 0 && probe.pipeline_recipe_declarations > 0;
  if ((probe.pipeline_volumes > 0) !== (probe.pipeline_recipe_declarations > 0)) {
    throw refused("the database has only one of pipeline_volumes and pipeline_recipe_declarations.");
  }
  const counts = readCounts(
    await countRows(clearGuardCountsSql(tenantId, { pipelineTables })),
    ["pipeline_pages", "migrated_pages", "other_pages", "pipeline_volumes", "recipe_declarations"],
  );
  if (!counts) throw refused("could not count its OCR pages and pipeline rows.");

  const found: string[] = [];
  if (counts.pipeline_pages > 0) {
    found.push(`${counts.pipeline_pages} OCR pages written by the media pipeline, which cannot be rebuilt`);
  }
  if (counts.other_pages > 0) {
    found.push(`${counts.other_pages} OCR pages without a run id that are not migrated page-1 rows, which the importer does not recreate`);
  }
  if (counts.pipeline_volumes > 0) {
    found.push(`${counts.pipeline_volumes} pipeline volumes`);
  }
  if (counts.recipe_declarations > 0) {
    found.push(`${counts.recipe_declarations} recipe declarations`);
  }
  if (found.length > 0) {
    throw refused(`the clear would delete ${found.join("; ")}.`);
  }
  return { migratedPages: counts.migrated_pages };
}

/**
 * The production row reader for `refuseUnsafeTenantClear`: runs
 * the SQL against the target D1 through wrangler and returns the rows.
 * `outputDir` is kept for callers that pass it; reads write no files.
 */
export function wranglerRows(
  target: ClearTarget,
  outputDir: string = DEFAULT_OUTPUT_DIR,
): (sql: string) => Promise<unknown[]> {
  return (sql) => wranglerJson(target, sql, "ocr-pages");
}

/**
 * Take a per-tenant + ancillary count snapshot of the target D1. Issues
 * at most TWO wrangler invocations per snapshot (one for the per-tenant
 * domain UNION ALL, one for the ancillary table UNION ALL). The single-
 * UNION-ALL shape is the explicit anti-chatty-assertions pattern --
 * 8 separate calls would multiply round-trip latency for no
 * information gain.
 *
 * `outputDir` is kept for callers that pass it; the reads no longer
 * write temporary files.
 */
export async function snapshotCounts(
  target: ClearTarget,
  outputDir: string = DEFAULT_OUTPUT_DIR,
): Promise<CountSnapshot> {
  // Per-tenant counts across the four tenanted domain tables. GROUP BY
  // tenant_id so tenants with zero rows in a table are simply absent
  // from the result set; assertPostClearInvariants treats absent =
  // (table-count == 0) for that tenant.
  const domainSql = `SELECT 'repositories' AS tbl, tenant_id, COUNT(*) AS cnt FROM repositories GROUP BY tenant_id
UNION ALL
SELECT 'descriptions', tenant_id, COUNT(*) FROM descriptions GROUP BY tenant_id
UNION ALL
SELECT 'entities', tenant_id, COUNT(*) FROM entities GROUP BY tenant_id
UNION ALL
SELECT 'places', tenant_id, COUNT(*) FROM places GROUP BY tenant_id;
`;
  const domainRows = (await wranglerJson(target, domainSql, "domain")) as Array<{ tbl: string; tenant_id: string; cnt: number }>;

  const ancillarySql = `SELECT 'audit_log' AS tbl, COUNT(*) AS cnt FROM audit_log
UNION ALL SELECT 'drafts', COUNT(*) FROM drafts
UNION ALL SELECT 'changelog', COUNT(*) FROM changelog
UNION ALL SELECT 'comments', COUNT(*) FROM comments;
`;
  const ancillaryRows = (await wranglerJson(target, ancillarySql, "ancillary")) as Array<{ tbl: string; cnt: number }>;

  const domainByTenant = new Map<
    string,
    { repositories: number; descriptions: number; entities: number; places: number }
  >();
  for (const row of domainRows) {
    const existing =
      domainByTenant.get(row.tenant_id) ??
      { repositories: 0, descriptions: 0, entities: 0, places: 0 };
    if (row.tbl === "repositories") existing.repositories = row.cnt;
    if (row.tbl === "descriptions") existing.descriptions = row.cnt;
    if (row.tbl === "entities") existing.entities = row.cnt;
    if (row.tbl === "places") existing.places = row.cnt;
    domainByTenant.set(row.tenant_id, existing);
  }

  const ancillary = { audit_log: 0, drafts: 0, changelog: 0, comments: 0 };
  for (const row of ancillaryRows) {
    if (row.tbl in ancillary) {
      (ancillary as Record<string, number>)[row.tbl] = row.cnt;
    }
  }

  return { domainByTenant, ancillary };
}

/**
 * Cross-tenant invariant runtime check. Throws on any of three
 * invariant violations; the orchestrator catches the throw and aborts
 * the run before any INSERT can corrupt cross-tenant state.
 *
 *   (a) Every non-Neogranadina tenant's domain counts unchanged --
 *       a counts diff means the clear hit rows it shouldn't have.
 *       Throw lists the offending tenant id + before/after counts.
 *   (b) Neogranadina domain counts in all four tenanted domain tables
 *       are 0 post-clear -- otherwise the clear was incomplete and
 *       re-running may produce duplicate rows.
 *   (c) Ancillary table counts (audit_log/drafts/changelog/comments)
 *       unchanged -- these tables stay intact across rounds; a diff
 *       means the clear leaked into the ancillary surface.
 *
 * Returns a ClearAssertion[] on success so the orchestrator can record
 * the per-invariant pass into the run manifest. The function never
 * returns a `passed: false` entry; failure is signalled exclusively by
 * the throw, so callers cannot accidentally silence a violation by
 * inspecting the array.
 */
export function assertPostClearInvariants(
  before: CountSnapshot,
  after: CountSnapshot,
): ClearAssertion[] {
  const results: ClearAssertion[] = [];

  // (a) every non-neogranadina tenant unchanged
  for (const [tenantId, beforeCounts] of before.domainByTenant) {
    if (tenantId === NEOGRANADINA_TENANT_ID) continue;
    const afterCounts = after.domainByTenant.get(tenantId);
    const equal =
      afterCounts !== undefined &&
      afterCounts.repositories === beforeCounts.repositories &&
      afterCounts.descriptions === beforeCounts.descriptions &&
      afterCounts.entities === beforeCounts.entities &&
      afterCounts.places === beforeCounts.places;
    if (!equal) {
      throw new Error(
        `[ABORT] Tenant ${tenantId} counts changed during clear. ` +
          `before=${JSON.stringify(beforeCounts)} ` +
          `after=${JSON.stringify(afterCounts)}. ` +
          `Cross-tenant clear suspected -- inspect manually before re-running.`,
      );
    }
  }
  results.push({ invariant: "non-neo-tenants-unchanged", passed: true });

  // (b) neogranadina domain counts all 0
  const neoAfter = after.domainByTenant.get(NEOGRANADINA_TENANT_ID);
  if (
    neoAfter &&
    (neoAfter.repositories ||
      neoAfter.descriptions ||
      neoAfter.entities ||
      neoAfter.places)
  ) {
    throw new Error(
      `[ABORT] Neogranadina clear incomplete: ${JSON.stringify(neoAfter)}. ` +
        `Re-running may produce duplicate rows.`,
    );
  }
  results.push({ invariant: "neo-domain-zero", passed: true });

  // (c) ancillary counts unchanged
  for (const key of Object.keys(before.ancillary) as Array<
    keyof CountSnapshot["ancillary"]
  >) {
    if (before.ancillary[key] !== after.ancillary[key]) {
      throw new Error(
        `[ABORT] Ancillary table ${key} count changed during clear. ` +
          `before=${before.ancillary[key]} after=${after.ancillary[key]}. ` +
          `These tables stay intact across rounds.`,
      );
    }
  }
  results.push({ invariant: "ancillary-unchanged", passed: true });

  return results;
}

// Version: v0.8.0
