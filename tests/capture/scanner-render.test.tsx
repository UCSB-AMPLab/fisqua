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
 * answer is pinned in `scanner.test.ts`. A worker who does not manage
 * the scanner (`canManage` false) sees the device and the token's dates
 * with no control, and a note that only digitization administrators
 * change the token.
 *
 * Pairing: a manager whose workspace has usable stored keys sees the
 * code field and Look up (disabled while the field is empty); without
 * stored keys, or with erased ones, the section says that Fisqua holds no
 * bucket keys and shows no field, and an erasure shows its date. The
 * lookup's confirmation, the Revoke confirmation and the erase
 * confirmation open only after a click, so they are rendered here as the
 * parts they are (`scanner-parts.tsx`): the confirmation lists the code,
 * the unit name and device id as plain text, the unit's reported
 * workspace and the warning for a workspace with a linked unit; Revoke
 * asks for one of two reasons and keeps its button disabled until one is
 * chosen. Every error the action can answer has its own message, shown
 * only in the section the request was sent from, never while a request
 * is in flight, and not once a confirmation has been opened since
 * (`shownError`). The pairing confirmation also names the workspace,
 * and sets the unit name, which is free text, in the page's sans type.
 * Where focus goes when a confirmation closes is decided by
 * `focusAfterClose`, pinned here; moving the focus itself needs a browser
 * and is not tested. A worker who does not manage sees none of the
 * pairing or erasing controls. The sentence after a success
 * (`actionNotice`) covers a compromised revoke in four cases (stored
 * keys erased or none held; operators told or not) and Erase stored keys
 * in two, and asks the administrator to contact an operator directly
 * when none was told.
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
import enCapture from "../../app/locales/en/capture";
import esCapture from "../../app/locales/es/capture";
import enSidebar from "../../app/locales/en/sidebar";
import esSidebar from "../../app/locales/es/sidebar";
import enCommon from "../../app/locales/en/common";
import esCommon from "../../app/locales/es/common";
import ScannerPage from "../../app/routes/_auth.admin.capture.scanner";
import type { PairingView, ScannerView, StoredKeysState } from "../../app/lib/capture/scanner.server";
import { actionNotice, Confirm, focusAfterClose, PairConfirm, scannerErrorMessage, shownError } from "../../app/components/capture/scanner-parts";
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

const KEYS: StoredKeysState = { applianceId: "rig-1", usable: true, erasedAt: null, revision: 3 };

interface Extra {
  storedKeys?: StoredKeysState | null;
}

async function render(lang: "en" | "es", scanner: ScannerView | null, canManage = true, extra: Extra = {}) {
  const loaderData = {
    scanner,
    version: scanner?.version ?? "none",
    workspace: "Test Archive",
    canManage,
    // As the loader gives it: the stored keys' state only to those who manage.
    storedKeys: extra.storedKeys === undefined ? (canManage ? KEYS : null) : extra.storedKeys,
  };
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
    mode: null,
    modeReportedAt: null,
    version: "s-1:1",
    unitName: null,
    deviceId: null,
    ...overrides,
  };
}

const STORAGE_NOTE =
  "The scanner&#x27;s bucket keys are delivered when a unit is paired, once a Fisqua operator has stored them.";
const STORAGE_NOTE_ES =
  "Fisqua le entrega las claves del bucket del escáner al equipo cuando se vincula, siempre que un operador de Fisqua las haya guardado antes.";
const NO_KEYS =
  "Fisqua holds no bucket keys for this workspace, so no unit can be paired. A Fisqua operator must store them first.";

/** Renders one of the page's parts, outside the page, in `lang`. */
async function part(lang: "en" | "es", element: React.ReactElement) {
  return renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: await i18n(lang) }, element));
}

const PAIRING: PairingView = {
  code: "7KQ-M2X",
  unitName: "Sala <b>norte</b>",
  deviceId: "cap-01",
  currentTenant: null,
  replacesLinkedUnit: false,
};

const noop = () => {};

