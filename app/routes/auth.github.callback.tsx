import { redirect } from "react-router";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/auth.github.callback";

/**
 * GitHub OAuth callback route.
 * Exchanges the authorization code for an access token, fetches the user's
 * primary email, looks them up in D1, and creates a session -- or redirects
 * to /login with an appropriate error.
 * Loader-only route -- no component rendered.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { createSessionStorage } = await import("../sessions.server");
  const { createGitHubClient, fetchGitHubUserEmail, parseCookieValue } =
    await import("../lib/github-auth.server");
  const { users } = await import("../db/schema");

  const env = context.cloudflare.env;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  // Verify state against cookie (CSRF protection -- per GH-04)
  const cookies = request.headers.get("Cookie") || "";
  const storedState = parseCookieValue(cookies, "github_oauth_state");

  if (!code || !state || state !== storedState) {
    throw redirect("/login?error=oauth-failed");
  }

  const origin = new URL(request.url).origin;
  const github = createGitHubClient(
    env.GITHUB_CLIENT_ID,
    env.GITHUB_CLIENT_SECRET,
    `${origin}/auth/github/callback`
  );

  try {
    const tokens = await github.validateAuthorizationCode(code);
    const accessToken = tokens.accessToken();

    // Fetch primary verified email from GitHub
    const primaryEmail = await fetchGitHubUserEmail(accessToken);

    if (!primaryEmail) {
      throw redirect("/login?error=no-email");
    }

    // Look up user by email in D1 (per D-01)
    const db = drizzle(env.DB);
    const user = await db
      .select()
      .from(users)
      .where(eq(users.email, primaryEmail))
      .get();

    // Reject if no matching user (per D-02)
    if (!user) {
      throw redirect("/login?error=no-account");
    }

    // Store GitHub user ID if not already stored
    if (!user.githubId) {
      const userResponse = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "Zasqua-Catalogacion",
        },
      });
      if (userResponse.ok) {
        const ghUser = (await userResponse.json()) as { id: number };
        await db
          .update(users)
          .set({ githubId: String(ghUser.id) })
          .where(eq(users.id, user.id));
      }
    }

    // Create session -- identical to magic link flow (per D-07)
    const { getSession, commitSession } = createSessionStorage(
      env.SESSION_SECRET
    );
    const session = await getSession();
    session.set("userId", user.id);

    // Clear OAuth state cookie + set session cookie
    const headers = new Headers();
    headers.append("Set-Cookie", await commitSession(session));
    headers.append(
      "Set-Cookie",
      "github_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
    );

    throw redirect("/dashboard", { headers });
  } catch (e) {
    if (e instanceof Response) throw e; // re-throw redirects
    // OAuth2RequestError or network errors
    throw redirect("/login?error=oauth-failed");
  }
}
