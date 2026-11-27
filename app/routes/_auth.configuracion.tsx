/**
 * Account Configuration Page
 *
 * This page is the personal account preferences surface for the
 * signed-in user: display name, locale, and notification toggles.
 * Scoped to the caller — no
 * administrative surfaces live here. Reachable from the sidebar
 * footer and the top-bar user menu.
 *
 * The digest-frequency radios and the locale toggle both write to
 * `users` columns the notification sweep and the digest renderer
 * already read (0074) — this page is where a user actually sets
 * them, not just where the profile form and the language buttons
 * live. `userContext`'s `User` type carries neither field (it is
 * populated once per request by the auth middleware from a narrower
 * select), so the loader runs its own small query for them and
 * merges the result onto the context user rather than widening the
 * shared type for one route.
 *
 * The language buttons switch i18next in the browser at once, and in
 * the background submit the choice through a fetcher. The action saves
 * it to `users.locale`, which the digest renderer reads and the sign-in
 * routes copy into the `lang` cookie, and answers with that cookie
 * itself (`app/lib/language-cookie.server.ts`), which the i18next
 * middleware reads on every later request, so the language survives a
 * reload. Nothing is written to localStorage: the browser takes its
 * language from the page the server rendered, never from its own
 * storage. If the page was opened with `?lang=`, choosing a language
 * replaces the URL without it and the fetcher posts to that URL, so
 * the revalidation after the choice, and any reload, do not carry the
 * old parameter, which the middleware would otherwise record again.
 *
 * Save feedback runs through the shared `SaveFeedbackBanner` /
 * `SaveButton` pair. Before that, this page confirmed a successful
 * profile update but rendered nothing at all on failure, so a name
 * change that the action rejected looked identical to one that landed.
 * The locale fetcher deliberately does NOT feed the banner — a
 * fetcher submission never populates `actionData`, so the shared
 * feedback naturally stays scoped to the profile and preferences
 * forms.
 *
 * `actionData` arrives as a component prop rather than through
 * `useActionData` so the feedback states can be rendered — and
 * asserted — without standing up a live submission.
 *
 * @version v0.9.0
 */

import { useState } from "react";
import {
  data,
  Form,
  useFetcher,
  useLocation,
  useNavigate,
  useNavigation,
} from "react-router";
import { useTranslation } from "react-i18next";
import { Github } from "lucide-react";
import { userContext } from "../context";
import { withoutLanguageParam } from "~/lib/language-param";
import {
  SaveButton,
  SaveFeedbackBanner,
  isPendingSubmission,
} from "~/components/admin/save-feedback";
import type { Route } from "./+types/_auth.configuracion";

// The sweep's frequency floor is the cron tick (15min) down to a full
// off; order matches the schema's own `DIGEST_FREQUENCIES` sequence.
// Kept as a local literal rather than importing `~/db/schema` at module
// level — that module also carries the Drizzle table definitions, which
// have no business in the client bundle for a page that only needs five
// string values. The type-only import below is erased at build time and
// makes the compiler reject any entry that drifts from the schema enum.
import type { DIGEST_FREQUENCIES } from "~/db/schema";
import { pageMeta, heading } from "../lib/page-title";

type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];

const DIGEST_FREQUENCY_OPTIONS = [
  "15min",
  "hourly",
  "daily",
  "weekly",
  "off",
] as const satisfies readonly DigestFrequency[];