describe("Scanner, rendered", () => {
  it("shows the mode the unit last reported, or that it has reported none", async () => {
    const reported = await render("en", view({ mode: "backup", modeReportedAt: T0 }));
    expect(reported).toContain("Mode");
    expect(reported).toContain("Offsite copy only");
    expect(await render("en", view({}))).toContain("Not reported yet");
    expect(await render("es", view({ mode: "offline", modeReportedAt: T0 }))).toContain("Solo en el escáner");
  });

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
    expect(html).toContain("Appliance id");
    expect(html).toContain("The unit&#x27;s appliance id, as it appears in its key file");
    expect(html).toMatch(/<button type="submit"[^>]*>Make token<\/button>/);
    expect(html).not.toContain("Replace token");
    expect(html).toContain(STORAGE_NOTE);
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

  it("without canManage: the device and the token's dates, no control, and who changes the token", async () => {
    const active = await render("en", view({}), false);
    expect(active).toContain("Linked");
    expect(active).toContain("Not visible");
    expect(active).toContain("Only digitization administrators can make, replace or revoke the scanner&#x27;s token.");
    for (const control of ["Replace token", ">Revoke</button>", "Make token", "<input"]) expect(active).not.toContain(control);
    const none = await render("en", null, false);
    expect(none).not.toContain("Make token");
    expect(none).not.toContain("<input");
    expect(none).toContain("Only digitization administrators can make, replace or revoke the scanner&#x27;s token.");
    expect(await render("es", view({}), false)).toContain("Solo quienes administran la digitalización pueden crear, reemplazar o revocar el token del escáner.");
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
    expect(none).toContain("Identificador del equipo");
    expect(none).toContain(STORAGE_NOTE_ES);
    const linked = await render("es", view({}));
    expect(linked).toContain("Vinculado");
    expect(linked).toContain(">Reemplazar token</button>");
    expect(linked).toContain(">Revocar</button>");
    const revoked = await render("es", view({ tokenState: "revoked", deviceState: "revoked", revokedAt: T0 }));
    expect(revoked).toMatch(/<dt[^>]*>Revocado<\/dt>/);
    expect(revoked).toContain("El equipo no puede comunicarse con Fisqua hasta que tenga un token nuevo.");
  });
});

describe("Scanner, the device section", () => {
  it("labels the scanner's name Appliance id, and shows the linked unit when known", async () => {
    const html = await render("en", view({ unitName: "Reading room", deviceId: "dev-7" }));
    expect(html).toMatch(/<dt[^>]*>Appliance id<\/dt><dd[^>]*><span class="font-mono">rig-1<\/span>/);
    expect(html).toMatch(/<dt[^>]*>Unit name<\/dt><dd[^>]*>Reading room<\/dd>/);
    expect(html).toMatch(/<dt[^>]*>Device id<\/dt><dd[^>]*><span class="font-mono">dev-7<\/span>/);
    const unknown = await render("en", view({}));
    expect(unknown).not.toContain("Unit name");
    expect(unknown).not.toContain("Device id");
  });

  it("shows the linked unit to a worker who does not manage, read-only", async () => {
    const html = await render("en", view({ unitName: "Reading room", deviceId: "dev-7" }), false);
    expect(html).toContain("Reading room");
    expect(html).toContain("dev-7");
    expect(html).toContain(STORAGE_NOTE);
  });
});

