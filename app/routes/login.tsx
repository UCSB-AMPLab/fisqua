import { redirect, data } from "react-router";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { CircleCheck, CircleX, Github, Mail } from "lucide-react";
import type { Route } from "./+types/login";

const emailSchema = z.object({
  email: z.string().email(),
});

export function meta() {
  return [{ title: "Iniciar sesión | Fisqua" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { createSessionStorage } = await import("../sessions.server");

  const env = context.cloudflare.env;
  const { getSession } = createSessionStorage(env.SESSION_SECRET);
  const session = await getSession(request.headers.get("Cookie"));

  if (session.get("userId")) {
    throw redirect("/");
  }

  return null;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { createSessionStorage } = await import("../sessions.server");
  const { generateMagicLink } = await import("../lib/auth.server");
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
  const result = await generateMagicLink(
    db,
    parsed.data.email,
    origin,
    env.RESEND_API_KEY,
    env
  );

  if (result.error) {
    return data({ error: result.error, success: false }, { status: 400 });
  }

  return data({ success: true, error: null });
}

export default function LoginPage({ actionData }: Route.ComponentProps) {
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

  return (
    <div className="flex min-h-screen items-center justify-center bg-white">
      <div className="mx-auto w-full max-w-md space-y-6 px-4">
        <div className="text-center">
          <img
            src="/brand/fisqua-mark.svg"
            alt="Fisqua"
            className="mx-auto h-24 w-24"
          />
          <h1 className="mt-4 font-display text-[2.5rem] font-semibold text-indigo">
            Fisqua
          </h1>
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
            {/* GitHub login button -- primary position (per D-03) */}
            <a
              href="/auth/github"
              className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#24292f] font-sans text-[0.9375rem] font-semibold text-white hover:bg-[#1b1f23] focus:outline-none focus:ring-2 focus:ring-[#24292f] focus:ring-offset-2"
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
                  <span>{actionData.error}</span>
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
                className="flex h-12 w-full items-center justify-center gap-2 rounded-md bg-indigo font-sans text-[0.9375rem] font-semibold text-parchment hover:bg-indigo-deep focus:outline-none focus:ring-2 focus:ring-indigo focus:ring-offset-2"
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
