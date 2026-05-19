/**
 * Tests — impersonation handoff route
 *
 * This suite pins the GET `/handoff/impersonation?t=<id>` loader at
 * `app/routes/handoff.impersonation.tsx`. The route runs ONLY on
 * tenant subdomains; on the apex (fisqua.test / fisqua.org) and on
 * the platform host (platform.fisqua.test) it 404s. The successful
 * path consumes the row atomically, performs a defence-in-depth
 * tenant slug recheck (T-33-05-02), looks up the operator user,
 * applies `requireTenantUser({ allowImpersonation: true })`, mints
 * an impersonating session via `createSessionStorage`, and 302s to
 * `/dashboard`.
 *
 * Mirrors `tests/auth/github-handoff.test.ts`'s shape exactly —
 * loader-only route, atomic single-use consume, host-only Set-Cookie.
 *
 *   1. Happy path: 302 to /dashboard with Set-Cookie carrying NO
 *      `Domain=` substring. Asserts session payload via re-read.
 *   2. Replay: second consume of the same id → 410.
 *   3. Expired: pre-insert with expiresAt = now - 1 → 410.
 *   4. Unknown id: → 410.
 *   5. Tenant slug mismatch: row's targetTenantId is for tenant A;
 *      request hits tenant B's subdomain → 410. Atomic consume HAS
 *      already burned the row; the slug recheck is the defence-in-
 *      depth wall.
 *   6. Operator user not found / wrong tenantId: row points at a user
 *      whose tenantId is NOT PLATFORM_TENANT_ID → 410 (the
 *      requireTenantUser allowImpersonation carve-out fails).
 *   7. Cookie scoping: Set-Cookie has no Domain= attribute
 *      (host-only invariant preserved).
 *   8. Apex check: GET on fisqua.test → 404.
 *
 * @version v0.4.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedOperatorUser,
  OPERATOR_TEST_USER_ID,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
  getTestDb,
} from "../helpers/db";
import {
  insertImpersonationHandoff,
  IMPERSONATION_HANDOFF_TTL_MS,
} from "../../app/lib/impersonation-handoff.server";
import { createTestUser } from "../helpers/auth";
import { createSessionStorage } from "../../app/sessions.server";
import { PLATFORM_TENANT_ID } from "../../app/lib/tenant";

function makeLoaderArgs(url: string) {
  const request = new Request(url);
  return {
    request,
    context: {
      cloudflare: {
        env: {
          DB: env.DB,
          SESSION_SECRET: "test-session-secret",
        },
      },
    },
    params: {},
  };
}

async function runLoader(
  args: ReturnType<typeof makeLoaderArgs>,
): Promise<Response> {
  const { loader } = await import(
    "../../app/routes/handoff.impersonation"
  );
  try {
    const result = await loader(args as any);
    if (result instanceof Response) return result;
    throw new Error("loader returned non-Response");
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

describe("impersonation handoff route", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedOperatorUser();
  });

  it("happy path: 302 to /dashboard with host-only Set-Cookie carrying impersonating envelope", async () => {
    const db = getTestDb();
    const id = "id-imp-happy-1";
    await insertImpersonationHandoff(db, {
      id,
      actorUserId: OPERATOR_TEST_USER_ID,
      targetTenantId: DEFAULT_TEST_TENANT_ID,
      targetRole: "isCataloguer",
      reason: "fixing a bug",
      now: Date.now(),
    });

    const r = await runLoader(
      makeLoaderArgs(
        `https://neogranadina.fisqua.test/handoff/impersonation?t=${id}`,
      ),
    );
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/dashboard");

    // Set-Cookie present, host-only (no Domain=).
    const cookies: string[] = [];
    r.headers.forEach((v, k) => {
      if (k.toLowerCase() === "set-cookie") cookies.push(v);
    });
    const sessionCookie = cookies.find((c) => c.startsWith("__session="));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie ?? "").not.toMatch(/Domain=/i);

    // Re-read the session to confirm payload shape.
    const { getSession } = createSessionStorage("test-session-secret");
    const session = await getSession(sessionCookie ?? "");
    expect(session.get("userId")).toBe(OPERATOR_TEST_USER_ID);
    const imp = session.get("impersonating");
    expect(imp).toBeDefined();
    expect(imp!.role).toBe("isCataloguer");
    expect(imp!.sessionId).toBe(id);
    expect(typeof imp!.lastActivityAt).toBe("number");
  });

  it("replay: second consume of the same id returns 410", async () => {
    const db = getTestDb();
    const id = "id-imp-replay-1";
    await insertImpersonationHandoff(db, {
      id,
      actorUserId: OPERATOR_TEST_USER_ID,
      targetTenantId: DEFAULT_TEST_TENANT_ID,
      targetRole: "isCataloguer",
      reason: null,
      now: Date.now(),
    });

    const url = `https://neogranadina.fisqua.test/handoff/impersonation?t=${id}`;
    const first = await runLoader(makeLoaderArgs(url));
    expect(first.status).toBe(302);

    const second = await runLoader(makeLoaderArgs(url));
    expect(second.status).toBe(410);
  });

  it("expired row → 410", async () => {
    const db = getTestDb();
    const id = "id-imp-expired-1";
    const realNow = Date.now();
    await insertImpersonationHandoff(db, {
      id,
      actorUserId: OPERATOR_TEST_USER_ID,
      targetTenantId: DEFAULT_TEST_TENANT_ID,
      targetRole: "isCataloguer",
      reason: null,
      now: realNow - IMPERSONATION_HANDOFF_TTL_MS - 1_000,
    });

    const r = await runLoader(
      makeLoaderArgs(
        `https://neogranadina.fisqua.test/handoff/impersonation?t=${id}`,
      ),
    );
    expect(r.status).toBe(410);
  });

  it("unknown id → 410", async () => {
    const r = await runLoader(
      makeLoaderArgs(
        "https://neogranadina.fisqua.test/handoff/impersonation?t=unknown-id-xyz",
      ),
    );
    expect(r.status).toBe(410);
  });

  it("tenant slug mismatch: row for tenant A consumed at tenant B's subdomain → 410", async () => {
    const db = getTestDb();
    const id = "id-imp-slug-mismatch-1";
    // Row's target tenant is neogranadina, but request hits second-tenant.
    await insertImpersonationHandoff(db, {
      id,
      actorUserId: OPERATOR_TEST_USER_ID,
      targetTenantId: DEFAULT_TEST_TENANT_ID,
      targetRole: "isCataloguer",
      reason: null,
      now: Date.now(),
    });

    const r = await runLoader(
      makeLoaderArgs(
        `https://second-tenant.fisqua.test/handoff/impersonation?t=${id}`,
      ),
    );
    expect(r.status).toBe(410);
  });

  it("operator user is not on platform tenant → 410 (allowImpersonation carve-out fails)", async () => {
    // Seed a user whose tenantId is the second tenant (NOT the platform).
    const nonOperatorId = "55555555-5555-4555-8555-555555555555";
    await createTestUser({
      id: nonOperatorId,
      tenantId: SECOND_TEST_TENANT_ID,
      email: "imposter@example.test",
    });
    const db = getTestDb();
    const id = "id-imp-nonop-1";
    await insertImpersonationHandoff(db, {
      id,
      actorUserId: nonOperatorId,
      targetTenantId: DEFAULT_TEST_TENANT_ID,
      targetRole: "isCataloguer",
      reason: null,
      now: Date.now(),
    });

    const r = await runLoader(
      makeLoaderArgs(
        `https://neogranadina.fisqua.test/handoff/impersonation?t=${id}`,
      ),
    );
    expect(r.status).toBe(410);
  });

  it("apex host fisqua.test → 404", async () => {
    const r = await runLoader(
      makeLoaderArgs(
        "https://fisqua.test/handoff/impersonation?t=anything",
      ),
    );
    expect(r.status).toBe(404);
  });
});

// @version v0.4.0
