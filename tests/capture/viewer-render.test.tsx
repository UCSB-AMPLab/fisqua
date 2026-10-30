/**
 * Tests — the capture QC viewer, rendered
 *
 * This suite renders the capture QC viewer from fixed loader data, in
 * English and Spanish, and pins what a person sees before any script
 * runs:
 *
 *   - windowing: of a long volume only the openings on screen and two
 *     either side are mounted, around the opening the address names;
 *   - each opening: a group named by its number and decision, the line
 *     above it with its page keys and a rejection's reason and image to
 *     retake, Approve as
 *     a toggle, and the rotate buttons, one for a single image;
 *   - the rail: the current opening, its rotation, a rejection's reason
 *     and image to retake in its details and its history, the hold
 *     sentence, led by the Retakes requested badge when the handover has
 *     a rejected record and every opening is approved, the live region,
 *     and no button to start processing;
 *   - the contact sheet: a rejection's reason and image to retake;
 *   - each banner: no review images, preparing, failed, locked (with
 *     no decision controls), a new handover, and a filter that matches
 *     nothing; and, for ready review images, a banner only when access
 *     to them could not be had;
 *   - the reject form: every reason with its gloss, and a note required
 *     for Other, with Reject for retake disabled until it has one; on an
 *     opening with two images, the image to retake, required, with none
 *     chosen, or the saved one when the opening was rejected (Both for a
 *     rejection recorded without a side); none on an opening with one
 *     image;
 *   - clearing a decision: Clear decision in the margin and the rail of
 *     a decided opening the unit has not fetched, none once it has or
 *     for someone who may not decide, and "Decision cleared." in the
 *     history with the rotation still held;
 *   - an earlier handover's images: the Earlier images toggle only on
 *     an opening with an earlier rejection, and, pressed, the rejected
 *     images in the same box with the handover, reason and side;
 *   - the contact sheet's thumbnails from the review tiles, at 96 or 200
 *     pixels, comma encoded, token in the query, lazy, contained and
 *     turned, and placeholders without access or token;
 *   - the purged banner, in English and Spanish;
 *   - the top bar: the back link to the capture QC queue, and Lucide's
 *     arrow, undo and redo icons in place of inline paths, as the
 *     segmentation viewer now draws them too.
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
import enViewer from "../../app/locales/en/viewer";
import esViewer from "../../app/locales/es/viewer";
import enCommon from "../../app/locales/en/common";
import esCommon from "../../app/locales/es/common";
import ViewerPage from "../../app/routes/_auth.admin.capture.qc.$volumeId";
import { CaptureQcBanners } from "../../app/components/capture/viewer/capture-qc-viewer";
import { RejectForm } from "../../app/components/capture/viewer/reject-form";
import { CaptureQcRail } from "../../app/components/capture/viewer/capture-qc-rail";
import { OpeningRow } from "../../app/components/capture/viewer/opening-row";
import { ContactSheet } from "../../app/components/capture/viewer/contact-sheet";
import { ViewerTopBar } from "../../app/components/viewer/viewer-top-bar";
import { initialState, type CaptureQcVolume, type TilesState, type ViewerOpening } from "../../app/lib/capture/viewer";
import type { ReviewAccessState } from "../../app/lib/capture/use-review-access";

const T0 = Date.UTC(2026, 9, 20, 12);

function opening(i: number): ViewerOpening {
  const id = 1000 + i;
  const single = i === 3;
  return {
    captuaRecordId: id,
    sequence: i,
    scannerStatus: "in_review",
    images: single
      ? [{ captureId: `cap-${i}`, role: "single", pageKey: `co-test-img_${i}_c1` }]
      : [
          { captureId: `cap-${i}`, role: "left", pageKey: `co-test-img_${i}_c1` },
          { captureId: `cap-${i}`, role: "right", pageKey: `co-test-img_${i}_c2` },
        ],
    decision:
      i === 1
        ? { decision: "approved", reason: null, side: null, note: null, decidedBy: "Test Reviewer", decidedAt: T0 }
        : i === 2
          ? { decision: "rejected", reason: "glare", side: "left", note: "Lamp", decidedBy: "Test Reviewer", decidedAt: T0 }
          : null,
    rotations: i === 1 ? [{ captureId: "cap-1", role: "right", quarterTurns: 1 }] : [],
    earlier: null,
  };
}

function volume(count: number, overrides: Partial<CaptureQcVolume> = {}): CaptureQcVolume {
  const openings = Array.from({ length: count }, (_, k) => opening(k + 1));
  return {
    volume: { id: "v-1", referenceCode: "co-test-0001", title: "Test volume one" },
    reviewer: { id: "u-1", name: "Test Reviewer" },
    delivery: { manifestId: "delivery-1", handover: 1, receivedAt: T0, rejectedRecords: 0 },
    openings,
    counts: { openings: count, images: openings.reduce((n, o) => n + o.images.length, 0), approved: 1, rejected: 1, decided: 2 },
    revision: 1,
    canDecide: true,
    locked: false,
    tiles: { state: "none" },
    ...overrides,
  };
}

async function i18n(lang: "en" | "es") {
  const inst = i18next.createInstance();
  await (inst.init as (opts: unknown) => Promise<unknown>)({
    lng: lang,
    fallbackLng: "es",
    defaultNS: "common",
    resources: {
      en: { capture: enCapture, viewer: enViewer, common: enCommon },
      es: { capture: esCapture, viewer: esViewer, common: esCommon },
    },
    interpolation: { escapeValue: false },
  });
  return inst;
}

async function renderPage(data: CaptureQcVolume, query = "", lang: "en" | "es" = "en") {
  const Stub = createRoutesStub([
    {
      path: "/admin/capture/qc/:volumeId",
      Component: () => React.createElement(ViewerPage, { loaderData: data, actionData: undefined, params: { volumeId: "v-1" }, matches: [] } as any),
    },
  ]);
  return renderToStaticMarkup(
    React.createElement(I18nextProvider, { i18n: await i18n(lang) }, React.createElement(Stub, { initialEntries: [`/admin/capture/qc/v-1${query}`] })),
  );
}

async function renderNode(node: React.ReactElement, lang: "en" | "es" = "en") {
  return renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: await i18n(lang) }, node));
}

/** A component that formats dates reads the root's time zone through the router. */
function inRouter(node: React.ReactElement) {
  const Stub = createRoutesStub([{ path: "/", Component: () => node }]);
  return React.createElement(Stub, { initialEntries: ["/"] });
}

