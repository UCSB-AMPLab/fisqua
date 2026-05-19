/**
 * Client Entry Point
 *
 * This file deals with the browser-side React Router bootstrap. It
 * initialises an i18next instance on the client — wiring the browser
 * language detector against the `htmlTag` lang attribute the server
 * rendered, loading the same locale bundles the server middleware
 * uses, and registering `react-i18next` — then hands the rendered
 * shell to `hydrateRoot` so React can take over the SSR markup
 * without a full re-render. The `htmlTag`-only detector chain (no
 * cookie or localStorage fallback) keeps the client's resolved
 * language locked to whatever the server picked, which is the source
 * of truth.
 *
 * @version v0.3.0
 */
import i18next from "i18next";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { HydratedRouter } from "react-router/dom";
import I18nextBrowserLanguageDetector from "i18next-browser-languagedetector";
import resources from "~/locales";

async function main() {
  await i18next
    .use(initReactI18next)
    .use(I18nextBrowserLanguageDetector)
    .init({
      resources,
      fallbackLng: "es",
      defaultNS: "common",
      detection: {
        order: ["htmlTag"],
        caches: [],
      },
    });

  startTransition(() => {
    hydrateRoot(
      document,
      <I18nextProvider i18n={i18next}>
        <StrictMode>
          <HydratedRouter />
        </StrictMode>
      </I18nextProvider>
    );
  });
}

main().catch(console.error);
