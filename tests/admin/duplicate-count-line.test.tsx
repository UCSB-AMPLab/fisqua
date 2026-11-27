/**
 * Tests — the duplicates worklist's count line, for one pair and for two
 *
 * This suite pins the count line of the duplicates worklist, for one pair
 * and for several. `DuplicateCountLine` gives the number of candidate
 * pairs and the words for it: for one pair, "candidate pair" ("par
 * candidato"), with no sorting note, since one pair has no order; for
 * several, "candidate pairs · sorted by match strength" ("pares candidatos
 * · ordenados de mayor a menor coincidencia"). The line is rendered with
 * `renderToStaticMarkup` under an i18next instance over the app's own
 * resource bundles, in English and in Spanish.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../app/locales/en";
import es from "../../app/locales/es";
import { DuplicateCountLine } from "../../app/routes/_auth.admin.decisions.duplicates";

async function renderLine(lng: "en" | "es", totalPairs: number): Promise<string> {
  const i18n = createInstance();
  await i18n.init({
    lng,
    fallbackLng: "es",
    defaultNS: "common",
    resources: { en: en as Record<string, any>, es: es as Record<string, any> },
  });
  const html = renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n },
      React.createElement(DuplicateCountLine, { totalPairs, truncated: false, shown: totalPairs }),
    ),
  );
  return html.replace(/<[^>]+>/g, "");
}

describe("DuplicateCountLine", () => {
  it.each([
    ["en", 1, "1 candidate pair"],
    ["en", 2, "2 candidate pairs · sorted by match strength"],
    ["es", 1, "1 par candidato"],
    ["es", 2, "2 pares candidatos · ordenados de mayor a menor coincidencia"],
  ] as const)("reads %s with %i pairs", async (lng, totalPairs, expected) => {
    expect(await renderLine(lng, totalPairs)).toBe(expected);
  });
});

// @version v0.9.0
