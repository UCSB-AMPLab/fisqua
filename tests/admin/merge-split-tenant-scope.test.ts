/**
 * Tests — merges and splits move only the request tenant's links
 *
 * A shared entity or place can be linked from descriptions in several
 * tenants of its federation. The merge workbench, the split workbench
 * and the pair merge on the decisions surface each move links from one
 * record to another. This suite gives a shared record one link from the
 * acting tenant and one from a second tenant, has a workspace admin of
 * the federation's lead tenant (a steward of the shared space) merge or
 * split it naming both link ids, and pins that:
 *
 *   - the acting tenant's link moves (or, on a collision with the
 *     survivor, is dropped as before);
 *   - the second tenant's link stays exactly as it was, on the record
 *     merged away or split, even when the form names its id and even
 *     when the survivor already holds the same description and role;
 *   - the pair merge, which names no link ids, leaves the second
 *     tenant's link where it was.
 *
 * Every value here is a test value.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
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
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestEntity } from "../helpers/entities";
import { createTestPlace } from "../helpers/places";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { action as entityMerge } from "../../app/routes/_auth.admin.entities.$id.merge";
import { action as placeMerge } from "../../app/routes/_auth.admin.places.$id.merge";
import { action as entitySplit } from "../../app/routes/_auth.admin.entities.$id.split";
import { action as placeSplit } from "../../app/routes/_auth.admin.places.$id.split";
import { rulePairMerge } from "../../app/lib/pair-merge.server";

const A = DEFAULT_TEST_TENANT_ID;
const B = SECOND_TEST_TENANT_ID;

function db() {
  return drizzle(env.DB, { schema });
}

let admin: User;

function context(): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, admin);
  ctx.set(tenantContext, makeTenantContext({ id: A }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function post(action: (args: any) => Promise<unknown>, id: string, fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return action({
    request: new Request("http://neogranadina.fisqua.test/admin/x", { method: "POST", body: form }),
    context: context(),
    params: { id },
  });
}

let descA: string;
let descB: string;

async function seedDescriptions() {
  const repoA = await createTestRepository({ tenantId: A, code: "repo-a" });
  const repoB = await createTestRepository({ tenantId: B, code: "repo-b" });
  descA = (await createTestDescription({ tenantId: A, repositoryId: repoA.id })).id;
  descB = (await createTestDescription({ tenantId: B, repositoryId: repoB.id })).id;
}

async function entityLinkRow(id: string) {
  return db().select().from(schema.descriptionEntities).where(eq(schema.descriptionEntities.id, id)).get();
}
async function placeLinkRow(id: string) {
  return db().select().from(schema.descriptionPlaces).where(eq(schema.descriptionPlaces.id, id)).get();
}

async function entityLink(id: string, descriptionId: string, entityId: string) {
  await db().insert(schema.descriptionEntities).values({
    id, descriptionId, entityId, role: "creator", sequence: 0, createdAt: Date.now(),
  });
}
async function placeLink(id: string, descriptionId: string, placeId: string) {
  await db().insert(schema.descriptionPlaces).values({
    id, descriptionId, placeId, role: "created", createdAt: Date.now(),
  });
}

describe("merges and splits and the request tenant", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    const row = await createTestUser({ isAdmin: true });
    admin = makeUserContext({ id: row.id, tenantId: A, isAdmin: true });
    await seedDescriptions();
  });

  it("the entity merge moves this tenant's link and leaves the other tenant's", async () => {
    const survivor = await createTestEntity({ entityCode: "ne-sv-1" });
    const loser = await createTestEntity({ entityCode: "ne-ls-1" });
    await entityLink("la", descA, loser.id);
    await entityLink("lb", descB, loser.id);
    // The survivor already holds B's description under the same role, so
    // B's link would be dropped as a collision if it were processed.
    await entityLink("sb", descB, survivor.id);

    await post(entityMerge, loser.id, {
      reason: "same person",
      loserId: loser.id,
      survivorId: survivor.id,
      linkIds: JSON.stringify(["la", "lb"]),
    });
    expect((await entityLinkRow("la"))?.entityId).toBe(survivor.id);
    expect((await entityLinkRow("lb"))?.entityId).toBe(loser.id);
    expect((await entityLinkRow("sb"))?.entityId).toBe(survivor.id);
  });

  it("the place merge moves this tenant's link and leaves the other tenant's", async () => {
    const survivor = await createTestPlace({ placeCode: "nl-sv-1" });
    const loser = await createTestPlace({ placeCode: "nl-ls-1" });
    await placeLink("pa", descA, loser.id);
    await placeLink("pb", descB, loser.id);
    await placeLink("ps", descB, survivor.id);

    await post(placeMerge, loser.id, {
      reason: "same place",
      loserId: loser.id,
      survivorId: survivor.id,
      linkIds: JSON.stringify(["pa", "pb"]),
    });
    expect((await placeLinkRow("pa"))?.placeId).toBe(survivor.id);
    expect((await placeLinkRow("pb"))?.placeId).toBe(loser.id);
    expect((await placeLinkRow("ps"))?.placeId).toBe(survivor.id);
  });

  it("the entity split moves this tenant's link and leaves the other tenant's", async () => {
    const source = await createTestEntity({ entityCode: "ne-sp-1", displayName: "Two People" });
    await entityLink("la", descA, source.id);
    await entityLink("lb", descB, source.id);

    await post(entitySplit, source.id, {
      reason: "two people",
      nameA: "First",
      nameB: "Second",
      choices: JSON.stringify({
        datesOfExistence: "original",
        history: "original",
        wikidataId: "original",
        viafId: "original",
        dbeId: "original",
      }),
      linkIds: JSON.stringify(["la", "lb"]),
    });
    expect((await entityLinkRow("la"))?.entityId).not.toBe(source.id);
    expect((await entityLinkRow("lb"))?.entityId).toBe(source.id);
  });

  it("the place split moves this tenant's link and leaves the other tenant's", async () => {
    const source = await createTestPlace({ placeCode: "nl-sp-1", displayName: "Two Places" });
    await placeLink("pa", descA, source.id);
    await placeLink("pb", descB, source.id);

    await post(placeSplit, source.id, {
      reason: "two places",
      nameA: "North",
      nameB: "South",
      choices: JSON.stringify({
        coordinates: "original",
        tgnId: "original",
        hgisId: "original",
        whgId: "original",
      }),
      linkIds: JSON.stringify(["pa", "pb"]),
    });
    expect((await placeLinkRow("pa"))?.placeId).not.toBe(source.id);
    expect((await placeLinkRow("pb"))?.placeId).toBe(source.id);
  });

  it("the pair merge moves this tenant's links and leaves the other tenant's", async () => {
    const survivor = await createTestEntity({ entityCode: "ne-pv-1" });
    const loser = await createTestEntity({ entityCode: "ne-pl-1" });
    await entityLink("la", descA, loser.id);
    await entityLink("lb", descB, loser.id);
    await entityLink("sb", descB, survivor.id);

    const result = await rulePairMerge(
      db(),
      admin,
      makeTenantContext({ id: A }),
      "entity",
      survivor.id,
      loser.id,
      "same person",
    );
    expect(result.movedLinks).toBe(1);
    expect(result.droppedLinks).toBe(0);
    expect((await entityLinkRow("la"))?.entityId).toBe(survivor.id);
    expect((await entityLinkRow("lb"))?.entityId).toBe(loser.id);
    expect((await entityLinkRow("sb"))?.entityId).toBe(survivor.id);
  });
});