const mounted = (html: string) => [...html.matchAll(/data-opening="(\d+)"/g)].map((m) => Number(m[1]));

describe("windowing", () => {
  it("mounts only the openings on screen and two either side", async () => {
    const html = await renderPage(volume(60));
    expect(mounted(html)).toEqual([1, 2, 3, 4]);
    expect(html.match(/role="group"/g)).toHaveLength(4 + 2);
  });

  it("mounts the window round the opening the address names", async () => {
    const html = await renderPage(volume(60), "?opening=30");
    expect(mounted(html)).toEqual([28, 29, 30, 31, 32, 33]);
    expect(html).toContain("Opening 30 of 60");
  });
});

describe("the openings", () => {
  it("draws each opening as a named group, with its line, controls and rotation", async () => {
    const html = await renderPage(volume(4));
    expect(html).toContain('aria-label="Opening 1, Approved"');
    expect(html).toContain('aria-label="Opening 2, Rejected for retake"');
    expect(html).toContain('aria-label="Opening 4, Undecided"');
    expect(html).toContain("co-test-img_2_c1 / co-test-img_2_c2");
    expect(html).toContain(">Glare/reflection</span>");
    expect(html).toMatch(/>Glare\/reflection<\/span><span class="[^"]*">Left<\/span>/);
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="Approve opening 1"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*aria-label="Approve opening 4"/);
    expect(html).toContain('aria-label="Reject opening 2 for retake"');
    expect(html).toContain('aria-label="Rotate the left page of opening 1"');
    expect(html).toContain('aria-label="Rotate the right page of opening 1"');
    expect(html).toContain('aria-label="Rotate the single page of opening 3"');
    expect(html).not.toContain('aria-label="Rotate the right page of opening 3"');
    expect(html).toContain('aria-label="Left page of opening 1, unprocessed preview"');
  });

  it("shows the current opening in the rail, with the hold and the live region, and no processing button", async () => {
    const html = await renderPage(volume(4), "?opening=1");
    expect(html).toContain("Left: none · Right: 90° right");
    expect(html).toContain("by Test Reviewer · ");
    expect(html).toContain("Received from the scanner in handover 1.");
    expect(html).toContain("Processing waits until every opening is approved.");
    expect(html).toMatch(/aria-live="polite"[^>]*>Opening 1 of 4, Approved</);
    expect(html).not.toContain("Send to processing");
    expect(html).not.toContain("Request retakes");
  });

  it("leads the hold with Retakes requested when a rejected record is all that is left", async () => {
    const approved = (i: number): ViewerOpening => ({
      ...opening(i),
      decision: { decision: "approved", reason: null, side: null, note: null, decidedBy: "Test Reviewer", decidedAt: T0 },
    });
    const allApproved = (rejectedRecords: number) =>
      volume(2, {
        delivery: { manifestId: "delivery-1", handover: 1, receivedAt: T0, rejectedRecords },
        openings: [approved(1), approved(3)],
        counts: { openings: 2, images: 3, approved: 2, rejected: 0, decided: 2 },
      });
    const held = await renderPage(allApproved(1));
    expect(held).toMatch(/>Retakes requested<\/span> Processing waits until every opening is approved\./);
    const es = await renderPage(allApproved(1), "", "es");
    expect(es).toMatch(/>Capturas por repetir<\/span> /);
    // No rejected record, or openings still undecided: the sentence alone.
    expect(await renderPage(allApproved(0))).not.toContain("Retakes requested");
    const undecided = volume(4, { delivery: { manifestId: "delivery-1", handover: 1, receivedAt: T0, rejectedRecords: 1 } });
    expect(await renderPage(undecided)).not.toContain("Retakes requested");
    // Locked by a run: processing has the volume, so no badge.
    expect(await renderPage({ ...allApproved(1), locked: true, canDecide: false })).not.toContain("Retakes requested");
  });

  it("shows a rejection's image to retake in the rail and its history", async () => {
    const html = await renderPage(volume(4), "?opening=2");
    expect(html).toMatch(/>Glare\/reflection<\/b> · <b class="[^"]*">Left<\/b> · by Test Reviewer/);
    expect(html).toContain("Rejected for retake. Reason: Glare/reflection. Side: Left. Lamp");
    const es = await renderPage(volume(4), "?opening=2", "es");
    expect(es).toContain("Rechazado para repetir. Motivo: Reflejo/Brillo. Lado: Izquierdo. Lamp");
  });

  it("keeps the history sentence without an image for a single image's rejection", async () => {
    const data = volume(4);
    // Opening 3 is a single image.
    data.openings[2] = { ...data.openings[2], decision: { ...data.openings[1].decision!, side: null } };
    const html = await renderPage(data, "?opening=3");
    expect(html).toContain("Rejected for retake. Reason: Glare/reflection. Lamp");
    expect(html).not.toContain("Side: ");
  });

  it("shows a rejection's image to retake on the contact sheet", async () => {
    const html = await renderPage(volume(4), "?view=sheet");
    expect(html).toMatch(/>Glare\/reflection<\/span><span class="text-madder-deep">Left<\/span>/);
  });

  it("speaks Spanish", async () => {
    const html = await renderPage(volume(4), "?opening=2", "es");
    expect(html).toContain("Par de páginas 2 de 4");
    expect(html).toContain('aria-label="Par de páginas 2, Rechazado para repetir"');
    expect(html).toContain("Volver a Revisión de capturas");
    expect(html).toContain("Este volumen no tiene imágenes para revisión. Aun así, puedes aprobar o rechazar los pares de páginas.");
  });
});

