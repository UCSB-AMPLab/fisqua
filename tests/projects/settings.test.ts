/**
 * Tests — settings
 *
 * @version v0.3.0
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
} from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { requireProjectRole } from "../../app/lib/permissions.server";

describe("project settings", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  describe("settings update", () => {
    it("updates project name and description", async () => {
      const db = drizzle(env.DB, { schema });
      const user = await createTestUser();
      const now = Date.now();

      await db.insert(schema.projects).values({
        id: "proj-s1",
        name: "Original Name",
        description: "Original desc",
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      });

      await db
        .update(schema.projects)
        .set({
          name: "Updated Name",
          description: "Updated desc",
          updatedAt: Date.now(),
        })
        .where(eq(schema.projects.id, "proj-s1"));

      const updated = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, "proj-s1"))
        .get();

      expect(updated!.name).toBe("Updated Name");
      expect(updated!.description).toBe("Updated desc");
      expect(updated!.updatedAt).toBeGreaterThan(now);
    });

    it("updates conventions text", async () => {
      const db = drizzle(env.DB, { schema });
      const user = await createTestUser();
      const now = Date.now();

      await db.insert(schema.projects).values({
        id: "proj-s2",
        name: "Test",
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      });

      const conventionsText = "## Guidelines\n\n- Use consistent formatting\n- Follow style guide";

      await db
        .update(schema.projects)
        .set({
          conventions: conventionsText,
          updatedAt: Date.now(),
        })
        .where(eq(schema.projects.id, "proj-s2"));

      const updated = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, "proj-s2"))
        .get();

      expect(updated!.conventions).toBe(conventionsText);
    });

    it("updates settings JSON", async () => {
      const db = drizzle(env.DB, { schema });
      const user = await createTestUser();
      const now = Date.now();

      await db.insert(schema.projects).values({
        id: "proj-s3",
        name: "Test",
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      });

      const settingsJson = JSON.stringify({ theme: "dark", maxItems: 100 });

      await db
        .update(schema.projects)
        .set({
          settings: settingsJson,
          updatedAt: Date.now(),
        })
        .where(eq(schema.projects.id, "proj-s3"));

      const updated = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, "proj-s3"))
        .get();

      expect(updated!.settings).toBe(settingsJson);
      expect(JSON.parse(updated!.settings!)).toEqual({ theme: "dark", maxItems: 100 });
    });
  });

  describe("role access control", () => {
    it("allows lead to access settings", async () => {
      const db = drizzle(env.DB, { schema });
      const user = await createTestUser();
      const now = Date.now();

      await db.insert(schema.projects).values({
        id: "proj-s4",
        name: "Test",
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(schema.projectMembers).values({
        id: "pm-s4",
        projectId: "proj-s4",
        userId: user.id,
        role: "lead",
        createdAt: now,
      });

      const result = await requireProjectRole(db, user.id, "proj-s4", ["lead"]);
      expect(result).toHaveLength(1);
    });

    it("rejects member from settings", async () => {
      const db = drizzle(env.DB, { schema });
      const user = await createTestUser();
      const now = Date.now();

      await db.insert(schema.projects).values({
        id: "proj-s5",
        name: "Test",
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(schema.projectMembers).values({
        id: "pm-s5",
        projectId: "proj-s5",
        userId: user.id,
        role: "cataloguer",
        createdAt: now,
      });

      try {
        await requireProjectRole(db, user.id, "proj-s5", ["lead"]);
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(403);
      }
    });
  });
});
