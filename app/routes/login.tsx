/**
 * Tenant /login route
 *
 * This route is the per-tenant sign-in surface. Two affordances:
 *
 *   1. "Sign in with GitHub" — primary position. The button points at
 *      the apex init route (`https://fisqua.org/auth/github`) with
 *      `?return_to=<slug>`; the apex completes OAuth at the one
 *      callback URL the GitHub OAuth App is registered with and 302s
 *      back to this tenant via a single-use handoff token. The tenant
 *      slug is read from the loader's tenant resolution, made through
 *      `resolveRequestTenant`, so the row the i18next middleware read
 *      for the workspace's default language is not read again.
 *
 *   2. Magic-link form — secondary position. Submits an email; the
 *      action generates a magic link with `new URL(request.url).origin`
 *      so the verify URL stays on the tenant subdomain (host-aware by
 *      construction).
 *
 * @version v0.9.0
 */
import { redirect, data } from "react-router";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { CircleCheck, CircleX, Github, Mail } from "lucide-react";
import type { Route } from "./+types/login";
import {
  assertNonPlatformOrAllowlisted,
  resolveRequestTenant,
} from "../lib/tenant";
import { getLocale } from "../middleware/i18next";
import { pageMeta, heading } from "../lib/page-title";
import { FisquaMark } from "../components/landing/landing-mark";

const emailSchema = z.object({
  email: z.string().email(),
});

