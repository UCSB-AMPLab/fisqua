/**
 * Tests — a link's office, stored in its attributes
 *
 * This suite pins that the description page, the entity page and the
 * exports show and save a link's office through `attributes`. Migration
 * 0125 moves a link's `function` into `attributes` under `office`; those
 * surfaces show and save the one value under the name `function`, and the
 * suite pins that they do so through `attributes`:
 *
 *   - the description page's `link_entity` stores the office as JSON, a
 *     value with quotes kept as it was, and no office as `{}`;
 *   - its `update_entity_link` sets or removes the office and leaves any
 *     other attribute the link carries;
 *   - the entity page's `edit_description_link` does the same, and its
 *     loader lists the office as `function`;
 *   - the helpers that read and write the object agree with SQLite's.
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
} from "../helpers/db";
import { roleSetRows, seedRoleLists } from "../helpers/vocabulary";
import { NEOGRANADINA_ROLES } from "../../scripts/data/vocabularies/neogranadina-roles";
import { DEFAULT_TEST_FEDERATION_ID as ROLES_FEDERATION_A, SECOND_TEST_FEDERATION_ID as ROLES_FEDERATION_B } from "../helpers/db";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestEntity } from "../helpers/entities";
import { tenantContext, userContext } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { action as descriptionAction } from "../../app/routes/_auth.admin.descriptions.$id";
import { action as entityAction, loader as entityLoader } from "../../app/routes/_auth.admin.entities.$id";
import { attributesJson, officeOf, officeSql, withOffice } from "../../app/lib/link-attributes.server";

const A = DEFAULT_TEST_TENANT_ID;

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

async function post(action: (args: any) => Promise<unknown>, id: string, fields: Record<string, string>): Promise<unknown> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return action({
    request: new Request("http://neogranadina.fisqua.test/admin/x", { method: "POST", body: form }),
    context: context(),
    params: { id },
  });
}

const attributesOf = async (id: string) =>
  (await db().select().from(schema.descriptionEntities).where(eq(schema.descriptionEntities.id, id)).get())?.attributes;

let world: { entityId: string; otherEntityId: string; descId: string; linkId: string };

describe("a link's office in its attributes", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    // The link forms write only the roles the federation's list approves.
    await seedRoleLists(ROLES_FEDERATION_A, roleSetRows(NEOGRANADINA_ROLES));
    await seedRoleLists(ROLES_FEDERATION_B, roleSetRows(NEOGRANADINA_ROLES));
    const entity = await createTestEntity({ entityCode: "ne-office-1" });
    const other = await createTestEntity({ entityCode: "ne-office-2" });
    const repo = await createTestRepository({ tenantId: A, code: "repo-office" });
    const desc = await createTestDescription({ tenantId: A, repositoryId: repo.id });
    const linkId = crypto.randomUUID();
    await db().insert(schema.descriptionEntities).values({
      id: linkId,
      descriptionId: desc.id,
      entityId: entity.id,
      role: "creator",
      sequence: 0,
      attributes: JSON.stringify({ office: "Escribano", age: "30" }),
      createdAt: Date.now(),
    });
    world = { entityId: entity.id, otherEntityId: other.id, descId: desc.id, linkId };
  });

  it("stores the office of a new link from the description page, quotes and all", async () => {
    expect(
      await post(descriptionAction, world.descId, {
        _action: "link_entity", descriptionId: world.descId, entityId: world.otherEntityId, role: "author",
        function: 'Escribano "público"',
      }),
    ).toMatchObject({ ok: true });
    const link = await db()
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.entityId, world.otherEntityId))
      .get();
    expect(link!.attributes).toBe('{"office":"Escribano \\"público\\""}');
    expect(officeOf(link!.attributes)).toBe('Escribano "público"');
  });

  it("stores {} for a new link with no office", async () => {
    await post(descriptionAction, world.descId, {
      _action: "link_entity", descriptionId: world.descId, entityId: world.otherEntityId, role: "author",
    });
    const link = await db()
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.entityId, world.otherEntityId))
      .get();
    expect(link!.attributes).toBe("{}");
  });

  it("sets and removes the office from the description page, keeping the other attributes", async () => {
    await post(descriptionAction, world.descId, {
      _action: "update_entity_link", linkId: world.linkId, role: "creator", function: "Alcalde",
    });
    expect(JSON.parse((await attributesOf(world.linkId))!)).toEqual({ office: "Alcalde", age: "30" });
    await post(descriptionAction, world.descId, {
      _action: "update_entity_link", linkId: world.linkId, role: "creator", function: "",
    });
    expect(JSON.parse((await attributesOf(world.linkId))!)).toEqual({ age: "30" });
  });

  it("sets and removes the office from the entity page, keeping the other attributes", async () => {
    await post(entityAction, world.entityId, {
      _action: "edit_description_link", linkId: world.linkId, role: "creator", function: "Regidor",
    });
    expect(JSON.parse((await attributesOf(world.linkId))!)).toEqual({ office: "Regidor", age: "30" });
    await post(entityAction, world.entityId, {
      _action: "edit_description_link", linkId: world.linkId, role: "creator",
    });
    expect(JSON.parse((await attributesOf(world.linkId))!)).toEqual({ age: "30" });
  });

  it("lists the office as the link's function on the entity page", async () => {
    const data: any = await entityLoader({
      request: new Request(`http://neogranadina.fisqua.test/admin/x/${world.entityId}`),
      context: context(),
      params: { id: world.entityId },
    } as any);
    const page = data instanceof Response ? await data.json() : data;
    expect(page.links.map((l: { function: string | null }) => l.function)).toEqual(["Escribano"]);
  });

  it("agrees with SQLite on reading and writing the object", async () => {
    expect(attributesJson(null)).toBe("{}");
    expect(attributesJson("")).toBe("{}");
    expect(withOffice('{"age":"30"}', "Cura")).toBe('{"age":"30","office":"Cura"}');
    expect(withOffice('{"office":"Cura","age":"30"}', null)).toBe('{"age":"30"}');
    expect(officeOf("{}")).toBeNull();
    const row = await db()
      .select({ office: officeSql() })
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, world.linkId))
      .get();
    expect(row!.office).toBe("Escribano");
  });
});

// @version v0.9.0
