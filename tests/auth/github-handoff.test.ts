/**
 * Tests — github oauth tenant handoff
 *
 * This suite pins the tenant-side route at `<slug>.fisqua.org/auth/github/handoff`,
 * which consumes the single-use D1-backed handoff row, optionally binds
 * the GitHub user id on first sign-in, creates the host-only
 * session cookie, and 302s to `/dashboard`. This file pins the
 * security-relevant invariants:
 *
 *   - Replay: token consumed twice -> second attempt 410.
 *   - Expiry: pre-insert a row with expires_at = now-1 -> 410.
 *   - Slug-mismatch defence-in-depth: row's return_to_slug ≠ resolved
 *     tenant slug for the request host -> 410.
 *   - Unknown email: row's email does not match any users row -> 302 to
 *     /login?error=no-account.
 *   - Wrong tenant: row's email matches a user whose tenantId is a
 *     different tenant -> 302 to /login?error=no-account.
 *   - Happy path: 302 to /dashboard with host-only Set-Cookie; user's
 *     github_id is bound when previously null.
 *   - Apex check: route on `fisqua.test` apex returns 404.
 *
 * @version v0.4.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDatabase,
  getTestDb,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { oauthHandoffs, users } from "../../app/db/schema";
import {
  insertHandoff,
  OAUTH_HANDOFF_TTL_MS,
} from "../../app/lib/oauth-handoff.server";

function makeLoaderArgs(url: string) {
  const request = new Request(url);
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

/**
 * Run the loader and accept either a returned Response or a thrown
 * Response — React Router 7 loaders may use either idiom for redirects
 * and 4xx responses.
 */