describe("banners", () => {
  const banner = (props: {
    tiles?: TilesState;
    images?: ReviewAccessState["status"];
    locked?: boolean;
    deliveryChanged?: boolean;
    emptyFilter?: boolean;
  }) =>
    renderNode(
      React.createElement(CaptureQcBanners, {
        tiles: props.tiles ?? { state: "ready" },
        images: props.images,
        locked: props.locked ?? false,
        deliveryChanged: props.deliveryChanged ?? false,
        emptyFilter: props.emptyFilter ?? false,
      }),
    );

  it("says the review images were deleted once their purge started, and asks for no access", async () => {
    const purged = "The review images were deleted after processing.";
    expect(await banner({ tiles: { state: "purged" } })).toContain(purged);
    expect(await banner({ tiles: { state: "purged" }, images: "none" })).not.toContain("could not be loaded");
    // Processing locks the volume before its tiles are purged: both are said.
    const locked = await banner({ tiles: { state: "purged" }, locked: true });
    expect(locked).toContain(purged);
    expect(locked).toContain("Processing has started on this volume.");
    expect(await banner({ tiles: { state: "purged" }, locked: true, deliveryChanged: true })).not.toContain(purged);
    const html = await renderPage(volume(4, { tiles: { state: "purged" }, locked: true, canDecide: false }));
    expect(html).toContain(purged);
    const es = await renderPage(volume(4, { tiles: { state: "purged" } }), "", "es");
    expect(es).toContain("Las imágenes para revisión se borraron después del procesamiento.");
  });

  it("says each state", async () => {
    expect(await banner({ tiles: { state: "none" } })).toContain("This volume has no review images. You can still record decisions.");
    expect(await banner({ tiles: { state: "preparing" } })).toContain(
      "Review images are being prepared. You can still record decisions.",
    );
    expect(await banner({ tiles: { state: "failed" } })).toContain(
      "The review images could not be prepared. You can still record decisions.",
    );
    expect(await banner({ locked: true, tiles: { state: "none" } })).toBe(
      (await banner({ locked: true })).toString(),
    );
    expect(await banner({ locked: true })).toContain(
      "Processing has started on this volume. Its decisions can no longer be changed.",
    );
    const changed = await banner({ deliveryChanged: true, locked: true });
    expect(changed).toContain("A new handover of this volume arrived. Reload the page to review it.");
    expect(changed).not.toContain("Processing has started");
    expect(changed).toContain('role="alert"');
    expect(await banner({ emptyFilter: true })).toContain("No openings match this filter.");
    expect(await banner({})).toBe("");
  });

  it("follows access to the review tiles", async () => {
    const none = "This volume has no review images. You can still record decisions.";
    const unavailable = "The review images could not be loaded. You can still record decisions.";
    expect(await banner({ tiles: { state: "ready" }, images: "loading" })).toBe("");
    expect(await banner({ tiles: { state: "ready" }, images: "ready" })).toBe("");
    const failed = await banner({ tiles: { state: "ready" }, images: "unavailable" });
    expect(failed).toContain(unavailable);
    expect(failed).not.toContain(none);
    expect(failed).toContain('role="status"');
    // Access is asked for only when the tiles are ready.
    expect(await banner({ tiles: { state: "none" }, images: "none" })).toContain(none);
    expect(await banner({ tiles: { state: "failed" }, images: "none" })).not.toContain(unavailable);
    expect(await banner({ locked: true, tiles: { state: "ready" }, images: "unavailable" })).not.toContain(unavailable);
  });

  it("shows the locked banner and no decision controls on a locked volume", async () => {
    const html = await renderPage(volume(4, { locked: true, canDecide: false }));
    expect(html).toContain("Processing has started on this volume. Its decisions can no longer be changed.");
    expect(html).not.toContain("This volume has no review images.");
    expect(html).not.toContain("Approve opening");
    expect(html).not.toContain("Reject opening");
    expect(html).toContain('aria-label="Make opening 1 current"');
  });

  it("shows the empty filter when nothing matches", async () => {
    const html = await renderPage(volume(2), "?show=undecided");
    expect(html).toContain("No openings match this filter.");
    expect(mounted(html)).toEqual([]);
  });
});

