/**
 * Tests — auth middleware
 *
 * This suite is the integration-coverage net for `app/middleware/auth.server.ts`. The
 * middleware is a two-context (user + tenant) gate: it resolves the
 * user from the session cookie, resolves the tenant from the request
 * `Host` header, asserts `user.tenantId === tenant.id`, and only
 * then attaches both contexts and runs the lastActiveAt throttle.
 *
 * The cases below construct synthetic `Request` objects with the
 * required `Host` header (encoded in the URL) and a real session
 * cookie produced via `createSessionStorage`. They invoke
 * `authMiddleware` directly with a `RouterContextProvider` that
 * exposes `cloudflare.env` so the middleware can pull
 * `SESSION_SECRET` and `DB` exactly as it does at the edge.
 *
 * Coverage:
 *   - tenant context attaches on a legacy-host request and the
 *     resolved row is the seeded `neogranadina` tenant.
 *   - alignment passes when `user.tenantId === tenant.id`.
 *   - cross-tenant attempt (Neogranadina user reaching a
 *     `second-tenant.fisqua.test` URL) is rejected with 403.
 *   - unknown host throws 404 (no body / header leak).
 *   - missing session cookie still redirects to `/login` (regression
 *     check on existing behaviour).
 *   - lastActiveAt throttle still suppresses repeat writes within
 *     5 minutes (regression check on existing logic).
 *
 * @version v0.4.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { authMiddleware } from "../../app/middleware/auth.server";
import {
  impersonationContext,
  tenantContext,
  userContext,
} from "../../app/context";
import { createSessionStorage } from "../../app/sessions.server";
import { users } from "../../app/db/schema";

const TEST_SECRET = "test-session-secret";

async function makeSessionCookie(userId: string): Promise<string> {
  const { getSession, commitSession } = createSessionStorage(TEST_SECRET);
  const session = await getSession();
  session.set("userId", userId);
  return commitSession(session);
}

async function makeImpersonatingSessionCookie(
  userId: string,
  impersonating: {
    role: "isAdmin" | "isSuperAdmin" | "isCollabAdmin" | "isArchiveUser" | "isUserManager" | "isCataloguer";
    sessionId: string;
    lastActivityAt: number;
  },
): Promise<string> {
  const { getSession, commitSession } = createSessionStorage(TEST_SECRET);
  const session = await getSession();
  session.set("userId", userId);
  session.set("impersonating", impersonating);
  return commitSession(session);
}

function buildContext(): any {
  const ctx = new RouterContextProvider();
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function buildAuthenticatedRequest(
  userId: string,
  url: string,
): Promise<Request> {
  const cookie = await makeSessionCookie(userId);
  return new Request(url, { headers: { Cookie: cookie } });
}

describe("authMiddleware", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("attaches tenant context on a legacy-host request", async () => {
    const user = await createTestUser({
      tenantId: DEFAULT_TEST_TENANT_ID,
      isAdmin: true,
    });
    const request = await buildAuthenticatedRequest(
      user.id,
      "https://catalogacion.zasqua.org/admin/descriptions",
    );
    const ctx = buildContext();

    await authMiddleware({ request, context: ctx } as any, async () => undefined);

    const attachedUser = ctx.get(userContext);
    const attachedTenant = ctx.get(tenantContext);
    expect(attachedUser.id).toBe(user.id);
    expect(attachedTenant.id).toBe(DEFAULT_TEST_TENANT_ID);
    expect(attachedTenant.slug).toBe("neogranadina");
  });

  it("alignment passes when user.tenantId === tenant.id (subdomain host)", async () => {
    const user = await createTestUser({
      tenantId: DEFAULT_TEST_TENANT_ID,
      isAdmin: true,
    });
    const request = await buildAuthenticatedRequest(
      user.id,
      "https://neogranadina.fisqua.test/admin/descriptions",
    );
    const ctx = buildContext();

    await authMiddleware({ request, context: ctx } as any, async () => undefined);

    expect(ctx.get(tenantContext).slug).toBe("neogranadina");
  });

  it("cross-tenant attempt is redirected to /wrong-workspace", async () => {
    // Neogranadina user reaching a second-tenant URL. The middleware
    // 302s to the same-host /wrong-workspace?home=<slug>
    // interstitial, with the stale __session cookie cleared on the
    // response.
    const user = await createTestUser({
      tenantId: DEFAULT_TEST_TENANT_ID,
      isAdmin: true,
    });
    const request = await buildAuthenticatedRequest(
      user.id,
      "https://second-tenant.fisqua.test/admin/descriptions",
    );
    const ctx = buildContext();

    try {
      await authMiddleware({ request, context: ctx } as any, async () => undefined);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      const response = e as Response;
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(
        "/wrong-workspace?home=neogranadina",
      );
      // Stale session is cleared on the way out.
      const cookie = response.headers.get("Set-Cookie") ?? "";
      expect(cookie).toContain("__session=");
      expect(cookie).toMatch(/Max-Age=0|Expires=/i);
    }
  });

  it("operator user on tenant subdomain (no impersonation envelope) still 403s", async () => {
    // The wrong-workspace redirect MUST NOT fire when
    // user.tenantId === PLATFORM_TENANT_ID. Operator hitting a
    // tenant subdomain without an active impersonation envelope is
    // a security boundary and must keep 403'ing.
    const { PLATFORM_TENANT_ID } = await import("../../app/lib/tenant");
    const operator = await createTestUser({
      tenantId: PLATFORM_TENANT_ID,
      isAdmin: true,
    });
    const request = await buildAuthenticatedRequest(
      operator.id,
      "https://second-tenant.fisqua.test/admin/descriptions",
    );
    const ctx = buildContext();

    try {
      await authMiddleware({ request, context: ctx } as any, async () => undefined);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });

  it("cross-tenant attempt on legacy host falls through to 403", async () => {
    // catalogacion.zasqua.org maps to neogranadina via
    // LEGACY_HOST_MAP, but is not in SUBDOMAIN_HOST_SUFFIXES, so the
    // interstitial CTA can't be built. Fall through to the bare 403.
    const user = await createTestUser({
      tenantId: SECOND_TEST_TENANT_ID,
      isAdmin: true,
    });
    const request = await buildAuthenticatedRequest(
      user.id,
      "https://catalogacion.zasqua.org/admin/descriptions",
    );
    const ctx = buildContext();

    try {
      await authMiddleware({ request, context: ctx } as any, async () => undefined);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });

  it("cross-tenant attempt where home tenant is soft-disabled falls through to 403", async () => {
    // Home tenant exists but disabledAt is set → no interstitial
    // (CTA would 404). Fall through to 403.
    const user = await createTestUser({
      tenantId: SECOND_TEST_TENANT_ID,
      isAdmin: true,
    });

    // Soft-disable the user's home tenant.
    const { tenants } = await import("../../app/db/schema");
    const db = drizzle(env.DB);
    await db
      .update(tenants)
      .set({ disabledAt: Date.now() })
      .where(eq(tenants.id, SECOND_TEST_TENANT_ID));

    const request = await buildAuthenticatedRequest(
      user.id,
      "https://neogranadina.fisqua.test/admin/descriptions",
    );
    const ctx = buildContext();

    try {
      await authMiddleware({ request, context: ctx } as any, async () => undefined);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });

  it("unknown host is rejected with 404", async () => {
    const user = await createTestUser({
      tenantId: DEFAULT_TEST_TENANT_ID,
      isAdmin: true,
    });
    const request = await buildAuthenticatedRequest(
      user.id,
      "https://unknown.example.com/admin/descriptions",
    );
    const ctx = buildContext();

    try {
      await authMiddleware({ request, context: ctx } as any, async () => undefined);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
  });

  it("missing session redirects to /login", async () => {
    // No Cookie header at all.
    const request = new Request(
      "https://catalogacion.zasqua.org/admin/descriptions",
    );
    const ctx = buildContext();

    try {
      await authMiddleware({ request, context: ctx } as any, async () => undefined);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBeGreaterThanOrEqual(300);
      expect((e as Response).status).toBeLessThan(400);
      const location = (e as Response).headers.get("Location");
      expect(location).toBe("/login");
    }
  });

  // impersonationContext + idle timeout.
  it("impersonationContext is null when session has no impersonating envelope", async () => {
    const user = await createTestUser({
      tenantId: DEFAULT_TEST_TENANT_ID,
      isAdmin: true,
    });
    const request = await buildAuthenticatedRequest(
      user.id,
      "https://catalogacion.zasqua.org/admin/descriptions",
    );
    const ctx = buildContext();

    await authMiddleware({ request, context: ctx } as any, async () => undefined);

    expect(ctx.get(impersonationContext)).toBeNull();
  });

  it("impersonationContext is populated when session carries an impersonating envelope", async () => {
    // Operator user — tenantId = PLATFORM_TENANT_ID, hits a tenant
    // subdomain. The impersonating envelope on the session opts the
    // request into requireTenantUser's allowImpersonation carve-out.
    const { PLATFORM_TENANT_ID } = await import("../../app/lib/tenant");
    const operator = await createTestUser({
      tenantId: PLATFORM_TENANT_ID,
      isAdmin: true,
      email: "operator-imp@example.test",
    });
    const startedAt = Date.now();
    const cookie = await makeImpersonatingSessionCookie(operator.id, {
      role: "isCataloguer",
      sessionId: "sess-test-1",
      lastActivityAt: startedAt,
    });
    const request = new Request(
      "https://neogranadina.fisqua.test/dashboard",
      { headers: { Cookie: cookie } },
    );
    const ctx = buildContext();

    await authMiddleware({ request, context: ctx } as any, async () =>
      new Response("ok"),
    );

    const state = ctx.get(impersonationContext);
    expect(state).not.toBeNull();
    expect(state!.role).toBe("isCataloguer");
    expect(state!.sessionId).toBe("sess-test-1");
    // lastActivityAt is refreshed to "now" inside the middleware; allow
    // a generous skew for slow CI but require it to have moved forward.
    expect(state!.lastActivityAt).toBeGreaterThanOrEqual(startedAt);
  });

  it("redirects to /login and clears impersonating when lastActivityAt is older than 30 minutes", async () => {
    const { PLATFORM_TENANT_ID } = await import("../../app/lib/tenant");
    const operator = await createTestUser({
      tenantId: PLATFORM_TENANT_ID,
      isAdmin: true,
      email: "operator-stale@example.test",
    });
    // 31 minutes ago — past the 30-minute idle timeout.
    const stale = Date.now() - 31 * 60 * 1000;
    const cookie = await makeImpersonatingSessionCookie(operator.id, {
      role: "isCataloguer",
      sessionId: "sess-stale-1",
      lastActivityAt: stale,
    });
    const request = new Request(
      "https://neogranadina.fisqua.test/dashboard",
      { headers: { Cookie: cookie } },
    );
    const ctx = buildContext();

    try {
      await authMiddleware({ request, context: ctx } as any, async () =>
        new Response("ok"),
      );
      expect.fail("Should have redirected");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      const r = e as Response;
      expect(r.status).toBeGreaterThanOrEqual(300);
      expect(r.status).toBeLessThan(400);
      expect(r.headers.get("Location")).toBe("/login");
      // Set-Cookie header carries the cleared session.
      expect(r.headers.get("Set-Cookie")).not.toBeNull();
    }
  });

  it("refreshes impersonating.lastActivityAt and re-commits the session cookie on each request", async () => {
    const { PLATFORM_TENANT_ID } = await import("../../app/lib/tenant");
    const operator = await createTestUser({
      tenantId: PLATFORM_TENANT_ID,
      isAdmin: true,
      email: "operator-refresh@example.test",
    });
    const earlier = Date.now() - 5 * 60 * 1000; // 5 min ago — fresh.
    const cookie = await makeImpersonatingSessionCookie(operator.id, {
      role: "isAdmin",
      sessionId: "sess-refresh-1",
      lastActivityAt: earlier,
    });
    const request = new Request(
      "https://neogranadina.fisqua.test/dashboard",
      { headers: { Cookie: cookie } },
    );
    const ctx = buildContext();

    const response = await authMiddleware(
      { request, context: ctx } as any,
      async () => new Response("ok"),
    );
    // The middleware returns the wrapped response with Set-Cookie.
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).headers.get("Set-Cookie")).not.toBeNull();

    const state = ctx.get(impersonationContext);
    expect(state).not.toBeNull();
    expect(state!.lastActivityAt).toBeGreaterThan(earlier);
  });

  it("lastActiveAt throttle suppresses repeat writes within 5 minutes", async () => {
    const user = await createTestUser({
      tenantId: DEFAULT_TEST_TENANT_ID,
      isAdmin: true,
    });
    const db = drizzle(env.DB);

    // Stamp lastActiveAt fresh to a value within the throttle window.
    const fresh = Date.now();
    await db
      .update(users)
      .set({ lastActiveAt: fresh })
      .where(eq(users.id, user.id));

    const request = await buildAuthenticatedRequest(
      user.id,
      "https://catalogacion.zasqua.org/admin/descriptions",
    );
    const ctx = buildContext();

    await authMiddleware({ request, context: ctx } as any, async () => undefined);

    const [row] = await db
      .select({ lastActiveAt: users.lastActiveAt })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)
      .all();

    // Throttle is "do not update within 5 minutes" -- the value must
    // still equal the freshly stamped value, not have been bumped to
    // Date.now() inside the middleware.
    expect(row?.lastActiveAt).toBe(fresh);
  });
});
