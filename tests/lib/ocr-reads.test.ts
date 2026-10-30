/**
 * Tests — reading one description's OCR pages
 *
 * This suite covers the reads the description page, the transcript view
 * and the authorities worklist use: page counts and sizes, a page of
 * pages in order, a bounded assembled text that stops reading once it
 * has enough, and find-in-transcript that names the pages a term is on,
 * retrying once with the sanitised expression when FTS5 rejects the
 * compiled one. Every read is tenant-scoped; a description in another
 * tenant reads as having no transcript. A static guard pins the tenant
 * predicate in every raw statement over the page tables, which the
 * cross-tenant keystone cannot see.
 *
 * The Workers pool rolls back each test's writes, so the pages are
 * seeded before every test rather than once for the file.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyMigrations, cleanDatabase, getTestDb } from "../helpers/db";
import { seedOcrFixtures, seedPage, OCR_IDS } from "../helpers/ocr-fixtures";
import {
  transcriptSummary, transcriptSummaries, loadTranscriptPages, loadTranscriptText,
  findInTranscript, findInTranscriptWithRetry, findAnchorPages, PAGE_JOIN,
} from "../../app/lib/ocr/search.server";

beforeEach(async () => {
  await applyMigrations();
  await cleanDatabase();
  await seedOcrFixtures();
  for (let seq = 1; seq <= 5; seq++) {
    await seedPage({ descriptionId: OCR_IDS.descA1, tenantId: OCR_IDS.tenantA, pageSeq: seq, text: `folio ${seq} ` + "z".repeat(100) });
  }
  await seedPage({ descriptionId: OCR_IDS.descA1, tenantId: OCR_IDS.tenantA, pageSeq: 6, text: "real cedula de arequipa" });
  await seedPage({ descriptionId: OCR_IDS.descB1, tenantId: OCR_IDS.tenantB, pageSeq: 1, text: "arequipa ajena" });
});

describe("one description's pages", () => {
  it("summarises page count and length", async () => {
    const s = await transcriptSummary(getTestDb(), OCR_IDS.tenantA, OCR_IDS.descA1);
    expect(s.pageCount).toBe(6);
    expect(s.totalChars).toBe(5 * 108 + "real cedula de arequipa".length + 5 * PAGE_JOIN.length);
    const whole = (await loadTranscriptText(getTestDb(), OCR_IDS.tenantA, [OCR_IDS.descA1], Number.MAX_SAFE_INTEGER)).get(OCR_IDS.descA1)!;
    expect(whole.length).toBe(s.totalChars);
  });

  it("summarises several descriptions in one read, and none across tenants", async () => {
    const m = await transcriptSummaries(getTestDb(), OCR_IDS.tenantA, [OCR_IDS.descA1, OCR_IDS.descA2, OCR_IDS.descB1]);
    expect(m.get(OCR_IDS.descA1)?.pageCount).toBe(6);
    expect(m.has(OCR_IDS.descA2)).toBe(false);
    expect(m.has(OCR_IDS.descB1)).toBe(false);
  });

  it("pages through pages in order", async () => {
    const p = await loadTranscriptPages(getTestDb(), OCR_IDS.tenantA, OCR_IDS.descA1, { offset: 2, limit: 2 });
    expect(p.map((x) => x.seq)).toEqual([3, 4]);
  });

  it("assembles text in page order and stops reading at the cap", async () => {
    const m = await loadTranscriptText(getTestDb(), OCR_IDS.tenantA, [OCR_IDS.descA1], 250);
    const text = m.get(OCR_IDS.descA1)!;
    expect(text.startsWith("folio 1 ")).toBe(true);
    expect(text.split(PAGE_JOIN)).toHaveLength(3); // pages 1-3 start below 250 chars
    expect(text).not.toContain("arequipa");
  });

  it("finds the pages a term is on", async () => {
    const hits = await findInTranscript(getTestDb(), OCR_IDS.tenantA, OCR_IDS.descA1, '"arequipa"', 10);
    expect(hits.map((h) => h.seq)).toEqual([6]);
    expect(hits[0].snippet).toContain("arequipa");
  });

  it("retries once with the sanitised expression when FTS5 rejects the first", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const hits = await findInTranscriptWithRetry(
        getTestDb(), OCR_IDS.tenantA, OCR_IDS.descA1, { match: '"arequipa', retry: '"arequipa"' }, 10,
      );
      expect(hits.map((h) => h.seq)).toEqual([6]);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  it("does not retry an expression FTS5 accepts", async () => {
    const hits = await findInTranscriptWithRetry(
      getTestDb(), OCR_IDS.tenantA, OCR_IDS.descA1, { match: '"cedula"', retry: '"arequipa"' }, 10,
    );
    expect(hits.map((h) => h.seq)).toEqual([6]);
    const none = await findInTranscriptWithRetry(
      getTestDb(), OCR_IDS.tenantA, OCR_IDS.descA1, { match: '"lima"', retry: '"arequipa"' }, 10,
    );
    expect(none).toEqual([]);
  });

  it("gives no hits when there is no retry or the retry is rejected too", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await findInTranscriptWithRetry(
        getTestDb(), OCR_IDS.tenantA, OCR_IDS.descA1, { match: '"arequipa', retry: null }, 10,
      )).toEqual([]);
      expect(await findInTranscriptWithRetry(
        getTestDb(), OCR_IDS.tenantA, OCR_IDS.descA1, { match: '"arequipa', retry: '"real' }, 10,
      )).toEqual([]);
    } finally {
      logged.mockRestore();
    }
  });

  it("finds the first page an anchor is on, with that page's text", async () => {
    const m = await findAnchorPages(getTestDb(), OCR_IDS.tenantA, [OCR_IDS.descA1, OCR_IDS.descA2], '"real cedula"');
    expect(m.get(OCR_IDS.descA1)).toEqual({ seq: 6, text: "real cedula de arequipa" });
    expect(m.has(OCR_IDS.descA2)).toBe(false);
  });

  it("does not read another tenant's description", async () => {
    expect((await transcriptSummary(getTestDb(), OCR_IDS.tenantA, OCR_IDS.descB1)).pageCount).toBe(0);
    expect(await findInTranscript(getTestDb(), OCR_IDS.tenantA, OCR_IDS.descB1, '"arequipa"', 10)).toEqual([]);
    expect((await findAnchorPages(getTestDb(), OCR_IDS.tenantA, [OCR_IDS.descB1], '"arequipa"')).size).toBe(0);
  });

  it("refuses more than 50 ids", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    await expect(loadTranscriptText(getTestDb(), OCR_IDS.tenantA, ids, 100)).rejects.toThrow();
  });
});

// The cross-tenant keystone scans Drizzle calls and cannot see raw sql
// templates, so the page reads carry their own static guard: every raw
// statement over the page tables names the tenant in the same template.
describe("tenant keystone for raw OCR statements (static)", () => {
  const sources = import.meta.glob(
    ["../../app/lib/ocr/search.server.ts", "../../app/lib/ocr/ingest.server.ts"],
    { query: "?raw", import: "default", eager: true },
  ) as Record<string, string>;

  function templates(file: string): string[] {
    const entry = Object.entries(sources).find(([path]) => path.endsWith(file));
    expect(entry, `${file} was not loaded`).toBeDefined();
    return [...entry![1].matchAll(/sql`([^`]*)`/g)].map((m) => m[1]);
  }

  it("every page read in search.server.ts carries p.tenant_id", () => {
    const reads = templates("search.server.ts").filter((s) => s.includes("FROM ocr_pages"));
    expect(reads.length).toBeGreaterThanOrEqual(6);
    for (const s of reads) expect(s).toMatch(/p\.tenant_id =/);
  });

  it("every page statement in ingest.server.ts carries tenant_id", () => {
    const reads = templates("ingest.server.ts").filter((s) => s.includes("FROM ocr_pages"));
    expect(reads.length).toBeGreaterThanOrEqual(1);
    for (const s of reads) expect(s).toContain("tenant_id =");
  });
});

// Version: v0.8.0
