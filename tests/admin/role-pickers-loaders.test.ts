/**
 * Tests — the role pickers and labels each federation's pages get
 *
 * This suite pins the role pickers and labels that each federation's pages
 * get. The pages that show or pick a document or place role read the
 * acting tenant's federation's role lists once per request, and pass the
 * option groups and the code-to-label maps to their components. It pins
 * that:
 *
 *   - in the description editor's loader, two workspaces in two
 *     federations with different lists each get their own entity
 *     groups, place options and labels, and neither sees the other's
 *     codes;
 *   - a relation role's label comes from the federation's relation
 *     roles;
 *   - a federation with no lists gets empty pickers and maps;
 *   - the split and merge pages of entities and places, and the
 *     decision queue, a decision and a duplicate pair, get the acting
 *     tenant's federation's pickers.
 *
 * The first federation holds the Neogranadina set; the second holds a
 * short list of test values. The loader runs outside the i18next
 * middleware, so the labels are in English.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import {
  applyMigrations,
  cleanDatabase,
  seedFederations,
  seedTenants,
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
  SECOND_TEST_TENANT_ID,
  SECOND_TEST_FEDERATION_ID,
} from "../helpers/db";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestEntity } from "../helpers/entities";
import { createTestPlace } from "../helpers/places";
import { roleSetRows, seedRoleLists } from "../helpers/vocabulary";
import { tenantContext, userContext } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { loader as descriptionLoader } from "../../app/routes/_auth.admin.descriptions.$id";
import { loader as entitySplitLoader } from "../../app/routes/_auth.admin.entities.$id.split";
import { loader as entityMergeLoader } from "../../app/routes/_auth.admin.entities.$id.merge";
import { loader as placeSplitLoader } from "../../app/routes/_auth.admin.places.$id.split";
import { loader as placeMergeLoader } from "../../app/routes/_auth.admin.places.$id.merge";
import { loader as decisionsLoader } from "../../app/routes/_auth.admin.decisions._index";
import { loader as decisionLoader } from "../../app/routes/_auth.admin.decisions.$id";
import { loader as pairLoader } from "../../app/routes/_auth.admin.decisions.pair";
import { fileAuthorityProposals } from "../../app/lib/pending-decisions.server";
import { drizzle } from "drizzle-orm/d1";
import { NEOGRANADINA_ROLES } from "../../scripts/data/vocabularies/neogranadina-roles";
import type { RolePickers } from "../../app/lib/role-options";

function context(tenantId: string, federationId: string): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, makeUserContext({ tenantId, isAdmin: true }));
  ctx.set(tenantContext, makeTenantContext({ id: tenantId, federationId }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function rolesOf(tenantId: string, federationId: string, descriptionId: string): Promise<RolePickers> {
  const data = (await descriptionLoader({
    request: new Request(`http://fisqua.test/admin/descriptions/${descriptionId}`),
    context: context(tenantId, federationId),
    params: { id: descriptionId },
  } as any)) as { roles: RolePickers };
  return data.roles;
}

let descA: string;
let descB: string;

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDatabase();
  await seedFederations();
  await seedTenants();
  await seedRoleLists(DEFAULT_TEST_FEDERATION_ID, roleSetRows(NEOGRANADINA_ROLES));
  await seedRoleLists(SECOND_TEST_FEDERATION_ID, [
    { list: "role_group", code: "court", es: "Tribunal", en: "Court", position: 1 },
    { list: "entity_role", code: "deponent", es: "Declarante", en: "Deponent", group: "court", position: 1 },
    { list: "entity_role", code: "clerk", es: "Escribiente", en: "Clerk", group: "court", position: 2 },
    { list: "place_role", code: "seat", es: "Sede", en: "Seat", position: 1 },
  ]);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO vocabulary_values (id, federation_id, list, code, label_es, label_en, group_code, position, created_at, updated_at) " +
      "VALUES ('rel-b', ?, 'relation_role', 'ward', 'pupilo', 'ward', 'court', 1, ?, ?)",
  ).bind(SECOND_TEST_FEDERATION_ID, now, now).run();
  const repoA = await createTestRepository({ tenantId: DEFAULT_TEST_TENANT_ID, code: "repo-roles-a" });
  const repoB = await createTestRepository({ tenantId: SECOND_TEST_TENANT_ID, code: "repo-roles-b" });
  descA = (await createTestDescription({ tenantId: DEFAULT_TEST_TENANT_ID, repositoryId: repoA.id })).id;
  descB = (await createTestDescription({ tenantId: SECOND_TEST_TENANT_ID, repositoryId: repoB.id })).id;
});

describe("the description editor's role pickers, per federation", () => {
  it("gives each federation its own options and labels", async () => {
    const a = await rolesOf(DEFAULT_TEST_TENANT_ID, DEFAULT_TEST_FEDERATION_ID, descA);
    const b = await rolesOf(SECOND_TEST_TENANT_ID, SECOND_TEST_FEDERATION_ID, descB);

    expect(a.entityGroups.map((g) => g.key)).toEqual([
      "production", "correspondence", "notarial", "legal", "family", "transactions", "visual",
    ]);
    expect(a.entityGroups[0].label).toBe("Production & mentions");
    expect(a.entityGroups[0].options[0]).toEqual({ value: "creator", label: "Creator" });
    expect(a.entityGroups.flatMap((g) => g.options)).toHaveLength(33);
    expect(a.placeOptions.map((o) => o.value)).toEqual([
      "created", "subject", "mentioned", "sent_from", "sent_to", "published", "venue",
    ]);
    expect(a.labels.entity.fiador).toBe("Surety");
    expect(a.labels.entity.deponent).toBeUndefined();
    expect(a.labels.relation).toEqual({});

    expect(b.entityGroups).toEqual([
      {
        key: "court",
        label: "Court",
        options: [{ value: "deponent", label: "Deponent" }, { value: "clerk", label: "Clerk" }],
      },
    ]);
    expect(b.placeOptions).toEqual([{ value: "seat", label: "Seat" }]);
    expect(b.labels.entity).toEqual({ deponent: "Deponent", clerk: "Clerk" });
    expect(b.labels.place).toEqual({ seat: "Seat" });
    expect(b.labels.relation).toEqual({ ward: "ward" });
  });

  it("gives a federation with no lists empty pickers and maps", async () => {
    await env.DB.prepare("DELETE FROM vocabulary_values WHERE federation_id = ?").bind(SECOND_TEST_FEDERATION_ID).run();
    const b = await rolesOf(SECOND_TEST_TENANT_ID, SECOND_TEST_FEDERATION_ID, descB);
    expect(b).toEqual({ entityGroups: [], placeOptions: [], labels: { entity: {}, place: {}, relation: {} } });
  });
});

describe("the split, merge and decision pages' role pickers", () => {
  const B = { tenant: SECOND_TEST_TENANT_ID, federation: SECOND_TEST_FEDERATION_ID };

  async function run(loader: (args: any) => Promise<unknown>, url: string, params: Record<string, string> = {}) {
    return (await loader({
      request: new Request(`http://fisqua.test${url}`),
      context: context(B.tenant, B.federation),
      params,
    })) as { roles: RolePickers };
  }

  const expectB = (roles: RolePickers) => {
    expect(roles.entityGroups.flatMap((g) => g.options.map((o) => o.value))).toEqual(["deponent", "clerk"]);
    expect(roles.labels.place).toEqual({ seat: "Seat" });
    expect(roles.labels.relation).toEqual({ ward: "ward" });
  };

  it("hands each page the acting tenant's federation's lists", async () => {
    const e1 = await createTestEntity({ federationId: B.federation, entityCode: "ne-b-1" });
    const e2 = await createTestEntity({ federationId: B.federation, entityCode: "ne-b-2" });
    const p1 = await createTestPlace({ federationId: B.federation, placeCode: "nl-b-1" });
    const p2 = await createTestPlace({ federationId: B.federation, placeCode: "nl-b-2" });

    expectB((await run(entitySplitLoader, `/admin/entities/${e1.id}/split`, { id: e1.id })).roles);
    expectB((await run(entityMergeLoader, `/admin/entities/${e1.id}/merge?survivor=${e2.id}`, { id: e1.id })).roles);
    expectB((await run(placeSplitLoader, `/admin/places/${p1.id}/split`, { id: p1.id })).roles);
    expectB((await run(placeMergeLoader, `/admin/places/${p1.id}/merge?survivor=${p2.id}`, { id: p1.id })).roles);
    expectB((await run(pairLoader, `/admin/decisions/pair?type=entities&a=${e1.id}&b=${e2.id}`)).roles);

    await fileAuthorityProposals(drizzle(env.DB), B.federation, [
      {
        tenantId: B.tenant,
        payload: { heading: "Juan Declarante", proposedType: "person", proposedName: "Juan Declarante", action: "mint", proposedRole: "deponent" },
        sourceModule: "roles-test",
      },
    ]);
    const queue = await run(decisionsLoader, "/admin/decisions");
    expectB(queue.roles);
    const proposalId = (queue as unknown as { proposals: Array<{ id: string }> }).proposals[0].id;
    expectB((await run(decisionLoader, `/admin/decisions/${proposalId}`, { id: proposalId })).roles);
  });
});

// @version v0.9.0
