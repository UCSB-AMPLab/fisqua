/**
 * Tests — relation sides keep their relation role's label on every surface
 *
 * This suite pins that relation sides keep their relation role's label on
 * every surface that shows linked entities' roles outside the description
 * editor. A code can be both a document role and a relation role of one
 * federation (here `spouse`, with a different label in each list). A
 * relation side, a link that names another link of its description or is
 * named by one, takes the relation role's label; any other link takes the
 * document role's. The suite pins that on each such surface:
 *
 *   - the Reader record page: its entity links say whether each is a
 *     relation side, without the other link's id, and the linker labels
 *     them;
 *   - the split and merge workbenches' cards: each role says whether it
 *     is held as a relation side, and the context card labels it;
 *   - the worklist's unfolded panel: the description's entities say
 *     whether each is a relation side, grouped apart from the document
 *     role of the same code;
 *   - the duplicate pair page: the roles a record holds as a relation
 *     side are listed apart from its document roles;
 *   - the entity page's worklist: a role pill whose links are all
 *     relation sides takes the relation role's label, as its rows do.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { createRoutesStub } from "react-router";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import resources from "../../app/locales";
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
import { seedRoleLists } from "../helpers/vocabulary";
import { loadPublishedRecord } from "../../app/lib/reader.server";
import {
  loadLinkedDescriptionCard,
  loadLinkedDescriptionCards,
} from "../../app/lib/authority-linked-context.server";
import { loadPairContext } from "../../app/lib/pair-context.server";
import { readRoleVocabulary } from "../../app/lib/vocabulary.server";
import { entityRoleLabel, placeRoleLabel, rolePickers, type RolePickers } from "../../app/lib/role-options";
import { EntityLinker } from "../../app/components/descriptions/entity-linker";
import { LinkedDescriptionContextCard } from "../../app/components/admin/linked-description-context-card";
import { LinkedDescriptionUnfold } from "../../app/components/admin/linked-description-unfold";
import DecisionPairPage from "../../app/routes/_auth.admin.decisions.pair";
import { loader as entityLoader } from "../../app/routes/_auth.admin.entities.$id";
import { LinkedDescriptionsWorklist } from "../../app/components/admin/linked-descriptions-worklist";
import { RouterContextProvider } from "react-router";
import { tenantContext, userContext } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { createTestUser } from "../helpers/auth";

const A = DEFAULT_TEST_TENANT_ID;
const SIDE = "spouse (relation)";
const DOC = "Spouse in the document";

const db = () => drizzle(env.DB, { schema });

let world: { desc: string; husband: string; wife: string; other: string; husbandLink: string };
let roles: RolePickers;

async function link(id: string, descriptionId: string, entityId: string, relatedTo: string | null, sequence: number) {
  await env.DB.prepare(
    "INSERT INTO description_entities (id, description_id, entity_id, role, sequence, related_to, attributes, created_at) VALUES (?, ?, ?, 'spouse', ?, ?, '{}', ?)",
  ).bind(id, descriptionId, entityId, sequence, relatedTo, Date.now()).run();
}

/** Renders inside a router and an English i18next instance, which the components need. */
async function html(element: React.ReactElement): Promise<string> {
  const inst = i18next.createInstance();
  await (inst.init as (opts: unknown) => Promise<unknown>)({
    lng: "en",
    fallbackLng: "es",
    defaultNS: "common",
    resources,
    interpolation: { escapeValue: false },
  });
  const Stub = createRoutesStub([{ path: "/", Component: () => element }]);
  return renderToStaticMarkup(
    React.createElement(I18nextProvider, { i18n: inst }, React.createElement(Stub, { initialEntries: ["/"] })),
  );
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDatabase();
  await seedFederations();
  await seedTenants();
  await seedRoleLists(DEFAULT_TEST_FEDERATION_ID, [
    { list: "role_group", code: "family", es: "Familia", en: "Family", position: 1 },
    { list: "entity_role", code: "spouse", es: "Cónyuge en el documento", en: DOC, group: "family", position: 1 },
    { list: "place_role", code: "mentioned", es: "Mencionado", en: "Mentioned", position: 1 },
  ]);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO vocabulary_values (id, federation_id, list, code, label_es, label_en, group_code, position, created_at, updated_at) " +
      "VALUES ('rel-spouse', ?, 'relation_role', 'spouse', 'cónyuge (relación)', ?, 'family', 1, ?, ?)",
  ).bind(DEFAULT_TEST_FEDERATION_ID, SIDE, now, now).run();
  roles = rolePickers(await readRoleVocabulary(db(), DEFAULT_TEST_FEDERATION_ID), "en");

  const repo = await createTestRepository({ tenantId: A, code: "repo-rel-labels" });
  const desc = (await createTestDescription({ tenantId: A, repositoryId: repo.id, isPublished: true })).id;
  const husband = (await createTestEntity({ entityCode: "ne-rl-h", displayName: "Pedro Esposo" })).id;
  const wife = (await createTestEntity({ entityCode: "ne-rl-w", displayName: "Ana Esposa" })).id;
  const other = (await createTestEntity({ entityCode: "ne-rl-o", displayName: "Juan Otro" })).id;
  await link("rl-h", desc, husband, null, 0);
  await link("rl-w", desc, wife, "rl-h", 1);
  await link("rl-o", desc, other, null, 2);
  world = { desc, husband, wife, other, husbandLink: "rl-h" };
});

