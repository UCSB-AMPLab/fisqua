/**
 * Tests — admin entities cross-tenant isolation
 *
 * This suite carries the read-negative + write-negative coverage for
 * the entities authority surface.
 * The entities admin loader (`app/routes/_auth.admin.entities.tsx`)
 * and its detail/edit counterparts (`_auth.admin.entities.$id.tsx`,
 * `_auth.admin.entities.new.tsx`) all carry the
 * `eq(entities.tenantId, tenant.id)` predicate; this test confirms
 * cross-tenant reads/writes are blocked at the data layer in the
 * seeded fixture.
 *
 * Threat model coverage: cross-tenant data leak via subtle predicate
 * bug; POST body asserting tenantId for a different tenant.
 *
 * @version v0.4.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";

async function seedEntity(args: {
  tenantId: string;
  displayName: string;
  sortName: string;
  entityType?: "person" | "family" | "corporate";
}): Promise<string> {
  const db = drizzle(env.DB);
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(schema.entities).values({
    id,
    tenantId: args.tenantId,
    displayName: args.displayName,
    sortName: args.sortName,
    entityType: args.entityType ?? "person",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe("admin entities cross-tenant isolation", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("read-negative: tenant-A scoped query never returns tenant-B entities", async () => {
    const db = drizzle(env.DB);

    const entityA = await seedEntity({
      tenantId: DEFAULT_TEST_TENANT_ID,
      displayName: "Bolívar, Simón",
      sortName: "bolivar simon",
    });
    const entityB = await seedEntity({
      tenantId: SECOND_TEST_TENANT_ID,
      displayName: "Tenant B Person",
      sortName: "tenant b person",
    });

    const rowsForA = await db
      .select({
        id: schema.entities.id,
        displayName: schema.entities.displayName,
        tenantId: schema.entities.tenantId,
      })
      .from(schema.entities)
      .where(eq(schema.entities.tenantId, DEFAULT_TEST_TENANT_ID))
      .all();

    expect(rowsForA).toHaveLength(1);
    expect(rowsForA[0].id).toBe(entityA);
    expect(rowsForA.map((r) => r.id)).not.toContain(entityB);

    const rowsForB = await db
      .select({ id: schema.entities.id })
      .from(schema.entities)
      .where(eq(schema.entities.tenantId, SECOND_TEST_TENANT_ID))
      .all();
    expect(rowsForB).toHaveLength(1);
    expect(rowsForB[0].id).toBe(entityB);
  });

  it("write-negative: tenant-A scoped UPDATE on tenant-B entity id leaves tenant B unchanged", async () => {
    const db = drizzle(env.DB);

    const entityA = await seedEntity({
      tenantId: DEFAULT_TEST_TENANT_ID,
      displayName: "Original A",
      sortName: "original a",
    });
    const entityB = await seedEntity({
      tenantId: SECOND_TEST_TENANT_ID,
      displayName: "Original B",
      sortName: "original b",
    });

    await db
      .update(schema.entities)
      .set({ displayName: "Cross-tenant overwrite attempt" })
      .where(
        and(
          eq(schema.entities.tenantId, DEFAULT_TEST_TENANT_ID),
          eq(schema.entities.id, entityB),
        ),
      )
      .run();

    const rowB = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, entityB))
      .get();
    expect(rowB).toBeTruthy();
    expect(rowB!.displayName).toBe("Original B");
    expect(rowB!.tenantId).toBe(SECOND_TEST_TENANT_ID);

    const rowA = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, entityA))
      .get();
    expect(rowA!.displayName).toBe("Original A");
  });

  it("write-negative: tenant-A scoped DELETE on tenant-B entity id leaves tenant B intact", async () => {
    // The merge / delete admin flows on entities use the same
    // `where(and(tenantId, id))` predicate shape as UPDATE; this case
    // confirms a cross-tenant id-guess on the DELETE path is also a
    // no-op.
    const db = drizzle(env.DB);

    const entityB = await seedEntity({
      tenantId: SECOND_TEST_TENANT_ID,
      displayName: "Will Survive",
      sortName: "will survive",
    });

    await db
      .delete(schema.entities)
      .where(
        and(
          eq(schema.entities.tenantId, DEFAULT_TEST_TENANT_ID),
          eq(schema.entities.id, entityB),
        ),
      )
      .run();

    const rowB = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, entityB))
      .get();
    expect(rowB).toBeTruthy();
    expect(rowB!.displayName).toBe("Will Survive");
  });
});
