/**
 * Same-Origin Check for Resource Actions
 *
 * This module deals with one question a cookie-authenticated action must
 * answer before it acts: did the request come from a page of this
 * Worker's own host? React Router checks the `Origin` of a document
 * action before the route runs, but a direct request to a resource route
 * (one with no page) skips that check, so a page on a sibling host of the
 * same site (another tenant's subdomain) could post to such a route with
 * a signed-in person's cookie. `requireSameOrigin` closes that for the
 * route that calls it.
 *
 * GET and HEAD pass, since they change nothing. Any other method must
 * name where it came from: the `Origin` header, or the `Referer` when a
 * browser sent no `Origin`. A request with neither, or with `Origin:
 * null`, is refused. The source must have the scheme and host (port
 * included) of the request's own URL, and that host must be one this
 * Worker serves by its configuration: a host of `LEGACY_HOST_MAP`, or a
 * tenant subdomain under the configured `PUBLIC_HOST_SUFFIX` where the
 * deployment sets one, and under one of `SUBDOMAIN_HOST_SUFFIXES`
 * otherwise. `X-Forwarded-Host` is never read. Every refusal is a bare
 * 403, thrown, and says nothing about why.
 *
 * The rest of this module is the Worker-wide check, which asks of every
 * request before React Router sees it: could this request have been sent
 * by a page on another origin, riding on a signed-in person's cookie? The
 * session cookie (`__session`) is SameSite=lax, so a page on a sibling
 * host of the same site — another tenant's subdomain, say — can still
 * post to Fisqua with it attached. React Router checks the `Origin` of
 * document actions, but it lets a request with no `Origin` through,
 * prefers the `X-Forwarded-Host` header over the URL when comparing, and
 * skips resource routes (routes with no page) altogether. The check here
 * covers every route in one place, in `workers/app.ts`. It takes no
 * `Referer` in place of a missing `Origin`, so a cookie-carrying write it
 * lets through also meets `requireSameOrigin`'s source test; a route
 * that calls `requireSameOrigin` as well adds only the served-host test.
 *
 * `isCrossOriginSessionWrite` answers true when a request should be
 * refused: its method is anything but GET, HEAD or OPTIONS, its `Cookie`
 * header carries a cookie named `__session`, and its `Origin` is missing,
 * `null`, or anything other than the origin of the request's own URL.
 * That origin comes from the URL Cloudflare received, never from the
 * `Host` or `X-Forwarded-Host` headers, which the sender controls. A
 * request with no session cookie passes: the pipeline runner and the
 * Captua scanner authenticate with Bearer tokens and send no cookie, and
 * a cookieless request carries no one's authority.
 *
 * `isCrossOriginLoginPost` is a separate rule for one route. The
 * magic-link form on `/login` is posted before anyone is signed in, so
 * it carries no cookie and the session rule never sees it; without its
 * own check, any site could make a visitor's browser ask Fisqua to email
 * a sign-in link to an address of the site's choosing. It refuses a
 * state-changing request to `/login` whose `Origin` is missing, `null`,
 * or another origin. The path is normalised the way React Router
 * matches it (case-insensitive, percent-decoded, with or without a
 * trailing slash, and with the `.data` suffix of a single-fetch
 * submission), so a variant spelling cannot reach the action around the
 * check.
 *
 * The cookie header is parsed by name, so a cookie called `x__session`
 * or a value containing `__session` is not mistaken for the session.
 *
 * @version v0.8.0
 */

import { LEGACY_HOST_MAP, SUBDOMAIN_HOST_SUFFIXES } from "./tenant";

/** The settings this check reads. `Env` is assignable to it. */
export interface SameOriginEnv {
  PUBLIC_HOST_SUFFIX?: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** Whether `hostname` is one this Worker serves by its configuration. */
export function isServedHost(hostname: string, env: SameOriginEnv): boolean {
  const host = hostname.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LEGACY_HOST_MAP, host)) return true;
  const configured = env.PUBLIC_HOST_SUFFIX?.trim().toLowerCase();
  const suffixes: readonly string[] = configured ? [configured.startsWith(".") ? configured : `.${configured}`] : SUBDOMAIN_HOST_SUFFIXES;
  return suffixes.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

/** Throws a bare 403 unless the request is safe or came from this Worker's own origin. */
export function requireSameOrigin(request: Request, env: SameOriginEnv): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;
  const forbidden = () => new Response(null, { status: 403 });
  const own = new URL(request.url);
  if (!isServedHost(own.hostname, env)) throw forbidden();
  const source = request.headers.get("Origin") ?? request.headers.get("Referer");
  if (source === null || source === "" || source === "null") throw forbidden();
  let from: URL;
  try {
    from = new URL(source);
  } catch {
    throw forbidden();
  }
  if (from.protocol !== own.protocol || from.host.toLowerCase() !== own.host.toLowerCase()) throw forbidden();
}

const SESSION_COOKIE_NAME = "__session";

// OPTIONS is safe here too: the Worker-wide check sees CORS preflights,
// which change nothing.
const WORKER_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether the `Cookie` header names a cookie `__session`, by exact name. */
function hasSessionCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  return cookieHeader.split(";").some((pair) => {
    const eq = pair.indexOf("=");
    const name = (eq === -1 ? pair : pair.slice(0, eq)).trim();
    return name === SESSION_COOKIE_NAME;
  });
}

/** Whether the request's `Origin` header is exactly the origin of its own URL. */
function originMatchesUrl(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin === null || origin === "" || origin === "null") return false;
  return origin === new URL(request.url).origin;
}

/**
 * True when a state-changing request carries the session cookie and did
 * not come from the request's own origin. The Worker answers such a
 * request with a bare 403.
 */
export function isCrossOriginSessionWrite(request: Request): boolean {
  if (WORKER_SAFE_METHODS.has(request.method.toUpperCase())) return false;
  if (!hasSessionCookie(request.headers.get("Cookie"))) return false;
  return !originMatchesUrl(request);
}

/** The login route's path as React Router would match it, or null if it cannot be decoded. */
function normaliseLoginPath(pathname: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  path = path.toLowerCase();
  if (path.endsWith(".data")) path = path.slice(0, -".data".length);
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

/**
 * True when a state-changing request to the login route did not come
 * from the request's own origin. React Router runs a route's action for
 * PUT, PATCH and DELETE as well as POST, so every method but GET, HEAD
 * and OPTIONS counts. This applies to `/login` only: its action sends
 * email for a visitor who is not signed in, so the session rule above,
 * which needs a cookie, does not cover it.
 */
export function isCrossOriginLoginPost(request: Request): boolean {
  if (WORKER_SAFE_METHODS.has(request.method.toUpperCase())) return false;
  const path = normaliseLoginPath(new URL(request.url).pathname);
  // A path that cannot be decoded cannot match a route either; React
  // Router answers it, not the login action.
  if (path !== "/login") return false;
  return !originMatchesUrl(request);
}

// @version v0.8.0
