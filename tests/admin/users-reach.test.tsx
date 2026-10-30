/**
 * Tests — workspace admins reach users and projects
 *
 * This suite pins who reaches the user and cataloguing admin surfaces,
 * and that reaching a surface grants no role flag. Five parts:
 *
 *   1. The sidebar's bottom link to /admin/users, labelled "Users"
 *      (`sidebar:users`), shows under the page's own gate,
 *      `canManageTenantUsers`: a tenant admin and a user manager see
 *      it, a plain member does not.
 *
 *   2. The dashboard. The loader computes `canManageUsers` from the
 *      same rule; the Admin button and the empty state's manage-users
 *      link both go to /admin/users and show only under it.
 *
 *   3. A tenant admin (`isAdmin`) opens All projects and Team, whose
 *      loaders and actions sit behind `requireCollabAdmin`. The same
 *      admin still cannot set `isSuperAdmin`, `isUserManager` or any
 *      other flag outside `assignableRoleFlags`: the user detail action
 *      refuses a crafted body naming one. Team's
 *      remove action ignores a membership in another tenant's project.
 *      On a crowdsourcing-off tenant every cataloguing admin action
 *      (create project, assign, remove, promote) 404s and writes
 *      nothing, because the layout's capability check runs only in its
 *      loader and a loader does not guard an action. The same holds
 *      for every action under `/projects/:id/*`. The user detail page
 *      lists, and lets an admin change, only memberships in the
 *      request tenant's projects.
 *
 *   4. The user detail page's "Only a super admin or a workspace admin can change roles"
 *      notice shows only to a viewer whose assignable set is empty.
 *
 *   5. /admin/cataloguing/users redirects to
 *      /admin/users?area=cataloguing.
 *
 * Rendered cases use `renderToStaticMarkup` with an isolated i18next
 * instance over the real locale bundles, inside `createRoutesStub`, as
 * `tests/admin/save-feedback.test.tsx` does. Loader and action cases
 * build a `RouterContextProvider` by hand and run the real i18next
 * middleware for the actions that read `getInstance`, as
 * `tests/admin/users-role-scope.test.ts` does.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { createRoutesStub, RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import resources from "../../app/locales";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import {
  grantContext,
  impersonationContext,
  tenantContext,
  userContext,
  type User,
} from "../../app/context";
import {
  Sidebar,
  type SidebarTenant,
  type SidebarUser,
} from "../../app/components/layout/sidebar";
import Dashboard from "../../app/routes/_auth.dashboard";
import UserDetailPage from "../../app/routes/_auth.admin.users.$id";
import {
  assignableRoleFlags,
  TENANT_SCOPED_ROLE_FLAGS,
  unassignableSubmittedRoleFlags,
} from "../../app/lib/permissions.server";

type Db = ReturnType<typeof drizzle>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function render(
  lang: "en" | "es",
  path: string,
  element: () => React.ReactElement,
): Promise<string> {
  const inst = i18next.createInstance();
  await (inst.init as (opts: unknown) => Promise<unknown>)({
    lng: lang,
    fallbackLng: "es",
    defaultNS: "common",
    resources,
    interpolation: { escapeValue: false },
  });
  const Stub = createRoutesStub([{ path, Component: element }]);
  return renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n: inst },
      React.createElement(Stub, { initialEntries: [path] }),
    ),
  );
}

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
  crowdsourcingEnabled?: boolean;
  request?: Request;
}): Promise<any> {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, args.user);
  ctx.set(
    tenantContext,
    makeTenantContext({
      id: DEFAULT_TEST_TENANT_ID,
      crowdsourcingEnabled: args.crowdsourcingEnabled ?? true,
    }),
  );
  ctx.set(impersonationContext, null);
  ctx.set(grantContext, null);
  (ctx as any).cloudflare = { env };
  if (args.request) await runI18nMiddleware(ctx, args.request);
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
    email: `reach-${id.slice(0, 8)}@example.com`,
    name: "Target",
    isAdmin: false,
    isSuperAdmin: false,
    isCollabAdmin: false,
    isArchiveUser: false,
    isUserManager: false,
    isCataloguer: false,
    isRecordsAdmin: false,
    isAuthoritiesAdmin: false,
    isImportsAdmin: false,
    isDigitizationAdmin: false,
    createdAt: now,
    updatedAt: now,
    ...args.flags,
  });
  return id;
}

async function seedProject(db: Db, tenantId: string): Promise<string> {
  const ownerId = await seedUser(db, { tenantId });
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(schema.projects).values({
    id,
    tenantId,
    name: `Project ${id.slice(0, 4)}`,
    createdBy: ownerId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

function post(path: string, fields: Record<string, string>): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    body: new URLSearchParams(fields),
  });
}

/** A tenant admin and nothing else: no platform or cataloguing flag. */
const tenantAdmin = () =>
  makeUserContext({ id: crypto.randomUUID(), isAdmin: true });

