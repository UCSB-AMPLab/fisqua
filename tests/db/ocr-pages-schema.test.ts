/**
 * Tests — the OCR page table and its index
 *
 * This suite covers migration 0085: one row per page of OCR text,
 * unique per description and page, a staging table the ingest writes
 * through, and a full-text index that follows every insert, update and
 * delete — including the deletes a description's own removal cascades
 * into. The index is external-content: it reads page text from
 * `ocr_pages` and keeps no copy of its own, and FTS5's integrity check,
 * run against the page table, passes after each kind of change. The
 * migration file itself is run here, not the hand-built mirror, so the
 * test sees what D1 will see; a second describe pins that the mirror in
 * `tests/helpers/db.ts` builds the same columns and the same index.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { runMigrationFile } from "../helpers/migration-file";
import { seedOcrFixtures, seedPage, OCR_IDS } from "../helpers/ocr-fixtures";

export const OCR_PAGES_COLUMNS = [
  "id", "tenant_id", "description_id", "page_seq", "text", "source_key", "alto_key", "run_id", "created_at",
];

async function columns(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return results.map((r) => r.name);
}

async function matchCount(term: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM ocr_pages p JOIN ocr_pages_fts f ON f.rowid = p.rowid WHERE f.ocr_pages_fts MATCH ?",
  ).bind(term).first<{ n: number }>();
  return row!.n;
}

/** FTS5's check of the index against the page table it reads from. */
async function integrityCheck(): Promise<void> {
  await env.DB.prepare("INSERT INTO ocr_pages_fts(ocr_pages_fts, rank) VALUES ('integrity-check', 1)").run();
}

async function indexDefinition(): Promise<{ sql: string; shadowContent: boolean }> {
  const row = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name = 'ocr_pages_fts'").first<{ sql: string }>();
  const shadow = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ocr_pages_fts_content'",
  ).first();
  return { sql: row!.sql.replace(/\s+/g, " "), shadowContent: shadow !== null };
}