describe("the reject form", () => {
  const form = (reason: "other" | "blur" | null) =>
    renderNode(React.createElement(RejectForm, { n: 7, initialReason: reason, onSubmit: () => {}, onCancel: () => {} }));

  it("lists every reason with its gloss", async () => {
    const html = await form(null);
    expect(html.match(/type="radio"/g)).toHaveLength(9);
    expect(html).toContain("Reason for retake");
    expect(html).toContain("Motion blur");
    expect(html).toContain("The camera or the page moved during the shot, so the image is smeared.");
    expect(html).toMatch(/<button type="submit" disabled=""/);
  });

  it("requires a note for Other, and keeps Reject for retake disabled until it has one", async () => {
    const html = await form("other");
    expect(html).toContain('aria-required="true"');
    expect(html).toContain("(required for Other)");
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*>Reject for retake<\/button>/);
  });

  const pairForm = (initialSide: "left" | "right" | "both" | null) =>
    renderNode(
      React.createElement(RejectForm, { n: 7, pair: true, initialSide, initialReason: "blur", onSubmit: () => {}, onCancel: () => {} }),
    );

  it("asks which image to retake on an opening with two images, with none chosen, and stays disabled until one is", async () => {
    const html = await pairForm(null);
    expect(html).toContain("<legend");
    expect(html).toContain("Side to retake");
    expect(html.match(/type="radio"/g)).toHaveLength(12);
    for (const label of ["Left", "Right", "Both"]) expect(html).toContain(`>${label}</label>`);
    const sides = html.match(/<input id="[^"]*-side-[a-z]+"[^>]*>/g) ?? [];
    expect(sides).toHaveLength(3);
    for (const input of sides) {
      expect(input).toContain('required=""');
      expect(input).not.toContain('checked=""');
    }
    expect(html.indexOf("Side to retake")).toBeLessThan(html.indexOf("Reason for retake"));
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*>Reject for retake<\/button>/);
  });

  it("starts from the saved image to retake, and can then be sent", async () => {
    const html = await pairForm("right");
    const checked = (html.match(/<input id="[^"]*-side-[a-z]+"[^>]*>/g) ?? []).filter((i) => i.includes('checked=""'));
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain('value="right"');
    expect(html).toMatch(/<button type="submit" class="[^"]*">Reject for retake<\/button>/);
  });

  it("opens on a pair's rejection recorded without a side with Both chosen, and shows Both", async () => {
    const legacy: ViewerOpening = { ...opening(2), decision: { ...opening(2).decision!, side: null } };
    const html = await renderNode(inRouter(
      React.createElement(CaptureQcRail, {
        referenceCode: "co-test-0001",
        reviewerName: "Test Reviewer",
        imageCount: 2,
        openingCount: 1,
        counts: { approved: 0, rejected: 1, undecided: 0 },
        opening: legacy,
        state: initialState(legacy),
        handover: 1,
        receivedAt: T0,
        canDecide: true,
        rejectOpen: true,
        onReject: () => {},
        onCancelReject: () => {},
        refusal: null,
        announcement: "",
        collapsed: false,
        onToggle: () => {},
      }),
    ));
    const checked = (html.match(/<input id="[^"]*-side-[a-z]+"[^>]*>/g) ?? []).filter((i) => i.includes('checked=""'));
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain('value="both"');
    expect(html).toContain("Rejected for retake. Reason: Glare/reflection. Side: Both. Lamp");
  });

  it("does not ask which image on an opening with one image", async () => {
    const html = await form("blur");
    expect(html).not.toContain("Side to retake");
    expect(html.match(/type="radio"/g)).toHaveLength(9);
  });

  it("takes any other reason with or without a note", async () => {
    const html = await form("blur");
    expect(html).not.toContain("aria-required");
    expect(html).toContain("(optional)");
    expect(html).toMatch(/<button type="submit" class="[^"]*">Reject for retake<\/button>/);
  });
});

