/**
 * Tests — i18next middleware fallback
 *
 * Pins the failure mode behind the "No value found for context" 500 on
 * unmatched URLs: React Router's static handler short-circuits a
 * genuinely unmatched request straight to a 404 static context without
 * running any route middleware, so `i18nextMiddleware` never sets the
 * per-request i18next instance and `getInstance(context)` has nothing
 * to read. `createFallbackI18nInstance` (`app/middleware/i18next.ts`)
 * is the fix `app/entry.server.tsx` falls back to in that case.
 *
 * Coverage:
 *   1. `getInstance` throws on a `RouterContextProvider` that never ran
 *      the middleware -- reproduces the actual crash mechanism.
 *   2. `createFallbackI18nInstance` builds a working instance without
 *      needing any request context, carrying the same resource bundle
 *      (a "common" namespace lookup resolves to the real translated
 *      string, not the bare key).
 *
 * @version v0.6.0
 */
import { describe, it, expect } from "vitest";
import { RouterContextProvider } from "react-router";
import { getInstance, createFallbackI18nInstance } from "../../app/middleware/i18next";

describe("i18next middleware fallback", () => {
  it("getInstance throws when the middleware never ran (unmatched-route reproduction)", () => {
    const context = new RouterContextProvider();
    expect(() => getInstance(context)).toThrow();
  });

  it("createFallbackI18nInstance builds a working instance without request context", async () => {
    const instance = await createFallbackI18nInstance();
    expect(instance.isInitialized).toBe(true);
    // Resolves against the real "es" bundle (the app's fallback
    // language) -- not the bare translation key, which is what a
    // broken or uninitialized instance would return instead.
    expect(instance.t("error.not_found", { ns: "common" })).toBe(
      "No se encontró la página solicitada.",
    );
  });
});

// @version v0.6.0
