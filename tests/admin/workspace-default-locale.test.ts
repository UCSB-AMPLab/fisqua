/**
 * Tests — the workspace's default language, set from its Users page
 *
 * This suite pins how a workspace's admins set `tenants.default_locale`
 * from the Language section of their own Users page (`/admin/users`,
 * `_action` `setDefaultLocale`), through the rule the operator console
 * uses (`setDefaultLocale`). It calls the page's loader and action with
 * the user the auth middleware hands over, and pins:
 *
 *   - who may set it: a workspace admin and a federation steward
 *     (`canSetDefaultLocale` true, the action saves); a federation staff
 *     grant and a cataloguer reach neither the page nor the action (a
 *     bare 403); a user manager reaches the page but is not offered the
 *     section, and the action refuses them with a bare 403;
 *   - what it saves: English, Spanish, or no default, each change one
 *     `set_capability` audit row with `settingsChanged: 'default_locale'`
 *     and the value before and after, the actor's home tenant as the
 *     actor's tenant; an unchanged value writes nothing; any other value
 *     is refused, naming the field.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import {
  applyMigrations,
  cleanDatabase,
  getTestDb,
  seedFederations,
  DEFAULT_TEST_FEDERATION_ID,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createGrantUser, createTestUser } from "../helpers/auth";
import { makeUserContext } from "../helpers/context";
import {
  grantContext,
  impersonationContext,
  tenantContext,
  userContext,
  type GrantState,
  type User,
} from "../../app/context";
import * as schema from "../../app/db/schema";
import { loader, action } from "../../app/routes/_auth.admin.users";

const HOST = "https://neogranadina.fisqua.test";

async function tenantRow() {
  return (await getTestDb()
    .select()
    .from(schema.tenants)
    .where(eq(schema.tenants.id, DEFAULT_TEST_TENANT_ID))
    .get())!;
}

async function context(user: User, grant: GrantState | null = null): Promise<any> {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, await tenantRow());
  ctx.set(grantContext, grant);
  ctx.set(impersonationContext, null);
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function load(user: User, grant: GrantState | null = null): Promise<any> {
  return loader({ request: new Request(`${HOST}/admin/users`), context: await context(user, grant), params: {} } as any);
}

async function submit(user: User, defaultLocale: string, grant: GrantState | null = null): Promise<any> {
  const body = new URLSearchParams({ _action: "setDefaultLocale", defaultLocale });
  return action({
    request: new Request(`${HOST}/admin/users`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }),
    context: await context(user, grant),
    params: {},
  } as any);
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}

async function storedDefault(): Promise<string | null> {
  return (await tenantRow()).defaultLocale;
}

async function auditRows(): Promise<Array<{ action: string; actor_tenant_id: string; details: string }>> {
  const { results } = await env.DB.prepare(
    "SELECT action, actor_tenant_id, details FROM audit_log WHERE target_tenant_id = ? ORDER BY rowid",
  )
    .bind(DEFAULT_TEST_TENANT_ID)
    .all<{ action: string; actor_tenant_id: string; details: string }>();
  return results;
}

async function resetDefaults(): Promise<void> {
  await env.DB.prepare("UPDATE tenants SET default_locale = NULL").run();
}

const grantOf = (role: "steward" | "staff"): GrantState => ({
  role,
  federationId: DEFAULT_TEST_FEDERATION_ID,
  homeTenantId: SECOND_TEST_TENANT_ID,
});

let admin: User;
let cataloguer: User;
let userManager: User;
let steward: User;
let staff: User;

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDatabase();
  await seedFederations();
  await resetDefaults();
  const a = await createTestUser({ isAdmin: true, name: "Test Admin" });
  admin = makeUserContext({ id: a.id, email: a.email, name: a.name, isAdmin: true });
  const c = await createTestUser({ name: "Test Cataloguer" });
  cataloguer = makeUserContext({ id: c.id, email: c.email, name: c.name, isCataloguer: true });
  const m = await createTestUser({ name: "Test Manager" });
  userManager = makeUserContext({ id: m.id, email: m.email, name: m.name, isUserManager: true });
  steward = await createGrantUser("steward", { name: "Test Steward" });
  staff = await createGrantUser("staff", { name: "Test Staff" });
});

afterAll(resetDefaults);

describe("who may set the workspace's default language", () => {
  it("offers the section to a workspace admin and a federation steward, with the stored value", async () => {
    await env.DB.prepare("UPDATE tenants SET default_locale = 'es' WHERE id = ?").bind(DEFAULT_TEST_TENANT_ID).run();
    for (const [user, grant] of [[admin, null], [steward, grantOf("steward")]] as const) {
      const data = await load(user, grant);
      expect(data.canSetDefaultLocale).toBe(true);
      expect(data.defaultLocale).toBe("es");
    }
  });

  it("lets a federation steward save it, recording their home tenant as the actor's", async () => {
    expect(await submit(steward, "en", grantOf("steward"))).toEqual({ localeSaved: true, noop: false });
    expect(await storedDefault()).toBe("en");
    expect((await auditRows()).map((r) => [r.action, r.actor_tenant_id])).toEqual([["set_capability", SECOND_TEST_TENANT_ID]]);
  });

  it("refuses a federation staff grant and a cataloguer the page and the action, and writes nothing", async () => {
    expect(await status(load(staff, grantOf("staff")))).toBe(403);
    expect(await status(submit(staff, "en", grantOf("staff")))).toBe(403);
    expect(await status(load(cataloguer))).toBe(403);
    expect(await status(submit(cataloguer, "en"))).toBe(403);
    expect(await storedDefault()).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it("does not offer the section to a user manager, and refuses their action", async () => {
    const data = await load(userManager);
    expect(data.canSetDefaultLocale).toBe(false);
    expect(await status(submit(userManager, "en"))).toBe(403);
    expect(await storedDefault()).toBeNull();
  });
});

describe("what a workspace admin saves", () => {
  it("saves English, then Spanish, then clears the default, auditing each change", async () => {
    expect(await submit(admin, "en")).toEqual({ localeSaved: true, noop: false });
    expect(await storedDefault()).toBe("en");
    expect(await submit(admin, "es")).toEqual({ localeSaved: true, noop: false });
    expect(await storedDefault()).toBe("es");
    expect(await submit(admin, "")).toEqual({ localeSaved: true, noop: false });
    expect(await storedDefault()).toBeNull();

    const rows = await auditRows();
    expect(rows.map((r) => [r.action, r.actor_tenant_id])).toEqual([
      ["set_capability", DEFAULT_TEST_TENANT_ID],
      ["set_capability", DEFAULT_TEST_TENANT_ID],
      ["set_capability", DEFAULT_TEST_TENANT_ID],
    ]);
    expect(rows.map((r) => JSON.parse(r.details))).toEqual([
      { slug: "neogranadina", settingsChanged: "default_locale", from: null, to: "en" },
      { slug: "neogranadina", settingsChanged: "default_locale", from: "en", to: "es" },
      { slug: "neogranadina", settingsChanged: "default_locale", from: "es", to: null },
    ]);
  });

  it("writes nothing when the value is unchanged", async () => {
    expect(await submit(admin, "")).toEqual({ localeSaved: true, noop: true });
    expect(await auditRows()).toEqual([]);
  });

  it("refuses any other value, naming the field, and keeps the stored default", async () => {
    await submit(admin, "es");
    const before = (await auditRows()).length;
    const result = await submit(admin, "fr");
    expect(result.fieldErrors?.defaultLocale).toHaveLength(1);
    expect(result.localeSaved).toBeUndefined();
    expect(await storedDefault()).toBe("es");
    expect(await auditRows()).toHaveLength(before);
  });
});

// @version v0.9.0
