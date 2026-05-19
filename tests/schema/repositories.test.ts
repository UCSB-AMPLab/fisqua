/**
 * Tests — repositories schema
 *
 * This suite pins the structural shape of the `repositories` table — the
 * top-level grouping unit that every description hangs off. Four pins:
 * required fields on insert, the unique constraint on `code` (the
 * stable external identifier used in URLs and EAD exports), the
 * `countryCode` default of `'COL'` reflecting Fisqua's Colombian
 * archival focus, and the `enabled` default of `true` so newly created
 * repositories are visible without an extra activation step.
 *
 * The `countryCode = 'COL'` default is a deliberate stance, not a
 * technical default — Fisqua's primary deployment is Colombian
 * archives, and the dominant case should require no override. Repos
 * outside Colombia override it explicitly.
 *
 * @version v0.4.0
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
import { DEFAULT_TEST_TENANT_ID, applyMigrations, cleanDatabase } from "../helpers/db";

describe("repositories table", () => {
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
      tenantId: DEFAULT_TEST_TENANT_ID,
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
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: crypto.randomUUID(),
      code: "unique-code",
      name: "First Repository",
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      db.insert(schema.repositories).values({
        tenantId: DEFAULT_TEST_TENANT_ID,
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
      tenantId: DEFAULT_TEST_TENANT_ID,
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
      tenantId: DEFAULT_TEST_TENANT_ID,
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
