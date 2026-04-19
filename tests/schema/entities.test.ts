/**
 * Tests — entities
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

describe("entities table (SCHEMA-03)", () => {
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("can insert an entity with required fields", async () => {
    const id = crypto.randomUUID();
    const now = Date.now();

    await db.insert(schema.entities).values({
      id,
      entityCode: "ne-abc234",
      displayName: "Juan de Castellanos",
      sortName: "Castellanos, Juan de",
      entityType: "person",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, id));

    expect(row).toBeDefined();
    expect(row.entityCode).toBe("ne-abc234");
    expect(row.displayName).toBe("Juan de Castellanos");
    expect(row.sortName).toBe("Castellanos, Juan de");
    expect(row.entityType).toBe("person");
  });

  it("entityCode has unique constraint", async () => {
    const now = Date.now();

    await db.insert(schema.entities).values({
      id: crypto.randomUUID(),
      entityCode: "ne-xxxxxx",
      displayName: "First Entity",
      sortName: "Entity, First",
      entityType: "person",
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      db.insert(schema.entities).values({
        id: crypto.randomUUID(),
        entityCode: "ne-xxxxxx",
        displayName: "Second Entity",
        sortName: "Entity, Second",
        entityType: "person",
        createdAt: now,
        updatedAt: now,
      })
    ).rejects.toThrow();
  });

  it("mergedInto column exists and accepts a UUID", async () => {
    const mainId = crypto.randomUUID();
    const mergedId = crypto.randomUUID();
    const now = Date.now();

    await db.insert(schema.entities).values({
      id: mainId,
      entityCode: "ne-main01",
      displayName: "Main Entity",
      sortName: "Entity, Main",
      entityType: "person",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(schema.entities).values({
      id: mergedId,
      entityCode: "ne-mrgd01",
      displayName: "Merged Entity",
      sortName: "Entity, Merged",
      entityType: "person",
      mergedInto: mainId,
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, mergedId));

    expect(row.mergedInto).toBe(mainId);
  });

  it("nameVariants defaults to '[]'", async () => {
    const id = crypto.randomUUID();
    const now = Date.now();

    await db.insert(schema.entities).values({
      id,
      entityCode: "ne-defvar",
      displayName: "Default Variants",
      sortName: "Variants, Default",
      entityType: "corporate",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, id));

    expect(row.nameVariants).toBe("[]");
  });
});
