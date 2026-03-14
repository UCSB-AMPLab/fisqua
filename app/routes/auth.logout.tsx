import { redirect } from "react-router";
import type { Route } from "./+types/auth.logout";

/**
 * Logout action (POST only).
 * Destroys the session cookie and redirects to /login.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const { createSessionStorage } = await import("../sessions.server");

  const env = context.cloudflare.env;
  const { getSession, destroySession } = createSessionStorage(
    env.SESSION_SECRET
  );
  const session = await getSession(request.headers.get("Cookie"));

  throw redirect("/login", {
    headers: {
      "Set-Cookie": await destroySession(session),
    },
  });
}
