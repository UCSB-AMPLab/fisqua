/**
 * Root Document
 *
 * The top-level layout that wraps every page in the app. It emits the
 * `<html>` document, loads the Google font families used in the app's
 * typography stack, declares the favicon and Open Graph metadata, and
 * installs the `i18next` middleware so every loader and action runs
 * inside a resolved locale context.
 *
 * The default export renders a bare `<Outlet />` because the real
 * layout chrome -- sidebar, top bar, footer -- lives in the
 * authenticated layout `_auth.tsx`. The root stays lean so public
 * routes like `/login` and the OAuth callbacks can render without
 * pulling in sidebar code.
 *
 * `ErrorBoundary` catches both route error responses and thrown
 * exceptions, surfacing a minimal error page. In development mode it
 * also dumps the stack trace so unexpected errors are visible in the
 * browser without tailing Worker logs.
 *
 * @version v0.3.0
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
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Crimson+Text:ital,wght@0,400;0,600;0,700;1,400&family=DM+Sans:wght@100..1000&display=swap",
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
  let message = t("error.generic_title");
  let details = t("error.generic_detail");
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? t("error.not_found")
        : error.statusText || details;
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
