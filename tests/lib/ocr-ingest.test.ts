/**
 * Tests — OCR page ingest
 *
 * This suite covers `ingestOcrPages`, the step that turns a published
 * volume's page-text objects into page rows. Pinned here: the rows after a
 * call are exactly the run's pages, with both object keys; a repeat call
 * changes nothing, not even row ids; a later call replaces an earlier one,
 * including when it has fewer pages; a missing object or a malformed page
 * list writes nothing and leaves the previous rows in place; empty pages
 * are rows with empty text; text is stored as the object holds it; a
 * description in another tenant is refused; a description that holds a
 * page-1 row backfilled from the old column is refused before any read, and
 * that row is kept even when it is written while the call is reading, so
 * the export's text for it does not change; a call that names the migrated
 * page-1 row replaces that row and no other, and refuses a named row of
 * another shape or a second migrated row; a volume of 734 pages goes
 * through in one call, with a statement plan that stays inside D1's
 * per-invocation query limit; two overlapping calls each commit a whole
 * page set; an abandoned attempt's staging rows are cleared by a later
 * call; and a single page above 100 KB is stored through one bound
 * statement. The object store is an in-memory fake, so nothing here touches
 * the network.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, cleanDatabase, getTestDb } from "../helpers/db";
import { seedOcrFixtures, OCR_IDS } from "../helpers/ocr-fixtures";
import {
  ingestOcrPages, planStagingChunks, OcrIngestError, STAGING_ABANDON_MS,
} from "../../app/lib/ocr/ingest.server";
import type { MediaObjectReader, OcrPageInput } from "../../app/lib/ocr/ingest.server";

class FakeReader implements MediaObjectReader {
  objects = new Map<string, string>();
  reads: string[] = [];
  async getText(bucket: string, key: string) {
    this.reads.push(`${bucket}/${key}`);
    return this.objects.get(`${bucket}/${key}`) ?? null;
  }
}

/** Holds every read until `open()` is called. */
class GatedReader extends FakeReader {
  open!: () => void;
  private gate = new Promise<void>((resolve) => { this.open = resolve; });
  async getText(bucket: string, key: string) {
    await this.gate;
    return super.getText(bucket, key);
  }
}

/** A gated reader that also resolves `entered` when the first read starts. */
class WatchedReader extends GatedReader {
  private enter!: () => void;
  entered = new Promise<void>((resolve) => { this.enter = resolve; });
  async getText(bucket: string, key: string) {
    this.enter();
    return super.getText(bucket, key);
  }
}

const BUCKET = "ocr-test";

function pages(prefix: string, n: number, from = 1): OcrPageInput[] {
  return Array.from({ length: n }, (_, i) => {
    const seq = from + i;
    const stem = `p${String(seq).padStart(4, "0")}`;
    return { seq, textKey: `${prefix}/txt/${stem}.txt`, altoKey: `${prefix}/alto/${stem}.xml` };
  });
}

async function rows(descriptionId: string) {
  const { results } = await env.DB.prepare(
    "SELECT page_seq, text, source_key, alto_key, run_id FROM ocr_pages WHERE description_id = ? ORDER BY page_seq",
  ).bind(descriptionId).all<{ page_seq: number; text: string; source_key: string; alto_key: string | null; run_id: string }>();
  return results;
}

async function stagedCount(): Promise<number> {
  return (await env.DB.prepare("SELECT count(*) AS n FROM ocr_pages_staging").first<{ n: number }>())!.n;
}

let reader: FakeReader;

beforeEach(async () => {
  await applyMigrations();
  await cleanDatabase();
  await seedOcrFixtures();
  reader = new FakeReader();
});

function fill(target: FakeReader, prefix: string, n: number, word: string) {
  for (const p of pages(prefix, n)) target.objects.set(`${BUCKET}/${p.textKey}`, `${word} pagina ${p.seq}`);
}
const put = (prefix: string, n: number, word: string) => fill(reader, prefix, n, word);

