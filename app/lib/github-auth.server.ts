import * as arctic from "arctic";

export { generateState } from "arctic";

/**
 * Creates an Arctic GitHub OAuth client.
 */
export function createGitHubClient(
  clientId: string,
  clientSecret: string,
  redirectUri: string
) {
  return new arctic.GitHub(clientId, clientSecret, redirectUri);
}

/**
 * Fetches the primary verified email address from the GitHub API.
 * Returns the email lowercased, or null if no primary+verified email exists.
 */
export async function fetchGitHubUserEmail(
  accessToken: string
): Promise<string | null> {
  const response = await fetch("https://api.github.com/user/emails", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "Zasqua-Catalogacion",
    },
  });

  if (!response.ok) {
    return null;
  }

  const emails = (await response.json()) as Array<{
    email: string;
    primary: boolean;
    verified: boolean;
  }>;

  const primary = emails.find((e) => e.primary && e.verified);
  return primary ? primary.email.toLowerCase() : null;
}

/**
 * Parses a single cookie value from a Cookie header string.
 * Returns the decoded value, or null if the cookie is not found.
 */
export function parseCookieValue(
  cookieHeader: string,
  name: string
): string | null {
  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${name}=([^;]*)`)
  );
  return match ? decodeURIComponent(match[1]) : null;
}
