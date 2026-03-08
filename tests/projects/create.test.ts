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
import { requireAdmin, requireProjectRole } from "../../app/lib/permissions.server";
import { createProject, validateProjectForm } from "../../app/lib/projects.server";

describe("project creation", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  describe("requireAdmin", () => {
    it("allows admin users", () => {
      const admin = { id: "1", email: "admin@test.com", name: "Admin", isAdmin: true };
      expect(() => requireAdmin(admin)).not.toThrow();
    });

    it("throws 403 for non-admin users", () => {
      const user = { id: "2", email: "user@test.com", name: "User", isAdmin: false };
      try {
        requireAdmin(user);
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(403);
      }
    });
  });

  describe("requireProjectRole", () => {
    it("allows user with matching role", async () => {
      const db = drizzle(env.DB, { schema });
      const user = await createTestUser({ isAdmin: false });
      const now = Date.now();

      await db.insert(schema.projects).values({
        id: "proj-1",
        name: "Test Project",
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(schema.projectMembers).values({
        id: "pm-1",
        projectId: "proj-1",
        userId: user.id,
        role: "lead",
        createdAt: now,
      });

      const result = await requireProjectRole(db, user.id, "proj-1", ["lead"]);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("lead");
    });

    it("throws 403 for user without matching role", async () => {
      const db = drizzle(env.DB, { schema });
      const user = await createTestUser({ isAdmin: false });
      const now = Date.now();

      await db.insert(schema.projects).values({
        id: "proj-2",
        name: "Test Project 2",
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(schema.projectMembers).values({
        id: "pm-2",
        projectId: "proj-2",
        userId: user.id,
        role: "member",
        createdAt: now,
      });

      try {
        await requireProjectRole(db, user.id, "proj-2", ["lead"]);
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(403);
      }
    });

    it("allows admin to bypass role checks", async () => {
      const db = drizzle(env.DB, { schema });
      const admin = await createTestUser({ isAdmin: true });
      const now = Date.now();

      await db.insert(schema.projects).values({
        id: "proj-3",
        name: "Test Project 3",
        createdBy: admin.id,
        createdAt: now,
        updatedAt: now,
      });

      // Admin has no membership but should still be allowed
      const result = await requireProjectRole(db, admin.id, "proj-3", ["lead"], true);
      expect(result).toHaveLength(0); // no membership, but allowed
    });
  });

  describe("validateProjectForm", () => {
    it("validates valid project data", () => {
      const result = validateProjectForm({
        name: "My Project",
        description: "A description",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("My Project");
      }
    });

    it("rejects empty project name", () => {
      const result = validateProjectForm({
        name: "",
        description: "",
      });

      expect(result.success).toBe(false);
    });
  });

  describe("createProject", () => {
    it("creates a project and adds creator as lead", async () => {
      const db = drizzle(env.DB, { schema });
      const admin = await createTestUser({ isAdmin: true });

      const project = await createProject(db, {
        name: "Template Project",
        description: "A project using the template",
      }, admin.id);

      expect(project.name).toBe("Template Project");
      expect(project.createdBy).toBe(admin.id);

      // Verify creator is added as lead
      const members = await db
        .select()
        .from(schema.projectMembers)
        .where(eq(schema.projectMembers.projectId, project.id))
        .all();

      expect(members).toHaveLength(1);
      expect(members[0].userId).toBe(admin.id);
      expect(members[0].role).toBe("lead");
    });
  });
});
