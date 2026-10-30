/**
 * OCR page ingest
 *
 * This module deals with loading a published volume's OCR text into the
 * catalogue. The media pipeline leaves one plain-text object per page
 * in delivery storage; when the volume is published, the publish step
 * hands this module the list of those objects, in canvas order, and
 * `ingestOcrPages` turns them into `ocr_pages` rows.
 *
 * The contract it keeps: after a successful call the description's page
 * rows are exactly the run's pages, one per canvas position, each with
 * the text of its object as stored, the object's key in `source_key`
 * and the page's ALTO key in `alto_key`. Calling it again with the same
 * run changes nothing; calling it with another run replaces the earlier
 * rows, including any pages the new run no longer has. It does not
 * decide which run is current, and it cannot: nothing in its input
 * orders runs. The publish step decides, from the volume's own state,
 * and calls this only for that run.
 *
 * WHY A STAGING TABLE. A volume can run to hundreds of pages, more text
 * than one D1 statement may carry. The pages are written first to
 * `ocr_pages_staging` under an attempt id this call mints, in as many
 * small statements as they need; then a single batch, which D1 runs as
 * one transaction, deletes the description's old pages, copies the
 * staged ones in, and clears them. Every statement in that batch is
 * guarded by one condition: the attempt's staged rows are exactly pages
 * 1..N. A reader therefore sees the old pages or the new ones, never
 * some of each, and an incomplete attempt commits nothing. Because
 * attempts never share staging rows, two overlapping calls (a retry
 * after a timeout) each commit a whole set or nothing. When the staged
 * pages equal the stored ones, the batch leaves the stored rows alone,
 * so a repeated call keeps page ids and index entries. Staging rows an
 * attempt abandoned are cleared by the next call for the same
 * description once they are older than STAGING_ABANDON_MS.
 *
 * WHAT ONE CALL COSTS. One object read per page, one staging INSERT per
 * eleven pages of ordinary size, and six further statements. A volume
 * of 734 pages is 734 reads and 73 D1 queries, inside the
 * per-invocation limits for subrequests and D1 queries. The call takes
 * the whole volume; there is no page cap.
 *
 * BACKFILLED TEXT IS REPLACED ONLY WHEN THE CALLER NAMES IT. A row with
 * no run id holds the transcript backfilled from the old `ocr_text`
 * column, and the export reads that row and no other. The row cannot
 * sit beside a run's page 1, since a description has one row per page
 * position, so a run's pages either replace it or are refused. By
 * default the call refuses: it throws `backfilled_text` before it reads
 * any object. The publish step replaces the row, having first kept its
 * text elsewhere, and says so by passing `replaceMigrated` with the
 * row's id. Only that row is replaced, and only while it is the
 * migrated shape (page 1, no source or ALTO key) and the description's
 * only row without a run id; anything else is refused the same way.
 * Every statement of the replacing batch is guarded against any other
 * row without a run id, so one written while the call was reading is
 * kept and the call throws the same error.
 *
 * NOTHING IS WRITTEN UNTIL EVERYTHING IS READ. The page list is
 * checked first (positive, unique, contiguous from 1, which is what a
 * canvas sequence is), then the description's tenant and its backfilled
 * row, then every object
 * is read. A missing object is an error: the pipeline's own checks
 * already asserted one text per page, so a gap here means storage and
 * the run report disagree, and the previous rows are kept.
 *
 * The object store is reached only through `MediaObjectReader`, which
 * the pipeline module implements over its storage adapter. Text is
 * stored as the object holds it; the pipeline writes it as NFC.
 *
 * @version v0.8.0
 */
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import * as schema from "~/db/schema";
import { descriptions, ocrPages, ocrPagesStaging } from "~/db/schema";

export interface MediaObjectReader {
  /** UTF-8 text of the object, or null if it does not exist. */
  getText(bucket: string, key: string): Promise<string | null>;
}

export interface OcrPageInput {
  seq: number;
  textKey: string;
  altoKey: string | null;
}

/** The one migrated page-1 row a call may replace, named by its id. */
export interface ReplaceMigrated {
  pageId: string;
}

export type OcrIngestErrorCode =
  | "invalid_pages" | "unknown_description" | "backfilled_text" | "missing_object" | "incomplete_staging";

export class OcrIngestError extends Error {
  constructor(public readonly code: OcrIngestErrorCode, message: string) {
    super(message);
    this.name = "OcrIngestError";
  }
}

type Db = DrizzleD1Database<typeof schema>;

export const READ_CONCURRENCY = 6;
/** D1 allows 100 bound parameters; a staging row binds 9. */
export const STAGING_ROWS_PER_STATEMENT = 11;
/** Text bytes per staging INSERT, kept below D1's 100 KB statement cap. */
export const STAGING_BYTES_PER_STATEMENT = 80_000;
/** Staging rows older than this belong to an attempt that died. */
export const STAGING_ABANDON_MS = 60 * 60 * 1000;

