/**
 * Tests — retiring the OCR column
 *
 * This suite covers migration 0087. Before it drops
 * `descriptions.ocr_text` it copies across anything written to the
 * column after 0086 ran — a transcript first filled, one edited, or one
 * cleared — so the window between the two migrations loses nothing and
 * restores nothing. A cleared transcript (NULL or empty) removes its
 * migrated page-1 row and that row's full-text entry. Pages written by
 * a pipeline run are left as they are. After it the column is gone and
 * the record index still follows description edits.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { runMigrationFile } from "../helpers/migration-file";
import { seedOcrFixtures, seedPage, OCR_IDS } from "../helpers/ocr-fixtures";

// extra descriptions for the late-clear cases, beside the shared fixtures
const CLEARED_NULL = "0d000000-0000-4000-8000-0000000000c1";
const CLEARED_EMPTY = "0d000000-0000-4000-8000-0000000000c2";
const PIPELINE_CLEARED = "0d000000-0000-4000-8000-0000000000c3";

async function seedDescription(id: string, ref: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO descriptions (id, tenant_id, repository_id, description_level, reference_code, title, created_at, updated_at) VALUES (?, ?, ?, 'item', ?, ?, ?, ?)",
  ).bind(id, OCR_IDS.tenantA, OCR_IDS.repoA, ref, ref, now, now).run();
}

beforeAll(async () => {
  await applyMigrations();
  await cleanDatabase();
  const { results } = await env.DB.prepare("PRAGMA table_info(descriptions)").all<{ name: string }>();
  if (!results.some((r) => r.name === "ocr_text")) {
    await env.DB.prepare("ALTER TABLE descriptions ADD COLUMN ocr_text TEXT DEFAULT ''").run();
  }
  await seedOcrFixtures();
  await env.DB.prepare("UPDATE descriptions SET ocr_text = 'antes' WHERE id = ?").bind(OCR_IDS.descA1).run();
  await seedDescription(CLEARED_NULL, "pe-bn-cdip-00011");
  await seedDescription(CLEARED_EMPTY, "pe-bn-cdip-00012");
  await seedDescription(PIPELINE_CLEARED, "pe-bn-cdip-00013");
  await env.DB.prepare("UPDATE descriptions SET ocr_text = 'tacuarembo' WHERE id = ?").bind(CLEARED_NULL).run();
  await env.DB.prepare("UPDATE descriptions SET ocr_text = 'yanacocha' WHERE id = ?").bind(CLEARED_EMPTY).run();
  await runMigrationFile("0086_ocr_pages_backfill.sql");
  // clears after 0086: one to NULL, one to the empty string
  await env.DB.prepare("UPDATE descriptions SET ocr_text = NULL WHERE id = ?").bind(CLEARED_NULL).run();
  await env.DB.prepare("UPDATE descriptions SET ocr_text = '' WHERE id = ?").bind(CLEARED_EMPTY).run();
  // a pipeline-written page whose description's column is empty
  await seedPage({ descriptionId: PIPELINE_CLEARED, tenantId: OCR_IDS.tenantA, pageSeq: 1, text: "de otra corrida", runId: "run-y" });
  await env.DB.prepare("UPDATE descriptions SET ocr_text = '' WHERE id = ?").bind(PIPELINE_CLEARED).run();
  // edits after 0086: one changed, one newly filled
  await env.DB.prepare("UPDATE descriptions SET ocr_text = 'despues' WHERE id = ?").bind(OCR_IDS.descA1).run();
  await env.DB.prepare("UPDATE descriptions SET ocr_text = 'nuevo' WHERE id = ?").bind(OCR_IDS.descA2).run();
  // a pipeline-written page whose description still has a stale column value
  await seedPage({ descriptionId: OCR_IDS.descA3, tenantId: OCR_IDS.tenantA, pageSeq: 1, text: "de la corrida", runId: "run-x" });
  await env.DB.prepare("UPDATE descriptions SET ocr_text = 'columna vieja' WHERE id = ?").bind(OCR_IDS.descA3).run();
  await runMigrationFile("0087_drop_descriptions_ocr_text.sql");
});

describe("migration 0087", () => {
  it("carries late edits and late fills into page 1", async () => {
    const { results } = await env.DB.prepare(
      "SELECT description_id, text FROM ocr_pages WHERE page_seq = 1 AND run_id IS NULL ORDER BY description_id",
    ).all<{ description_id: string; text: string }>();
    expect(results).toEqual([
      { description_id: OCR_IDS.descA1, text: "despues" },
      { description_id: OCR_IDS.descA2, text: "nuevo" },
    ]);
  });

  it("does not overwrite pipeline-written pages", async () => {
    const row = await env.DB.prepare(
      "SELECT text, run_id FROM ocr_pages WHERE description_id = ? AND page_seq = 1",
    ).bind(OCR_IDS.descA3).first<{ text: string; run_id: string }>();
    expect(row).toEqual({ text: "de la corrida", run_id: "run-x" });
  });

  it("removes migrated page-1 rows whose transcript was cleared to NULL or empty", async () => {
    const { results } = await env.DB.prepare(
      "SELECT description_id FROM ocr_pages WHERE description_id IN (?, ?)",
    ).bind(CLEARED_NULL, CLEARED_EMPTY).all();
    expect(results).toEqual([]);
  });

  it("removes the cleared transcripts from the full-text index", async () => {
    for (const term of ["tacuarembo", "yanacocha"]) {
      const row = await env.DB.prepare(
        "SELECT count(*) AS n FROM ocr_pages_fts WHERE ocr_pages_fts MATCH ?",
      ).bind(term).first<{ n: number }>();
      expect(row!.n).toBe(0);
    }
  });

  it("keeps a pipeline-written page when the description's column is empty", async () => {
    const row = await env.DB.prepare(
      "SELECT text, run_id FROM ocr_pages WHERE description_id = ? AND page_seq = 1",
    ).bind(PIPELINE_CLEARED).first<{ text: string; run_id: string }>();
    expect(row).toEqual({ text: "de otra corrida", run_id: "run-y" });
  });

  it("drops the column", async () => {
    const { results } = await env.DB.prepare("PRAGMA table_info(descriptions)").all<{ name: string }>();
    expect(results.map((r) => r.name)).not.toContain("ocr_text");
  });

  it("leaves the record index following description edits", async () => {
    await env.DB.prepare("UPDATE descriptions SET title = 'Titulo quillacollo' WHERE id = ?").bind(OCR_IDS.descA1).run();
    const row = await env.DB.prepare("SELECT count(*) AS n FROM descriptions_fts WHERE descriptions_fts MATCH 'quillacollo'").first<{ n: number }>();
    expect(row!.n).toBe(1);
  });
});
