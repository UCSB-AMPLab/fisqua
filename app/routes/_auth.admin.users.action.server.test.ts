/**
 * Tests for the User Admin Invite Action
 *
 * This module unit-tests `handleUsersAction`, the handler behind the
 * invite form on /admin/users, in
 * `_auth.admin.users.action.server.ts`. Calling it directly exercises
 * the logic without standing up a full React Router request, which
 * keeps the suite fast and lets us assert on the i18n key strings
 * rather than on rendered DOM.
 *
 * Each test seeds a fresh D1 with `applyMigrations` + `cleanDatabase`,
 * builds a `User` fixture via `makeUser`, and asserts the mutation
 * effect (DB row state after the call). Tenant scope is held flat on
 * `NEOGRANADINA_TENANT_ID`.
 *
 * The flag toggles are not actions of this handler: a body naming
 * `toggleAdmin` or `toggleCollabAdmin` is refused as unknown and
 * changes nothing. The invite cases cover the opening-role choice: a
 * workspace admin can send someone in with any of the six workspace
 * roles and they get exactly that flag and no other, `records_admin`
 * being the records area's admin; an area's admin is refused as
 * `invalid_role` where the workspace does not have the area; a
 * platform role is refused at invite time whoever asks for it; an
 * `isCollabAdmin` field is refused with a 403 for anyone but a super
 * admin, tenant admins included; and an inviter who is not a tenant
 * admin cannot give away a tenant role either. A sent invitation leaves
 * one `invite_user` audit row naming the inviter's home workspace, the
 * workspace and the new person; a failed one leaves none. During an
 * operator session an invitation carries no role.
 *
 * @version v0.8.0
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { applyMigrations, cleanDatabase } from "../../tests/helpers/db";
import { handleUsersAction } from "./_auth.admin.users.action.server";
import { NEOGRANADINA_TENANT_ID } from "../lib/tenant";
import { SECOND_TEST_TENANT_ID } from "../../tests/helpers/db";
import type { User } from "../context";

// A tiny i18n stub — just echoes the key so tests can assert on it.
const i18n = { t: (key: string) => key };

/** The request tenant, with every optional area on. */
const TENANT = {
  id: NEOGRANADINA_TENANT_ID,
  authoritiesEnabled: true,
  digitizationEnabled: true,
  importsEnabled: true,
};

/** The inviter at home, outside any operator session. */
const ACTOR = { homeTenantId: NEOGRANADINA_TENANT_ID, impersonationSessionId: null };

const sent = { sendInvite: async () => ({ success: true }) };

function invitedRow(db: ReturnType<typeof drizzle>, email: string) {
  return db.select().from(schema.users).where(eq(schema.users.email, email)).get();
}

function auditRows(db: ReturnType<typeof drizzle>) {
  return db.select().from(schema.auditLog).all();
}

/** The inviter's id: a row seeded before each case, as an audit row names its actor by a foreign key. */
const INVITER_ID = "00000000-0000-4000-8000-0000000000b1";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: overrides.id ?? INVITER_ID,
    tenantId: overrides.tenantId ?? NEOGRANADINA_TENANT_ID,
    email: overrides.email ?? "u@example.com",
    name: overrides.name ?? null,
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
    lastActiveAt: null,
    githubId: null,
    ...overrides,
  };
}

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