function checkPages(pages: OcrPageInput[]): void {
  if (pages.length === 0) throw new OcrIngestError("invalid_pages", "No pages to ingest");
  const seen = new Set<number>();
  for (const { seq } of pages) {
    if (!Number.isInteger(seq) || seq < 1 || seen.has(seq)) {
      throw new OcrIngestError("invalid_pages", `Bad or repeated page sequence ${seq}`);
    }
    seen.add(seq);
  }
  if (Math.max(...seen) !== pages.length) {
    throw new OcrIngestError("invalid_pages", `Page sequence is not 1..${pages.length}`);
  }
}

async function assertOwned(db: Db, tenantId: string, descriptionId: string): Promise<void> {
  const owner = await db
    .select({ id: descriptions.id })
    .from(descriptions)
    .where(and(eq(descriptions.id, descriptionId), eq(descriptions.tenantId, tenantId)))
    .get();
  if (!owner) {
    throw new OcrIngestError("unknown_description", `No description ${descriptionId} in this workspace`);
  }
}

function backfilledRow(tenantId: string, descriptionId: string) {
  return and(
    eq(ocrPages.tenantId, tenantId),
    eq(ocrPages.descriptionId, descriptionId),
    isNull(ocrPages.runId),
  );
}

/**
 * Throws `backfilled_text` when the description holds a row without a
 * run id that the call may not replace: any such row when `allowed` is
 * absent, and otherwise any row but the named one, or the named one when
 * it is not a bare page 1.
 */
async function assertNoBackfilled(
  db: Db,
  tenantId: string,
  descriptionId: string,
  allowed?: ReplaceMigrated,
): Promise<void> {
  const found = await db
    .select({ id: ocrPages.id, pageSeq: ocrPages.pageSeq, sourceKey: ocrPages.sourceKey, altoKey: ocrPages.altoKey })
    .from(ocrPages)
    .where(backfilledRow(tenantId, descriptionId))
    .all();
  const refused = found.some(
    (r) =>
      allowed === undefined ||
      r.id !== allowed.pageId ||
      r.pageSeq !== 1 ||
      r.sourceKey !== null ||
      r.altoKey !== null,
  );
  if (refused) {
    throw new OcrIngestError(
      "backfilled_text",
      `Description ${descriptionId} holds OCR text backfilled from the old column; it is not replaced`,
    );
  }
}

async function readAll(reader: MediaObjectReader, bucket: string, pages: OcrPageInput[]): Promise<string[]> {
  const texts: string[] = new Array(pages.length);
  let next = 0;
  async function worker() {
    while (next < pages.length) {
      const i = next++;
      const body = await reader.getText(bucket, pages[i].textKey);
      if (body === null) {
        throw new OcrIngestError("missing_object", `Missing page text ${pages[i].textKey}`);
      }
      texts[i] = body;
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, pages.length) }, worker));
  return texts;
}

/** Groups items into staging statements under the row and byte caps. */
export function planStagingChunks<T>(items: T[], size: (t: T) => number): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const b = size(item);
    if (current.length > 0 && (current.length >= STAGING_ROWS_PER_STATEMENT || bytes + b > STAGING_BYTES_PER_STATEMENT)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += b;
  }
  if (current.length > 0) out.push(current);
  return out;
}

