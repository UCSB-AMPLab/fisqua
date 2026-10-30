/**
 * Tests — moving the OCR blobs into page rows
 *
 * This suite covers migration 0086, which copies every non-empty
 * `ocr_text` into a single page-1 row: no page boundaries are invented,
 * empty and missing transcripts produce no row, the tenant comes from
 * the description, and the copied text is searchable at once, with the
 * external-content index consistent with the page table. The `ocr_text`
 * column is added back here when the hand-built schema no longer has
 * it, so the test keeps describing the migration after the column is
 * dropped.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { runMigrationFile } from "../helpers/migration-file";
import { seedOcrFixtures, OCR_IDS } from "../helpers/ocr-fixtures";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LONG = "palabra ".repeat(12_000); // ~96 KB, above the old import cap

describe("migration 0086", () => {
  beforeAll(async () => {
    await applyMigrations();
    await cleanDatabase();
    const { results } = await env.DB.prepare("PRAGMA table_info(descriptions)").all<{ name: string }>();
    if (!results.some((r) => r.name === "ocr_text")) {
      await env.DB.prepare("ALTER TABLE descriptions ADD COLUMN ocr_text TEXT DEFAULT ''").run();
    }
    await seedOcrFixtures();
    await env.DB.prepare("UPDATE descriptions SET ocr_text = ? WHERE id = ?").bind("Bando del virrey marmolejo", OCR_IDS.descA1).run();
    await env.DB.prepare("UPDATE descriptions SET ocr_text = ? WHERE id = ?").bind(LONG, OCR_IDS.descA2).run();
    await env.DB.prepare("UPDATE descriptions SET ocr_text = '' WHERE id = ?").bind(OCR_IDS.descB1).run();
    await runMigrationFile("0086_ocr_pages_backfill.sql");
  });

  it("writes one page-1 row per non-empty transcript and none for empty ones", async () => {
    const { results } = await env.DB.prepare(
      "SELECT description_id, page_seq, tenant_id, source_key, alto_key, run_id, id FROM ocr_pages ORDER BY description_id",
    ).all<Record<string, unknown>>();
    expect(results.map((r) => r.description_id)).toEqual([OCR_IDS.descA1, OCR_IDS.descA2]);
    for (const r of results) {
      expect(r.page_seq).toBe(1);
      expect(r.tenant_id).toBe(OCR_IDS.tenantA);
      expect(r.source_key).toBeNull();
      expect(r.alto_key).toBeNull();
      expect(r.run_id).toBeNull();
      expect(r.id).toMatch(UUID);
    }
  });

  it("copies the text byte for byte, including text above the old import cap", async () => {
    const row = await env.DB.prepare("SELECT text FROM ocr_pages WHERE description_id = ?").bind(OCR_IDS.descA2).first<{ text: string }>();
    expect(row!.text).toBe(LONG);
  });

  it("makes the copied text searchable", async () => {
    const row = await env.DB.prepare(
      "SELECT p.description_id AS d FROM ocr_pages p JOIN ocr_pages_fts f ON f.rowid = p.rowid WHERE f.ocr_pages_fts MATCH 'marmolejo'",
    ).first<{ d: string }>();
    expect(row!.d).toBe(OCR_IDS.descA1);
  });

  it("leaves the index consistent with the page table", async () => {
    await env.DB.prepare("INSERT INTO ocr_pages_fts(ocr_pages_fts, rank) VALUES ('integrity-check', 1)").run();
  });
});
