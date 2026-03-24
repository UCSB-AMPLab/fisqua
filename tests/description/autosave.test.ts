import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
} from "vitest";
import { eq } from "drizzle-orm";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { saveDescription } from "../../app/lib/description.server";

describe("Description autosave (DESC-06)", () => {
  let db: ReturnType<typeof drizzle>;
  let entryId: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });

    const user = await createTestUser({ isAdmin: false });
    const now = Date.now();

    const projectId = crypto.randomUUID();
    const volumeId = crypto.randomUUID();
    entryId = crypto.randomUUID();

    await db.insert(schema.projects).values({
      id: projectId,
      name: "Test Project",
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(schema.projectMembers).values({
      id: crypto.randomUUID(),
      projectId,
      userId: user.id,
      role: "cataloguer",
      createdAt: now,
    });

    await db.insert(schema.volumes).values({
      id: volumeId,
      projectId,
      name: "Test Volume",
      referenceCode: "co-test-vol001",
      manifestUrl: "https://example.com/manifest.json",
      pageCount: 10,
      status: "approved",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(schema.entries).values({
      id: entryId,
      volumeId,
      position: 0,
      startPage: 1,
      startY: 0,
      type: "item",
      descriptionStatus: "in_progress",
      assignedDescriber: user.id,
      createdAt: now,
      updatedAt: now,
    });
  });

  test("saveDescription persists a single field change", async () => {
    await saveDescription(db, entryId, { scopeContent: "New content" });

    const [entry] = await db
      .select({ scopeContent: schema.entries.scopeContent })
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId))
      .all();

    expect(entry.scopeContent).toBe("New content");
  });

  test("saveDescription applies all fields in the fields object", async () => {
    // First save with two fields
    await saveDescription(db, entryId, {
      scopeContent: "Content",
      language: "es",
    });

    const [after1] = await db
      .select({
        scopeContent: schema.entries.scopeContent,
        language: schema.entries.language,
      })
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId))
      .all();

    expect(after1.scopeContent).toBe("Content");
    expect(after1.language).toBe("es");

    // Second save with all three fields — saveDescription replaces all
    // DescriptionFields (missing ones become null via ?? null)
    await saveDescription(db, entryId, {
      scopeContent: "Updated content",
      language: "es",
      dateExpression: "1921",
    });

    const [after2] = await db
      .select({
        scopeContent: schema.entries.scopeContent,
        language: schema.entries.language,
        dateExpression: schema.entries.dateExpression,
      })
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId))
      .all();

    expect(after2.scopeContent).toBe("Updated content");
    expect(after2.language).toBe("es");
    expect(after2.dateExpression).toBe("1921");
  });

  test("saveDescription updates the updatedAt timestamp", async () => {
    const [before] = await db
      .select({ updatedAt: schema.entries.updatedAt })
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId))
      .all();

    const originalUpdatedAt = before.updatedAt;

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 10));

    await saveDescription(db, entryId, { language: "en" });

    const [after] = await db
      .select({ updatedAt: schema.entries.updatedAt })
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId))
      .all();

    expect(after.updatedAt).toBeGreaterThan(originalUpdatedAt);
  });

  test("sequential saves apply latest values (last-write-wins)", async () => {
    await saveDescription(db, entryId, {
      scopeContent: "Version A",
      language: "es",
    });

    await saveDescription(db, entryId, {
      scopeContent: "Version B",
      language: "es",
    });

    const [entry] = await db
      .select({ scopeContent: schema.entries.scopeContent })
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId))
      .all();

    expect(entry.scopeContent).toBe("Version B");
  });
});
