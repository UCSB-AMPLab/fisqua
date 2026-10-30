/**
 * Tests — granting and revoking access on the user detail page
 *
 * This suite pins who may change which role on `/admin/users/:id`,
 * that every change lands with its `audit_log` row or not at all, and
 * what the access history then shows. It drives the real route `action`
 * and `loader` with the i18next middleware run for an English request,
 * so refusals are checked by their English text. Five parts:
 *
 *   1. Role flags by actor: a workspace admin grants and revokes each
 *      of the eight workspace roles, a steward through a grant does the
 *      same with their home workspace as the audit's actor tenant, a
 *      super admin also the two platform roles; a workspace admin's
 *      crafted platform field, an area admin, a user manager, someone
 *      changing their own roles and an operator in an impersonation
 *      session are refused, and nothing is written.
 *   2. The write: a page whose shown values are stale lands nothing
 *      (`error_roles_changed`), the last workspace admin cannot be
 *      removed, and of two concurrent demotions of the last two
 *      workspace admins only one lands.
 *   3. Federation roles: a super admin at home on the federation's lead
 *      workspace grants and revokes steward and staff, including a
 *      steward made staff; a federation steward (by lead-workspace
 *      admin or by grant) grants staff but not steward; a super admin
 *      elsewhere, a member workspace's admin and a steward of another
 *      federation are refused.
 *   4. Audit rows: actor, actor tenant, target tenant, target and
 *      details, immutable once written; project membership changes
 *      record theirs too, with the operator session id when there is
 *      one.
 *   5. The loader and the page: which federation boxes are live, and
 *      the access history as it reads, with entries of sections the
 *      viewer does not see left out, invitations by their role's
 *      section. What a role control shows and the baseline it posts
 *      move together when the loader revalidates (`reconcileShown`;
 *      the suite has no browser, so the reconciliation is pinned as
 *      the pure function the controls render through).
 *   6. A federation steward with no workspace flag: reaches the list
 *      without the invitation, and the detail page with its Federation
 *      section alone; grants and revokes staff; is refused the profile,
 *      the workspace roles and the project memberships. Federation
 *      staff reach none of it.
 *
 * Every value here is a test value: no real tenant or person.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
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
  SECOND_TEST_FEDERATION_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import {
  grantContext,
  impersonationContext,
  tenantContext,
  userContext,
  type GrantState,
  type ImpersonatingState,
  type Tenant,
  type User,
} from "../../app/context";
import { applyGrantEffectiveRole } from "../../app/lib/federation.server";
import { applyRoleChanges } from "../../app/lib/access-changes.server";
import UserDetailPage, { action, loader, reconcileShown } from "../../app/routes/_auth.admin.users.$id";
import { action as listAction, loader as listLoader } from "../../app/routes/_auth.admin.users";

type Db = ReturnType<typeof drizzle>;

const T0 = 1_800_000_000_000;

/** Every optional area on. */
const allOn = (overrides: Partial<Tenant> = {}) =>
  makeTenantContext({
    crowdsourcingEnabled: true,
    authoritiesEnabled: true,
    digitizationEnabled: true,
    importsEnabled: true,
    ...overrides,
  });

/** The default tenant served as a member of the second federation, whose lead is elsewhere. */
const asMember = () => allOn({ federationId: SECOND_TEST_FEDERATION_ID });

async function runI18nMiddleware(ctx: RouterContextProvider, request: Request): Promise<void> {
  const { i18nextMiddleware } = await import("../../app/middleware/i18next");
  await (i18nextMiddleware as any)({ request, params: {}, context: ctx }, async () => new Response(null));
}

interface Session {
  tenant?: Tenant;
  grant?: GrantState | null;
  impersonation?: ImpersonatingState | null;
}

async function context(user: User, session: Session = {}): Promise<any> {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, session.tenant ?? allOn());
  ctx.set(grantContext, session.grant ?? null);
  ctx.set(impersonationContext, session.impersonation ?? null);
  (ctx as any).cloudflare = { env };
  await runI18nMiddleware(ctx, new Request("http://localhost/admin/users/x?lang=en"));
  return ctx;
}

/** Posts `fields` to the detail action for `targetId`; a thrown Response comes back as its status. */
async function post(
  user: User,
  targetId: string,
  fields: Record<string, string>,
  session: Session = {},
): Promise<{ ok: boolean; error?: string; message?: string } | number> {
  const request = new Request(`http://localhost/admin/users/${targetId}?lang=en`, {
    method: "POST",
    body: new URLSearchParams(fields),
  });
  try {
    return (await action({ request, params: { id: targetId }, context: await context(user, session) } as any)) as any;
  } catch (e) {
    if (e instanceof Response) return e.status;
    throw e;
  }
}

/** A roles form: each flag with its shown value and its box. */
function roles(flags: Record<string, { shown: boolean; on: boolean }>): Record<string, string> {
  const out: Record<string, string> = { _action: "updateRoles" };
  for (const [flag, { shown, on }] of Object.entries(flags)) {
    out[`shown_${flag}`] = shown ? "1" : "0";
    if (on) out[flag] = "on";
  }
  return out;
}