describe("Scanner, pairing", () => {
  it("a manager with usable stored keys gets the code field and Look up, disabled while empty", async () => {
    const html = await render("en", view({}));
    expect(html).toContain(">Pair a unit</h2>");
    const input = html.match(/<input[^>]*name="code"[^>]*>/)?.[0] ?? "";
    expect(input).not.toBe("");
    for (const attr of ['autoComplete="off"', 'autoCapitalize="characters"', 'spellCheck="false"', 'inputMode="text"']) {
      expect(input.toLowerCase()).toContain(attr.toLowerCase());
    }
    expect(input).toContain("font-mono");
    expect(html).toMatch(/<label[^>]*>Code<\/label>/);
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Look up<\/button>/);
    expect(html).not.toContain(NO_KEYS);
  });

  it("pairs with no scanner yet too", async () => {
    expect(await render("en", null)).toMatch(/<input[^>]*name="code"/);
  });

  it("without stored keys: the no-keys sentence and no field", async () => {
    const html = await render("en", view({}), true, { storedKeys: null });
    expect(html).toContain(">Pair a unit</h2>");
    expect(html).toContain(NO_KEYS);
    expect(html).not.toMatch(/name="code"/);
    expect(html).not.toContain("Look up");
    expect(html).not.toContain("Erase stored keys");
  });

  it("with erased keys: the no-keys sentence, when they were erased, and no field", async () => {
    const html = await render("en", view({}), true, {
      storedKeys: { applianceId: "rig-1", usable: false, erasedAt: Date.UTC(2026, 10, 2, 12), revision: 4 },
    });
    expect(html).toContain(NO_KEYS);
    expect(html).toMatch(/<dt[^>]*>Stored keys erased<\/dt><dd[^>]*>[^<]*2026[^<]*<\/dd>/);
    expect(html).not.toMatch(/name="code"/);
    expect(html).not.toContain("Erase stored keys");
  });

  it("the confirmation lists the code, the unit name, the device id and the workspace as plain text", async () => {
    const html = await part("en", React.createElement(PairConfirm, { pairing: PAIRING, workspace: "Test Archive", busy: false, onCancel: noop, onApprove: noop }));
    expect(html).toContain("Approve this unit?");
    expect(html).toMatch(/<dd[^>]*><span class="font-mono">7KQ-M2X<\/span>/);
    expect(html).toMatch(/<dt[^>]*>Unit name<\/dt><dd[^>]*>Sala &lt;b&gt;norte&lt;\/b&gt;<\/dd>/);
    expect(html).toMatch(/<dt[^>]*>Workspace<\/dt><dd[^>]*>Test Archive<\/dd>/);
    expect(html).not.toContain("<b>norte</b>");
    expect(html).toMatch(/<dd[^>]*><span class="font-mono">cap-01<\/span>/);
    expect(html).toContain(">Approve</button>");
    expect(html).toContain(">Cancel</button>");
    expect(html).not.toContain("currently linked to");
    expect(html).not.toContain("is already linked");
  });

  it("the confirmation says what workspace the unit reports, and warns when a unit is linked", async () => {
    const html = await part(
      "en",
      React.createElement(PairConfirm, {
        pairing: { ...PAIRING, currentTenant: "other-archive", replacesLinkedUnit: true },
        workspace: "Test Archive",
        busy: false,
        onCancel: noop,
        onApprove: noop,
      }),
    );
    expect(html).toContain("The unit reports it is currently linked to other-archive.");
    expect(html).toContain(
      "A unit is already linked to this workspace. Once this unit collects its settings, the linked unit can no longer call Fisqua, but it keeps the bucket keys until they are revoked in B2. If that unit is out of the archive&#x27;s hands, use Erase stored keys.",
    );
    const es = await part(
      "es",
      React.createElement(PairConfirm, {
        pairing: { ...PAIRING, currentTenant: "other-archive", replacesLinkedUnit: true },
        workspace: "Test Archive",
        busy: false,
        onCancel: noop,
        onApprove: noop,
      }),
    );
    expect(es).toContain("other-archive");
    expect(es).toContain(">Aprobar</button>");
    expect(es).toMatch(/<dt[^>]*>Espacio de trabajo<\/dt><dd[^>]*>Test Archive<\/dd>/);
  });

  it("each pairing error has its own message, and the wait is given in minutes", async () => {
    const t = (await i18n("en")).getFixedT("en", "capture");
    expect(scannerErrorMessage(t, "pair", { ok: false, error: "pair_unknown" })).toBe(
      "No unit is waiting with that code. Check the code and try again.",
    );
    expect(scannerErrorMessage(t, "pair", { ok: false, error: "pair_not_waiting" })).toBe(
      "This code has expired or was already used. Ask the unit for a new one.",
    );
    expect(scannerErrorMessage(t, "pair", { ok: false, error: "pair_no_keys" })).toBe(NO_KEYS);
    expect(scannerErrorMessage(t, "pair", { ok: false, error: "pair_limited", retryAfterSeconds: 30 })).toBe(
      "Too many wrong codes. Codes are accepted again in less than a minute.",
    );
    expect(scannerErrorMessage(t, "pair", { ok: false, error: "pair_limited", retryAfterSeconds: 60 })).toBe(
      "Too many wrong codes. Codes are accepted again in about 1 minute.",
    );
    expect(scannerErrorMessage(t, "pair", { ok: false, error: "pair_limited", retryAfterSeconds: 61 })).toBe(
      "Too many wrong codes. Codes are accepted again in about 2 minutes.",
    );
    expect(scannerErrorMessage(t, "pair", { ok: false, error: "pair_keys_unreadable" })).toBe(
      "Fisqua cannot read the stored keys of this workspace, so no unit can be paired. Ask a Fisqua operator.",
    );
    expect(scannerErrorMessage(t, "pair", { ok: false, error: "changed" })).toBe(
      "The scanner or its stored keys changed while this page was open. Reload the page and try again.",
    );
    const errors = [
      "invalid_request", "invalid_name", "unconfirmed", "changed", "no_stored_keys", "live_token", "no_scanner",
      "no_live_token", "name_mismatch", "several_scanners", "pair_unknown", "pair_not_waiting", "pair_no_keys", "pair_limited",
      "pair_keys_unreadable",
    ] as const;
    for (const lang of ["en", "es"] as const) {
      const tl = (await i18n(lang)).getFixedT(lang, "capture");
      for (const area of ["token", "pair", "erase"] as const) {
        for (const error of errors) {
          const message = scannerErrorMessage(tl, area, { ok: false, error, retryAfterSeconds: 120 });
          expect(message, `${lang} ${area} ${error}`).not.toMatch(/^scanner\./);
          expect(message.length).toBeGreaterThan(10);
        }
      }
    }
  });
});

