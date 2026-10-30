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
 *   (a) Loader on a crowdsourcing-off tenant leaves out the
 *       Cataloguing section, which holds the two checkboxes, and so
 *       sends neither flag to the page.
 *   (b) Loader on a crowdsourcing-on tenant (Neogranadina) includes
 *       the section with both checkboxes and the person's state.
 *   (c) Dormant flag preserved across a no-op cycle: a user with
 *       `isCataloguer = true` on a crowdsourcing-off tenant still has
 *       the flag set after a roundtrip — confirms the seed schema
 *       does not auto-clear capability-dependent flags and gives a baseline for case (d).
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
 * `applyUpdateRoles` also takes the caller's `assignableFlags` — the
 * privilege half of the write filter, covered in
 * `users-role-scope.test.ts`. These cases pass a super admin's full
 * set so the capability half is what they exercise, in isolation. The
 * same filter holds the authorities, imports and digitization admin
 * flags to their areas: a body that names one of them, with its shown
 * value, for a workspace without the area writes nothing to it. Each
 * form carries the shown value of every flag it posts, as the page
 * does.
 *
 * Test mechanics: each route case constructs a `RouterContextProvider`
 * pre-populated with `userContext`, `tenantContext`, and
 * `cloudflare.env`, then invokes the loader directly. The synthetic
 * `Request` uses `localhost` so no Host-header tenant resolution
 * runs (the middleware is bypassed and we set `tenantContext` on the
 * context directly).
 *
 * @version v0.8.0
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
import {
  grantContext,
  impersonationContext,
  tenantContext,
  userContext,
  type User,
} from "../../app/context";
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
  ctx.set(impersonationContext, null);
  ctx.set(grantContext, null);
  (ctx as any).cloudflare = { env };
  return ctx;
}

/** Runs `applyUpdateRoles` as a super admin would, on `tenantId`. */
async function applyAsSuperAdmin(
  db: Db,
  args: {
    tenantId: string;
    capabilities: Partial<Parameters<typeof makeTenantContext>[0]>;
    targetUserId: string;
    formData: FormData;
  },
) {
  const { applyUpdateRoles } = await import(
    "../../app/routes/_auth.admin.users.$id.roles.server"
  );
  const { assignableRoleFlags } = await import(
    "../../app/lib/permissions.server"
  );
  // A real row: the audit row names its actor by a foreign key.
  const superAdmin = makeUserContext({
    id: await seedUser(db, { tenantId: args.tenantId, flags: { isSuperAdmin: true } }),
    tenantId: args.tenantId,
    isSuperAdmin: true,
  });
  return applyUpdateRoles({
    db,
    d1: env.DB,
    tenant: makeTenantContext({ id: args.tenantId, ...args.capabilities }),
    targetUserId: args.targetUserId,
    formData: args.formData,
    // A super admin: every flag is assignable, so the only thing that
    // can hold a flag back is the capability.
    assignableFlags: assignableRoleFlags(superAdmin),
    currentUser: superAdmin,
    actor: {
      user: superAdmin,
      homeTenantId: args.tenantId,
      impersonationSessionId: null,
    },
    now: Date.now(),
    newId: () => crypto.randomUUID(),
  });
}

