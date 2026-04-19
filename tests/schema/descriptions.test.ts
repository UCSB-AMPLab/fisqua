/**
 * Tests — descriptions
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

describe("descriptions table (SCHEMA-01)", () => {
  let db: ReturnType<typeof drizzle>;
  let repositoryId: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });

    // Create a repository for FK reference
    repositoryId = crypto.randomUUID();
    await db.insert(schema.repositories).values({
      id: repositoryId,
      code: "test-repo",
      name: "Test Repository",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  it("can insert a description with all required fields", async () => {
    const id = crypto.randomUUID();
    const now = Date.now();

    await db.insert(schema.descriptions).values({
      id,
      repositoryId,
      descriptionLevel: "fonds",
      referenceCode: "CO-TEST-001",
      localIdentifier: "001",
      title: "Test Fonds",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, id));

    expect(row).toBeDefined();
    expect(row.repositoryId).toBe(repositoryId);
    expect(row.descriptionLevel).toBe("fonds");
    expect(row.referenceCode).toBe("CO-TEST-001");
    expect(row.localIdentifier).toBe("001");
    expect(row.title).toBe("Test Fonds");
  });

  it("hierarchy columns exist and accept values (parentId, position, rootDescriptionId)", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const now = Date.now();

    await db.insert(schema.descriptions).values({
      id: rootId,
      repositoryId,
      descriptionLevel: "fonds",
      referenceCode: "CO-TEST-002",
      localIdentifier: "002",
      title: "Root Fonds",
      position: 0,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(schema.descriptions).values({
      id: childId,
      repositoryId,
      descriptionLevel: "series",
      referenceCode: "CO-TEST-002-S1",
      localIdentifier: "002-S1",
      title: "Child Series",
      parentId: rootId,
      rootDescriptionId: rootId,
      position: 0,
      createdAt: now,
      updatedAt: now,
    });

    const [child] = await db
      .select()
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, childId));

    expect(child.parentId).toBe(rootId);
    expect(child.rootDescriptionId).toBe(rootId);
    expect(child.position).toBe(0);
  });

  it("denorm cache columns exist (depth, childCount, pathCache)", async () => {
    const id = crypto.randomUUID();
    const now = Date.now();

    await db.insert(schema.descriptions).values({
      id,
      repositoryId,
      descriptionLevel: "fonds",
      referenceCode: "CO-TEST-003",
      localIdentifier: "003",
      title: "Fonds with cache",
      depth: 0,
      childCount: 5,
      pathCache: "CO-TEST-003",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, id));

    expect(row.depth).toBe(0);
    expect(row.childCount).toBe(5);
    expect(row.pathCache).toBe("CO-TEST-003");
  });

  it("referenceCode has unique constraint (inserting duplicate throws)", async () => {
    const now = Date.now();
    const refCode = "CO-TEST-UNIQUE";

    await db.insert(schema.descriptions).values({
      id: crypto.randomUUID(),
      repositoryId,
      descriptionLevel: "fonds",
      referenceCode: refCode,
      localIdentifier: "U1",
      title: "First",
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      db.insert(schema.descriptions).values({
        id: crypto.randomUUID(),
        repositoryId,
        descriptionLevel: "fonds",
        referenceCode: refCode,
        localIdentifier: "U2",
        title: "Second",
        createdAt: now,
        updatedAt: now,
      })
    ).rejects.toThrow();
  });

  it("isPublished defaults to false (staff publishes explicitly)", async () => {
    const id = crypto.randomUUID();
    const now = Date.now();

    await db.insert(schema.descriptions).values({
      id,
      repositoryId,
      descriptionLevel: "item",
      referenceCode: "CO-TEST-PUB",
      localIdentifier: "PUB",
      title: "Published by default",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, id));

    expect(row.isPublished).toBe(false);
  });

  it("dateStart and dateEnd store ISO date strings, not integers (Pitfall 5)", async () => {
    const id = crypto.randomUUID();
    const now = Date.now();

    await db.insert(schema.descriptions).values({
      id,
      repositoryId,
      descriptionLevel: "item",
      referenceCode: "CO-TEST-DATE",
      localIdentifier: "DATE",
      title: "Historical dates",
      dateStart: "1780-03-15",
      dateEnd: "1782-11-20",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, id));

    expect(row.dateStart).toBe("1780-03-15");
    expect(row.dateEnd).toBe("1782-11-20");
    expect(typeof row.dateStart).toBe("string");
    expect(typeof row.dateEnd).toBe("string");
  });
});