const FREQ_LABEL_KEYS: Record<DigestFrequency, string> = {
  "15min": "freq_15min",
  hourly: "freq_hourly",
  daily: "freq_daily",
  weekly: "freq_weekly",
  off: "freq_off",
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function meta(args: Route.MetaArgs) {
  return pageMeta(
    args,
    heading("settings:title"),
  );
}

export async function loader({ context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { users } = await import("~/db/schema");

  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  // The context User carries no preference columns, so the page reads
  // its own row. locale is deliberately NOT loaded: its consumer is the
  // digest renderer, and the language buttons key off the live i18n
  // state, which is what the reader is actually seeing.
  const [prefs] = await db
    .select({ digestFrequency: users.digestFrequency })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)
    .all();

  return {
    user: {
      ...user,
      digestFrequency: (prefs?.digestFrequency ??
        "hourly") as DigestFrequency,
    },
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { users, DIGEST_FREQUENCIES } = await import("~/db/schema");

  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  switch (intent) {
    case "updateProfile": {
      const name = (formData.get("name") as string || "").trim();

      await db
        .update(users)
        .set({
          name: name || null,
          updatedAt: Date.now(),
        })
        .where(eq(users.id, user.id));

      return { ok: true, intent: "updateProfile" };
    }

    case "updatePreferences": {
      const digestFrequency = formData.get("digestFrequency") as string;

      if (!(DIGEST_FREQUENCIES as readonly string[]).includes(digestFrequency)) {
        return { ok: false };
      }

      await db
        .update(users)
        .set({
          digestFrequency: digestFrequency as (typeof DIGEST_FREQUENCIES)[number],
          updatedAt: Date.now(),
        })
        .where(eq(users.id, user.id));

      return { ok: true, intent: "updatePreferences" };
    }

    case "updateLocale": {
      const { isSupportedLanguage, serializeLanguageCookie } = await import(
        "~/lib/language-cookie.server"
      );
      const locale = formData.get("locale");

      if (!isSupportedLanguage(locale)) {
        return { ok: false };
      }

      await db
        .update(users)
        .set({
          locale,
          updatedAt: Date.now(),
        })
        .where(eq(users.id, user.id));

      return data(
        { ok: true, intent: "updateLocale" },
        {
          headers: {
            "Set-Cookie": await serializeLanguageCookie(locale, request),
          },
        },
      );
    }

    default:
      // No `error` message: the intent is not reachable from the UI, so
      // there is nothing user-meaningful to say. The feedback banner
      // falls back to the localised "not saved" line rather than
      // surfacing an untranslated developer string.
      return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ConfiguracionPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { user } = loaderData;
  const { t, i18n } = useTranslation("settings");
  const navigation = useNavigation();
  const localeFetcher = useFetcher();
  const location = useLocation();
  const navigate = useNavigate();
  const savingProfile = isPendingSubmission(
    navigation.state,
    navigation.formData ?? undefined,
    "updateProfile",
  );
  const savingPreferences = isPendingSubmission(
    navigation.state,
    navigation.formData ?? undefined,
    "updatePreferences",
  );
  const [activeLang, setActiveLang] = useState(i18n.language?.startsWith("es") ? "es" : "en");

  function handleLanguageChange(lang: string) {
    i18n.changeLanguage(lang);
    setActiveLang(lang);
    const search = withoutLanguageParam(location.search);
    if (search !== null) {
      navigate(
        { pathname: location.pathname, search, hash: location.hash },
        { replace: true, preventScrollReset: true },
      );
    }
    localeFetcher.submit(
      { _action: "updateLocale", locale: lang },
      {
        method: "post",
        action: `${location.pathname}${search ?? location.search}`,
      },
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-12">
      <h1 className="font-display text-4xl font-semibold text-stone-700">
        {t("title")}
      </h1>

      {/* Save feedback — transient on success, persistent on failure. */}
      <SaveFeedbackBanner
        source={actionData}
        pending={savingProfile || savingPreferences}
        labels={{ success: t("saved"), error: t("common:save.failed") }}
        className="mt-4"
      />

      {/* Profile section */}
      <div className="mt-6 rounded-lg border border-stone-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-stone-700">
          {t("profile")}
        </h2>
        <Form method="post" className="mt-4 space-y-4">
          <input type="hidden" name="_action" value="updateProfile" />
          <div>
            <label
              htmlFor="settings-name"
              className="block font-sans text-xs font-medium text-indigo"
            >
              {t("name")}
            </label>
            <input
              type="text"
              id="settings-name"
              name="name"
              defaultValue={user.name || ""}
              className="mt-1 block w-full max-w-sm rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm shadow-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
            />
          </div>
          <div>
            <span className="block font-sans text-xs font-medium text-stone-500">
              {t("email")}
            </span>
            <p className="mt-1 font-sans text-sm text-stone-500">
              {user.email}
            </p>
          </div>
          <SaveButton
            pending={savingProfile}
            label={t("save")}
            pendingLabel={t("common:save.saving")}
          />
        </Form>
      </div>

      {/* Language section */}
      <div className="mt-6 rounded-lg border border-stone-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-stone-700">
          {t("language")}
        </h2>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => handleLanguageChange("es")}
            className={`rounded-md px-4 py-2 text-sm font-semibold transition-colors ${
              activeLang === "es"
                ? "bg-indigo text-parchment"
                : "border border-stone-200 bg-white text-stone-700 hover:bg-stone-50"
            }`}
          >
            {t("language_es")}
          </button>
          <button
            type="button"
            onClick={() => handleLanguageChange("en")}
            className={`rounded-md px-4 py-2 text-sm font-semibold transition-colors ${
              activeLang === "en"
                ? "bg-indigo text-parchment"
                : "border border-stone-200 bg-white text-stone-700 hover:bg-stone-50"
            }`}
          >
            {t("language_en")}
          </button>
        </div>
      </div>

      {/* Notifications section */}
      <div className="mt-6 rounded-lg border border-stone-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-stone-700">
          {t("notifications")}
        </h2>
        <p className="mt-1 text-sm text-stone-500">{t("notificationsHint")}</p>
        <Form method="post" className="mt-4 space-y-4">
          <input type="hidden" name="_action" value="updatePreferences" />
          <fieldset>
            <legend className="block font-sans text-xs font-medium text-indigo">
              {t("freqLegend")}
            </legend>
            <div className="mt-2 space-y-2">
              {DIGEST_FREQUENCY_OPTIONS.map((freq) => (
                <label
                  key={freq}
                  className="flex items-center gap-2 text-sm text-stone-700"
                >
                  <input
                    type="radio"
                    name="digestFrequency"
                    value={freq}
                    defaultChecked={user.digestFrequency === freq}
                    className="accent-indigo"
                  />
                  {t(FREQ_LABEL_KEYS[freq])}
                </label>
              ))}
            </div>
          </fieldset>
          <SaveButton
            pending={savingPreferences}
            label={t("save")}
            pendingLabel={t("common:save.saving")}
          />
        </Form>
      </div>

      {/* Connected accounts section */}
      <div className="mt-6 rounded-lg border border-stone-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-stone-700">
          {t("connected_accounts")}
        </h2>
        <div className="mt-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Github className="h-5 w-5 text-stone-700" />
            <span className="font-sans text-sm text-stone-700">GitHub</span>
          </div>
          {user.githubId ? (
            <span className="font-sans text-sm font-medium text-verdigris">
              {t("github_connected")}
            </span>
          ) : (
            <a
              href="/auth/github"
              className="font-sans text-sm font-medium text-indigo hover:underline"
            >
              {t("github_connect")}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// @version v0.9.0
