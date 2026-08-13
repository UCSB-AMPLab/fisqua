/**
 * Tests — import run detail: step-label interpolation
 *
 * Pins the render of the in-flight step label at
 * `app/routes/_auth.admin.imports.runs.$runId.tsx` (`t("runDetail.step", {
 * step: run.currentStep })`). Workflow step names look like
 * `create-batch:3/113` (`app/workflows/import-commit.ts`), and i18next's
 * default interpolation setting HTML-escapes interpolated values
 * (`escapeValue: true`), turning `/` into the entity `&#x2F;` before React
 * ever sees the string — React's own JSX escaping does not run a second
 * pass to undo that, so the entity is what lands in the DOM as literal
 * text. The fix is `interpolation: { escapeValue: false }` on both i18next
 * bootstraps (`app/middleware/i18next.ts`, `app/entry.client.tsx`), which
 * is the correct setting for React consumers since JSX already escapes on
 * render.
 *
 * Rendering strategy mirrors `tests/routes/landing.test.tsx`'s render
 * suite: `renderToStaticMarkup` with an isolated `i18next` instance loaded
 * with the real `imports` + `common` locale bundles, wrapped in
 * `createRoutesStub` for the `<Link>`/`<Form>`/`useNavigation`/
 * `useActionData`/`useRevalidator` router context the route needs.
 *
 * @version v0.6.0
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { createRoutesStub } from "react-router";
import enImports from "../../app/locales/en/imports";
import enCommon from "../../app/locales/en/common";
import esImports from "../../app/locales/es/imports";
import esCommon from "../../app/locales/es/common";
import RunDetailRoute from "../../app/routes/_auth.admin.imports.runs.$runId";

/** A run mid-flight on a batch step whose label contains a `/`. */
function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    kind: "import",
    status: "running",
    message: "SBMAL import",
    justification: null,
    revertsRun: null,
    revertedByRun: null,
    revertedByRunId: null,
    profileName: "SBMAL DACS",
    profileVersion: 1,
    createdAt: new Date("2026-08-01T00:00:00Z").toISOString(),
    currentStep: "create-batch:3/113",
    stepsCompleted: 3,
    totalSteps: 113,
    errorMessage: null,
    uploadId: null,
    reportArtifact: null,
    recordCounts: null,
    acceptedFindings: null,
    ...overrides,
  };
}

async function makeI18n(lang: "en" | "es") {
  const inst = i18next.createInstance();
  await (inst.init as (opts: unknown) => Promise<unknown>)({
    lng: lang,
    fallbackLng: "es",
    defaultNS: "common",
    resources: {
      en: { imports: enImports, common: enCommon },
      es: { imports: esImports, common: esCommon },
    },
    // Mirrors the fixed production config (app/middleware/i18next.ts,
    // app/entry.client.tsx): without this, i18next HTML-escapes
    // interpolated values before React ever renders them.
    interpolation: { escapeValue: false },
  });
  return inst;
}

async function renderRunDetail(
  lang: "en" | "es",
  runOverrides: Record<string, unknown> = {},
): Promise<string> {
  const inst = await makeI18n(lang);
  const loaderData = { run: makeRun(runOverrides), counts: null, canRevert: false };
  const Stub = createRoutesStub([
    {
      path: "/admin/imports/runs/:runId",
      Component: () =>
        React.createElement(RunDetailRoute, {
          loaderData,
          actionData: undefined,
          params: { runId: "run-1" },
          matches: [],
        } as never),
    },
  ]);
  return renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n: inst },
      React.createElement(Stub, { initialEntries: ["/admin/imports/runs/run-1"] }),
    ),
  );
}

describe("run detail — step label interpolation", () => {
  it("renders a step label containing '/' unescaped in English", async () => {
    const html = await renderRunDetail("en");
    expect(html).toContain("Step: create-batch:3/113");
    expect(html).not.toContain("&#x2F;");
    expect(html).not.toContain("&#x2f;");
  });

  it("renders a step label containing '/' unescaped in Spanish", async () => {
    const html = await renderRunDetail("es");
    expect(html).toContain("Paso: create-batch:3/113");
    expect(html).not.toContain("&#x2F;");
  });

  it("still HTML-escapes other markup-shaped characters (React's own escaping, not bypassed)", async () => {
    // Disabling i18next's own escaping must not reopen an injection path --
    // React's JSX-level escaping is untouched and still neutralises `<`/`>`.
    const html = await renderRunDetail("en", { currentStep: "<b>create-batch</b>:3/113" });
    expect(html).not.toContain("<b>create-batch</b>");
    expect(html).toContain("&lt;b&gt;create-batch&lt;/b&gt;:3/113");
  });
});
