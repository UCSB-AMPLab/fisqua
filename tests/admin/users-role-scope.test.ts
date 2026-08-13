/**
 * Tests — admin role-assignment scope
 *
 * This suite pins the split between the roles a tenant admin may hand
 * out and the roles that stay super-admin-only, and the boundaries
 * that keep the first from becoming the second.
 *
 * The split exists because a federation steward's effective
 * member-tenant flags are admin-equivalent but deliberately NOT
 * `isSuperAdmin` (see `grantEffectiveRoleFlags`). Under the old
 * super-admin-only rule a steward onboarding a partner workspace could
 * invite colleagues and then give them nothing, so the people they
 * invited signed in to an empty dashboard with no in-product way out.
 *
 * Four boundaries, each with its own case:
 *
 *   - Target scoping. A tenant admin may only touch users of the
 *     REQUEST tenant, which comes from `tenantContext` and never from
 *     the acting user's own row. A target elsewhere 404s, with the
 *     same shape a missing id gets, so probing cannot tell the two
 *     apart.
 *   - No self-escalation. `isSuperAdmin` and `isUserManager` are not
 *     reachable by a tenant admin down any path, including a crafted
 *     form body — the action refuses the submission rather than
 *     trusting the field, and nothing is written.
 *   - Self-protection, unchanged: nobody edits their own roles.
 *   - The UI offers only what the action will accept: the loader
 *     returns the caller's assignable set, which is what the JSX
 *     enables.
 *
 * Most cases drive the real route `action`, so the guards are
 * exercised in the order the request meets them. That needs an i18n
 * instance in context, which `runI18nMiddleware` supplies by invoking
 * the real middleware — the action calls `i18n.t(...)` on every
 * refusal path, and a stub would not prove the keys exist.
 *
 * @version v0.7.0
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
import {
  assignableRoleFlags,
  canAssignTenantRoles,
  canManageTenantUsers,
  unassignableSubmittedRoleFlags,
  PLATFORM_SCOPED_ROLE_FLAGS,
  TENANT_SCOPED_ROLE_FLAGS,
} from "../../app/lib/permissions.server";

type Db = ReturnType<typeof drizzle>;

/**
 * Populate the i18next context slot by running the real middleware.
 * `getInstance` reads a context key the middleware owns and does not
 * export, so there is no way to set it directly — running the
 * middleware for one no-op request is the supported route in.
 */
async function runI18nMiddleware(
  ctx: RouterContextProvider,
  request: Request,
): Promise<void> {
  const { i18nextMiddleware } = await import("../../app/middleware/i18next");
  await (i18nextMiddleware as any)(
    { request, params: {}, context: ctx },
    async () => new Response(null),
  );
}

async function buildContext(args: {
  user: User;
  tenantId: string;
  crowdsourcingEnabled?: boolean;
  request: Request;
}): Promise<any> {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, args.user);
  ctx.set(
    tenantContext,
    makeTenantContext({
      id: args.tenantId,
      slug:
        args.tenantId === SECOND_TEST_TENANT_ID
          ? "second-tenant"
          : "neogranadina",
      crowdsourcingEnabled: args.crowdsourcingEnabled ?? true,
    }),
  );
  (ctx as any).cloudflare = { env };
  await runI18nMiddleware(ctx, args.request);
  return ctx;
}

