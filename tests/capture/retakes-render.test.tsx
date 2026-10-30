/**
 * Tests — the Retakes screen, rendered
 *
 * This suite renders the Retakes page from fixed loader data, in
 * English and Spanish, and pins what a person sees: the title, the
 * section eyebrow and the introduction; the legend of the three retake
 * states in order, joined by Lucide arrows rather than Unicode ones;
 * one card per volume with its reference code, title and count of
 * openings to retake; the review in progress with "Open in viewer",
 * a link to the volume in the capture QC viewer, and when the
 * rejections reached the scanner;
 * the table's columns, each row's opening, page keys, reason label with
 * its gloss and, when the rejection names one, the image to retake, note, who asked and the days outstanding, and each state in
 * its colour pair, missing from the new delivery standing apart from the
 * three in the legend; and the empty state.
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
import RetakesPage from "../../app/routes/_auth.admin.capture.retakes";
import type { RetakeRow, RetakeVolume } from "../../app/lib/capture/retakes.server";

const T0 = Date.UTC(2026, 9, 20, 12);

function row(overrides: Partial<RetakeRow>): RetakeRow {
  return {
    captuaRecordId: 16,
    sequence: 16,
    pageKeys: ["co-test-0001-img_0031_c1", "co-test-0001-img_0032_c2"],
    reason: "blur",
    side: null,
    note: null,
    askedBy: "Test Reviewer",
    askedAt: T0,
    outstandingDays: 3,
    state: "requested",
    sentAt: null,
    fromEarlier: false,
    ...overrides,
  };
}

const VOLUMES: RetakeVolume[] = [
  {
    volumeId: "v-1",
    referenceCode: "co-test-0001",
    title: "Test volume one",
    undecided: 4,
    sentAt: null,
    rows: [
      row({}),
      row({ captuaRecordId: 20, sequence: 20, reason: "glare", side: "left", note: "Lamp reflection on the left page", outstandingDays: 1 }),
    ],
  },
  {
    volumeId: "v-2",
    referenceCode: "co-test-0002",
    title: null,
    undecided: 0,
    sentAt: T0,
    rows: [
      row({ captuaRecordId: 3, sequence: 3, reason: "framing", state: "sent", sentAt: T0 }),
      row({ captuaRecordId: 5, sequence: 5, reason: "other", note: "Torn corner", pageKeys: ["co-test-0002-img_0009_c1"], state: "sent", sentAt: T0 }),
      row({ captuaRecordId: 7, sequence: 7, reason: "shadow", state: "replaced", outstandingDays: 1, fromEarlier: true }),
      row({ captuaRecordId: 8, sequence: 8, reason: "dirt", state: "missing", fromEarlier: true }),
    ],
  },
];

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

async function render(lang: "en" | "es", volumes: RetakeVolume[]) {
  const Stub = createRoutesStub([
    {
      path: "/admin/capture/retakes",
      Component: () => React.createElement(RetakesPage, { loaderData: { volumes }, actionData: undefined, params: {}, matches: [] } as any),
    },
  ]);
  return renderToStaticMarkup(
    React.createElement(I18nextProvider, { i18n: await i18n(lang) }, React.createElement(Stub, { initialEntries: ["/admin/capture/retakes"] })),
  );
}

describe("Retakes, rendered", () => {
  it("shows the image to retake beside the reason when the rejection names one", async () => {
    const html = await render("en", VOLUMES);
    expect(html).toMatch(/>Glare\/reflection<\/span> · <span class="font-normal">Left<\/span>/);
    expect(html).not.toMatch(/>Motion blur<\/span> · /);
    expect(await render("es", VOLUMES)).toMatch(/>Reflejo\/Brillo<\/span> · <span class="font-normal">Izquierdo<\/span>/);
  });

  it("shows the title, the eyebrow, the introduction and the legend in order, with Lucide arrows", async () => {
    const html = await render("en", VOLUMES);
    expect(html).toContain(">Retakes</h1>");
    expect(html).toContain("Digitization");
    expect(html).toContain(
      "Openings rejected in capture QC whose retakes have not yet been approved. A volume waits until all its retakes are back and approved.",
    );
    const legend = html.slice(html.indexOf('aria-label="Retake states"'), html.indexOf("</ol>"));
    expect(legend.indexOf("Requested")).toBeLessThan(legend.indexOf("Sent to scanner"));
    expect(legend.indexOf("Sent to scanner")).toBeLessThan(legend.indexOf("Replaced (awaiting review)"));
    expect(legend.match(/lucide-arrow-right/g)).toHaveLength(2);
    // Missing stands apart from the flow, after it and with no arrow.
    expect(legend.indexOf("Missing from the new delivery")).toBeGreaterThan(legend.indexOf("Replaced (awaiting review)"));
    expect(html).not.toContain("→");
  });

  it("draws one card per volume, with its header", async () => {
    const html = await render("en", VOLUMES);
    expect(html).toContain("co-test-0001</h2>");
    expect(html).toContain("Test volume one · 2 openings to retake");
    expect(html).toContain("co-test-0002</h2>");
    expect(html).toContain(">4 openings to retake</p>");
    expect(html).toContain("Review in progress: 4 openings undecided");
    expect(html).toMatch(/<a[^>]*href="\/admin\/capture\/qc\/v-1"[^>]*>Open in viewer<\/a>/);
    expect(html).not.toContain("The viewer is not available yet.");
    expect(html).toContain("Sent to the scanner: ");
    expect(html.match(/Open in viewer/g)).toHaveLength(1);
  });

  it("shows each row's columns, reason with its gloss, note and state in its colour pair", async () => {
    const html = await render("en", VOLUMES);
    for (const col of ["Opening", "Page keys", "Reason", "Note", "Asked by", "Asked", "Outstanding", "State"]) {
      expect(html).toContain(`>${col}</th>`);
    }
    expect(html).toContain("Opening 16");
    expect(html).toContain("co-test-0001-img_0031_c1</span>");
    expect(html).toContain('title="The camera or the page moved during the shot, so the image is smeared.">Motion blur</span>');
    expect(html).toContain(">Glare/reflection</span>");
    expect(html).toContain("Lamp reflection on the left page");
    expect(html).toContain(">Other</span>");
    expect(html).toContain("Torn corner");
    expect(html).toContain("Test Reviewer");
    expect(html).toContain("3 days");
    expect(html).toContain("1 day<");
    expect(html).toMatch(/bg-madder-tint text-madder-deep">Requested</);
    expect(html).toMatch(/bg-saffron-tint text-saffron-deep">Sent to scanner</);
    expect(html).toMatch(/bg-stone-100 text-stone-600">Replaced \(awaiting review\)</);
    expect(html).toMatch(/bg-madder-tint text-madder-deep">Missing from the new delivery</);
  });

  it("shows the empty state when no retake is outstanding", async () => {
    const html = await render("en", []);
    expect(html).toContain("No retakes outstanding");
    expect(html).toContain("Openings rejected in capture QC appear here until their retakes are approved.");
    expect(html).not.toContain("<table");
  });

  it("renders in Spanish", async () => {
    const html = await render("es", VOLUMES);
    expect(html).toContain(">Capturas por repetir</h1>");
    expect(html).toContain("Digitalización");
    expect(html).toContain("Solicitada");
    expect(html).toContain("Enviada al escáner");
    expect(html).toContain("Reemplazada (por revisar)");
    expect(html).toContain("Test volume one · 2 pares de páginas por repetir");
    expect(html).toContain("Revisión en curso: 4 pares de páginas sin resolver");
    expect(html).toContain("Abrir en el visor");
    expect(html).toContain("Par de páginas 16");
    expect(html).toContain(">Imagen movida</span>");
    expect(html).toContain(">Claves de página</th>");
    expect(html).toContain("Envío al escáner: ");
    expect(html).toContain("Falta en la nueva entrega");
    expect(html).toContain(">En espera</th>");
    const empty = await render("es", []);
    expect(empty).toContain("No hay capturas por repetir");
  });
});

// @version v0.8.0
