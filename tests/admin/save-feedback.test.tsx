/**
 * Tests — shared admin save feedback
 *
 * This suite pins the contract behind the partner complaint that the
 * admin save buttons gave no feedback at all. Three layers:
 *
 *   1. `resolveSaveFeedback` — the pure normaliser that reads the four
 *      return dialects the admin actions grew up speaking. Covered
 *      shape by shape, because every surface that adopts the banner
 *      relies on this mapping being right for ITS action.
 *
 *   2. `shouldAutoDismiss` / `isPendingSubmission` — the two pure
 *      predicates behind the behaviours that cannot be observed in
 *      static markup. The auto-dismiss asymmetry is the point of the
 *      whole change: a success may disappear on a timer, a failure
 *      never may, because a failed save the archivist did not see is
 *      the original bug inverted.
 *
 *   3. Two rendered surfaces — `/configuracion` and the cataloguing
 *      users page — asserted for a success confirmation and for a
 *      persistent error. Rendering strategy mirrors
 *      `tests/imports/run-detail-step-label.test.tsx`:
 *      `renderToStaticMarkup` with an isolated `i18next` instance
 *      loaded with the real locale bundles, wrapped in
 *      `createRoutesStub` for the `<Form>` / `useNavigation` context
 *      the routes need. Both routes read `actionData` from
 *      `Route.ComponentProps` rather than `useActionData` precisely so
 *      the feedback states are reachable without a live submission.
 *
 *      Static markup runs the render body and initial `useState` but
 *      NOT `useEffect`, so the success banner is asserted in its
 *      just-arrived state — which is exactly the state under test. The
 *      dismissal timer that the effect arms is pinned at layer 2.
 *
 * @version v0.6.0
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { createRoutesStub } from "react-router";
import {
  resolveSaveFeedback,
  shouldAutoDismiss,
  isPendingSubmission,
} from "../../app/components/admin/save-feedback";
import enCommon from "../../app/locales/en/common";
import enSettings from "../../app/locales/en/settings";
import enAdmin from "../../app/locales/en/admin";
import esCommon from "../../app/locales/es/common";
import esSettings from "../../app/locales/es/settings";
import esAdmin from "../../app/locales/es/admin";
import ConfiguracionRoute from "../../app/routes/_auth.configuracion";
import CataloguingUsersRoute from "../../app/routes/_auth.admin.cataloguing.users";

const LABELS = { success: "SAVED_FALLBACK", error: "FAILED_FALLBACK" };

// ---------------------------------------------------------------------------
// Layer 1 — the resolver
// ---------------------------------------------------------------------------

describe("resolveSaveFeedback", () => {
  it("returns null before the first submission", () => {
    expect(resolveSaveFeedback(undefined, LABELS)).toBeNull();
    expect(resolveSaveFeedback(null, LABELS)).toBeNull();
  });

  it("returns null for a payload that reports no outcome", () => {
    // Fetchers carry unrelated payloads too (autosave acknowledgements,
    // for one). Those must not light up the banner.
    expect(resolveSaveFeedback({ autosaved: true }, LABELS)).toBeNull();
  });

  it("reads `{ ok: true, message }` as success with the action's own message", () => {
    expect(
      resolveSaveFeedback({ ok: true, message: "Member assigned" }, LABELS),
    ).toEqual({ kind: "success", message: "Member assigned" });
  });

  it("reads a message-less `{ ok: true }` as success with the fallback label", () => {
    expect(
      resolveSaveFeedback({ ok: true, intent: "updateProfile" }, LABELS),
    ).toEqual({ kind: "success", message: "SAVED_FALLBACK" });
  });

  it("reads `{ success: true }` as success with the fallback label", () => {
    expect(resolveSaveFeedback({ success: true }, LABELS)).toEqual({
      kind: "success",
      message: "SAVED_FALLBACK",
    });
  });

  it("reads `{ ok: false, error }` as error with the action's own message", () => {
    expect(
      resolveSaveFeedback(
        { ok: false, error: "That address is already in use" },
        LABELS,
      ),
    ).toEqual({ kind: "error", message: "That address is already in use" });
  });

  it("reads a message-less `{ ok: false }` as error with the fallback label", () => {
    expect(resolveSaveFeedback({ ok: false }, LABELS)).toEqual({
      kind: "error",
      message: "FAILED_FALLBACK",
    });
  });

  it("reads a bare `{ error }` as error", () => {
    expect(resolveSaveFeedback({ error: "Invalid name" }, LABELS)).toEqual({
      kind: "error",
      message: "Invalid name",
    });
  });

  it("reads field-level `{ errors }` as an error summary", () => {
    // The fields render their own messages, but they may be scrolled
    // off screen; the banner is what says the save did not land.
    expect(
      resolveSaveFeedback({ errors: { email: "Required" } }, LABELS),
    ).toEqual({ kind: "error", message: "FAILED_FALLBACK" });
  });

  it("ignores an empty `errors` bag", () => {
    expect(resolveSaveFeedback({ errors: {} }, LABELS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — the predicates
// ---------------------------------------------------------------------------

describe("shouldAutoDismiss", () => {
  it("lets a success confirmation dismiss itself", () => {
    expect(shouldAutoDismiss("success")).toBe(true);
  });

  it("never lets an error dismiss itself", () => {
    // The whole point of the change: an unseen failure is worse than
    // the silence it replaced.
    expect(shouldAutoDismiss("error")).toBe(false);
  });
});

describe("isPendingSubmission", () => {
  function fd(entries: Record<string, string>): FormData {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.append(k, v);
    return f;
  }

  it("is false while idle", () => {
    expect(isPendingSubmission("idle", fd({ _action: "updateProfile" }), "updateProfile")).toBe(false);
  });

  it("is true only for the form whose _action is in flight", () => {
    const inFlight = fd({ _action: "updateProfile" });
    expect(isPendingSubmission("submitting", inFlight, "updateProfile")).toBe(true);
    expect(isPendingSubmission("submitting", inFlight, "updateRoles")).toBe(false);
  });

  it("stays busy through the loading phase that follows the action", () => {
    expect(
      isPendingSubmission("loading", fd({ _action: "inviteUser" }), "inviteUser"),
    ).toBe(true);
  });

  it("honours an alternate discriminator field", () => {
    // The vocabularies pages discriminate on `intent`, not `_action`.
    expect(
      isPendingSubmission("submitting", fd({ intent: "save" }), "save", "intent"),
    ).toBe(true);
    expect(isPendingSubmission("submitting", fd({ intent: "save" }), "save")).toBe(false);
  });

  it("treats any non-idle state as busy when no discriminator is given", () => {
    expect(isPendingSubmission("submitting", undefined)).toBe(true);
    expect(isPendingSubmission("idle", undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — the rendered surfaces
// ---------------------------------------------------------------------------

async function makeI18n(lang: "en" | "es") {
  const inst = i18next.createInstance();
  await (inst.init as (opts: unknown) => Promise<unknown>)({
    lng: lang,
    fallbackLng: "es",
    defaultNS: "common",
    resources: {
      en: { common: enCommon, settings: enSettings, admin: enAdmin },
      es: { common: esCommon, settings: esSettings, admin: esAdmin },
    },
    interpolation: { escapeValue: false },
  });
  return inst;
}

async function render(
  lang: "en" | "es",
  path: string,
  Component: React.ComponentType<never>,
  props: Record<string, unknown>,
): Promise<string> {
  const inst = await makeI18n(lang);
  const Stub = createRoutesStub([
    {
      path,
      Component: () => React.createElement(Component, props as never),
    },
  ]);
  return renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n: inst },
      React.createElement(Stub, { initialEntries: [path] }),
    ),
  );
}

/** Account settings — `{ ok: true, intent }` / `{ ok: false }`. */
function renderConfiguracion(lang: "en" | "es", actionData: unknown) {
  return render(lang, "/configuracion", ConfiguracionRoute, {
    loaderData: {
      user: { id: "u1", name: "Ana", email: "ana@example.org", githubId: null },
    },
    actionData,
    params: {},
    matches: [],
  });
}

