/**
 * OCR budget report
 *
 * This module measures how much of the database the OCR transcripts
 * take. Page text and its full-text index share one D1 database with
 * everything else, under D1's per-database size cap, so the decision to
 * move the index out of D1 has to rest on measured numbers rather than
 * estimates. The report gives page rows, descriptions with pages, the
 * text in UTF-8 bytes, the index's own storage (`ocr_pages_fts_data`),
 * the index's copy of the text when it keeps one
 * (`ocr_pages_fts_content`, present for a regular FTS5 table, absent for
 * an external-content one), rows abandoned in `ocr_pages_staging`, and
 * the page rows and bytes per workspace.
 *
 * ONE SET OF STATEMENTS, TWO WAYS TO RUN THEM. The SQL lives once, as
 * plain strings in OCR_BUDGET_SQL with no bound values.
 * `collectOcrBudget` runs each through whatever reader it is given and
 * assembles the report: the command-line script passes a reader over
 * `wrangler d1 execute --json`, and `measureOcrBudget` passes one over a
 * D1 binding, for the Worker and the Workers test pool.
 *
 * ACROSS EVERY WORKSPACE, AND FOR OPERATORS ONLY. The size cap applies
 * to the shared database, not to one workspace's share of it, so these
 * statements carry no tenant predicate; `perTenant` is the breakdown.
 * That makes the report an operator measurement. It is reachable from
 * the command line and from tests only, and a test checks that no route
 * module imports it, so no page can show one workspace another's
 * counts. The statements are raw strings rather than Drizzle calls on
 * the page tables for the same reason: they are not request reads.
 *
 * @version v0.8.0
 */
import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

export interface OcrBudget {
  pageRows: number;
  descriptionsWithPages: number;
  /** Sum of the UTF-8 bytes of `ocr_pages.text`. */
  textBytes: number;
  /** Sum of `length(block)` over `ocr_pages_fts_data`. */
  ftsIndexBytes: number;
  /** UTF-8 bytes of the index's own copy of the text; 0 when it keeps none. */
  ftsContentBytes: number;
  /** Rows left in `ocr_pages_staging` by abandoned ingest attempts. */
  stagingRows: number;
  stagingBytes: number;
  perTenant: { tenantId: string; pageRows: number; textBytes: number }[];
}

/** Each value is one SELECT returning one row (or, for perTenant, one row per tenant). */
export const OCR_BUDGET_SQL = {
  totals:
    "SELECT count(*) AS page_rows, count(DISTINCT description_id) AS descriptions_with_pages, " +
    "sum(length(CAST(text AS BLOB))) AS text_bytes FROM ocr_pages",
  ftsIndex: "SELECT sum(length(block)) AS fts_index_bytes FROM ocr_pages_fts_data",
  ftsContentExists:
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ocr_pages_fts_content'",
  ftsContent:
    "SELECT sum(length(CAST(c0 AS BLOB))) AS fts_content_bytes FROM ocr_pages_fts_content",
  staging:
    "SELECT count(*) AS staging_rows, sum(length(CAST(text AS BLOB))) AS staging_bytes FROM ocr_pages_staging",
  perTenant:
    "SELECT tenant_id, count(*) AS page_rows, sum(length(CAST(text AS BLOB))) AS text_bytes " +
    "FROM ocr_pages GROUP BY tenant_id ORDER BY tenant_id",
} as const;

type BudgetKey = keyof typeof OCR_BUDGET_SQL;
type Rows = Record<string, unknown>[];

/** A count or sum as it arrives from D1 or wrangler: number, numeric string, or null for an empty sum. */
function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Build the report from each statement's rows. `ftsContent` is [] when the index keeps no copy. */
export function assembleOcrBudget(rows: Record<BudgetKey, Rows>): OcrBudget {
  const totals = rows.totals[0] ?? {};
  const staging = rows.staging[0] ?? {};
  return {
    pageRows: num(totals.page_rows),
    descriptionsWithPages: num(totals.descriptions_with_pages),
    textBytes: num(totals.text_bytes),
    ftsIndexBytes: num(rows.ftsIndex[0]?.fts_index_bytes),
    ftsContentBytes: num(rows.ftsContent[0]?.fts_content_bytes),
    stagingRows: num(staging.staging_rows),
    stagingBytes: num(staging.staging_bytes),
    perTenant: rows.perTenant.map((r) => ({
      tenantId: String(r.tenant_id),
      pageRows: num(r.page_rows),
      textBytes: num(r.text_bytes),
    })),
  };
}

/** Runs every OCR_BUDGET_SQL string once through `read` and assembles the report. */
export async function collectOcrBudget(
  read: (sql: string) => Promise<Rows>,
): Promise<OcrBudget> {
  const contentTable = await read(OCR_BUDGET_SQL.ftsContentExists);
  const rows: Record<BudgetKey, Rows> = {
    totals: await read(OCR_BUDGET_SQL.totals),
    ftsIndex: await read(OCR_BUDGET_SQL.ftsIndex),
    ftsContentExists: contentTable,
    ftsContent: contentTable.length > 0 ? await read(OCR_BUDGET_SQL.ftsContent) : [],
    staging: await read(OCR_BUDGET_SQL.staging),
    perTenant: await read(OCR_BUDGET_SQL.perTenant),
  };
  return assembleOcrBudget(rows);
}

/** The report over a D1 binding. */
export async function measureOcrBudget(db: DrizzleD1Database<any>): Promise<OcrBudget> {
  return collectOcrBudget(async (statement) => (await db.all(sql.raw(statement))) as Rows);
}
