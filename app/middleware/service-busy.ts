/**
 * Service-Busy Middleware
 *
 * This middleware runs first at the root, around every other
 * middleware, loader and action of a matched route. When D1 refuses a
 * read the request cannot do without (the tenant lookup that resolves
 * the request host, the auth middleware's reads) as overloaded, and
 * the refusal outlasts that read's retries, the error fails the request
 * and the router answers 500. The router hands that error to the app's
 * `handleError` (`app/entry.server.tsx`), which records it in
 * `d1OverloadedContext` through `noteD1Overload` when it is an
 * overload, before the response reaches this middleware. This
 * middleware replaces the response only when it is a 500 and the error
 * behind it was recorded so. Any other status passes unchanged: a page
 * that rendered after some caller absorbed a refusal (the i18next
 * middleware's read of the workspace default language), and a 503 a
 * route answered itself (the sign-in form's busy message). A 500 from
 * any other error passes unchanged too, even after an absorbed
 * refusal, since an absorbed refusal never reaches `handleError`.
 *
 * On a resource route (a route with no component, such as the `/api/`
 * routes) the router runs the middleware with an error handler that
 * rethrows, so an error from a middleware (the auth middleware's reads)
 * propagates out of `await next()` here and the router would build its
 * own 500 outside this middleware. This middleware catches such an
 * error: an overload refusal (`isD1Overloaded`, on its cause chain) gets
 * the busy answer, and any other error is rethrown unchanged. A
 * resource route's own 500, from an error its loader or action threw,
 * is a plain-text response and gets the same answer when its error was
 * an overload. That answer, `serviceBusyResourceResponse()`, is a 503
 * with `Retry-After` and `Cache-Control: no-store` whose body is
 * `{"error":"service_busy"}` under `/api/` or when the request's
 * `Accept` names JSON, and the plain-text marker otherwise. A route's
 * own 503, such as the capture pairing routes' `{"rule":"busy"}`, is
 * never replaced.
 *
 * A document request, whose 500 the router renders as HTML, gets
 * `serviceBusyResponse()`: a 503 carrying
 * `Retry-After` and a short static page. A client navigation or
 * fetcher, whose single-fetch response the router marks with an
 * `X-Remix-Response` header, gets `serviceBusyDataResponse()`: a 503
 * with the same headers and the plain-text body `SERVICE_BUSY_MARKER`
 * (`app/lib/service-busy-marker.ts`) and no `X-Remix-Response`, which
 * the client router hands to the root `ErrorBoundary` as an
 * `ErrorResponse`; the boundary shows the busy title and detail for it.
 * The busy answer is not written in the single-fetch format itself,
 * whose encoding belongs to the router and whose route-by-route results
 * would need the routes the request matched.
 *
 * Each replacement writes one JSON log line with `console.error`:
 * event `service_busy_503`, the request's method, host, path, workspace
 * slug and `cf-ray` id, the names of the reads that gave up in this
 * request, absorbed ones included, the status replaced (500, the
 * router's answer either way), and `from`: `response` when the router
 * built the 500, `thrown` when the error came out of `next()`. The
 * `d1_overload` lines of those reads carry the same `cf-ray` id.
 *
 * The page reads no tenant, user or language, and so needs neither
 * D1 nor i18next: it states both languages, Spanish first as the
 * app's fallback language, from the `common` namespace's
 * `error.busy_title` and `error.busy_detail` strings in the static
 * resource bundle. `Retry-After` is 10 seconds, the window over which
 * D1 counts the load it refuses. The response is not cached, since the
 * next request may well succeed.
 *
 * A genuinely unmatched URL runs no route middleware and so never
 * reaches this one; it reads no tenant either.
 *
 * @version v0.9.0
 */
import type { MiddlewareFunction } from "react-router";
import resources from "../locales";
import {
  d1FailedReads,
  failedOnD1Overload,
  isD1Overloaded,
  requestLogFields,
  writeLogLine,
} from "../lib/d1-overload";
import { SERVICE_BUSY_MARKER } from "../lib/service-busy-marker";

