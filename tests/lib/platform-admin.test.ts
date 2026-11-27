/**
 * Tests — the platform admin's admission and effective flags
 *
 * This suite pins the pure parts of `app/lib/platform-admin.server.ts`
 * and the platform-admin admit path of `requireTenantUser`
 * (`app/lib/tenant.ts`):
 *
 *   - `admitsAsPlatformAdmin` admits only when the flag read from the
 *     user row is exactly `true`, the tenant's kind is exactly
 *     `tenant`, the tenant is not disabled, and the row is not stored on
 *     the platform tenant; a truthy non-boolean, a platform tenant, a
 *     disabled tenant and an operator's row are all refused;
 *   - `platformAdminEffectiveUser` sets every role flag the `User`
 *     type has to true, keeps the person's identity, and gives the
 *     request tenant as the tenant the person acts in;
 *   - `requireTenantUser` admits a person of another tenant with the
 *     `platformAdmin` option on a live workspace, and refuses the
 *     platform tenant, a disabled workspace, and the option off;
 *   - `liveWorkspaces` lists every workspace of kind `tenant` that is
 *     not disabled, and never the platform tenant.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:test";
import {
  admitsAsPlatformAdmin,
  liveWorkspaces,
  platformAdminEffectiveUser,
} from "../../app/lib/platform-admin.server";
import { PLATFORM_TENANT_ID, requireTenantUser } from "../../app/lib/tenant";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import {
  applyMigrations,
  cleanDatabase,
  seedDisabledTenant,
  DEFAULT_TEST_TENANT_ID,
  DISABLED_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";

const live = makeTenantContext({ id: DEFAULT_TEST_TENANT_ID, kind: "tenant", disabledAt: null });

describe("admitsAsPlatformAdmin", () => {
  it("admits a platform admin on a live workspace", () => {
    expect(admitsAsPlatformAdmin({ isPlatformAdmin: true, tenantId: SECOND_TEST_TENANT_ID }, live)).toBe(true);
  });

  it("refuses anything but a flag that is exactly true", () => {
    for (const value of [false, undefined, null, 1, "true", "1", {}]) {
      expect(admitsAsPlatformAdmin({ isPlatformAdmin: value as any, tenantId: SECOND_TEST_TENANT_ID }, live)).toBe(false);
    }
    expect(admitsAsPlatformAdmin({} as any, live)).toBe(false);
  });

  it("refuses the platform tenant and any kind other than tenant", () => {
    expect(admitsAsPlatformAdmin({ isPlatformAdmin: true, tenantId: SECOND_TEST_TENANT_ID }, { ...live, kind: "platform" })).toBe(false);
    expect(admitsAsPlatformAdmin({ isPlatformAdmin: true, tenantId: SECOND_TEST_TENANT_ID }, { ...live, kind: "other" as any })).toBe(false);
  });

  it("refuses an operator: a row stored on the platform tenant", () => {
    expect(admitsAsPlatformAdmin({ isPlatformAdmin: true, tenantId: PLATFORM_TENANT_ID }, live)).toBe(false);
  });

  it("refuses a disabled workspace", () => {
    expect(admitsAsPlatformAdmin({ isPlatformAdmin: true, tenantId: SECOND_TEST_TENANT_ID }, { ...live, disabledAt: Date.now() })).toBe(false);
    expect(admitsAsPlatformAdmin({ isPlatformAdmin: true, tenantId: SECOND_TEST_TENANT_ID }, { ...live, disabledAt: undefined as any })).toBe(false);
  });
});

describe("platformAdminEffectiveUser", () => {
  it("sets every role flag the User type has, keeps identity, and acts in the request tenant", () => {
    const stored = { ...makeUserContext({ id: "pa-1", tenantId: SECOND_TEST_TENANT_ID, email: "pa@test.local", name: "PA" }), isPlatformAdmin: true };
    const effective = platformAdminEffectiveUser(stored, live);
    // Every boolean field of the User shape except the grant-only
    // `worksInEveryArea` marker is a role flag, and every one is on.
    const flagKeys = Object.keys(makeUserContext()).filter(
      (k) => typeof (makeUserContext() as any)[k] === "boolean",
    );
    expect(flagKeys.length).toBeGreaterThanOrEqual(10);
    for (const k of flagKeys) expect((effective as any)[k]).toBe(true);
    expect(effective.worksInEveryArea).toBeUndefined();
    expect(effective).toMatchObject({ id: "pa-1", email: "pa@test.local", name: "PA", tenantId: DEFAULT_TEST_TENANT_ID });
    expect((effective as any).isPlatformAdmin).toBe(true);
    // The stored user is not changed.
    expect(stored.tenantId).toBe(SECOND_TEST_TENANT_ID);
    expect(stored.isAdmin).toBe(false);
  });
});

describe("requireTenantUser, platform admin path", () => {
  const foreign = makeUserContext({ tenantId: SECOND_TEST_TENANT_ID });

  it("admits a person of another tenant on a live workspace", () => {
    expect(() => requireTenantUser(live, foreign, { platformAdmin: true })).not.toThrow();
  });

  it("refuses without the option, or with a value that is not exactly true", () => {
    expect(() => requireTenantUser(live, foreign)).toThrow();
    expect(() => requireTenantUser(live, foreign, { platformAdmin: false })).toThrow();
    expect(() => requireTenantUser(live, foreign, { platformAdmin: 1 as any })).toThrow();
  });

  it("refuses an operator's row even with the option", () => {
    const operator = makeUserContext({ tenantId: PLATFORM_TENANT_ID });
    expect(() => requireTenantUser(live, operator, { platformAdmin: true })).toThrow();
  });

  it("refuses the platform tenant and a disabled workspace", () => {
    const platform = makeTenantContext({ id: PLATFORM_TENANT_ID, kind: "platform" });
    expect(() => requireTenantUser(platform, foreign, { platformAdmin: true })).toThrow();
    const disabled = makeTenantContext({ id: DISABLED_TEST_TENANT_ID, disabledAt: Date.now() });
    expect(() => requireTenantUser(disabled, foreign, { platformAdmin: true })).toThrow();
  });
});

describe("liveWorkspaces", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("lists every live workspace of kind tenant, never the platform tenant or a disabled one", async () => {
    await seedDisabledTenant();
    const rows = await liveWorkspaces(drizzle(env.DB));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(DEFAULT_TEST_TENANT_ID);
    expect(ids).toContain(SECOND_TEST_TENANT_ID);
    expect(ids).not.toContain(PLATFORM_TENANT_ID);
    expect(ids).not.toContain(DISABLED_TEST_TENANT_ID);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["id", "name", "slug"]);
  });
});

// @version v0.9.0