const grantFlag = (flag: string) => roles({ [flag]: { shown: false, on: true } });
const revokeFlag = (flag: string) => roles({ [flag]: { shown: true, on: false } });

function federationForm(shown: string, to: string): Record<string, string> {
  return { _action: "updateRoles", federationRoleShown: shown, federationRole: to };
}

async function seedUser(
  db: Db,
  name: string,
  flags: Partial<typeof schema.users.$inferInsert> = {},
  tenantId: string = DEFAULT_TEST_TENANT_ID,
): Promise<User> {
  const id = crypto.randomUUID();
  const email = `${name.toLowerCase().replace(/\s+/g, "-")}-${id.slice(0, 6)}@example.test`;
  await db.insert(schema.users).values({ id, tenantId, email, name, createdAt: T0, updatedAt: T0, ...flags });
  const { createdAt: _c, updatedAt: _u, ...userFlags } = flags as Record<string, unknown>;
  return makeUserContext({ id, tenantId, email, name, ...(userFlags as Partial<User>) });
}

async function membership(db: Db, userId: string, federationId: string, role: "steward" | "staff") {
  await db.insert(schema.federationMemberships).values({
    id: crypto.randomUUID(),
    userId,
    federationId,
    role,
    createdAt: T0,
  });
}

async function readUser(db: Db, id: string) {
  return (await db.select().from(schema.users).where(eq(schema.users.id, id)).get())!;
}

async function federationRoleOf(db: Db, userId: string, federationId: string): Promise<string> {
  const row = await db
    .select({ role: schema.federationMemberships.role })
    .from(schema.federationMemberships)
    .where(
      and(
        eq(schema.federationMemberships.userId, userId),
        eq(schema.federationMemberships.federationId, federationId),
      ),
    )
    .get();
  return row?.role ?? "none";
}

const audits = (db: Db) => db.select().from(schema.auditLog).all();
const details = async (db: Db) => (await audits(db)).map((r) => [r.action, JSON.parse(r.details!)]);

const ERR = {
  changed: "Someone changed this person's access after you opened the page. Reload the page and try again.",
  lastAdmin: "This workspace needs at least one workspace admin. Make someone else workspace admin first.",
  operator: "Roles cannot be changed during an operator session.",
  notAssignable: "That request included a role you cannot grant. No roles were changed.",
  self: "You cannot change your own roles",
  onlySuper: "Only a super admin or a workspace admin can change roles.",
};

const WORKSPACE_FLAGS = [
  "isAdmin",
  "isArchiveUser",
  "isRecordsAdmin",
  "isAuthoritiesAdmin",
  "isImportsAdmin",
  "isDigitizationAdmin",
  "isCollabAdmin",
  "isCataloguer",
] as const;

const OPERATOR_SESSION: ImpersonatingState = { role: "isAdmin", sessionId: "session-op-1", lastActivityAt: T0 };

let db: Db;
let admin: User;
let target: User;

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDatabase();
  db = drizzle(env.DB);
  admin = await seedUser(db, "Ana Admin", { isAdmin: true });
  target = await seedUser(db, "Tomas Target");
});

// ---------------------------------------------------------------------------
// 1. Role flags by actor
// ---------------------------------------------------------------------------

