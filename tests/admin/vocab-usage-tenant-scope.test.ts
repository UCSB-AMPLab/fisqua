/**
 * Tests — vocabulary usage counts stay inside the request tenant
 *
 * The entity-role and place-role junctions carry no tenant of their
 * own, so the vocabularies landing page and the enum detail page count
 * their usage through each link's description. This suite links one
 * shared entity and one shared place to a description in each of two
 * tenants, under different roles, and pins that each tenant's pages
 * count only its own links:
 *
 *   - the landing page's distinct entity-role and place-role counts;
 *   - the enum page's per-role usage for entity roles and place roles.
 *
 * Every value here is a test value.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedFederations,
  seedTenants,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestEntity } from "../helpers/entities";
import { createTestPlace } from "../helpers/places";
import { tenantContext, userContext } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { loader as landingLoader } from "../../app/routes/_auth.admin.vocabularies._index";
import { loader as enumsLoader } from "../../app/routes/_auth.admin.vocabularies.enums";

function context(tenantId: string): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, makeUserContext({ tenantId, isRecordsAdmin: true }));
  ctx.set(tenantContext, makeTenantContext({ id: tenantId }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function link(tenantId: string, entityId: string, placeId: string, entityRole: string, placeRole: string) {
  const db = drizzle(env.DB, { schema });
  const repo = await createTestRepository({ tenantId, code: `repo-${tenantId.slice(0, 4)}` });
  const description = await createTestDescription({ tenantId, repositoryId: repo.id });
  const now = Date.now();
  await db.insert(schema.descriptionEntities).values({
    id: crypto.randomUUID(),
    descriptionId: description.id,
    entityId,
    role: entityRole as (typeof schema.descriptionEntities.$inferInsert)["role"],
    createdAt: now,
  });
  await db.insert(schema.descriptionPlaces).values({
    id: crypto.randomUUID(),
    descriptionId: description.id,
    placeId,
    role: placeRole as (typeof schema.descriptionPlaces.$inferInsert)["role"],
    createdAt: now,
  });
}

async function enumCounts(tenantId: string, vocab: string): Promise<Record<string, number>> {
  const data = (await enumsLoader({
    request: new Request(`http://test.fisqua.test/admin/vocabularies/enums?vocab=${vocab}`),
    context: context(tenantId),
    params: {},
  } as any)) as { terms: { value: string; count: number }[] };
  return Object.fromEntries(data.terms.filter((t) => t.count > 0).map((t) => [t.value, t.count]));
}

describe("vocabulary usage counts and the request tenant", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    const entity = await createTestEntity({});
    const place = await createTestPlace({});
    await link(DEFAULT_TEST_TENANT_ID, entity.id, place.id, "creator", "created");
    await link(SECOND_TEST_TENANT_ID, entity.id, place.id, "recipient", "sent_to");
  });

  it("the landing page counts only this tenant's distinct roles", async () => {
    const data = (await landingLoader({
      request: new Request("http://test.fisqua.test/admin/vocabularies"),
      context: context(DEFAULT_TEST_TENANT_ID),
      params: {},
    } as any)) as { entityRoles: number; placeRoles: number };
    expect(data.entityRoles).toBe(1);
    expect(data.placeRoles).toBe(1);
  });

  it("the enum page counts only this tenant's role usage", async () => {
    expect(await enumCounts(DEFAULT_TEST_TENANT_ID, "entity-roles")).toEqual({ creator: 1 });
    expect(await enumCounts(DEFAULT_TEST_TENANT_ID, "place-roles")).toEqual({ created: 1 });
    expect(await enumCounts(SECOND_TEST_TENANT_ID, "entity-roles")).toEqual({ recipient: 1 });
    expect(await enumCounts(SECOND_TEST_TENANT_ID, "place-roles")).toEqual({ sent_to: 1 });
  });
});