// ---------------------------------------------------------------------------
// 1. Sidebar link
// ---------------------------------------------------------------------------

function sidebarUser(overrides: Partial<SidebarUser> = {}): SidebarUser {
  return {
    isAdmin: false,
    isSuperAdmin: false,
    isCollabAdmin: false,
    isArchiveUser: false,
    isUserManager: false,
    isCataloguer: false,
    isRecordsAdmin: false,
    isAuthoritiesAdmin: false,
    isImportsAdmin: false,
    hasAnyProjectMembership: false,
    isCaptureManager: false,
    isCaptureReviewer: false,
    ...overrides,
  };
}

const sidebarTenant: SidebarTenant = {
  crowdsourcingEnabled: true,
  vocabularyHubEnabled: true,
  publishPipelineEnabled: true,
  multiRepositoryEnabled: true,
  authoritiesEnabled: true,
  importsEnabled: false,
  digitizationEnabled: false,
};

function renderSidebar(lang: "en" | "es", user: SidebarUser) {
  return render(lang, "/", () =>
    React.createElement(Sidebar, {
      user,
      tenant: sidebarTenant,
      collapsed: false,
      onToggle: () => {},
    }),
  );
}

describe("sidebar link to /admin/users", () => {
  it("shows to a tenant admin, labelled Users", async () => {
    const html = await renderSidebar("en", sidebarUser({ isAdmin: true }));
    expect(html).toMatch(/href="\/admin\/users"[^>]*>[\s\S]*?Users</);
    expect(html).not.toContain("System users");
  });

  it("shows to a user manager", async () => {
    const html = await renderSidebar("en", sidebarUser({ isUserManager: true }));
    expect(html).toContain('href="/admin/users"');
  });

  it("does not show to a member with no administrative flag", async () => {
    const html = await renderSidebar(
      "en",
      sidebarUser({ hasAnyProjectMembership: true }),
    );
    expect(html).not.toContain('href="/admin/users"');
  });

  it("reads Usuarios in Spanish", async () => {
    const html = await renderSidebar("es", sidebarUser({ isAdmin: true }));
    expect(html).toMatch(/href="\/admin\/users"[^>]*>[\s\S]*?Usuarios</);
    expect(html).not.toContain("Usuarios del sistema");
  });
});

// ---------------------------------------------------------------------------
// 2. Dashboard
// ---------------------------------------------------------------------------

describe("dashboard loader - canManageUsers", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  async function loadFor(user: User, crowdsourcingEnabled = true) {
    const { loader } = await import("../../app/routes/_auth.dashboard");
    const ctx = await buildContext({ user, crowdsourcingEnabled });
    return (await loader({
      request: new Request("http://localhost/"),
      context: ctx,
      params: {},
    } as any)) as { canManageUsers: boolean };
  }

  it("is true for a tenant admin", async () => {
    expect((await loadFor(tenantAdmin())).canManageUsers).toBe(true);
  });

  it("is true for a user manager, crowdsourcing off as well", async () => {
    const manager = makeUserContext({
      id: crypto.randomUUID(),
      isUserManager: true,
    });
    expect((await loadFor(manager)).canManageUsers).toBe(true);
    expect((await loadFor(manager, false)).canManageUsers).toBe(true);
  });

  it("is false for a collab admin with no tenant or platform role", async () => {
    const collab = makeUserContext({
      id: crypto.randomUUID(),
      isCollabAdmin: true,
    });
    expect((await loadFor(collab)).canManageUsers).toBe(false);
  });
});