const base = { tenantId: OCR_IDS.tenantA, descriptionId: OCR_IDS.descA1, bucket: BUCKET };
const oneToN = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("ingestOcrPages", () => {
  it("writes exactly the run's pages, with both object keys", async () => {
    put("r1", 3, "tributo");
    const out = await ingestOcrPages(getTestDb(), reader, { ...base, runId: "run-1", pages: pages("r1", 3) });
    expect(out.pagesWritten).toBe(3);
    expect(out.bytesRead).toBe(new TextEncoder().encode("tributo pagina 1tributo pagina 2tributo pagina 3").length);
    const r = await rows(OCR_IDS.descA1);
    expect(r.map((x) => x.page_seq)).toEqual([1, 2, 3]);
    expect(r[1]).toEqual({
      page_seq: 2, text: "tributo pagina 2", source_key: "r1/txt/p0002.txt", alto_key: "r1/alto/p0002.xml", run_id: "run-1",
    });
    expect(await stagedCount()).toBe(0);
  });

  it("stores a null ALTO key as null", async () => {
    put("r1", 1, "padron");
    await ingestOcrPages(getTestDb(), reader, {
      ...base, runId: "run-1", pages: [{ seq: 1, textKey: "r1/txt/p0001.txt", altoKey: null }],
    });
    expect((await rows(OCR_IDS.descA1))[0].alto_key).toBeNull();
  });

  it("leaves the same rows, ids and index entries when called again with the same input", async () => {
    put("r1", 2, "alcabala");
    const input = { ...base, runId: "run-1", pages: pages("r1", 2) };
    const identity = async () =>
      (await env.DB.prepare(
        "SELECT id, rowid AS r, created_at, page_seq, text, source_key, alto_key, run_id FROM ocr_pages WHERE description_id = ? ORDER BY page_seq",
      ).bind(OCR_IDS.descA1).all()).results;
    await ingestOcrPages(getTestDb(), reader, input);
    const first = await identity();
    await ingestOcrPages(getTestDb(), reader, input);
    expect(await identity()).toEqual(first);
    const hits = await env.DB.prepare(
      "SELECT f.rowid AS r FROM ocr_pages_fts f WHERE ocr_pages_fts MATCH 'alcabala' ORDER BY f.rowid",
    ).all<{ r: number }>();
    expect(hits.results.map((h) => h.r)).toEqual(first.map((row) => row.r));
    expect(await stagedCount()).toBe(0);
  });

  it("rewrites the rows when the same run's text changes", async () => {
    put("r1", 2, "almojarifazgo");
    const input = { ...base, runId: "run-1", pages: pages("r1", 2) };
    await ingestOcrPages(getTestDb(), reader, input);
    reader.objects.set(`${BUCKET}/r1/txt/p0002.txt`, "almojarifazgo corregido");
    await ingestOcrPages(getTestDb(), reader, input);
    expect((await rows(OCR_IDS.descA1))[1].text).toBe("almojarifazgo corregido");
  });

  it("replaces an earlier run, including pages the later run no longer has", async () => {
    put("r1", 4, "mita");
    await ingestOcrPages(getTestDb(), reader, { ...base, runId: "run-1", pages: pages("r1", 4) });
    put("r2", 2, "encomienda");
    await ingestOcrPages(getTestDb(), reader, { ...base, runId: "run-2", pages: pages("r2", 2) });
    const r = await rows(OCR_IDS.descA1);
    expect(r.map((x) => [x.page_seq, x.run_id])).toEqual([[1, "run-2"], [2, "run-2"]]);
    const stale = await env.DB.prepare("SELECT count(*) AS n FROM ocr_pages_fts WHERE ocr_pages_fts MATCH 'mita'").first<{ n: number }>();
    expect(stale!.n).toBe(0);
  });

  it("does not order runs: the last call wins (the publish action guards run order)", async () => {
    put("r2", 2, "posterior");
    await ingestOcrPages(getTestDb(), reader, { ...base, runId: "run-2", pages: pages("r2", 2) });
    put("r1", 3, "anterior");
    await ingestOcrPages(getTestDb(), reader, { ...base, runId: "run-1", pages: pages("r1", 3) });
    expect((await rows(OCR_IDS.descA1)).map((x) => x.run_id)).toEqual(["run-1", "run-1", "run-1"]);
  });

  it("refuses a description that holds a backfilled page-1 row, and keeps that row", async () => {
    await env.DB.prepare(
      "INSERT INTO ocr_pages (id, tenant_id, description_id, page_seq, text, created_at) VALUES ('blob', ?, ?, 1, 'texto viejo', 0)",
    ).bind(OCR_IDS.tenantA, OCR_IDS.descA1).run();
    put("r1", 2, "nuevo");
    const failure = ingestOcrPages(getTestDb(), reader, { ...base, runId: "run-1", pages: pages("r1", 2) });
    await expect(failure).rejects.toBeInstanceOf(OcrIngestError);
    await expect(failure).rejects.toMatchObject({ code: "backfilled_text" });
    const r = await rows(OCR_IDS.descA1);
    expect(r.map((x) => [x.page_seq, x.text, x.run_id])).toEqual([[1, "texto viejo", null]]);
    expect(reader.reads).toEqual([]);
    expect(await stagedCount()).toBe(0);
  });

  it("keeps a backfilled page-1 row written while the call was reading", async () => {
    const slow = new WatchedReader();
    fill(slow, "r1", 2, "nuevo");
    const call = ingestOcrPages(getTestDb(), slow, { ...base, runId: "run-1", pages: pages("r1", 2) });
    call.catch(() => {});
    await slow.entered;
    await env.DB.prepare(
      "INSERT INTO ocr_pages (id, tenant_id, description_id, page_seq, text, created_at) VALUES ('blob', ?, ?, 1, 'texto viejo', 0)",
    ).bind(OCR_IDS.tenantA, OCR_IDS.descA1).run();
    slow.open();
    await expect(call).rejects.toMatchObject({ code: "backfilled_text" });
    const r = await rows(OCR_IDS.descA1);
    expect(r.map((x) => [x.page_seq, x.text, x.run_id])).toEqual([[1, "texto viejo", null]]);
    expect(await stagedCount()).toBe(0);
  });

  it("replaces the migrated page-1 row it is told to replace, and the index with it", async () => {
    await env.DB.prepare(
      "INSERT INTO ocr_pages (id, tenant_id, description_id, page_seq, text, created_at) VALUES ('blob', ?, ?, 1, 'texto viejo', 0)",
    ).bind(OCR_IDS.tenantA, OCR_IDS.descA1).run();
    put("r1", 2, "nuevo");
    const out = await ingestOcrPages(getTestDb(), reader, {
      ...base, runId: "run-1", pages: pages("r1", 2), replaceMigrated: { pageId: "blob" },
    });
    expect(out.pagesWritten).toBe(2);
    const r = await rows(OCR_IDS.descA1);
    expect(r.map((x) => [x.page_seq, x.text, x.run_id])).toEqual([[1, "nuevo pagina 1", "run-1"], [2, "nuevo pagina 2", "run-1"]]);
    const old = await env.DB.prepare("SELECT count(*) AS n FROM ocr_pages_fts WHERE ocr_pages_fts MATCH 'viejo'").first<{ n: number }>();
    expect(old!.n).toBe(0);
    expect(await stagedCount()).toBe(0);

    // A second call with the same input finds no migrated row and changes nothing.
    await ingestOcrPages(getTestDb(), reader, {
      ...base, runId: "run-1", pages: pages("r1", 2), replaceMigrated: { pageId: "blob" },
    });
    expect((await rows(OCR_IDS.descA1)).map((x) => x.text)).toEqual(["nuevo pagina 1", "nuevo pagina 2"]);
  });

  it("refuses a migrated row it was not told to replace, or one that is not a bare page 1", async () => {
    const insert = (id: string, seq: number, sourceKey: string | null) =>
      env.DB.prepare(
        "INSERT INTO ocr_pages (id, tenant_id, description_id, page_seq, text, source_key, created_at) VALUES (?, ?, ?, ?, 'texto viejo', ?, 0)",
      ).bind(id, OCR_IDS.tenantA, OCR_IDS.descA1, seq, sourceKey).run();
    put("r1", 2, "nuevo");
    const call = (pageId: string) =>
      ingestOcrPages(getTestDb(), reader, { ...base, runId: "run-1", pages: pages("r1", 2), replaceMigrated: { pageId } });

    await insert("blob", 1, null);
    await expect(call("another")).rejects.toMatchObject({ code: "backfilled_text" });

    await env.DB.prepare("UPDATE ocr_pages SET source_key = 'legacy/key.txt' WHERE id = 'blob'").run();
    await expect(call("blob")).rejects.toMatchObject({ code: "backfilled_text" });

    await env.DB.prepare("UPDATE ocr_pages SET source_key = NULL, page_seq = 2 WHERE id = 'blob'").run();
    await expect(call("blob")).rejects.toMatchObject({ code: "backfilled_text" });

    await env.DB.prepare("UPDATE ocr_pages SET page_seq = 1 WHERE id = 'blob'").run();
    await insert("blob-2", 2, null);
    await expect(call("blob")).rejects.toMatchObject({ code: "backfilled_text" });

    expect((await rows(OCR_IDS.descA1)).map((x) => [x.page_seq, x.text, x.run_id])).toEqual([
      [1, "texto viejo", null], [2, "texto viejo", null],
    ]);
    expect(reader.reads).toEqual([]);
    expect(await stagedCount()).toBe(0);
  });

  it("keeps a second migrated row written while a replacing call was reading", async () => {
    await env.DB.prepare(
      "INSERT INTO ocr_pages (id, tenant_id, description_id, page_seq, text, created_at) VALUES ('blob', ?, ?, 1, 'texto viejo', 0)",
    ).bind(OCR_IDS.tenantA, OCR_IDS.descA1).run();
    const slow = new WatchedReader();
    fill(slow, "r1", 2, "nuevo");
    const call = ingestOcrPages(getTestDb(), slow, {
      ...base, runId: "run-1", pages: pages("r1", 2), replaceMigrated: { pageId: "blob" },
    });
    call.catch(() => {});
    await slow.entered;
    await env.DB.prepare(
      "INSERT INTO ocr_pages (id, tenant_id, description_id, page_seq, text, created_at) VALUES ('blob-2', ?, ?, 2, 'otro viejo', 0)",
    ).bind(OCR_IDS.tenantA, OCR_IDS.descA1).run();
    slow.open();
    await expect(call).rejects.toMatchObject({ code: "backfilled_text" });
    expect((await rows(OCR_IDS.descA1)).map((x) => [x.page_seq, x.text, x.run_id])).toEqual([
      [1, "texto viejo", null], [2, "otro viejo", null],
    ]);
    expect(await stagedCount()).toBe(0);
  });

  it("writes nothing and keeps the previous rows when an object is missing", async () => {
    put("r1", 2, "diezmo");
    await ingestOcrPages(getTestDb(), reader, { ...base, runId: "run-1", pages: pages("r1", 2) });
    put("r2", 3, "quinto");
    reader.objects.delete(`${BUCKET}/r2/txt/p0002.txt`);
    const failure = ingestOcrPages(getTestDb(), reader, { ...base, runId: "run-2", pages: pages("r2", 3) });
    await expect(failure).rejects.toBeInstanceOf(OcrIngestError);
    await expect(failure).rejects.toMatchObject({ code: "missing_object" });
    expect((await rows(OCR_IDS.descA1)).map((x) => x.run_id)).toEqual(["run-1", "run-1"]);
    expect(await stagedCount()).toBe(0);
  });

  it("stores an empty page as a row with empty text", async () => {
    put("r1", 2, "censo");
    reader.objects.set(`${BUCKET}/r1/txt/p0002.txt`, "");
    await ingestOcrPages(getTestDb(), reader, { ...base, runId: "run-1", pages: pages("r1", 2) });
    expect((await rows(OCR_IDS.descA1))[1].text).toBe("");
  });

  it("stores the object body unchanged and counts the bytes it read", async () => {
    const decomposed = "Bogotá"; // not NFC; stored as the object holds it
    reader.objects.set(`${BUCKET}/r1/txt/p0001.txt`, decomposed);
    const out = await ingestOcrPages(getTestDb(), reader, { ...base, runId: "run-1", pages: pages("r1", 1) });
    expect((await rows(OCR_IDS.descA1))[0].text).toBe(decomposed);
    expect(out.bytesRead).toBe(new TextEncoder().encode(decomposed).length);
  });

  it.each([
    ["duplicate", [{ seq: 1, textKey: "a", altoKey: null }, { seq: 1, textKey: "b", altoKey: null }]],
    ["gap", [{ seq: 1, textKey: "a", altoKey: null }, { seq: 3, textKey: "b", altoKey: null }]],
    ["zero", [{ seq: 0, textKey: "a", altoKey: null }]],
    ["empty list", []],
  ])("refuses a %s page list before reading anything", async (_label, list) => {
    await expect(
      ingestOcrPages(getTestDb(), reader, { ...base, runId: "run-1", pages: list as OcrPageInput[] }),
    ).rejects.toMatchObject({ code: "invalid_pages" });
    expect(reader.reads).toEqual([]);
  });

  it("refuses a description that belongs to another tenant", async () => {
    put("r1", 1, "x");
    await expect(
      ingestOcrPages(getTestDb(), reader, { ...base, descriptionId: OCR_IDS.descB1, runId: "run-1", pages: pages("r1", 1) }),
    ).rejects.toMatchObject({ code: "unknown_description" });
  });

  it("writes a 734-page volume in one call", async () => {
    for (const p of pages("big", 734)) reader.objects.set(`${BUCKET}/${p.textKey}`, "x ".repeat(1_500));
    const out = await ingestOcrPages(getTestDb(), reader, {
      ...base, descriptionId: OCR_IDS.descA2, runId: "run-big", pages: pages("big", 734),
    });
    expect(out.pagesWritten).toBe(734);
    expect((await rows(OCR_IDS.descA2)).map((x) => x.page_seq)).toEqual(oneToN(734));
    expect(reader.reads).toHaveLength(734);
    expect(await stagedCount()).toBe(0);
  });

  it("plans staging statements within D1's per-statement and per-invocation limits", () => {
    const threeKb = (n: number) => Array.from({ length: n }, () => 3_000);
    expect(planStagingChunks(threeKb(734), (b) => b)).toHaveLength(67);
    expect(planStagingChunks(threeKb(2_000), (b) => b)).toHaveLength(182);
    expect(planStagingChunks([50_000, 50_000, 50_000], (b) => b)).toHaveLength(3);
    for (const group of planStagingChunks(threeKb(734), (b) => b)) {
      expect(group.length).toBeLessThanOrEqual(11);
      expect(group.reduce((s, b) => s + b, 0)).toBeLessThanOrEqual(80_000);
    }
  });

  it("two overlapping calls for the same run each commit a whole page set", async () => {
    const slow = new GatedReader();
    fill(slow, "v", 20, "cedula");
    put("v", 20, "cedula");
    const input = { ...base, runId: "run-1", pages: pages("v", 20) };
    const first = ingestOcrPages(getTestDb(), slow, input);   // started first, held at its reads
    await ingestOcrPages(getTestDb(), reader, input);        // starts second, commits first
    expect((await rows(OCR_IDS.descA1)).map((x) => x.page_seq)).toEqual(oneToN(20));
    slow.open();
    await first;                                             // commits last
    expect((await rows(OCR_IDS.descA1)).map((x) => x.page_seq)).toEqual(oneToN(20));
    expect(await stagedCount()).toBe(0);
  });

  it("clears an abandoned attempt's rows for the same description, and only those", async () => {
    const old = Date.now() - STAGING_ABANDON_MS - 1;
    const insert = "INSERT INTO ocr_pages_staging (attempt_id, run_id, description_id, page_seq, tenant_id, text, created_at) VALUES (?, 'run-0', ?, 1, ?, 'resto', ?)";
    await env.DB.prepare(insert).bind("att-dead", OCR_IDS.descA1, OCR_IDS.tenantA, old).run();
    await env.DB.prepare(insert).bind("att-live", OCR_IDS.descA1, OCR_IDS.tenantA, Date.now()).run();
    await env.DB.prepare(insert).bind("att-other", OCR_IDS.descA2, OCR_IDS.tenantA, old).run();
    put("r1", 1, "acta");
    await ingestOcrPages(getTestDb(), reader, { ...base, runId: "run-1", pages: pages("r1", 1) });
    const { results } = await env.DB.prepare("SELECT attempt_id FROM ocr_pages_staging ORDER BY attempt_id").all<{ attempt_id: string }>();
    expect(results.map((r) => r.attempt_id)).toEqual(["att-live", "att-other"]);
  });

  it("stores one page larger than 100 KB", async () => {
    reader.objects.set(`${BUCKET}/r1/txt/p0001.txt`, "y ".repeat(75_000));
    await ingestOcrPages(getTestDb(), reader, { ...base, runId: "run-1", pages: pages("r1", 1) });
    expect((await rows(OCR_IDS.descA1))[0].text.length).toBe(150_000);
  });
});