describe("Scanner, which error is shown", () => {
  const refused = { ok: false as const, error: "pair_unknown" as const };

  it("shows an answer's error only in the section its request was sent from", async () => {
    const t = (await i18n("en")).getFixedT("en", "capture");
    expect(shownError(t, "pair", { busy: false, sentFrom: "pair", answer: refused })).toBe(
      "No unit is waiting with that code. Check the code and try again.",
    );
    expect(shownError(t, "token", { busy: false, sentFrom: "pair", answer: refused })).toBeNull();
    expect(shownError(t, "erase", { busy: false, sentFrom: "pair", answer: refused })).toBeNull();
  });

  it("shows no error while a request is in flight, not even the previous answer's", async () => {
    const t = (await i18n("en")).getFixedT("en", "capture");
    expect(shownError(t, "pair", { busy: true, sentFrom: "pair", answer: refused })).toBeNull();
    expect(shownError(t, "token", { busy: true, sentFrom: "token", answer: refused })).toBeNull();
  });

  it("shows no error once it has been dismissed by opening a confirmation, or after a success", async () => {
    const t = (await i18n("en")).getFixedT("en", "capture");
    expect(shownError(t, "pair", { busy: false, sentFrom: null, answer: refused })).toBeNull();
    expect(shownError(t, "pair", { busy: false, sentFrom: "pair", answer: { ok: true, step: "pair_approve" } })).toBeNull();
    expect(shownError(t, "pair", { busy: false, sentFrom: "pair", answer: undefined })).toBeNull();
  });
});

describe("Scanner, the sentence after a success", () => {
  const revoke = (keysErased: boolean, operatorsNotified: boolean) =>
    ({ ok: true, step: "revoke", keysErased, operatorsNotified }) as const;

  it("after a compromised revoke, says what was erased and whether the operators were told, in four cases", async () => {
    const t = (await i18n("en")).getFixedT("en", "capture");
    const say = (keysErased: boolean, operatorsNotified: boolean) => {
      const notice = actionNotice(revoke(keysErased, operatorsNotified), "compromised");
      expect(notice?.area).toBe("token");
      return t(`scanner.${notice!.key}`);
    };
    expect(say(true, true)).toBe(
      "The stored keys were erased, and Fisqua's operators have been told to revoke the unit's keys in B2.",
    );
    expect(say(true, false)).toBe(
      "The stored keys were erased, but no Fisqua operator could be told. Contact a Fisqua operator directly: the unit's keys work in B2 until an operator revokes them there.",
    );
    expect(say(false, true)).toBe(
      "Fisqua held no stored keys for this workspace, so none were erased. Fisqua's operators have been told to revoke the unit's keys in B2.",
    );
    expect(say(false, false)).toBe(
      "Fisqua held no stored keys for this workspace, so none were erased, and no Fisqua operator could be told. Contact a Fisqua operator directly: the unit's keys work in B2 until an operator revokes them there.",
    );
  });

  it("after Erase stored keys, says whether the operators were told", async () => {
    const t = (await i18n("en")).getFixedT("en", "capture");
    const erased = (operatorsNotified: boolean) =>
      actionNotice({ ok: true, step: "erase_keys", keysErased: true, operatorsNotified }, null);
    expect(erased(true)).toEqual({ area: "erase", key: "erased_notified" });
    expect(t(`scanner.${erased(false)!.key}`)).toBe(
      "The stored keys were erased, but no Fisqua operator could be told. Contact a Fisqua operator directly: the keys work in B2 until an operator revokes them there.",
    );
  });

  it("says nothing after a revoke for a reset or replaced unit, and gives the approval its own sentence", () => {
    expect(actionNotice({ ok: true, step: "revoke", keysErased: false }, "replaced")).toBeNull();
    expect(actionNotice({ ok: true, step: "pair_approve" }, null)).toEqual({ area: "pair", key: "pair_approved" });
  });

  it("has every sentence in English and Spanish", async () => {
    const keys = [
      "pair_approved", "revoked_erased_notified", "revoked_erased_unnotified", "revoked_none_stored_notified",
      "revoked_none_stored_unnotified", "erased_notified", "erased_unnotified",
    ];
    for (const lang of ["en", "es"] as const) {
      const t = (await i18n(lang)).getFixedT(lang, "capture");
      for (const key of keys) expect(t(`scanner.${key}`), `${lang} ${key}`).not.toMatch(/^scanner\./);
    }
  });
});

