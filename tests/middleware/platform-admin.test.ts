/**
 * Tests — the auth middleware and the platform admin
 *
 * This suite drives `app/middleware/auth.server.ts` with a real
 * session cookie for a person whose `users.is_platform_admin` is set,
 * and pins how the middleware admits them:
 *
 *   - on a live workspace that is not their stored one, they are
 *     admitted as a home member with every role flag on, acting in the
 *     request tenant; no grant context is set, no wrong-workspace
 *     redirect fires, and a write records no `edit_on_behalf` row;
 *   - a federation grant into that workspace does not lower them to
 *     the grant's flags: platform access wins;
 *   - on their stored workspace they also have every role flag;
 *   - the platform tenant's host and a disabled workspace stay closed;
 *   - the flag is read from the database on every request: clearing it
 *     closes the next request, and a session cookie that claims the
 *     flag admits no one;
 *   - an operator (a row stored on the platform tenant) with the flag
 *     is not admitted without an impersonation envelope, and the
 *     envelope is unchanged by the flag.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { RouterContextProvider } from "react-router";
import {
  applyMigrations,
  cleanDatabase,
  seedDisabledTenant,
  DEFAULT_TEST_FEDERATION_ID,
  DEFAULT_TEST_TENANT_ID,
  DISABLED_TEST_TENANT_SLUG,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { authMiddleware } from "../../app/middleware/auth.server";
import {
  grantContext,
  impersonationContext,
  tenantContext,
  userContext,
} from "../../app/context";
import { createSessionStorage } from "../../app/sessions.server";
import { federationMemberships } from "../../app/db/schema";
import { PLATFORM_TENANT_ID } from "../../app/lib/tenant";

const TEST_SECRET = "test-session-secret";

const ROLE_FLAGS = [
  "isAdmin",
  "isSuperAdmin",
  "isCollabAdmin",
  "isArchiveUser",
  "isUserManager",
  "isCataloguer",
  "isRecordsAdmin",
  "isAuthoritiesAdmin",
  "isImportsAdmin",
  "isDigitizationAdmin",
] as const;

async function cookieFor(userId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { getSession, commitSession } = createSessionStorage(TEST_SECRET);
  const session = await getSession();
  session.set("userId", userId);
  for (const [k, v] of Object.entries(extra)) (session as any).set(k, v);
  return commitSession(session);
}

function buildContext(): any {
  const ctx = new RouterContextProvider();
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function setPlatformAdmin(userId: string, on: boolean): Promise<void> {
  await env.DB.prepare("UPDATE users SET is_platform_admin = ? WHERE id = ?").bind(on ? 1 : 0, userId).run();
}

async function run(url: string, cookie: string, method = "GET") {
  const ctx = buildContext();
  const request = new Request(url, { method, headers: { Cookie: cookie } });
  try {
    await authMiddleware({ request, context: ctx } as any, async () => new Response("ok"));
    return { ctx, thrown: null as Response | null };
  } catch (e) {
    if (e instanceof Response) return { ctx, thrown: e };
    throw e;
  }
}

async function auditRows() {
  const { results } = await env.DB.prepare("SELECT action FROM audit_log").all();
  return results;
}

describe("authMiddleware: platform admin", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("admits a platform admin of another tenant as a home member with every role flag", async () => {
    const pa = await createTestUser({ tenantId: SECOND_TEST_TENANT_ID });
    await setPlatformAdmin(pa.id, true);
    const { ctx, thrown } = await run(
      "https://neogranadina.fisqua.test/admin/users",
      await cookieFor(pa.id),
    );
    expect(thrown).toBeNull();
    const effective = ctx.get(userContext);
    for (const f of ROLE_FLAGS) expect(effective[f]).toBe(true);
    expect(effective.id).toBe(pa.id);
    expect(effective.tenantId).toBe(DEFAULT_TEST_TENANT_ID);
    expect(ctx.get(tenantContext).id).toBe(DEFAULT_TEST_TENANT_ID);
    expect(ctx.get(grantContext)).toBeNull();
    expect(ctx.get(impersonationContext)).toBeNull();
    // The stored row is untouched.
    const row = await env.DB.prepare("SELECT tenant_id, is_admin FROM users WHERE id = ?").bind(pa.id).first();
    expect(row).toEqual({ tenant_id: SECOND_TEST_TENANT_ID, is_admin: 0 });
  });

  it("records no edit_on_behalf row for a write", async () => {
    const pa = await createTestUser({ tenantId: SECOND_TEST_TENANT_ID });
    await setPlatformAdmin(pa.id, true);
    const { thrown } = await run(
      "https://neogranadina.fisqua.test/admin/capture/queue",
      await cookieFor(pa.id),
      "POST",
    );
    expect(thrown).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it("takes precedence over a federation grant: the flags are never lowered to staff", async () => {
    const pa = await createTestUser({ tenantId: SECOND_TEST_TENANT_ID });
    await setPlatformAdmin(pa.id, true);
    await drizzle(env.DB).insert(federationMemberships).values({
      id: crypto.randomUUID(),
      userId: pa.id,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      role: "staff",
      createdAt: Date.now(),
    });
    const { ctx, thrown } = await run(
      "https://neogranadina.fisqua.test/admin/capture/queue",
      await cookieFor(pa.id),
      "POST",
    );
    expect(thrown).toBeNull();
    const effective = ctx.get(userContext);
    for (const f of ROLE_FLAGS) expect(effective[f]).toBe(true);
    expect(effective.worksInEveryArea).toBeUndefined();
    expect(ctx.get(grantContext)).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it("gives every role flag on the stored workspace too", async () => {
    const pa = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID });
    await setPlatformAdmin(pa.id, true);
    const { ctx, thrown } = await run(
      "https://neogranadina.fisqua.test/dashboard",
      await cookieFor(pa.id),
    );
    expect(thrown).toBeNull();
    for (const f of ROLE_FLAGS) expect(ctx.get(userContext)[f]).toBe(true);
  });

  it("leaves the platform tenant closed", async () => {
    const pa = await createTestUser({ tenantId: SECOND_TEST_TENANT_ID });
    await setPlatformAdmin(pa.id, true);
    const cookie = await cookieFor(pa.id);
    const app = await run("https://platform.fisqua.test/dashboard", cookie);
    expect(app.thrown?.status).toBe(404);
    // Even on an operator path, the auth middleware does not admit them.
    const operator = await run("https://platform.fisqua.test/operator/tenants", cookie);
    expect(operator.thrown?.status).toBe(403);
  });

  it("leaves a disabled workspace closed", async () => {
    await seedDisabledTenant();
    const pa = await createTestUser({ tenantId: SECOND_TEST_TENANT_ID });
    await setPlatformAdmin(pa.id, true);
    const { thrown } = await run(
      `https://${DISABLED_TEST_TENANT_SLUG}.fisqua.test/dashboard`,
      await cookieFor(pa.id),
    );
    expect(thrown?.status).toBe(404);
  });

  it("reads the flag on every request: clearing it closes the next request", async () => {
    const pa = await createTestUser({ tenantId: SECOND_TEST_TENANT_ID });
    await setPlatformAdmin(pa.id, true);
    const cookie = await cookieFor(pa.id);
    expect((await run("https://neogranadina.fisqua.test/dashboard", cookie)).thrown).toBeNull();
    await setPlatformAdmin(pa.id, false);
    const after = await run("https://neogranadina.fisqua.test/dashboard", cookie);
    expect(after.thrown?.status).toBe(302);
    expect(after.thrown?.headers.get("Location")).toBe("/wrong-workspace?home=second-tenant");
  });

  it("ignores a session cookie that claims the flag", async () => {
    const user = await createTestUser({ tenantId: SECOND_TEST_TENANT_ID });
    const cookie = await cookieFor(user.id, { isPlatformAdmin: true, is_platform_admin: 1 });
    const { thrown } = await run("https://neogranadina.fisqua.test/dashboard", cookie);
    expect(thrown?.status).toBe(302);
    expect(thrown?.headers.get("Location")).toBe("/wrong-workspace?home=second-tenant");
  });

  it("does not admit an operator with the flag and no impersonation envelope", async () => {
    const operator = await createTestUser({ tenantId: PLATFORM_TENANT_ID });
    await setPlatformAdmin(operator.id, true);
    const { thrown } = await run("https://neogranadina.fisqua.test/dashboard", await cookieFor(operator.id));
    expect(thrown?.status).toBe(403);
  });

  it("leaves an operator's impersonation envelope unchanged", async () => {
    const operator = await createTestUser({ tenantId: PLATFORM_TENANT_ID });
    await setPlatformAdmin(operator.id, true);
    const cookie = await cookieFor(operator.id, {
      impersonating: { role: "isCataloguer", sessionId: "imp-1", lastActivityAt: Date.now() },
    });
    const { ctx, thrown } = await run("https://neogranadina.fisqua.test/dashboard", cookie);
    expect(thrown).toBeNull();
    const effective = ctx.get(userContext);
    expect(effective.tenantId).toBe(PLATFORM_TENANT_ID);
    for (const f of ROLE_FLAGS) expect(effective[f]).toBe(false);
    expect(ctx.get(impersonationContext)?.role).toBe("isCataloguer");
    expect(ctx.get(grantContext)).toBeNull();
  });

  it("leaves home access unchanged for a person without the flag", async () => {
    const user = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID });
    const { ctx, thrown } = await run(
      "https://neogranadina.fisqua.test/dashboard",
      await cookieFor(user.id),
    );
    expect(thrown).toBeNull();
    for (const f of ROLE_FLAGS) expect(ctx.get(userContext)[f]).toBe(false);
  });
});

// @version v0.9.0
