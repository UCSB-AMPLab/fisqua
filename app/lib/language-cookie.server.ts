/**
 * Language Cookie
 *
 * This module deals with the `lang` cookie, the one place the reader's
 * chosen interface language persists between requests. The i18next
 * middleware (`app/middleware/i18next.ts`) reads it on every request,
 * after an explicit `?lang=` and before the Accept-Language header, so
 * a language chosen once keeps applying until it is changed.
 *
 * Three places write it:
 *   - the i18next middleware, on any response to a request that carries
 *     a supported `?lang=` (the landing page's EN / ES toggle);
 *   - the `/configuracion` action, when a signed-in user picks a
 *     language there (the same request also saves `users.locale`);
 *   - the sign-in routes, from the user's saved `users.locale`, when
 *     the browser has no `lang` cookie on that host yet and the
 *     sign-in URL names no language of its own.
 *
 * `languageCookie` is the React Router cookie object the middleware's
 * detector parses. `serializeLanguageCookie` builds the Set-Cookie
 * header for a request, adding `Secure` when the request came over
 * https (the vite dev server serves plain http on `*.localhost`, where
 * browsers drop a Secure cookie). `readLanguageCookie` returns the
 * supported language the request's cookie names, or null.
 * `signInLanguageCookie` is the sign-in rule: a header only when the
 * user has a saved locale, the request carries no `lang` cookie, and
 * its URL has no supported `?lang=`. A language already chosen in this
 * browser, or named in the sign-in link, keeps precedence over the
 * account's saved one, as it does in the detection order; for the
 * `?lang=` case the i18next middleware records the cookie, which it
 * does only when the response sets none.
 *
 * The cookie is host-only (no `Domain`), like the `__session` cookie
 * in `app/sessions.server.ts`. Workspaces are subdomains of
 * `fisqua.org`, and `users` rows belong to one workspace, so a choice
 * made on one workspace is not carried to another; a
 * `Domain=fisqua.org` cookie would also be sent to
 * `*.staging.fisqua.org`, and it cannot be set at all on the local
 * development hosts or on legacy hosts outside `fisqua.org`. A user
 * arriving on their workspace gets their saved language at sign-in.
 *
 * The cookie is unsigned and HttpOnly: only the server reads or writes
 * it, and the detector discards any value that is not a supported
 * language.
 *
 * @version v0.9.0
 */
import { createCookie } from "react-router";
import { LANGUAGE_PARAM } from "./language-param";

export const SUPPORTED_LANGUAGES = ["es", "en"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export const languageCookie = createCookie("lang", {
  path: "/",
  maxAge: ONE_YEAR_SECONDS,
  sameSite: "lax",
  httpOnly: true,
});

export function isSupportedLanguage(
  value: unknown,
): value is SupportedLanguage {
  return (
    typeof value === "string" &&
    (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
  );
}

/** The Set-Cookie header value that records `lang` for this request's host. */
export function serializeLanguageCookie(
  lang: SupportedLanguage,
  request: Request,
): Promise<string> {
  const secure = new URL(request.url).protocol === "https:";
  return languageCookie.serialize(lang, { secure });
}

/** The supported language this request's `lang` cookie names, or null. */
export async function readLanguageCookie(
  request: Request,
): Promise<SupportedLanguage | null> {
  const value = await languageCookie.parse(request.headers.get("Cookie"));
  return isSupportedLanguage(value) ? value : null;
}

/**
 * The `lang` Set-Cookie header to send with a sign-in response, or null
 * when the user has no saved locale, this browser already carries a
 * `lang` cookie on this host, or the request names a language in
 * `?lang=`.
 */
export async function signInLanguageCookie(
  request: Request,
  savedLocale: string | null | undefined,
): Promise<string | null> {
  if (!isSupportedLanguage(savedLocale)) return null;
  const explicit = new URL(request.url).searchParams.get(LANGUAGE_PARAM);
  if (isSupportedLanguage(explicit)) return null;
  if ((await readLanguageCookie(request)) !== null) return null;
  return serializeLanguageCookie(savedLocale, request);
}

// @version v0.9.0
