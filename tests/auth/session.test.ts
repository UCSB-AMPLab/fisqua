import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createSessionStorage } from "../../app/sessions.server";
import { requireUser } from "../../app/lib/auth.server";

const TEST_SECRET = "test-session-secret-at-least-32-characters-long";

describe("session management", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  describe("createSessionStorage", () => {
    it("creates a session and commits a cookie with userId", async () => {
      const { getSession, commitSession } = createSessionStorage(TEST_SECRET);

      const session = await getSession();
      session.set("userId", "test-user-id");

      const cookie = await commitSession(session);
      expect(cookie).toBeTruthy();
      expect(cookie).toContain("__session");
    });

    it("reads userId from a committed session cookie", async () => {
      const { getSession, commitSession } = createSessionStorage(TEST_SECRET);

      const session = await getSession();
      session.set("userId", "test-user-id");

      const cookie = await commitSession(session);

      // Read back
      const session2 = await getSession(cookie);
      expect(session2.get("userId")).toBe("test-user-id");
    });

    it("destroys a session and clears the cookie", async () => {
      const { getSession, commitSession, destroySession } =
        createSessionStorage(TEST_SECRET);

      const session = await getSession();
      session.set("userId", "test-user-id");
      const cookie = await commitSession(session);

      const clearedCookie = await destroySession(
        await getSession(cookie)
      );
      expect(clearedCookie).toBeTruthy();

      // Reading the cleared cookie should give an empty session
      const session2 = await getSession(clearedCookie);
      expect(session2.get("userId")).toBeUndefined();
    });
  });

  describe("requireUser", () => {
    it("returns the user for a valid userId", async () => {
      const db = drizzle(env.DB, { schema });
      const testUser = await createTestUser({
        email: "scholar@example.com",
        name: "Scholar",
      });

      const user = await requireUser(db, testUser.id);
      expect(user).not.toBeNull();
      expect(user!.email).toBe("scholar@example.com");
      expect(user!.name).toBe("Scholar");
    });

    it("returns null for a non-existent userId", async () => {
      const db = drizzle(env.DB, { schema });

      const user = await requireUser(db, "non-existent-id");
      expect(user).toBeNull();
    });
  });
});
