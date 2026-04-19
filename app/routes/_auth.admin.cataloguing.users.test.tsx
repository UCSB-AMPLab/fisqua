/**
 * Tests for Cataloguing Admin Users Actions
 *
 * @version v0.3.0
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { applyMigrations, cleanDatabase } from "../../tests/helpers/db";
import { handleUsersAction } from "./_auth.admin.cataloguing.users.action.server";
import { requireCollabAdmin } from "../lib/permissions.server";
import type { User } from "../context";

// A tiny i18n stub — just echoes the key so tests can assert on it.
const i18n = { t: (key: string) => key };

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    email: overrides.email ?? "u@example.com",
    name: overrides.name ?? null,
    isAdmin: false,
    isSuperAdmin: false,
    isCollabAdmin: false,
    isArchiveUser: false,
    githubId: null,
    ...overrides,
  };
}

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

function expectForbidden(fn: () => Promise<unknown>) {
  return expect(fn()).rejects.toBeInstanceOf(Response);
}

describe("cataloguing users admin: loader gate", () => {
  it("requireCollabAdmin rejects plain user with 403", () => {
    const plain = makeUser();
    try {
      requireCollabAdmin(plain);
      expect.fail("expected 403");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });

  it("requireCollabAdmin rejects archive admin with 403", () => {
    const admin = makeUser({ isAdmin: true });
    try {
      requireCollabAdmin(admin);
      expect.fail("expected 403");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });

  it("requireCollabAdmin allows collab-admin", () => {
    expect(() =>
      requireCollabAdmin(makeUser({ isCollabAdmin: true }))
    ).not.toThrow();
  });

  it("requireCollabAdmin allows superadmin", () => {
    expect(() =>
      requireCollabAdmin(makeUser({ isSuperAdmin: true }))
    ).not.toThrow();
  });
});

describe("cataloguing users admin: action handler", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("toggleAdmin as collab-admin (non-super) throws 403 - closes live bug", async () => {
    const db = drizzle(env.DB);
    const collabAdmin = makeUser({ isCollabAdmin: true });
    const now = Date.now();
    const targetId = crypto.randomUUID();
    await db.insert(schema.users).values({
      id: targetId,
      email: "target@example.com",
      isAdmin: false,
      createdAt: now,
      updatedAt: now,
    });

    await expectForbidden(() =>
      handleUsersAction(
        collabAdmin,
        db,
        fd({ _action: "toggleAdmin", userId: targetId }),
        env,
        i18n,
        "http://localhost"
      )
    );

    // Target row was not mutated.
    const row = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, targetId))
      .get();
    expect(row!.isAdmin).toBeFalsy();
  });

  it("toggleCollabAdmin as collab-admin (non-super) throws 403", async () => {
    const db = drizzle(env.DB);
    const collabAdmin = makeUser({ isCollabAdmin: true });
    const now = Date.now();
    const targetId = crypto.randomUUID();
    await db.insert(schema.users).values({
      id: targetId,
      email: "target2@example.com",
      isAdmin: false,
      createdAt: now,
      updatedAt: now,
    });

    await expectForbidden(() =>
      handleUsersAction(
        collabAdmin,
        db,
        fd({ _action: "toggleCollabAdmin", userId: targetId }),
        env,
        i18n,
        "http://localhost"
      )
    );
  });

  it("toggleAdmin as superadmin succeeds", async () => {
    const db = drizzle(env.DB);
    const superadmin = makeUser({ isSuperAdmin: true });
    const now = Date.now();
    const targetId = crypto.randomUUID();
    await db.insert(schema.users).values({
      id: targetId,
      email: "target3@example.com",
      isAdmin: false,
      createdAt: now,
      updatedAt: now,
    });

    const result = await handleUsersAction(
      superadmin,
      db,
      fd({ _action: "toggleAdmin", userId: targetId }),
      env,
      i18n,
      "http://localhost"
    );
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, targetId))
      .get();
    expect(row!.isAdmin).toBeTruthy();
  });

  it("inviteUser with isCollabAdmin=on as non-super throws 403", async () => {
    const db = drizzle(env.DB);
    const collabAdmin = makeUser({ isCollabAdmin: true });

    await expectForbidden(() =>
      handleUsersAction(
        collabAdmin,
        db,
        fd({
          _action: "inviteUser",
          email: "newbie@example.com",
          name: "Newbie",
          isCollabAdmin: "on",
        }),
        env,
        i18n,
        "http://localhost"
      )
    );

    // No user row created.
    const row = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "newbie@example.com"))
      .get();
    expect(row).toBeFalsy();
  });

  it("inviteUser with email+name only creates user row and calls sender", async () => {
    const db = drizzle(env.DB);
    const collabAdmin = makeUser({ isCollabAdmin: true });
    let senderCalled = false;

    const result = await handleUsersAction(
      collabAdmin,
      db,
      fd({
        _action: "inviteUser",
        email: "invitee@example.com",
        name: "Invitee",
      }),
      env,
      i18n,
      "http://localhost",
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
      id: crypto.randomUUID(),
      email: "dup@example.com",
      isAdmin: false,
      createdAt: now,
      updatedAt: now,
    });

    const result = await handleUsersAction(
      collabAdmin,
      db,
      fd({
        _action: "inviteUser",
        email: "dup@example.com",
      }),
      env,
      i18n,
      "http://localhost",
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

  it("inviteUser rolls back user row when email sender fails", async () => {
    const db = drizzle(env.DB);
    const collabAdmin = makeUser({ isCollabAdmin: true });

    const result = await handleUsersAction(
      collabAdmin,
      db,
      fd({
        _action: "inviteUser",
        email: "fail@example.com",
      }),
      env,
      i18n,
      "http://localhost",
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
});
