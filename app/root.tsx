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
 * @version v0.6.0
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
  // instance carries real translations. `t()` calls are wrapped
  // defensively so a translation failure still renders a plain 404 /
  // error page instead of taking the whole boundary down with it.
  let message: string;
  let details: string;
  try {
    message = t("error.generic_title");
    details = t("error.generic_detail");
  } catch {
    message = "Something went wrong";
    details = "An unexpected error occurred.";
  }
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    try {
      details =
        error.status === 404
          ? t("error.not_found")
          : error.statusText || details;
    } catch {
      details =
        error.status === 404
          ? "The requested page could not be found."
          : error.statusText || details;
    }
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
