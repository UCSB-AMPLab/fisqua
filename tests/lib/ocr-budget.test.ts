/**
 * Tests — the OCR budget report
 *
 * This suite covers `measureOcrBudget`, which reports how much of the
 * database the OCR pages and their index take: row counts, text bytes
 * counted as UTF-8, the index's own storage, the index's copy of the
 * text when the index keeps one, and the same per workspace.
 *
 * The report reads across every workspace by design, so it must never
 * be reachable from a route: one case reads every route module as text
 * and checks none imports it.
 *
 * The Workers pool rolls back each test's writes, so the pages are
 * seeded before every test.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, cleanDatabase, getTestDb } from "../helpers/db";
import { seedOcrFixtures, seedPage, OCR_IDS } from "../helpers/ocr-fixtures";
import {
  measureOcrBudget,
  assembleOcrBudget,
  OCR_BUDGET_SQL,
} from "../../app/lib/ocr/budget.server";

const PAGES = [
  { descriptionId: OCR_IDS.descA1, tenantId: OCR_IDS.tenantA, pageSeq: 1, text: "real cédula de Popayán" },
  { descriptionId: OCR_IDS.descA1, tenantId: OCR_IDS.tenantA, pageSeq: 2, text: "año de 1790" },
  { descriptionId: OCR_IDS.descB1, tenantId: OCR_IDS.tenantB, pageSeq: 1, text: "Santafé" },
];
const bytes = (s: string) => new TextEncoder().encode(s).length;

beforeEach(async () => {
  await applyMigrations();
  await cleanDatabase();
  await seedOcrFixtures();
  for (const p of PAGES) await seedPage(p);
});

async function hasContentTable(): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ocr_pages_fts_content'",
  ).first();
  return row !== null;
}

describe("measureOcrBudget", () => {
  it("counts rows, descriptions and UTF-8 text bytes", async () => {
    const b = await measureOcrBudget(getTestDb());
    const expected = PAGES.reduce((n, p) => n + bytes(p.text), 0);
    // An accented character takes two bytes, so bytes and characters differ.
    expect(expected).toBeGreaterThan(PAGES.reduce((n, p) => n + p.text.length, 0));
    expect(b.pageRows).toBe(3);
    expect(b.descriptionsWithPages).toBe(2);
    expect(b.textBytes).toBe(expected);
  });

  it("measures the index, and its copy of the text when it keeps one", async () => {
    const b = await measureOcrBudget(getTestDb());
    expect(b.ftsIndexBytes).toBeGreaterThan(0);
    if (await hasContentTable()) {
      expect(b.ftsContentBytes).toBe(b.textBytes);
    } else {
      expect(b.ftsContentBytes).toBe(0);
    }
  });

  it("shows rows left in staging", async () => {
    const text = "página abandonada";
    await env.DB.prepare(
      "INSERT INTO ocr_pages_staging (attempt_id, run_id, description_id, page_seq, tenant_id, text, source_key, alto_key, created_at) VALUES (?, ?, ?, 1, ?, ?, NULL, NULL, ?)",
    ).bind(crypto.randomUUID(), crypto.randomUUID(), OCR_IDS.descA2, OCR_IDS.tenantA, text, Date.now()).run();
    const b = await measureOcrBudget(getTestDb());
    expect(b.stagingRows).toBe(1);
    expect(b.stagingBytes).toBe(bytes(text));
  });

  it("splits rows and bytes per workspace", async () => {
    const b = await measureOcrBudget(getTestDb());
    const byTenant = new Map(b.perTenant.map((t) => [t.tenantId, t]));
    expect(byTenant.get(OCR_IDS.tenantA)).toEqual({
      tenantId: OCR_IDS.tenantA, pageRows: 2, textBytes: bytes(PAGES[0].text) + bytes(PAGES[1].text),
    });
    expect(byTenant.get(OCR_IDS.tenantB)).toEqual({
      tenantId: OCR_IDS.tenantB, pageRows: 1, textBytes: bytes(PAGES[2].text),
    });
    expect(b.perTenant.length).toBe(2);
  });

  it("assembles the same report from rows shaped as wrangler returns them", async () => {
    const rows = {} as Parameters<typeof assembleOcrBudget>[0];
    for (const key of Object.keys(OCR_BUDGET_SQL) as (keyof typeof OCR_BUDGET_SQL)[]) {
      if (key === "ftsContent" && !(await hasContentTable())) {
        rows[key] = [];
        continue;
      }
      // wrangler's --json gives, per statement, a `results` array of
      // plain row objects keyed by column name.
      const out = await env.DB.prepare(OCR_BUDGET_SQL[key]).all();
      rows[key] = JSON.parse(JSON.stringify(out.results));
    }
    expect(assembleOcrBudget(rows)).toEqual(await measureOcrBudget(getTestDb()));
  });

  it("is imported by no route module", () => {
    const files = import.meta.glob("../../app/routes/**/*.{ts,tsx}", {
      query: "?raw", import: "default", eager: true,
    }) as Record<string, string>;
    expect(Object.keys(files).length).toBeGreaterThan(10);
    const importers = Object.entries(files)
      .filter(([, source]) => source.includes("ocr/budget.server"))
      .map(([path]) => path);
    expect(importers).toEqual([]);
  });
});
