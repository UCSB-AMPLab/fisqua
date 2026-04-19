/**
 * Tests — descriptions tree
 *
 * @version v0.3.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq, asc } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestDescription } from "../helpers/descriptions";
import { createTestRepository } from "../helpers/repositories";

describe("descriptions children API", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("returns root descriptions (depth 0) ordered by position", async () => {
    const repo = await createTestRepository({ code: "AHRB" });

    const d1 = await createTestDescription({
      repositoryId: repo.id,
      depth: 0,
      position: 1,
      title: "Second Fonds",
      descriptionLevel: "fonds",
      childCount: 3,
    });
    const d2 = await createTestDescription({
      repositoryId: repo.id,
      depth: 0,
      position: 0,
      title: "First Fonds",
      descriptionLevel: "fonds",
      childCount: 5,
    });

    const db = drizzle(env.DB);
    const roots = await db
      .select({
        id: schema.descriptions.id,
        title: schema.descriptions.title,
        referenceCode: schema.descriptions.referenceCode,
        descriptionLevel: schema.descriptions.descriptionLevel,
        dateExpression: schema.descriptions.dateExpression,
        scopeContent: schema.descriptions.scopeContent,
        childCount: schema.descriptions.childCount,
        isPublished: schema.descriptions.isPublished,
        position: schema.descriptions.position,
        repositoryId: schema.descriptions.repositoryId,
      })
      .from(schema.descriptions)
      .where(eq(schema.descriptions.depth, 0))
      .orderBy(asc(schema.descriptions.position))
      .all();

    expect(roots).toHaveLength(2);
    expect(roots[0].title).toBe("First Fonds");
    expect(roots[1].title).toBe("Second Fonds");
    expect(roots[0].position).toBe(0);
    expect(roots[1].position).toBe(1);
    // Verify all expected fields present
    expect(roots[0]).toHaveProperty("id");
    expect(roots[0]).toHaveProperty("referenceCode");
    expect(roots[0]).toHaveProperty("descriptionLevel");
    expect(roots[0]).toHaveProperty("dateExpression");
    expect(roots[0]).toHaveProperty("scopeContent");
    expect(roots[0]).toHaveProperty("childCount");
    expect(roots[0]).toHaveProperty("isPublished");
    expect(roots[0]).toHaveProperty("repositoryId");
  });

  it("returns children of a parent ordered by position", async () => {
    const repo = await createTestRepository({ code: "AHRB" });

    const parent = await createTestDescription({
      repositoryId: repo.id,
      depth: 0,
      position: 0,
      title: "Parent Fonds",
      descriptionLevel: "fonds",
      childCount: 2,
    });

    const child1 = await createTestDescription({
      repositoryId: repo.id,
      parentId: parent.id,
      depth: 1,
      position: 1,
      title: "Second Series",
      descriptionLevel: "series",
    });
    const child2 = await createTestDescription({
      repositoryId: repo.id,
      parentId: parent.id,
      depth: 1,
      position: 0,
      title: "First Series",
      descriptionLevel: "series",
      childCount: 10,
    });

    const db = drizzle(env.DB);
    const children = await db
      .select({
        id: schema.descriptions.id,
        title: schema.descriptions.title,
        referenceCode: schema.descriptions.referenceCode,
        descriptionLevel: schema.descriptions.descriptionLevel,
        dateExpression: schema.descriptions.dateExpression,
        scopeContent: schema.descriptions.scopeContent,
        childCount: schema.descriptions.childCount,
        isPublished: schema.descriptions.isPublished,
        position: schema.descriptions.position,
        repositoryId: schema.descriptions.repositoryId,
      })
      .from(schema.descriptions)
      .where(eq(schema.descriptions.parentId, parent.id))
      .orderBy(asc(schema.descriptions.position))
      .all();

    expect(children).toHaveLength(2);
    expect(children[0].title).toBe("First Series");
    expect(children[1].title).toBe("Second Series");
    expect(children[0].childCount).toBe(10);
  });

  it("returns empty array when parent has no children", async () => {
    const repo = await createTestRepository({ code: "AHRB" });

    const leaf = await createTestDescription({
      repositoryId: repo.id,
      depth: 0,
      position: 0,
      title: "Leaf Item",
      descriptionLevel: "item",
      childCount: 0,
    });

    const db = drizzle(env.DB);
    const children = await db
      .select({
        id: schema.descriptions.id,
        title: schema.descriptions.title,
      })
      .from(schema.descriptions)
      .where(eq(schema.descriptions.parentId, leaf.id))
      .orderBy(asc(schema.descriptions.position))
      .all();

    expect(children).toHaveLength(0);
  });

  it("returns correct fields for each child item", async () => {
    const repo = await createTestRepository({ code: "AHRB" });

    const desc = await createTestDescription({
      repositoryId: repo.id,
      depth: 0,
      position: 0,
      title: "Protocolos notariales de Tunja",
      descriptionLevel: "fonds",
      dateExpression: "1550-1600",
      scopeContent: "Notarial records from the city of Tunja",
      childCount: 42,
      isPublished: true,
    });

    const db = drizzle(env.DB);
    const [result] = await db
      .select({
        id: schema.descriptions.id,
        title: schema.descriptions.title,
        referenceCode: schema.descriptions.referenceCode,
        descriptionLevel: schema.descriptions.descriptionLevel,
        dateExpression: schema.descriptions.dateExpression,
        scopeContent: schema.descriptions.scopeContent,
        childCount: schema.descriptions.childCount,
        isPublished: schema.descriptions.isPublished,
        position: schema.descriptions.position,
        repositoryId: schema.descriptions.repositoryId,
      })
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, desc.id))
      .all();

    expect(result.id).toBe(desc.id);
    expect(result.title).toBe("Protocolos notariales de Tunja");
    expect(result.referenceCode).toBe(desc.referenceCode);
    expect(result.descriptionLevel).toBe("fonds");
    expect(result.dateExpression).toBe("1550-1600");
    expect(result.scopeContent).toBe("Notarial records from the city of Tunja");
    expect(result.childCount).toBe(42);
    expect(result.isPublished).toBe(true);
    expect(result.repositoryId).toBe(repo.id);
  });
});
