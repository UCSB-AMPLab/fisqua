/**
 * Tests — auth.verify wrong-tenant gate
 *
 * This suite exercises the `app/routes/auth.verify.tsx` loader's tenant-
 * alignment check between `verifyMagicLink` and session minting.
 * Without this gate a Neogranadina user clicking a magic link
 * minted on `second-tenant.fisqua.test` would get a `__session`
 * cookie minted on the wrong subdomain and 403 at `authMiddleware`.
 * The loader detects the mismatch and 302s to the
 * `/wrong-workspace` interstitial WITHOUT minting a session.
 *
 * Coverage:
 *   1. wrong subdomain + magic link valid + home tenant resolvable
 *      -> 302 to `/wrong-workspace?home=<slug>`, NO `Set-Cookie` for
 *      `__session` on the response.
 *   2. matching subdomain (regression) -> 302 to `/dashboard` with
 *      `Set-Cookie` for `__session`.
 *   3. expired/invalid token (regression) -> 302 to
 *      `/login?error=expired-link`, no session minted.
 *   4. wrong subdomain + user's home tenant is soft-disabled -> 302
 *      to `/login?error=no-account`, no session minted.
 *   5. wrong subdomain + live federation steward grant into the host
 *      tenant's federation -> session minted, 302 to `/dashboard`
 *      (the grant door; without it stewards can never enter member
 *      tenants — sessions are host-scoped).
 *   6. wrong subdomain + grant on an UNRELATED federation -> still
 *      bounced to `/wrong-workspace` (grants are federation-scoped).
 *
 * @version v0.6.1
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
  SECOND_TEST_FEDERATION_ID,
  DEFAULT_TEST_FEDERATION_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import * as schema from "../../app/db/schema";

function makeLoaderArgs(url: string) {
  const request = new Request(url);
  return {
    request,
    context: {
      cloudflare: {
        env: {
          DB: env.DB,
          SESSION_SECRET: "test-session-secret",
          RESEND_API_KEY: "test-resend-key",
        },
      },
    },
    params: {},
  };
}

/**
 * Seed a magic-link token for `userId` and return it. The token is
 * fresh (15-minute expiry), unused, and points at the given user.
 */
async function seedMagicToken(
  userId: string,
  overrides?: { expiresAt?: number; usedAt?: number | null },
): Promise<string> {
  const db = drizzle(env.DB);
  const token = crypto.randomUUID();
  await db.insert(schema.magicLinks).values({
    id: crypto.randomUUID(),
    token,
    userId,
    expiresAt: overrides?.expiresAt ?? Date.now() + 15 * 60 * 1000,
    usedAt: overrides?.usedAt ?? null,
    createdAt: Date.now(),
  });
  return token;
}

