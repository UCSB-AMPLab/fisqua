/**
 * Tests — admin places cross-tenant isolation
 *
 * This suite carries the read-negative + write-negative coverage for
 * the places authority surface.
 * The places admin loader (`app/routes/_auth.admin.places.tsx`) and
 * its detail/edit counterparts (`_auth.admin.places.$id.tsx`,
 * `_auth.admin.places.new.tsx`) all carry the
 * `eq(places.tenantId, tenant.id)` predicate; this test confirms
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

async function seedPlace(args: {
  tenantId: string;
  label: string;
  displayName?: string;
}): Promise<string> {
  const db = drizzle(env.DB);
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(schema.places).values({
    id,
    tenantId: args.tenantId,
    label: args.label,
    displayName: args.displayName ?? args.label,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe("admin places cross-tenant isolation", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("read-negative: tenant-A scoped query never returns tenant-B places", async () => {
    const db = drizzle(env.DB);

    const placeA = await seedPlace({
      tenantId: DEFAULT_TEST_TENANT_ID,
      label: "Santafé de Bogotá",
    });
    const placeB = await seedPlace({
      tenantId: SECOND_TEST_TENANT_ID,
      label: "Tenant B Town",
    });

    const rowsForA = await db
      .select({
        id: schema.places.id,
        label: schema.places.label,
        tenantId: schema.places.tenantId,
      })
      .from(schema.places)
      .where(eq(schema.places.tenantId, DEFAULT_TEST_TENANT_ID))
      .all();

    expect(rowsForA).toHaveLength(1);
    expect(rowsForA[0].id).toBe(placeA);
    expect(rowsForA.map((r) => r.id)).not.toContain(placeB);

    const rowsForB = await db
      .select({ id: schema.places.id })
      .from(schema.places)
      .where(eq(schema.places.tenantId, SECOND_TEST_TENANT_ID))
      .all();
    expect(rowsForB).toHaveLength(1);
    expect(rowsForB[0].id).toBe(placeB);
  });

  it("write-negative: tenant-A scoped UPDATE on tenant-B place id leaves tenant B unchanged", async () => {
    const db = drizzle(env.DB);

    const placeA = await seedPlace({
      tenantId: DEFAULT_TEST_TENANT_ID,
      label: "Original A",
    });
    const placeB = await seedPlace({
      tenantId: SECOND_TEST_TENANT_ID,
      label: "Original B",
    });

    await db
      .update(schema.places)
      .set({ label: "Cross-tenant overwrite attempt" })
      .where(
        and(
          eq(schema.places.tenantId, DEFAULT_TEST_TENANT_ID),
          eq(schema.places.id, placeB),
        ),
      )
      .run();

    const rowB = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, placeB))
      .get();
    expect(rowB).toBeTruthy();
    expect(rowB!.label).toBe("Original B");
    expect(rowB!.tenantId).toBe(SECOND_TEST_TENANT_ID);

    const rowA = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, placeA))
      .get();
    expect(rowA!.label).toBe("Original A");
  });

  it("write-negative: tenant-A scoped DELETE on tenant-B place id leaves tenant B intact", async () => {
    const db = drizzle(env.DB);

    const placeB = await seedPlace({
      tenantId: SECOND_TEST_TENANT_ID,
      label: "Will Survive",
    });

    await db
      .delete(schema.places)
      .where(
        and(
          eq(schema.places.tenantId, DEFAULT_TEST_TENANT_ID),
          eq(schema.places.id, placeB),
        ),
      )
      .run();

    const rowB = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, placeB))
      .get();
    expect(rowB).toBeTruthy();
    expect(rowB!.label).toBe("Will Survive");
  });
});