/** Seconds a client is asked to wait before trying again. */
export const SERVICE_BUSY_RETRY_AFTER_SECONDS = 10;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The static bilingual 503 page, built from the resource bundle only. */
export function serviceBusyResponse(): Response {
  const es = resources.es.common.error;
  const en = resources.en.common.error;
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Fisqua</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafaf9;color:#292524;font-family:Georgia,serif;padding:4rem 1.5rem;box-sizing:border-box}
main{max-width:28rem}
h1{font-size:1.5rem;line-height:1.25;margin:0 0 .75rem}
p{font-size:1rem;line-height:1.6;color:#57534e;margin:0}
section+section{margin-top:2.5rem}
</style>
</head>
<body>
<main>
<section lang="es"><h1>${escapeHtml(es.busy_title)}</h1><p>${escapeHtml(es.busy_detail)}</p></section>
<section lang="en"><h1>${escapeHtml(en.busy_title)}</h1><p>${escapeHtml(en.busy_detail)}</p></section>
</main>
</body>
</html>
`;
  return new Response(html, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Retry-After": String(SERVICE_BUSY_RETRY_AFTER_SECONDS),
      "Cache-Control": "no-store",
    },
  });
}

/** The busy answer to a single-fetch request: a plain 503 whose body is the marker. */
export function serviceBusyDataResponse(): Response {
  return new Response(SERVICE_BUSY_MARKER, {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": String(SERVICE_BUSY_RETRY_AFTER_SECONDS),
      "Cache-Control": "no-store",
    },
  });
}

/** Whether a resource route's busy answer should be JSON: under /api/, or asked for. */
function wantsJson(request: Request): boolean {
  if (new URL(request.url).pathname.startsWith("/api/")) return true;
  return /\bapplication\/(?:[\w.+-]+\+)?json\b/i.test(request.headers.get("Accept") ?? "");
}

/**
 * The busy answer to a resource route: a 503 with `Retry-After` and
 * `Cache-Control: no-store`, whose body is `{"error":"service_busy"}`
 * when `wantsJson`, else the plain-text marker.
 */
export function serviceBusyResourceResponse(request: Request): Response {
  const headers = {
    "Retry-After": String(SERVICE_BUSY_RETRY_AFTER_SECONDS),
    "Cache-Control": "no-store",
  };
  if (wantsJson(request)) {
    return Response.json({ error: "service_busy" }, { status: 503, headers });
  }
  return new Response(SERVICE_BUSY_MARKER, {
    status: 503,
    headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function logServiceBusy(
  request: Request,
  context: Parameters<MiddlewareFunction<Response>>[0]["context"],
  from: "thrown" | "response",
): void {
  try {
    writeLogLine("error", {
      event: "service_busy_503",
      ...requestLogFields(request),
      reads: [...d1FailedReads(context)],
      replaced_status: 500,
      from,
    });
  } catch {
    // Logging never changes what the request does.
  }
}

/**
 * Answers the busy response in place of a 500 whose error was a D1
 * overload refusal, or in place of an overload refusal thrown past
 * `next()`, and writes one `service_busy_503` log line; passes every
 * other response through and rethrows every other error unchanged.
 */
export const serviceBusyMiddleware: MiddlewareFunction<Response> = async (
  { request, context },
  next,
) => {
  let response: Response;
  try {
    response = await next();
  } catch (err) {
    // A resource route's middleware error is rethrown past this point;
    // the router would answer it with its own 500.
    if (!isD1Overloaded(err)) throw err;
    logServiceBusy(request, context, "thrown");
    return serviceBusyResourceResponse(request);
  }
  if (response.status !== 500 || !failedOnD1Overload(context)) return response;
  logServiceBusy(request, context, "response");
  if (response.headers.has("X-Remix-Response")) return serviceBusyDataResponse();
  if ((response.headers.get("Content-Type") ?? "").startsWith("text/html")) return serviceBusyResponse();
  return serviceBusyResourceResponse(request);
};

// @version v0.9.0