describe("auth.verify wrong-tenant gate", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("redirects to /wrong-workspace and does NOT mint a session when host tenant differs from user.tenantId", async () => {
    // Neogranadina user, magic link clicked on second-tenant.fisqua.test.
    const user = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID });
    const token = await seedMagicToken(user.id);

    const { loader } = await import("../../app/routes/auth.verify");

    try {
      await loader(
        makeLoaderArgs(
          `https://second-tenant.fisqua.test/auth/verify?token=${token}`,
        ) as any,
      );
      expect.unreachable("loader should have thrown a redirect");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      const response = e as Response;
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(
        "/wrong-workspace?home=neogranadina",
      );
      // Critical: NO __session cookie on the wrong-tenant response.
      const cookie = response.headers.get("Set-Cookie");
      expect(cookie === null || !cookie.includes("__session=")).toBe(true);
    }
  });

  it("mints the session and redirects to /dashboard when host matches user.tenantId (regression)", async () => {
    const user = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID });
    const token = await seedMagicToken(user.id);

    const { loader } = await import("../../app/routes/auth.verify");

    try {
      await loader(
        makeLoaderArgs(
          `https://neogranadina.fisqua.test/auth/verify?token=${token}`,
        ) as any,
      );
      expect.unreachable("loader should have thrown a redirect");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      const response = e as Response;
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/dashboard");
      expect(response.headers.get("Set-Cookie")).toContain("__session=");
    }
  });

  it("mints the session and redirects to /dashboard when the user holds a steward grant into the host tenant's federation", async () => {
    // Neogranadina-home user, steward of the Second Test Federation,
    // magic link clicked on second-tenant.fisqua.test: the grant door
    // admits them; authMiddleware resolves the effective role later.
    const user = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID });
    const db = drizzle(env.DB);
    await db.insert(schema.federationMemberships).values({
      id: crypto.randomUUID(),
      userId: user.id,
      federationId: SECOND_TEST_FEDERATION_ID,
      role: "steward",
      createdAt: Date.now(),
    });
    const token = await seedMagicToken(user.id);

    const { loader } = await import("../../app/routes/auth.verify");

    try {
      await loader(
        makeLoaderArgs(
          `https://second-tenant.fisqua.test/auth/verify?token=${token}`,
        ) as any,
      );
      expect.unreachable("loader should have thrown a redirect");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      const response = e as Response;
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/dashboard");
      expect(response.headers.get("Set-Cookie")).toContain("__session=");
    }
  });

  it("still bounces to /wrong-workspace when the user's only grant is on an unrelated federation", async () => {
    // A steward grant on the user's OWN home federation must not open
    // doors elsewhere: grants are federation-scoped.
    const user = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID });
    const db = drizzle(env.DB);
    await db.insert(schema.federationMemberships).values({
      id: crypto.randomUUID(),
      userId: user.id,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      role: "steward",
      createdAt: Date.now(),
    });
    const token = await seedMagicToken(user.id);

    const { loader } = await import("../../app/routes/auth.verify");

    try {
      await loader(
        makeLoaderArgs(
          `https://second-tenant.fisqua.test/auth/verify?token=${token}`,
        ) as any,
      );
      expect.unreachable("loader should have thrown a redirect");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      const response = e as Response;
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(
        "/wrong-workspace?home=neogranadina",
      );
      const cookie = response.headers.get("Set-Cookie");
      expect(cookie === null || !cookie.includes("__session=")).toBe(true);
    }
  });

  it("redirects to /login?error=expired-link for an expired token (regression)", async () => {
    const user = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID });
    const token = await seedMagicToken(user.id, {
      expiresAt: Date.now() - 1000,
    });

    const { loader } = await import("../../app/routes/auth.verify");

    try {
      await loader(
        makeLoaderArgs(
          `https://second-tenant.fisqua.test/auth/verify?token=${token}`,
        ) as any,
      );
      expect.unreachable("loader should have thrown a redirect");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      const response = e as Response;
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(
        "/login?error=expired-link",
      );
      const cookie = response.headers.get("Set-Cookie");
      expect(cookie === null || !cookie.includes("__session=")).toBe(true);
    }
  });

  it("redirects to /login?error=no-account when the user's home tenant is soft-disabled", async () => {
    // Create a user on second-tenant, then soft-disable that tenant,
    // then click a magic link on neogranadina.fisqua.test.
    const user = await createTestUser({ tenantId: SECOND_TEST_TENANT_ID });
    const token = await seedMagicToken(user.id);

    // Soft-disable the home tenant.
    const db = drizzle(env.DB);
    const { eq } = await import("drizzle-orm");
    await db
      .update(schema.tenants)
      .set({ disabledAt: Date.now() })
      .where(eq(schema.tenants.id, SECOND_TEST_TENANT_ID));

    const { loader } = await import("../../app/routes/auth.verify");

    try {
      await loader(
        makeLoaderArgs(
          `https://neogranadina.fisqua.test/auth/verify?token=${token}`,
        ) as any,
      );
      expect.unreachable("loader should have thrown a redirect");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      const response = e as Response;
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/login?error=no-account");
      const cookie = response.headers.get("Set-Cookie");
      expect(cookie === null || !cookie.includes("__session=")).toBe(true);
    }
  });
});
