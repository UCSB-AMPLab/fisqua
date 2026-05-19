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
 * @version v0.4.0
 */
import { initReactI18next } from "react-i18next";
import { createI18nextMiddleware } from "remix-i18next/middleware";
import resources from "../locales";

export const [i18nextMiddleware, getLocale, getInstance] =
  createI18nextMiddleware({
    detection: {
      supportedLanguages: ["es", "en"],
      fallbackLanguage: "es",
      searchParamKey: "lang",
    },
    i18next: {
      resources,
      defaultNS: "common",
    },
    plugins: [initReactI18next],
  });

// @version v0.4.0
