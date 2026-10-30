/**
 * Tests — the Scanner screen, rendered
 *
 * This suite renders the Scanner page from fixed loader data, in English
 * and Spanish, and pins what a person sees in each state the loader can
 * give: no scanner yet (Not linked, the unit name field, Make token), a
 * token waiting for the
 * unit's first call, a linked scanner (Replace token and Revoke, the
 * dates), and a revoked token (when, and Make token). The device badge
 * keeps the design system's one badge shape, and the storage note is
 * there in every state. The token's just-made state lives only in the
 * page's state after an action, so it is not rendered here; the action's
 * answer is pinned in `scanner.test.ts`.
 *
 * Every value here is a test value.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { createRoutesStub } from "react-router";
import enCapture from "../../app/locales/en/capture";
import esCapture from "../../app/locales/es/capture";
import enSidebar from "../../app/locales/en/sidebar";
import esSidebar from "../../app/locales/es/sidebar";
import enCommon from "../../app/locales/en/common";
import esCommon from "../../app/locales/es/common";
import ScannerPage from "../../app/routes/_auth.admin.capture.scanner";
import type { ScannerView } from "../../app/lib/capture/scanner.server";
import { BADGE_SHAPE } from "../../app/components/workflow/status-badge";

const T0 = Date.UTC(2026, 9, 20, 12);

async function i18n(lang: "en" | "es") {
  const inst = i18next.createInstance();
  await (inst.init as (opts: unknown) => Promise<unknown>)({
    lng: lang,
    fallbackLng: "es",
    defaultNS: "common",
    resources: {
      en: { capture: enCapture, sidebar: enSidebar, common: enCommon },
      es: { capture: esCapture, sidebar: esSidebar, common: esCommon },
    },
    interpolation: { escapeValue: false },
  });
  return inst;
}

async function render(lang: "en" | "es", scanner: ScannerView | null) {
  const loaderData = { scanner, version: scanner?.version ?? "none", workspace: "Test Archive" };
  const Stub = createRoutesStub([
    {
      path: "/admin/capture/scanner",
      Component: () => React.createElement(ScannerPage as React.ComponentType<any>, { loaderData, actionData: undefined, params: {}, matches: [] }),
    },
  ]);
  return renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n: await i18n(lang) },
      React.createElement(Stub, { initialEntries: ["/admin/capture/scanner"] }),
    ),
  );
}

function view(overrides: Partial<ScannerView>): ScannerView {
  return {
    name: "rig-1",
    tokenState: "active",
    deviceState: "linked",
    tokenCreatedAt: T0 - 86_400_000,
    lastSeenAt: T0,
    revokedAt: null,
    version: "s-1:1",
    ...overrides,
  };
}

describe("Scanner, rendered", () => {
  it("with no scanner: Not linked, Never, no name yet, and Make token", async () => {
    const html = await render("en", null);
    expect(html).toContain("Digitization");
    expect(html).toContain(">Scanner</h1>");
    expect(html).toContain("The Captua unit that hands volumes over to this workspace. A workspace has one scanner.");
    expect(html).toContain(`${BADGE_SHAPE} bg-stone-100 text-stone-600">Not linked`);
    expect(html).toContain("None yet");
    expect(html).toContain("Test Archive");
    expect(html).toContain("Never");
    expect(html).toContain("This scanner has no token. It cannot call Fisqua until you make one.");
    expect(html).toContain("Unit name");
    expect(html).toContain("The unit&#x27;s short id, as it appears in its key file");
    expect(html).toMatch(/<button type="submit"[^>]*>Make token<\/button>/);
    expect(html).not.toContain("Replace token");
    expect(html).toContain("The scanner&#x27;s bucket and storage keys are set by Fisqua&#x27;s operators.");
    expect(html).not.toMatch(/hash/i);
  });

  it("waiting for the first call: the badge, and the active token's fields", async () => {
    const html = await render("en", view({ deviceState: "waiting", lastSeenAt: null }));
    expect(html).toContain("Waiting for first call");
    expect(html).toContain("rig-1");
    expect(html).toContain("Not visible");
    expect(html).toContain(">Replace token</button>");
    expect(html).toContain(">Revoke</button>");
    expect(html).not.toContain(">Make token</button>");
  });

  it("linked: the badge, Made, Last used, the replace note and the two actions", async () => {
    const html = await render("en", view({}));
    expect(html).toContain(`${BADGE_SHAPE} bg-verdigris-tint text-verdigris-deep">Linked`);
    for (const s of ["Last called Fisqua", "Made", "Last used", "Not visible"]) expect(html).toContain(s);
    expect(html).toContain("Replacing makes a new token and revokes this one. The unit&#x27;s next call with the old token is refused.");
    expect(html).not.toContain("Never");
  });

  it("revoked: the badge, when, and Make token", async () => {
    const html = await render("en", view({ tokenState: "revoked", deviceState: "revoked", revokedAt: T0 }));
    expect(html).toContain(`${BADGE_SHAPE} bg-madder-tint text-madder-deep">Revoked`);
    expect(html).toMatch(/<dt[^>]*>Revoked<\/dt><dd[^>]*>[^<]+<\/dd>/);
    expect(html).toContain("The unit&#x27;s calls are refused until it has a new token.");
    expect(html).toContain(">Make token</button>");
    expect(html).not.toContain("Replace token");
  });

  it("in Spanish", async () => {
    const none = await render("es", null);
    expect(none).toContain(">Escáner</h1>");
    expect(none).toContain("Sin vincular");
    expect(none).toContain(">Crear token</button>");
    expect(none).toContain("Nombre de la unidad");
    expect(none).toContain("Los operadores de Fisqua configuran el bucket y las claves de almacenamiento del escáner.");
    const linked = await render("es", view({}));
    expect(linked).toContain("Vinculado");
    expect(linked).toContain(">Reemplazar token</button>");
    expect(linked).toContain(">Revocar</button>");
    const revoked = await render("es", view({ tokenState: "revoked", deviceState: "revoked", revokedAt: T0 }));
    expect(revoked).toMatch(/<dt[^>]*>Revocado<\/dt>/);
    expect(revoked).toContain("La unidad no puede comunicarse con Fisqua hasta que tenga un token nuevo.");
  });
});

// @version v0.8.0
