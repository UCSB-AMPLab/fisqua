/**
 * Tests — description transcript line
 *
 * This suite pins the read-only transcript line on the description
 * detail page (`app/components/descriptions/transcript-line.tsx`). The
 * line names how many OCR pages the description holds and links to the
 * transcript route (`/admin/descriptions/:id/transcript`). A
 * description with no OCR pages renders nothing at all, so a record
 * without a transcript carries no empty row.
 *
 * Rendering follows `tests/imports/run-detail-step-label.test.tsx`:
 * `renderToStaticMarkup` with an isolated i18next instance loaded with
 * the real `descriptions_admin` bundles, inside `createRoutesStub` for
 * the router context `<Link>` needs. Both languages are rendered so the
 * `_one` / `_other` plural forms are exercised as the app resolves them.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { createRoutesStub } from "react-router";
import enDescriptions from "../../app/locales/en/descriptions";
import esDescriptions from "../../app/locales/es/descriptions";
import { TranscriptLine } from "../../app/components/descriptions/transcript-line";

async function render(lang: "en" | "es", pageCount: number): Promise<string> {
  const inst = i18next.createInstance();
  await (inst.init as (opts: unknown) => Promise<unknown>)({
    lng: lang,
    fallbackLng: "es",
    defaultNS: "descriptions_admin",
    resources: {
      en: { descriptions_admin: enDescriptions },
      es: { descriptions_admin: esDescriptions },
    },
    interpolation: { escapeValue: false },
  });
  const Stub = createRoutesStub([
    {
      path: "/admin/descriptions/:id",
      Component: () =>
        React.createElement(TranscriptLine, { descriptionId: "desc-1", pageCount }),
    },
  ]);
  return renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n: inst },
      React.createElement(Stub, { initialEntries: ["/admin/descriptions/desc-1"] }),
    ),
  );
}

describe("TranscriptLine", () => {
  it("shows the label, a plural page count and the link in English", async () => {
    const html = await render("en", 12);
    expect(html).toContain("Transcript");
    expect(html).toContain("12 pages");
    expect(html).toContain('href="/admin/descriptions/desc-1/transcript"');
    expect(html).toContain("View transcript");
  });

  it("uses the singular form for one page in English", async () => {
    const html = await render("en", 1);
    expect(html).toContain("1 page");
    expect(html).not.toContain("1 pages");
  });

  it("shows the label, a plural page count and the link in Spanish", async () => {
    const html = await render("es", 3);
    expect(html).toContain("Transcripción");
    expect(html).toContain("3 páginas");
    expect(html).toContain('href="/admin/descriptions/desc-1/transcript"');
    expect(html).toContain("Ver transcripción");
  });

  it("uses the singular form for one page in Spanish", async () => {
    const html = await render("es", 1);
    expect(html).toContain("1 página");
    expect(html).not.toContain("1 páginas");
  });

  it("renders nothing when the description has no transcript pages", async () => {
    expect(await render("en", 0)).toBe("");
    expect(await render("es", 0)).toBe("");
  });
});
