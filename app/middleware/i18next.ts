/**
 * i18next Middleware
 *
 * This middleware deals with attaching an i18next instance to every
 * request and resolving the active language. The server picks the
 * language in this order, and the first source that names a supported
 * language wins:
 *   1. `?lang=en` / `?lang=es` on the request (the landing page's
 *      EN / ES toggle links to these);
 *   2. the `lang` cookie (`app/lib/language-cookie.server.ts`);
 *   3. the workspace's default language (`tenants.default_locale`),
 *      when the request is on a workspace host and the workspace sets
 *      one;
 *   4. the Accept-Language header;
 *   5. Spanish.
 * The workspace default is read only when steps 1 and 2 name no
 * supported language, so a visitor who has chosen a language costs no
 * tenant read. Nor is it read for a route that renders no page
 * (`rendersNoPage`): the machine endpoints under `/api/`, whose callers
 * (a scanner unit, the media pipeline runner) send no cookie, and the
 * public sign-in, handoff, logout and invite routes, which only
 * redirect. Those requests go straight from step 2 to Accept-Language. The read goes through `resolveRequestTenant`, which
 * keeps the lookup in `requestTenantContext`; the auth middleware and
 * the public routes that resolve the tenant take it from that same
 * lookup later in the request, so the default adds no D1 read on the pages that load
 * the tenant anyway. The apex host has no workspace and the resolver
 * rejects it before any query. An unknown or soft-disabled workspace,
 * a request with no D1 binding, or a failed read leaves step 3 empty,
 * and detection goes on to Accept-Language; a failure here never fails
 * the request.
 * A signed-in user's saved `users.locale` is not read here: this
 * middleware runs at the root, before the auth middleware has loaded
 * the user, and loading it here would cost a session parse and a D1
 * read on every request, the public landing page included. The sign-in
 * routes write the `lang` cookie from `users.locale` instead, so the
 * saved language takes effect through step 2, above the workspace
 * default.
 *
 * Detection is the remix-i18next language detector, given the cookie
 * and an explicit order. Step 3 is the detector's `custom` source: its
 * `findLocale` receives only the request, so the middleware registers,
 * per request, the lookup that reads the workspace default from the
 * request context, and `findLocale` calls it. The exported `i18nextMiddleware` wraps it: a
 * GET or HEAD request carrying a supported `?lang=` gets the `lang`
 * cookie set on its response, so a language chosen through a link
 * persists past that one request. A form submission does not: its URL
 * keeps whatever query string the page had, so a `?lang=` there is a
 * leftover, not a choice. Nor does a response that already sets `lang`
 * (the settings action), so a choice made there is the only `lang`
 * cookie that leaves the response. `searchParamKey` is `"lang"` because
 * the upstream default is `"lng"`, which the toggle's links do not use.
 *
 * The browser does not detect a language of its own: `entry.client.tsx`
 * initialises i18next from the `<html lang>` the server rendered, so the
 * first paint and hydration use the server's choice.
 *
 * Loaders read the resolved language via `getLocale(context)`; the
 * shared instance returned by `getInstance(context)` is also
 * available for server-side `t()` calls outside React.
 *
 * Work that runs with no request at all — the unmatched-URL fallback,
 * and the cron that renders notification digests in each recipient's
 * stored language — reaches for `createServerI18nInstance` instead, so
 * the resource bundle and interpolation rules stay single-sourced.
 *
 * @version v0.9.0
 */
import {
  createInstance,
  type i18n as I18nInstance,
  type ThirdPartyModule,
} from "i18next";
import { initReactI18next } from "react-i18next";
import type { MiddlewareFunction } from "react-router";
import { createI18nextMiddleware } from "remix-i18next/middleware";
import resources from "../locales";
import { drizzle } from "drizzle-orm/d1";
import { LANGUAGE_PARAM } from "../lib/language-param";
import { resolveRequestTenant } from "../lib/tenant";
import {
  SUPPORTED_LANGUAGES,
  isSupportedLanguage,
  languageCookie,
  serializeLanguageCookie,
} from "../lib/language-cookie.server";

// Shared with `createServerI18nInstance` below so every standalone
// instance carries the exact same resource bundle and interpolation
// rules as the per-request instance the middleware builds.
const i18nextConfig = {
  resources,
  defaultNS: "common",
  // React already escapes interpolated text on render; i18next's own
  // HTML-entity escaping (default `escapeValue: true`) would run first
  // and leave the entities as literal characters in the rendered
  // output (e.g. "/" -> "&#x2F;") instead of being unescaped by React.
  interpolation: { escapeValue: false },
};

// Routes that render no page. `/api/` is matched as a prefix; the others
// are exact paths of public routes that only redirect or answer a POST.
const NO_PAGE_PREFIX = "/api/";
const NO_PAGE_PATHS: ReadonlySet<string> = new Set([
  "/auth/verify",
  "/auth/github",
  "/auth/github/callback",
  "/auth/github/handoff",
  "/auth/logout",
  "/handoff/impersonation",
  "/end-impersonation",
  "/invite/accept",
]);

