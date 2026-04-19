/**
 * Account Configuration Page
 *
 * Personal account preferences for the signed-in user: display name,
 * locale, and notification toggles. Scoped to the caller — no
 * administrative surfaces live here. Reachable from the sidebar
 * footer and the top-bar user menu.
 *
 * @version v0.3.0
 */

import { useState } from "react";
import { Form, useActionData } from "react-router";
import { useTranslation } from "react-i18next";
import { Github } from "lucide-react";
import { userContext } from "../context";
import type { Route } from "./+types/_auth.configuracion";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  return { user };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { users } = await import("~/db/schema");

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

    default:
      return { ok: false, error: "Unknown action" };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ConfiguracionPage({
  loaderData,
}: Route.ComponentProps) {
  const { user } = loaderData;
  const actionData = useActionData<typeof action>();
  const { t, i18n } = useTranslation("settings");
  const [activeLang, setActiveLang] = useState(i18n.language?.startsWith("es") ? "es" : "en");

  function handleLanguageChange(lang: string) {
    i18n.changeLanguage(lang);
    setActiveLang(lang);
    try {
      localStorage.setItem("i18nextLng", lang);
    } catch {
      // localStorage may not be available
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-12">
      <h1 className="font-display text-4xl font-semibold text-[#44403C]">
        {t("title")}
      </h1>

      {/* Success feedback */}
      {actionData?.ok && actionData?.intent === "updateProfile" && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-[#2F6B45] bg-[#D6E8DB] px-4 py-3 font-sans text-sm text-[#44403C]">
          {t("saved")}
        </div>
      )}

      {/* Profile section */}
      <div className="mt-6 rounded-lg border border-[#E7E5E4] bg-white p-6">
        <h2 className="text-lg font-semibold text-[#44403C]">
          {t("profile")}
        </h2>
        <Form method="post" className="mt-4 space-y-4">
          <input type="hidden" name="_action" value="updateProfile" />
          <div>
            <label
              htmlFor="settings-name"
              className="block font-sans text-xs font-medium text-[#78716C]"
            >
              {t("name")}
            </label>
            <input
              type="text"
              id="settings-name"
              name="name"
              defaultValue={user.name || ""}
              className="mt-1 block w-full max-w-sm rounded-lg border border-[#E7E5E4] px-3 py-2 font-sans text-sm shadow-sm focus:border-[#8B2942] focus:ring-1 focus:ring-[#8B2942] focus:outline-none"
            />
          </div>
          <div>
            <span className="block font-sans text-xs font-medium text-[#78716C]">
              {t("email")}
            </span>
            <p className="mt-1 font-sans text-sm text-[#78716C]">
              {user.email}
            </p>
          </div>
          <button
            type="submit"
            className="rounded-lg bg-[#6B1F33] px-4 py-2 text-sm font-semibold text-white hover:bg-[#8B2942]"
          >
            {t("save")}
          </button>
        </Form>
      </div>

      {/* Language section */}
      <div className="mt-6 rounded-lg border border-[#E7E5E4] bg-white p-6">
        <h2 className="text-lg font-semibold text-[#44403C]">
          {t("language")}
        </h2>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => handleLanguageChange("es")}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
              activeLang === "es"
                ? "bg-[#8B2942] text-white"
                : "border border-[#E7E5E4] bg-white text-[#44403C] hover:bg-[#FAFAF9]"
            }`}
          >
            {t("language_es")}
          </button>
          <button
            type="button"
            onClick={() => handleLanguageChange("en")}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
              activeLang === "en"
                ? "bg-[#8B2942] text-white"
                : "border border-[#E7E5E4] bg-white text-[#44403C] hover:bg-[#FAFAF9]"
            }`}
          >
            {t("language_en")}
          </button>
        </div>
      </div>

      {/* Connected accounts section */}
      <div className="mt-6 rounded-lg border border-[#E7E5E4] bg-white p-6">
        <h2 className="text-lg font-semibold text-[#44403C]">
          {t("connected_accounts")}
        </h2>
        <div className="mt-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Github className="h-5 w-5 text-[#44403C]" />
            <span className="font-sans text-sm text-[#44403C]">GitHub</span>
          </div>
          {user.githubId ? (
            <span className="font-sans text-sm font-medium text-[#2F6B45]">
              {t("github_connected")}
            </span>
          ) : (
            <a
              href="/auth/github"
              className="font-sans text-sm font-medium text-[#8B2942] hover:underline"
            >
              {t("github_connect")}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
