/**
 * Tests — description links stay inside the request tenant
 *
 * This suite checks that description links stay inside the request
 * tenant. The description, entity and place pages each change the
 * junctions that link a description to an entity or a place. A link row
 * is named by id in the posted form, so these routes must reach it only
 * through a description of the request tenant and the record the page
 * addresses. Two tenants share an entity and a place; each has a
 * description linked to both. Acting as a workspace admin of the first
 * tenant, this suite pins that:
 *
 *   - on the description page, updating, removing or reordering the
 *     second tenant's link 404s and leaves it as it was; linking from
 *     another tenant's description, or naming one in the form, 404s;
 *     an entity private to the second tenant cannot be linked;
 *   - on the entity and place pages, editing or unlinking the second
 *     tenant's link 404s and leaves it, and linking the second tenant's
 *     description 404s and writes nothing;
 *   - the same intents on the tenant's own links still work;
 *   - the entity and place detail pages list, count and open only the
 *     tenant's own linked descriptions, and the other tenant's link id
 *     opens no card and answers 404 for its full transcript.
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
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestEntity } from "../helpers/entities";
import { createTestPlace } from "../helpers/places";
import { tenantContext, userContext } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { action as descriptionAction } from "../../app/routes/_auth.admin.descriptions.$id";
import { action as entityAction, loader as entityLoader } from "../../app/routes/_auth.admin.entities.$id";
import { action as placeAction, loader as placeLoader } from "../../app/routes/_auth.admin.places.$id";
import { seedPage } from "../helpers/ocr-fixtures";

const A = DEFAULT_TEST_TENANT_ID;
const B = SECOND_TEST_TENANT_ID;

function db() {
  return drizzle(env.DB, { schema });
}

function context(): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, makeUserContext({ tenantId: A, isAdmin: true }));
  ctx.set(tenantContext, makeTenantContext({ id: A }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function post(
  action: (args: any) => Promise<unknown>,
  id: string,
  fields: Record<string, string>,
): Promise<number> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  try {
    await action({
      request: new Request("http://neogranadina.fisqua.test/admin/x", { method: "POST", body: form }),
      context: context(),
      params: { id },
    });
    return 200;
  } catch (e) {
    if (e instanceof Response) return e.status;
    throw e;
  }
}

let world: {
  entityId: string;
  placeId: string;
  privateEntityId: string;
  descA: string;
  descB: string;
  entityLinkA: string;
  entityLinkB: string;
  placeLinkA: string;
  placeLinkB: string;
};

async function seed() {
  const entity = await createTestEntity({ entityCode: "ne-shared-1" });
  const privateEntity = await createTestEntity({ entityCode: "ne-private-1" });
  await env.DB.prepare("UPDATE entities SET tenant_id = ? WHERE id = ?").bind(B, privateEntity.id).run();
  const place = await createTestPlace({});
  const repoA = await createTestRepository({ tenantId: A, code: "repo-a" });
  const repoB = await createTestRepository({ tenantId: B, code: "repo-b" });
  const descA = await createTestDescription({ tenantId: A, repositoryId: repoA.id });
  const descB = await createTestDescription({ tenantId: B, repositoryId: repoB.id });
  const now = Date.now();
  const ids = {
    entityLinkA: crypto.randomUUID(),
    entityLinkB: crypto.randomUUID(),
    placeLinkA: crypto.randomUUID(),
    placeLinkB: crypto.randomUUID(),
  };
  await db().insert(schema.descriptionEntities).values([
    { id: ids.entityLinkA, descriptionId: descA.id, entityId: entity.id, role: "creator", sequence: 0, createdAt: now },
    { id: ids.entityLinkB, descriptionId: descB.id, entityId: entity.id, role: "creator", sequence: 0, createdAt: now },
  ]);
  await db().insert(schema.descriptionPlaces).values([
    { id: ids.placeLinkA, descriptionId: descA.id, placeId: place.id, role: "created", createdAt: now },
    { id: ids.placeLinkB, descriptionId: descB.id, placeId: place.id, role: "created", createdAt: now },
  ]);
  world = {
    entityId: entity.id,
    placeId: place.id,
    privateEntityId: privateEntity.id,
    descA: descA.id,
    descB: descB.id,
    ...ids,
  };
}

async function entityLink(id: string) {
  return db().select().from(schema.descriptionEntities).where(eq(schema.descriptionEntities.id, id)).get();
}
async function placeLink(id: string) {
  return db().select().from(schema.descriptionPlaces).where(eq(schema.descriptionPlaces.id, id)).get();
}
async function linkCounts() {
  const e = await db().select().from(schema.descriptionEntities).all();
  const p = await db().select().from(schema.descriptionPlaces).all();
  return { entities: e.length, places: p.length };
}

describe("description links and the request tenant", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    await seed();
  });

  describe("the description page", () => {
    it("refuses to update, remove or reorder another tenant's links", async () => {
      expect(await post(descriptionAction, world.descA, {
        _action: "update_entity_link", linkId: world.entityLinkB, role: "author",
      })).toBe(404);
      expect(await post(descriptionAction, world.descA, {
        _action: "remove_entity_link", linkId: world.entityLinkB,
      })).toBe(404);
      expect(await post(descriptionAction, world.descA, {
        _action: "update_place_link", linkId: world.placeLinkB, role: "subject",
      })).toBe(404);
      expect(await post(descriptionAction, world.descA, {
        _action: "remove_place_link", linkId: world.placeLinkB,
      })).toBe(404);
      await post(descriptionAction, world.descA, {
        _action: "reorder_entity_link", linkId: world.entityLinkB, direction: "down",
      });
      expect((await entityLink(world.entityLinkB))?.role).toBe("creator");
      expect((await entityLink(world.entityLinkB))?.sequence).toBe(0);
      expect((await placeLink(world.placeLinkB))?.role).toBe("created");
    });

    it("refuses another tenant's description, in the path or in the form", async () => {
      expect(await post(descriptionAction, world.descB, {
        _action: "remove_entity_link", linkId: world.entityLinkB,
      })).toBe(404);
      expect(await post(descriptionAction, world.descA, {
        _action: "link_entity", descriptionId: world.descB, entityId: world.entityId, role: "author",
      })).toBe(404);
      expect(await post(descriptionAction, world.descA, {
        _action: "link_place", descriptionId: world.descB, placeId: world.placeId, role: "subject",
      })).toBe(404);
      expect(await entityLink(world.entityLinkB)).toBeDefined();
      expect(await linkCounts()).toEqual({ entities: 2, places: 2 });
    });

    it("refuses to link an entity private to another tenant", async () => {
      expect(await post(descriptionAction, world.descA, {
        _action: "link_entity", descriptionId: world.descA, entityId: world.privateEntityId, role: "author",
      })).toBe(404);
      expect(await linkCounts()).toEqual({ entities: 2, places: 2 });
    });

    it("still changes the tenant's own links", async () => {
      expect(await post(descriptionAction, world.descA, {
        _action: "update_entity_link", linkId: world.entityLinkA, role: "author",
      })).toBe(200);
      expect((await entityLink(world.entityLinkA))?.role).toBe("author");
      expect(await post(descriptionAction, world.descA, {
        _action: "remove_place_link", linkId: world.placeLinkA,
      })).toBe(200);
      expect(await placeLink(world.placeLinkA)).toBeUndefined();
    });
  });

  describe("the entity and place pages", () => {
    it("refuse to edit or unlink another tenant's links", async () => {
      expect(await post(entityAction, world.entityId, {
        _action: "edit_description_link", linkId: world.entityLinkB, role: "author",
      })).toBe(404);
      expect(await post(entityAction, world.entityId, {
        _action: "unlink_description", linkId: world.entityLinkB,
      })).toBe(404);
      expect(await post(placeAction, world.placeId, {
        _action: "edit_description_link", linkId: world.placeLinkB, role: "subject",
      })).toBe(404);
      expect(await post(placeAction, world.placeId, {
        _action: "unlink_description", linkId: world.placeLinkB,
      })).toBe(404);
      expect((await entityLink(world.entityLinkB))?.role).toBe("creator");
      expect((await placeLink(world.placeLinkB))?.role).toBe("created");
    });

    it("refuse to link another tenant's description", async () => {
      expect(await post(entityAction, world.entityId, {
        _action: "link_description", descriptionId: world.descB, role: "author",
      })).toBe(404);
      expect(await post(placeAction, world.placeId, {
        _action: "link_description", descriptionId: world.descB, role: "subject",
      })).toBe(404);
      expect(await linkCounts()).toEqual({ entities: 2, places: 2 });
    });

    it("refuse an entity private to another tenant", async () => {
      expect(await post(entityAction, world.privateEntityId, {
        _action: "link_description", descriptionId: world.descA, role: "author",
      })).toBe(404);
      expect(await linkCounts()).toEqual({ entities: 2, places: 2 });
    });

    it("still change the tenant's own links", async () => {
      expect(await post(entityAction, world.entityId, {
        _action: "edit_description_link", linkId: world.entityLinkA, role: "author",
      })).toBe(200);
      expect((await entityLink(world.entityLinkA))?.role).toBe("author");
      expect(await post(placeAction, world.placeId, {
        _action: "unlink_description", linkId: world.placeLinkA,
      })).toBe(200);
      expect(await placeLink(world.placeLinkA)).toBeUndefined();
    });
  });

  describe("the entity and place detail pages", () => {
    async function load(
      loader: (args: any) => Promise<unknown>,
      id: string,
      query = "",
    ): Promise<{ status: number; data: any }> {
      try {
        const data = await loader({
          request: new Request(`http://neogranadina.fisqua.test/admin/x/${id}${query}`),
          context: context(),
          params: { id },
        });
        return {
          status: 200,
          data: data instanceof Response ? await data.json() : data,
        };
      } catch (e) {
        if (e instanceof Response) return { status: e.status, data: null };
        throw e;
      }
    }

    it("list, count and open only this tenant's linked descriptions", async () => {
      await seedPage({ descriptionId: world.descB, tenantId: B, pageSeq: 1, text: "texto del otro archivo" });
      for (const [loader, id, linkA, linkB] of [
        [entityLoader, world.entityId, world.entityLinkA, world.entityLinkB],
        [placeLoader, world.placeId, world.placeLinkA, world.placeLinkB],
      ] as const) {
        const page = await load(loader, id);
        expect(page.status).toBe(200);
        expect(page.data.descLinkCount).toBe(1);
        expect(page.data.total).toBe(1);
        expect(page.data.links.map((l: { id: string }) => l.id)).toEqual([linkA]);
        expect(JSON.stringify(page.data)).not.toContain(world.descB);

        // The other tenant's link id opens no card and no transcript.
        const card = await load(loader, id, `?card=${linkB}`);
        expect(card.data.card).toBeNull();
        expect((await load(loader, id, `?card=${linkB}&full=1`)).status).toBe(404);
        // The tenant's own link still opens.
        expect((await load(loader, id, `?card=${linkA}`)).data.card.descriptionId).toBe(world.descA);
      }
    });
  });
});

