/**
 * Tests — github oauth tenant handoff: wrong-tenant edges
 *
 * This suite is the sibling to `tests/auth/github-handoff.test.ts`. That file pins the
 * happy path and the security-relevant invariants; this file covers
 * the wrong-tenant edge cases that branch on `homeTenant`
 * disability and the legacy host.
 *
 * The headline behaviour change (wrong-tenant 302 to /wrong-workspace
 * instead of /login?error=no-account) lives in the sibling file --
 * search for "wrong tenant: row's email matches a user on a different
 * tenant".
 *
 * Coverage:
 *   1. Wrong-tenant where the user's home tenant is soft-disabled
 *      (`disabledAt != null`) -> 302 to /login?error=no-account
 *      (no /wrong-workspace redirect, no session minted).
 *
 * The "ghost tenant" case (user.tenantId references a missing row) is
 * structurally unreachable: the FK constraint on `users.tenant_id`
 * prevents pointing a user at a non-existent tenant. The soft-disable
 * case below is the only "home tenant exists but unusable" branch.
 *
 * @version v0.4.1
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDatabase,
  getTestDb,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { tenants } from "../../app/db/schema";
import { insertHandoff } from "../../app/lib/oauth-handoff.server";

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

describe("GitHub OAuth handoff - wrong-tenant edges", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("user on a soft-disabled home tenant -> /login?error=no-account (no wrong-workspace redirect)", async () => {
    // User belongs to second-tenant; request is for neogranadina;
    // second-tenant has been soft-disabled. The interstitial CTA would
    // 404 if we sent the user there, so fall through to no-account.
    await createTestUser({
      email: "scholar@example.com",
      tenantId: SECOND_TEST_TENANT_ID,
    });

    const db = getTestDb();
    await db
      .update(tenants)
      .set({ disabledAt: Date.now() })
      .where(eq(tenants.id, SECOND_TEST_TENANT_ID));

    const id = "id-disabled-home-1";
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
    expect(r.headers.get("Location")).toBe("/login?error=no-account");
    const cookie = r.headers.get("Set-Cookie");
    expect(cookie === null || !cookie.includes("__session=")).toBe(true);
  });

});
