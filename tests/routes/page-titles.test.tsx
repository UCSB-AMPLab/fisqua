/**
 * Tests — page titles
 *
 * This suite pins the browser-tab title of every Fisqua page. Four
 * checks:
 *
 * 1. Every route module with a default export exports `meta`, except
 *    the layouts in `LAYOUTS`, which only wrap an `Outlet` and add no
 *    heading of their own. It reads the route sources as text, so a
 *    new page without a title fails here before it reaches a tab that
 *    shows a bare URL.
 * 2. Every literal `heading("namespace:key")` reference in a route
 *    resolves in both Spanish and English. `label()` falls back to
 *    the key's last segment for a miss, so a mistyped key would
 *    otherwise ship as a lowercase word in the tab.
 * 3. `meta()` on real routes returns the expected title in each
 *    language: a fixed heading, a record's name before its section, a
 *    project page under its project's name, and the login and
 *    wrong-workspace pages that carry `lang` in their own loader data.
 * 4. The root error boundary renders a `<title>` with the status and
 *    the error heading.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";

import { lookup, pageTitle } from "../../app/lib/page-title";

const routeSources = import.meta.glob("../../app/routes/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Layouts that render only chrome around an `Outlet`; every page
// beneath them sets its own title.
const LAYOUTS = new Set([
  "_auth.tsx",
  "_operator.tsx",
  "_auth.admin.cataloguing.tsx",
  "_auth.admin.vocabularies.tsx",
]);

const fileName = (path: string) => path.split("/").pop() as string;

describe("every page route exports meta", () => {
  const pages = Object.entries(routeSources).filter(([path, src]) =>
    /^export default /m.test(src) && !LAYOUTS.has(fileName(path)),
  );

  it("finds the page routes", () => {
    expect(pages.length).toBeGreaterThan(60);
  });

  it.each(pages.map(([path]) => fileName(path)))("%s", (name) => {
    const src = routeSources[`../../app/routes/${name}`];
    expect(src).toMatch(/^export (function|const) meta\b/m);
  });

  it("keeps the layout allowlist to files that exist and render no page of their own", () => {
    for (const name of LAYOUTS) {
      const src = routeSources[`../../app/routes/${name}`];
      expect(src, name).toBeDefined();
      expect(src, name).not.toMatch(/^export (function|const) meta\b/m);
    }
  });
});

describe("heading references resolve", () => {
  const refs = new Set<string>();
  for (const src of Object.values(routeSources)) {
    for (const match of src.matchAll(/\bheading\("([a-z_]+:[^"]+)"\)/g)) {
      refs.add(match[1]);
    }
  }

  it("finds the references", () => {
    expect(refs.size).toBeGreaterThan(40);
  });

  it.each([...refs].sort())("%s", (ref) => {
    expect(lookup("en", ref), `en ${ref}`).toBeTruthy();
    expect(lookup("es", ref), `es ${ref}`).toBeTruthy();
  });
});

const rootMatch = (lang: "en" | "es") => [{ id: "root", data: { lang } }];

describe("meta() titles", () => {
  it("joins parts most specific first and ends with the product name", () => {
    expect(pageTitle("Tomo 006", "Descripciones")).toBe(
      "Tomo 006 | Descripciones | Fisqua",
    );
    expect(pageTitle(null, "", "Entities")).toBe("Entities | Fisqua");
    expect(pageTitle()).toBe("Fisqua");
  });

  it("titles a fixed-heading page in the language of the root loader", async () => {
    const { meta } = await import("../../app/routes/_auth.admin.capture.retakes");
    const args = (lang: "en" | "es") =>
      ({ data: undefined, matches: rootMatch(lang) }) as never;
    expect(meta(args("en"))).toEqual([{ title: "Retakes | Fisqua" }]);
    expect(meta(args("es"))).toEqual([{ title: "Capturas por repetir | Fisqua" }]);
  });

  it("puts a record's title before its section", async () => {
    const { meta } = await import("../../app/routes/_auth.admin.descriptions.$id");
    const args = (lang: "en" | "es") =>
      ({
        data: { description: { title: "Tomo 006" } },
        matches: rootMatch(lang),
      }) as never;
    expect(meta(args("es"))).toEqual([
      { title: "Tomo 006 | Descripciones | Fisqua" },
    ]);
    expect(meta(args("en"))).toEqual([
      { title: "Tomo 006 | Descriptions | Fisqua" },
    ]);
  });

  it("titles a handlist by its name, and a locked one by the section", async () => {
    const { meta } = await import("../../app/routes/_auth.handlists.$id");
    const matches = rootMatch("es");
    expect(
      meta({
        data: { locked: false, handlist: { name: "Para revisar" } },
        matches,
      } as never),
    ).toEqual([{ title: "Para revisar | Listas de trabajo | Fisqua" }]);
    expect(
      meta({ data: { locked: true, reason: "authorities-admin-only" }, matches } as never),
    ).toEqual([{ title: "Listas de trabajo | Fisqua" }]);
  });

  it("titles a project page under its project's name", async () => {
    const { meta } = await import("../../app/routes/_auth.projects.$id.members");
    const matches = [
      ...rootMatch("en"),
      { id: "routes/_auth.projects.$id", data: { project: { name: "Notaría Primera" } } },
    ];
    expect(meta({ data: undefined, matches } as never)).toEqual([
      { title: "Users | Notaría Primera | Fisqua" },
    ]);
  });

  it("titles the login and wrong-workspace pages from their own loader data", async () => {
    const login = await import("../../app/routes/login");
    const wrong = await import("../../app/routes/wrong-workspace");
    expect(login.meta({ data: { lang: "es" }, matches: [] } as never)).toEqual([
      { title: "Iniciar sesión | Fisqua" },
    ]);
    expect(login.meta({ data: { lang: "en" }, matches: [] } as never)).toEqual([
      { title: "Sign in | Fisqua" },
    ]);
    expect(wrong.meta({ data: { lang: "es" }, matches: [] } as never)).toEqual([
      { title: "Espacio de trabajo equivocado | Fisqua" },
    ]);
  });

  it("falls back to English when no loader supplied a language", async () => {
    const { meta } = await import("../../app/routes/_auth.admin.entities");
    expect(meta({ data: undefined, matches: [] } as never)).toEqual([
      { title: "Entities | Fisqua" },
    ]);
  });
});

describe("root error boundary title", () => {
  it("renders the status and the error heading in the tab title", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const React = await import("react");
    const { I18nextProvider } = await import("react-i18next");
    const i18next = (await import("i18next")).default;
    const en = (await import("../../app/locales/en")).default;
    const es = (await import("../../app/locales/es")).default;
    const { ErrorBoundary } = await import("../../app/root");

    const instance = i18next.createInstance();
    await (instance.init as (opts: unknown) => Promise<unknown>)({
      lng: "es",
      fallbackLng: "es",
      defaultNS: "common",
      resources: { en, es },
      interpolation: { escapeValue: false },
    });
    const html = renderToStaticMarkup(
      React.createElement(
        I18nextProvider,
        { i18n: instance },
        React.createElement(ErrorBoundary as never, {
          error: { status: 404, statusText: "Not Found", internal: false, data: null },
        } as never),
      ),
    );
    expect(html).toContain("<title>404 No hay nada en esta dirección | Fisqua</title>");
  });
});

// @version v0.9.0
