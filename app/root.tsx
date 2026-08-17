/**
 * App Root
 *
 * This file deals with the outermost React Router component. It
 * renders the HTML document scaffold, hydrates the i18next instance
 * attached by the middleware, and mounts the fall-back error boundary
 * that catches uncaught errors from loaders, actions, and components --
 * including unmatched URLs, which never run route middleware and so
 * cannot assume any context (i18next included) was populated for the
 * request. See `app/entry.server.tsx` for the corresponding fallback
 * on the render side.
 *
 * @version v0.7.0
 */

import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import { useTranslation } from "react-i18next";

import type { Route } from "./+types/root";
import { i18nextMiddleware } from "./middleware/i18next";
import "./app.css";

export const middleware = [i18nextMiddleware];

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  // Spectral (serif: prose, headings, wordmark) +
  // Bricolage Grotesque (sans: chrome, buttons, labels) +
  // JetBrains Mono (mono: codes, IDs). The exact families and axes are
  // dictated by the Fisqua design-system tokens; see app.css.
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Spectral:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,600;12..96,700&family=JetBrains+Mono:wght@400;500&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const { i18n } = useTranslation();
  return (
    <html lang={i18n.language}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="icon" href="/favicon.ico" sizes="32x32" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta property="og:image" content="/og-image.png" />
        <meta property="og:title" content="Fisqua" />
        <meta property="og:site_name" content="Fisqua" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const { t } = useTranslation("common");

  // This boundary is the last line of defense for the whole render
  // tree, including requests that never matched a route -- and a
  // genuinely unmatched URL skips route middleware entirely (see
  // `app/entry.server.tsx`), so nothing here can assume the i18next
  // instance carries real translations. Every `t()` call goes through
  // this defensive wrapper so a translation failure still renders a
  // legible English page instead of taking the boundary down with it.
  const tr = (key: string, fallback: string): string => {
    try {
      const value = t(key);
      return value === key ? fallback : value;
    } catch {
      return fallback;
    }
  };

  // Copy keys on STATUS, never on statusText: guards throw bare
  // status texts ("Forbidden", "Not found") that are neither
  // translated nor written for readers, and the tenant-scoping rule
  // deliberately answers 404 for cross-tenant and nonexistent alike —
  // so the 404 copy must not imply the thing exists somewhere else.
  let status: number | null = null;
  let title = tr("error.generic_title", "Something went wrong");
  let detail = tr("error.generic_detail", "An unexpected error occurred.");
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    status = error.status;
    if (error.status === 404) {
      title = tr("error.not_found_title", "Nothing at this address");
      detail = tr(
        "error.not_found",
        "There's no page at this address in this workspace. Check the address, or go back to the workspace and carry on from there.",
      );
    } else if (error.status === 403) {
      title = tr("error.forbidden_title", "You don't have access to this");
      detail = tr(
        "error.forbidden",
        "Your role in this workspace doesn't allow this action. If you need it, ask a workspace administrator.",
      );
    } else {
      title = tr("error.server_error_title", "Something went wrong on our side");
      detail = tr(
        "error.server_error",
        "The request didn't complete. Try again — and if it keeps failing, tell a workspace administrator what you were doing and when.",
      );
    }
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    detail = error.message;
    stack = error.stack;
  }

  // Retry is only offered where retrying can help: transient server
  // failures and unknown errors. A 403 or 404 reloads to the same
  // answer, so those get the way back instead.
  const showRetry = status === null || status >= 500;

  return (
    <main className="flex min-h-svh items-center justify-center bg-stone-50 px-6 py-16">
      <div className="w-full max-w-md">
        <p className="font-serif text-15 font-semibold text-stone-400">
          Fisqua
        </p>
        {status !== null && (
          <p className="mt-8 font-mono text-13 font-medium tracking-widest text-stone-400">
            {status}
          </p>
        )}
        <h1 className="mt-2 font-serif text-2xl font-semibold leading-tight text-stone-800">
          {title}
        </h1>
        <p className="mt-3 text-15 leading-relaxed text-stone-600">{detail}</p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <a
            href="/"
            className="inline-flex h-10 items-center rounded-lg bg-indigo px-4 text-15 font-semibold text-white hover:bg-indigo-deep"
          >
            {tr("error.back_home", "Back to the workspace")}
          </a>
          {showRetry && (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex h-10 items-center rounded-lg border border-stone-300 bg-white px-4 text-15 font-semibold text-stone-700 hover:bg-stone-100"
            >
              {tr("error.try_again", "Try again")}
            </button>
          )}
        </div>
        {stack && (
          <pre className="mt-8 w-full overflow-x-auto rounded-lg bg-stone-100 p-4 text-13">
            <code>{stack}</code>
          </pre>
        )}
      </div>
    </main>
  );
}
