/**
 * Permission Guard Tests
 *
 * This suite deals with pinning the behaviour of the user-level
 * permission guards in `permissions.server.ts`. The current suite
 * focuses on `requireCollabAdmin`, the gate on the cataloguing admin
 * surface: it admits super admins, collab admins and tenant admins
 * (`isAdmin`), and rejects every other flag combination, including an
 * archive user and a user manager. Admitting a tenant admin to the
 * surface grants no flag; `tests/admin/users-reach.test.tsx` pins that
 * `assignableRoleFlags` is unchanged for them.
 *
 * @version v0.8.0
 */

import { describe, it, expect } from "vitest";
import { requireCollabAdmin } from "./permissions.server";
import type { User } from "../context";

function makeUser(overrides: Partial<User & { isCollabAdmin: boolean; isArchiveUser: boolean }> = {}): User {
  return {
    id: "u1",
    email: "u1@example.com",
    name: "User One",
    isAdmin: false,
    isSuperAdmin: false,
    githubId: null,
    ...overrides,
  } as User;
}

function expectForbidden(fn: () => void) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(403);
    return;
  }
  throw new Error("Expected requireCollabAdmin to throw a 403 Response");
}

describe("requireCollabAdmin", () => {
  it("allows a superadmin user", () => {
    const user = makeUser({ isSuperAdmin: true });
    expect(requireCollabAdmin(user)).toBeUndefined();
  });

  it("allows a collabAdmin-only user", () => {
    const user = makeUser({ isCollabAdmin: true });
    expect(requireCollabAdmin(user)).toBeUndefined();
  });

  it("allows a tenant admin (isAdmin only)", () => {
    const user = makeUser({ isAdmin: true });
    expect(requireCollabAdmin(user)).toBeUndefined();
  });

  it("rejects a user manager who is not also an admin", () => {
    const user = makeUser({ isUserManager: true });
    expectForbidden(() => requireCollabAdmin(user));
  });

  it("rejects a plain user with no flags", () => {
    const user = makeUser();
    expectForbidden(() => requireCollabAdmin(user));
  });

  it("rejects an archiveUser-only user", () => {
    const user = makeUser({ isArchiveUser: true });
    expectForbidden(() => requireCollabAdmin(user));
  });
});

// @version v0.8.0
