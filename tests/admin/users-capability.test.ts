/**
 * Tests — admin user-edit capability filter
 *
 * This suite pins the capability-aware shape of the user-edit form:
 * when the request tenant has `crowdsourcingEnabled === false`, the
 * form omits the `isCollabAdmin` and `isCataloguer`
 * checkboxes from the role-flag fieldset, and the matching action
 * handler skips writing those fields on update so dormant DB values
 * stay intact.
 *
 * The four cases here cover:
 *
 *   (a) Loader on a crowdsourcing-off tenant returns capability info
 *       indicating the two checkboxes must be hidden in the JSX.
 *   (b) Loader on a crowdsourcing-on tenant (Neogranadina) returns
 *       capability info indicating both checkboxes still render.
 *   (c) Dormant flag preserved across a no-op cycle: a user with
 *       `isCataloguer = true` on a crowdsourcing-off tenant still has
 *       the flag set after a roundtrip — confirms the seed schema
 *       does not auto-clear capability-dependent flags (CONTEXT.md
 *       C-05) and gives a baseline for case (d).
 *   (d) Action helper does NOT auto-clear `isCollabAdmin` /
 *       `isCataloguer` when the form post omits them and the tenant
 *       has crowdsourcing off. Without the route patch, today's
 *       action would read `formData.get("isCataloguer") === "on"` as
 *       `false` and auto-clear the dormant flag — silently
 *       destroying state. The patch skips writing those fields when
 *       the tenant capability is off, so the dormant flag survives.
 *       The test exercises the extracted helper
 *       `applyUpdateRoles(...)` directly to bypass the i18n / Host-
 *       header machinery the full route action wires up (importing
 *       the route module from the Workers test pool would pull in
 *       `~/locales` which `vitest.config.ts` does not alias).
 *
 * Test mechanics: each route case constructs a `RouterContextProvider`
 * pre-populated with `userContext`, `tenantContext`, and
 * `cloudflare.env`, then invokes the loader directly. The synthetic
 * `Request` uses `localhost` so no Host-header tenant resolution
 * runs (the middleware is bypassed and we set `tenantContext` on the
 * context directly).
 *
 * @version v0.4.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";

type Db = ReturnType<typeof drizzle>;

function buildContext(args: { user: User; crowdsourcingEnabled: boolean }): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, args.user);
  ctx.set(
    tenantContext,
    makeTenantContext({
      id: args.user.tenantId,
      slug:
        args.user.tenantId === SECOND_TEST_TENANT_ID
          ? "second-tenant"
          : "neogranadina",
      crowdsourcingEnabled: args.crowdsourcingEnabled,
      // The other three capabilities stay ON so we exercise the
      // crowdsourcing gate in isolation.
      vocabularyHubEnabled: true,
      publishPipelineEnabled: true,
      multiRepositoryEnabled: true,
    }),
  );
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function seedUser(
  db: Db,
  args: { tenantId: string; flags?: Partial<typeof schema.users.$inferInsert> },
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(schema.users).values({
    tenantId: args.tenantId,
    id,
    email: `target-${id.slice(0, 8)}@example.com`,
    name: "Target",
    isAdmin: false,
    isSuperAdmin: false,
    isCollabAdmin: false,
    isArchiveUser: false,
    isUserManager: false,
    isCataloguer: false,
    createdAt: now,
    updatedAt: now,
    ...args.flags,
  });
  return id;
}

describe("admin user-edit capability filter", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("loader returns crowdsourcingEnabled=false on a crowdsourcing-off tenant", async () => {
    const db = drizzle(env.DB);
    const targetId = await seedUser(db, {
      tenantId: SECOND_TEST_TENANT_ID,
      flags: { isCataloguer: true },
    });

    const superAdmin = makeUserContext({
      id: crypto.randomUUID(),
      tenantId: SECOND_TEST_TENANT_ID,
      isSuperAdmin: true,
    });
    const ctx = buildContext({ user: superAdmin, crowdsourcingEnabled: false });

    const { loader } = await import(
      "../../app/routes/_auth.admin.users.$id"
    );
    const res = (await loader({
      request: new Request("http://localhost/admin/users/" + targetId),
      params: { id: targetId },
      context: ctx,
    } as any)) as any;

    // Loader exposes the capability flag the JSX gates on.
    expect(res.tenant).toBeDefined();
    expect(res.tenant.crowdsourcingEnabled).toBe(false);
    // The seeded dormant flag is still on the user row the loader
    // returns; the JSX simply will not render it.
    expect(res.targetUser.isCataloguer).toBeTruthy();
  });

  it("loader returns crowdsourcingEnabled=true on a crowdsourcing-on tenant", async () => {
    const db = drizzle(env.DB);
    const targetId = await seedUser(db, {
      tenantId: DEFAULT_TEST_TENANT_ID,
      flags: { isCataloguer: true },
    });

    const superAdmin = makeUserContext({
      id: crypto.randomUUID(),
      tenantId: DEFAULT_TEST_TENANT_ID,
      isSuperAdmin: true,
    });
    const ctx = buildContext({ user: superAdmin, crowdsourcingEnabled: true });

    const { loader } = await import(
      "../../app/routes/_auth.admin.users.$id"
    );
    const res = (await loader({
      request: new Request("http://localhost/admin/users/" + targetId),
      params: { id: targetId },
      context: ctx,
    } as any)) as any;

    expect(res.tenant.crowdsourcingEnabled).toBe(true);
    expect(res.targetUser.isCataloguer).toBeTruthy();
  });

  it("dormant flag survives roundtrip: isCataloguer=true on crowdsourcing-off tenant stays set in DB", async () => {
    const db = drizzle(env.DB);
    const targetId = await seedUser(db, {
      tenantId: SECOND_TEST_TENANT_ID,
      flags: { isCataloguer: true, isCollabAdmin: true },
    });

    // Read the row back directly. The seed used the second tenant,
    // whose `crowdsourcing_enabled` is 0 in the seed (per
    // `seedTenants()`); the user row's `isCataloguer` and
    // `isCollabAdmin` are still 1 because nothing auto-clears them.
    const row = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, targetId))
      .get();
    expect(row).toBeTruthy();
    expect(row!.isCataloguer).toBeTruthy();
    expect(row!.isCollabAdmin).toBeTruthy();
  });

  it("applyUpdateRoles helper does NOT auto-clear isCataloguer/isCollabAdmin when posted from a crowdsourcing-off tenant", async () => {
    const db = drizzle(env.DB);
    const targetId = await seedUser(db, {
      tenantId: SECOND_TEST_TENANT_ID,
      flags: { isCataloguer: true, isCollabAdmin: true },
    });

    // Build a form body shaped exactly as the JSX would emit when
    // crowdsourcing is off: only the four always-rendered flags
    // appear; isCollabAdmin and isCataloguer are NOT in the body.
    const formData = new FormData();
    formData.append("_action", "updateRoles");
    formData.append("isAdmin", "on");
    formData.append("isUserManager", "on");
    // isSuperAdmin and isArchiveUser deliberately omitted (off).

    const { applyUpdateRoles } = await import(
      "../../app/routes/_auth.admin.users.$id"
    );
    await applyUpdateRoles({
      db,
      tenantId: SECOND_TEST_TENANT_ID,
      crowdsourcingEnabled: false,
      targetUserId: targetId,
      formData,
    });

    // The dormant flags are still set; the helper skipped them
    // because crowdsourcingEnabled was false.
    const after = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, targetId))
      .get();
    expect(after).toBeTruthy();
    expect(after!.isCataloguer).toBeTruthy();
    expect(after!.isCollabAdmin).toBeTruthy();
    // The four always-rendered flags reflect the post body.
    expect(after!.isAdmin).toBeTruthy();
    expect(after!.isUserManager).toBeTruthy();
    expect(after!.isSuperAdmin).toBeFalsy();
    expect(after!.isArchiveUser).toBeFalsy();
  });

  it("applyUpdateRoles helper writes all six flags when crowdsourcing is on (Neogranadina shape)", async () => {
    const db = drizzle(env.DB);
    const targetId = await seedUser(db, {
      tenantId: DEFAULT_TEST_TENANT_ID,
      flags: { isCataloguer: true, isCollabAdmin: true },
    });

    // Form body emitted by the JSX when crowdsourcing is on: all six
    // flags are renderable; here we deliberately uncheck the two
    // capability-dependent ones to confirm the helper writes them
    // (no auto-skip when capability is on).
    const formData = new FormData();
    formData.append("_action", "updateRoles");
    formData.append("isAdmin", "on");
    formData.append("isUserManager", "on");
    // isCollabAdmin and isCataloguer omitted (unchecked).

    const { applyUpdateRoles } = await import(
      "../../app/routes/_auth.admin.users.$id"
    );
    await applyUpdateRoles({
      db,
      tenantId: DEFAULT_TEST_TENANT_ID,
      crowdsourcingEnabled: true,
      targetUserId: targetId,
      formData,
    });

    const after = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, targetId))
      .get();
    expect(after).toBeTruthy();
    // Capability-on tenant: the unchecked fields ARE cleared (the
    // existing v0.3 behaviour for an admin who uses the form to
    // strip a role).
    expect(after!.isCataloguer).toBeFalsy();
    expect(after!.isCollabAdmin).toBeFalsy();
    expect(after!.isAdmin).toBeTruthy();
    expect(after!.isUserManager).toBeTruthy();
  });
});
