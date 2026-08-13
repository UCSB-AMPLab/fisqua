/**
 * i18next Middleware
 *
 * This middleware deals with attaching an i18next instance to every
 * request and resolving the active language via the standard
 * remix-i18next detection chain
 * (searchParams → cookie → session → header). We set
 * `searchParamKey: "lang"` so the locked `?lang=en` / `?lang=es`
 * toggle URLs on the marketing landing flip the response language;
 * the upstream default is `"lng"`, which would silently no-op the
 * landing's locked toggle markup.
 *
 * Loaders read the resolved language via `getLocale(context)`; the
 * shared instance returned by `getInstance(context)` is also
 * available for server-side `t()` calls outside React.
 *
 * @version v0.6.0
 */
import { createInstance, type i18n as I18nInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import { createI18nextMiddleware } from "remix-i18next/middleware";
import resources from "../locales";

// Shared with `createFallbackI18nInstance` below so the fallback carries
// the exact same resource bundle and interpolation rules as the
// per-request instance the middleware builds.
const i18nextConfig = {
  resources,
  defaultNS: "common",
  // React already escapes interpolated text on render; i18next's own
  // HTML-entity escaping (default `escapeValue: true`) would run first
  // and leave the entities as literal characters in the rendered
  // output (e.g. "/" -> "&#x2F;") instead of being unescaped by React.
  interpolation: { escapeValue: false },
};

export const [i18nextMiddleware, getLocale, getInstance] =
  createI18nextMiddleware({
    detection: {
      supportedLanguages: ["es", "en"],
      fallbackLanguage: "es",
      searchParamKey: "lang",
    },
    i18next: i18nextConfig,
    plugins: [initReactI18next],
  });

/**
 * Builds a standalone i18next instance that is NOT wired to any
 * request context. React Router's static handler short-circuits a
 * genuinely unmatched URL straight to a 404 static context without
 * ever running route middleware (the `!matches` branch of
 * `staticHandler.query()` in `react-router`'s core) -- so
 * `i18nextMiddleware` never runs and `getInstance(context)` has
 * nothing to read. `entry.server.tsx` falls back to this instance in
 * that case so the root `ErrorBoundary` still has a working
 * translator and can render a real 404 instead of the request
 * crashing on a missing-context throw before React ever renders
 * anything. The fixed `"es"` language mirrors the app's fallback
 * language -- there is no request-scoped detection to run here since,
 * by construction, the request never matched a route.
 */
export async function createFallbackI18nInstance(): Promise<I18nInstance> {
  const instance = createInstance(i18nextConfig);
  instance.use(initReactI18next);
  await instance.init({ lng: "es" });
  return instance;
}

// @version v0.6.0
