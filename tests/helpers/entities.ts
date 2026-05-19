/**
 * Tests — entities
 *
 * This helper module wraps entity-row creation for the test suite.
 * Every entity row carries a tenant_id NOT NULL FK to tenants(id),
 * so tests must call seedTenants() before invoking this helper.
 * Defaults to DEFAULT_TEST_TENANT_ID.
 *
 * @version v0.4.0
 */
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:test";
import * as schema from "../../app/db/schema";
import { DEFAULT_TEST_TENANT_ID } from "./db";

export async function createTestEntity(overrides: Partial<{
  id: string;
  tenantId: string;
  entityCode: string;
  displayName: string;
  sortName: string;
  surname: string;
  givenName: string;
  entityType: string;
  honorific: string;
  primaryFunction: string;
  nameVariants: string;
  datesOfExistence: string;
  mergedInto: string;
  wikidataId: string;
  viafId: string;
}> = {}) {
  const db = drizzle(env.DB);
  const now = Date.now();
  const id = overrides.id ?? crypto.randomUUID();
  const values = {
    id,
    tenantId: overrides.tenantId ?? DEFAULT_TEST_TENANT_ID,
    entityCode: overrides.entityCode ?? "ne-test01",
    displayName: overrides.displayName ?? "Test Entity",
    sortName: overrides.sortName ?? "Entity, Test",
    surname: overrides.surname ?? undefined,
    givenName: overrides.givenName ?? undefined,
    entityType: (overrides.entityType ?? "person") as
      (typeof schema.entities.$inferInsert)["entityType"],
    honorific: overrides.honorific ?? undefined,
    primaryFunction: overrides.primaryFunction ?? undefined,
    nameVariants: overrides.nameVariants ?? "[]",
    datesOfExistence: overrides.datesOfExistence ?? undefined,
    mergedInto: overrides.mergedInto ?? undefined,
    wikidataId: overrides.wikidataId ?? undefined,
    viafId: overrides.viafId ?? undefined,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(schema.entities).values(values);
  return values;
}