function renderDashboard(args: {
  user: Partial<User>;
  canManageUsers: boolean;
  crowdsourcing: boolean;
}) {
  const loaderData = {
    user: makeUserContext(args.user),
    caps: { crowdsourcing: args.crowdsourcing, imports: false },
    primaryRole: "none",
    data: null,
    pendingDecisions: null,
    canManageUsers: args.canManageUsers,
    lang: "en",
  };
  return render("en", "/", () =>
    React.createElement(Dashboard as React.ComponentType<any>, {
      loaderData,
      params: {},
      matches: [],
    }),
  );
}

describe("dashboard links to /admin/users", () => {
  it("a tenant admin's Admin button and empty-state link both go to /admin/users", async () => {
    const html = await renderDashboard({
      user: { isAdmin: true },
      canManageUsers: true,
      crowdsourcing: true,
    });
    expect(html.match(/href="\/admin\/users"/g)).toHaveLength(2);
    expect(html).not.toContain("/admin/cataloguing/users");
    expect(html).toContain('href="/projects/new"');
  });

  it("a user manager on a crowdsourcing-off tenant gets the Admin button but not New project", async () => {
    const html = await renderDashboard({
      user: { isUserManager: true },
      canManageUsers: true,
      crowdsourcing: false,
    });
    expect(html).toContain('href="/admin/users"');
    expect(html).not.toContain('href="/projects/new"');
  });

  it("a member who cannot manage users sees neither link", async () => {
    const html = await renderDashboard({
      user: {},
      canManageUsers: false,
      crowdsourcing: true,
    });
    expect(html).not.toContain('href="/admin/users"');
    expect(html).not.toContain("/admin/cataloguing/users");
  });
});

// ---------------------------------------------------------------------------
// 3. Tenant admins reach All projects and Team, and gain no flag
// ---------------------------------------------------------------------------

