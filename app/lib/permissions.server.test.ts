/**
 * Permission Guard Tests
 *
 * Pins the behaviour of the user-level permission guards in
 * `permissions.server.ts`. The current suite focuses on
 * `requireCollabAdmin`, which is the canonical example of a two-tier
 * role wall: it accepts superadmin and collab-admin users and rejects
 * every other flag combination, including archive admins -- the
 * collab-admin tier and the archive-admin tier are intentionally
 * separate, and the test pins that wall so a future permission
 * refactor cannot quietly tear it down.
 *
 * @version v0.3.0
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

  it("rejects an admin-only user — the two admin tiers are walled off", () => {
    const user = makeUser({ isAdmin: true });
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