export function meta(args: Route.MetaArgs) {
  return pageMeta(
    args,
    heading("auth:page_title"),
  );
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { createSessionStorage } = await import("../sessions.server");
  const { drizzle } = await import("drizzle-orm/d1");

  const env = context.cloudflare.env;
  const { getSession } = createSessionStorage(env.SESSION_SECRET);
  const session = await getSession(request.headers.get("Cookie"));

  if (session.get("userId")) {
    throw redirect("/");
  }

  // Resolve the tenant from the request host so the "Sign in with
  // GitHub" button can carry `?return_to=<slug>` to the apex. The
  // apex init route is the single entry point for OAuth across every
  // tenant; the tenant-side button on /login is just a convenience
  // link.
  //
  // Defensive: if tenant resolution throws (unknown host, multi-level
  // subdomain), bubble the 404 — it's the same behaviour every other
  // tenant route gets, and a /login that 404s on a non-existent host
  // is correct.
  const db = drizzle(env.DB);
  const tenant = await resolveRequestTenant(context, db, request);
  // Seal platform host. /login is not in OPERATOR_ROUTE_ALLOWLIST,
  // so platform.fisqua.org/login hard-404s here — externally
  // identical to an unknown slug's /login.
  assertNonPlatformOrAllowlisted(tenant, new URL(request.url).pathname);

  // Locale channel for `meta()`: `getLocale` throws if the i18next
  // middleware did not run on this request (direct loader invocation
  // from tests) — fall back to "en".
  let lang: "en" | "es" = "en";
  try {
    lang = getLocale(context) === "es" ? "es" : "en";
  } catch {
    lang = "en";
  }

  return {
    lang,
    tenantSlug: tenant.slug,
    // Surface the workspace name as a subtitle under the Fisqua
    // mark/title so users know which tenant they're about to sign
    // into. Only exposed for tenant kind; platform host returns null
    // so the operator-login screen doesn't leak the platform tenant's
    // display name.
    tenantName: tenant.kind === "tenant" ? tenant.name : null,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { createSessionStorage } = await import("../sessions.server");
  const { generateMagicLink } = await import("../lib/auth.server");
  const { isD1Overloaded } = await import("../lib/d1-overload");
  const { getInstance } = await import("~/middleware/i18next");

  const env = context.cloudflare.env;
  const i18n = getInstance(context);
  const formData = await request.formData();

  const parsed = emailSchema.safeParse({
    email: formData.get("email"),
  });

  if (!parsed.success) {
    return data(
      { error: i18n.t("auth:error.invalid_email"), success: false },
      { status: 400 }
    );
  }

  const db = drizzle(env.DB);
  const origin = new URL(request.url).origin;
  // The email takes the default language of the workspace this host
  // resolves to, the one the link signs into, which for a federation
  // grant holder is not their home workspace. An unresolvable host
  // leaves the user's home workspace to supply it. The page's language
  // goes with the request: the email uses it only when the user has no
  // saved language and the workspace no default.
  //
  // A D1 overload refusal answers 503 with a message asking the person
  // to try again, whether it refused the workspace lookup, outlasted
  // the read retries in generateMagicLink, or refused the token insert;
  // any other error from generateMagicLink is left to the router. The
  // workspace lookup is not retried here: the resolver already retries
  // its read, the request holds a single lookup, and a failed one stays
  // failed for the rest of the request.
  const busy = () =>
    data(
      { error: i18n.t("auth:error.sign_in_busy"), success: false },
      { status: 503 }
    );
  let workspaceId: string | null = null;
  try {
    workspaceId = (await resolveRequestTenant(context, db, request)).id;
  } catch (err) {
    if (isD1Overloaded(err)) return busy();
    workspaceId = null;
  }
  let result: Awaited<ReturnType<typeof generateMagicLink>>;
  try {
    result = await generateMagicLink(
      db,
      parsed.data.email,
      origin,
      env.RESEND_API_KEY,
      env,
      i18n.language,
      workspaceId,
      { request }
    );
  } catch (err) {
    if (!isD1Overloaded(err)) throw err;
    return busy();
  }

  if (result.error) {
    return data({ error: result.error, success: false }, { status: 400 });
  }

  return data({ success: true, error: null });
}

export default function LoginPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { t } = useTranslation("auth");
  const searchParams =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const urlError = searchParams.get("error");

  const errorMessages: Record<string, string> = {
    "expired-link": t("error.expired_link"),
    "invalid-link": t("error.invalid_link"),
    "oauth-failed": t("error.oauth_failed"),
    "no-email": t("error.no_email"),
    "no-account": t("error.no_account"),
  };

  // The GitHub button targets the apex init route with
  // ?return_to=<slug>. The apex completes OAuth at the one URL the
  // GitHub OAuth App is registered with, then 302s back to this
  // tenant subdomain via the single-use handoff token.
  const tenantSlug = loaderData?.tenantSlug ?? "";
  const githubHref = tenantSlug
    ? `https://fisqua.org/auth/github?return_to=${encodeURIComponent(tenantSlug)}`
    : "/auth/github";

  return (
    <div className="flex min-h-screen items-center justify-center bg-white">
      <div className="mx-auto w-full max-w-md space-y-6 px-4">
        <div className="text-center">
          <FisquaMark className="mx-auto h-24 w-24" color="var(--verdigris)" label="Fisqua" />
          <h1 className="mt-4 font-display text-5xl font-semibold text-indigo">
            Fisqua
          </h1>
          {loaderData?.tenantName && (
            <p className="mt-1 font-sans text-sm text-stone-500">
              {loaderData.tenantName}
            </p>
          )}
        </div>

        {urlError && errorMessages[urlError] && (
          <div className="flex items-start gap-3 rounded-md border border-indigo bg-indigo-tint px-4 py-3 text-sm text-stone-700">
            <CircleX
              className="mt-0.5 h-5 w-5 shrink-0 text-indigo"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <span>{errorMessages[urlError]}</span>
          </div>
        )}

        {actionData?.success ? (
          <div className="flex items-start gap-3 rounded-md border border-verdigris bg-verdigris-tint px-4 py-3 text-sm text-stone-700">
            <CircleCheck
              className="mt-0.5 h-5 w-5 shrink-0 text-verdigris"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <span>{t("success_message")}</span>
          </div>
        ) : (
          <div className="space-y-6">
            {/*
              GitHub login button — primary position. The link targets
              the apex init route with the tenant slug as
              ?return_to=<slug>. GitHub OAuth Apps allow exactly one
              Authorization callback URL, so the apex completes the
              flow on behalf of every tenant.
            */}
            <a
              href={githubHref}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#24292f] font-sans text-15 font-semibold text-white hover:bg-[#1b1f23] focus:outline-none focus:ring-2 focus:ring-[#24292f] focus:ring-offset-2"
            >
              <Github className="h-5 w-5" />
              {t("github_login_button")}
            </a>

            {/* Divider */}
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-stone-300" />
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="bg-white px-2 text-stone-500">{t("or_divider")}</span>
              </div>
            </div>

            {/* Magic link form -- secondary position */}
            <form method="post" className="space-y-4">
              {actionData?.error && (
                <div className="flex items-start gap-3 rounded-md border border-indigo bg-indigo-tint px-4 py-3 text-sm text-stone-700">
                  <CircleX
                    className="mt-0.5 h-5 w-5 shrink-0 text-indigo"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                  {/*
                    `no_account` is the stable token auth.server returns
                    when the email has no user; every other error value
                    arrives pre-translated by the action.
                  */}
                  <span>
                    {actionData.error === "no_account"
                      ? t("login.no_account")
                      : actionData.error}
                  </span>
                </div>
              )}

              <div>
                <label
                  htmlFor="email"
                  className="block font-sans text-sm font-medium text-indigo"
                >
                  {t("email_label")}
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  className="mt-1 block h-12 w-full rounded-lg border border-stone-300 px-3 text-sm shadow-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
                  placeholder={t("placeholder")}
                />
              </div>

              <button
                type="submit"
                className="flex h-12 w-full items-center justify-center gap-2 rounded-md bg-indigo font-sans text-15 font-semibold text-parchment hover:bg-indigo-deep focus:outline-none focus:ring-2 focus:ring-indigo focus:ring-offset-2"
              >
                <Mail className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />
                {t("login_button")}
              </button>
            </form>
          </div>
        )}

        <p className="text-center font-sans text-xs text-stone-400">
          {t("footer_note")}
        </p>
      </div>
    </div>
  );
}

// @version v0.9.0
