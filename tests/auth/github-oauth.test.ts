/**
 * Tests — github oauth
 *
 * @version v0.3.0
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";

// Mock the arctic library so the route loaders' dynamic import picks up mocked dependency
vi.mock("arctic", () => ({
  GitHub: vi.fn().mockImplementation(() => ({
    createAuthorizationURL: vi.fn().mockReturnValue(
      new URL(
        "https://github.com/login/oauth/authorize?state=mock-state&scope=user:email"
      )
    ),
    validateAuthorizationCode: vi.fn().mockResolvedValue({
      accessToken: () => "mock-access-token",
    }),
  })),
  generateState: vi.fn().mockReturnValue("mock-state"),
}));

// Save original fetch so Workers runtime internals still work
const originalFetch = globalThis.fetch;

/**
 * Build a minimal Route.LoaderArgs-compatible context object for direct loader invocation.
 * This is the documented fallback when SELF.fetch cannot resolve
 * virtual:react-router/server-build in worktree environments.
 */
function makeLoaderArgs(url: string, cookies?: string) {
  const request = new Request(url, {
    headers: cookies ? { Cookie: cookies } : {},
  });
  return {
    request,
    context: {
      cloudflare: {
        env: {
          DB: env.DB,
          SESSION_SECRET: "test-session-secret",
          GITHUB_CLIENT_ID: "test-github-id",
          GITHUB_CLIENT_SECRET: "test-github-secret",
        },
      },
    },
    params: {},
  };
}

describe("GitHub OAuth", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();

    // Mock global fetch to intercept GitHub API calls
    const mockFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === "https://api.github.com/user/emails") {
          return new Response(
            JSON.stringify([
              {
                email: "scholar@example.com",
                primary: true,
                verified: true,
              },
            ]),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ id: 12345 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return originalFetch(input, init);
      }
    );
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.stubGlobal("fetch", originalFetch);
  });

  describe("OAuth initiation", () => {
    it("initiates OAuth flow with state cookie and redirect to GitHub", async () => {
      const { loader } = await import("../../app/routes/auth.github");
      const args = makeLoaderArgs("http://localhost/auth/github");
      const response = (await loader(args as any)) as Response;

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toContain(
        "github.com/login/oauth"
      );
      const setCookie = response.headers.get("Set-Cookie") || "";
      expect(setCookie).toContain("github_oauth_state=");
    });
  });

  describe("OAuth callback", () => {
    it("creates session for matching email", async () => {
      await createTestUser({ email: "scholar@example.com" });

      const { loader } = await import(
        "../../app/routes/auth.github.callback"
      );
      const args = makeLoaderArgs(
        "http://localhost/auth/github/callback?code=test-code&state=mock-state",
        "github_oauth_state=mock-state"
      );

      // The loader throws redirects, so catch them
      try {
        await loader(args as any);
        expect.unreachable("Should have thrown a redirect");
      } catch (e) {
        const response = e as Response;
        expect(response.status).toBe(302);
        expect(response.headers.get("Location")).toContain("/dashboard");
        // Session cookie should be set
        const cookies = response.headers.get("Set-Cookie") || "";
        expect(cookies).toContain("__session=");
      }
    });

    it("rejects unmatched email with no-account error", async () => {
      // Override mock to return a non-matching email
      const mockFetch = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;

          if (url === "https://api.github.com/user/emails") {
            return new Response(
              JSON.stringify([
                {
                  email: "stranger@example.com",
                  primary: true,
                  verified: true,
                },
              ]),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }
            );
          }

          if (url === "https://api.github.com/user") {
            return new Response(JSON.stringify({ id: 99999 }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }

          return originalFetch(input, init);
        }
      );
      vi.stubGlobal("fetch", mockFetch);

      const { loader } = await import(
        "../../app/routes/auth.github.callback"
      );
      const args = makeLoaderArgs(
        "http://localhost/auth/github/callback?code=test-code&state=mock-state",
        "github_oauth_state=mock-state"
      );

      try {
        await loader(args as any);
        expect.unreachable("Should have thrown a redirect");
      } catch (e) {
        const response = e as Response;
        expect(response.status).toBe(302);
        expect(response.headers.get("Location")).toContain(
          "/login?error=no-account"
        );
      }
    });

    it("rejects invalid state with oauth-failed error", async () => {
      const { loader } = await import(
        "../../app/routes/auth.github.callback"
      );
      const args = makeLoaderArgs(
        "http://localhost/auth/github/callback?code=test-code&state=wrong-state",
        "github_oauth_state=mock-state"
      );

      try {
        await loader(args as any);
        expect.unreachable("Should have thrown a redirect");
      } catch (e) {
        const response = e as Response;
        expect(response.status).toBe(302);
        expect(response.headers.get("Location")).toContain(
          "/login?error=oauth-failed"
        );
      }
    });

    it("rejects missing code with oauth-failed error", async () => {
      const { loader } = await import(
        "../../app/routes/auth.github.callback"
      );
      const args = makeLoaderArgs(
        "http://localhost/auth/github/callback?state=mock-state",
        "github_oauth_state=mock-state"
      );

      try {
        await loader(args as any);
        expect.unreachable("Should have thrown a redirect");
      } catch (e) {
        const response = e as Response;
        expect(response.status).toBe(302);
        expect(response.headers.get("Location")).toContain(
          "/login?error=oauth-failed"
        );
      }
    });

    it("handles missing verified email with no-email error", async () => {
      await createTestUser({ email: "scholar@example.com" });

      // Override mock to return no primary email
      const mockFetch = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;

          if (url === "https://api.github.com/user/emails") {
            return new Response(
              JSON.stringify([
                {
                  email: "scholar@example.com",
                  primary: false,
                  verified: true,
                },
              ]),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }
            );
          }

          if (url === "https://api.github.com/user") {
            return new Response(JSON.stringify({ id: 12345 }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }

          return originalFetch(input, init);
        }
      );
      vi.stubGlobal("fetch", mockFetch);

      const { loader } = await import(
        "../../app/routes/auth.github.callback"
      );
      const args = makeLoaderArgs(
        "http://localhost/auth/github/callback?code=test-code&state=mock-state",
        "github_oauth_state=mock-state"
      );

      try {
        await loader(args as any);
        expect.unreachable("Should have thrown a redirect");
      } catch (e) {
        const response = e as Response;
        expect(response.status).toBe(302);
        expect(response.headers.get("Location")).toContain(
          "/login?error=no-email"
        );
      }
    });
  });
});
