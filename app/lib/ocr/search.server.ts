/**
 * OCR page reads within one description
 *
 * This module deals with reading the OCR transcript of a description,
 * which is stored as one `ocr_pages` row per page. It serves four
 * readers: the description page, which shows how many pages a
 * transcript has and how long it is (`transcriptSummary`,
 * `transcriptSummaries`); the transcript view, which pages through the
 * pages in order (`loadTranscriptPages`) and finds the pages a term is
 * on (`findInTranscript`, and `findInTranscriptWithRetry`, which
 * retries once with the sanitised expression when FTS5 rejects the
 * compiled one, as workspace search does); and the authorities worklist, which needs a
 * bounded stretch of text (`loadTranscriptText`) and the first page a
 * name appears on (`findAnchorPages`). Searches across the whole
 * workspace are not here; they live with the other search statements in
 * `global-search.server.ts`.
 *
 * ASSEMBLY IS IN JS. A newspaper volume's transcript can be larger than
 * D1's 2 MB string limit, so no statement concatenates pages with
 * `group_concat`. Pages come back as rows and are joined here with
 * PAGE_JOIN. `loadTranscriptText` takes a character cap and, with a
 * window sum over page lengths, fetches only the pages that start below
 * it, so a short preview never reads a whole volume. The cap is applied
 * again to the joined text.
 *
 * FTS READS THAT AGGREGATE ARE MATERIALISED. SQLite rejects FTS5
 * auxiliary functions and some MATCH plans under GROUP BY. The anchor
 * read groups the matching page numbers inside a MATERIALIZED common
 * table expression and joins back to `ocr_pages` for the text.
 *
 * ID LISTS ARE CAPPED AT 50. A read over several descriptions inlines
 * their ids as bound parameters, and D1 allows 100 per statement. The
 * callers already cap what they show; these functions throw above
 * MAX_IDS so no read can grow past the limit.
 *
 * EVERY STATEMENT NAMES THE TENANT. Each one carries
 * `p.tenant_id = ${tenantId}` in the same template as
 * `FROM ocr_pages p`, and a static test checks it. A description held by
 * another tenant reads as having no transcript.
 *
 * Snippets use the same HIGHLIGHT_OPEN and HIGHLIGHT_CLOSE markers as
 * global search, so one renderer serves both.
 *
 * @version v0.8.0
 */
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { HIGHLIGHT_OPEN, HIGHLIGHT_CLOSE } from "~/lib/global-search.server";

type Db = DrizzleD1Database<any>;

export interface TranscriptSummary { pageCount: number; totalChars: number }
export interface TranscriptPage { seq: number; text: string }
export interface PageHit { seq: number; snippet: string }

/** Pages per screen in the transcript view. */
export const TRANSCRIPT_PAGE_SIZE = 20;
/** What separates two pages in an assembled transcript. */
export const PAGE_JOIN = "\n\n";
/** The most description ids one read inlines. */
export const MAX_IDS = 50;

const SNIPPET_ELLIPSIS = "…";
const SNIPPET_TOKENS = 16;

function checkIds(ids: string[]): void {
  if (ids.length > MAX_IDS) {
    throw new Error(`OCR page reads take at most ${MAX_IDS} description ids; got ${ids.length}`);
  }
}

function idList(ids: string[]): SQL {
  return sql.join(ids.map((id) => sql`${id}`), sql.raw(", "));
}

function summaryOf(pageCount: number, chars: number): TranscriptSummary {
  return { pageCount, totalChars: chars + Math.max(pageCount - 1, 0) * PAGE_JOIN.length };
}

export async function transcriptSummary(db: Db, tenantId: string, descriptionId: string): Promise<TranscriptSummary> {
  const row = await db.get<{ n: number; chars: number | null }>(sql`
    SELECT count(*) AS n, sum(length(p.text)) AS chars
    FROM ocr_pages p
    WHERE p.tenant_id = ${tenantId} AND p.description_id = ${descriptionId}
  `);
  return summaryOf(row?.n ?? 0, row?.chars ?? 0);
}

export async function transcriptSummaries(
  db: Db, tenantId: string, descriptionIds: string[],
): Promise<Map<string, TranscriptSummary>> {
  checkIds(descriptionIds);
  const out = new Map<string, TranscriptSummary>();
  if (descriptionIds.length === 0) return out;
  const rows = (await db.all(sql`
    SELECT p.description_id AS id, count(*) AS n, sum(length(p.text)) AS chars
    FROM ocr_pages p
    WHERE p.tenant_id = ${tenantId} AND p.description_id IN (${idList(descriptionIds)})
    GROUP BY p.description_id
  `)) as { id: string; n: number; chars: number | null }[];
  for (const r of rows) out.set(r.id, summaryOf(r.n, r.chars ?? 0));
  return out;
}

export async function loadTranscriptPages(
  db: Db, tenantId: string, descriptionId: string, opts: { offset: number; limit: number },
): Promise<TranscriptPage[]> {
  const rows = (await db.all(sql`
    SELECT p.page_seq AS seq, p.text AS text
    FROM ocr_pages p
    WHERE p.tenant_id = ${tenantId} AND p.description_id = ${descriptionId}
    ORDER BY p.page_seq
    LIMIT ${opts.limit} OFFSET ${opts.offset}
  `)) as { seq: number; text: string }[];
  return rows.map((r) => ({ seq: r.seq, text: r.text }));
}

