/**
 * Tests — evidence for merges on the decisions surface
 *
 * This suite pins the evidence required for merges on the decisions
 * surface. The duplicates card and the pair page merge two entity records
 * through `rulePairMerge`. The server refuses an entity merge that carries
 * no fact or no description on one side, writing nothing, and records the
 * evidence of a merge it makes in the `merge` ledger row's
 * `detail.evidence`, as description ids, beside the steward's note in
 * `detail.reason`. A cited link removed between the check and the batch
 * fails the batch on its guard, and the merge is refused as
 * `evidence_stale`. Organization and family records need evidence as a
 * person does; place merges take none.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedFederations,
  seedTenants,
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestEntity } from "../helpers/entities";
import { createTestPlace } from "../helpers/places";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { RouterContextProvider } from "react-router";
import { tenantContext, userContext, type User } from "../../app/context";
import { action as duplicatesAction } from "../../app/routes/_auth.admin.decisions.duplicates";
import { action as pairAction } from "../../app/routes/_auth.admin.decisions.pair";
import { rulePairMerge } from "../../app/lib/pair-merge.server";

const A = DEFAULT_TEST_TENANT_ID;
const S = "ent-survivor";
const L = "ent-loser";

function db() {
  return drizzle(env.DB, { schema });
}

let admin: User;
let dL: string;
let dS: string;

async function link(id: string, descriptionId: string, entityId: string) {
  await db().insert(schema.descriptionEntities).values({
    id, descriptionId, entityId, role: "creator", sequence: 0, createdAt: 1,
  });
}

async function mergeRows() {
  return (await db().select().from(schema.authorityOperations).where(eq(schema.authorityOperations.operation, "merge")).all())
    .map((r) => ({ ...r, detail: JSON.parse(r.detail ?? "null") }));
}

async function loserRow() {
  return db().select().from(schema.entities).where(eq(schema.entities.id, L)).get();
}

/** The test D1, with `change` run once just before the first batch. */
function beforeFirstBatch(change: () => Promise<unknown>): D1Database {
  let done = false;
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!done) {
            done = true;
            await change();
          }
          return target.batch(statements);
        };
      }
      const value = (target as any)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const evidence = (facts: string[], cited: Array<[string, string]>) => ({
  facts,
  cited: cited.map(([entityId, descriptionId]) => ({ entityId, descriptionId })),
});

