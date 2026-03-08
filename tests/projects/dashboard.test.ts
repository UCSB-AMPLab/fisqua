import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
} from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { getUserProjects } from "../../app/lib/projects.server";

describe("dashboard", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  describe("getUserProjects", () => {
    it("returns projects where user has membership", async () => {
      const db = drizzle(env.DB, { schema });
      const user = await createTestUser();
      const now = Date.now();

      // Create two projects and add user to both
      await db.insert(schema.projects).values([
        {
          id: "proj-a",
          name: "Project A",
          createdBy: user.id,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "proj-b",
          name: "Project B",
          createdBy: user.id,
          createdAt: now,
          updatedAt: now - 1000,
        },
      ]);

      await db.insert(schema.projectMembers).values([
        { id: "pm-a1", projectId: "proj-a", userId: user.id, role: "lead", createdAt: now },
        { id: "pm-b1", projectId: "proj-b", userId: user.id, role: "cataloguer", createdAt: now },
      ]);

      const projects = await getUserProjects(db, user.id, false);

      expect(projects).toHaveLength(2);
      expect(projects.map((p) => p.name)).toContain("Project A");
      expect(projects.map((p) => p.name)).toContain("Project B");

      // Check role info is included
      const projA = projects.find((p) => p.name === "Project A")!;
      expect(projA.roles).toContain("lead");

      const projB = projects.find((p) => p.name === "Project B")!;
      expect(projB.roles).toContain("cataloguer");
    });

    it("returns empty array for user with no projects", async () => {
      const db = drizzle(env.DB, { schema });
      const user = await createTestUser();

      const projects = await getUserProjects(db, user.id, false);
      expect(projects).toHaveLength(0);
    });

    it("does not return projects user is not a member of", async () => {
      const db = drizzle(env.DB, { schema });
      const user = await createTestUser();
      const otherUser = await createTestUser({ email: "other@test.com" });
      const now = Date.now();

      // Create a project with only otherUser
      await db.insert(schema.projects).values({
        id: "proj-c",
        name: "Project C",
        createdBy: otherUser.id,
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(schema.projectMembers).values({
        id: "pm-c1",
        projectId: "proj-c",
        userId: otherUser.id,
        role: "lead",
        createdAt: now,
      });

      const projects = await getUserProjects(db, user.id, false);
      expect(projects).toHaveLength(0);
    });

    it("returns all projects for admin users", async () => {
      const db = drizzle(env.DB, { schema });
      const admin = await createTestUser({ isAdmin: true });
      const other = await createTestUser({ email: "other@test.com" });
      const now = Date.now();

      // Create a project where admin has no membership
      await db.insert(schema.projects).values({
        id: "proj-d",
        name: "Project D",
        createdBy: other.id,
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(schema.projectMembers).values({
        id: "pm-d1",
        projectId: "proj-d",
        userId: other.id,
        role: "lead",
        createdAt: now,
      });

      const projects = await getUserProjects(db, admin.id, true);
      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe("Project D");
    });
  });
});
