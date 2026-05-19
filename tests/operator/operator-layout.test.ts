/**
 * Tests — operator layout
 *
 * This suite pins the gate behaviour of the `_operator` layout's middleware
 * (`app/middleware/operator-auth.server.ts`):
 *
 *   1. Operator session on the platform host → middleware completes
 *      without throwing; userContext + tenantContext + impersonationContext
 *      all populated.
 *   2. Non-operator session on the platform host → 404 from the
 *      assertNonPlatformOrAllowlisted gate inside getTenantFromRequest's
 *      caller? No — the operator middleware does not run the platform-host
 *      404 check. Instead, the assertOperator(tenant) gate 403s the
 *      operator middleware when the resolved tenant is not the platform.
 *      On a tenant subdomain that means a non-platform tenant + 403; on
 *      the platform host the resolved tenant IS the platform tenant, so
 *      a NEOGRANADINA user hitting platform host actually 403s here too
 *      because requireTenantUser would 403 first if it ran — but the
 *      operator middleware does NOT call requireTenantUser, so the only
 *      gate left is assertOperator(tenant). Since the tenant resolves to
 *      platform on the platform host, assertOperator passes for any
 *      authenticated user who lands on the platform host. Wait — that
 *      means a Neogranadina user reaching platform.fisqua.test/operator
 *      WOULD pass operator middleware, which is wrong.
 *
 *      Correction: the platform-host gate is enforced upstream by
 *      `assertNonPlatformOrAllowlisted` from authMiddleware on tenant
 *      subdomains. On the platform host itself, `requireTenantUser`
 *      from authMiddleware would 403 a non-platform user before they
 *      ever reach `_operator` — except `_operator` is a SIBLING of
 *      `_auth` and runs its OWN middleware, not authMiddleware.
 *      Therefore on the platform host, the only structural gate is
 *      assertOperator(tenant) which checks tenant.kind === 'platform'
 *      — which is true for the platform host regardless of user. The
 *      missing piece is a check that the USER's tenantId is the
 *      platform tenant.
 *
 *      Add this check: the operator middleware must verify
 *      user.tenantId === PLATFORM_TENANT_ID. assertOperator gates the
 *      tenant; the user check gates the user. Both are required. The
 *      _auth middleware doesn't need this because it runs
 *      requireTenantUser; _operator doesn't run requireTenantUser, so
 *      it must add the user check explicitly.
 *
 *   3. No session cookie → 302 to /login (regression of the standard
 *      shape).
 *   4. Tenant subdomain → 403 (the platform-tenant-only check fires
 *      via assertOperator after tenant resolution).
 *
 * Tests use a custom RouterContextProvider with the cloudflare.env
 * shim mirroring tests/middleware/auth.test.ts.
 *
 * @version v0.4.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedOperatorUser,
  OPERATOR_TEST_USER_ID,
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { operatorAuthMiddleware } from "../../app/middleware/operator-auth.server";
import {
  impersonationContext,
  tenantContext,
  userContext,
} from "../../app/context";
import { createSessionStorage } from "../../app/sessions.server";
import { PLATFORM_TENANT_ID } from "../../app/lib/tenant";

const TEST_SECRET = "test-session-secret";

async function makeSessionCookie(userId: string): Promise<string> {
  const { getSession, commitSession } = createSessionStorage(TEST_SECRET);
  const session = await getSession();
  session.set("userId", userId);
  return commitSession(session);
}

function buildContext(): any {
  const ctx = new RouterContextProvider();
  (ctx as any).cloudflare = { env };
  return ctx;
}

describe("operatorAuthMiddleware", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedOperatorUser();
  });

  it("operator session on platform host → middleware passes; userContext + tenantContext + impersonationContext populated", async () => {
    const cookie = await makeSessionCookie(OPERATOR_TEST_USER_ID);
    const request = new Request(
      "https://platform.fisqua.test/operator/tenants",
      { headers: { Cookie: cookie } },
    );
    const ctx = buildContext();

    await operatorAuthMiddleware(
      { request, context: ctx } as any,
      async () => undefined,
    );

    expect(ctx.get(userContext).id).toBe(OPERATOR_TEST_USER_ID);
    expect(ctx.get(tenantContext).id).toBe(PLATFORM_TENANT_ID);
    expect(ctx.get(tenantContext).kind).toBe("platform");
    // Impersonation slot is null on platform host.
    expect(ctx.get(impersonationContext)).toBeNull();
  });

  it("no session cookie on platform host → 302 to /login", async () => {
    const request = new Request(
      "https://platform.fisqua.test/operator/tenants",
    );
    const ctx = buildContext();

    try {
      await operatorAuthMiddleware(
        { request, context: ctx } as any,
        async () => undefined,
      );
      expect.fail("Should have redirected to /login");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      const r = e as Response;
      expect(r.status).toBeGreaterThanOrEqual(300);
      expect(r.status).toBeLessThan(400);
      expect(r.headers.get("Location")).toBe("/login");
    }
  });

  it("operator session on tenant subdomain → 403 from assertOperator", async () => {
    // The operator's user can only operate on the platform host.
    // assertOperator(tenant) checks tenant.kind === 'platform' — on
    // a tenant subdomain the resolved tenant is `tenant`, not
    // `platform`, so the gate throws 403.
    const cookie = await makeSessionCookie(OPERATOR_TEST_USER_ID);
    const request = new Request(
      "https://neogranadina.fisqua.test/operator/tenants",
      { headers: { Cookie: cookie } },
    );
    const ctx = buildContext();

    try {
      await operatorAuthMiddleware(
        { request, context: ctx } as any,
        async () => undefined,
      );
      expect.fail("Should have thrown 403");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });

  it("non-operator session on platform host → 403 (operator route registered in routes.ts but assertOperator gates by user identity, not just tenant)", async () => {
    // A regular Neogranadina user attempts to reach the operator
    // surface on platform.fisqua.test. The middleware's assertOperator
    // call passes because tenant.kind === 'platform' on the platform
    // host — so assertOperator alone is not sufficient. The operator
    // middleware must ALSO check that the user belongs to the platform
    // tenant (user.tenantId === PLATFORM_TENANT_ID). Without that
    // check, any logged-in user can reach the operator surface by
    // hitting the platform host.
    //
    // This test pins the contract: a non-platform user hitting the
    // platform host gets 403 from the operator middleware.
    const tenantUser = await createTestUser({
      tenantId: DEFAULT_TEST_TENANT_ID,
      isAdmin: false,
      email: "tenant-user@example.test",
    });
    const cookie = await makeSessionCookie(tenantUser.id);
    const request = new Request(
      "https://platform.fisqua.test/operator/tenants",
      { headers: { Cookie: cookie } },
    );
    const ctx = buildContext();

    try {
      await operatorAuthMiddleware(
        { request, context: ctx } as any,
        async () => undefined,
      );
      expect.fail("Should have thrown 403 — non-platform user on platform host");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });
});

// @version v0.4.0
