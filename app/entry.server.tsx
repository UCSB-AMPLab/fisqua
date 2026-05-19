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
 * @version v0.3.0
 */
import type { EntryContext } from "react-router";
import type { RouterContextProvider } from "react-router";
import { ServerRouter } from "react-router";
import { I18nextProvider } from "react-i18next";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import { getInstance } from "./middleware/i18next";

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider
) {
  let shellRendered = false;
  const userAgent = request.headers.get("user-agent");

  const body = await renderToReadableStream(
    <I18nextProvider i18n={getInstance(loadContext)}>
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