describe("tenant admin on the cataloguing admin surface", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("passes the cataloguing layout gate", async () => {
    const { loader } = await import("../../app/routes/_auth.admin.cataloguing");
    const ctx = await buildContext({ user: tenantAdmin() });
    await expect(
      loader({
        request: new Request("http://localhost/admin/cataloguing"),
        context: ctx,
        params: {},
      } as any),
    ).resolves.toBeTruthy();
  });

  it("opens All projects", async () => {
    const { loader } = await import(
      "../../app/routes/_auth.admin.cataloguing.projects"
    );
    const db = drizzle(env.DB);
    await seedProject(db, DEFAULT_TEST_TENANT_ID);
    const ctx = await buildContext({ user: tenantAdmin() });
    const data = (await loader({
      request: new Request("http://localhost/admin/cataloguing/projects"),
      context: ctx,
      params: {},
    } as any)) as Record<string, unknown>;
    expect(data).toBeTruthy();
  });

  it("opens Team and assigns a member to a project", async () => {
    const team = await import("../../app/routes/_auth.admin.cataloguing.team");
    const db = drizzle(env.DB);
    const admin = tenantAdmin();
    await seedUser(db, { tenantId: DEFAULT_TEST_TENANT_ID, flags: { id: admin.id, isAdmin: true } });

    const loaderCtx = await buildContext({ user: admin });
    await expect(
      team.loader({
        request: new Request("http://localhost/admin/cataloguing/team"),
        context: loaderCtx,
        params: {},
      } as any),
    ).resolves.toBeTruthy();

    const projectId = await seedProject(db, DEFAULT_TEST_TENANT_ID);
    const memberId = await seedUser(db, { tenantId: DEFAULT_TEST_TENANT_ID });
    const request = post("/admin/cataloguing/team", {
      _action: "assignToProject",
      userId: memberId,
      projectId,
      role: "cataloguer",
    });
    const actionCtx = await buildContext({ user: admin, request: new Request("http://localhost/") });
    const result = await team.action({
      request,
      context: actionCtx,
      params: {},
    } as any);
    expect(result).toMatchObject({ ok: true });

    // A project role, not a flag: the member's row is untouched.
    const row = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, memberId))
      .get();
    expect(row!.isCataloguer).toBeFalsy();
    expect(row!.isCollabAdmin).toBeFalsy();
  });

  it("cannot remove a membership in another tenant's project from Team", async () => {
    const team = await import("../../app/routes/_auth.admin.cataloguing.team");
    const db = drizzle(env.DB);
    const foreignProjectId = await seedProject(db, SECOND_TEST_TENANT_ID);
    const foreignUserId = await seedUser(db, { tenantId: SECOND_TEST_TENANT_ID });
    const membershipId = crypto.randomUUID();
    await db.insert(schema.projectMembers).values({
      id: membershipId,
      projectId: foreignProjectId,
      userId: foreignUserId,
      role: "cataloguer",
      createdAt: Math.floor(Date.now() / 1000),
    });

    const request = post("/admin/cataloguing/team", {
      _action: "removeFromProject",
      membershipId,
    });
    const ctx = await buildContext({ user: tenantAdmin(), request: new Request("http://localhost/") });
    const result = await team.action({ request, context: ctx, params: {} } as any);
    expect(result).toMatchObject({ ok: false });

    const after = await db
      .select()
      .from(schema.projectMembers)
      .where(eq(schema.projectMembers.id, membershipId))
      .get();
    expect(after).toBeTruthy();
  });

  it("assigns the tenant-scoped flags and nothing else", () => {
    const admin = tenantAdmin();
    expect([...assignableRoleFlags(admin)]).toEqual([...TENANT_SCOPED_ROLE_FLAGS]);
    expect(assignableRoleFlags(admin)).toContain("isCollabAdmin");
    expect(assignableRoleFlags(admin)).toContain("isCataloguer");
    for (const flag of ["isSuperAdmin", "isUserManager"] as const) {
      expect(assignableRoleFlags(admin)).not.toContain(flag);
    }
    const body = new FormData();
    body.set("isCollabAdmin", "on");
    body.set("isSuperAdmin", "on");
    body.set("isAdmin", "on");
    expect(unassignableSubmittedRoleFlags(admin, body).sort()).toEqual([
      "isSuperAdmin",
    ]);
  });

  for (const flag of ["isSuperAdmin", "isUserManager"]) {
    it(`cannot set ${flag} through the user detail action`, async () => {
      const { action } = await import("../../app/routes/_auth.admin.users.$id");
      const db = drizzle(env.DB);
      const targetId = await seedUser(db, { tenantId: DEFAULT_TEST_TENANT_ID });
      const request = post(`/admin/users/${targetId}`, {
        _action: "updateRoles",
        shown_isAdmin: "0",
        isAdmin: "on",
        [`shown_${flag}`]: "0",
        [flag]: "on",
      });
      const ctx = await buildContext({ user: tenantAdmin(), request: new Request("http://localhost/") });
      const result = await action({
        request,
        context: ctx,
        params: { id: targetId },
      } as any);
      expect(result).toMatchObject({ ok: false });

      const row = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, targetId))
        .get();
      expect((row as Record<string, unknown>)[flag]).toBeFalsy();
      expect(row!.isAdmin).toBeFalsy();
    });
  }
});

// ---------------------------------------------------------------------------
// 3b. The cataloguing actions check the capability themselves
// ---------------------------------------------------------------------------

