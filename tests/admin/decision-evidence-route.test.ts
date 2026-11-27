/**
 * Tests — the descriptions a duplicate pair's merge may cite
 *
 * This suite pins how the merge dialog of the duplicates page gets the
 * descriptions a pair's merge may cite. The duplicates page reads its
 * entity pairs from the stored list, and reads no descriptions
 * besides: its merge dialog loads the two records' descriptions from
 * `/admin/decisions/evidence` when it opens. The suite pins that the
 * duplicates loader sends no statement reading descriptions for the
 * evidence panel, and that the evidence route answers a pair with the
 * acting tenant's descriptions of each record and nothing of another
 * tenant's descriptions, and answers 404 for a pair that is not two
 * existing, visible, unmerged records. A pair that has gone is answered as
 * data, so the dialog's fetcher, which React Router reloads after the
 * pair's own merge, reaches no error boundary: this runs in a memory data
 * router, through the merge to the reload.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { RouterContextProvider, createMemoryRouter } from "react-router";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedFederations,
  seedTenants,
  DEFAULT_TEST_FEDERATION_ID,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestEntity } from "../helpers/entities";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { tenantContext, userContext, type User } from "../../app/context";
import { loader as duplicatesLoader } from "../../app/routes/_auth.admin.decisions.duplicates";
import { loader as evidenceLoader } from "../../app/routes/_auth.admin.decisions.evidence";

const A = DEFAULT_TEST_TENANT_ID;
const B = SECOND_TEST_TENANT_ID;

let admin: User;
let statements: string[];

/** The test D1, recording every statement it prepares. */
function recording(): D1Database {
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          statements.push(query);
          return target.prepare(query);
        };
      }
      const value = (target as any)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function context(): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, admin);
  ctx.set(tenantContext, makeTenantContext({ id: A }));
  (ctx as any).cloudflare = { env: { ...env, DB: recording() } };
  return ctx;
}

async function link(id: string, descriptionId: string, entityId: string) {
  await drizzle(env.DB, { schema }).insert(schema.descriptionEntities).values({
    id, descriptionId, entityId, role: "creator", sequence: 0, createdAt: 1,
  });
}