/**
 * Whether the request is for a route that renders no page, so its
 * language needs no workspace default. A trailing slash is ignored.
 */
export function rendersNoPage(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  if (pathname.startsWith(NO_PAGE_PREFIX)) return true;
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return NO_PAGE_PATHS.has(trimmed);
}

// The workspace-default lookup for each request in flight, keyed by the
// request object the detector's `findLocale` receives.
const workspaceDefaultLookups = new WeakMap<Request, () => Promise<string | null>>();

/**
 * The default language of the workspace the request is on, or null
 * when there is none: the apex host, an unknown or soft-disabled
 * workspace, a workspace without a default, no D1 binding, or a read
 * that failed.
 */
async function workspaceDefaultLocale(
  context: Parameters<MiddlewareFunction<Response>>[0]["context"],
  request: Request,
): Promise<string | null> {
  try {
    const env = (context as { cloudflare?: { env?: Env } }).cloudflare?.env;
    if (!env?.DB) return null;
    const tenant = await resolveRequestTenant(context, drizzle(env.DB), request);
    return tenant.defaultLocale ?? null;
  } catch {
    return null;
  }
}

const [detectLanguage, getLocale, getInstance] = createI18nextMiddleware({
  detection: {
    supportedLanguages: [...SUPPORTED_LANGUAGES],
    fallbackLanguage: "es",
    searchParamKey: LANGUAGE_PARAM,
    cookie: languageCookie,
    order: ["searchParams", "cookie", "custom", "header"],
    findLocale: async (request) => {
      const lookup = workspaceDefaultLookups.get(request);
      return lookup ? lookup() : null;
    },
  },
  i18next: i18nextConfig,
  plugins: [initReactI18next],
});

export { getLocale, getInstance };

/**
 * Registers the request's workspace-default lookup (none for a route
 * that renders no page), runs language
 * detection for the request and, when a GET or HEAD
 * request names a supported language in `?lang=` and the response does
 * not already set `lang`, records it in the `lang` cookie on the
 * response.
 */
export const i18nextMiddleware: MiddlewareFunction<Response> = async (
  args,
  next,
) => {
  if (!rendersNoPage(args.request)) {
    workspaceDefaultLookups.set(args.request, () =>
      workspaceDefaultLocale(args.context, args.request),
    );
  }
  const response = await detectLanguage(args, next);
  const requested = new URL(args.request.url).searchParams.get(LANGUAGE_PARAM);
  if (!response || !isSupportedLanguage(requested)) return response;
  const method = args.request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return response;
  const alreadySet = response.headers
    .getSetCookie()
    .some((c) => c.startsWith(`${languageCookie.name}=`));
  if (alreadySet) return response;
  const setCookie = await serializeLanguageCookie(requested, args.request);
  try {
    response.headers.append("Set-Cookie", setCookie);
    return response;
  } catch {
    // A response passed through from `fetch()` has immutable headers;
    // copy it to add the cookie.
    const copy = new Response(response.body, response);
    copy.headers.append("Set-Cookie", setCookie);
    return copy;
  }
};

/**
 * Builds a standalone i18next instance fixed to one language, wired to
 * no request context at all. Two callers need this: the unmatched-URL
 * fallback below, and the notification sweep, which renders digest mail
 * from the cron in each recipient's stored locale — there is no request
 * to detect a language from in either case, so the language is passed
 * in rather than negotiated.
 *
 * `plugins` exists only so the fallback path can keep registering
 * `initReactI18next`. Registration has to happen before `init()` (i18next
 * runs a third-party module's own `init` during its own, and a `use()`
 * that lands afterwards is silently inert), so the plugin list cannot be
 * applied by the caller after the fact. Server-side rendering of an email
 * touches no React, so the digest path passes nothing.
 */
export async function createServerI18nInstance(
  lng: "en" | "es",
  plugins: ThirdPartyModule[] = [],
): Promise<I18nInstance> {
  const instance = createInstance(i18nextConfig);
  for (const plugin of plugins) instance.use(plugin);
  await instance.init({ lng });
  return instance;
}

/**
 * Builds a standalone i18next instance that is NOT wired to any
 * request context. React Router's static handler short-circuits a
 * genuinely unmatched URL straight to a 404 static context without
 * ever running route middleware (the `!matches` branch of
 * `staticHandler.query()` in `react-router`'s core) -- so
 * `i18nextMiddleware` never runs and `getInstance(context)` has
 * nothing to read. `entry.server.tsx` falls back to this instance in
 * that case so the root `ErrorBoundary` still has a working
 * translator and can render a real 404 instead of the request
 * crashing on a missing-context throw before React ever renders
 * anything. The fixed `"es"` language mirrors the app's fallback
 * language -- there is no request-scoped detection to run here since,
 * by construction, the request never matched a route.
 */
export async function createFallbackI18nInstance(): Promise<I18nInstance> {
  return createServerI18nInstance("es", [initReactI18next]);
}

// @version v0.9.0