describe("clearing a decision", () => {
  const rowOf = (html: string, n: number) => html.split('data-opening="').find((part) => part.startsWith(`${n}"`)) ?? "";

  it("offers Clear decision on a decided opening the unit has not fetched, in its margin and in the rail", async () => {
    const html = await renderPage(volume(4), "?opening=1");
    expect(rowOf(html, 1)).toContain('aria-label="Clear decision"');
    expect(rowOf(html, 2)).toContain('aria-label="Clear decision"');
    expect(rowOf(html, 4)).not.toContain('aria-label="Clear decision"');
    expect(html).toMatch(/<\/svg>Clear decision<\/button>/);
    const es = await renderPage(volume(4), "?opening=1", "es");
    expect(es).toContain('aria-label="Dejar sin resolver"');
  });

  it("offers no Clear decision once the unit has fetched the decision, nor to someone who may not decide", async () => {
    const data = volume(4);
    data.openings[0] = { ...data.openings[0], decision: { ...data.openings[0].decision!, sentAt: T0 + 5 } };
    const html = await renderPage(data, "?opening=1");
    expect(rowOf(html, 1)).not.toContain("Clear decision");
    expect(rowOf(html, 2)).toContain('aria-label="Clear decision"');
    expect(html).not.toMatch(/<\/svg>Clear decision<\/button>/);
    const locked = await renderPage(volume(4, { locked: true, canDecide: false }), "?opening=2");
    expect(locked).not.toContain("Clear decision");
  });

  it("says in the history that the decision was cleared, with the rotation still held", async () => {
    const o = opening(1);
    const html = await renderNode(
      inRouter(
        React.createElement(CaptureQcRail, {
          referenceCode: "co-test-0001",
          reviewerName: "Test Reviewer",
          imageCount: 2,
          openingCount: 1,
          counts: { approved: 0, rejected: 0, undecided: 1 },
          opening: o,
          state: { decision: null, turns: { "right:cap-1": 1 } },
          handover: 1,
          receivedAt: T0,
          canDecide: true,
          rejectOpen: false,
          cleared: true,
          onClear: () => {},
          onReject: () => {},
          onCancelReject: () => {},
          refusal: null,
          announcement: "",
          collapsed: false,
          onToggle: () => {},
        }),
      ),
    );
    expect(html).toContain("Decision cleared.");
    expect(html).toContain("Not saved yet. The rotation is sent with this opening");
    expect(html).not.toMatch(/<\/svg>Clear decision<\/button>/);
  });
});