describe("cataloguing admin actions on a crowdsourcing-off tenant", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  async function expect404(run: () => Promise<unknown>) {
    let thrown: unknown;
    try {
      await run();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  }

  async function offContext(user: User) {
    return buildContext({
      user,
      crowdsourcingEnabled: false,
      request: new Request("http://localhost/"),
    });
  }

  it("createProject is refused and no project is written", async () => {
    const { action } = await import(
      "../../app/routes/_auth.admin.cataloguing.projects"
    );
    const db = drizzle(env.DB);
    const before = await db.select().from(schema.projects).all();
    const ctx = await offContext(tenantAdmin());
    await expect404(() =>
      action({
        request: post("/admin/cataloguing/projects", {
          _action: "createProject",
          name: "Off-tenant project",
        }),
        context: ctx,
        params: {},
      } as any),
    );
    const after = await db.select().from(schema.projects).all();
    expect(after).toHaveLength(before.length);
    const members = await db.select().from(schema.projectMembers).all();
    expect(members).toHaveLength(0);
  });

  it("assignToProject is refused and no membership is written", async () => {
    const { action } = await import(
      "../../app/routes/_auth.admin.cataloguing.team"
    );
    const db = drizzle(env.DB);
    const projectId = await seedProject(db, DEFAULT_TEST_TENANT_ID);
    const memberId = await seedUser(db, { tenantId: DEFAULT_TEST_TENANT_ID });
    const ctx = await offContext(tenantAdmin());
    await expect404(() =>
      action({
        request: post("/admin/cataloguing/team", {
          _action: "assignToProject",
          userId: memberId,
          projectId,
          role: "cataloguer",
        }),
        context: ctx,
        params: {},
      } as any),
    );
    const members = await db.select().from(schema.projectMembers).all();
    expect(members).toHaveLength(0);
  });

  it("removeFromProject is refused and the membership stays", async () => {
    const { action } = await import(
      "../../app/routes/_auth.admin.cataloguing.team"
    );
    const db = drizzle(env.DB);
    const projectId = await seedProject(db, DEFAULT_TEST_TENANT_ID);
    const memberId = await seedUser(db, { tenantId: DEFAULT_TEST_TENANT_ID });
    const membershipId = crypto.randomUUID();
    await db.insert(schema.projectMembers).values({
      id: membershipId,
      projectId,
      userId: memberId,
      role: "cataloguer",
      createdAt: Math.floor(Date.now() / 1000),
    });
    const ctx = await offContext(tenantAdmin());
    await expect404(() =>
      action({
        request: post("/admin/cataloguing/team", {
          _action: "removeFromProject",
          membershipId,
        }),
        context: ctx,
        params: {},
      } as any),
    );
    const after = await db
      .select()
      .from(schema.projectMembers)
      .where(eq(schema.projectMembers.id, membershipId))
      .get();
    expect(after).toBeTruthy();
  });

  it("promote is refused for a super admin and no description is written", async () => {
    const { action } = await import(
      "../../app/routes/_auth.admin.cataloguing.promote"
    );
    const db = drizzle(env.DB);
    const before = await db.select().from(schema.descriptions).all();
    const ctx = await offContext(
      makeUserContext({ id: crypto.randomUUID(), isSuperAdmin: true }),
    );
    await expect404(() =>
      action({
        request: post("/admin/cataloguing/promote", { volumeId: "v1" }),
        context: ctx,
        params: {},
      } as any),
    );
    const after = await db.select().from(schema.descriptions).all();
    expect(after).toHaveLength(before.length);
  });
});

// ---------------------------------------------------------------------------
// 3c. Project actions check the capability themselves
// ---------------------------------------------------------------------------

