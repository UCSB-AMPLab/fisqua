import { redirect } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import { createSessionStorage } from "../sessions.server";
import { acceptInvite } from "../lib/invites.server";
import type { Route } from "./+types/invite.accept";

/**
 * Invite acceptance endpoint.
 * Loader-only route -- no component rendered.
 * Accepts an invite token, creates membership, starts a session,
 * and redirects to the project.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env;
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    throw redirect("/login?error=invalid-invite");
  }

  const db = drizzle(env.DB);
  const result = await acceptInvite(db, token);

  if (!result.success) {
    throw redirect("/login?error=invalid-invite");
  }

  // Create session for the user
  const { getSession, commitSession } = createSessionStorage(
    env.SESSION_SECRET
  );
  const session = await getSession();
  session.set("userId", result.userId);

  throw redirect(`/projects/${result.projectId}`, {
    headers: {
      "Set-Cookie": await commitSession(session),
    },
  });
}
