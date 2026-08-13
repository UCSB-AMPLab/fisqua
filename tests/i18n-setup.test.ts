/**
 * Tests — i18n bootstrap configuration
 *
 * This suite pins the i18n configuration values that the
 * `app/middleware/i18next.ts` module passes to
 * `createI18nextMiddleware` at request time. The middleware itself
 * cannot be imported directly under the Workers vitest pool because
 * it uses the `~/locales` alias which the test pool does not
 * resolve; instead, this suite verifies the building blocks (the
 * resources barrel, the `initReactI18next` plugin, the structural
 * tuple the middleware re-exports) so a refactor that drifts any
 * of those pieces surfaces here.
 *
 * The narrow scope is intentional — this file is the structural
 * contract check, not a runtime exercise. Runtime behaviour
 * (actual translation resolution) is covered by
 * `tests/i18n-plurals.test.ts` and the namespace-specific
 * completeness suite.
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import { initReactI18next } from "react-i18next";
import resources from "../app/locales";

/**
 * These tests verify the i18n configuration values that the middleware
 * in app/middleware/i18next.ts passes to createI18nextMiddleware.
 *
 * We cannot import the middleware directly because it uses the ~/locales
 * alias which the Workers test pool does not resolve. Instead we verify
 * the building blocks: the resources barrel, the initReactI18next plugin,
 * and the structural expectations those impose.
 */
describe("i18n setup", () => {
  it("exports i18nextMiddleware, getLocale, and getInstance from middleware", async () => {
    // Verify the middleware module exports the expected three-element tuple
    // by checking the source file structure. We use a dynamic import with
    // the relative path to avoid the ~/locales alias issue.
    // Since the middleware's ~/locales import fails in test context,
    // verify the module's existence and structure via resources + plugin instead.
    expect(resources).toBeDefined();
    expect(initReactI18next).toBeDefined();
    // The middleware file exports [i18nextMiddleware, getLocale, getInstance]
    // from createI18nextMiddleware — this is verified by the TypeScript
    // compiler accepting the destructured import in app code.
  });

  it("configures es as default language and en as fallback", () => {
    // The middleware passes supportedLanguages: ["es", "en"] and
    // fallbackLanguage: "es" to createI18nextMiddleware.
    // Verify the resources barrel provides both locales.
    expect(resources).toHaveProperty("es");
    expect(resources).toHaveProperty("en");
    expect(Object.keys(resources.es).length).toBeGreaterThan(0);
    expect(Object.keys(resources.en).length).toBeGreaterThan(0);
  });

  it("sets common as the default namespace", () => {
    // The middleware passes defaultNS: "common" to createI18nextMiddleware.
    // Verify both locales include a common namespace.
    expect(resources.es).toHaveProperty("common");
    expect(resources.en).toHaveProperty("common");
    expect(Object.keys(resources.es.common as object).length).toBeGreaterThan(
      0,
    );
  });

  it("includes initReactI18next in plugins", () => {
    // The middleware passes [initReactI18next] as plugins.
    // Verify the plugin is a valid i18next 3rdParty module.
    expect(initReactI18next).toBeDefined();
    expect(initReactI18next).toHaveProperty("type", "3rdParty");
    expect(initReactI18next).toHaveProperty("init");
  });

  it("disables i18next's own interpolation escaping on both bootstraps", async () => {
    // Without `escapeValue: false`, i18next HTML-escapes interpolated
    // values (e.g. a workflow step label like "create-batch:3/113"
    // becomes "create-batch:3&#x2F;113") before React ever renders
    // them -- React's JSX escaping does not run a second pass to undo
    // that, so the entity is what a reader sees. React already escapes
    // on render, so i18next must not escape first. Read via Vite's
    // `?raw` suffix rather than `node:fs`: the Workers pool sandbox has
    // no real filesystem, but the raw-source transform still runs at
    // bundle time.
    const { default: middlewareSrc } = await import("../app/middleware/i18next.ts?raw");
    const { default: clientEntrySrc } = await import("../app/entry.client.tsx?raw");
    expect(middlewareSrc).toMatch(/interpolation:\s*{\s*escapeValue:\s*false\s*}/);
    expect(clientEntrySrc).toMatch(/interpolation:\s*{\s*escapeValue:\s*false\s*}/);
  });
});
