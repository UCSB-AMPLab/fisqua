/**
 * Marketing Landing + Workspace Picker (apex / fisqua.org)
 *
 * This route is the anonymous, non-`_auth` entry point that owns the
 * `fisqua.org` apex experience. It has three responsibilities:
 *
 *   1. The loader branches on host. On a tenant subdomain
 *      (`<slug>.fisqua.org`, `<slug>.localhost`, `<slug>.fisqua.test`,
 *      or the legacy `catalogacion.zasqua.org` host), it throws
 *      `redirect("/dashboard")` -- preserving the earlier
 *      behaviour where hitting `/` on a tenant subdomain takes
 *      authenticated users into the staff app (and `/dashboard`
 *      itself bounces unauthenticated callers to `/login`). On the
 *      apex it reads the active locale via `getLocale(context)` and
 *      the display version via `APP_VERSION`
 *      (`app/lib/app-version.server.ts`, derived from
 *      `package.json`), returning `{ lang, surface: "landing",
 *      version }` so the render layer knows which language and
 *      version badge to surface.
 *
 *   2. The action handles the workspace-picker form POST. By
 *      design, the action does NOT touch D1, does
 *      NOT validate slug shape, does NOT call any tenant-existence
 *      helper. It trims and lowercases the input, returns a
 *      `Response.json({ error: "empty" }, 400)` on empty submit,
 *      or throws `redirect(`https://${slug}.<apex>/login`)`
 *      otherwise, with the apex taken from the request host when it is
 *      a recognised one and `fisqua.org` when it is not. Unknown slugs fall through to the resolver's
 *      bare 404 on the next request -- externally indistinguishable
 *      from "valid slug, no tenant".
 *
 *   3. The default-export component renders the locked v0.4
 *      marketing surface as designed in the 2026-05-02 design pass:
 *      header with brand mark + segmented EN/ES toggle, a
 *      two-column hero (eyebrow + Spectral display tagline in
 *      indigo + thin divider + workspace picker | parchment plate
 *      with the centred mark) on desktop, a parchment-banded
 *      context paragraph with eyebrow gutter, and a thin footer
 *      with the version line and the two locked outward links.
 *      Mobile collapses to a single column and drops the
 *      decorative parchment plate.
 *
 * The host-branch is implemented WITHOUT a D1 lookup so the apex
 * loader stays cheap and so `getTenantFromRequest` does not need to
 * be called from a non-`_auth` route. `isTenantHost` is a pure
 * string check against the existing `LEGACY_HOST_MAP` and
 * `SUBDOMAIN_HOST_SUFFIXES` constants in `app/lib/tenant.ts`.
 *
 * @version v0.9.0
 */

import { redirect } from "react-router";
import { Trans, useTranslation } from "react-i18next";
import { drizzle } from "drizzle-orm/d1";
import type { Route } from "./+types/_index";
import {
  LEGACY_HOST_MAP,
  RESERVED_NON_TENANT_SUBDOMAINS,
  SUBDOMAIN_HOST_SUFFIXES,
  SlugSchema,
  findTenantBySlug,
} from "../lib/tenant";
import { getLocale } from "../middleware/i18next";
import { APP_VERSION } from "../lib/app-version.server";
import { LandingHeader } from "../components/landing/landing-header";
import { WorkspacePicker } from "../components/landing/workspace-picker";
import { LandingFooter } from "../components/landing/landing-footer";
import { ParchmentPlate } from "../components/landing/landing-mark";

export function meta({ data: loaderData }: Route.MetaArgs) {
  const lang = loaderData?.lang === "es" ? "es" : "en";
  const title = "Fisqua";
  const description =
    lang === "es"
      ? "Fisqua reúne catalogación de archivos, gestión documental, digitalización y preservación digital en una plataforma colaborativa, modular y de código abierto."
      : "Fisqua brings together archival cataloguing, records management, digitization, and preservation in one collaborative, modular, open-source platform.";
  return [
    { title },
    { name: "description", content: description },
  ];
}

