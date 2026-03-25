import { redirect } from "react-router";
import type { Route } from "./+types/auth.github";

/**
 * GitHub OAuth initiation route.
 * Redirects the user to GitHub's authorization page with a state cookie for CSRF protection.
 * Loader-only route -- no component rendered.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { createGitHubClient, generateState } = await import(
    "../lib/github-auth.server"
  );

  const env = context.cloudflare.env;
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw redirect("/login?error=oauth-failed");
  }

  const origin = new URL(request.url).origin;
  const github = createGitHubClient(
    env.GITHUB_CLIENT_ID,
    env.GITHUB_CLIENT_SECRET,
    `${origin}/auth/github/callback`
  );

  const state = generateState();
  const url = github.createAuthorizationURL(state, ["user:email"]);

  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      "Set-Cookie": `github_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}
