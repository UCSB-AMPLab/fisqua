/**
 * Tests — re-sourcing truncated transcripts
 *
 * This suite covers the pure parts of the one-off command that restores
 * the transcripts the original import clipped. The planner decides, for
 * each clipped description, whether a supplied original can replace the
 * clipped page text: only when the description carries the clipped
 * marker, the original exists, and its UTF-8 length equals the length
 * the marker recorded. The statement builder writes an original that is
 * larger than one D1 statement may carry as a series of appends, each
 * under the limit, scoped to the description's workspace. The column
 * guard refuses to write while the retired OCR column still exists,
 * because the migration that drops it would copy the clipped text back
 * over the restored page.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import {
  planResourcing, splitForSql, restorationSql, assertColumnRetired, RESTORE_STATEMENT_BYTES,
} from "../../scripts/commands/ocr-resource-truncated";

const marker = (n: number) => JSON.stringify([{ provider: "ocr-truncated", id: n }]);
const row = (legacyIds: string) => ({ id: "d1", tenantId: "t1", referenceCode: "pe-bn-cdip-1", legacyIds, text: "x" });
const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("planResourcing", () => {
  it("replaces a clipped page when the original's byte length matches the marker", () => {
    const original = "á".repeat(10);
    const out = planResourcing([row(marker(20))], { "pe-bn-cdip-1": original });
    expect(out).toEqual({ update: [{ descriptionId: "d1", tenantId: "t1", text: original }], missing: [], mismatched: [] });
  });

  it("reports a missing original", () => {
    const out = planResourcing([row(marker(20))], {});
    expect(out.missing).toEqual(["pe-bn-cdip-1"]);
    expect(out.update).toEqual([]);
  });

  it("reports an original whose length disagrees with the marker", () => {
    const out = planResourcing([row(marker(999))], { "pe-bn-cdip-1": "short" });
    expect(out.mismatched).toEqual(["pe-bn-cdip-1"]);
  });

  it("ignores rows without the marker", () => {
    expect(planResourcing([row("[]")], { "pe-bn-cdip-1": "y" })).toEqual({ update: [], missing: [], mismatched: [] });
  });
});

describe("splitForSql", () => {
  it("splits a 181 KB text with quotes and accents into pieces under the limit that rejoin exactly", () => {
    const text = ("Carta de D'Elhuyar, Popayán. ").repeat(6_500); // about 190 KB
    const pieces = splitForSql(text, RESTORE_STATEMENT_BYTES - 500);
    expect(pieces.join("")).toBe(text);
    expect(pieces.length).toBeGreaterThan(3);
    for (const p of pieces) expect(bytes(p.replaceAll("'", "''"))).toBeLessThanOrEqual(RESTORE_STATEMENT_BYTES - 500);
  });

  it("never cuts inside a surrogate pair", () => {
    const pieces = splitForSql("𝔄".repeat(1_000), 101);
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const p of pieces) expect(p).not.toMatch(lone);
    expect(pieces.join("")).toBe("𝔄".repeat(1_000));
  });
});

describe("restorationSql", () => {
  const update = { descriptionId: "d1", tenantId: "t1", text: "x'y ".repeat(40_000) }; // 160 KB
  const statements = restorationSql(update, "att-1", 1_700_000_000_000);

  it("keeps every statement under the limit", () => {
    for (const s of statements) expect(bytes(s)).toBeLessThanOrEqual(RESTORE_STATEMENT_BYTES);
  });

  it("stages, appends, copies into the migrated page-1 row, then clears the staging row", () => {
    expect(statements[0]).toMatch(/^INSERT INTO ocr_pages_staging /);
    expect(statements.slice(1, -2).every((s) => s.startsWith("UPDATE ocr_pages_staging SET text = text || "))).toBe(true);
    expect(statements.at(-2)).toMatch(/^UPDATE ocr_pages SET text = \(SELECT text FROM ocr_pages_staging /);
    expect(statements.at(-2)).toContain("run_id IS NULL AND page_seq = 1");
    expect(statements.at(-1)).toMatch(/^DELETE FROM ocr_pages_staging /);
  });

  it("scopes every statement to the description's workspace", () => {
    for (const s of statements) expect(s).toContain("tenant_id = 't1'");
  });
});

describe("assertColumnRetired", () => {
  it("refuses while descriptions.ocr_text exists", () => {
    expect(() => assertColumnRetired(["id", "title", "ocr_text"])).toThrow(/0087/);
  });
  it("allows once the column is gone", () => {
    expect(() => assertColumnRetired(["id", "title"])).not.toThrow();
  });
});