/**
 * Returns true when the request's host is a tenant subdomain (or the
 * legacy `catalogacion.zasqua.org` host). The apex `fisqua.org`,
 * synthetic apex `fisqua.test`, and bare `localhost` return false.
 *
 * Multi-level subdomains (`evil.neogranadina.fisqua.org`) are rejected
 * structurally -- they are NOT tenant hosts here, which means a future
 * spoof attempt lands on the apex landing rather than redirecting into
 * the staff app under an unexpected origin.
 */
function isTenantHost(request: Request): boolean {
  const host = new URL(request.url).hostname.toLowerCase();
  if (host in LEGACY_HOST_MAP) return true;
  // Reserved infrastructure subdomains (e.g. `staging.fisqua.org`)
  // structurally match a `.fisqua.org` suffix-strip but are the
  // staging deploy's apex, not tenants. Apex landing renders here.
  if (RESERVED_NON_TENANT_SUBDOMAINS.has(host)) return false;
  for (const suffix of SUBDOMAIN_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) {
      const slug = host.slice(0, host.length - suffix.length);
      if (slug.length > 0 && !slug.includes(".")) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The login address of a workspace, built under the host the picker was
 * posted to: `fisqua.org` gives `https://<slug>.fisqua.org/login`,
 * `staging.fisqua.org` gives `https://<slug>.staging.fisqua.org/login`,
 * and the local hosts `localhost` and `fisqua.test` give `<slug>.` under
 * themselves with the request's own protocol and port, so the local
 * server answers. Each of these suffixes is one the tenant resolver
 * recognises (`SUBDOMAIN_HOST_SUFFIXES`). Only these literal hosts are
 * accepted: any other host, a forged `Host` header included, gives the
 * production address.
 */
const PRODUCTION_APEXES: ReadonlySet<string> = new Set(["fisqua.org", "staging.fisqua.org"]);
const LOCAL_APEXES: ReadonlySet<string> = new Set(["localhost", "fisqua.test"]);

function workspaceLoginUrl(request: Request, slug: string): string {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  if (PRODUCTION_APEXES.has(host)) return `https://${slug}.${host}/login`;
  if (LOCAL_APEXES.has(host)) {
    const port = url.port ? `:${url.port}` : "";
    return `${url.protocol}//${slug}.${host}${port}/login`;
  }
  return `https://${slug}.fisqua.org/login`;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  if (isTenantHost(request)) {
    throw redirect("/dashboard");
  }
  // Apex render. Read the resolved language from the i18next
  // middleware, which honours the toggle's `?lang=` and records it in
  // the `lang` cookie for later requests.
  let lang: "en" | "es" = "en";
  try {
    const detected = getLocale(context);
    lang = detected === "es" ? "es" : "en";
  } catch {
    // `getLocale` throws if the i18next middleware did not run on
    // this request (e.g. direct loader invocation from tests). Fall
    // back to "en" -- tests that need a specific language pass
    // `loaderData` directly via the route component.
    lang = "en";
  }
  return { lang, surface: "landing" as const, version: APP_VERSION };
}

/**
 * Picker action.
 *
 * The C-03 invariant (action does NOT touch D1; unknown slugs fall
 * through to the resolver's bare 404 to mitigate enumeration) was
 * retired on 2026-05-02. Rationale: with ~5–6 institutional
 * partners, all of whom are public-by-design (AMPL, Neogranadina,
 * etc.) and whose hostnames are leaked by Cloudflare's per-hostname
 * Certificate Transparency entries anyway, the enumeration mitigation
 * was paying off a debt that does not exist for this product. The
 * UX cost — typo of a real-shape slug landing on the browser's
 * default 404 with no recovery path — was the dominant friction.
 *
 * Three error states surfaced inline at the picker, no round trip:
 *   - `empty`     — input was whitespace-only.
 *   - `shape`     — failed `SlugSchema` (charset / length / reserved).
 *   - `notFound`  — shape OK but no tenant row matches; the slug is
 *                   echoed back in the message so the user can see
 *                   what they typed.
 *
 * On success, the action 302s to `https://<slug>.<apex>/login`, where
 * `<apex>` is the host the picker was posted to when it is one of the
 * recognised apexes (`workspaceLoginUrl`), and `fisqua.org` otherwise.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const formData = await request.formData();
  const raw = formData.get("slug");
  const slug = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (slug === "") {
    return Response.json({ error: "empty" as const }, { status: 400 });
  }
  const shapeCheck = SlugSchema.safeParse(slug);
  if (!shapeCheck.success) {
    return Response.json({ error: "shape" as const }, { status: 400 });
  }
  const db = drizzle(context.cloudflare.env.DB);
  const tenant = await findTenantBySlug(db, slug);
  if (!tenant) {
    return Response.json(
      { error: "notFound" as const, slug },
      { status: 400 },
    );
  }
  throw redirect(workspaceLoginUrl(request, slug));
}

const eyebrowStyle = {
  fontFamily: "var(--font-sans)",
  fontSize: "11px",
  fontWeight: 600,
  letterSpacing: "0.14em",
  color: "var(--verdigris-deep)",
  margin: 0,
  textTransform: "uppercase" as const,
};

const taglineStyle = {
  fontFamily: "var(--font-display)",
  fontSize: "clamp(32px, 4.6vw, 52px)",
  lineHeight: 1.08,
  letterSpacing: "-0.018em",
  color: "var(--indigo)",
  fontWeight: 500,
  margin: 0,
  textWrap: "pretty" as const,
};

/**
 * Narrow the loose `actionData` type to a concrete picker error shape
 * the WorkspacePicker can switch on. Returns `undefined` on the
 * happy path (no action data, or action data without an `error`).
 */
function actionDataToPickerError(
  actionData: unknown,
):
  | { code: "empty" }
  | { code: "shape" }
  | { code: "notFound"; slug: string }
  | undefined {
  if (!actionData || typeof actionData !== "object") return undefined;
  const data = actionData as { error?: unknown; slug?: unknown };
  if (data.error === "empty") return { code: "empty" };
  if (data.error === "shape") return { code: "shape" };
  if (data.error === "notFound" && typeof data.slug === "string") {
    return { code: "notFound", slug: data.slug };
  }
  return undefined;
}

const contextBodyStyle = {
  fontFamily: "var(--font-serif)",
  fontSize: "19px",
  lineHeight: 1.55,
  color: "var(--indigo)",
  margin: 0,
  maxWidth: "720px",
  textWrap: "pretty" as const,
};

export default function LandingRoute({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { t } = useTranslation("landing");
  const lang: "en" | "es" = loaderData?.lang === "es" ? "es" : "en";
  const error = actionDataToPickerError(actionData);
  // Falls back to an empty interpolation rather than importing
  // `APP_VERSION` directly here -- this component is bundled for the
  // client, and the version belongs to the server-only loader path
  // (see `app/lib/app-version.server.ts`).
  const version = loaderData?.version ?? "";

  return (
    <div className="min-h-screen bg-white text-indigo">
      <LandingHeader lang={lang} />

      <section
        aria-labelledby="hero-tagline"
        className="mx-auto grid max-w-[1200px] items-center gap-10 px-5 py-14 md:gap-16 md:px-16 md:py-24 md:[grid-template-columns:minmax(0,1fr)_minmax(0,0.85fr)]"
      >
        <div className="flex max-w-[560px] flex-col gap-6 md:gap-9">
          <p style={eyebrowStyle}>{t("hero.eyebrow", { version })}</p>
          <h1 id="hero-tagline" style={taglineStyle}>
            {t("hero.tagline")}
          </h1>
          <div className="h-px w-20 bg-stone-200" aria-hidden="true" />
          <WorkspacePicker error={error} />
        </div>
        <ParchmentPlate />
      </section>

      <section
        aria-labelledby="context-eyebrow"
        className="border-y border-parchment-deep bg-parchment"
      >
        <div className="mx-auto grid max-w-[1200px] items-start gap-6 px-5 py-12 md:gap-16 md:px-16 md:py-14 md:[grid-template-columns:200px_minmax(0,1fr)]">
          <p
            id="context-eyebrow"
            style={{ ...eyebrowStyle, paddingTop: "8px" }}
          >
            {t("context.eyebrow")}
          </p>
          <p style={contextBodyStyle}>
            <Trans
              i18nKey="context.paragraph"
              ns="landing"
              components={{ em: <em />, strong: <strong /> }}
            />
          </p>
        </div>
      </section>

      <LandingFooter version={version} />
    </div>
  );
}

// @version v0.9.0
