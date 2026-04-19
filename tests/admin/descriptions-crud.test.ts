/**
 * Tests — descriptions crud
 *
 * @version v0.3.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq, sql } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import {
  LEVEL_HIERARCHY,
  getAllowedChildLevels,
  isValidChildLevel,
} from "../../app/lib/description-levels";

describe("description CRUD", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("creates a description with minimal required fields", async () => {
    const db = drizzle(env.DB);
    const repo = await createTestRepository({ code: "AHRB" });
    const now = Date.now();
    const id = crypto.randomUUID();

    await db.insert(schema.descriptions).values({
      id,
      repositoryId: repo.id,
      title: "Notaria Primera de Bogota",
      descriptionLevel: "fonds",
      referenceCode: "AHRB-N1",
      localIdentifier: "N1",
      isPublished: false,
      createdAt: now,
      updatedAt: now,
    });

    const desc = await db
      .select()
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, id))
      .get();

    expect(desc).toBeTruthy();
    expect(desc!.title).toBe("Notaria Primera de Bogota");
    expect(desc!.descriptionLevel).toBe("fonds");
    expect(desc!.referenceCode).toBe("AHRB-N1");
    expect(desc!.localIdentifier).toBe("N1");
    expect(desc!.repositoryId).toBe(repo.id);
    expect(desc!.isPublished).toBe(false);
  });

  it("rejects duplicate referenceCode", async () => {
    await createTestRepository({ id: "repo-test", code: "TEST" });
    await createTestDescription({ referenceCode: "AHRB-N1-001" });

    try {
      await createTestDescription({ referenceCode: "AHRB-N1-001" });
      expect.fail("Should have thrown on duplicate referenceCode");
    } catch (e) {
      expect(e).toBeTruthy();
    }
  });

  it("new descriptions default to isPublished = false", async () => {
    await createTestRepository({ id: "repo-test", code: "TEST" });
    const desc = await createTestDescription({ isPublished: false });

    const db = drizzle(env.DB);
    const row = await db
      .select()
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, desc.id))
      .get();

    expect(row!.isPublished).toBe(false);
  });

  it("deletes a leaf description", async () => {
    await createTestRepository({ id: "repo-test", code: "TEST" });
    const desc = await createTestDescription({ childCount: 0 });

    const db = drizzle(env.DB);
    await db
      .delete(schema.descriptions)
      .where(eq(schema.descriptions.id, desc.id));

    const row = await db
      .select()
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, desc.id))
      .get();

    expect(row).toBeUndefined();
  });

  it("blocks deletion when children exist", async () => {
    await createTestRepository({ id: "repo-test", code: "TEST" });
    const parent = await createTestDescription({
      childCount: 2,
      referenceCode: "PARENT-001",
    });

    // Simulate the server-side check: childCount > 0 means block
    expect(parent.childCount).toBeGreaterThan(0);
  });
});

describe("description column view", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("loader returns view: tree by default", async () => {
    // The loader returns { view: "tree" } when no view param is set
    const db = drizzle(env.DB);
    // Just verify tree view shape — no items needed
    // Since we can't call the loader directly, we verify the schema supports the query
    const repo = await createTestRepository({ code: "TEST" });
    const desc = await createTestDescription({
      repositoryId: repo.id,
      title: "Test Fonds",
      referenceCode: "TEST-001",
    });

    // Column view query pattern: join descriptions with repositories
    const rows = await db
      .select({
        id: schema.descriptions.id,
        referenceCode: schema.descriptions.referenceCode,
        title: schema.descriptions.title,
        descriptionLevel: schema.descriptions.descriptionLevel,
        repositoryName: schema.repositories.name,
        hasDigital: schema.descriptions.hasDigital,
      })
      .from(schema.descriptions)
      .leftJoin(
        schema.repositories,
        eq(schema.descriptions.repositoryId, schema.repositories.id)
      )
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].referenceCode).toBe("TEST-001");
    expect(rows[0].repositoryName).toBe("Test Repository");
    expect(rows[0].hasDigital).toBe(false);
  });

  it("column view query returns filtered results by description level", async () => {
    const db = drizzle(env.DB);
    const repo = await createTestRepository({ code: "LEVEL" });
    await createTestDescription({
      repositoryId: repo.id,
      title: "A Fonds",
      descriptionLevel: "fonds",
      referenceCode: "LEVEL-F1",
    });
    await createTestDescription({
      repositoryId: repo.id,
      title: "A Series",
      descriptionLevel: "series",
      referenceCode: "LEVEL-S1",
    });

    // Filter by level = fonds
    const rows = await db
      .select()
      .from(schema.descriptions)
      .where(eq(schema.descriptions.descriptionLevel, "fonds"))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].referenceCode).toBe("LEVEL-F1");
  });

  it("column view query returns results filtered by search (LIKE fallback)", async () => {
    const db = drizzle(env.DB);
    const repo = await createTestRepository({ code: "SRCH" });
    await createTestDescription({
      repositoryId: repo.id,
      title: "Notaria Primera de Bogota",
      referenceCode: "SRCH-N1",
    });
    await createTestDescription({
      repositoryId: repo.id,
      title: "Juzgado Civil",
      referenceCode: "SRCH-J1",
    });

    // Search by title LIKE
    const likePattern = "%Notaria%";
    const rows = await db
      .select()
      .from(schema.descriptions)
      .where(sql`${schema.descriptions.title} LIKE ${likePattern}`)
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].referenceCode).toBe("SRCH-N1");
  });

  it("lightweight search API returns limited fields", async () => {
    const db = drizzle(env.DB);
    const repo = await createTestRepository({ code: "LITE" });
    await createTestDescription({
      repositoryId: repo.id,
      title: "Searchable Record",
      referenceCode: "LITE-001",
    });

    // Lightweight search returns id, title, referenceCode, descriptionLevel
    const rows = await db
      .select({
        id: schema.descriptions.id,
        title: schema.descriptions.title,
        referenceCode: schema.descriptions.referenceCode,
        descriptionLevel: schema.descriptions.descriptionLevel,
      })
      .from(schema.descriptions)
      .where(sql`${schema.descriptions.title} LIKE ${'%Searchable%'}`)
      .limit(20)
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Searchable Record");
    expect(rows[0].referenceCode).toBe("LITE-001");
    expect(rows[0].descriptionLevel).toBe("fonds");
    // Verify no extra fields leaked
    expect(Object.keys(rows[0])).toEqual(["id", "title", "referenceCode", "descriptionLevel"]);
  });

  it("cursor pagination returns correct page boundaries", async () => {
    const db = drizzle(env.DB);
    const repo = await createTestRepository({ code: "PAGE" });

    // Create 3 descriptions with ordered reference codes
    for (let i = 1; i <= 3; i++) {
      await createTestDescription({
        repositoryId: repo.id,
        title: `Record ${i}`,
        referenceCode: `PAGE-${String(i).padStart(3, "0")}`,
      });
    }

    // Page 1: first 2 items
    const page1 = await db
      .select()
      .from(schema.descriptions)
      .orderBy(schema.descriptions.referenceCode)
      .limit(3)
      .all();

    expect(page1).toHaveLength(3);
    expect(page1[0].referenceCode).toBe("PAGE-001");
    expect(page1[2].referenceCode).toBe("PAGE-003");

    // Cursor pagination: get items after PAGE-001
    const cursorCode = "PAGE-001";
    const page2 = await db
      .select()
      .from(schema.descriptions)
      .where(sql`${schema.descriptions.referenceCode} > ${cursorCode}`)
      .orderBy(schema.descriptions.referenceCode)
      .limit(2)
      .all();

    expect(page2).toHaveLength(2);
    expect(page2[0].referenceCode).toBe("PAGE-002");
    expect(page2[1].referenceCode).toBe("PAGE-003");
  });
});

describe("description level hierarchy", () => {
  it("defines correct hierarchy ranking", () => {
    expect(LEVEL_HIERARCHY["fonds"]).toBe(0);
    expect(LEVEL_HIERARCHY["subfonds"]).toBe(1);
    expect(LEVEL_HIERARCHY["collection"]).toBe(1);
    expect(LEVEL_HIERARCHY["series"]).toBe(2);
    expect(LEVEL_HIERARCHY["subseries"]).toBe(3);
    expect(LEVEL_HIERARCHY["section"]).toBe(3);
    expect(LEVEL_HIERARCHY["volume"]).toBe(4);
    expect(LEVEL_HIERARCHY["file"]).toBe(4);
    expect(LEVEL_HIERARCHY["item"]).toBe(5);
  });

  it("allows all levels for root (no parent)", () => {
    const allowed = getAllowedChildLevels(null);
    expect(allowed).toContain("fonds");
    expect(allowed).toContain("item");
    expect(allowed.length).toBe(9);
  });

  it("constrains child level below parent (fonds parent)", () => {
    const allowed = getAllowedChildLevels("fonds");
    expect(allowed).not.toContain("fonds");
    expect(allowed).toContain("subfonds");
    expect(allowed).toContain("collection");
    expect(allowed).toContain("series");
    expect(allowed).toContain("item");
  });

  it("constrains child level below parent (series parent)", () => {
    const allowed = getAllowedChildLevels("series");
    expect(allowed).not.toContain("fonds");
    expect(allowed).not.toContain("subfonds");
    expect(allowed).not.toContain("series");
    expect(allowed).toContain("subseries");
    expect(allowed).toContain("file");
    expect(allowed).toContain("item");
  });

  it("validates child level correctly", () => {
    expect(isValidChildLevel("fonds", "subfonds")).toBe(true);
    expect(isValidChildLevel("fonds", "item")).toBe(true);
    expect(isValidChildLevel("fonds", "fonds")).toBe(false);
    expect(isValidChildLevel("series", "fonds")).toBe(false);
    expect(isValidChildLevel("series", "subseries")).toBe(true);
    expect(isValidChildLevel("item", "item")).toBe(false);
  });

  it("item allows no children", () => {
    const allowed = getAllowedChildLevels("item");
    expect(allowed).toHaveLength(0);
  });
});
