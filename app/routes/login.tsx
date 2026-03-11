import { redirect, data } from "react-router";
import { useTranslation } from "react-i18next";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { createSessionStorage } from "../sessions.server";
import { generateMagicLink } from "../lib/auth.server";
import { getInstance } from "~/middleware/i18next";
import type { Route } from "./+types/login";

const emailSchema = z.object({
  email: z.string().email(),
});

export function meta() {
  return [{ title: "Iniciar sesion | Zasqua Catalogacion" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env;
  const { getSession } = createSessionStorage(env.SESSION_SECRET);
  const session = await getSession(request.headers.get("Cookie"));

  if (session.get("userId")) {
    throw redirect("/");
  }

  return null;
}

export async function action({ request, context }: Route.ActionArgs) {
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
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-white">
      <div className="w-full max-w-sm space-y-6 px-4">
        <div className="text-center">
          <img src="/pomegranate.svg" alt="Zasqua" className="mx-auto h-24 w-24" />
          <h1 className="font-serif text-3xl font-semibold text-burgundy">Zasqua</h1>
          <p className="mt-1 text-sm text-stone-500">Catalogacion</p>
        </div>

        {urlError && errorMessages[urlError] && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {errorMessages[urlError]}
          </div>
        )}

        {actionData?.success ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {t("success_message")}
          </div>
        ) : (
          <form method="post" className="space-y-4">
            {actionData?.error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                {actionData.error}
              </div>
            )}

            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-stone-700"
              >
                {t("email_label")}
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                autoFocus
                className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm shadow-sm focus:border-burgundy-light focus:outline-none focus:ring-1 focus:ring-burgundy-light"
                placeholder={t("placeholder")}
              />
            </div>

            <button
              type="submit"
              className="w-full rounded-md bg-burgundy-deep px-4 py-2 text-sm font-medium text-white hover:bg-burgundy focus:outline-none focus:ring-2 focus:ring-burgundy-light focus:ring-offset-2"
            >
              {t("login_button")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
