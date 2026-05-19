/**
 * Tests — github oauth (apex init + callback)
 *
 * This suite pins the apex-init and apex-callback halves of the GitHub
 * OAuth flow. GitHub OAuth Apps do not allow multiple Authorization
 * callback URLs. The model is therefore one callback URL at apex
 * (`https://fisqua.org/auth/github/callback`) plus a single-use
 * D1-backed handoff token to the tenant subdomain; the tenant-side
 * handoff is covered in `tests/auth/github-handoff.test.ts`.
 *
 * Coverage:
 *   - Init: apex-only host check; required `?return_to=<slug>` slug; state
 *     cookie carries the slug; `redirect_uri` is the constant
 *     `https://fisqua.org/auth/github/callback` regardless of slug; tenant
 *     subdomain returns 404; non-existent / platform / malformed slugs
 *     return 400.
 *   - Callback: state validation; successful exchange inserts an
 *     oauth_handoffs row and 302s to the tenant handoff URL; NO
 *     `Set-Cookie: __session`; tenant subdomain returns 404.
 *
 * @version v0.4.0
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
import { applyMigrations, cleanDatabase, getTestDb } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { oauthHandoffs } from "../../app/db/schema";
import { eq } from "drizzle-orm";

// Captures the redirect_uri argument passed to arctic.GitHub's
// constructor on each invocation. redirect_uri must always be
// `https://fisqua.org/auth/github/callback`, regardless of the
// `?return_to=<slug>` query param.
const githubConstructorCalls: Array<{
  clientId: unknown;
  clientSecret: unknown;
  redirectUri: unknown;
}> = [];

// Mock the arctic library so the route loaders' dynamic import picks up mocked dependency
vi.mock("arctic", () => ({
  GitHub: vi
    .fn()
    .mockImplementation(
      (clientId: unknown, clientSecret: unknown, redirectUri: unknown) => {
        githubConstructorCalls.push({ clientId, clientSecret, redirectUri });
        return {
          createAuthorizationURL: vi.fn().mockReturnValue(
            new URL(
              "https://github.com/login/oauth/authorize?state=mock-state&scope=user:email"
            )
          ),
          validateAuthorizationCode: vi.fn().mockResolvedValue({
            accessToken: () => "mock-access-token",
          }),
        };
      }
    ),
  generateState: vi.fn().mockReturnValue("mock-state"),
}));

// Save original fetch so Workers runtime internals still work
const originalFetch = globalThis.fetch;

/**
 * Build a minimal Route.LoaderArgs-compatible context object for direct loader invocation.
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

describe("GitHub OAuth init -- apex-only with state-cookie return_to", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
    githubConstructorCalls.length = 0;
  });

  it("redirect_uri is constant apex regardless of return_to slug", async () => {
    const { loader } = await import("../../app/routes/auth.github");

    // First slug: neogranadina
    const args1 = makeLoaderArgs(
      "https://fisqua.test/auth/github?return_to=neogranadina",
    );
    try {
      await loader(args1 as any);
    } catch (e) {
      if (!(e instanceof Response)) throw e;
    }

    // Second slug: second-tenant
    const args2 = makeLoaderArgs(
      "https://fisqua.test/auth/github?return_to=second-tenant",
    );
    try {
      await loader(args2 as any);
    } catch (e) {
      if (!(e instanceof Response)) throw e;
    }

    expect(githubConstructorCalls.length).toBeGreaterThanOrEqual(2);
    const last2 = githubConstructorCalls.slice(-2);
    expect(last2[0].redirectUri).toBe(
      "https://fisqua.org/auth/github/callback",
    );
    expect(last2[1].redirectUri).toBe(
      "https://fisqua.org/auth/github/callback",
    );
  });

  it("state cookie carries both the CSRF state and the return_to slug", async () => {
    const { loader } = await import("../../app/routes/auth.github");
    const args = makeLoaderArgs(
      "https://fisqua.test/auth/github?return_to=neogranadina",
    );
    const response = (await loader(args as any)) as Response;
    expect(response.status).toBe(302);
    const setCookie = response.headers.get("Set-Cookie") || "";
    // The cookie body carries the arctic state plus the slug. Shape is
    // implementation-detail (single cookie or two); the test pins only
    // the contents (state + slug presence), not the exact format.
    expect(setCookie).toContain("github_oauth_state=");
    expect(setCookie).toMatch(/mock-state/);
    expect(setCookie).toMatch(/neogranadina/);
  });

  it("returns 404 when run on a tenant subdomain (apex-only)", async () => {
    const { loader } = await import("../../app/routes/auth.github");
    const args = makeLoaderArgs(
      "https://neogranadina.fisqua.test/auth/github?return_to=neogranadina",
    );
    try {
      const r = await loader(args as any);
      // Non-throwing 404 is acceptable too.
      expect((r as Response).status).toBe(404);
    } catch (e) {
      const r = e as Response;
      expect(r).toBeInstanceOf(Response);
      expect(r.status).toBe(404);
    }
  });

  it("returns 400 when return_to is missing", async () => {
    const { loader } = await import("../../app/routes/auth.github");
    const args = makeLoaderArgs("https://fisqua.test/auth/github");
    try {
      const r = await loader(args as any);
      expect((r as Response).status).toBe(400);
    } catch (e) {
      const r = e as Response;
      expect(r).toBeInstanceOf(Response);
      expect(r.status).toBe(400);
    }
  });

  it("returns 400 when return_to is empty", async () => {
    const { loader } = await import("../../app/routes/auth.github");
    const args = makeLoaderArgs("https://fisqua.test/auth/github?return_to=");
    try {
      const r = await loader(args as any);
      expect((r as Response).status).toBe(400);
    } catch (e) {
      const r = e as Response;
      expect(r.status).toBe(400);
    }
  });

  it("returns 400 when return_to is malformed (uppercase)", async () => {
    const { loader } = await import("../../app/routes/auth.github");
    const args = makeLoaderArgs(
      "https://fisqua.test/auth/github?return_to=NEOGRANADINA",
    );
    try {
      const r = await loader(args as any);
      expect((r as Response).status).toBe(400);
    } catch (e) {
      const r = e as Response;
      expect(r.status).toBe(400);
    }
  });

  it("returns 400 when return_to resolves to a non-existent tenant", async () => {
    const { loader } = await import("../../app/routes/auth.github");
    const args = makeLoaderArgs(
      "https://fisqua.test/auth/github?return_to=does-not-exist",
    );
    try {
      const r = await loader(args as any);
      expect((r as Response).status).toBe(400);
    } catch (e) {
      const r = e as Response;
      expect(r.status).toBe(400);
    }
  });

  it("returns 400 when return_to resolves to the platform tenant", async () => {
    const { loader } = await import("../../app/routes/auth.github");
    const args = makeLoaderArgs(
      "https://fisqua.test/auth/github?return_to=platform",
    );
    try {
      const r = await loader(args as any);
      expect((r as Response).status).toBe(400);
    } catch (e) {
      const r = e as Response;
      expect(r.status).toBe(400);
    }
  });
});

describe("GitHub OAuth callback -- apex-only with handoff insert", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
    githubConstructorCalls.length = 0;

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
          return new Response(
            JSON.stringify({ id: 12345, login: "octocat" }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        return originalFetch(input, init);
      }
    );
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.stubGlobal("fetch", originalFetch);
  });

  /**
   * Build a state cookie carrying both the arctic state and the
   * return_to slug. Mirrors what the apex init route writes.
   */
  function stateCookie(state: string, slug: string): string {
    return `github_oauth_state=${state}.${slug}`;
  }

  /**
   * Run the loader and accept either a returned Response or a thrown
   * Response — React Router 7 loaders may use either idiom for redirects.
   */
  async function runLoader(args: ReturnType<typeof makeLoaderArgs>) {
    const { loader } = await import("../../app/routes/auth.github.callback");
    try {
      const result = await loader(args as any);
      if (result instanceof Response) return result;
      throw new Error("loader returned non-Response");
    } catch (e) {
      if (e instanceof Response) return e;
      throw e;
    }
  }

  it("rejects state mismatch with redirect to /login?error=oauth-failed", async () => {
    const args = makeLoaderArgs(
      "https://fisqua.test/auth/github/callback?code=test-code&state=wrong-state",
      stateCookie("mock-state", "neogranadina"),
    );
    const r = await runLoader(args);
    expect(r).toBeInstanceOf(Response);
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toContain("/login?error=oauth-failed");
  });

  it("inserts a handoff row and 302s to the tenant handoff URL", async () => {
    const args = makeLoaderArgs(
      "https://fisqua.test/auth/github/callback?code=test-code&state=mock-state",
      stateCookie("mock-state", "neogranadina"),
    );
    const r = await runLoader(args);
    expect(r).toBeInstanceOf(Response);
    expect(r.status).toBe(302);
    const location = r.headers.get("Location") || "";
    // Shape: https://neogranadina.fisqua.org/auth/github/handoff?t=<id>
    expect(location).toMatch(
      /^https:\/\/neogranadina\.fisqua\.org\/auth\/github\/handoff\?t=[^&]+$/,
    );

    // Verify the row landed in oauth_handoffs.
    const db = getTestDb();
    const rows = await db.select().from(oauthHandoffs).all();
    expect(rows.length).toBe(1);
    expect(rows[0].email).toBe("scholar@example.com");
    expect(rows[0].githubId).toBe("12345");
    expect(rows[0].githubLogin).toBe("octocat");
    expect(rows[0].returnToSlug).toBe("neogranadina");
    expect(rows[0].consumed).toBe(false);
    // Token in the URL matches the row's id.
    const url = new URL(location);
    const t = url.searchParams.get("t");
    expect(t).toBe(rows[0].id);
  });

  it("issues NO Set-Cookie: __session on the apex callback", async () => {
    const args = makeLoaderArgs(
      "https://fisqua.test/auth/github/callback?code=test-code&state=mock-state",
      stateCookie("mock-state", "neogranadina"),
    );
    const r = await runLoader(args);
    expect(r).toBeInstanceOf(Response);
    // The response may carry a state-cookie clear, but it MUST NOT
    // carry a __session cookie. Apex has no user session.
    const allSetCookies: string[] = [];
    r.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") allSetCookies.push(value);
    });
    const sessionCookies = allSetCookies.filter((c) =>
      c.startsWith("__session="),
    );
    expect(sessionCookies.length).toBe(0);
  });

  it("returns 404 when the callback runs on a tenant subdomain", async () => {
    const args = makeLoaderArgs(
      "https://neogranadina.fisqua.test/auth/github/callback?code=test-code&state=mock-state",
      stateCookie("mock-state", "neogranadina"),
    );
    const r = await runLoader(args);
    expect(r).toBeInstanceOf(Response);
    expect(r.status).toBe(404);
  });

  it("rejects missing code with /login?error=oauth-failed", async () => {
    const args = makeLoaderArgs(
      "https://fisqua.test/auth/github/callback?state=mock-state",
      stateCookie("mock-state", "neogranadina"),
    );
    const r = await runLoader(args);
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toContain("/login?error=oauth-failed");
  });

  it("rejects when the GitHub primary email is missing", async () => {
    // Override fetch to return no primary verified email.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url === "https://api.github.com/user/emails") {
          return new Response(
            JSON.stringify([
              { email: "scholar@example.com", primary: false, verified: true },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === "https://api.github.com/user") {
          return new Response(
            JSON.stringify({ id: 12345, login: "octocat" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return originalFetch(input, init);
      }),
    );

    const args = makeLoaderArgs(
      "https://fisqua.test/auth/github/callback?code=test-code&state=mock-state",
      stateCookie("mock-state", "neogranadina"),
    );
    const r = await runLoader(args);
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toContain("/login?error=no-email");
  });
});