describe("project actions on a crowdsourcing-off tenant", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  // One representative write per route, aimed at a real volume and
  // member, so that without the gate each one would change a row.
  // "VOLUME" and "MEMBER" in a body are replaced with the seeded ids.
  const cases: Array<[string, () => Promise<any>, Record<string, string>]> = [
    ["settings", () => import("../../app/routes/_auth.projects.$id.settings"), { _action: "archiveProject" }],
    ["members", () => import("../../app/routes/_auth.projects.$id.members"), { _action: "addMember", role: "cataloguer" }],
    ["volumes", () => import("../../app/routes/_auth.projects.$id.volumes"), { _action: "add-volumes", manifestUrls: "https://example.org/m.json" }],
    ["volume manage", () => import("../../app/routes/_auth.projects.$id.volumes.$volumeId.manage"), { _action: "delete" }],
    ["assignments", () => import("../../app/routes/_auth.projects.$id.assignments"), { _action: "assign", volumeId: "VOLUME", cataloguerId: "MEMBER" }],
    ["assignment descriptions", () => import("../../app/routes/_auth.projects.$id.assignments.description.$volumeId"), { _action: "assignDescriber" }],
    ["overview", () => import("../../app/routes/_auth.projects.$id.overview"), { intent: "assign" }],
  ];

  for (const [label, load, fields] of cases) {
    it(`${label}: refused with a 404 and nothing written`, async () => {
      const mod = await load();
      const db = drizzle(env.DB);
      const admin = tenantAdmin();
      const projectId = await seedProject(db, DEFAULT_TEST_TENANT_ID);
      const memberId = await seedUser(db, { tenantId: DEFAULT_TEST_TENANT_ID });
      const membershipId = crypto.randomUUID();
      await db.insert(schema.projectMembers).values({
        id: membershipId,
        projectId,
        userId: memberId,
        role: "cataloguer",
        createdAt: Math.floor(Date.now() / 1000),
      });
      const volumeId = crypto.randomUUID();
      const now = Date.now();
      await db.insert(schema.volumes).values({
        id: volumeId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        projectId,
        name: "Volume",
        referenceCode: `co-reach-${volumeId.slice(0, 6)}`,
        manifestUrl: "https://example.com/manifest.json",
        pageCount: 1,
        status: "unstarted",
        createdAt: now,
        updatedAt: now,
      });
      const body = Object.fromEntries(
        Object.entries({ ...fields, userId: memberId }).map(([k, v]) => [
          k,
          v === "VOLUME" ? volumeId : v === "MEMBER" ? memberId : v,
        ]),
      );
      const snapshot = async () => ({
        projects: await db.select().from(schema.projects).all(),
        members: await db.select().from(schema.projectMembers).all(),
        volumes: await db.select().from(schema.volumes).all(),
      });
      const before = await snapshot();

      const ctx = await buildContext({
        user: admin,
        crowdsourcingEnabled: false,
        request: new Request("http://localhost/"),
      });
      let thrown: unknown;
      try {
        await mod.action({
          request: post(`/projects/${projectId}/x`, body),
          context: ctx,
          params: { id: projectId, volumeId },
        } as any);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(404);
      expect(await snapshot()).toEqual(before);
    });
  }
});

// ---------------------------------------------------------------------------
// 3d. The user detail page shows only this tenant's memberships
// ---------------------------------------------------------------------------

