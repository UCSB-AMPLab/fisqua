/**
 * Capture Link — Reference-Code Lookup and Description Search
 *
 * This module answers the two calls by which a Captua unit in Fisqua
 * mode finds the description a volume belongs to before an admin saves
 * a volume created or corrected by hand: the exact lookup of contract
 * 1.8, `GET /api/capture/v1/descriptions/<referenceCode>`
 * (`handleDescriptionLookup`), and the search of contract 1.10,
 * `GET /api/capture/v1/descriptions?q=<text>` (`handleDescriptionSearch`).
 * The stem must equal the reference code of a description in the
 * workspace; the search helps the admin find it, and saving still runs
 * the exact lookup.
 *
 * Like the link's other calls both run no session and no Origin check,
 * answer on the tenant's host, and are authenticated, rate-limited and
 * gated as the queue's calls are (`admit` in `queue-link.server.ts`,
 * over `authenticate` in `link.server.ts`): the unit's bearer token, 401
 * without one or with an unknown one, 403 for a revoked token or another
 * tenant's, a bare 404 for an unknown host or a workspace without the
 * digitization capability, and 429 with `Retry-After` past the shared
 * limit of calls a minute. Any method other than GET is 405, uncounted.
 *
 * Both answer a description as `{ referenceCode, title, level, dates:
 * { display, start, end } }`, built in one place (`descriptionAnswer`)
 * so the two shapes cannot drift: `level` is the description level as
 * Fisqua holds it, and the dates are mapped as the digitisation-list
 * file maps them (`contractDates`). Both reach every description of the
 * workspace, at any level, published or not.
 *
 * THE LOOKUP. A description whose reference code is exactly the one
 * asked for is 200 with its answer. Reference codes are unique within a
 * tenant (`desc_ref_code_idx`), so the lookup reads one row through that
 * index. The code is the last segment of the request's path, decoded
 * exactly once (`referenceCodeOf`), never the router's parameter, which
 * can be decoded more than once: a code holding a literal `%2F` is sent
 * as `%252F` and must not arrive as `/`. A segment that is not valid
 * percent-encoding names no code. Any other code, including one only
 * another workspace holds, is 404 with `{ rule: "unknown-reference-code" }`.
 * The rule is always in the body, because a bare 404 is what a Fisqua
 * without 1.8 answers, and the unit reads that as "cannot check" rather
 * than "no such code".
 *
 * THE SEARCH. `q` is trimmed; missing or under three characters, it is
 * 400 with `{ rule: "query-too-short" }`, after authentication, so the
 * call still counts. Otherwise the answer is 200 with `{ results }`, at
 * most `SEARCH_RESULT_LIMIT` descriptions ordered by bm25 rank and then
 * by reference code, so equal ranks come back in a stable order; an
 * empty list means no match. The rows are read through the description
 * full-text index in the same statement as the tenant predicate, under
 * the expression `searchExpression` builds, and a failure of that
 * statement is logged by its class and answered with a bare 503, so no
 * detail of the index reaches the unit.
 *
 * The expression is built only from tokens this module produces. `q`
 * is composed to NFC, so a decomposed accent stays part of its letter,
 * and cut to `MAX_QUERY_CHARACTERS`; each whitespace-separated word is
 * split on every run of characters that is neither a Unicode letter nor
 * a number, empty pieces dropped, and each token cut to
 * `MAX_TOKEN_CHARACTERS`. Only the first `MAX_QUERY_TOKENS` tokens
 * across all words are kept, so a word cut mid-way keeps its first
 * tokens and a word of thousands of tokens, `co-co-co-…`, costs eight.
 * Each word with a token becomes one phrase of its tokens joined by
 * single spaces, quoted by `quotedUnit` (the search language's own
 * quoting), followed by a star after the closing quote that makes the
 * last token a prefix, behind the fixed column filter on the reference
 * code and the title; the units are joined with AND. The expression
 * can therefore hold no FTS5 syntax from `q`: inside the quotes there
 * are only letters, digits and single spaces — no quote, NUL, star,
 * colon, caret, brace or parenthesis — and NEAR, AND, OR and NOT typed
 * by a person are words of a phrase. The index tokenizes with unicode61,
 * which also splits on hyphens and folds case and accents, so
 * `co-ahr-con` becomes the phrase `"co ahr con"*` and finds
 * `co-ahr-con-caj002`. A `q` with no token answers an empty list
 * without a read.
 *
 * @version v0.9.0
 */
import { and, eq, sql } from "drizzle-orm";
import { descriptions } from "../../db/schema";
import { quotedUnit } from "../search-query";
import type { CaptureLinkDeps } from "./link.server";
import { admit } from "./queue-link.server";
import { contractDates } from "./queue.server";

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { Allow: "GET", "Cache-Control": "no-store" } });
}

/** The rule a 404 for a code the workspace does not hold always carries. */
export const UNKNOWN_REFERENCE_CODE = "unknown-reference-code";