describe("role flags by actor", () => {
  for (const flag of WORKSPACE_FLAGS) {
    it(`a workspace admin grants and revokes ${flag}, each with its audit row`, async () => {
      expect(await post(admin, target.id, grantFlag(flag))).toMatchObject({ ok: true });
      expect(!!(await readUser(db, target.id))[flag]).toBe(true);
      expect(await post(admin, target.id, revokeFlag(flag))).toMatchObject({ ok: true });
      expect(!!(await readUser(db, target.id))[flag]).toBe(false);

      const rows = await audits(db);
      expect(rows.map((r) => JSON.parse(r.details!))).toEqual([
        { flag, step: "granted" },
        { flag, step: "revoked" },
      ]);
      for (const row of rows) {
        expect(row).toMatchObject({
          action: "set_user_role",
          actorUserId: admin.id,
          actorUserIdText: admin.email,
          actorTenantId: DEFAULT_TEST_TENANT_ID,
          targetTenantId: DEFAULT_TEST_TENANT_ID,
          targetObjectKind: "user",
          targetObjectId: target.id,
          impersonationSessionId: null,
        });
      }
    });
  }

  for (const flag of ["isSuperAdmin", "isUserManager"]) {
    it(`a super admin grants and revokes ${flag}; a workspace admin's crafted post of it is refused`, async () => {
      const crafted = await post(admin, target.id, { ...grantFlag(flag), ...grantFlag("isRecordsAdmin") });
      expect(crafted).toMatchObject({ ok: false, error: ERR.notAssignable });
      expect(await audits(db)).toEqual([]);
      expect((await readUser(db, target.id)).isRecordsAdmin).toBeFalsy();

      const sup = await seedUser(db, "Sam Super", { isSuperAdmin: true });
      expect(await post(sup, target.id, grantFlag(flag))).toMatchObject({ ok: true });
      expect(!!(await readUser(db, target.id))[flag as "isSuperAdmin"]).toBe(true);
      expect(await post(sup, target.id, revokeFlag(flag))).toMatchObject({ ok: true });
      expect(!!(await readUser(db, target.id))[flag as "isSuperAdmin"]).toBe(false);
      expect((await details(db)).map(([, d]) => d.step)).toEqual(["granted", "revoked"]);
    });
  }

  it("a steward through a grant grants a workspace role, recorded against their home workspace", async () => {
    const home = await seedUser(db, "Sofia Steward", {}, SECOND_TEST_TENANT_ID);
    await membership(db, home.id, DEFAULT_TEST_FEDERATION_ID, "steward");
    const grant: GrantState = { role: "steward", federationId: DEFAULT_TEST_FEDERATION_ID, homeTenantId: SECOND_TEST_TENANT_ID };
    const steward = applyGrantEffectiveRole(home, grant);

    expect(await post(steward, target.id, grantFlag("isDigitizationAdmin"), { grant })).toMatchObject({ ok: true });
    const [row] = await audits(db);
    expect(row).toMatchObject({
      actorUserId: home.id,
      actorTenantId: SECOND_TEST_TENANT_ID,
      targetTenantId: DEFAULT_TEST_TENANT_ID,
      targetObjectId: target.id,
    });
    // ...and no platform role.
    expect(await post(steward, target.id, grantFlag("isUserManager"), { grant })).toMatchObject({
      ok: false,
      error: ERR.notAssignable,
    });
  });

  for (const flag of ["isRecordsAdmin", "isAuthoritiesAdmin", "isImportsAdmin", "isDigitizationAdmin"] as const) {
    it(`an area admin (${flag}) grants nothing: the action is refused at the gate`, async () => {
      const areaAdmin = await seedUser(db, "Ari Area", { [flag]: true });
      expect(await post(areaAdmin, target.id, grantFlag(flag))).toBe(403);
      expect((await readUser(db, target.id))[flag]).toBeFalsy();
      expect(await audits(db)).toEqual([]);
    });
  }

  it("a user manager grants nothing", async () => {
    const manager = await seedUser(db, "Uma Manager", { isUserManager: true });
    expect(await post(manager, target.id, grantFlag("isArchiveUser"))).toMatchObject({ ok: false, error: ERR.onlySuper });
    expect(await post(manager, target.id, federationForm("none", "staff"))).toMatchObject({
      ok: false,
      error: ERR.notAssignable,
    });
    expect(await audits(db)).toEqual([]);
  });

  it("nobody changes their own roles or federation role", async () => {
    const sup = await seedUser(db, "Sam Super", { isSuperAdmin: true });
    expect(await post(admin, admin.id, grantFlag("isRecordsAdmin"))).toMatchObject({ ok: false, error: ERR.self });
    expect(await post(sup, sup.id, federationForm("none", "steward"))).toMatchObject({ ok: false, error: ERR.self });
    expect(await federationRoleOf(db, sup.id, DEFAULT_TEST_FEDERATION_ID)).toBe("none");
    expect(await audits(db)).toEqual([]);
  });

  it("an operator in an impersonation session grants and revokes nothing", async () => {
    const operator = await seedUser(db, "Olga Operator", { isSuperAdmin: true });
    const session = { impersonation: OPERATOR_SESSION };
    expect(await post(operator, target.id, grantFlag("isAdmin"), session)).toMatchObject({ ok: false, error: ERR.operator });
    expect(await post(operator, target.id, federationForm("none", "steward"), session)).toMatchObject({
      ok: false,
      error: ERR.operator,
    });
    expect((await readUser(db, target.id)).isAdmin).toBeFalsy();
    expect(await federationRoleOf(db, target.id, DEFAULT_TEST_FEDERATION_ID)).toBe("none");
    expect(await audits(db)).toEqual([]);
  });

  it("a checkbox posted without its shown value is an invalid request", async () => {
    expect(await post(admin, target.id, { _action: "updateRoles", isRecordsAdmin: "on" })).toMatchObject({
      ok: false,
      error: "Invalid request",
    });
    expect((await readUser(db, target.id)).isRecordsAdmin).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// 2. The write
// ---------------------------------------------------------------------------

describe("the write", () => {
  it("lands nothing when anything the page showed has changed", async () => {
    // Someone else made the person a records admin after the page loaded.
    await db.update(schema.users).set({ isRecordsAdmin: true }).where(eq(schema.users.id, target.id));
    const res = await post(admin, target.id, {
      ...roles({
        isRecordsAdmin: { shown: false, on: true },
        isArchiveUser: { shown: false, on: true },
      }),
    });
    expect(res).toMatchObject({ ok: false, error: ERR.changed });
    expect((await readUser(db, target.id)).isArchiveUser).toBeFalsy();
    expect(await audits(db)).toEqual([]);
  });

  it("lands neither flags nor federation role when the federation role shown has changed", async () => {
    const sup = await seedUser(db, "Sam Super", { isSuperAdmin: true });
    await membership(db, target.id, DEFAULT_TEST_FEDERATION_ID, "staff");
    const res = await post(sup, target.id, {
      ...roles({ isArchiveUser: { shown: false, on: true } }),
      federationRoleShown: "none",
      federationRole: "steward",
    });
    expect(res).toMatchObject({ ok: false, error: ERR.changed });
    expect((await readUser(db, target.id)).isArchiveUser).toBeFalsy();
    expect(await federationRoleOf(db, target.id, DEFAULT_TEST_FEDERATION_ID)).toBe("staff");
    expect(await audits(db)).toEqual([]);
  });

  it("an unchanged flag that changed underneath still stops the save", async () => {
    await db.update(schema.users).set({ isCataloguer: true }).where(eq(schema.users.id, target.id));
    const res = await post(admin, target.id, {
      ...roles({
        isCataloguer: { shown: false, on: false },
        isRecordsAdmin: { shown: false, on: true },
      }),
    });
    expect(res).toMatchObject({ ok: false, error: ERR.changed });
    expect((await readUser(db, target.id)).isRecordsAdmin).toBeFalsy();
  });

  it("refuses to remove the last workspace admin", async () => {
    const sup = await seedUser(db, "Sam Super", { isSuperAdmin: true });
    // Ana is the only workspace admin.
    expect(await post(sup, admin.id, revokeFlag("isAdmin"))).toMatchObject({ ok: false, error: ERR.lastAdmin });
    expect((await readUser(db, admin.id)).isAdmin).toBeTruthy();
    expect(await audits(db)).toEqual([]);
    // With another workspace admin, the same save lands.
    await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, target.id));
    expect(await post(sup, admin.id, revokeFlag("isAdmin"))).toMatchObject({ ok: true });
    expect((await readUser(db, admin.id)).isAdmin).toBeFalsy();
  });

  it("of two concurrent demotions of the last two workspace admins, only one lands", async () => {
    const sup = await seedUser(db, "Sam Super", { isSuperAdmin: true });
    const other = await seedUser(db, "Otto Other", { isAdmin: true });
    const actor = { user: sup, homeTenantId: DEFAULT_TEST_TENANT_ID, impersonationSessionId: null };
    const demote = (id: string) =>
      applyRoleChanges({
        d1: env.DB,
        tenant: { id: DEFAULT_TEST_TENANT_ID, federationId: DEFAULT_TEST_FEDERATION_ID },
        targetUserId: id,
        changes: [{ flag: "isAdmin", shown: true, to: false }],
        federation: null,
        actor,
        now: T0,
        newId: () => crypto.randomUUID(),
      });
    // Both read "another admin exists" before either writes.
    const results = await Promise.all([demote(admin.id), demote(other.id)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: "last_workspace_admin" }]);
    const admins = (await db.select().from(schema.users).all()).filter((u) => u.isAdmin);
    expect(admins).toHaveLength(1);
    expect(await audits(db)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Federation roles
// ---------------------------------------------------------------------------

describe("federation roles", () => {
  it("a super admin at home on the lead workspace grants steward, makes them staff, and revokes staff", async () => {
    const sup = await seedUser(db, "Sam Super", { isSuperAdmin: true });
    expect(await post(sup, target.id, federationForm("none", "steward"))).toMatchObject({ ok: true });
    expect(await federationRoleOf(db, target.id, DEFAULT_TEST_FEDERATION_ID)).toBe("steward");
    expect(await post(sup, target.id, federationForm("steward", "staff"))).toMatchObject({ ok: true });
    expect(await federationRoleOf(db, target.id, DEFAULT_TEST_FEDERATION_ID)).toBe("staff");
    expect(await post(sup, target.id, federationForm("staff", "none"))).toMatchObject({ ok: true });
    expect(await federationRoleOf(db, target.id, DEFAULT_TEST_FEDERATION_ID)).toBe("none");

    expect(await details(db)).toEqual([
      ["set_federation_role", { federation_id: DEFAULT_TEST_FEDERATION_ID, from: "none", to: "steward" }],
      ["set_federation_role", { federation_id: DEFAULT_TEST_FEDERATION_ID, from: "steward", to: "staff" }],
      ["set_federation_role", { federation_id: DEFAULT_TEST_FEDERATION_ID, from: "staff", to: "none" }],
    ]);
    for (const row of await audits(db)) {
      expect(row).toMatchObject({ actorTenantId: DEFAULT_TEST_TENANT_ID, targetTenantId: DEFAULT_TEST_TENANT_ID, targetObjectId: target.id });
    }
  });

  it("a super admin of a workspace that does not lead the federation grants neither role", async () => {
    // The default tenant served as a member of the second federation.
    const sup = await seedUser(db, "Sam Super", { isSuperAdmin: true });
    const session = { tenant: asMember() };
    expect(await post(sup, target.id, federationForm("none", "steward"), session)).toMatchObject({
      ok: false,
      error: ERR.notAssignable,
    });
    expect(await post(sup, target.id, federationForm("none", "staff"), session)).toMatchObject({
      ok: false,
      error: ERR.notAssignable,
    });
    expect(await federationRoleOf(db, target.id, SECOND_TEST_FEDERATION_ID)).toBe("none");
  });

  it("a super admin homed elsewhere grants no steward on the lead workspace", async () => {
    const outsider = await seedUser(db, "Sam Elsewhere", { isSuperAdmin: true }, SECOND_TEST_TENANT_ID);
    expect(await post(outsider, target.id, federationForm("none", "steward"))).toMatchObject({
      ok: false,
      error: ERR.notAssignable,
    });
    expect(await audits(db)).toEqual([]);
  });

  it("the lead workspace's admin, a federation steward, grants and revokes staff but not steward", async () => {
    expect(await post(admin, target.id, federationForm("none", "staff"))).toMatchObject({ ok: true });
    expect(await federationRoleOf(db, target.id, DEFAULT_TEST_FEDERATION_ID)).toBe("staff");
    expect(await post(admin, target.id, federationForm("staff", "steward"))).toMatchObject({
      ok: false,
      error: ERR.notAssignable,
    });
    expect(await post(admin, target.id, federationForm("staff", "none"))).toMatchObject({ ok: true });
    expect(await federationRoleOf(db, target.id, DEFAULT_TEST_FEDERATION_ID)).toBe("none");
  });

  it("making a steward staff is a steward revoke, refused to a federation steward", async () => {
    await membership(db, target.id, DEFAULT_TEST_FEDERATION_ID, "steward");
    expect(await post(admin, target.id, federationForm("steward", "staff"))).toMatchObject({
      ok: false,
      error: ERR.notAssignable,
    });
    expect(await post(admin, target.id, federationForm("steward", "none"))).toMatchObject({
      ok: false,
      error: ERR.notAssignable,
    });
    expect(await federationRoleOf(db, target.id, DEFAULT_TEST_FEDERATION_ID)).toBe("steward");
  });

  it("a steward through a grant grants staff in a member workspace", async () => {
    const home = await seedUser(db, "Sofia Steward", {}, SECOND_TEST_TENANT_ID);
    await membership(db, home.id, DEFAULT_TEST_FEDERATION_ID, "steward");
    const grant: GrantState = { role: "steward", federationId: DEFAULT_TEST_FEDERATION_ID, homeTenantId: SECOND_TEST_TENANT_ID };
    const steward = applyGrantEffectiveRole(home, grant);
    expect(await post(steward, target.id, federationForm("none", "staff"), { grant })).toMatchObject({ ok: true });
    expect(await post(steward, target.id, federationForm("staff", "steward"), { grant })).toMatchObject({
      ok: false,
      error: ERR.notAssignable,
    });
    const [row] = await audits(db);
    expect(row).toMatchObject({ actorTenantId: SECOND_TEST_TENANT_ID, targetTenantId: DEFAULT_TEST_TENANT_ID });
  });

  it("a member workspace's admin, who is no steward, grants no staff", async () => {
    expect(await post(admin, target.id, federationForm("none", "staff"), { tenant: asMember() })).toMatchObject({
      ok: false,
      error: ERR.notAssignable,
    });
    expect(await federationRoleOf(db, target.id, SECOND_TEST_FEDERATION_ID)).toBe("none");
  });

  it("a steward of another federation grants no staff in this one", async () => {
    const otherSteward = await seedUser(db, "Olivia Other", { isUserManager: true });
    await membership(db, otherSteward.id, SECOND_TEST_FEDERATION_ID, "steward");
    expect(await post(otherSteward, target.id, federationForm("none", "staff"))).toMatchObject({
      ok: false,
      error: ERR.notAssignable,
    });
    expect(await federationRoleOf(db, target.id, DEFAULT_TEST_FEDERATION_ID)).toBe("none");
  });

  it("refuses a federation role outside none, staff and steward", async () => {
    const sup = await seedUser(db, "Sam Super", { isSuperAdmin: true });
    expect(await post(sup, target.id, federationForm("none", "owner"))).toMatchObject({ ok: false, error: "Invalid request" });
  });
});

// ---------------------------------------------------------------------------
// 4. Audit rows
// ---------------------------------------------------------------------------

describe("audit rows", () => {
  it("cannot be changed or deleted once written", async () => {
    await post(admin, target.id, grantFlag("isRecordsAdmin"));
    const [row] = await audits(db);
    await expect(
      env.DB.prepare("UPDATE audit_log SET details = ? WHERE id = ?").bind("{}", row.id).run(),
    ).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("DELETE FROM audit_log WHERE id = ?").bind(row.id).run()).rejects.toThrow(/immutable/);
  });

  it("records project memberships added, re-roled and removed, with the operator session when there is one", async () => {
    const projectId = crypto.randomUUID();
    await db.insert(schema.projects).values({
      id: projectId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      name: "Project Alpha",
      createdBy: admin.id,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(await post(admin, target.id, { _action: "assignToProject", projectId, role: "cataloguer" })).toMatchObject({ ok: true });
    const [member] = await db.select().from(schema.projectMembers).all();
    expect(
      await post(
        admin,
        target.id,
        { _action: "changeRole", membershipId: member.id, shown_role: "cataloguer", role: "lead" },
        { impersonation: OPERATOR_SESSION },
      ),
    ).toMatchObject({ ok: true });
    // A change from a page that still showed cataloguer lands nothing:
    // it would overwrite the lead role set meanwhile.
    expect(
      await post(admin, target.id, { _action: "changeRole", membershipId: member.id, shown_role: "cataloguer", role: "reviewer" }),
    ).toMatchObject({ ok: false, error: ERR.changed });
    expect((await db.select().from(schema.projectMembers).all())[0].role).toBe("lead");
    // A removal on a page that still showed cataloguer lands nothing.
    expect(
      await post(admin, target.id, { _action: "removeFromProject", membershipId: member.id, shown_role: "cataloguer" }),
    ).toMatchObject({ ok: false, error: ERR.changed });
    expect(await db.select().from(schema.projectMembers).all()).toHaveLength(1);
    expect(
      await post(admin, target.id, { _action: "removeFromProject", membershipId: member.id, shown_role: "lead" }),
    ).toMatchObject({ ok: true });
    expect(await db.select().from(schema.projectMembers).all()).toEqual([]);

    const rows = await audits(db);
    expect(rows.map((r) => [r.action, JSON.parse(r.details!), r.impersonationSessionId])).toEqual([
      ["set_project_membership", { project_id: projectId, step: "added", role: "cataloguer" }, null],
      ["set_project_membership", { project_id: projectId, step: "changed", role: "lead" }, OPERATOR_SESSION.sessionId],
      ["set_project_membership", { project_id: projectId, step: "removed", role: "lead" }, null],
    ]);
    for (const row of rows) expect(row).toMatchObject({ targetObjectKind: "user", targetObjectId: target.id });
  });
});

// ---------------------------------------------------------------------------
// 5. The loader and the page
// ---------------------------------------------------------------------------

async function load(user: User, targetId: string, session: Session = {}) {
  return (await loader({
    request: new Request(`http://localhost/admin/users/${targetId}`),
    params: { id: targetId },
    context: await context(user, session),
  } as any)) as any;
}

async function render(loaderData: unknown, targetId: string): Promise<string> {
  const inst = i18next.createInstance();
  await (inst.init as (opts: unknown) => Promise<unknown>)({
    lng: "en",
    fallbackLng: "es",
    defaultNS: "common",
    resources,
    interpolation: { escapeValue: false },
  });
  const path = `/admin/users/${targetId}`;
  const Stub = createRoutesStub([
    {
      path,
      Component: () =>
        React.createElement(UserDetailPage as React.ComponentType<any>, { loaderData, params: { id: targetId }, matches: [] }),
    },
  ]);
  return renderToStaticMarkup(
    React.createElement(I18nextProvider, { i18n: inst }, React.createElement(Stub, { initialEntries: [path] })),
  );
}

describe("the loader and the page", () => {
  it("offers both federation roles to the lead's super admin, staff to its admin, neither during an operator session", async () => {
    const sup = await seedUser(db, "Sam Super", { isSuperAdmin: true });
    expect((await load(sup, target.id)).federationEditable).toEqual({ steward: true, staff: true });
    expect((await load(admin, target.id)).federationEditable).toEqual({ steward: false, staff: true });
    const operator = await load(sup, target.id, { impersonation: OPERATOR_SESSION });
    expect(operator.operatorSession).toBe(true);
    const html = await render(operator, target.id);
    expect(html).toContain(ERR.operator);
    expect(html).not.toContain('name="federationRole"');
    expect(html).not.toMatch(/name="shown_/);
  });

  it("explains a locked steward box to the lead's admin, and posts the federation role", async () => {
    const html = await render(await load(admin, target.id), target.id);
    expect(html).toContain('title="Only a super admin of the federation&#x27;s lead workspace can grant this role"');
    expect(html).toContain('name="federationRole" value="none"');
    expect(html).toContain("You can grant the roles for this workspace.");
  });

  it("explains a locked staff box to a member workspace's super admin", async () => {
    const sup = await seedUser(db, "Sam Super", { isSuperAdmin: true });
    const html = await render(await load(sup, target.id, { tenant: asMember() }), target.id);
    expect(html).toContain('title="Only a federation steward can grant this role"');
    expect(html).not.toContain('name="federationRole"');
  });

  it("shows the access history with who made each change, newest first", async () => {
    const sup = await seedUser(db, "Sam Super", { isSuperAdmin: true });
    const projectId = crypto.randomUUID();
    await db.insert(schema.projects).values({
      id: projectId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      name: "Project Alpha",
      createdBy: admin.id,
      createdAt: T0,
      updatedAt: T0,
    });
    // The invitation, before every change below.
    await db.insert(schema.auditLog).values({
      id: crypto.randomUUID(),
      createdAt: 1_000,
      actorUserId: admin.id,
      actorUserIdText: admin.email,
      actorTenantId: DEFAULT_TEST_TENANT_ID,
      action: "invite_user",
      targetTenantId: DEFAULT_TEST_TENANT_ID,
      targetObjectKind: "user",
      targetObjectId: target.id,
      impersonationSessionId: null,
      details: JSON.stringify({ role: "archive_user" }),
    });
    await post(admin, target.id, grantFlag("isRecordsAdmin"));
    await post(admin, target.id, revokeFlag("isRecordsAdmin"));
    await post(sup, target.id, federationForm("none", "steward"));
    await post(sup, target.id, federationForm("steward", "none"));
    await post(admin, target.id, { _action: "assignToProject", projectId, role: "reviewer" });
    const [member] = await db.select().from(schema.projectMembers).all();
    await post(admin, target.id, { _action: "changeRole", membershipId: member.id, shown_role: "reviewer", role: "lead" });
    await post(admin, target.id, { _action: "removeFromProject", membershipId: member.id, shown_role: "lead" });

    const data = await load(sup, target.id);
    expect(data.history.map((e: { kind: string }) => e.kind).sort()).toEqual(
      [
        "invited",
        "role_granted",
        "role_revoked",
        "federation_granted",
        "federation_revoked",
        "project_added",
        "project_changed",
        "project_removed",
      ].sort(),
    );
    expect(data.history.at(-1).kind).toBe("invited");

    const html = await render(data, target.id);
    for (const line of [
      "Invited as Reader by Ana Admin",
      "Records admin granted by Ana Admin",
      "Records admin revoked by Ana Admin",
      "Federation Steward granted by Sam Super",
      "Federation Steward revoked by Sam Super",
      "Added to Project Alpha as Reviewer by Ana Admin",
      "Role in Project Alpha changed to Lead by Ana Admin",
      "Removed from Project Alpha by Ana Admin",
    ]) {
      expect(html).toContain(line);
    }
  });

  it("leaves out history of sections the viewer does not see", async () => {
    const sup = await seedUser(db, "Sam Super", { isSuperAdmin: true });
    await post(sup, target.id, federationForm("none", "staff"));
    await post(sup, target.id, grantFlag("isUserManager"));
    await post(sup, target.id, grantFlag("isRecordsAdmin"));
    // A workspace admin of the member workspace sees neither Platform
    // nor Federation.
    const kinds = (await load(admin, target.id, { tenant: asMember() })).history.map(
      (e: { kind: string; role?: string }) => `${e.kind}:${e.role}`,
    );
    expect(kinds).toEqual(["role_granted:records_admin"]);
  });
});

// ---------------------------------------------------------------------------
// 5b. Revalidation and the invitation's section
// ---------------------------------------------------------------------------

describe("role controls across a revalidation", () => {
  it("keeps the viewer's unsaved choice while the loader gives the same value", () => {
    const edited = { shown: "none", value: "staff" };
    expect(reconcileShown(edited, "none")).toBe(edited);
    const box = { shown: false, value: true };
    expect(reconcileShown(box, false)).toBe(box);
  });

  it("drops the choice and moves the baseline when someone else changed the role", () => {
    // The page showed staff; the viewer left it on; another admin
    // revoked it, and the loader revalidated with none.
    expect(reconcileShown({ shown: "staff", value: "staff" }, "none")).toEqual({ shown: "none", value: "none" });
    // A flag the viewer had checked, granted meanwhile by someone else:
    // shown and posted as granted, not re-granted over the new state.
    expect(reconcileShown({ shown: false, value: true }, true)).toEqual({ shown: true, value: true });
    expect(reconcileShown({ shown: true, value: false }, false)).toEqual({ shown: false, value: false });
  });

  it("renders each control from the loader's value, with the same value as its baseline", async () => {
    await membership(db, target.id, DEFAULT_TEST_FEDERATION_ID, "staff");
    await db.update(schema.users).set({ isRecordsAdmin: true }).where(eq(schema.users.id, target.id));
    const sup = await seedUser(db, "Sam Super", { isSuperAdmin: true });
    const html = await render(await load(sup, target.id), target.id);
    const box = (html.match(/<input type="checkbox"[^>]*name="isRecordsAdmin"[^>]*>/) ?? [""])[0];
    expect(box).toContain('checked=""');
    expect(html).toContain('name="shown_isRecordsAdmin" value="1"');
    expect(html).toContain('name="federationRole" value="staff"');
    expect(html).toContain('name="federationRoleShown" value="staff"');
  });
});

describe("invitations in the access history", () => {
  it("shows an invitation with the section of its role, and one with no role to everyone", async () => {
    for (const [role, at] of [
      ["records_admin", 1_000],
      ["none", 2_000],
    ] as const) {
      await db.insert(schema.auditLog).values({
        id: crypto.randomUUID(),
        createdAt: at,
        actorUserId: admin.id,
        actorUserIdText: admin.email,
        actorTenantId: DEFAULT_TEST_TENANT_ID,
        action: "invite_user",
        targetTenantId: DEFAULT_TEST_TENANT_ID,
        targetObjectKind: "user",
        targetObjectId: target.id,
        impersonationSessionId: null,
        details: JSON.stringify({ role }),
      });
    }
    // A user manager sees Platform and Cataloguing, not Records.
    const manager = await seedUser(db, "Uma Manager", { isUserManager: true });
    expect((await load(manager, target.id)).history.map((e: { kind: string }) => e.kind)).toEqual(["invited_no_role"]);
    // A workspace admin sees Records.
    expect((await load(admin, target.id)).history.map((e: { kind: string }) => e.kind)).toEqual([
      "invited_no_role",
      "invited",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6. A federation steward with no workspace flag
// ---------------------------------------------------------------------------

describe("a federation steward with no workspace flag", () => {
  let steward: User;

  beforeEach(async () => {
    steward = await seedUser(db, "Sofia Steward");
    await membership(db, steward.id, DEFAULT_TEST_FEDERATION_ID, "steward");
  });

  async function list(user: User) {
    try {
      return await listLoader({
        request: new Request("http://localhost/admin/users"),
        params: {},
        context: await context(user),
      } as any);
    } catch (e) {
      if (e instanceof Response) return e.status;
      throw e;
    }
  }

  it("reaches the list without the invitation, and cannot invite", async () => {
    const data = (await list(steward)) as any;
    expect(data.canInvite).toBe(false);
    expect(data.people.map((p: { id: string }) => p.id)).toContain(target.id);
    const request = new Request("http://localhost/admin/users", {
      method: "POST",
      body: new URLSearchParams({ _action: "inviteUser", email: "someone@example.test" }),
    });
    await expect(listAction({ request, params: {}, context: await context(steward) } as any)).rejects.toMatchObject({
      status: 403,
    });
    expect(await audits(db)).toEqual([]);
  });

  it("reaches the detail page with the Federation section alone, and no profile form", async () => {
    const data = await load(steward, target.id);
    expect(data.sections).toEqual(["federation"]);
    expect(data.canManageUser).toBe(false);
    expect(data.federationEditable).toEqual({ steward: false, staff: true });
    expect(data.memberships).toEqual([]);
    const html = await render(data, target.id);
    expect(html).not.toContain('id="section-profile"');
    expect(html).not.toContain('name="email"');
    expect(html).toContain('name="federationRole" value="none"');
    expect(html).not.toContain("Only a super admin or a workspace admin can change roles.");
  });

  it("grants and revokes staff, recorded against their home workspace", async () => {
    expect(await post(steward, target.id, federationForm("none", "staff"))).toMatchObject({ ok: true });
    expect(await federationRoleOf(db, target.id, DEFAULT_TEST_FEDERATION_ID)).toBe("staff");
    expect(await post(steward, target.id, federationForm("staff", "none"))).toMatchObject({ ok: true });
    expect(await post(steward, target.id, federationForm("none", "steward"))).toMatchObject({
      ok: false,
      error: ERR.notAssignable,
    });
    const rows = await audits(db);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ actorUserId: steward.id, actorTenantId: DEFAULT_TEST_TENANT_ID });
  });

  it("is refused the profile, the workspace roles and the project memberships", async () => {
    const projectId = crypto.randomUUID();
    await db.insert(schema.projects).values({
      id: projectId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      name: "Project Alpha",
      createdBy: admin.id,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(await post(steward, target.id, { _action: "updateProfile", name: "Renamed", email: target.email })).toBe(403);
    expect(await post(steward, target.id, { _action: "assignToProject", projectId, role: "lead" })).toBe(403);
    expect(await post(steward, target.id, grantFlag("isRecordsAdmin"))).toMatchObject({
      ok: false,
      error: ERR.onlySuper,
    });
    expect(
      await post(steward, target.id, { ...grantFlag("isRecordsAdmin"), ...federationForm("none", "staff") }),
    ).toMatchObject({ ok: false, error: ERR.notAssignable });
    const after = await readUser(db, target.id);
    expect(after.name).toBe("Tomas Target");
    expect(after.isRecordsAdmin).toBeFalsy();
    expect(await federationRoleOf(db, target.id, DEFAULT_TEST_FEDERATION_ID)).toBe("none");
    expect(await db.select().from(schema.projectMembers).all()).toEqual([]);
    expect(await audits(db)).toEqual([]);
  });

  it("leaves federation staff with no workspace flag outside the users area", async () => {
    const staff = await seedUser(db, "Fede Staff");
    await membership(db, staff.id, DEFAULT_TEST_FEDERATION_ID, "staff");
    expect(await list(staff)).toBe(403);
    await expect(load(staff, target.id)).rejects.toMatchObject({ status: 403 });
    expect(await post(staff, target.id, federationForm("none", "staff"))).toBe(403);
  });
});

// @version v0.8.0
