/**
 * Tests — the role an accepted decision links under, from the pages
 *
 * This suite pins the role an accepted decision links under, from the
 * pages; Fisqua assumes no role for a decision's evidence link. It runs
 * the decision queue's action (the one-click accept) and the decision
 * page's action for a link proposal whose evidence resolves, and pins
 * that:
 *
 *   - an accept from the queue whose proposed role the federation's
 *     list does not hold, or in a federation with no lists, answers
 *     `invalid` and writes no link and no ruling;
 *   - the same accept from the decision page, with a role the reviewer
 *     chose from the list, writes the link under that role and reports
 *     it;
 *   - a role the reviewer posts that the list does not hold answers
 *     `invalid`;
 *   - a proposal citing its reference with surrounding spaces resolves
 *     the description on the decision page, the queue and the core
 *     alike: the page shows the role and skip controls, the queue's
 *     loader resolves the reference, and the proposal is accepted with
 *     a chosen role or by skipping the link;
 *   - on the decision page the submitted role decides: a cleared select
 *     with no skip answers `invalid` and writes nothing, even when the
 *     proposal names an approved role;
 *   - a proposed role with surrounding spaces is read the same way by
 *     the page's preselection, the queue's accept and the core: trimmed,
 *     then matched exactly.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
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
  DEFAULT_TEST_FEDERATION_ID,
  SECOND_TEST_TENANT_ID,
  SECOND_TEST_FEDERATION_ID,
} from "../helpers/db";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestEntity } from "../helpers/entities";
import { createTestUser } from "../helpers/auth";
import { roleSetRows, seedRoleLists } from "../helpers/vocabulary";
import { tenantContext, userContext } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { action as queueAction, loader as queueLoader } from "../../app/routes/_auth.admin.decisions._index";
import DecisionPage, { action as decisionAction, loader as decisionLoader } from "../../app/routes/_auth.admin.decisions.$id";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { createRoutesStub } from "react-router";
import resources from "../../app/locales";
import { fileAuthorityProposals } from "../../app/lib/pending-decisions.server";
import { NEOGRANADINA_ROLES } from "../../scripts/data/vocabularies/neogranadina-roles";

/** The ruling admin of each tenant, a real user row, since a ruling records who ruled. */
const admins: Record<string, string> = {};

