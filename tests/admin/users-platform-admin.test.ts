/**
 * Tests — platform admins on a workspace's users screens
 *
 * This suite pins how the users area of a workspace shows and protects
 * platform admins. A platform admin is at home in every live workspace,
 * but their row is not the workspace's to manage. The suite pins:
 *
 *   - `loadUsersList` lists platform admins apart, as `platformAdmins`,
 *     whichever workspace their row is stored in, and leaves them out
 *     of the workspace's people, the federation's people and the head
 *     counts; the search applies to them;
 *   - the list page shows them under the "Platform admins" heading, with
 *     no link to a detail page;
 *   - the detail loader and every detail action 404 on a platform
 *     admin stored in the workspace, so they cannot be edited, demoted
 *     or removed there;
 *   - `applyUpdateRoles` refuses to touch a platform admin;
 *   - the last-admin rule does not count a platform admin stored in the
 *     workspace, whose row has `is_admin` set, as another admin.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
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
import resources from "../../app/locales";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_FEDERATION_ID,
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
import { loadUsersList } from "../../app/lib/users-area.server";
import { applyRoleChanges } from "../../app/lib/access-changes.server";
import { applyUpdateRoles } from "../../app/routes/_auth.admin.users.$id.roles.server";
import UsersListPage, { loader as listLoader } from "../../app/routes/_auth.admin.users";
import { action as detailAction, loader as detailLoader } from "../../app/routes/_auth.admin.users.$id";

type Db = ReturnType<typeof drizzle>;
const T0 = 1_800_000_000_000;
const tenant = makeTenantContext({ crowdsourcingEnabled: true, authoritiesEnabled: true });

async function seedUser(db: Db, name: string, flags: Record<string, unknown> = {}, tenantId = DEFAULT_TEST_TENANT_ID) {
  const id = crypto.randomUUID();
  await db.insert(schema.users).values({
    id,
    tenantId,
    email: `${name.toLowerCase().replace(/\s+/g, "-")}@example.test`,
    name,
    createdAt: T0,
    updatedAt: T0,
    ...(flags as any),
  });
  return id;
}

async function makePlatformAdmin(id: string) {
  await env.DB.prepare("UPDATE users SET is_platform_admin = 1 WHERE id = ?").bind(id).run();
}

async function context(user: User): Promise<any> {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, tenant);
  ctx.set(grantContext, null);
  ctx.set(impersonationContext, null);
  (ctx as any).cloudflare = { env };
  const { i18nextMiddleware } = await import("../../app/middleware/i18next");
  await (i18nextMiddleware as any)(
    { request: new Request("http://localhost/admin/users?lang=en"), params: {}, context: ctx },
    async () => new Response(null),
  );
  return ctx;
}

const superAdmin = (id: string) =>
  makeUserContext({ id, isSuperAdmin: true, isAdmin: true, isUserManager: true });

async function status(p: Promise<unknown>): Promise<number | unknown> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof Response) return e.status;
    throw e;
  }
}

describe("platform admins on the users screens", () => {
  let db: Db;
  let adminId: string;
  let homePa: string;
  let foreignPa: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB);
    adminId = await seedUser(db, "Ana Admin", { isAdmin: true, isSuperAdmin: true });
    await seedUser(db, "Rafa Reader", { isArchiveUser: true });
    homePa = await seedUser(db, "Pia Home", { isAdmin: true });
    await makePlatformAdmin(homePa);
    foreignPa = await seedUser(db, "Pablo Foreign", {}, SECOND_TEST_TENANT_ID);
    await makePlatformAdmin(foreignPa);
    // A federation membership does not put a platform admin in the
    // federation table either.
    await db.insert(schema.federationMemberships).values({
      id: crypto.randomUUID(),
      userId: foreignPa,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      role: "staff",
      createdAt: T0,
    });
  });

  it("lists platform admins apart, out of the people, the federation's people and the counts", async () => {
    const list = await loadUsersList(db, tenant, { query: "", area: null });
    expect(list.people.map((p) => p.id)).not.toContain(homePa);
    expect(list.people.map((p) => p.id)).toContain(adminId);
    expect(list.federationPeople.map((p) => p.id)).not.toContain(foreignPa);
    expect(list.peopleCount).toBe(2);
    expect(list.federationPeopleCount).toBe(0);
    expect(list.platformAdmins.map((p) => p.id).sort()).toEqual([homePa, foreignPa].sort());
    expect(list.platformAdmins.find((p) => p.id === foreignPa)).toEqual({
      id: foreignPa,
      name: "Pablo Foreign",
      email: "pablo-foreign@example.test",
    });
  });

  it("applies the search to platform admins", async () => {
    const list = await loadUsersList(db, tenant, { query: "pablo", area: null });
    expect(list.platformAdmins.map((p) => p.id)).toEqual([foreignPa]);
  });

  it("shows them on the page under the Platform admin label, with no link", async () => {
    const loaderData = await listLoader({
      request: new Request("http://localhost/admin/users"),
      params: {},
      context: await context(superAdmin(adminId)),
    } as any);
    const inst = i18next.createInstance();
    await (inst.init as (opts: unknown) => Promise<unknown>)({
      lng: "en",
      fallbackLng: "es",
      defaultNS: "common",
      resources,
      interpolation: { escapeValue: false },
    });
    const Stub = createRoutesStub([
      {
        path: "/admin/users",
        Component: () =>
          React.createElement(UsersListPage as React.ComponentType<any>, { loaderData, params: {}, matches: [] }),
      },
    ]);
    const html = renderToStaticMarkup(
      React.createElement(I18nextProvider, { i18n: inst }, React.createElement(Stub, { initialEntries: ["/admin/users"] })),
    );
    expect(html).toContain(">Platform admins<");
    expect((resources as any).es.user_admin.platform_admin).toBe("Personas que administran la plataforma");
    expect(html).toContain("Pia Home");
    expect(html).toContain("Pablo Foreign");
    expect(html).not.toContain(`href="/admin/users/${homePa}"`);
    expect(html).not.toContain(`href="/admin/users/${foreignPa}"`);
    expect(html).toContain(`href="/admin/users/${adminId}"`);
  });

  it("404s the detail page and every detail action on a platform admin", async () => {
    const viewer = superAdmin(adminId);
    expect(
      await status(
        detailLoader({
          request: new Request(`http://localhost/admin/users/${homePa}`),
          params: { id: homePa },
          context: await context(viewer),
        } as any),
      ),
    ).toBe(404);
    const forms: Record<string, string>[] = [
      { _action: "updateRoles", shown_isAdmin: "1" },
      { _action: "updateProfile", name: "Renamed", email: "renamed@example.test" },
      { _action: "assignToProject", projectId: "p-1", role: "cataloguer" },
      { _action: "removeFromProject", membershipId: "m-1" },
    ];
    for (const fields of forms) {
      const request = new Request(`http://localhost/admin/users/${homePa}?lang=en`, {
        method: "POST",
        body: new URLSearchParams(fields),
      });
      expect(await status(detailAction({ request, params: { id: homePa }, context: await context(viewer) } as any))).toBe(404);
    }
    const row = await db.select().from(schema.users).where(eq(schema.users.id, homePa)).get();
    expect(row).toMatchObject({ name: "Pia Home", isAdmin: true });
    expect(await db.select().from(schema.auditLog).all()).toEqual([]);
  });

  it("a hidden platform admin with is_admin does not count as the workspace's other admin", async () => {
    // Ana Admin is the one visible workspace admin; Pia Home, a platform
    // admin stored here, also has is_admin = 1 on her row.
    const result = await applyRoleChanges({
      d1: env.DB,
      tenant,
      targetUserId: adminId,
      changes: [{ flag: "isAdmin", shown: true, to: false }],
      federation: null,
      actor: { user: superAdmin(adminId), homeTenantId: DEFAULT_TEST_TENANT_ID, impersonationSessionId: null },
      now: T0,
      newId: () => crypto.randomUUID(),
    });
    expect(result).toEqual({ ok: false, error: "last_workspace_admin" });
    const row = await db.select().from(schema.users).where(eq(schema.users.id, adminId)).get();
    expect(row?.isAdmin).toBe(true);
    expect(await db.select().from(schema.auditLog).all()).toEqual([]);
  });

  it("applyUpdateRoles refuses to touch a platform admin", async () => {
    const formData = new FormData();
    formData.set("shown_isAdmin", "1");
    const result = await applyUpdateRoles({
      db,
      d1: env.DB,
      tenant,
      targetUserId: homePa,
      formData,
      assignableFlags: ["isAdmin"],
      currentUser: superAdmin(adminId),
      actor: { user: superAdmin(adminId), homeTenantId: DEFAULT_TEST_TENANT_ID, impersonationSessionId: null },
      now: T0,
      newId: () => crypto.randomUUID(),
    });
    expect(result).toEqual({ ok: false, error: "role_not_assignable" });
    const row = await db.select().from(schema.users).where(eq(schema.users.id, homePa)).get();
    expect(row?.isAdmin).toBe(true);
    expect(await db.select().from(schema.auditLog).all()).toEqual([]);
  });
});

// @version v0.9.0
