/**
 * Tests — the workspace switcher for a platform admin
 *
 * The authenticated layout's loader (`app/routes/_auth.tsx`) gives the
 * top bar its workspace switcher: the person's home workspace and the
 * workspaces of the federations they hold a grant in. A platform admin
 * is at home in every live workspace, so the switcher lists all of them.
 * This suite runs the loader for:
 *
 *   - a platform admin: every workspace of kind `tenant` that is not
 *     disabled, the current one marked, never the platform tenant or a
 *     disabled workspace;
 *   - the same person once the flag is cleared: back to no switcher;
 *   - a person without the flag and without grants: no switcher.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import {
  applyMigrations,
  cleanDatabase,
  seedDisabledTenant,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import {
  grantContext,
  impersonationContext,
  tenantContext,
  userContext,
} from "../../app/context";
import { loader } from "../../app/routes/_auth";

async function load(userId: string, tenantId: string) {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, makeUserContext({ id: userId, tenantId, isAdmin: true }));
  ctx.set(tenantContext, makeTenantContext());
  ctx.set(grantContext, null);
  ctx.set(impersonationContext, null);
  (ctx as any).cloudflare = { env };
  return (await loader({
    request: new Request("https://neogranadina.fisqua.test/dashboard"),
    params: {},
    context: ctx,
  } as any)) as any;
}

describe("workspace switcher: platform admin", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("lists every live workspace for a platform admin", async () => {
    await seedDisabledTenant();
    const pa = await createTestUser({ tenantId: SECOND_TEST_TENANT_ID });
    await env.DB.prepare("UPDATE users SET is_platform_admin = 1 WHERE id = ?").bind(pa.id).run();
    const data = await load(pa.id, SECOND_TEST_TENANT_ID);
    const names = (data.workspaces as Array<{ name: string }>).map((w) => w.name);
    expect(names).toEqual(["DACS Test Tenant", "Neogranadina", "RAD Test Tenant", "Second Test Tenant"]);
    const current = data.workspaces.filter((w: { current: boolean }) => w.current);
    expect(current).toEqual([
      { name: "Neogranadina", url: "https://neogranadina.fisqua.test/dashboard", current: true },
    ]);
  });

  it("drops back to no switcher once the flag is cleared", async () => {
    const pa = await createTestUser({ tenantId: SECOND_TEST_TENANT_ID });
    await env.DB.prepare("UPDATE users SET is_platform_admin = 1 WHERE id = ?").bind(pa.id).run();
    expect((await load(pa.id, SECOND_TEST_TENANT_ID)).workspaces).not.toBeNull();
    await env.DB.prepare("UPDATE users SET is_platform_admin = 0 WHERE id = ?").bind(pa.id).run();
    expect((await load(pa.id, SECOND_TEST_TENANT_ID)).workspaces).toBeNull();
  });

  it("gives no switcher to a person without the flag or grants", async () => {
    const user = await createTestUser({ tenantId: SECOND_TEST_TENANT_ID });
    expect((await load(user.id, SECOND_TEST_TENANT_ID)).workspaces).toBeNull();
  });
});

// @version v0.9.0