describe("an earlier handover's images", () => {
  const earlier: ViewerOpening["earlier"] = {
    deliveryId: "delivery-0",
    handover: 1,
    images: [
      { captureId: "cap-old", role: "left", pageKey: "co-test-old_2_c1" },
      { captureId: "cap-old", role: "right", pageKey: "co-test-old_2_c2" },
    ],
    decision: { decision: "rejected", reason: "blur", side: "right", note: null, decidedBy: "Test Reviewer", decidedAt: T0 },
  };
  const row = (comparing: boolean, withEarlier = true, lang: "en" | "es" = "en") =>
    renderNode(
      React.createElement(OpeningRow, {
        opening: { ...opening(2), decision: null, earlier: withEarlier ? earlier : null },
        state: { decision: null, turns: {} },
        view: "spreads",
        pw: 300,
        width: 712,
        height: 440,
        current: true,
        canDecide: true,
        comparing,
        onCurrent: () => {},
        onApprove: () => {},
        onReject: () => {},
        onRotate: () => {},
        onCompare: () => {},
      }),
      lang,
    );

  it("offers Earlier images only on an opening with an earlier rejection", async () => {
    const html = await row(false);
    expect(html).toMatch(/data-compare=""[^>]*>.*Earlier images<\/button>/);
    expect(html).toContain('data-page-key="co-test-img_2_c1"');
    expect(html).not.toContain("co-test-old_2_c1");
    expect(html).not.toContain("data-earlier-caption");
    expect(await row(false, false)).not.toContain("Earlier images");
  });

  it("swaps in the rejected images in the same box, with a caption naming the handover, reason and side", async () => {
    const shown = await row(true);
    expect(shown).toMatch(/data-compare=""[^>]*>.*Current images<\/button>/);
    expect(shown).toContain('data-page-key="co-test-old_2_c1"');
    expect(shown).toContain('data-page-key="co-test-old_2_c2"');
    expect(shown).not.toContain('data-page-key="co-test-img_2_c1"');
    expect(shown).toContain("Handover 1, rejected: Motion blur");
    expect(shown).toMatch(/data-earlier-caption=""[\s\S]*>Right<\/span>/);
    // The row keeps its size, and each image its page's.
    expect(shown).toContain('style="width:712px;height:440px"');
    expect(shown.match(/style="width:300px;height:420px"/g)).toHaveLength(4);
    const es = await row(true, true, "es");
    expect(es).toContain("Entrega 1. Motivo: Imagen movida");
    expect(es).toContain("Ver imágenes actuales");
  });
});