function roleForm(fields: Record<string, string>): Request {
  const body = new URLSearchParams({ _action: "updateRoles", ...fields });
  return new Request("http://localhost/admin/users/x", {
    method: "POST",
    body,
  });
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
    email: `scope-${id.slice(0, 8)}@example.com`,
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

/** A project owned by the OTHER tenant, for the scoping cases. */
async function seedForeignProject(db: Db): Promise<string> {
  const ownerId = await seedUser(db, { tenantId: SECOND_TEST_TENANT_ID });
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(schema.projects).values({
    id,
    tenantId: SECOND_TEST_TENANT_ID,
    name: "Foreign project",
    createdBy: ownerId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

function readUser(db: Db, id: string) {
  return db.select().from(schema.users).where(eq(schema.users.id, id)).get();
}

/** A tenant admin: what a federation steward's effective flags look like. */
const tenantAdmin = (tenantId: string) =>
  makeUserContext({
    id: crypto.randomUUID(),
    tenantId,
    isAdmin: true,
    isUserManager: true,
  });

const superAdmin = (tenantId: string) =>
  makeUserContext({ id: crypto.randomUUID(), tenantId, isSuperAdmin: true });

// ---------------------------------------------------------------------------
// The split itself
// ---------------------------------------------------------------------------

describe("role-assignment scope helpers", () => {
  it("a super admin may assign every role flag", () => {
    const flags = assignableRoleFlags(superAdmin(DEFAULT_TEST_TENANT_ID));
    for (const flag of [
      ...TENANT_SCOPED_ROLE_FLAGS,
      ...PLATFORM_SCOPED_ROLE_FLAGS,
      "isCollabAdmin",
      "isCataloguer",
    ] as const) {
      expect(flags).toContain(flag);
    }
  });

  it("a tenant admin may assign the tenant-scoped roles and nothing else", () => {
    const flags = assignableRoleFlags(tenantAdmin(DEFAULT_TEST_TENANT_ID));
    expect([...flags]).toEqual([...TENANT_SCOPED_ROLE_FLAGS]);
    for (const flag of PLATFORM_SCOPED_ROLE_FLAGS) {
      expect(flags).not.toContain(flag);
    }
  });

  it("a user manager who is not a tenant admin may assign nothing", () => {
    const userManager = makeUserContext({ isUserManager: true });
    expect([...assignableRoleFlags(userManager)]).toEqual([]);
    expect(canAssignTenantRoles(userManager)).toBe(false);
    // ...but still reaches the surface, which is what the flag is for.
    expect(canManageTenantUsers(userManager)).toBe(true);
  });

  it("a user with no administrative flag reaches nothing", () => {
    const plain = makeUserContext();
    expect(canManageTenantUsers(plain)).toBe(false);
    expect([...assignableRoleFlags(plain)]).toEqual([]);
  });

  it("submitted platform flags are reported back for a tenant admin, and not for a super admin", () => {
    const body = new FormData();
    body.append("isAdmin", "on");
    body.append("isSuperAdmin", "on");

    expect(
      unassignableSubmittedRoleFlags(tenantAdmin(DEFAULT_TEST_TENANT_ID), body),
    ).toEqual(["isSuperAdmin"]);
    expect(
      unassignableSubmittedRoleFlags(superAdmin(DEFAULT_TEST_TENANT_ID), body),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The action
// ---------------------------------------------------------------------------

describe("user detail action - role scope", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("a tenant admin grants Records admin to a user of their own tenant", async () => {
    const db = drizzle(env.DB);
    const targetId = await seedUser(db, { tenantId: DEFAULT_TEST_TENANT_ID });

    const request = roleForm({ isAdmin: "on" });
    const ctx = await buildContext({
      user: tenantAdmin(DEFAULT_TEST_TENANT_ID),
      tenantId: DEFAULT_TEST_TENANT_ID,
      request,
    });

    const { action } = await import("../../app/routes/_auth.admin.users.$id");
    const res = (await action({
      request,
      params: { id: targetId },
      context: ctx,
    } as any)) as any;

    expect(res.ok).toBe(true);
    const after = await readUser(db, targetId);
    expect(after!.isAdmin).toBeTruthy();
  });

  it("a tenant admin's crafted isSuperAdmin field is refused and nothing is written", async () => {
    const db = drizzle(env.DB);
    const targetId = await seedUser(db, { tenantId: DEFAULT_TEST_TENANT_ID });

    // Exactly the body a tampered client would send: the legitimate
    // field plus the one the page rendered disabled.
    const request = roleForm({ isAdmin: "on", isSuperAdmin: "on" });
    const ctx = await buildContext({
      user: tenantAdmin(DEFAULT_TEST_TENANT_ID),
      tenantId: DEFAULT_TEST_TENANT_ID,
      request,
    });

    const { action } = await import("../../app/routes/_auth.admin.users.$id");
    const res = (await action({
      request,
      params: { id: targetId },
      context: ctx,
    } as any)) as any;

    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();

    const after = await readUser(db, targetId);
    expect(after!.isSuperAdmin).toBeFalsy();
    // The whole submission is refused, not partially applied: the
    // legitimate half of the crafted body did not land either.
    expect(after!.isAdmin).toBeFalsy();
  });

  it("a tenant admin's crafted isUserManager field is refused too", async () => {
    const db = drizzle(env.DB);
    const targetId = await seedUser(db, { tenantId: DEFAULT_TEST_TENANT_ID });

    const request = roleForm({ isUserManager: "on" });
    const ctx = await buildContext({
      user: tenantAdmin(DEFAULT_TEST_TENANT_ID),
      tenantId: DEFAULT_TEST_TENANT_ID,
      request,
    });

    const { action } = await import("../../app/routes/_auth.admin.users.$id");
    const res = (await action({
      request,
      params: { id: targetId },
      context: ctx,
    } as any)) as any;

    expect(res.ok).toBe(false);
    const after = await readUser(db, targetId);
    expect(after!.isUserManager).toBeFalsy();
  });

  it("a tenant admin cannot escalate themselves by naming their own account", async () => {
    const db = drizzle(env.DB);
    const acting = tenantAdmin(DEFAULT_TEST_TENANT_ID);
    const actingId = await seedUser(db, {
      tenantId: DEFAULT_TEST_TENANT_ID,
      flags: { isAdmin: true },
    });
    const actingUser = { ...acting, id: actingId };

    const request = roleForm({ isAdmin: "on", isSuperAdmin: "on" });
    const ctx = await buildContext({
      user: actingUser,
      tenantId: DEFAULT_TEST_TENANT_ID,
      request,
    });

    const { action } = await import("../../app/routes/_auth.admin.users.$id");
    const res = (await action({
      request,
      params: { id: actingId },
      context: ctx,
    } as any)) as any;

    expect(res.ok).toBe(false);
    const after = await readUser(db, actingId);
    expect(after!.isSuperAdmin).toBeFalsy();
  });

  it("the existing self-protection still refuses a plain self role change", async () => {
    const db = drizzle(env.DB);
    const acting = superAdmin(DEFAULT_TEST_TENANT_ID);
    const actingId = await seedUser(db, {
      tenantId: DEFAULT_TEST_TENANT_ID,
      flags: { isSuperAdmin: true },
    });

    const request = roleForm({ isArchiveUser: "on" });
    const ctx = await buildContext({
      user: { ...acting, id: actingId },
      tenantId: DEFAULT_TEST_TENANT_ID,
      request,
    });

    const { action } = await import("../../app/routes/_auth.admin.users.$id");
    const res = (await action({
      request,
      params: { id: actingId },
      context: ctx,
    } as any)) as any;

    expect(res.ok).toBe(false);
    const after = await readUser(db, actingId);
    expect(after!.isArchiveUser).toBeFalsy();
    // Self-protection must not have cost the caller their own roles.
    expect(after!.isSuperAdmin).toBeTruthy();
  });

  it("a target in another tenant 404s and is left alone", async () => {
    const db = drizzle(env.DB);
    // The target lives in the second tenant; the request is served for
    // the default one.
    const foreignId = await seedUser(db, { tenantId: SECOND_TEST_TENANT_ID });

    const request = roleForm({ isAdmin: "on" });
    const ctx = await buildContext({
      user: tenantAdmin(DEFAULT_TEST_TENANT_ID),
      tenantId: DEFAULT_TEST_TENANT_ID,
      request,
    });

    const { action } = await import("../../app/routes/_auth.admin.users.$id");
    let thrown: unknown;
    try {
      await action({
        request,
        params: { id: foreignId },
        context: ctx,
      } as any);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);

    const after = await readUser(db, foreignId);
    expect(after!.isAdmin).toBeFalsy();
  });

  it("a super admin keeps the full set, including the platform roles", async () => {
    const db = drizzle(env.DB);
    const targetId = await seedUser(db, { tenantId: DEFAULT_TEST_TENANT_ID });

    const request = roleForm({
      isSuperAdmin: "on",
      isUserManager: "on",
      isAdmin: "on",
    });
    const ctx = await buildContext({
      user: superAdmin(DEFAULT_TEST_TENANT_ID),
      tenantId: DEFAULT_TEST_TENANT_ID,
      request,
    });

    const { action } = await import("../../app/routes/_auth.admin.users.$id");
    const res = (await action({
      request,
      params: { id: targetId },
      context: ctx,
    } as any)) as any;

    expect(res.ok).toBe(true);
    const after = await readUser(db, targetId);
    expect(after!.isSuperAdmin).toBeTruthy();
    expect(after!.isUserManager).toBeTruthy();
    expect(after!.isAdmin).toBeTruthy();
  });

  it("a tenant admin's save leaves the platform flags it cannot see untouched", async () => {
    const db = drizzle(env.DB);
    // A target who already holds a platform role. The tenant admin's
    // form does not carry those fields at all, and an absent checkbox
    // normally reads as false — so this is the case where a naive
    // read-everything action would silently demote a user manager.
    const targetId = await seedUser(db, {
      tenantId: DEFAULT_TEST_TENANT_ID,
      flags: { isUserManager: true, isSuperAdmin: true },
    });

    const request = roleForm({ isArchiveUser: "on" });
    const ctx = await buildContext({
      user: tenantAdmin(DEFAULT_TEST_TENANT_ID),
      tenantId: DEFAULT_TEST_TENANT_ID,
      request,
    });

    const { action } = await import("../../app/routes/_auth.admin.users.$id");
    const res = (await action({
      request,
      params: { id: targetId },
      context: ctx,
    } as any)) as any;

    expect(res.ok).toBe(true);
    const after = await readUser(db, targetId);
    expect(after!.isArchiveUser).toBeTruthy();
    expect(after!.isUserManager).toBeTruthy();
    expect(after!.isSuperAdmin).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Target scoping across the rest of the action's intents
// ---------------------------------------------------------------------------

describe("user detail action - target scoping", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  function postForm(fields: Record<string, string>): Request {
    return new Request("http://localhost/admin/users/x", {
      method: "POST",
      body: new URLSearchParams(fields),
    });
  }

  async function runAction(request: Request, targetId: string) {
    const ctx = await buildContext({
      user: tenantAdmin(DEFAULT_TEST_TENANT_ID),
      tenantId: DEFAULT_TEST_TENANT_ID,
      request,
    });
    const { action } = await import("../../app/routes/_auth.admin.users.$id");
    return action({ request, params: { id: targetId }, context: ctx } as any);
  }

  it("a profile edit against a cross-tenant target 404s instead of silently no-opping", async () => {
    const db = drizzle(env.DB);
    const foreignId = await seedUser(db, {
      tenantId: SECOND_TEST_TENANT_ID,
      flags: { name: "Untouched" },
    });

    let thrown: unknown;
    try {
      await runAction(
        postForm({
          _action: "updateProfile",
          name: "Renamed",
          email: "renamed@example.com",
        }),
        foreignId,
      );
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
    const after = await readUser(db, foreignId);
    expect(after!.name).toBe("Untouched");
  });

  it("a project assignment naming another tenant's project 404s and writes no membership", async () => {
    const db = drizzle(env.DB);
    const targetId = await seedUser(db, { tenantId: DEFAULT_TEST_TENANT_ID });

    // A project belonging to the OTHER tenant. The loader would never
    // have offered it; the id arrives in the body.
    const foreignProjectId = await seedForeignProject(db);

    let thrown: unknown;
    try {
      await runAction(
        postForm({
          _action: "assignToProject",
          projectId: foreignProjectId,
          role: "cataloguer",
        }),
        targetId,
      );
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);

    const rows = await db
      .select()
      .from(schema.projectMembers)
      .where(eq(schema.projectMembers.projectId, foreignProjectId))
      .all();
    expect(rows).toEqual([]);
  });

  it("a membership id from another tenant cannot be re-roled or removed", async () => {
    const db = drizzle(env.DB);
    const targetId = await seedUser(db, { tenantId: DEFAULT_TEST_TENANT_ID });

    const foreignProjectId = await seedForeignProject(db);
    const foreignUserId = await seedUser(db, {
      tenantId: SECOND_TEST_TENANT_ID,
    });
    const foreignMembershipId = crypto.randomUUID();
    await db.insert(schema.projectMembers).values({
      id: foreignMembershipId,
      projectId: foreignProjectId,
      userId: foreignUserId,
      role: "cataloguer",
      createdAt: Math.floor(Date.now() / 1000),
    });

    for (const intent of ["changeRole", "removeFromProject"]) {
      let thrown: unknown;
      try {
        await runAction(
          postForm({
            _action: intent,
            membershipId: foreignMembershipId,
            role: "lead",
          }),
          targetId,
        );
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(404);
    }

    const after = await db
      .select()
      .from(schema.projectMembers)
      .where(eq(schema.projectMembers.id, foreignMembershipId))
      .get();
    expect(after).toBeTruthy();
    expect(after!.role).toBe("cataloguer");
  });
});

// ---------------------------------------------------------------------------
// The loader — the UI must not offer what the action refuses
// ---------------------------------------------------------------------------

describe("user detail loader - editable role set", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  async function loadFor(user: User, targetId: string) {
    const request = new Request("http://localhost/admin/users/" + targetId);
    const ctx = await buildContext({
      user,
      tenantId: DEFAULT_TEST_TENANT_ID,
      request,
    });
    const { loader } = await import("../../app/routes/_auth.admin.users.$id");
    return (await loader({
      request,
      params: { id: targetId },
      context: ctx,
    } as any)) as any;
  }

  it("a tenant admin gets the two tenant-scoped roles as editable", async () => {
    const db = drizzle(env.DB);
    const targetId = await seedUser(db, { tenantId: DEFAULT_TEST_TENANT_ID });

    const res = await loadFor(tenantAdmin(DEFAULT_TEST_TENANT_ID), targetId);

    expect(res.canEditRoles).toBe(true);
    expect(res.canEditAllRoles).toBe(false);
    expect(res.editableRoles).toEqual([...TENANT_SCOPED_ROLE_FLAGS]);
    for (const flag of PLATFORM_SCOPED_ROLE_FLAGS) {
      expect(res.editableRoles).not.toContain(flag);
    }
  });

  it("a super admin gets every role as editable", async () => {
    const db = drizzle(env.DB);
    const targetId = await seedUser(db, { tenantId: DEFAULT_TEST_TENANT_ID });

    const res = await loadFor(superAdmin(DEFAULT_TEST_TENANT_ID), targetId);

    expect(res.canEditRoles).toBe(true);
    expect(res.canEditAllRoles).toBe(true);
    for (const flag of PLATFORM_SCOPED_ROLE_FLAGS) {
      expect(res.editableRoles).toContain(flag);
    }
  });

  it("a user manager gets a read-only role fieldset", async () => {
    const db = drizzle(env.DB);
    const targetId = await seedUser(db, { tenantId: DEFAULT_TEST_TENANT_ID });

    const res = await loadFor(
      makeUserContext({
        id: crypto.randomUUID(),
        tenantId: DEFAULT_TEST_TENANT_ID,
        isUserManager: true,
      }),
      targetId,
    );

    expect(res.canEditRoles).toBe(false);
    expect(res.editableRoles).toEqual([]);
  });

  it("a cross-tenant target 404s at the loader as well", async () => {
    const db = drizzle(env.DB);
    const foreignId = await seedUser(db, { tenantId: SECOND_TEST_TENANT_ID });

    let thrown: unknown;
    try {
      await loadFor(tenantAdmin(DEFAULT_TEST_TENANT_ID), foreignId);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });
});