function context(tenantId: string, federationId: string): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, makeUserContext({ id: admins[tenantId], tenantId, isAdmin: true }));
  ctx.set(tenantContext, makeTenantContext({ id: tenantId, federationId }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function post(
  action: (args: any) => Promise<unknown>,
  tenantId: string,
  federationId: string,
  fields: Record<string, string>,
  params: Record<string, string> = {},
): Promise<any> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return action({
    request: new Request("http://fisqua.test/admin/decisions", { method: "POST", body: form }),
    context: context(tenantId, federationId),
    params,
  });
}

/** A link proposal for an entity of the federation, citing a description of the tenant. */
async function proposal(
  tenantId: string,
  federationId: string,
  proposedRole?: string,
  cite: (code: string) => string = (code) => code,
): Promise<{ id: string; entityId: string }> {
  const entity = await createTestEntity({ federationId, entityCode: `ne-${crypto.randomUUID().slice(0, 8)}` });
  const repo = await createTestRepository({ tenantId, code: `repo-${crypto.randomUUID().slice(0, 8)}` });
  await createTestDescription({ tenantId, repositoryId: repo.id, referenceCode: `CMD-${entity.id.slice(0, 6)}` });
  await fileAuthorityProposals(drizzle(env.DB), federationId, [
    {
      tenantId,
      payload: {
        heading: "Juan Testigo",
        proposedType: "person",
        proposedName: "Juan Testigo",
        action: "link",
        linkTargetType: "entity",
        linkTargetId: entity.id,
        evidenceRef: cite(`CMD-${entity.id.slice(0, 6)}`),
        ...(proposedRole ? { proposedRole } : {}),
      },
      sourceModule: "roles-test",
    },
  ]);
  const row = await env.DB.prepare("SELECT id FROM pending_decisions WHERE payload LIKE ?")
    .bind(`%${entity.id}%`)
    .first<{ id: string }>();
  return { id: row!.id, entityId: entity.id };
}

async function linksOf(entityId: string) {
  return drizzle(env.DB, { schema })
    .select()
    .from(schema.descriptionEntities)
    .all()
    .then((rows) => rows.filter((r) => r.entityId === entityId));
}

async function statusOf(id: string) {
  return (await env.DB.prepare("SELECT status FROM pending_decisions WHERE id = ?").bind(id).first<{ status: string }>())!.status;
}

describe("the role an accepted decision links under", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    await seedRoleLists(DEFAULT_TEST_FEDERATION_ID, roleSetRows(NEOGRANADINA_ROLES));
    for (const tenantId of [DEFAULT_TEST_TENANT_ID, SECOND_TEST_TENANT_ID]) {
      admins[tenantId] = (await createTestUser({ tenantId, isAdmin: true })).id;
    }
  });

  it("refuses a queue accept whose proposed role the list does not hold, with nothing written", async () => {
    const p = await proposal(DEFAULT_TEST_TENANT_ID, DEFAULT_TEST_FEDERATION_ID, "deponent");
    const out = await post(queueAction, DEFAULT_TEST_TENANT_ID, DEFAULT_TEST_FEDERATION_ID, {
      _action: "rule",
      id: p.id,
      ruling: "accepted",
    });
    expect(out).toMatchObject({ ok: false, code: "invalid" });
    expect(await linksOf(p.entityId)).toHaveLength(0);
    expect(await statusOf(p.id)).toBe("open");
  });

  it("refuses a queue accept in a federation with no role lists, with nothing written", async () => {
    const p = await proposal(SECOND_TEST_TENANT_ID, SECOND_TEST_FEDERATION_ID, "mentioned");
    const out = await post(queueAction, SECOND_TEST_TENANT_ID, SECOND_TEST_FEDERATION_ID, {
      _action: "rule",
      id: p.id,
      ruling: "accepted",
    });
    expect(out).toMatchObject({ ok: false, code: "invalid" });
    expect(await linksOf(p.entityId)).toHaveLength(0);
    expect(await statusOf(p.id)).toBe("open");
  });

  it("links under the role the reviewer chose on the decision page, and refuses one the list does not hold", async () => {
    const p = await proposal(DEFAULT_TEST_TENANT_ID, DEFAULT_TEST_FEDERATION_ID, "deponent");
    const fields = { _action: "accept", type: "person", displayName: "Juan Testigo" };

    const refused = await post(decisionAction, DEFAULT_TEST_TENANT_ID, DEFAULT_TEST_FEDERATION_ID, { ...fields, linkRole: "clerk" }, { id: p.id });
    expect(refused).toMatchObject({ ok: false, code: "invalid" });
    const unchosen = await post(decisionAction, DEFAULT_TEST_TENANT_ID, DEFAULT_TEST_FEDERATION_ID, fields, { id: p.id });
    expect(unchosen).toMatchObject({ ok: false, code: "invalid" });
    expect(await linksOf(p.entityId)).toHaveLength(0);

    const chosen = await post(decisionAction, DEFAULT_TEST_TENANT_ID, DEFAULT_TEST_FEDERATION_ID, { ...fields, linkRole: "witness" }, { id: p.id });
    expect(chosen).toMatchObject({ ok: true, linkedRole: "witness" });
    expect((await linksOf(p.entityId)).map((l) => l.role)).toEqual(["witness"]);
  });

  it("resolves a reference cited with surrounding spaces the same way on the page, the queue and the core", async () => {
    const T = DEFAULT_TEST_TENANT_ID;
    const F = DEFAULT_TEST_FEDERATION_ID;
    const render = async (Page: any, loaderData: unknown) => {
      const inst = i18next.createInstance();
      await (inst.init as (opts: unknown) => Promise<unknown>)({
        lng: "en", fallbackLng: "es", defaultNS: "common", resources, interpolation: { escapeValue: false },
      });
      const Stub = createRoutesStub([
        { path: "/", Component: () => React.createElement(Page, { loaderData, actionData: undefined, params: {}, matches: [] }) },
      ]);
      return renderToStaticMarkup(
        React.createElement(I18nextProvider, { i18n: inst }, React.createElement(Stub, { initialEntries: ["/"] })),
      );
    };
    const load = (loader: (args: any) => Promise<unknown>, url: string, params: Record<string, string> = {}) =>
      loader({ request: new Request(`http://fisqua.test${url}`), context: context(T, F), params });

    const byRole = await proposal(T, F, undefined, (code) => ` ${code} `);
    const bySkip = await proposal(T, F, undefined, (code) => ` ${code} `);

    const page = await render(DecisionPage, await load(decisionLoader, `/admin/decisions/${byRole.id}`, { id: byRole.id }));
    expect(page).toContain('name="linkRole"');
    expect(page).toContain('name="skipLink"');
    const queue = (await load(queueLoader, "/admin/decisions")) as { refIds: Record<string, string> };
    expect(Object.keys(queue.refIds)).toContain(`CMD-${byRole.entityId.slice(0, 6)}`);

    const fields = { _action: "accept", type: "person", displayName: "Juan Testigo" };
    const chosen = await post(decisionAction, T, F, { ...fields, linkRole: "witness" }, { id: byRole.id });
    expect(chosen).toMatchObject({ ok: true, linkedRole: "witness" });
    expect((await linksOf(byRole.entityId)).map((l) => l.role)).toEqual(["witness"]);

    const skipped = await post(decisionAction, T, F, { ...fields, skipLink: "on" }, { id: bySkip.id });
    expect(skipped).toMatchObject({ ok: true, linkedRef: null });
    expect(await linksOf(bySkip.entityId)).toHaveLength(0);
    expect(await statusOf(bySkip.id)).toBe("ruled");
  });

  it("refuses a decision-page accept whose role select was cleared, even with an approved proposed role", async () => {
    const p = await proposal(DEFAULT_TEST_TENANT_ID, DEFAULT_TEST_FEDERATION_ID, "witness");
    const out = await post(
      decisionAction,
      DEFAULT_TEST_TENANT_ID,
      DEFAULT_TEST_FEDERATION_ID,
      { _action: "accept", type: "person", displayName: "Juan Testigo", linkRole: "" },
      { id: p.id },
    );
    expect(out).toMatchObject({ ok: false, code: "invalid" });
    expect(await linksOf(p.entityId)).toHaveLength(0);
    expect(await statusOf(p.id)).toBe("open");
  });

  it("reads a padded proposed role the same way in the page's preselection, the queue's accept and the core", async () => {
    const T = DEFAULT_TEST_TENANT_ID;
    const F = DEFAULT_TEST_FEDERATION_ID;
    const onPage = await proposal(T, F, " witness ");
    const inQueue = await proposal(T, F, " witness ");

    const inst = i18next.createInstance();
    await (inst.init as (opts: unknown) => Promise<unknown>)({
      lng: "en", fallbackLng: "es", defaultNS: "common", resources, interpolation: { escapeValue: false },
    });
    const loaderData = await decisionLoader({
      request: new Request(`http://fisqua.test/admin/decisions/${onPage.id}`),
      context: context(T, F),
      params: { id: onPage.id },
    } as any);
    const Stub = createRoutesStub([
      { path: "/", Component: () => React.createElement(DecisionPage as any, { loaderData, actionData: undefined, params: {}, matches: [] }) },
    ]);
    const page = renderToStaticMarkup(
      React.createElement(I18nextProvider, { i18n: inst }, React.createElement(Stub, { initialEntries: ["/"] })),
    );
    expect(page).toContain('<option value="witness" selected="">');

    const queued = await post(queueAction, T, F, { _action: "rule", id: inQueue.id, ruling: "accepted" });
    expect(queued).toMatchObject({ ok: true });
    expect((await linksOf(inQueue.entityId)).map((l) => l.role)).toEqual(["witness"]);
  });
});

// @version v0.9.0