describe("the evidence descriptions of a duplicate pair", () => {
  let dA1: string;
  let dA2: string;
  let dB1: string;

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    statements = [];
    const row = await createTestUser({ isAdmin: true });
    admin = makeUserContext({ id: row.id, tenantId: A, isAdmin: true });
    const repoA = await createTestRepository({ tenantId: A, code: "repo-a" });
    const repoB = await createTestRepository({ tenantId: B, code: "repo-b" });
    dA1 = (await createTestDescription({ tenantId: A, repositoryId: repoA.id, referenceCode: "a-1", title: "Causa criminal" })).id;
    dA2 = (await createTestDescription({ tenantId: A, repositoryId: repoA.id, referenceCode: "a-2" })).id;
    dB1 = (await createTestDescription({ tenantId: B, repositoryId: repoB.id, referenceCode: "b-1" })).id;
    await createTestEntity({ id: "ent-a", entityCode: "ne-a1", displayName: "Domingo Caycedo", sortName: "Caycedo, Domingo" });
    await createTestEntity({ id: "ent-b", entityCode: "ne-b1", displayName: "Domingo Caycedo", sortName: "Caycedo, Domingo" });
    // The pair as the scheduled recheck stores it.
    await env.DB.prepare(
      "INSERT INTO duplicate_candidates (id_a, id_b, federation_id, tenant_id, facts, weight, computed_at) VALUES ('ent-a', 'ent-b', ?, ?, ?, 4, 1)",
    )
      .bind(
        DEFAULT_TEST_FEDERATION_ID,
        A,
        JSON.stringify({
          warning: null,
          offices: ["Alcalde"],
          associates: [],
          documents: [],
          dates: { a: null, b: null, overlap: false },
          places: [],
          more: { associates: 0, documents: 0, places: 0 },
        }),
      )
      .run();
    await link("l-a1", dA1, "ent-a");
    await link("l-b2", dA2, "ent-b");
    // Another tenant's description, linked to the shared record.
    await link("l-a9", dB1, "ent-a");
  });

  it("the duplicates loader no longer reads descriptions", async () => {
    const data: any = await duplicatesLoader({
      request: new Request("http://neogranadina.fisqua.test/admin/decisions/duplicates"),
      context: context(),
      params: {},
    } as any);
    expect(data.pairs).toHaveLength(1);
    expect(data.pairs[0].a.descriptions).toBeUndefined();
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter((q) => /ROW_NUMBER\(\)/.test(q) || /reference_code/.test(q))).toEqual([]);
  });

  async function evidence(a: string, b: string) {
    const res = (await evidenceLoader({
      request: new Request(`http://neogranadina.fisqua.test/admin/decisions/evidence?a=${a}&b=${b}`),
      context: context(),
      params: {},
    } as any)) as Response;
    return res.json() as Promise<{ a: string; b: string; descriptions: Record<string, Array<{ id: string; code: string; title: string }>> }>;
  }

  it("returns the pair's descriptions of the acting tenant, in one read with retries", async () => {
    const answer = await evidence("ent-a", "ent-b");
    expect(answer.a).toBe("ent-a");
    expect(answer.descriptions["ent-a"].map((d) => d.id)).toEqual([dA1]);
    expect(answer.descriptions["ent-a"][0]).toMatchObject({ code: "a-1", title: "Causa criminal" });
    expect(answer.descriptions["ent-b"].map((d) => d.id)).toEqual([dA2]);
    expect(JSON.stringify(answer)).not.toContain(dB1);
  });

  async function status(query: string) {
    statements = [];
    return evidenceLoader({
      request: new Request(`http://neogranadina.fisqua.test/admin/decisions/evidence?${query}`),
      context: context(),
      params: {},
    } as any).then((r) => (r as Response).status, (e) => (e instanceof Response ? e.status : Promise.reject(e)));
  }

  it("answers 404 unless both records exist, are the tenant's to see and are not merged away", async () => {
    await createTestEntity({ id: "ent-own", entityCode: "ot-o1", displayName: "Otro" });
    await env.DB.prepare("UPDATE entities SET tenant_id = ? WHERE id = 'ent-own'").bind(B).run();
    await link("l-o1", dA1, "ent-own");
    await createTestEntity({ id: "ent-gone", entityCode: "ne-g1", displayName: "Fusionado", mergedInto: "ent-b" });

    expect(await status("a=ent-a&b=ent-b")).toBe(200);
    // Another tenant's own record.
    expect(await status("a=ent-a&b=ent-own")).toBe(404);
    // A record merged away.
    expect(await status("a=ent-a&b=ent-gone")).toBe(404);
    // A record that does not exist.
    expect(await status("a=ent-a&b=ent-none")).toBe(404);
    // A malformed pair reads nothing.
    expect(await status("a=ent-a&b=ent-a")).toBe(404);
    expect(statements).toEqual([]);
    expect(await status("a=ent-a")).toBe(404);
    expect(statements).toEqual([]);
  });

  it("answers a pair that has gone as data, so a fetcher revalidated after the merge reaches no error boundary", async () => {
    // A data router as the duplicates page has it: the page and the evidence route under one root.
    const router = createMemoryRouter(
      [
        {
          id: "root",
          path: "/",
          children: [
            { id: "duplicates", path: "admin/decisions/duplicates", loader: () => ({ ok: true }) },
            { id: "evidence", path: "admin/decisions/evidence", loader: (args) => evidenceLoader({ ...args, context: context() } as any) },
          ],
        },
      ],
      { initialEntries: ["/admin/decisions/duplicates"] },
    );
    await router.initialize();
    const settled = () =>
      new Promise<void>((resolve) => {
        const check = () => router.state.navigation.state === "idle" && (router.state.fetchers.get("ev")?.state ?? "idle") === "idle" && router.state.revalidation === "idle";
        if (check()) return resolve();
        const off = router.subscribe(() => {
          if (check()) {
            off();
            resolve();
          }
        });
      });
    // Mounted, as `useFetcher` mounts it, so the router keeps it and revalidates it. Every
    // state the router reaches is watched: its last answer for the fetcher, and any error.
    router.getFetcher("ev");
    let last: any;
    const errors: unknown[] = [];
    router.subscribe((st) => {
      const f = st.fetchers.get("ev");
      if (f && f.state === "idle" && f.data !== undefined) last = f.data;
      if (st.errors) errors.push(st.errors);
    });
    const fetcherData = () => last;
    await router.fetch("ev", "duplicates", "/admin/decisions/evidence?a=ent-a&b=ent-b");
    await settled();
    expect(router.state.errors).toBeNull();
    expect(fetcherData().descriptions["ent-a"]).toHaveLength(1);

    // The pair is merged; React Router then reloads the open fetcher.
    await env.DB.prepare("UPDATE entities SET merged_into = 'ent-b' WHERE id = 'ent-a'").run();
    router.revalidate();
    await new Promise((r) => setTimeout(r, 0));
    await settled();
    expect(router.state.errors).toBeNull();
    expect(errors).toEqual([]);
    expect(fetcherData()).toEqual({ a: "ent-a", b: "ent-b", gone: true });
    router.dispose();
  });
});

// @version v0.9.0
