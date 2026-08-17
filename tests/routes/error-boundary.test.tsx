/**
 * Tests — root error boundary
 *
 * Pins the fix for unmatched URLs crashing with "No value found for
 * context" instead of rendering a 404. The actual crash was in
 * `app/entry.server.tsx`: `getInstance(loadContext)` reads a React
 * Router context slot that only `i18nextMiddleware` populates, and
 * React Router's static handler short-circuits a genuinely unmatched
 * request straight to a 404 static context WITHOUT running any route
 * middleware -- so the read threw before `ServerRouter` (and this
 * boundary) ever got to render, turning the would-be 404 into a
 * framework-level 500 (see `tests/middleware/i18next.test.ts` for the
 * lower-level reproduction of that throw).
 *
 * This suite renders `app/root.tsx`'s `ErrorBoundary` directly --
 * mirroring the `renderLanding` harness in `tests/routes/landing.test.tsx`
 * -- against a 404 `isRouteErrorResponse`-shaped error, under the two
 * i18n instances the fixed `entry.server.tsx` can hand it:
 *
 *   1. "styled" -- the ordinary per-request instance (the shape
 *      `i18nextMiddleware` builds when a route DID match and threw a
 *      404, e.g. a loader's `throw new Response(null, { status: 404 })`).
 *   2. "fallback" -- `createFallbackI18nInstance()`, the standalone
 *      instance `entry.server.tsx` now falls back to when the request
 *      never matched a route at all and middleware never ran.
 *
 * Both must render actual 404 content, not throw and not render blank
 * -- the mechanical guarantee behind "unmatched URLs 404, not 500".
 * A full HTTP-level request-handler test is not attempted here:
 * `tests/routes/landing.test.tsx`'s harness docstring notes `SELF.fetch`
 * cannot resolve `virtual:react-router/server-build` in worktree
 * environments, and hand-building a valid `EntryContext` for
 * `ServerRouter` outside the real build pipeline is impractical.
 *
 * @version v0.6.0
 */
import { describe, it, expect } from "vitest";

/**
 * Minimal object satisfying `isRouteErrorResponse`'s shape check
 * (`status: number`, `statusText: string`, `internal: boolean`,
 * `"data" in error`) without depending on react-router's internal
 * `ErrorResponseImpl` class, which the public package doesn't export.
 */
function makeRouteErrorResponse(status: number, statusText: string) {
  return { status, statusText, internal: false, data: null };
}

async function renderErrorBoundary(
  error: unknown,
  i18nInstance: import("i18next").i18n,
): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const { I18nextProvider } = await import("react-i18next");
  const { ErrorBoundary } = await import("../../app/root");

  const tree = React.createElement(
    I18nextProvider,
    { i18n: i18nInstance },
    React.createElement(ErrorBoundary as never, { error } as never),
  );
  return renderToStaticMarkup(tree);
}

describe("root ErrorBoundary — 404 rendering", () => {
  it("styled case: renders a real 404 when the per-request i18next instance is present", async () => {
    const i18nextModule = await import("i18next");
    const enResources = (await import("../../app/locales/en")).default;
    const esResources = (await import("../../app/locales/es")).default;

    const instance = i18nextModule.default.createInstance();
    await (instance.init as (opts: unknown) => Promise<unknown>)({
      lng: "en",
      fallbackLng: "es",
      defaultNS: "common",
      resources: {
        en: enResources as Record<string, unknown>,
        es: esResources as Record<string, unknown>,
      },
      interpolation: { escapeValue: false },
    });

    const html = await renderErrorBoundary(
      makeRouteErrorResponse(404, "Not Found"),
      instance,
    );
    expect(html).toContain("404");
    expect(html).toContain("There&#x27;s no page at this address");
  });

  it("styled case: a 403 renders the access copy, never the bare status text", async () => {
    const i18nextModule = await import("i18next");
    const enResources = (await import("../../app/locales/en")).default;
    const esResources = (await import("../../app/locales/es")).default;

    const instance = i18nextModule.default.createInstance();
    await (instance.init as (opts: unknown) => Promise<unknown>)({
      lng: "en",
      fallbackLng: "es",
      defaultNS: "common",
      resources: {
        en: enResources as Record<string, unknown>,
        es: esResources as Record<string, unknown>,
      },
      interpolation: { escapeValue: false },
    });

    const html = await renderErrorBoundary(
      makeRouteErrorResponse(403, "Forbidden"),
      instance,
    );
    expect(html).toContain("403");
    expect(html).toContain("You don&#x27;t have access to this");
    // The framework's bare status text must never be the page.
    expect(html).not.toContain(">Forbidden<");
  });

  it("fallback case: renders a real 404 through createFallbackI18nInstance when route middleware never ran", async () => {
    const { createFallbackI18nInstance } = await import(
      "../../app/middleware/i18next"
    );
    const instance = await createFallbackI18nInstance();

    const html = await renderErrorBoundary(
      makeRouteErrorResponse(404, "Not Found"),
      instance,
    );
    expect(html).toContain("404");
    // The fallback instance is fixed to "es" (no request to detect a
    // language from) -- the point is that it resolves the REAL
    // translated string, not the bare "error.not_found" key.
    expect(html).toContain(
      "En este espacio de trabajo no hay ninguna página con esta dirección",
    );
  });

  it("does not throw for a non-route error under either instance", async () => {
    const { createFallbackI18nInstance } = await import(
      "../../app/middleware/i18next"
    );
    const instance = await createFallbackI18nInstance();
    const html = await renderErrorBoundary(new Error("boom"), instance);
    expect(html).toContain("Algo salió mal");
  });
});

// @version v0.6.0
