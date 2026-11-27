/**
 * Tests — the operator's tenant page, rendered
 *
 * This suite renders the operator's tenant page from fixed loader data,
 * in English and Spanish, and pins the notice about erased scanner keys:
 * while the tenant's stored keys are erased, the page gives the time of
 * the erasure and the names of the two B2 keys an operator must revoke
 * in Backblaze B2; while they are usable or none were stored, the page
 * says nothing about them.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { createRoutesStub } from "react-router";
import enOperator from "../../app/locales/en/operator";
import esOperator from "../../app/locales/es/operator";
import enCommon from "../../app/locales/en/common";
import esCommon from "../../app/locales/es/common";
import TenantDetailPage from "../../app/routes/_operator.tenants.$slug";

const WRITE = "fisqua-test-archive-appliance-rig-1";
const READ = "fisqua-test-archive-appliance-rig-1-read";
const ERASED_AT = Date.UTC(2026, 10, 12, 15, 30);

async function i18n(lang: "en" | "es") {
  const inst = i18next.createInstance();
  await (inst.init as (opts: unknown) => Promise<unknown>)({
    lng: lang,
    fallbackLng: "es",
    defaultNS: "common",
    resources: {
      en: { operator: enOperator, common: enCommon },
      es: { operator: esOperator, common: esCommon },
    },
    interpolation: { escapeValue: false },
  });
  return inst;
}

function loaderData(erasedScannerKeys: unknown) {
  return {
    tenant: {
      id: "test-tenant",
      slug: "test-archive",
      name: "Test Archive",
      kind: "tenant",
      descriptiveStandard: null,
      createdAt: Date.UTC(2026, 0, 1),
      disabledAt: null,
      defaultLocale: null,
    },
    canEdit: false,
    canImpersonate: false,
    canDisable: false,
    canReEnable: false,
    erasedScannerKeys,
  };
}

async function render(lang: "en" | "es", erasedScannerKeys: unknown) {
  const Stub = createRoutesStub([
    {
      id: "tenant",
      path: "/operator/tenants/test-archive",
      Component: TenantDetailPage as never,
      loader: () => null,
    },
  ]);
  return renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n: await i18n(lang) },
      React.createElement(Stub, {
        initialEntries: ["/operator/tenants/test-archive"],
        hydrationData: { loaderData: { tenant: loaderData(erasedScannerKeys) } },
      }),
    ),
  );
}

const ERASED = { erasedAt: ERASED_AT, writeKeyName: WRITE, readKeyName: READ };

describe("the erased scanner keys notice", () => {
  it("names the two keys to revoke in B2 and when the keys were erased, in English", async () => {
    const html = await render("en", ERASED);
    expect(html).toContain("Scanner keys erased");
    expect(html).toContain(WRITE);
    expect(html).toContain(READ);
    expect(html).toContain("Upload key");
    expect(html).toContain("Read key");
    expect(html).toContain("Revoke both keys in Backblaze B2.");
    expect(html).toContain("2026");
  });

  it("names the two keys in Spanish", async () => {
    const html = await render("es", ERASED);
    expect(html).toContain("Claves del escáner borradas");
    expect(html).toContain("Clave de carga");
    expect(html).toContain("Clave de lectura");
    expect(html).toContain(WRITE);
    expect(html).toContain(READ);
  });

  it("says nothing about scanner keys while they are usable or none were stored", async () => {
    const html = await render("en", null);
    expect(html).toContain("Test Archive");
    expect(html).not.toContain("Scanner keys erased");
    expect(html).not.toContain("appliance");
  });
});

// @version v0.9.0