/** Cataloguing users — `{ ok, message }` / `{ ok: false, error }`. */
function renderCataloguingUsers(lang: "en" | "es", actionData: unknown) {
  return render(lang, "/admin/cataloguing/users", CataloguingUsersRoute, {
    loaderData: {
      users: [],
      currentUser: { id: "u1", isSuperAdmin: true, isCollabAdmin: true },
      tenant: { crowdsourcingEnabled: true },
    },
    actionData,
    params: {},
    matches: [],
  });
}

describe("account settings — save feedback", () => {
  it("renders no banner before the first submission", async () => {
    const html = await renderConfiguracion("en", undefined);
    expect(html).not.toContain("Changes saved");
    expect(html).not.toContain("Changes were not saved");
  });

  it("renders the success confirmation in a polite live region", async () => {
    const html = await renderConfiguracion("en", {
      ok: true,
      intent: "updateProfile",
    });
    // The route supplies its own success wording via `settings:saved`.
    expect(html).toContain("Changes saved");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("renders a message-less failure as a persistent alert", async () => {
    const html = await renderConfiguracion("en", { ok: false });
    expect(html).toContain("Changes were not saved");
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    // The failure must not also read as a success.
    expect(html).not.toContain("Changes saved<");
  });

  it("renders the Spanish success confirmation", async () => {
    const html = await renderConfiguracion("es", {
      ok: true,
      intent: "updateProfile",
    });
    expect(html).toContain("Cambios guardados");
  });

  it("renders the Spanish failure line", async () => {
    const html = await renderConfiguracion("es", { ok: false });
    expect(html).toContain("No se guardaron los cambios");
  });

  it("keeps both live regions in the tree even with nothing to announce", async () => {
    // Assistive technology only reliably announces content that appears
    // inside a region already present in the accessibility tree, so the
    // wrappers render whether or not there is a message.
    const html = await renderConfiguracion("en", undefined);
    expect(html).toContain('role="status"');
    expect(html).toContain('role="alert"');
  });
});

describe("cataloguing users — save feedback", () => {
  it("renders the action's own success message", async () => {
    const html = await renderCataloguingUsers("en", {
      ok: true,
      message: "Invitation sent to ana@example.org",
    });
    expect(html).toContain("Invitation sent to ana@example.org");
    expect(html).toContain('role="status"');
  });

  it("renders the action's own error message as a persistent alert", async () => {
    const html = await renderCataloguingUsers("en", {
      ok: false,
      error: "That address already has an account",
    });
    expect(html).toContain("That address already has an account");
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
  });

  it("falls back to the shared Spanish failure line when the action gives no message", async () => {
    const html = await renderCataloguingUsers("es", { ok: false });
    expect(html).toContain("No se guardaron los cambios");
  });

  it("renders the idle submit label, not the busy one", async () => {
    // The busy label only appears while a submission is in flight;
    // a static render is by definition idle.
    const html = await renderCataloguingUsers("en", undefined);
    expect(html).not.toContain("Saving...");
  });
});