describe("user detail memberships", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seedMemberships(db: Db) {
    const targetId = await seedUser(db, { tenantId: DEFAULT_TEST_TENANT_ID });
    const localProject = await seedProject(db, DEFAULT_TEST_TENANT_ID);
    const foreignProject = await seedProject(db, SECOND_TEST_TENANT_ID);
    const localMembership = crypto.randomUUID();
    const foreignMembership = crypto.randomUUID();
    const createdAt = Math.floor(Date.now() / 1000);
    await db.insert(schema.projectMembers).values([
      { id: localMembership, projectId: localProject, userId: targetId, role: "cataloguer", createdAt },
      { id: foreignMembership, projectId: foreignProject, userId: targetId, role: "cataloguer", createdAt },
    ]);
    return { targetId, localMembership, foreignMembership };
  }

  it("lists the memberships in this tenant's projects and not another tenant's", async () => {
    const { loader } = await import("../../app/routes/_auth.admin.users.$id");
    const db = drizzle(env.DB);
    const { targetId, localMembership, foreignMembership } = await seedMemberships(db);
    const ctx = await buildContext({ user: tenantAdmin() });
    const data = (await loader({
      request: new Request(`http://localhost/admin/users/${targetId}`),
      context: ctx,
      params: { id: targetId },
    } as any)) as { memberships: Array<{ id: string }> };
    const ids = data.memberships.map((m) => m.id);
    expect(ids).toContain(localMembership);
    expect(ids).not.toContain(foreignMembership);
  });

  for (const intent of ["changeRole", "removeFromProject"]) {
    it(`${intent} on another tenant's membership 404s and leaves it alone`, async () => {
      const { action } = await import("../../app/routes/_auth.admin.users.$id");
      const db = drizzle(env.DB);
      const { targetId, foreignMembership } = await seedMemberships(db);
      const ctx = await buildContext({
        user: tenantAdmin(),
        request: new Request("http://localhost/"),
      });
      let thrown: unknown;
      try {
        await action({
          request: post(`/admin/users/${targetId}`, {
            _action: intent,
            membershipId: foreignMembership,
            role: "lead",
          }),
          context: ctx,
          params: { id: targetId },
        } as any);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(404);
      const row = await db
        .select()
        .from(schema.projectMembers)
        .where(eq(schema.projectMembers.id, foreignMembership))
        .get();
      expect(row).toBeTruthy();
      expect(row!.role).toBe("cataloguer");
    });
  }
});

// ---------------------------------------------------------------------------
// 4. The super-admin notice on the user detail page
// ---------------------------------------------------------------------------

const NOTICE = "Only a super admin or a workspace admin can change roles.";
const TENANT_NOTICE = "You can grant the roles for this workspace.";

function renderDetail(editableRoles: string[], canEditAllRoles: boolean) {
  const now = Date.now();
  const loaderData = {
    targetUser: {
      id: "target",
      email: "target@example.org",
      name: "Target",
      lastActiveAt: null,
      createdAt: now,
    },
    sections: ["records"],
    roles: {
      records: [
        { key: "workspace_admin", field: "isAdmin", checked: false },
        { key: "records_admin", field: "isRecordsAdmin", checked: false },
        { key: "archive_user", field: "isArchiveUser", checked: false },
      ],
    },
    federation: null,
    reviewedVolumes: null,
    history: [],
    memberships: [],
    assignableProjects: [],
    isSelf: false,
    operatorSession: false,
    canManageUser: true,
    editableRoles,
    federationEditable: { steward: false, staff: false },
    canEditRoles: editableRoles.length > 0,
    canEditAllRoles,
  };
  return render("en", "/admin/users/target", () =>
    React.createElement(UserDetailPage as React.ComponentType<any>, {
      loaderData,
      params: { id: "target" },
      matches: [],
    }),
  );
}

describe("user detail notice", () => {
  it("shows to a viewer who can assign nothing (a user manager)", async () => {
    const manager = makeUserContext({ isUserManager: true });
    const html = await renderDetail([...assignableRoleFlags(manager)], false);
    expect(html).toContain(NOTICE);
  });

  it("does not show to a tenant admin, who gets the tenant-roles notice", async () => {
    const html = await renderDetail([...assignableRoleFlags(tenantAdmin())], false);
    expect(html).not.toContain(NOTICE);
    expect(html).toContain(TENANT_NOTICE);
  });

  it("does not show to a super admin", async () => {
    const admin = makeUserContext({ isSuperAdmin: true });
    const html = await renderDetail([...assignableRoleFlags(admin)], true);
    expect(html).not.toContain(NOTICE);
    expect(html).not.toContain(TENANT_NOTICE);
  });
});

// ---------------------------------------------------------------------------
// 5. The old address
// ---------------------------------------------------------------------------

describe("/admin/cataloguing/users", () => {
  it("redirects to /admin/users?area=cataloguing", async () => {
    const { loader } = await import(
      "../../app/routes/_auth.admin.cataloguing.users"
    );
    const response = loader() as Response;
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/admin/users?area=cataloguing");
  });
});

// @version v0.8.0