/** The rule a 400 for a missing or too short search query carries. */
export const QUERY_TOO_SHORT = "query-too-short";

/** The fewest characters a search query may have once trimmed. */
export const MIN_QUERY_LENGTH = 3;

/** The most characters of a search query that are read. */
export const MAX_QUERY_CHARACTERS = 256;

/** The most tokens of a search query that constrain the match. */
export const MAX_QUERY_TOKENS = 8;

/** The most characters of one token that are kept. */
export const MAX_TOKEN_CHARACTERS = 64;

/** The most descriptions one search answers. */
export const SEARCH_RESULT_LIMIT = 20;

/** The columns of a description both calls answer from. */
interface DescriptionAnswerRow {
  referenceCode: string;
  title: string;
  level: string;
  dateExpression: string | null;
  dateStart: string | null;
  dateEnd: string | null;
}

/** One description as both calls answer it. */
function descriptionAnswer(row: DescriptionAnswerRow) {
  return {
    referenceCode: row.referenceCode,
    title: row.title,
    level: row.level,
    dates: contractDates(row),
  };
}

/**
 * The reference code a request names: the last segment of its path,
 * trailing slashes aside, percent-decoded once, or null when the encoding is malformed.
 */
export function referenceCodeOf(request: Request): string | null {
  // The router accepts a trailing slash, so literal ones are dropped
  // first; an encoded `%2F` is still part of the code.
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  const raw = path.slice(path.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export async function handleDescriptionLookup(deps: CaptureLinkDeps, request: Request): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  const auth = await admit(deps, request);
  if (auth instanceof Response) return auth;

  const code = referenceCodeOf(request);
  const row =
    code === null || code === ""
      ? undefined
      : await deps.db
          .select({
            referenceCode: descriptions.referenceCode,
            title: descriptions.title,
            level: descriptions.descriptionLevel,
            dateExpression: descriptions.dateExpression,
            dateStart: descriptions.dateStart,
            dateEnd: descriptions.dateEnd,
          })
          .from(descriptions)
          .where(and(eq(descriptions.tenantId, auth.tenant.id), eq(descriptions.referenceCode, code)))
          .get();
  if (!row) return json(404, { rule: UNKNOWN_REFERENCE_CODE });
  return json(200, descriptionAnswer(row));
}

/** The index columns a search matches: the reference code and the title. */
const SEARCH_COLUMNS = "{reference_code title}";

/** A run of characters that is neither a Unicode letter nor a number: a token separator. */
const NON_TOKEN = /[^\p{L}\p{N}]+/u;

/** The first `max` code points of a string. */
function cut(text: string, max: number): string {
  return [...text].slice(0, max).join("");
}

/**
 * The FTS5 MATCH expression for a search query, or null when it holds
 * no token: each word one quoted prefix phrase of its letter and digit
 * tokens on the reference code and the title, all of them required,
 * within the character and token caps.
 */
export function searchExpression(q: string): string | null {
  const units: string[] = [];
  let left = MAX_QUERY_TOKENS;
  for (const word of cut(q.normalize("NFC").trim(), MAX_QUERY_CHARACTERS).split(/\s+/)) {
    if (left === 0) break;
    const tokens = word
      .split(NON_TOKEN)
      .filter((token) => token !== "")
      .slice(0, left)
      .map((token) => cut(token, MAX_TOKEN_CHARACTERS));
    if (tokens.length === 0) continue;
    left -= tokens.length;
    units.push(`${SEARCH_COLUMNS}: ${quotedUnit(`${tokens.join(" ")}*`)}`);
  }
  return units.length === 0 ? null : units.join(" AND ");
}

export async function handleDescriptionSearch(deps: CaptureLinkDeps, request: Request): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  const auth = await admit(deps, request);
  if (auth instanceof Response) return auth;

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if ([...q].length < MIN_QUERY_LENGTH) return json(400, { rule: QUERY_TOO_SHORT });

  const match = searchExpression(q);
  if (match === null) return json(200, { results: [] });
  let rows: DescriptionAnswerRow[];
  try {
    rows = (await deps.db.all(sql`
      SELECT d.reference_code AS referenceCode, d.title AS title, d.description_level AS level,
             d.date_expression AS dateExpression, d.date_start AS dateStart, d.date_end AS dateEnd
      FROM descriptions d JOIN descriptions_fts f ON f.rowid = d.rowid
      WHERE d.tenant_id = ${auth.tenant.id} AND f.descriptions_fts MATCH ${match}
      ORDER BY bm25(f.descriptions_fts), d.reference_code
      LIMIT ${SEARCH_RESULT_LIMIT}
    `)) as DescriptionAnswerRow[];
  } catch (err) {
    console.error(`Capture description search failed (${err instanceof Error ? err.name : "error"})`);
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return json(200, { results: rows.map(descriptionAnswer) });
}

// @version v0.9.0
