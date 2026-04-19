/**
 * Tests — entities
 *
 * @version v0.3.0
 */
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:test";
import * as schema from "../../app/db/schema";

export async function createTestEntity(overrides: Partial<{
  id: string;
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
    entityCode: overrides.entityCode ?? "ne-test01",
    displayName: overrides.displayName ?? "Test Entity",
    sortName: overrides.sortName ?? "Entity, Test",
    surname: overrides.surname ?? undefined,
    givenName: overrides.givenName ?? undefined,
    entityType: overrides.entityType ?? "person",
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