describe("the contact sheet's thumbnails", () => {
  const sheet = (access: { base: string; token: () => string | null } | null, zoom = 1) =>
    renderNode(
      React.createElement(ContactSheet, {
        openings: [opening(1), opening(3)],
        states: new Map([
          [1001, initialState(opening(1))],
          [1003, initialState(opening(3))],
        ]),
        currentId: 1001,
        zoom,
        selected: new Set<number>(),
        canDecide: true,
        access,
        onOpen: () => {},
        onToggle: () => {},
      }),
    );
  const BASE = "https://f000.backblazeb2.test/file/review-tiles/co-test/delivery-1/";

  it("reads each page's thumbnail from the review tiles, comma encoded and with the token in the query", async () => {
    const html = await sheet({ base: BASE, token: () => "tok/1" });
    const srcs = [...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
    expect(srcs).toEqual([
      `${BASE}co-test-img_1_c1/full/96%2C/0/default.jpg?Authorization=tok%2F1`,
      `${BASE}co-test-img_1_c2/full/96%2C/0/default.jpg?Authorization=tok%2F1`,
      `${BASE}co-test-img_3_c1/full/96%2C/0/default.jpg?Authorization=tok%2F1`,
    ]);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("object-contain");
    // Opening 1's right page is turned a quarter: drawn on its side.
    expect(html).toContain("width:123px;height:88px;transform:translate(-50%, -50%) rotate(90deg)");
    expect(html).toContain("width:88px;height:123px;transform:translate(-50%, -50%) rotate(0deg)");
  });

  it("asks for 200 pixels when the box times the screen's pixel ratio passes 96", async () => {
    const g = globalThis as { window?: unknown };
    const before = g.window;
    g.window = { devicePixelRatio: 2 };
    try {
      expect(await sheet({ base: BASE, token: () => "tok" })).toContain("/full/200%2C/0/default.jpg?Authorization=tok");
    } finally {
      g.window = before;
    }
  });

  it("draws placeholders without access or without a token", async () => {
    for (const html of [await sheet(null), await sheet({ base: BASE, token: () => null })]) {
      expect(html).not.toContain("<img");
      expect(html.match(/bg-parchment-deep/g)).toHaveLength(3);
    }
  });
});

describe("strict mode", () => {
  it("renders the viewer inside React.StrictMode, with no dialog open and nothing unsaved", async () => {
    const Stub = createRoutesStub([
      {
        path: "/admin/capture/qc/:volumeId",
        Component: () =>
          React.createElement(
            React.StrictMode,
            null,
            React.createElement(ViewerPage, { loaderData: volume(4), actionData: undefined, params: { volumeId: "v-1" }, matches: [] } as any),
          ),
      },
    ]);
    const html = renderToStaticMarkup(
      React.createElement(I18nextProvider, { i18n: await i18n("en") }, React.createElement(Stub, { initialEntries: ["/admin/capture/qc/v-1"] })),
    );
    expect(mounted(html)).toEqual([1, 2, 3, 4]);
    expect(html).toContain(">Saved</span>");
    expect(html).not.toContain("Unsaved changes");
  });
});

describe("the top bar", () => {
  const bar = (props: { backTo: string; backLabel: string }) => {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () =>
          React.createElement(ViewerTopBar, {
            volumeName: "co-test-0001 · Test volume one",
            ...props,
            saveStatus: "saved",
            canUndo: true,
            canRedo: false,
            onUndo: () => {},
            onRedo: () => {},
          }),
      },
    ]);
    return renderNode(React.createElement(Stub, { initialEntries: ["/"] }));
  };

  it("links back where it is told, with Lucide icons", async () => {
    const qc = await bar({ backTo: "/admin/capture/qc", backLabel: "Back to capture QC" });
    expect(qc).toContain('aria-label="Back to capture QC" href="/admin/capture/qc"');
    expect(qc).toContain("lucide-arrow-left");
    expect(qc).toContain("lucide-undo");
    expect(qc).toContain("lucide-redo");
    expect(qc).not.toContain("M10.5 19.5 3 12");
    expect(qc).not.toContain("M9 15 3 9m0 0 6-6");

    const segmentation = await bar({ backTo: "/projects/p-1/volumes", backLabel: "Back to volumes" });
    expect(segmentation).toContain('aria-label="Back to volumes" href="/projects/p-1/volumes"');
  });
});

// @version v0.8.0
