/**
 * Descriptions Admin — Transcript
 *
 * This page shows the OCR transcript of one description, page by page.
 * The transcript is stored as one `ocr_pages` row per page and is
 * read-only in Fisqua; this view pages through those rows
 * TRANSCRIPT_PAGE_SIZE at a time (`?p=`, 1-based) and never assembles
 * the whole text, since a newspaper volume can run to megabytes. Each
 * page's heading links to the description opened at that page
 * (`?page=<seq>`), where the image viewer shows the canvas the text was
 * read from.
 *
 * With `?q=`, the loader compiles the search box with the same parser
 * and compiler as workspace search and lists the pages the term is on,
 * each with a marked snippet, ahead of the pages themselves. A box FTS5
 * rejects (a phrase with an unbalanced quote, or a field scope the page
 * index has no column for) is retried once with the sanitised
 * expression, as workspace search does; if nothing survives sanitising
 * or the retry is rejected too, there are no hits rather than an error
 * page, and the pages still render.
 *
 * Access and tenant scope follow the description editor: an admin of
 * the request's workspace only, and a description held by another
 * workspace answers 404. Every page read names the tenant
 * (`app/lib/ocr/search.server.ts`).
 *
 * @version v0.8.0
 */

import { Link, useLoaderData } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { Marked } from "~/components/search/marked";
import type { Route } from "./+types/_auth.admin.descriptions.$id.transcript";

/** The most matching pages one find lists. */
const MAX_TRANSCRIPT_HITS = 100;

function positiveInt(raw: string | null): number {
  if (raw === null || !/^\d+$/.test(raw)) return 1;
  const n = Number(raw);
  return n >= 1 && Number.isSafeInteger(n) ? n : 1;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { requireArea } = await import("~/lib/user-access.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq } = await import("drizzle-orm");
  const { descriptions } = await import("~/db/schema");
  const { transcriptSummary, loadTranscriptPages, findInTranscriptWithRetry, TRANSCRIPT_PAGE_SIZE } =
    await import("~/lib/ocr/search.server");
  const { parseSearch, compileFtsExpression, sanitisedFallbackExpression } =
    await import("~/lib/search-query");
  const { HIGHLIGHT_OPEN, HIGHLIGHT_CLOSE } = await import("~/lib/global-search.server");

  const user = context.get(userContext);
  requireArea(user, "records");
  const tenant = context.get(tenantContext);
  // Schema-invariant guard, as in the description editor.
  if (tenant.descriptiveStandard == null) {
    throw new Error(
      "Schema invariant violation: tenant.descriptiveStandard is null",
    );
  }

  const db = drizzle(context.cloudflare.env.DB);
  const id = params.id;

  const description = await db
    .select({
      id: descriptions.id,
      referenceCode: descriptions.referenceCode,
      title: descriptions.title,
    })
    .from(descriptions)
    .where(and(eq(descriptions.tenantId, tenant.id), eq(descriptions.id, id)))
    .get();
  if (!description) {
    throw new Response("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const page = positiveInt(url.searchParams.get("p"));
  const qValues = url.searchParams.getAll("q");

  const summary = await transcriptSummary(db, tenant.id, id);
  const pages = await loadTranscriptPages(db, tenant.id, id, {
    offset: (page - 1) * TRANSCRIPT_PAGE_SIZE,
    limit: TRANSCRIPT_PAGE_SIZE,
  });

  const parsed = parseSearch(qValues);
  const match = compileFtsExpression(parsed);
  const hits =
    match === null
      ? []
      : await findInTranscriptWithRetry(
          db, tenant.id, id,
          { match, retry: sanitisedFallbackExpression(parsed) },
          MAX_TRANSCRIPT_HITS,
        );

  return {
    description,
    summary,
    pages,
    hits,
    page,
    pageCount: Math.max(1, Math.ceil(summary.pageCount / TRANSCRIPT_PAGE_SIZE)),
    q: qValues,
    markers: { open: HIGHLIGHT_OPEN, close: HIGHLIGHT_CLOSE },
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DescriptionTranscriptPage() {
  const { description, pages, hits, page, pageCount, q, markers } =
    useLoaderData<typeof loader>();
  const { t } = useTranslation("descriptions_admin");

  const base = `/admin/descriptions/${description.id}`;
  const atPage = (seq: number) => `${base}?page=${seq}`;
  const screen = (p: number) => {
    const params = new URLSearchParams();
    params.set("p", String(p));
    for (const value of q) params.append("q", value);
    return `${base}/transcript?${params.toString()}`;
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <Link to={base} className="font-sans text-sm text-indigo-deep hover:underline">
          {description.referenceCode}
        </Link>
        <h1 className="mt-1 font-serif text-2xl text-stone-900">{description.title}</h1>
      </header>

      {hits.length > 0 && (
        <ol className="mb-8 space-y-2 border-b border-stone-200 pb-6">
          {hits.map((hit) => (
            <li key={hit.seq} className="text-sm text-stone-700">
              <Link to={atPage(hit.seq)} className="mr-2 font-sans text-indigo-deep hover:underline">
                {hit.seq}
              </Link>
              <Marked text={hit.snippet} markers={markers} />
            </li>
          ))}
        </ol>
      )}

      {pages.map((p) => (
        <section key={p.seq} className="mb-6">
          <h2 className="mb-2 font-sans text-sm font-semibold text-stone-500">
            <Link to={atPage(p.seq)} className="hover:underline">
              {p.seq}
            </Link>
          </h2>
          <p className="whitespace-pre-wrap font-serif text-base text-stone-800">{p.text}</p>
        </section>
      ))}

      {pageCount > 1 && (
        <nav className="flex items-center justify-center gap-2 font-sans text-sm text-stone-500">
          {page > 1 ? (
            <Link to={screen(page - 1)} aria-label={t("prev_page")} className="rounded p-1 hover:bg-stone-100">
              <ChevronLeft className="h-4 w-4" />
            </Link>
          ) : (
            <span className="p-1 opacity-30"><ChevronLeft className="h-4 w-4" /></span>
          )}
          <span>
            {page} / {pageCount}
          </span>
          {page < pageCount ? (
            <Link to={screen(page + 1)} aria-label={t("next_page")} className="rounded p-1 hover:bg-stone-100">
              <ChevronRight className="h-4 w-4" />
            </Link>
          ) : (
            <span className="p-1 opacity-30"><ChevronRight className="h-4 w-4" /></span>
          )}
        </nav>
      )}
    </div>
  );
}

// Version: v0.8.0