describe("Scanner, where focus goes when a confirmation closes", () => {
  const enabled = { disabled: false };

  it("waits while the request or its revalidation is in flight, even with the button on the page", () => {
    expect(focusAfterClose({ busy: true, newToken: false, opener: enabled })).toBe("wait");
    expect(focusAfterClose({ busy: true, newToken: false, opener: { disabled: true } })).toBe("wait");
  });

  it("goes back to the button that opened it, once nothing is in flight and the button is enabled", () => {
    expect(focusAfterClose({ busy: false, newToken: false, opener: enabled })).toBe("opener");
  });

  it("goes to the section when the button is gone or disabled", () => {
    expect(focusAfterClose({ busy: false, newToken: false, opener: null })).toBe("section");
    expect(focusAfterClose({ busy: false, newToken: false, opener: { disabled: true } })).toBe("section");
  });

  it("leaves focus to a new token, which takes it itself", () => {
    expect(focusAfterClose({ busy: false, newToken: true, opener: enabled })).toBe("none");
  });
});

describe("Scanner, revoke and erase", () => {
  it("Revoke asks why, with no default, and its button is disabled until a reason is chosen", async () => {
    const html = await part("en", React.createElement(Confirm, { kind: "revoke", busy: false, onCancel: noop, onConfirm: noop }));
    expect(html).toMatch(/<fieldset[^>]*><legend[^>]*>Why are you revoking it\?<\/legend>/);
    const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(2);
    for (const r of radios) expect(r).not.toContain("checked");
    expect(html).toContain('value="replaced"');
    expect(html).toContain('value="compromised"');
    expect(html).toContain("The unit was reset or replaced");
    expect(html).toContain("The unit was lost, stolen or compromised");
    expect(html).toContain(
      "The stored keys are erased, and Fisqua&#x27;s operators are told to revoke them in B2. No unit can be paired until an operator stores new keys.",
    );
    expect(html).toMatch(/<button type="button"[^>]*disabled=""[^>]*>Revoke token<\/button>/);
  });

  it("Replace asks no reason", async () => {
    const html = await part("en", React.createElement(Confirm, { kind: "replace", busy: false, onCancel: noop, onConfirm: noop }));
    expect(html).not.toContain("<fieldset");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Replace token<\/button>/);
  });

  it("Erase stored keys: offered to a manager whose keys are usable, with its own confirmation", async () => {
    const html = await render("en", view({}));
    expect(html).toMatch(/<button type="button"[^>]*>Erase stored keys<\/button>/);
    const confirm = await part("en", React.createElement(Confirm, { kind: "erase", busy: false, onCancel: noop, onConfirm: noop }));
    expect(confirm).toContain("Erase the stored keys?");
    expect(confirm).toContain(
      "Fisqua deletes its copy of the scanner&#x27;s bucket keys and tells its operators to revoke them in B2. A unit that holds the keys keeps working with them until they are revoked in B2. No unit can be paired until an operator stores new keys. Erasing is not reversible.",
    );
    expect(confirm).toContain(">Erase keys</button>");
  });

  it("no resting button is madder: Revoke and Erase stored keys wait for their confirmation", async () => {
    const html = await render("en", view({}));
    expect(html).not.toContain("bg-madder ");
  });

  it("a worker who does not manage sees none of the controls", async () => {
    const html = await render("en", view({ unitName: "Reading room", deviceId: "dev-7" }), false);
    for (const control of ["Pair a unit", "Look up", 'name="code"', "Erase stored keys", "Replace token", ">Revoke</button>", "<button"]) {
      expect(html, control).not.toContain(control);
    }
    const noKeys = await render("en", view({}), false, { storedKeys: null });
    expect(noKeys).not.toContain(NO_KEYS);
  });
});

// @version v0.9.0