describe("migration 0085", () => {
  beforeAll(async () => {
    await applyMigrations();
    await cleanDatabase();
    for (const s of [
      "DROP TRIGGER IF EXISTS ocr_pages_fts_ai", "DROP TRIGGER IF EXISTS ocr_pages_fts_ad",
      "DROP TRIGGER IF EXISTS ocr_pages_fts_au", "DROP TABLE IF EXISTS ocr_pages_fts",
      "DROP TABLE IF EXISTS ocr_pages_staging", "DROP TABLE IF EXISTS ocr_pages",
    ]) await env.DB.prepare(s).run();
    await runMigrationFile("0085_ocr_pages.sql");
    await seedOcrFixtures();
  });

  it("creates the page table with the agreed columns", async () => {
    expect(await columns("ocr_pages")).toEqual(OCR_PAGES_COLUMNS);
  });

  it("rejects a second row for the same description and page", async () => {
    await seedPage({ descriptionId: OCR_IDS.descA1, tenantId: OCR_IDS.tenantA, pageSeq: 1, text: "uno" });
    await expect(
      seedPage({ descriptionId: OCR_IDS.descA1, tenantId: OCR_IDS.tenantA, pageSeq: 1, text: "dos" }),
    ).rejects.toThrow();
  });

  it("rejects page_seq below 1", async () => {
    await expect(
      seedPage({ descriptionId: OCR_IDS.descA1, tenantId: OCR_IDS.tenantA, pageSeq: 0, text: "x" }),
    ).rejects.toThrow();
  });

  it("indexes inserts, follows updates, and forgets deletes", async () => {
    await seedPage({ descriptionId: OCR_IDS.descA2, tenantId: OCR_IDS.tenantA, pageSeq: 1, text: "virreinato chuquisaca" });
    expect(await matchCount("chuquisaca")).toBe(1);
    await env.DB.prepare("UPDATE ocr_pages SET text = 'virreinato potosi' WHERE description_id = ? AND page_seq = 1").bind(OCR_IDS.descA2).run();
    expect(await matchCount("chuquisaca")).toBe(0);
    expect(await matchCount("potosi")).toBe(1);
    await env.DB.prepare("DELETE FROM ocr_pages WHERE description_id = ? AND page_seq = 1").bind(OCR_IDS.descA2).run();
    expect(await matchCount("potosi")).toBe(0);
  });

  it("is an external-content index over ocr_pages that keeps no copy of the text", async () => {
    const { sql, shadowContent } = await indexDefinition();
    expect(sql).toContain("content='ocr_pages'");
    expect(sql).toContain("content_rowid='rowid'");
    expect(shadowContent).toBe(false);
  });

  it("stays consistent with the page table through insert, update and delete", async () => {
    await seedPage({ descriptionId: OCR_IDS.descA3, tenantId: OCR_IDS.tenantA, pageSeq: 1, text: "real audiencia de quito" });
    await seedPage({ descriptionId: OCR_IDS.descA3, tenantId: OCR_IDS.tenantA, pageSeq: 2, text: "cabildo de cuenca" });
    await integrityCheck();
    await env.DB.prepare("UPDATE ocr_pages SET text = 'cabildo de loja' WHERE description_id = ? AND page_seq = 2").bind(OCR_IDS.descA3).run();
    await integrityCheck();
    // An update that leaves the text alone must not touch the index.
    await env.DB.prepare("UPDATE ocr_pages SET source_key = 'k' WHERE description_id = ? AND page_seq = 1").bind(OCR_IDS.descA3).run();
    await integrityCheck();
    await env.DB.prepare("DELETE FROM ocr_pages WHERE description_id = ? AND page_seq = 1").bind(OCR_IDS.descA3).run();
    await integrityCheck();
    expect(await matchCount("quito")).toBe(0);
    expect(await matchCount("loja")).toBe(1);
  });

  it("folds accents the way the record index does", async () => {
    await seedPage({ descriptionId: OCR_IDS.descA2, tenantId: OCR_IDS.tenantA, pageSeq: 2, text: "Cofradía de Nuestra Señora" });
    expect(await matchCount("cofradia")).toBe(1);
  });

  it("returns snippet() over page text", async () => {
    // Each test's writes are rolled back after it (isolated storage), so
    // this test seeds its own page rather than reading the previous one's.
    await seedPage({ descriptionId: OCR_IDS.descA2, tenantId: OCR_IDS.tenantA, pageSeq: 2, text: "Cofradía de Nuestra Señora" });
    const row = await env.DB.prepare(
      "SELECT snippet(f.ocr_pages_fts, 0, '[', ']', '…', 8) AS s FROM ocr_pages p JOIN ocr_pages_fts f ON f.rowid = p.rowid WHERE f.ocr_pages_fts MATCH 'senora'",
    ).first<{ s: string }>();
    expect(row!.s).toContain("[Señora]");
  });

  it("removes a description's pages and their index entries when the description goes", async () => {
    await seedPage({ descriptionId: OCR_IDS.descB1, tenantId: OCR_IDS.tenantB, pageSeq: 1, text: "huancavelica" });
    expect(await matchCount("huancavelica")).toBe(1);
    await env.DB.prepare("DELETE FROM descriptions WHERE id = ?").bind(OCR_IDS.descB1).run();
    const left = await env.DB.prepare("SELECT count(*) AS n FROM ocr_pages WHERE description_id = ?").bind(OCR_IDS.descB1).first<{ n: number }>();
    expect(left!.n).toBe(0);
    expect(await matchCount("huancavelica")).toBe(0);
  });

  it("creates the staging table, keyed by attempt", async () => {
    expect(await columns("ocr_pages_staging")).toEqual([
      "attempt_id", "run_id", "description_id", "page_seq", "tenant_id", "text", "source_key", "alto_key", "created_at",
    ]);
    const insert = "INSERT INTO ocr_pages_staging (attempt_id, run_id, description_id, page_seq, tenant_id, text, created_at) VALUES (?, 'r', ?, 1, ?, 'x', 0)";
    await env.DB.prepare(insert).bind("att-1", OCR_IDS.descA1, OCR_IDS.tenantA).run();
    await env.DB.prepare(insert).bind("att-2", OCR_IDS.descA1, OCR_IDS.tenantA).run();
    await expect(env.DB.prepare(insert).bind("att-1", OCR_IDS.descA1, OCR_IDS.tenantA).run()).rejects.toThrow();
  });
});

describe("the hand-built test schema", () => {
  it("mirrors 0085's columns", async () => {
    await applyMigrations();
    expect(await columns("ocr_pages")).toEqual(OCR_PAGES_COLUMNS);
  });

  it("mirrors 0085's external-content index", async () => {
    await applyMigrations();
    const { sql, shadowContent } = await indexDefinition();
    expect(sql).toContain("content='ocr_pages'");
    expect(shadowContent).toBe(false);
    const triggers = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'ocr_pages_fts_%' ORDER BY name",
    ).all<{ name: string; sql: string }>();
    expect(triggers.results.map((t) => t.name)).toEqual(["ocr_pages_fts_ad", "ocr_pages_fts_ai", "ocr_pages_fts_au"]);
    for (const t of triggers.results.filter((t) => t.name !== "ocr_pages_fts_ai")) {
      expect(t.sql).toContain("VALUES ('delete', old.rowid, old.text)");
    }
  });
});