describe("user admin invite action", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    const now = Date.now();
    await drizzle(env.DB).insert(schema.users).values({
      tenantId: NEOGRANADINA_TENANT_ID,
      id: INVITER_ID,
      email: "inviter-row@example.com",
      createdAt: now,
      updatedAt: now,
    });
  });

  // The per-row flag toggles are not actions of this handler. A body
  // naming one is refused as unknown and changes nothing, whoever sends
  // it -- a tenant admin who reaches the cataloguing surface included.
  for (const intent of ["toggleAdmin", "toggleCollabAdmin"]) {
    it(`refuses ${intent} as an unknown action and leaves the flags alone`, async () => {
      const db = drizzle(env.DB);
      const tenantAdmin = makeUser({ isAdmin: true });
      const now = Date.now();
      const targetId = crypto.randomUUID();
      await db.insert(schema.users).values({
        tenantId: NEOGRANADINA_TENANT_ID,
        id: targetId,
        email: `target-${intent}@example.com`,
        isAdmin: false,
        isCollabAdmin: false,
        createdAt: now,
        updatedAt: now,
      });

      const result = await handleUsersAction(
        tenantAdmin,
        TENANT,
        db,
        fd({ _action: intent, userId: targetId }),
        env,
        i18n,
        "http://localhost",
        ACTOR
      );
      expect(result).toEqual({ ok: false, error: "admin:error.unknown_action" });

      const row = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, targetId))
        .get();
      expect(row!.isAdmin).toBeFalsy();
      expect(row!.isCollabAdmin).toBeFalsy();
    });
  }

  for (const [label, flags] of [
    ["a tenant admin", { isAdmin: true }],
    ["a collab admin", { isCollabAdmin: true }],
    ["a super admin", { isSuperAdmin: true }],
  ] as const) {
    it(`inviteUser with an isCollabAdmin field is an invalid role, even from ${label}`, async () => {
      const db = drizzle(env.DB);
      const email = `collab-${label.replace(/\s+/g, "-")}@example.com`;
      const result = await handleUsersAction(
        makeUser(flags),
        TENANT,
        db,
        fd({ _action: "inviteUser", email, role: "none", isCollabAdmin: "on" }),
        env,
        i18n,
        "http://localhost",
        ACTOR,
        sent,
      );
      expect(result).toEqual({ ok: false, error: "admin:error.invalid_role" });
      expect(await invitedRow(db, email)).toBeFalsy();
      expect(await auditRows(db)).toEqual([]);
    });
  }

  it("inviteUser with email+name only creates user row and calls sender", async () => {
    const db = drizzle(env.DB);
    const collabAdmin = makeUser({ isCollabAdmin: true });
    let senderCalled = false;

    const result = await handleUsersAction(
      collabAdmin,
      TENANT,
      db,
      fd({
        _action: "inviteUser",
        email: "invitee@example.com",
        name: "Invitee",
      }),
      env,
      i18n,
      "http://localhost",
      ACTOR,
      {
        sendInvite: async () => {
          senderCalled = true;
          return { success: true };
        },
      }
    );

    expect(result.ok).toBe(true);
    expect(senderCalled).toBe(true);

    const row = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "invitee@example.com"))
      .get();
    expect(row).toBeTruthy();
    expect(row!.isCollabAdmin).toBeFalsy();
    expect(row!.isAdmin).toBeFalsy();
    expect(row!.name).toBe("Invitee");
  });

  it("inviteUser duplicate email returns error, no duplicate row", async () => {
    const db = drizzle(env.DB);
    const collabAdmin = makeUser({ isCollabAdmin: true });
    const now = Date.now();
    await db.insert(schema.users).values({
      tenantId: NEOGRANADINA_TENANT_ID,
      id: crypto.randomUUID(),
      email: "dup@example.com",
      isAdmin: false,
      createdAt: now,
      updatedAt: now,
    });

    const result = await handleUsersAction(
      collabAdmin,
      TENANT,
      db,
      fd({
        _action: "inviteUser",
        email: "dup@example.com",
      }),
      env,
      i18n,
      "http://localhost",
      ACTOR,
      {
        sendInvite: async () => ({ success: true }),
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/duplicate/);

    const rows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "dup@example.com"))
      .all();
    expect(rows.length).toBe(1);
  });

  it("inviteUser with role=workspace_admin as a tenant admin creates the user with exactly that flag", async () => {
    const db = drizzle(env.DB);
    // A tenant admin — the shape a federation steward's effective
    // member-tenant flags take. Also collab admin so the calling
    // route's own gate would admit them.
    const inviter = makeUser({ isAdmin: true, isCollabAdmin: true });

    const result = await handleUsersAction(
      inviter,
      TENANT,
      db,
      fd({
        _action: "inviteUser",
        email: "records@example.com",
        name: "Records",
        role: "workspace_admin",
      }),
      env,
      i18n,
      "http://localhost",
      ACTOR,
      { sendInvite: async () => ({ success: true }) }
    );

    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "records@example.com"))
      .get();
    expect(row!.isAdmin).toBeTruthy();
    // Exactly that flag: nothing else came along with it.
    expect(row!.isArchiveUser).toBeFalsy();
    expect(row!.isSuperAdmin).toBeFalsy();
    expect(row!.isUserManager).toBeFalsy();
    expect(row!.isCollabAdmin).toBeFalsy();
  });

  it("inviteUser with role=archive_user creates a read-only account", async () => {
    const db = drizzle(env.DB);
    const inviter = makeUser({ isAdmin: true, isCollabAdmin: true });

    const result = await handleUsersAction(
      inviter,
      TENANT,
      db,
      fd({
        _action: "inviteUser",
        email: "reader@example.com",
        role: "archive_user",
      }),
      env,
      i18n,
      "http://localhost",
      ACTOR,
      { sendInvite: async () => ({ success: true }) }
    );

    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "reader@example.com"))
      .get();
    expect(row!.isArchiveUser).toBeTruthy();
    expect(row!.isAdmin).toBeFalsy();
  });

  it("inviteUser offering a platform role is refused and creates nothing", async () => {
    const db = drizzle(env.DB);
    const inviter = makeUser({ isAdmin: true, isCollabAdmin: true });

    for (const role of ["super_admin", "user_manager", "isSuperAdmin"]) {
      const result = await handleUsersAction(
        inviter,
        TENANT,
        db,
        fd({
          _action: "inviteUser",
          email: `escalate-${role}@example.com`,
          role,
        }),
        env,
        i18n,
        "http://localhost",
        ACTOR,
        { sendInvite: async () => ({ success: true }) }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/role/);

      const row = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, `escalate-${role}@example.com`))
        .get();
      expect(row).toBeFalsy();
    }
  });

  it("inviteUser with a tenant role as a collab admin who is not a tenant admin is refused", async () => {
    const db = drizzle(env.DB);
    // Collab admin only: not a tenant admin, so has no tenant roles to
    // give away. The route does not admit them either; this pins the
    // handler's own bound.
    const inviter = makeUser({ isCollabAdmin: true });

    const result = await handleUsersAction(
      inviter,
      TENANT,
      db,
      fd({
        _action: "inviteUser",
        email: "nope@example.com",
        role: "records_admin",
      }),
      env,
      i18n,
      "http://localhost",
      ACTOR,
      { sendInvite: async () => ({ success: true }) }
    );

    expect(result.ok).toBe(false);

    const row = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "nope@example.com"))
      .get();
    expect(row).toBeFalsy();
  });

  it("inviteUser rolls back user row when email sender fails", async () => {
    const db = drizzle(env.DB);
    const collabAdmin = makeUser({ isCollabAdmin: true });

    const result = await handleUsersAction(
      collabAdmin,
      TENANT,
      db,
      fd({
        _action: "inviteUser",
        email: "fail@example.com",
      }),
      env,
      i18n,
      "http://localhost",
      ACTOR,
      {
        sendInvite: async () => ({ error: "resend down" }),
      }
    );

    expect(result.ok).toBe(false);

    const row = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "fail@example.com"))
      .get();
    expect(row).toBeFalsy();
  });

  const FLAG_OF: Array<[string, keyof typeof schema.users.$inferSelect]> = [
    ["workspace_admin", "isAdmin"],
    ["records_admin", "isRecordsAdmin"],
    ["authorities_admin", "isAuthoritiesAdmin"],
    ["digitization_admin", "isDigitizationAdmin"],
    ["imports_admin", "isImportsAdmin"],
    ["archive_user", "isArchiveUser"],
  ];
  const ALL_FLAGS = [
    "isAdmin",
    "isSuperAdmin",
    "isUserManager",
    "isCollabAdmin",
    "isCataloguer",
    "isArchiveUser",
    "isRecordsAdmin",
    "isAuthoritiesAdmin",
    "isImportsAdmin",
    "isDigitizationAdmin",
  ] as const;

  for (const [value, flag] of FLAG_OF) {
    it(`inviteUser with role=${value} gives ${flag} and no other flag, and records the invitation`, async () => {
      const db = drizzle(env.DB);
      const inviter = makeUser({ isAdmin: true, email: "inviter@example.com" });
      const email = `${value}@example.com`;
      const result = await handleUsersAction(
        inviter,
        TENANT,
        db,
        fd({ _action: "inviteUser", email, role: value }),
        env,
        i18n,
        "http://localhost",
        { homeTenantId: SECOND_TEST_TENANT_ID, impersonationSessionId: null },
        sent,
      );
      expect(result.ok).toBe(true);
      const row = await invitedRow(db, email);
      for (const f of ALL_FLAGS) expect(!!row![f]).toBe(f === flag);

      // The invitation, and the grant of its role with its own row.
      const rows = await auditRows(db);
      expect(rows.map((r) => r.action).sort()).toEqual(["invite_user", "set_user_role"]);
      const invite = rows.find((r) => r.action === "invite_user")!;
      const grant = rows.find((r) => r.action === "set_user_role")!;
      expect(JSON.parse(grant.details!)).toEqual({ flag, step: "granted" });
      expect(grant).toMatchObject({ actorTenantId: SECOND_TEST_TENANT_ID, targetObjectId: row!.id });
      expect(invite).toMatchObject({
        action: "invite_user",
        actorUserId: inviter.id,
        actorUserIdText: "inviter@example.com",
        actorTenantId: SECOND_TEST_TENANT_ID,
        targetTenantId: NEOGRANADINA_TENANT_ID,
        targetObjectKind: "user",
        targetObjectId: row!.id,
        impersonationSessionId: null,
      });
      expect(JSON.parse(invite.details!)).toEqual({ role: value });
    });
  }

  for (const [value, capability] of [
    ["authorities_admin", "authoritiesEnabled"],
    ["digitization_admin", "digitizationEnabled"],
    ["imports_admin", "importsEnabled"],
  ] as const) {
    it(`inviteUser with role=${value} is invalid where the workspace has no such area`, async () => {
      const db = drizzle(env.DB);
      const inviter = makeUser({ isAdmin: true });
      const email = `no-area-${value}@example.com`;
      const result = await handleUsersAction(
        inviter,
        { ...TENANT, [capability]: false },
        db,
        fd({ _action: "inviteUser", email, role: value }),
        env,
        i18n,
        "http://localhost",
        ACTOR,
        sent,
      );
      expect(result).toEqual({ ok: false, error: "admin:error.invalid_role" });
      expect(await invitedRow(db, email)).toBeFalsy();
      expect(await auditRows(db)).toEqual([]);
    });
  }

  it("inviteUser without a role records the invitation with role none", async () => {
    const db = drizzle(env.DB);
    const inviter = makeUser({ isAdmin: true });
    const result = await handleUsersAction(
      inviter,
      TENANT,
      db,
      fd({ _action: "inviteUser", email: "plain@example.com" }),
      env,
      i18n,
      "http://localhost",
      ACTOR,
      sent,
    );
    expect(result.ok).toBe(true);
    const rows = await auditRows(db);
    expect(rows.map((r) => [r.action, JSON.parse(r.details!)])).toEqual([["invite_user", { role: "none" }]]);
  });

  it("inviteUser whose email fails leaves no audit row", async () => {
    const db = drizzle(env.DB);
    const inviter = makeUser({ isAdmin: true });
    const result = await handleUsersAction(
      inviter,
      TENANT,
      db,
      fd({ _action: "inviteUser", email: "bounce@example.com", role: "records_admin" }),
      env,
      i18n,
      "http://localhost",
      ACTOR,
      { sendInvite: async () => ({ error: "resend down" }) },
    );
    expect(result.ok).toBe(false);
    expect(await invitedRow(db, "bounce@example.com")).toBeFalsy();
    expect(await auditRows(db)).toEqual([]);
  });

  it("inviteUser during an operator session refuses a role and accepts none", async () => {
    const db = drizzle(env.DB);
    const operator = makeUser({ isAdmin: true });
    const session = { homeTenantId: NEOGRANADINA_TENANT_ID, impersonationSessionId: "session-1" };

    const refused = await handleUsersAction(
      operator,
      TENANT,
      db,
      fd({ _action: "inviteUser", email: "op-role@example.com", role: "workspace_admin" }),
      env,
      i18n,
      "http://localhost",
      session,
      sent,
    );
    expect(refused).toEqual({ ok: false, error: "user_admin:error_operator_no_grants" });
    expect(await invitedRow(db, "op-role@example.com")).toBeFalsy();

    const accepted = await handleUsersAction(
      operator,
      TENANT,
      db,
      fd({ _action: "inviteUser", email: "op-none@example.com", role: "none" }),
      env,
      i18n,
      "http://localhost",
      session,
      sent,
    );
    expect(accepted.ok).toBe(true);
    const rows = await auditRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].impersonationSessionId).toBe("session-1");
  });

  it("inviteUser whose role batch fails reports no success, and leaves the account with no role and no audit row", async () => {
    const db = drizzle(env.DB);
    const inviter = makeUser({ isAdmin: true });
    // A database whose batches fail: the account and the email go
    // through, the role and its row do not.
    const failing = {
      ...env,
      DB: {
        prepare: (sql: string) => env.DB.prepare(sql),
        batch: async () => {
          throw new Error("batch failed");
        },
      },
    };
    const result = await handleUsersAction(
      inviter,
      TENANT,
      db,
      fd({ _action: "inviteUser", email: "half@example.com", role: "workspace_admin" }),
      failing,
      i18n,
      "http://localhost",
      ACTOR,
      sent,
    );
    // Not reported as a success: nothing of the batch landed.
    expect(result).toEqual({ ok: false, error: "admin:error.error_invite_role_not_granted" });
    const row = await invitedRow(db, "half@example.com");
    expect(row).toBeTruthy();
    for (const f of ALL_FLAGS) expect(!!row![f]).toBe(false);
    expect(await auditRows(db)).toEqual([]);
  });

  it("inviteUser records the invitation when another admin granted the role while the email was sending", async () => {
    const db = drizzle(env.DB);
    const inviter = makeUser({ isAdmin: true });
    const email = "raced@example.com";
    const result = await handleUsersAction(
      inviter,
      TENANT,
      db,
      fd({ _action: "inviteUser", email, role: "records_admin" }),
      env,
      i18n,
      "http://localhost",
      ACTOR,
      {
        // Another admin grants the role while the email is sending.
        sendInvite: async () => {
          await db.update(schema.users).set({ isRecordsAdmin: true }).where(eq(schema.users.email, email));
          return { success: true };
        },
      },
    );
    expect(result.ok).toBe(true);
    expect((await invitedRow(db, email))!.isRecordsAdmin).toBeTruthy();
    // The invitation is recorded; no grant is recorded over the other
    // admin's, as this invitation granted nothing.
    expect((await auditRows(db)).map((r) => [r.action, JSON.parse(r.details!)])).toEqual([
      ["invite_user", { role: "records_admin" }],
    ]);
  });

  it("inviteUser without a role whose audit batch fails answers that nothing was saved", async () => {
    const db = drizzle(env.DB);
    const failing = {
      ...env,
      DB: {
        prepare: (sql: string) => env.DB.prepare(sql),
        batch: async () => {
          throw new Error("batch failed");
        },
      },
    };
    const result = await handleUsersAction(
      makeUser({ isAdmin: true }),
      TENANT,
      db,
      fd({ _action: "inviteUser", email: "plain-fail@example.com" }),
      failing,
      i18n,
      "http://localhost",
      ACTOR,
      sent,
    );
    expect(result).toEqual({ ok: false, error: "common:save.failed" });
    expect(await auditRows(db)).toEqual([]);
  });

  it("inviteUser whose batch committed reports the invitation sent even if reading the grant back fails", async () => {
    const db = drizzle(env.DB);
    // The batch runs on the real database; the read-back after it fails.
    const readBackFails = {
      ...env,
      DB: {
        prepare: (sql: string) =>
          sql.startsWith("SELECT 1 AS landed")
            ? {
                bind: () => ({
                  first: async () => {
                    throw new Error("read failed");
                  },
                }),
              }
            : env.DB.prepare(sql),
        batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
      },
    };
    const email = "committed@example.com";
    const result = await handleUsersAction(
      makeUser({ isAdmin: true }),
      TENANT,
      db,
      fd({ _action: "inviteUser", email, role: "records_admin" }),
      readBackFails,
      i18n,
      "http://localhost",
      ACTOR,
      sent,
    );
    expect(result).toEqual({ ok: true, message: "admin:error.user_invited" });
    expect((await invitedRow(db, email))!.isRecordsAdmin).toBeTruthy();
    expect((await auditRows(db)).map((r) => r.action).sort()).toEqual(["invite_user", "set_user_role"]);
  });

  it("inviteUser whose batch committed and then threw reports the invitation sent", async () => {
    const db = drizzle(env.DB);
    // The batch commits on the real database, then the call throws, as a
    // transport or decode error after the commit would.
    const throwsAfterCommit = {
      ...env,
      DB: {
        prepare: (sql: string) => env.DB.prepare(sql),
        batch: async (statements: D1PreparedStatement[]) => {
          await env.DB.batch(statements);
          throw new Error("lost the answer");
        },
      },
    };
    const email = "after-commit@example.com";
    const result = await handleUsersAction(
      makeUser({ isAdmin: true }),
      TENANT,
      db,
      fd({ _action: "inviteUser", email, role: "records_admin" }),
      throwsAfterCommit,
      i18n,
      "http://localhost",
      ACTOR,
      sent,
    );
    expect(result).toEqual({ ok: true, message: "admin:error.user_invited" });
    expect((await invitedRow(db, email))!.isRecordsAdmin).toBeTruthy();
    expect((await auditRows(db)).map((r) => r.action).sort()).toEqual(["invite_user", "set_user_role"]);
  });

  it("inviteUser whose batch threw and whose check failed too answers by the role requested", async () => {
    const db = drizzle(env.DB);
    const nothingWorks = {
      ...env,
      DB: {
        prepare: (sql: string) =>
          sql.startsWith("SELECT 1 AS landed")
            ? {
                bind: () => ({
                  first: async () => {
                    throw new Error("read failed");
                  },
                }),
              }
            : env.DB.prepare(sql),
        batch: async () => {
          throw new Error("batch failed");
        },
      },
    };
    for (const [role, error] of [
      ["records_admin", "admin:error.error_invite_role_not_granted"],
      ["none", "common:save.failed"],
    ] as const) {
      const result = await handleUsersAction(
        makeUser({ isAdmin: true }),
        TENANT,
        db,
        fd({ _action: "inviteUser", email: `unknown-${role}@example.com`, role }),
        nothingWorks,
        i18n,
        "http://localhost",
        ACTOR,
        sent,
      );
      expect(result).toEqual({ ok: false, error });
    }
  });
});

// @version v0.8.0