async function runLoader(
  args: ReturnType<typeof makeLoaderArgs>,
): Promise<Response> {
  const { loader } = await import("../../app/routes/auth.github.handoff");
  try {
    const result = await loader(args as any);
    if (result instanceof Response) return result;
    throw new Error("loader returned non-Response");
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

describe("GitHub OAuth tenant handoff", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("happy path: 302 to /dashboard with host-only Set-Cookie", async () => {
    await createTestUser({
      email: "scholar@example.com",
      tenantId: DEFAULT_TEST_TENANT_ID,
    });
    const db = getTestDb();
    const id = "id-happy-1";
    await insertHandoff(db, {
      id,
      email: "scholar@example.com",
      githubId: "12345",
      githubLogin: "octocat",
      returnToSlug: "neogranadina",
      now: Date.now(),
    });

    const r = await runLoader(
      makeLoaderArgs(
        `https://neogranadina.fisqua.test/auth/github/handoff?t=${id}`,
      ),
    );
    expect(r).toBeInstanceOf(Response);
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/dashboard");

    // Find the __session cookie and assert host-only (no Domain).
    const allSetCookies: string[] = [];
    r.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") allSetCookies.push(value);
    });
    const session = allSetCookies.find((c) => c.startsWith("__session="));
    expect(session).toBeDefined();
    expect(session ?? "").not.toMatch(/Domain=/i);

    // github_id was bound on first sign-in.
    const [u] = await db
      .select()
      .from(users)
      .where(eq(users.email, "scholar@example.com"))
      .all();
    expect(u.githubId).toBe("12345");
  });

  it("replay: second consume of the same token returns 410", async () => {
    await createTestUser({
      email: "scholar@example.com",
      tenantId: DEFAULT_TEST_TENANT_ID,
    });
    const db = getTestDb();
    const id = "id-replay-1";
    await insertHandoff(db, {
      id,
      email: "scholar@example.com",
      githubId: "12345",
      githubLogin: "octocat",
      returnToSlug: "neogranadina",
      now: Date.now(),
    });

    const url = `https://neogranadina.fisqua.test/auth/github/handoff?t=${id}`;

    // First consume — happy path 302.
    const first = await runLoader(makeLoaderArgs(url));
    expect(first.status).toBe(302);

    // Second consume — 410.
    const second = await runLoader(makeLoaderArgs(url));
    expect(second.status).toBe(410);
  });

  it("expiry: row pre-inserted with expires_at = now-1 returns 410", async () => {
    await createTestUser({
      email: "scholar@example.com",
      tenantId: DEFAULT_TEST_TENANT_ID,
    });
    const db = getTestDb();
    const id = "id-expired-1";
    // Insert a row whose TTL has already elapsed by writing it with a
    // backdated `now`. expires_at = now + 30s, so passing now =
    // (real-now - 31s) gives a row expired 1s ago.
    const realNow = Date.now();
    await insertHandoff(db, {
      id,
      email: "scholar@example.com",
      githubId: "12345",
      githubLogin: "octocat",
      returnToSlug: "neogranadina",
      now: realNow - OAUTH_HANDOFF_TTL_MS - 1_000,
    });

    const r = await runLoader(
      makeLoaderArgs(
        `https://neogranadina.fisqua.test/auth/github/handoff?t=${id}`,
      ),
    );
    expect(r.status).toBe(410);
  });

  it("slug mismatch: row's return_to_slug differs from request host slug -> 410", async () => {
    await createTestUser({
      email: "scholar@example.com",
      tenantId: DEFAULT_TEST_TENANT_ID,
    });
    const db = getTestDb();
    const id = "id-slug-mismatch-1";
    await insertHandoff(db, {
      id,
      // Row's slug is `neogranadina`, but request host is `second-tenant.fisqua.test`.
      email: "scholar@example.com",
      githubId: "12345",
      githubLogin: "octocat",
      returnToSlug: "neogranadina",
      now: Date.now(),
    });

    const r = await runLoader(
      makeLoaderArgs(
        `https://second-tenant.fisqua.test/auth/github/handoff?t=${id}`,
      ),
    );
    expect(r.status).toBe(410);
  });

  it("unknown email: row's email matches no users -> 302 to /login?error=no-account", async () => {
    const db = getTestDb();
    const id = "id-no-account-1";
    await insertHandoff(db, {
      id,
      email: "stranger@example.com",
      githubId: "99999",
      githubLogin: "stranger",
      returnToSlug: "neogranadina",
      now: Date.now(),
    });

    const r = await runLoader(
      makeLoaderArgs(
        `https://neogranadina.fisqua.test/auth/github/handoff?t=${id}`,
      ),
    );
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toContain("/login?error=no-account");
  });

  it("wrong tenant: row's email matches a user on a different tenant -> 302 to /wrong-workspace?home=<slug>", async () => {
    // User exists but belongs to second-tenant; request is for neogranadina.
    // The /wrong-workspace interstitial replaces an earlier misleading
    // /login?error=no-account redirect (which lied — the user DOES
    // have an account, just on a different tenant).
    await createTestUser({
      email: "scholar@example.com",
      tenantId: SECOND_TEST_TENANT_ID,
    });
    const db = getTestDb();
    const id = "id-wrong-tenant-1";
    await insertHandoff(db, {
      id,
      email: "scholar@example.com",
      githubId: "12345",
      githubLogin: "octocat",
      returnToSlug: "neogranadina",
      now: Date.now(),
    });

    const r = await runLoader(
      makeLoaderArgs(
        `https://neogranadina.fisqua.test/auth/github/handoff?t=${id}`,
      ),
    );
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe(
      "/wrong-workspace?home=second-tenant",
    );
    // Critical: NO __session cookie minted for the wrong-tenant user.
    const cookie = r.headers.get("Set-Cookie");
    expect(cookie === null || !cookie.includes("__session=")).toBe(true);
  });

  it("apex check: GET https://fisqua.test/auth/github/handoff?t=<id> returns 404", async () => {
    const r = await runLoader(
      makeLoaderArgs("https://fisqua.test/auth/github/handoff?t=anything"),
    );
    expect(r).toBeInstanceOf(Response);
    expect(r.status).toBe(404);
  });

  it("missing token: ?t=<empty> returns 410", async () => {
    const r = await runLoader(
      makeLoaderArgs(
        "https://neogranadina.fisqua.test/auth/github/handoff?t=",
      ),
    );
    expect(r.status).toBe(410);
  });
});