function context(): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, admin);
  ctx.set(tenantContext, makeTenantContext({ id: A }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function post(action: (args: any) => Promise<unknown>, url: string, fields: Array<[string, string]>) {
  const form = new FormData();
  for (const [k, v] of fields) form.append(k, v);
  return action({ request: new Request(url, { method: "POST", body: form }), context: context(), params: {} });
}

async function refusal(promise: Promise<unknown>) {
  const err = await promise.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(Response);
  return { status: (err as Response).status, body: await (err as Response).text() };
}

describe("rulePairMerge and the evidence for an entity merge", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    const row = await createTestUser({ isAdmin: true });
    admin = makeUserContext({ id: row.id, tenantId: A, isAdmin: true });
    const repo = await createTestRepository({ tenantId: A, code: "repo-a" });
    dL = (await createTestDescription({ tenantId: A, repositoryId: repo.id, referenceCode: "a-1" })).id;
    dS = (await createTestDescription({ tenantId: A, repositoryId: repo.id, referenceCode: "a-2" })).id;
  });

  async function pair(entityType = "person") {
    await createTestEntity({ id: S, entityCode: "ne-s1", displayName: "Domingo Caycedo", entityType });
    await createTestEntity({ id: L, entityCode: "ne-l1", displayName: "Domingo Caicedo", entityType });
    await link("lk-l", dL, L);
    await link("lk-s", dS, S);
  }

  it("entity merge without evidence is refused and writes nothing", async () => {
    await pair();
    const tenant = makeTenantContext();
    expect(await refusal(rulePairMerge(db(), admin, tenant, "entity", S, L, "same name"))).toEqual({ status: 400, body: "evidence_facts" });
    expect(await refusal(rulePairMerge(db(), admin, tenant, "entity", S, L, null, Date.now(), undefined, evidence([], [[L, dL], [S, dS]]))))
      .toEqual({ status: 400, body: "evidence_facts" });
    expect(await refusal(rulePairMerge(db(), admin, tenant, "entity", S, L, null, Date.now(), undefined, evidence(["dates"], [[S, dS]]))))
      .toEqual({ status: 400, body: "evidence_loser" });
    expect(await refusal(rulePairMerge(db(), admin, tenant, "entity", S, L, null, Date.now(), undefined, evidence(["dates"], [[L, dL], [S, dL]]))))
      .toEqual({ status: 400, body: "evidence_unlinked" });
    expect(await mergeRows()).toEqual([]);
    expect((await loserRow())!.mergedInto).toBeNull();
    expect(await db().select().from(schema.pendingDecisions).all()).toEqual([]);
    expect((await db().select().from(schema.descriptionEntities).where(eq(schema.descriptionEntities.id, "lk-l")).get())!.entityId).toBe(L);
  });

  it("entity merge with evidence writes detail.evidence with description ids and keeps detail.reason", async () => {
    await pair();
    const result = await rulePairMerge(
      db(), admin, makeTenantContext(), "entity", S, L, "same case of 1835", 9_000, undefined,
      evidence(["matter", "dates"], [[L, dL], [S, dS]]),
    );
    expect(result.movedLinks).toBe(1);
    const [row] = await mergeRows();
    expect(row.detail.reason).toBe("same case of 1835");
    expect(row.detail.evidence).toEqual({ facts: ["dates", "matter"], descriptions: { [L]: [dL], [S]: [dS] } });
    expect((await loserRow())!.mergedInto).toBe(S);
  });

  it("refuses when a cited link is gone at confirm time", async () => {
    await pair();
    const racing = drizzle(
      beforeFirstBatch(() => env.DB.prepare("DELETE FROM description_entities WHERE id = 'lk-s'").run()),
      { schema },
    );
    expect(
      await refusal(rulePairMerge(racing, admin, makeTenantContext(), "entity", S, L, null, 9_000, undefined, evidence(["dates"], [[L, dL], [S, dS]]))),
    ).toEqual({ status: 409, body: "evidence_stale" });
    expect(await mergeRows()).toEqual([]);
    expect((await loserRow())!.mergedInto).toBeNull();
    expect((await db().select().from(schema.descriptionEntities).where(eq(schema.descriptionEntities.id, "lk-l")).get())!.entityId).toBe(L);
    expect(await db().select().from(schema.pendingDecisions).all()).toEqual([]);
  });

  it("the two routes answer a refusal with its evidence code and merge with the panel's fields", async () => {
    await pair();
    const card = "http://neogranadina.fisqua.test/admin/decisions/duplicates";
    const base: Array<[string, string]> = [["_action", "merge"], ["recordKind", "entities"], ["survivorId", S], ["loserId", L]];
    // The card's refusal names what the submitted records are, which words it.
    expect(await post(duplicatesAction, card, base)).toEqual({ ok: false, code: "evidence_facts", shape: "person" });
    expect(await post(duplicatesAction, card, [...base, ["evidence_fact", "dates"], ["evidence_description", `${S}:${dS}`]]))
      .toEqual({ ok: false, code: "evidence_loser", shape: "person" });
    const page = `http://neogranadina.fisqua.test/admin/decisions/pair?type=entities&a=${S}&b=${L}`;
    expect(await post(pairAction, page, [["_action", "merge"], ["survivorCode", "ne-s1"], ["evidence_fact", "dates"], ["evidence_description", `${L}:${dL}`]]))
      .toEqual({ ok: false, code: "evidence_survivor" });
    expect(await mergeRows()).toEqual([]);
    const merged = await post(pairAction, page, [
      ["_action", "merge"], ["survivorCode", "ne-s1"], ["reason", "same case"],
      ["evidence_fact", "kin"], ["evidence_description", `${L}:${dL}`], ["evidence_description", `${S}:${dS}`],
    ]);
    // The ruling redirects back to the queue.
    expect(merged).toBeInstanceOf(Response);
    expect((merged as Response).status).toBe(302);
    const [row] = await mergeRows();
    expect(row.detail).toMatchObject({ reason: "same case", evidence: { facts: ["kin"], descriptions: { [L]: [dL], [S]: [dS] } } });
  });

  it("place merges are unchanged", async () => {
    const survivor = await createTestPlace({ placeCode: "nl-s1" });
    const loser = await createTestPlace({ placeCode: "nl-l1" });
    const result = await rulePairMerge(db(), admin, makeTenantContext(), "place", survivor.id, loser.id, null, 9_000);
    expect(result.movedLinks).toBe(0);
    const [row] = await mergeRows();
    expect(row.recordType).toBe("place");
    expect(row.detail.evidence).toBeUndefined();
    // Evidence given for a place is ignored.
    const other = await createTestPlace({ placeCode: "nl-o1" });
    await rulePairMerge(db(), admin, makeTenantContext(), "place", survivor.id, other.id, null, 9_500, undefined, evidence([], []));
    expect((await mergeRows()).every((r) => r.detail.evidence === undefined)).toBe(true);
  });

  it("organisation and family entities need evidence too", async () => {
    for (const entityType of ["corporate", "family"]) {
      await cleanDatabase();
      await seedFederations();
      await seedTenants();
      const row = await createTestUser({ isAdmin: true });
      admin = makeUserContext({ id: row.id, tenantId: A, isAdmin: true });
      const repo = await createTestRepository({ tenantId: A, code: "repo-a" });
      dL = (await createTestDescription({ tenantId: A, repositoryId: repo.id })).id;
      dS = (await createTestDescription({ tenantId: A, repositoryId: repo.id })).id;
      await pair(entityType);
      expect(await refusal(rulePairMerge(db(), admin, makeTenantContext(), "entity", S, L, null))).toEqual({ status: 400, body: "evidence_facts" });
      // The card words the refusal by the submitted pair's type, a mixed pair generically.
      const card = "http://neogranadina.fisqua.test/admin/decisions/duplicates";
      const fields: Array<[string, string]> = [["_action", "merge"], ["recordKind", "entities"], ["survivorId", S], ["loserId", L]];
      expect(await post(duplicatesAction, card, fields)).toEqual({ ok: false, code: "evidence_facts", shape: entityType });
      await env.DB.prepare("UPDATE entities SET entity_type = 'person' WHERE id = ?").bind(L).run();
      expect(await post(duplicatesAction, card, fields)).toEqual({ ok: false, code: "evidence_facts", shape: "generic" });
      await env.DB.prepare("UPDATE entities SET entity_type = ? WHERE id = ?").bind(entityType, L).run();
      await rulePairMerge(db(), admin, makeTenantContext(), "entity", S, L, null, 9_000, undefined, evidence(["office"], [[L, dL], [S, dS]]));
      expect((await mergeRows())[0].detail.evidence.facts).toEqual(["office"]);
    }
  });
});

// @version v0.9.0
