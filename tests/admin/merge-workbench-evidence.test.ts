/**
 * Tests — evidence for merges in the merge workbench
 *
 * This suite pins the evidence the entity merge workbench requires. The
 * workbench merges the `:id` record into the survivor the steward chose.
 * Its note is optional; the evidence is not. The action refuses a merge
 * with no fact, or no cited description on one side, writing nothing; a
 * merge with evidence and an empty note records `detail.evidence` as
 * description ids and `detail.reason` as null. A cited link removed
 * between the check and the batch returns `evidence_stale`.
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
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestEntity } from "../helpers/entities";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { tenantContext, userContext, type User } from "../../app/context";
import { action } from "../../app/routes/_auth.admin.entities.$id.merge";

const A = DEFAULT_TEST_TENANT_ID;
const S = "ent-survivor";
const L = "ent-loser";

function db() {
  return drizzle(env.DB, { schema });
}

let admin: User;
let dL: string;
let dS: string;

function context(DB: D1Database = env.DB): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, admin);
  ctx.set(tenantContext, makeTenantContext({ id: A }));
  (ctx as any).cloudflare = { env: { ...env, DB } };
  return ctx;
}

async function merge(fields: Array<[string, string]>, DB?: D1Database) {
  const form = new FormData();
  for (const [k, v] of [["survivorId", S], ["linkIds", JSON.stringify(["lk-l"])], ...fields]) form.append(k, v);
  return action({
    request: new Request(`http://neogranadina.fisqua.test/admin/entities/${L}/merge`, { method: "POST", body: form }),
    context: context(DB),
    params: { id: L },
  } as any);
}

async function mergeRows() {
  return (await db().select().from(schema.authorityOperations).where(eq(schema.authorityOperations.operation, "merge")).all())
    .map((r) => ({ ...r, detail: JSON.parse(r.detail ?? "null") }));
}

describe("the merge workbench and the evidence for a merge", () => {
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
    dL = (await createTestDescription({ tenantId: A, repositoryId: repo.id })).id;
    dS = (await createTestDescription({ tenantId: A, repositoryId: repo.id })).id;
    await createTestEntity({ id: S, entityCode: "ne-s1", displayName: "Domingo Caycedo" });
    await createTestEntity({ id: L, entityCode: "ne-l1", displayName: "Domingo Caicedo" });
    for (const [id, d, e] of [["lk-l", dL, L], ["lk-s", dS, S]]) {
      await db().insert(schema.descriptionEntities).values({ id, descriptionId: d, entityId: e, role: "creator", sequence: 0, createdAt: 1 });
    }
  });

  it("workbench merge without evidence is refused", async () => {
    expect(await merge([["reason", "same name"]])).toEqual({ ok: false, error: "evidence_facts" });
    expect(await merge([["evidence_fact", "dates"], ["evidence_description", `${L}:${dL}`]])).toEqual({ ok: false, error: "evidence_survivor" });
    expect(await merge([["evidence_fact", "dates"], ["evidence_description", `${S}:${dS}`]])).toEqual({ ok: false, error: "evidence_loser" });
    expect(await merge([["evidence_fact", "dates"], ["evidence_description", `${L}:${dS}`], ["evidence_description", `${S}:${dS}`]]))
      .toEqual({ ok: false, error: "evidence_unlinked" });
    expect(await mergeRows()).toEqual([]);
    expect((await db().select().from(schema.entities).where(eq(schema.entities.id, L)).get())!.mergedInto).toBeNull();
  });

  it("workbench merge with evidence and an empty reason succeeds and records detail.evidence and reason null", async () => {
    const res = (await merge([
      ["reason", "  "], ["evidence_fact", "matter"], ["evidence_fact", "dates"],
      ["evidence_description", `${L}:${dL}`], ["evidence_description", `${S}:${dS}`],
    ])) as Response;
    expect(res.status).toBe(302);
    const [row] = await mergeRows();
    expect(row.detail.reason).toBeNull();
    expect(row.detail.evidence).toEqual({ facts: ["dates", "matter"], descriptions: { [L]: [dL], [S]: [dS] } });
    expect((await db().select().from(schema.entities).where(eq(schema.entities.id, L)).get())!.mergedInto).toBe(S);
  });

  it("refuses when a cited link is gone at confirm time", async () => {
    let done = false;
    const racing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!done) {
              done = true;
              await target.prepare("DELETE FROM description_entities WHERE id = 'lk-s'").run();
            }
            return target.batch(statements);
          };
        }
        const value = (target as any)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(await merge([
      ["evidence_fact", "kin"], ["evidence_description", `${L}:${dL}`], ["evidence_description", `${S}:${dS}`],
    ], racing)).toEqual({ ok: false, error: "evidence_stale" });
    expect(await mergeRows()).toEqual([]);
    expect((await db().select().from(schema.descriptionEntities).where(eq(schema.descriptionEntities.id, "lk-l")).get())!.entityId).toBe(L);
  });
});

// @version v0.9.0
