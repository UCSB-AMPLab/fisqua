/**
 * Server Entry Point
 *
 * This file deals with the SSR entry hook React Router calls on every
 * request after the middleware chain has run. It pulls the
 * request-scoped i18next instance off the load context (attached by
 * `i18nextMiddleware`), wraps the `<ServerRouter>` tree in
 * `<I18nextProvider>` so loaders, components, and `t()` calls all
 * resolve against the same language, and streams the result through
 * `renderToReadableStream`. For bots and SPA-mode renders the stream
 * is awaited to completion before the response is returned, which
 * ensures crawlers see the fully rendered page instead of an early
 * shell.
 *
 * A genuinely unmatched URL never runs `i18nextMiddleware` at all --
 * React Router's static handler short-circuits straight to a 404
 * static context, skipping the middleware pipeline entirely -- so
 * `getInstance(loadContext)` has no context value to read and throws.
 * Left unguarded that throw happens while building this function's own
 * JSX, before `ServerRouter` (and therefore `root.tsx`'s
 * `ErrorBoundary`) ever gets to render, turning a would-be 404 into a
 * framework-level 500. The try/catch below falls back to a standalone
 * instance so rendering can proceed and the boundary can do its job.
 *
 * `handleError` receives every error the router's error handling
 * catches from a middleware, loader or action, before the response
 * reaches the root middleware. It logs the error as React Router's
 * default handler does, and records a D1 overload refusal in the
 * request context (`noteD1Overload`), so `serviceBusyMiddleware` answers
 * that request's 500 with the busy page. An overload a caller caught
 * and absorbed never reaches it.
 *
 * @version v0.9.0
 */
import type { EntryContext } from "react-router";
import type { RouterContextProvider } from "react-router";
import { ServerRouter, isRouteErrorResponse, type HandleErrorFunction } from "react-router";
import { noteD1Overload } from "./lib/d1-overload";
import { I18nextProvider } from "react-i18next";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import { getInstance, createFallbackI18nInstance } from "./middleware/i18next";

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider
) {
  let shellRendered = false;
  const userAgent = request.headers.get("user-agent");

  let i18nInstance;
  try {
    i18nInstance = getInstance(loadContext);
  } catch {
    i18nInstance = await createFallbackI18nInstance();
  }

  const body = await renderToReadableStream(
    <I18nextProvider i18n={i18nInstance}>
      <ServerRouter context={routerContext} url={request.url} />
    </I18nextProvider>,
    {
      onError(error: unknown) {
        responseStatusCode = 500;
        // Log streaming rendering errors from inside the shell.  Don't log
        // errors encountered during initial shell rendering since they'll
        // reject and get logged in handleDocumentRequest.
        if (shellRendered) {
          console.error(error);
        }
      },
    }
  );
  shellRendered = true;

  // Ensure requests from bots and SPA Mode renders wait for all content to load before responding
  // https://react.dev/reference/react-dom/server/renderToPipeableStream#waiting-for-all-content-to-load-for-crawlers-and-static-generation
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}

/**
 * Receives every error the router's error handling catches from a
 * middleware, loader or action. It logs as React Router's default does,
 * and records a D1 overload refusal for `serviceBusyMiddleware`.
 */
export const handleError: HandleErrorFunction = (error, { request, context }) => {
  noteD1Overload(context, error);
  if (!request.signal.aborted) {
    console.error(
      isRouteErrorResponse(error) && (error as { error?: unknown }).error
        ? (error as { error?: unknown }).error
        : error,
    );
  }
};

// @version v0.9.0
