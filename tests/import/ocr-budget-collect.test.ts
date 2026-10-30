/**
 * Tests — collecting the OCR budget through an injected reader
 *
 * This suite covers `collectOcrBudget`, the path the command-line
 * report takes: each budget statement goes through the reader it is
 * given (in the command, wrangler's `d1 execute --json`) exactly once,
 * the index's text copy is measured only when that table exists, and
 * the report is assembled from the rows the reader returned. The reader
 * is a fake that records each statement, so no wrangler process runs.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { collectOcrBudget, OCR_BUDGET_SQL } from "../../app/lib/ocr/budget.server";

type Key = keyof typeof OCR_BUDGET_SQL;

function fakeReader(rowsFor: Partial<Record<Key, Record<string, unknown>[]>>) {
  const seen: string[] = [];
  const keyOf = new Map(Object.entries(OCR_BUDGET_SQL).map(([k, v]) => [v, k as Key]));
  const read = async (sql: string) => {
    seen.push(sql);
    const key = keyOf.get(sql);
    if (!key) throw new Error(`unexpected statement: ${sql}`);
    return rowsFor[key] ?? [];
  };
  return { read, seen };
}

const BASE: Partial<Record<Key, Record<string, unknown>[]>> = {
  totals: [{ page_rows: 14272, descriptions_with_pages: 14272, text_bytes: 62073926 }],
  ftsIndex: [{ fts_index_bytes: 40000000 }],
  staging: [{ staging_rows: 2, staging_bytes: 900 }],
  perTenant: [
    { tenant_id: "t-a", page_rows: 14000, text_bytes: 62000000 },
    { tenant_id: "t-b", page_rows: 272, text_bytes: 73926 },
  ],
};

describe("collectOcrBudget", () => {
  it("runs every statement once and reads the content copy when the table exists", async () => {
    const { read, seen } = fakeReader({
      ...BASE,
      ftsContentExists: [{ name: "ocr_pages_fts_content" }],
      ftsContent: [{ fts_content_bytes: 62073926 }],
    });
    const b = await collectOcrBudget(read);
    expect([...seen].sort()).toEqual(Object.values(OCR_BUDGET_SQL).sort());
    expect(b).toEqual({
      pageRows: 14272,
      descriptionsWithPages: 14272,
      textBytes: 62073926,
      ftsIndexBytes: 40000000,
      ftsContentBytes: 62073926,
      stagingRows: 2,
      stagingBytes: 900,
      perTenant: [
        { tenantId: "t-a", pageRows: 14000, textBytes: 62000000 },
        { tenantId: "t-b", pageRows: 272, textBytes: 73926 },
      ],
    });
  });

  it("skips the content statement when the index keeps no copy", async () => {
    const { read, seen } = fakeReader({ ...BASE, ftsContentExists: [] });
    const b = await collectOcrBudget(read);
    expect(seen).not.toContain(OCR_BUDGET_SQL.ftsContent);
    expect(seen.length).toBe(Object.keys(OCR_BUDGET_SQL).length - 1);
    expect(new Set(seen).size).toBe(seen.length);
    expect(b.ftsContentBytes).toBe(0);
  });

  it("reads numbers that arrive as strings and empty sums as zero", async () => {
    const { read } = fakeReader({
      totals: [{ page_rows: "0", descriptions_with_pages: "0", text_bytes: null }],
      ftsIndex: [{ fts_index_bytes: null }],
      ftsContentExists: [],
      staging: [{ staging_rows: 0, staging_bytes: null }],
      perTenant: [],
    });
    const b = await collectOcrBudget(read);
    expect(b).toEqual({
      pageRows: 0, descriptionsWithPages: 0, textBytes: 0, ftsIndexBytes: 0,
      ftsContentBytes: 0, stagingRows: 0, stagingBytes: 0, perTenant: [],
    });
  });
});
