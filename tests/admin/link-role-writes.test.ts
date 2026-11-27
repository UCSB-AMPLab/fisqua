/**
 * Tests — the role a link is written with, checked against the federation's list
 *
 * This suite pins that the link forms of the description page, the entity
 * page and the place page write a role only when the federation's list
 * holds it approved, checked inside the write statement, and that an edit
 * may keep the link's current code even when the list does not approve it.
 * It pins that for the six actions that write a role (`link_entity`,
 * `update_entity_link`, `link_place`, `update_place_link` on the
 * description page; `link_description` and `edit_description_link` on the
 * entity and place pages):
 *
 *   - a code the federation approves and the constants lack is written
 *     by each action that creates a link;
 *   - each edit saves a change that keeps such a code;
 *   - a code outside the approved list is refused with the page's
 *     generic error and nothing written, including a code deprecated
 *     after the page was read;
 *   - an edit that keeps a deprecated current code saves, and one that
 *     moves to a deprecated code is refused;
 *   - the check is part of the write statement itself.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
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
  DEFAULT_TEST_FEDERATION_ID,
} from "../helpers/db";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestEntity } from "../helpers/entities";
import { createTestPlace } from "../helpers/places";
import { createTestUser } from "../helpers/auth";
import { roleSetRows, seedRoleLists } from "../helpers/vocabulary";
import { tenantContext, userContext } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { action as descriptionAction } from "../../app/routes/_auth.admin.descriptions.$id";
import { action as entityAction } from "../../app/routes/_auth.admin.entities.$id";
import { action as placeAction } from "../../app/routes/_auth.admin.places.$id";
import { insertEntityLink } from "../../app/lib/link-roles.server";
import { NEOGRANADINA_ROLES } from "../../scripts/data/vocabularies/neogranadina-roles";

const A = DEFAULT_TEST_TENANT_ID;
const F = DEFAULT_TEST_FEDERATION_ID;
const db = () => drizzle(env.DB, { schema });

let userId: string;
let world: { desc: string; entity: string; other: string; place: string; otherPlace: string };

function context(): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, makeUserContext({ id: userId, tenantId: A, isAdmin: true }));
  ctx.set(tenantContext, makeTenantContext({ id: A }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function post(action: (args: any) => Promise<unknown>, id: string, fields: Record<string, string>): Promise<any> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return action({
    request: new Request("http://neogranadina.fisqua.test/admin/x", { method: "POST", body: form }),
    context: context(),
    params: { id },
  });
}

const entityLinks = () => db().select().from(schema.descriptionEntities).all();
const placeLinks = () => db().select().from(schema.descriptionPlaces).all();

async function entityLink(role: string, entityId = world.entity): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO description_entities (id, description_id, entity_id, role, sequence, attributes, created_at) VALUES (?, ?, ?, ?, 0, '{}', ?)",
  ).bind(id, world.desc, entityId, role, Date.now()).run();
  return id;
}

async function placeLink(role: string, placeId = world.place): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO description_places (id, description_id, place_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(id, world.desc, placeId, role, Date.now()).run();
  return id;
}

async function deprecate(list: string, code: string) {
  await env.DB.prepare("UPDATE vocabulary_values SET status = 'deprecated' WHERE federation_id = ? AND list = ? AND code = ?")
    .bind(F, list, code)
    .run();
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDatabase();
  await seedFederations();
  await seedTenants();
  await seedRoleLists(F, [
    ...roleSetRows(NEOGRANADINA_ROLES),
    { list: "entity_role", code: "deponent", es: "Declarante", en: "Deponent", group: "legal", position: 99 },
    { list: "entity_role", code: "retired", es: "Retirado", en: "Retired", group: "legal", position: 100, status: "deprecated" },
    { list: "entity_role", code: "lapsed", es: "Caducado", en: "Lapsed", group: "legal", position: 101, status: "deprecated" },
    { list: "place_role", code: "seat", es: "Sede", en: "Seat", position: 8 },
    { list: "place_role", code: "old_seat", es: "Sede antigua", en: "Old seat", position: 9, status: "deprecated" },
  ]);
  userId = (await createTestUser({ tenantId: A, isAdmin: true })).id;
  const repo = await createTestRepository({ tenantId: A, code: "repo-link-roles" });
  world = {
    desc: (await createTestDescription({ tenantId: A, repositoryId: repo.id })).id,
    entity: (await createTestEntity({ entityCode: "ne-lr-1" })).id,
    other: (await createTestEntity({ entityCode: "ne-lr-2" })).id,
    place: (await createTestPlace({ placeCode: "nl-lr-1" })).id,
    otherPlace: (await createTestPlace({ placeCode: "nl-lr-2" })).id,
  };
});

describe("link roles from the federation's list", () => {
  it("creates a link with a code the list approves and the constants lack, from each page", async () => {
    expect(await post(descriptionAction, world.desc, { _action: "link_entity", descriptionId: world.desc, entityId: world.entity, role: "deponent" }))
      .toMatchObject({ ok: true });
    expect(await post(entityAction, world.other, { _action: "link_description", descriptionId: world.desc, role: "deponent" }))
      .toMatchObject({ ok: true });
    expect(await post(descriptionAction, world.desc, { _action: "link_place", descriptionId: world.desc, placeId: world.place, role: "seat" }))
      .toMatchObject({ ok: true });
    expect(await post(placeAction, world.otherPlace, { _action: "link_description", descriptionId: world.desc, role: "seat" }))
      .toMatchObject({ ok: true });
    expect((await entityLinks()).map((l) => l.role)).toEqual(["deponent", "deponent"]);
    expect((await placeLinks()).map((l) => l.role)).toEqual(["seat", "seat"]);
  });

  it("saves an edit that keeps such a code, from each page", async () => {
    const e1 = await entityLink("deponent");
    const e2 = await entityLink("deponent", world.other);
    const p1 = await placeLink("seat");
    const p2 = await placeLink("seat", world.otherPlace);
    expect(await post(descriptionAction, world.desc, { _action: "update_entity_link", linkId: e1, role: "deponent", honorific: "Don" }))
      .toMatchObject({ ok: true });
    expect(await post(entityAction, world.other, { _action: "edit_description_link", linkId: e2, role: "deponent", roleNote: "a note" }))
      .toMatchObject({ ok: true });
    expect(await post(descriptionAction, world.desc, { _action: "update_place_link", linkId: p1, role: "seat" }))
      .toMatchObject({ ok: true });
    expect(await post(placeAction, world.otherPlace, { _action: "edit_description_link", linkId: p2, role: "seat", roleNote: "a note" }))
      .toMatchObject({ ok: true });
    const byId = Object.fromEntries((await entityLinks()).map((l) => [l.id, l]));
    expect(byId[e1].honorific).toBe("Don");
    expect(byId[e2].roleNote).toBe("a note");
    expect((await placeLinks()).find((l) => l.id === p2)!.roleNote).toBe("a note");
  });

  it("refuses a code outside the approved list with the generic error, and writes nothing", async () => {
    const refused = { ok: false, error: "generic" };
    expect(await post(descriptionAction, world.desc, { _action: "link_entity", descriptionId: world.desc, entityId: world.entity, role: "bogus" }))
      .toMatchObject(refused);
    expect(await post(entityAction, world.other, { _action: "link_description", descriptionId: world.desc, role: "seat" }))
      .toMatchObject(refused);
    expect(await post(descriptionAction, world.desc, { _action: "link_place", descriptionId: world.desc, placeId: world.place, role: "deponent" }))
      .toMatchObject(refused);
    expect(await post(placeAction, world.otherPlace, { _action: "link_description", descriptionId: world.desc, role: "old_seat" }))
      .toMatchObject(refused);
    expect(await entityLinks()).toHaveLength(0);
    expect(await placeLinks()).toHaveLength(0);

    const e1 = await entityLink("creator");
    const p1 = await placeLink("created");
    expect(await post(descriptionAction, world.desc, { _action: "update_entity_link", linkId: e1, role: "bogus" })).toMatchObject(refused);
    expect(await post(entityAction, world.entity, { _action: "edit_description_link", linkId: e1, role: "bogus" })).toMatchObject(refused);
    expect(await post(descriptionAction, world.desc, { _action: "update_place_link", linkId: p1, role: "bogus" })).toMatchObject(refused);
    expect(await post(placeAction, world.place, { _action: "edit_description_link", linkId: p1, role: "bogus" })).toMatchObject(refused);
    expect((await entityLinks()).map((l) => l.role)).toEqual(["creator"]);
    expect((await placeLinks()).map((l) => l.role)).toEqual(["created"]);
  });

  it("refuses a code deprecated after the page was read", async () => {
    // The page offered `deponent` and `seat`; they are deprecated before the form is sent.
    await deprecate("entity_role", "deponent");
    await deprecate("place_role", "seat");
    expect(await post(descriptionAction, world.desc, { _action: "link_entity", descriptionId: world.desc, entityId: world.entity, role: "deponent" }))
      .toMatchObject({ ok: false, error: "generic" });
    expect(await post(placeAction, world.place, { _action: "link_description", descriptionId: world.desc, role: "seat" }))
      .toMatchObject({ ok: false, error: "generic" });
    expect(await entityLinks()).toHaveLength(0);
    expect(await placeLinks()).toHaveLength(0);
  });

  it("saves an edit that keeps a deprecated current code, and refuses one that moves to another", async () => {
    const e1 = await entityLink("retired");
    const p1 = await placeLink("old_seat");
    expect(await post(descriptionAction, world.desc, { _action: "update_entity_link", linkId: e1, role: "retired", honorific: "Don" }))
      .toMatchObject({ ok: true });
    expect(await post(entityAction, world.entity, { _action: "edit_description_link", linkId: e1, role: "retired", roleNote: "kept", honorific: "Don" }))
      .toMatchObject({ ok: true });
    expect(await post(placeAction, world.place, { _action: "edit_description_link", linkId: p1, role: "old_seat", roleNote: "kept" }))
      .toMatchObject({ ok: true });
    expect(await post(descriptionAction, world.desc, { _action: "update_entity_link", linkId: e1, role: "lapsed" }))
      .toMatchObject({ ok: false, error: "generic" });
    const link = (await entityLinks())[0];
    expect(link.role).toBe("retired");
    expect(link.honorific).toBe("Don");
    expect(link.roleNote).toBe("kept");
    expect((await placeLinks())[0].roleNote).toBe("kept");
  });

  it("checks the role inside the write statement", async () => {
    const queries: string[] = [];
    const logged = drizzle(env.DB, { schema, logger: { logQuery: (q) => queries.push(q) } });
    const written = await insertEntityLink(logged, F, {
      id: crypto.randomUUID(),
      descriptionId: world.desc,
      entityId: world.entity,
      role: "deponent",
      createdAt: Date.now(),
    });
    expect(written).toBe(true);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^INSERT INTO description_entities[\s\S]* WHERE exists \(select 1 from "vocabulary_values"/);
    const stored = await db().select().from(schema.descriptionEntities).where(eq(schema.descriptionEntities.role, "deponent" as any)).all();
    expect(stored).toHaveLength(1);
  });
});

// @version v0.9.0
