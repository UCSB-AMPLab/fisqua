/**
 * Tests — the Digitization screens, rendered
 *
 * This suite renders the Volumes page and the Capture QC queue from
 * fixed loader data, in English and Spanish, and pins what a person
 * sees: the page titles and the section eyebrow; the state filters,
 * with the states the module's design leaves out listed only while a
 * volume is in one; the badge, a refusal's problem and each next step,
 * with Continue review linking to the capture QC viewer; the empty states, for no
 * volumes and for a filter nothing matches; and in the queue the
 * reviewer or "Not assigned", the decided count, the days waited, the
 * Retakes received mark with the count of replaced openings to review
 * again when a retake's approvals were carried over, the assignment
 * control for a manager only, and Open linking to the viewer.
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
import VolumesPage from "../../app/routes/_auth.admin.capture.volumes";
import QueuePage from "../../app/routes/_auth.admin.capture.qc";
import type { CaptureVolumeRow, ReviewerCandidates } from "../../app/lib/capture/screens.server";

const T0 = Date.UTC(2026, 9, 20, 12);
const DAY = 24 * 60 * 60 * 1000;

function row(overrides: Partial<CaptureVolumeRow>): CaptureVolumeRow {
  return {
    referenceCode: "co-test-0001",
    volumeId: "v-1",
    descriptionId: "d-1",
    title: "Test volume one",
    openings: 4,
    handedOverAt: T0 - 3 * DAY,
    linkState: "in_capture_qc",
    state: "in_capture_qc",
    nextStep: "continue_review",
    problem: null,
    reviewer: { id: "u-1", name: "Test Reviewer" },
    hasEarlierDelivery: false,
    approved: 2,
    rejected: 0,
    decided: 2,
    reviewAgain: null,
    ...overrides,
  };
}

const ROWS: CaptureVolumeRow[] = [
  row({}),
  row({
    referenceCode: "co-test-0002",
    volumeId: "v-2",
    linkState: "registered",
    state: "received",
    nextStep: "assign_reviewer",
    reviewer: null,
    approved: 0,
    decided: 0,
    hasEarlierDelivery: true,
  }),
  row({ referenceCode: "co-test-0003", linkState: "retakes_requested", state: "retakes_requested", nextStep: "waiting_for_scanner", rejected: 1, decided: 3, approved: 2 }),
  row({
    referenceCode: "co-test-0004",
    volumeId: null,
    descriptionId: null,
    title: null,
    linkState: "refused",
    state: "refused",
    nextStep: null,
    problem: { kind: "refusal", rule: "description" },
  }),
  row({
    referenceCode: "co-test-0005",
    linkState: "failed",
    state: "failed",
    nextStep: null,
    problem: { kind: "pipeline", message: "The media pipeline stopped the volume (timeout)" },
  }),
  row({
    referenceCode: "co-test-0006",
    volumeId: null,
    descriptionId: null,
    title: null,
    linkState: "refused",
    state: "refused",
    nextStep: null,
    problem: { kind: "refusal", rule: "a-rule-fisqua-does-not-know" },
  }),
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

async function render(lang: "en" | "es", path: string, url: string, Page: React.ComponentType<any>, loaderData: unknown) {
  const Stub = createRoutesStub([
    { path, Component: () => React.createElement(Page, { loaderData, actionData: undefined, params: {}, matches: [] }) },
  ]);
  return renderToStaticMarkup(
    React.createElement(I18nextProvider, { i18n: await i18n(lang) }, React.createElement(Stub, { initialEntries: [url] })),
  );
}

const volumes = (lang: "en" | "es", rows: CaptureVolumeRow[], query = "") =>
  render(lang, "/admin/capture/volumes", `/admin/capture/volumes${query}`, VolumesPage, { volumes: rows });

const CANDIDATES: ReviewerCandidates = {
  staff: [{ id: "u-1", name: "Test Reviewer" }],
  federationName: "Test Federation",
  federation: [{ id: "u-9", name: "Test Steward" }],
};

const queue = (lang: "en" | "es", manager: boolean, rows: CaptureVolumeRow[]) =>
  render(lang, "/admin/capture/qc", "/admin/capture/qc", QueuePage, {
    volumes: rows,
    candidates: manager ? CANDIDATES : null,
    federationName: "Test Federation",
    canAssign: manager,
    now: T0,
  });

describe("Volumes, rendered", () => {
  it("shows the title, the eyebrow, the columns and each row's state and next step", async () => {
    const html = await volumes("en", ROWS);
    expect(html).toContain("Scanner volumes");
    expect(html).toContain("Digitization");
    expect(html).toContain("Every volume the scanner has handed over.");
    for (const col of ["Reference code", "Title", "Openings", "Handed over", "State", "Next step"]) expect(html).toContain(col);
    expect(html).not.toContain(">Runs<");
    expect(html).toContain("In capture QC");
    expect(html).toContain("Retakes requested (1)");
    expect(html).toContain("The reference code matches no description in this workspace.");
    expect(html).toContain("The delivery was refused.");
    expect(html).toContain("Pipeline error:");
    expect(html).toMatch(/<code[^>]*>The media pipeline stopped the volume \(timeout\)<\/code>/);
    expect(html).toContain("An opening is what you see with the volume open: two facing pages, or a single page.");
    expect(html).toContain('href="/admin/capture/qc"');
    expect(html).toContain("Assign a reviewer");
    expect(html).toContain("Waiting for the scanner");
    expect(html).toMatch(/<a[^>]*href="\/admin\/capture\/qc\/v-1"[^>]*>Continue review<\/a>/);
    expect(html).not.toContain("aria-disabled");
    expect(html).toContain("A volume goes on to processing only when every opening is approved.");
  });

  it("draws each state in its colour pair, Published in sage", async () => {
    const html = await volumes("en", [
      row({ referenceCode: "co-a", linkState: "published", state: "published", nextStep: "open_volume" }),
      row({ referenceCode: "co-b", linkState: "approved", state: "approved", nextStep: null }),
      row({ referenceCode: "co-c", linkState: "running", state: "processing", nextStep: "running" }),
    ]);
    expect(html).toMatch(/bg-sage-tint text-sage-deep">Published</);
    expect(html).toMatch(/bg-verdigris-tint text-verdigris-deep">Approved</);
    expect(html).toMatch(/bg-indigo-tint text-indigo">Processing</);
  });

  it("cuts a long pipeline error to 200 characters and keeps the whole text in its title", async () => {
    const long = "E".repeat(250);
    const html = await volumes("en", [
      row({ linkState: "failed", state: "failed", nextStep: null, problem: { kind: "pipeline", message: long } }),
    ]);
    expect(html).toContain(`title="${long}"`);
    expect(html).toContain(`>${"E".repeat(200)}\u2026</code>`);
  });

  it("lists the drawn states as filters, and a left-out state only while a volume is in it", async () => {
    const html = await volumes("en", ROWS);
    for (const label of ["All states", "Received", "Preparing review images", "Approved", "Processing", "Published", "Refused"]) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).not.toContain(">Superseded</button>");
    expect(html).toContain(">Processing failed</button>");
  });

  it("filters by the state parameter, and says when nothing matches", async () => {
    const filtered = await volumes("en", ROWS, "?state=refused");
    expect(filtered).toContain("co-test-0004");
    expect(filtered).not.toContain("co-test-0001");
    expect(filtered).toMatch(/aria-pressed="true"[^>]*>Refused</);
    const none = await volumes("en", ROWS, "?state=published");
    expect(none).toContain("No volumes are in this state.");
  });

  it("shows the empty state when the scanner has handed nothing over", async () => {
    const html = await volumes("en", []);
    expect(html).toContain("No volumes yet");
    expect(html).not.toContain("<table");
  });

  it("renders in Spanish", async () => {
    const html = await volumes("es", ROWS);
    expect(html).toContain("Volúmenes del escáner");
    expect(html).toContain("Digitalización");
    expect(html).toContain("Capturas por repetir (1)");
    expect(html).toContain("Asignar revisor");
    expect(html).toContain("El código de referencia no corresponde a ninguna descripción de este espacio de trabajo.");
    expect(html).toContain("Fisqua no aceptó la entrega.");
    expect(html).toContain("Detalle técnico:");
  });
});

describe("the Capture QC queue, rendered", () => {
  const waiting = ROWS.slice(0, 2);

  it("shows reviewers, progress, days waited and Open linking to the viewer", async () => {
    const html = await queue("en", true, waiting);
    expect(html).toContain("Capture QC");
    expect(html).toContain("from the archive&#x27;s staff or from Test Federation.");
    expect(html).toContain("Test Reviewer");
    expect(html).toContain("Not assigned");
    expect(html).toContain("2 of 4 openings decided");
    expect(html).toContain("0 of 4 openings decided");
    expect(html).toContain("3 days");
    expect(html).toContain("Retakes received");
    expect(html).toMatch(/<a[^>]*href="\/admin\/capture\/qc\/v-1"[^>]*>Open<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/admin\/capture\/qc\/v-2"[^>]*>Open<\/a>/);
    expect(html).not.toContain("disabled=\"\"");
    expect(html).toContain("Approved");
    expect(html).toContain("Rejected for retake");
    expect(html).toContain("Undecided");
  });

  it("gives a manager Reassign and Assign, and a reviewer neither", async () => {
    const managed = await queue("en", true, waiting);
    expect(managed).toContain(">Reassign</button>");
    expect(managed).toMatch(/>Assign<svg/);
    const reviewed = await queue("en", false, waiting.slice(0, 1));
    expect(reviewed).not.toContain("Reassign");
    expect(reviewed).not.toMatch(/>Assign</);
  });

  it("counts a retake's replaced openings to review again in place of the openings decided", async () => {
    const html = await queue("en", true, [
      row({ hasEarlierDelivery: true, approved: 3, decided: 3, reviewAgain: 1 }),
      row({ referenceCode: "co-test-0007", hasEarlierDelivery: true, approved: 1, decided: 1, reviewAgain: 3 }),
    ]);
    expect(html).toContain("Retakes received");
    expect(html).toContain("1 replaced opening to review again");
    expect(html).toContain("3 replaced openings to review again");
    expect(html).not.toContain("openings decided");
    const es = await queue("es", true, [row({ hasEarlierDelivery: true, reviewAgain: 2 })]);
    expect(es).toContain("2 pares de páginas con captura repetida por revisar");
  });

  it("shows the empty state when nothing waits for review", async () => {
    const html = await queue("en", true, []);
    expect(html).toContain("No volumes waiting for review");
  });

  it("renders in Spanish, with one day in the singular", async () => {
    const html = await queue("es", true, [row({ handedOverAt: T0 - DAY })]);
    expect(html).toContain("Revisión de capturas");
    expect(html).toContain("2 de 4 pares de páginas resueltos");
    expect(html).toContain("1 día");
    expect(html).toContain("Reasignar");
  });
});

// @version v0.8.0
