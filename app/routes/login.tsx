import { redirect, data } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { createSessionStorage } from "../sessions.server";
import { generateMagicLink } from "../lib/auth.server";
import type { Route } from "./+types/login";

const emailSchema = z.object({
  email: z.string().email("Please enter a valid email address."),
});

export function meta() {
  return [{ title: "Log in" }];
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
  const formData = await request.formData();

  const parsed = emailSchema.safeParse({
    email: formData.get("email"),
  });

  if (!parsed.success) {
    return data(
      { error: parsed.error.issues[0].message, success: false },
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

const errorMessages: Record<string, string> = {
  "expired-link": "This login link has expired. Please request a new one.",
  "invalid-link": "This login link is invalid. Please request a new one.",
};

export default function LoginPage({ actionData }: Route.ComponentProps) {
  const searchParams =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const urlError = searchParams.get("error");

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50">
      <div className="w-full max-w-sm space-y-6 px-4">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-stone-900">Log in</h1>
          <p className="mt-1 text-sm text-stone-500">
            Sign in to your account
          </p>
        </div>

        {urlError && errorMessages[urlError] && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {errorMessages[urlError]}
          </div>
        )}

        {actionData?.success ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            Check your email for a login link.
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
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                autoFocus
                className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm shadow-sm focus:border-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-500"
                placeholder="you@example.com"
              />
            </div>

            <button
              type="submit"
              className="w-full rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 focus:outline-none focus:ring-2 focus:ring-stone-500 focus:ring-offset-2"
            >
              Send login link
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