async function commitAttempt(
  db: Db,
  a: {
    tenantId: string;
    descriptionId: string;
    runId: string;
    attemptId: string;
    pageCount: number;
    replaceMigrated?: ReplaceMigrated;
  },
): Promise<void> {
  const { tenantId, descriptionId, runId, attemptId, pageCount, replaceMigrated } = a;
  // The named migrated row, if any, is the one row without a run id the
  // batch may delete; the empty string names no row.
  const migratedId = replaceMigrated?.pageId ?? "";
  const complete = sql`(
    SELECT count(*) = ${pageCount} AND min(page_seq) = 1 AND max(page_seq) = ${pageCount}
    FROM ocr_pages_staging
    WHERE attempt_id = ${attemptId} AND run_id = ${runId}
      AND tenant_id = ${tenantId} AND description_id = ${descriptionId}
  )`;
  // True when the stored pages already are exactly the staged ones; a
  // repeat of the same input then keeps its ids, rowids and index rows.
  const unchanged = sql`(
    (SELECT count(*) FROM ocr_pages o
      WHERE o.tenant_id = ${tenantId} AND o.description_id = ${descriptionId}) = ${pageCount}
    AND (SELECT count(*) FROM ocr_pages o
      INNER JOIN ocr_pages_staging s ON s.page_seq = o.page_seq
      WHERE o.tenant_id = ${tenantId} AND o.description_id = ${descriptionId}
        AND s.attempt_id = ${attemptId} AND s.tenant_id = ${tenantId}
        AND o.run_id = s.run_id AND o.text = s.text
        AND o.source_key IS s.source_key AND o.alto_key IS s.alto_key) = ${pageCount}
  )`;
  // No statement may touch a description that holds a backfilled row
  // other than the migrated page 1 the caller named.
  const noBackfilled = sql`NOT EXISTS (
    SELECT 1 FROM ocr_pages b
    WHERE b.tenant_id = ${tenantId} AND b.description_id = ${descriptionId} AND b.run_id IS NULL
      AND NOT (b.id = ${migratedId} AND b.page_seq = 1 AND b.source_key IS NULL AND b.alto_key IS NULL)
  )`;
  const replace = sql`(${complete} AND ${noBackfilled} AND NOT ${unchanged})`;
  const now = Date.now();
  await db.batch([
    db.delete(ocrPages).where(
      and(
        eq(ocrPages.tenantId, tenantId),
        eq(ocrPages.descriptionId, descriptionId),
        or(isNotNull(ocrPages.runId), eq(ocrPages.id, migratedId)),
        replace,
      ),
    ),
    // insert().select(sql) rather than db.run(sql): a raw run with bound
    // values is not a statement the D1 driver can place in a batch. The
    // select list follows the table's column order, which Drizzle uses
    // for the INSERT column list.
    db.insert(ocrPages).select(sql`
      SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
             substr(lower(hex(randomblob(2))), 2) || '-' ||
             substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
             lower(hex(randomblob(6))),
             s.tenant_id, s.description_id, s.page_seq, s.text, s.source_key, s.alto_key, s.run_id, ${now}
      FROM ocr_pages_staging s
      WHERE s.attempt_id = ${attemptId} AND s.run_id = ${runId}
        AND s.tenant_id = ${tenantId} AND s.description_id = ${descriptionId}
        AND ${replace}
      ORDER BY s.page_seq
    `),
    db.delete(ocrPagesStaging).where(
      and(eq(ocrPagesStaging.tenantId, tenantId), eq(ocrPagesStaging.attemptId, attemptId), complete),
    ),
  ]);

  await assertNoBackfilled(db, tenantId, descriptionId, replaceMigrated);
  const check = await db.get<{ n: number; lo: number | null; hi: number | null }>(sql`
    SELECT count(*) AS n, min(page_seq) AS lo, max(page_seq) AS hi
    FROM ocr_pages
    WHERE tenant_id = ${tenantId} AND description_id = ${descriptionId} AND run_id = ${runId}
  `);
  if (!check || check.n !== pageCount || check.lo !== 1 || check.hi !== pageCount) {
    throw new OcrIngestError("incomplete_staging", `Attempt ${attemptId} did not hold pages 1..${pageCount}`);
  }
}

export async function ingestOcrPages(
  db: Db,
  reader: MediaObjectReader,
  input: {
    tenantId: string;
    descriptionId: string;
    runId: string;
    bucket: string;
    pages: OcrPageInput[];
    /** Set only by the publish step, after it has kept the row's text. */
    replaceMigrated?: ReplaceMigrated;
  },
): Promise<{ pagesWritten: number; bytesRead: number }> {
  const { tenantId, descriptionId, runId, bucket, replaceMigrated } = input;
  checkPages(input.pages);
  await assertOwned(db, tenantId, descriptionId);
  await assertNoBackfilled(db, tenantId, descriptionId, replaceMigrated);

  const ordered = [...input.pages].sort((a, b) => a.seq - b.seq);
  const texts = await readAll(reader, bucket, ordered);
  const encoder = new TextEncoder();
  const staged = ordered.map((p, i) => ({ page: p, text: texts[i], bytes: encoder.encode(texts[i]).length }));
  const bytesRead = staged.reduce((sum, r) => sum + r.bytes, 0);

  const attemptId = crypto.randomUUID();
  const now = Date.now();
  try {
    await db.delete(ocrPagesStaging).where(
      and(
        eq(ocrPagesStaging.tenantId, tenantId),
        eq(ocrPagesStaging.descriptionId, descriptionId),
        lt(ocrPagesStaging.createdAt, now - STAGING_ABANDON_MS),
      ),
    );
    for (const group of planStagingChunks(staged, (r) => r.bytes)) {
      await db.insert(ocrPagesStaging).values(
        group.map((r) => ({
          attemptId, runId, descriptionId, tenantId,
          pageSeq: r.page.seq, text: r.text, sourceKey: r.page.textKey, altoKey: r.page.altoKey, createdAt: now,
        })),
      );
    }
    await commitAttempt(db, { tenantId, descriptionId, runId, attemptId, pageCount: ordered.length, replaceMigrated });
    return { pagesWritten: ordered.length, bytesRead };
  } catch (e) {
    await db.delete(ocrPagesStaging).where(
      and(eq(ocrPagesStaging.tenantId, tenantId), eq(ocrPagesStaging.attemptId, attemptId)),
    );
    throw e;
  }
}
