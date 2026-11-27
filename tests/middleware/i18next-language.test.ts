/**
 * Tests — i18next middleware language detection and the `lang` cookie
 *
 * This suite pins the order in which the server picks the interface
 * language and the cookie that keeps a chosen language across requests.
 * Before the cookie existed, a signed-in user who picked Spanish got
 * English back on the next request whenever their browser asked for
 * English, because the server read only `?lang=` and Accept-Language.
 *
 * Coverage:
 *   1. `?lang=` wins over the `lang` cookie.
 *   2. The `lang` cookie wins over Accept-Language, and the request's
 *      i18next instance translates into the cookie's language (the
 *      refresh case).
 *   3. Accept-Language applies when there is no cookie, and Spanish is
 *      the fallback when nothing names a supported language.
 *   4. A supported `?lang=` sets the cookie on the response (host-only,
 *      Path=/, SameSite=Lax, a year's Max-Age, Secure only on https),
 *      and that cookie sent back selects the same language.
 *   5. An unsupported or absent `?lang=` sets no cookie.
 *   5a. A `?lang=` left in the URL of a form submission sets no cookie,
 *      and a response that already sets `lang` (the settings action)
 *      keeps its own as the only `lang` cookie.
 *   6. `signInLanguageCookie` writes the saved locale only when the
 *      browser has no `lang` cookie yet.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { RouterContextProvider } from "react-router";
import {
  i18nextMiddleware,
  getLocale,
  getInstance,
} from "../../app/middleware/i18next";
import {
  serializeLanguageCookie,
  signInLanguageCookie,
} from "../../app/lib/language-cookie.server";
import esCommon from "../../app/locales/es/common";
import enCommon from "../../app/locales/en/common";

/** The `name=value` part of a Set-Cookie header, usable as a Cookie header. */
function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0];
}

async function run(
  url: string,
  headers: Record<string, string> = {},
  init: { method?: string; downstream?: () => Promise<Response> } = {},
): Promise<{ context: RouterContextProvider; response: Response }> {
  const request = new Request(url, { headers, method: init.method ?? "GET" });
  const context = new RouterContextProvider();
  const response = (await i18nextMiddleware(
    { request, context, params: {} } as any,
    init.downstream ?? (async () => new Response("ok")),
  )) as Response;
  return { context, response };
}

async function esCookieHeader(): Promise<string> {
  const setCookie = await serializeLanguageCookie(
    "es",
    new Request("https://neogranadina.fisqua.test/"),
  );
  return cookiePair(setCookie);
}

describe("i18next middleware language detection order", () => {
  it("prefers ?lang= over the lang cookie", async () => {
    const { context } = await run(
      "https://neogranadina.fisqua.test/dashboard?lang=en",
      { Cookie: await esCookieHeader(), "Accept-Language": "es" },
    );
    expect(getLocale(context)).toBe("en");
  });

  it("prefers the lang cookie over Accept-Language, and renders in it", async () => {
    const { context } = await run("https://neogranadina.fisqua.test/dashboard", {
      Cookie: await esCookieHeader(),
      "Accept-Language": "en-US,en;q=0.9",
    });
    expect(getLocale(context)).toBe("es");
    const t = getInstance(context).t;
    expect(t("error.not_found", { ns: "common" })).toBe(esCommon.error.not_found);
    expect(esCommon.error.not_found).not.toBe(enCommon.error.not_found);
  });

  it("uses Accept-Language when there is no cookie", async () => {
    const { context } = await run("https://neogranadina.fisqua.test/dashboard", {
      "Accept-Language": "en-US,en;q=0.9",
    });
    expect(getLocale(context)).toBe("en");
  });

  it("falls back to Spanish when nothing names a supported language", async () => {
    const { context } = await run("https://neogranadina.fisqua.test/dashboard", {
      "Accept-Language": "fr-FR",
    });
    expect(getLocale(context)).toBe("es");
  });

  it("ignores a lang cookie that names an unsupported language", async () => {
    const { context } = await run("https://neogranadina.fisqua.test/dashboard", {
      Cookie: "lang=ImZyIg%3D%3D", // "fr", encoded as React Router encodes it
      "Accept-Language": "en",
    });
    expect(getLocale(context)).toBe("en");
  });
});

describe("i18next middleware lang cookie", () => {
  it("sets the lang cookie when ?lang= names a supported language", async () => {
    const { response } = await run("https://fisqua.test/?lang=es", {
      "Accept-Language": "en",
    });
    const setCookie = response.headers.get("Set-Cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toMatch(/^lang=/);
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=31536000");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).not.toMatch(/Domain=/i);

    // The next request, with the cookie and no ?lang=, stays Spanish.
    const { context } = await run("https://fisqua.test/", {
      Cookie: cookiePair(setCookie!),
      "Accept-Language": "en",
    });
    expect(getLocale(context)).toBe("es");
  });

  it("omits Secure on plain http", async () => {
    const { response } = await run("http://neogranadina.localhost:5173/?lang=en");
    const setCookie = response.headers.get("Set-Cookie");
    expect(setCookie).toMatch(/^lang=/);
    expect(setCookie).not.toContain("Secure");
  });

  it("sets no cookie for an unsupported ?lang=", async () => {
    const { response } = await run("https://fisqua.test/?lang=fr");
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("sets no cookie for a form submission whose URL still carries ?lang=", async () => {
    const { response } = await run(
      "https://neogranadina.fisqua.test/configuracion?lang=en",
      {},
      { method: "POST" },
    );
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("keeps a lang cookie the response already sets as the only one", async () => {
    const chosen = await serializeLanguageCookie(
      "es",
      new Request("https://neogranadina.fisqua.test/configuracion"),
    );
    const { response } = await run(
      "https://neogranadina.fisqua.test/configuracion?lang=en",
      {},
      {
        downstream: async () =>
          new Response("ok", { headers: { "Set-Cookie": chosen } }),
      },
    );
    const langCookies = response.headers
      .getSetCookie()
      .filter((c) => c.startsWith("lang="));
    expect(langCookies).toEqual([chosen]);
  });

  it("sets no cookie when the request has no ?lang=", async () => {
    const { response } = await run("https://fisqua.test/", {
      Cookie: await esCookieHeader(),
    });
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("signInLanguageCookie", () => {
  it("writes the saved locale when the browser has no lang cookie", async () => {
    const header = await signInLanguageCookie(
      new Request("https://neogranadina.fisqua.test/auth/verify"),
      "en",
    );
    expect(header).toMatch(/^lang=/);
    const { context } = await run("https://neogranadina.fisqua.test/dashboard", {
      Cookie: cookiePair(header!),
      "Accept-Language": "es",
    });
    expect(getLocale(context)).toBe("en");
  });

  it("leaves an existing lang cookie alone", async () => {
    const header = await signInLanguageCookie(
      new Request("https://neogranadina.fisqua.test/auth/verify", {
        headers: { Cookie: await esCookieHeader() },
      }),
      "en",
    );
    expect(header).toBeNull();
  });

  it("writes nothing when the URL carries an explicit ?lang=", async () => {
    const header = await signInLanguageCookie(
      new Request("https://neogranadina.fisqua.test/auth/verify?token=t&lang=es"),
      "en",
    );
    expect(header).toBeNull();
  });

  it("writes nothing when the user has no saved locale", async () => {
    const header = await signInLanguageCookie(
      new Request("https://neogranadina.fisqua.test/auth/verify"),
      null,
    );
    expect(header).toBeNull();
  });
});

// @version v0.9.0