describe("relation-side labels", () => {
  it("the Reader page says which links are relation sides, without the other link's id, and labels them", async () => {
    const loaded = await loadPublishedRecord(db(), { id: A, federationId: DEFAULT_TEST_FEDERATION_ID }, world.desc, 1);
    const sides = Object.fromEntries(loaded!.entityLinks.map((l) => [l.entityId, l.relationSide]));
    expect(sides).toEqual({ [world.husband]: true, [world.wife]: true, [world.other]: false });
    expect(loaded!.entityLinks.every((l) => !("relatedTo" in l))).toBe(true);

    const out = await html(
      React.createElement(EntityLinker, { descriptionId: world.desc, links: loaded!.entityLinks as any, roles, isEditing: false }),
    );
    expect(count(out, SIDE)).toBe(2);
    expect(count(out, DOC)).toBe(1);
  });

  it("the workbench cards say which roles are held as relation sides, and the card labels them", async () => {
    const label = (r: string, side?: boolean) => entityRoleLabel(roles.labels, r, side);
    for (const [entityId, expected] of [[world.wife, SIDE], [world.other, DOC]] as const) {
      const list = await loadLinkedDescriptionCards(db(), { recordType: "entity", ownerId: entityId, displayName: "x", tenantId: A });
      const out = await html(
        React.createElement(LinkedDescriptionContextCard, {
          card: list.cards[0],
          showAsRecorded: false,
          roleLabel: label,
          placeRoleLabel: (r: string) => placeRoleLabel(roles.labels, r),
          t: (k: string) => k,
        }),
      );
      expect(out).toContain(expected);
      expect(out).not.toContain(expected === SIDE ? DOC : SIDE);
    }
  });

  it("the unfolded panel groups the relation sides apart from the document role of the same code", async () => {
    const card = await loadLinkedDescriptionCard(db(), {
      recordType: "entity",
      ownerId: world.husband,
      displayName: "Pedro Esposo",
      junctionId: world.husbandLink,
      tenantId: A,
    });
    const sides = Object.fromEntries(card!.entities!.map((e) => [e.name, e.relationSide]));
    expect(sides).toEqual({ "Pedro Esposo": true, "Ana Esposa": true, "Juan Otro": false });
    const out = await html(
      React.createElement(LinkedDescriptionUnfold, {
        card: card!,
        junctionId: world.husbandLink,
        cardBasePath: `/admin/entities/${world.husband}`,
        showEntityGroups: true,
        roleLabel: (r: string, side?: boolean) => entityRoleLabel(roles.labels, r, side),
        placeRoleLabel: (r: string) => placeRoleLabel(roles.labels, r),
        t: (k: string) => k,
      }),
    );
    expect(count(out, SIDE)).toBe(1);
    expect(count(out, DOC)).toBe(1);
  });

  it("the pair page lists a record's relation-side roles apart, under the relation role's label", async () => {
    const seed = (id: string) => ({ id, createdAt: Date.now(), legacyIds: null });
    const ctx = await loadPairContext(db(), {
      kind: "entities",
      tenantId: A,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      seeds: [seed(world.wife), seed(world.other)],
    });
    expect(ctx[world.wife].descriptions[0]).toMatchObject({ roles: [], relationRoles: ["spouse"] });
    expect(ctx[world.other].descriptions[0]).toMatchObject({ roles: ["spouse"], relationRoles: [] });

    const side = (id: string, name: string) => ({
      id, name, code: id, entityType: "person", dates: null, nameVariants: "[]", sources: null,
      wikidataId: null, viafId: null, dbeId: null, tgnId: null, descriptionCount: 1, context: ctx[id],
    });
    const out = await html(
      React.createElement(DecisionPairPage as any, {
        loaderData: {
          kind: "entities",
          left: side(world.wife, "Ana Esposa"),
          right: side(world.other, "Juan Otro"),
          comments: [],
          viewer: { userId: "u1", isAdmin: true },
          roles,
        },
        actionData: undefined,
        params: {},
        matches: [],
      }),
    );
    expect(count(out, SIDE)).toBe(1);
    expect(count(out, DOC)).toBe(1);
  });

  it("labels a worklist pill whose links are all relation sides from the relation roles, as its rows", async () => {
    // Six descriptions, each with the wife as a relation side of the husband: more than five links,
    // so the pills show.
    const repo = await createTestRepository({ tenantId: A, code: "repo-rel-pills" });
    for (let i = 0; i < 6; i++) {
      const d = (await createTestDescription({ tenantId: A, repositoryId: repo.id })).id;
      await link(`rp-h-${i}`, d, world.husband, null, 0);
      await link(`rp-w-${i}`, d, world.wife, `rp-h-${i}`, 1);
    }
    const userId = (await createTestUser({ tenantId: A, isAdmin: true })).id;
    const ctx = new RouterContextProvider();
    ctx.set(userContext, makeUserContext({ id: userId, tenantId: A, isAdmin: true }));
    ctx.set(tenantContext, makeTenantContext({ id: A }));
    (ctx as any).cloudflare = { env };
    const data = (await entityLoader({
      request: new Request(`http://neogranadina.fisqua.test/admin/entities/${world.wife}`),
      context: ctx,
      params: { id: world.wife },
    } as any)) as any;
    expect(data.roleCounts).toEqual([{ role: "spouse", count: 7, relationSide: true }]);

    const out = await html(
      React.createElement(LinkedDescriptionsWorklist, {
        links: data.links,
        total: data.total,
        allCount: data.allCount,
        recordTotal: data.descLinkCount,
        roleCounts: data.roleCounts,
        repoCounts: data.repoCounts,
        repoSpan: data.repoSpan,
        dq: "",
        role: null,
        repo: null,
        sort: data.wl.sort,
        size: data.wl.size,
        page: 1,
        isMerged: false,
        roleOptions: [],
        recordId: world.wife,
        recordType: "entity",
        showEntityFields: true,
        roleLabel: (r: string, side?: boolean) => entityRoleLabel(roles.labels, r, side),
        placeRoleLabel: (r: string) => placeRoleLabel(roles.labels, r),
        t: ((k: string) => k) as any,
        ta: (k: string) => k,
      }),
    );
    // Seven rows and one pill, every one under the relation role's label.
    expect(count(out, SIDE)).toBe(8);
    expect(out).not.toContain(DOC);
  });
});

// @version v0.9.0
