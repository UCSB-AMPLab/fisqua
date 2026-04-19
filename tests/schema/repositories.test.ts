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
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";

describe("repositories table (SCHEMA-02)", () => {
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("can insert a repository with required fields", async () => {
    const id = crypto.randomUUID();
    const now = Date.now();

    await db.insert(schema.repositories).values({
      id,
      code: "ahrb",
      name: "Archivo Historico Regional de Boyaca",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, id));

    expect(row).toBeDefined();
    expect(row.code).toBe("ahrb");
    expect(row.name).toBe("Archivo Historico Regional de Boyaca");
  });

  it("code has unique constraint (inserting duplicate throws)", async () => {
    const now = Date.now();

    await db.insert(schema.repositories).values({
      id: crypto.randomUUID(),
      code: "unique-code",
      name: "First Repository",
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      db.insert(schema.repositories).values({
        id: crypto.randomUUID(),
        code: "unique-code",
        name: "Second Repository",
        createdAt: now,
        updatedAt: now,
      })
    ).rejects.toThrow();
  });

  it("countryCode defaults to 'COL'", async () => {
    const id = crypto.randomUUID();
    const now = Date.now();

    await db.insert(schema.repositories).values({
      id,
      code: "default-country",
      name: "Colombian Repo",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, id));

    expect(row.countryCode).toBe("COL");
  });

  it("enabled defaults to true", async () => {
    const id = crypto.randomUUID();
    const now = Date.now();

    await db.insert(schema.repositories).values({
      id,
      code: "enabled-default",
      name: "Enabled Repo",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, id));

    expect(row.enabled).toBe(true);
  });
});
