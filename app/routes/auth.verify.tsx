import { redirect } from "react-router";
import type { Route } from "./+types/auth.verify";

/**
 * Magic link verification endpoint.
 * Loader-only route -- no component rendered.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { createSessionStorage } = await import("../sessions.server");
  const { verifyMagicLink } = await import("../lib/auth.server");

  const env = context.cloudflare.env;
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    throw redirect("/login?error=invalid-link");
  }

  const db = drizzle(env.DB);
  const userId = await verifyMagicLink(db, token);

  if (!userId) {
    throw redirect("/login?error=expired-link");
  }

  // Create session
  const { getSession, commitSession } = createSessionStorage(
    env.SESSION_SECRET
  );
  const session = await getSession();
  session.set("userId", userId);

  throw redirect("/dashboard", {
    headers: {
      "Set-Cookie": await commitSession(session),
    },
  });
}