/** A roles form: each flag with the value shown and the box as posted. */
function rolesForm(flags: Record<string, { shown: boolean; on: boolean }>): FormData {
  const formData = new FormData();
  formData.append("_action", "updateRoles");
  for (const [flag, { shown, on }] of Object.entries(flags)) {
    formData.append(`shown_${flag}`, shown ? "1" : "0");
    if (on) formData.append(flag, "on");
  }
  return formData;
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

    // No Cataloguing section, so neither checkbox renders and the
    // dormant flag does not reach the page.
    expect(res.sections).not.toContain("cataloguing");
    expect(res.roles.cataloguing).toBeUndefined();
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

    expect(res.sections).toContain("cataloguing");
    const cataloguer = res.roles.cataloguing.find((r: { key: string }) => r.key === "cataloguer");
    expect(cataloguer).toEqual({ key: "cataloguer", field: "isCataloguer", checked: true });
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

    // A tampered body for a crowdsourcing-off workspace: it names the
    // pair with their shown values and unchecks them, beside two flags
    // the page does render.
    const formData = rolesForm({
      isAdmin: { shown: false, on: true },
      isUserManager: { shown: false, on: true },
      isSuperAdmin: { shown: false, on: false },
      isArchiveUser: { shown: false, on: false },
      isCollabAdmin: { shown: true, on: false },
      isCataloguer: { shown: true, on: false },
    });

    const result = await applyAsSuperAdmin(db, {
      tenantId: SECOND_TEST_TENANT_ID,
      capabilities: { crowdsourcingEnabled: false },
      targetUserId: targetId,
      formData,
    });
    expect(result).toEqual({ ok: true });

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
    // The flags the page renders reflect the post body.
    expect(after!.isAdmin).toBeTruthy();
    expect(after!.isUserManager).toBeTruthy();
    expect(after!.isSuperAdmin).toBeFalsy();
    expect(after!.isArchiveUser).toBeFalsy();
  });

  it("applyUpdateRoles helper writes the cataloguing pair when crowdsourcing is on (Neogranadina shape)", async () => {
    const db = drizzle(env.DB);
    const targetId = await seedUser(db, {
      tenantId: DEFAULT_TEST_TENANT_ID,
      flags: { isCataloguer: true, isCollabAdmin: true },
    });

    // Crowdsourcing on: the pair is on the page; here both are
    // unchecked to confirm the helper writes them.
    const formData = rolesForm({
      isAdmin: { shown: false, on: true },
      isUserManager: { shown: false, on: true },
      isCollabAdmin: { shown: true, on: false },
      isCataloguer: { shown: true, on: false },
    });

    const result = await applyAsSuperAdmin(db, {
      tenantId: DEFAULT_TEST_TENANT_ID,
      capabilities: { crowdsourcingEnabled: true },
      targetUserId: targetId,
      formData,
    });
    expect(result).toEqual({ ok: true });

    const after = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, targetId))
      .get();
    expect(after).toBeTruthy();
    expect(after!.isCataloguer).toBeFalsy();
    expect(after!.isCollabAdmin).toBeFalsy();
    expect(after!.isAdmin).toBeTruthy();
    expect(after!.isUserManager).toBeTruthy();
  });

  it("applyUpdateRoles helper writes no area admin flag for an area the workspace does not have", async () => {
    const db = drizzle(env.DB);
    const targetId = await seedUser(db, {
      tenantId: DEFAULT_TEST_TENANT_ID,
      flags: { isDigitizationAdmin: true },
    });

    // Authorities on, imports and digitization off: a tampered body
    // grants imports, revokes digitization and grants authorities.
    const formData = rolesForm({
      isAuthoritiesAdmin: { shown: false, on: true },
      isImportsAdmin: { shown: false, on: true },
      isDigitizationAdmin: { shown: true, on: false },
    });

    const result = await applyAsSuperAdmin(db, {
      tenantId: DEFAULT_TEST_TENANT_ID,
      capabilities: { authoritiesEnabled: true, importsEnabled: false, digitizationEnabled: false },
      targetUserId: targetId,
      formData,
    });
    expect(result).toEqual({ ok: true });

    const after = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, targetId))
      .get();
    expect(after!.isAuthoritiesAdmin).toBeTruthy();
    expect(after!.isImportsAdmin).toBeFalsy();
    expect(after!.isDigitizationAdmin).toBeTruthy();
    // Only the one change that landed is in the audit log.
    const rows = await db.select().from(schema.auditLog).all();
    expect(rows.map((r) => JSON.parse(r.details!))).toEqual([
      { flag: "isAuthoritiesAdmin", step: "granted" },
    ]);
  });
});

// @version v0.8.0