/**
 * Each description's pages in order, joined by PAGE_JOIN and cut at
 * `maxCharsPerDescription`. Descriptions with no pages are absent.
 */
export async function loadTranscriptText(
  db: Db, tenantId: string, descriptionIds: string[], maxCharsPerDescription: number,
): Promise<Map<string, string>> {
  checkIds(descriptionIds);
  const out = new Map<string, string>();
  if (descriptionIds.length === 0) return out;
  const cap = Number.isFinite(maxCharsPerDescription)
    ? Math.max(0, Math.floor(maxCharsPerDescription))
    : Number.MAX_SAFE_INTEGER;
  const rows = (await db.all(sql`
    SELECT description_id, page_seq, text FROM (
      SELECT p.description_id AS description_id, p.page_seq AS page_seq, p.text AS text,
             SUM(length(p.text)) OVER (PARTITION BY p.description_id ORDER BY p.page_seq
                                       ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS before
      FROM ocr_pages p
      WHERE p.tenant_id = ${tenantId} AND p.description_id IN (${idList(descriptionIds)})
    ) WHERE COALESCE(before, 0) < ${cap}
    ORDER BY description_id, page_seq
  `)) as { description_id: string; page_seq: number; text: string }[];
  const parts = new Map<string, string[]>();
  for (const r of rows) {
    const list = parts.get(r.description_id) ?? [];
    list.push(r.text);
    parts.set(r.description_id, list);
  }
  for (const [id, list] of parts) {
    const text = list.join(PAGE_JOIN);
    out.set(id, text.length > cap ? text.slice(0, cap) : text);
  }
  return out;
}

/**
 * The pages of one description that match an already compiled FTS5
 * expression, in page order, each with a highlighted snippet. A syntax
 * error from FTS5 propagates; `findInTranscriptWithRetry` retries as
 * global search does.
 */
export async function findInTranscript(
  db: Db, tenantId: string, descriptionId: string, match: string, limit: number,
): Promise<PageHit[]> {
  const rows = (await db.all(sql`
    SELECT p.page_seq AS seq,
           snippet(f.ocr_pages_fts, 0, ${HIGHLIGHT_OPEN}, ${HIGHLIGHT_CLOSE}, ${SNIPPET_ELLIPSIS}, ${SNIPPET_TOKENS}) AS snippet
    FROM ocr_pages p INNER JOIN ocr_pages_fts f ON f.rowid = p.rowid
    WHERE p.tenant_id = ${tenantId} AND p.description_id = ${descriptionId}
      AND f.ocr_pages_fts MATCH ${match}
    ORDER BY p.page_seq
    LIMIT ${limit}
  `)) as { seq: number; snippet: string }[];
  return rows.map((r) => ({ seq: r.seq, snippet: r.snippet }));
}

/**
 * For each description, the lowest-numbered page matching an already
 * compiled FTS5 expression, with that page's text. Descriptions with no
 * matching page are absent.
 */
export async function findAnchorPages(
  db: Db, tenantId: string, descriptionIds: string[], match: string,
): Promise<Map<string, TranscriptPage>> {
  checkIds(descriptionIds);
  const out = new Map<string, TranscriptPage>();
  if (descriptionIds.length === 0) return out;
  const rows = (await db.all(sql`
    WITH hit AS MATERIALIZED (
      SELECT p.description_id AS d, min(p.page_seq) AS seq
      FROM ocr_pages p INNER JOIN ocr_pages_fts f ON f.rowid = p.rowid
      WHERE p.tenant_id = ${tenantId} AND p.description_id IN (${idList(descriptionIds)})
        AND f.ocr_pages_fts MATCH ${match}
      GROUP BY p.description_id
    )
    SELECT p.description_id AS id, p.page_seq AS seq, p.text AS text
    FROM ocr_pages p INNER JOIN hit ON hit.d = p.description_id AND hit.seq = p.page_seq
    WHERE p.tenant_id = ${tenantId}
  `)) as { id: string; seq: number; text: string }[];
  for (const r of rows) out.set(r.id, { seq: r.seq, text: r.text });
  return out;
}

/**
 * `findInTranscript` under workspace search's bad-syntax policy: the
 * compiled expression first, then, if FTS5 rejects it, once more with
 * the sanitised positives-only expression. With no retry, or a retry
 * FTS5 rejects as well, there are no hits; each failure is logged and
 * none reaches the caller.
 */
export async function findInTranscriptWithRetry(
  db: Db, tenantId: string, descriptionId: string,
  expr: { match: string; retry: string | null }, limit: number,
): Promise<PageHit[]> {
  try {
    return await findInTranscript(db, tenantId, descriptionId, expr.match, limit);
  } catch (firstError) {
    if (expr.retry === null) {
      console.error("Transcript find: match failed and nothing survived sanitising", firstError);
      return [];
    }
    console.error("Transcript find: match failed; retrying with the sanitised expression", firstError);
    try {
      return await findInTranscript(db, tenantId, descriptionId, expr.retry, limit);
    } catch (retryError) {
      console.error("Transcript find: match failed on both the compiled and the sanitised expression", retryError);
      return [];
    }
  }
}

// Version: v0.8.0
