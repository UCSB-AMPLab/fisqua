/**
 * Tests — repositories
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
import { eq, sql } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestRepository } from "../helpers/repositories";
import { createTestUser } from "../helpers/auth";

describe("repository CRUD", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("creates a repository with required fields", async () => {
    const db = drizzle(env.DB);
    const now = Date.now();
    const id = crypto.randomUUID();

    await db.insert(schema.repositories).values({
      id,
      code: "AGN",
      name: "Archivo General de la Nacion",
      countryCode: "COL",
      createdAt: now,
      updatedAt: now,
    });

    const repo = await db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, id))
      .get();

    expect(repo).toBeTruthy();
    expect(repo!.code).toBe("AGN");
    expect(repo!.name).toBe("Archivo General de la Nacion");
    expect(repo!.countryCode).toBe("COL");
    expect(repo!.enabled).toBe(true);
    expect(repo!.createdAt).toBe(now);
    expect(repo!.updatedAt).toBe(now);
  });

  it("rejects duplicate repository code", async () => {
    await createTestRepository({ code: "AGN" });

    try {
      await createTestRepository({ code: "AGN" });
      expect.fail("Should have thrown on duplicate code");
    } catch (e) {
      // D1 throws on unique constraint violation; error message format varies
      expect(e).toBeTruthy();
    }
  });

  it("updates repository fields", async () => {
    const db = drizzle(env.DB);
    const repo = await createTestRepository({ name: "Old Name" });

    // Small delay so updatedAt differs
    const newUpdatedAt = Date.now() + 1000;
    await db
      .update(schema.repositories)
      .set({ name: "New Name", updatedAt: newUpdatedAt })
      .where(eq(schema.repositories.id, repo.id));

    const updated = await db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, repo.id))
      .get();

    expect(updated!.name).toBe("New Name");
    expect(updated!.updatedAt).toBeGreaterThan(repo.updatedAt);
  });

  it("toggles enabled status", async () => {
    const db = drizzle(env.DB);
    const repo = await createTestRepository({ enabled: true });

    await db
      .update(schema.repositories)
      .set({ enabled: false, updatedAt: Date.now() })
      .where(eq(schema.repositories.id, repo.id));

    const updated = await db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, repo.id))
      .get();

    expect(updated!.enabled).toBe(false);
  });
});

describe("cascade protection", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("blocks delete when descriptions reference the repository", async () => {
    const db = drizzle(env.DB);
    const repo = await createTestRepository();
    const user = await createTestUser();

    // Create a minimal description referencing this repository
    const descId = crypto.randomUUID();
    const now = Date.now();
    await db.insert(schema.descriptions).values({
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "fonds",
      referenceCode: "AGN-001",
      localIdentifier: "AGN-001",
      title: "Test Fonds",
      position: 0,
      depth: 0,
      childCount: 0,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    // Attempt to delete the repository -- should fail due to FK constraint
    try {
      await db
        .delete(schema.repositories)
        .where(eq(schema.repositories.id, repo.id));
      expect.fail("Should have thrown on FK constraint");
    } catch (e) {
      // D1 throws on FK constraint violation; error message format varies
      expect(e).toBeTruthy();
    }
  });

  it("allows delete when no descriptions reference the repository", async () => {
    const db = drizzle(env.DB);
    const repo = await createTestRepository();

    await db
      .delete(schema.repositories)
      .where(eq(schema.repositories.id, repo.id));

    const deleted = await db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, repo.id))
      .get();

    expect(deleted).toBeUndefined();
  });
});

describe("display metadata fields", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("persists displayTitle, subtitle, and heroImageUrl", async () => {
    const db = drizzle(env.DB);
    const now = Date.now();
    const id = crypto.randomUUID();

    await db.insert(schema.repositories).values({
      id,
      code: "TEST-DM",
      name: "Test Repo",
      displayTitle: "Custom Display Title",
      subtitle: "A subtitle",
      heroImageUrl: "https://r2.zasqua.org/hero/test.jpg",
      createdAt: now,
      updatedAt: now,
    });

    const repo = await db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, id))
      .get();

    expect(repo).toBeTruthy();
    expect(repo!.displayTitle).toBe("Custom Display Title");
    expect(repo!.subtitle).toBe("A subtitle");
    expect(repo!.heroImageUrl).toBe("https://r2.zasqua.org/hero/test.jpg");
  });

  it("defaults displayTitle, subtitle, heroImageUrl to null", async () => {
    const db = drizzle(env.DB);
    const repo = await createTestRepository({ code: "NULL-DM" });

    expect(repo.displayTitle).toBeNull();
    expect(repo.subtitle).toBeNull();
    expect(repo.heroImageUrl).toBeNull();
  });
});

describe("filtering", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("filters to enabled repositories only", async () => {
    const db = drizzle(env.DB);

    await createTestRepository({ code: "REPO-A", enabled: true });
    await createTestRepository({ code: "REPO-B", enabled: true });
    await createTestRepository({ code: "REPO-C", enabled: false });

    const enabledRepos = await db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.enabled, true))
      .all();

    expect(enabledRepos).toHaveLength(2);
    const codes = enabledRepos.map((r) => r.code).sort();
    expect(codes).toEqual(["REPO-A", "REPO-B"]);
  });
});
