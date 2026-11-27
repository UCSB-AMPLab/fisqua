/**
 * Tests — the shared merge dialog's search of vocabulary terms
 *
 * This suite pins how the merge dialog of the vocabulary term page
 * (`merge-dialog.tsx`) searches for terms. The dialog searches
 * `/admin/vocabularies/functions?_search=true`, which the functions
 * route's loader answers with a JSON array of terms, and the suite runs
 * that loader inside React Router's static handler. Requested as a
 * document, the route's page is given the array as its loader data, in
 * which the page's `terms` list is missing: the page cannot render it.
 * Loaded as the dialog's fetcher loads it, the route answers the array.
 * The URL is the one the dialog builds (`mergeSearchPath`), the source
 * term excluded.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { RouterContextProvider, createStaticHandler } from "react-router";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase, seedFederations, seedTenants, DEFAULT_TEST_FEDERATION_ID, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { tenantContext, userContext } from "../../app/context";
import { loader as functionsLoader } from "../../app/routes/_auth.admin.vocabularies.functions";
import { mergeSearchPath } from "../../app/lib/merge-search";

async function requestContext() {
  const row = await createTestUser({ isAdmin: true });
  const ctx = new RouterContextProvider();
  ctx.set(userContext, makeUserContext({ id: row.id, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true }));
  ctx.set(tenantContext, makeTenantContext({ id: DEFAULT_TEST_TENANT_ID }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

const handler = createStaticHandler([
  { id: "functions", path: "/admin/vocabularies/functions", loader: (args) => functionsLoader(args as any) },
]);

describe("the merge dialog's term search", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    const now = Date.now();
    await drizzle(env.DB, { schema }).insert(schema.vocabularyTerms).values([
      { id: "vt-a", federationId: DEFAULT_TEST_FEDERATION_ID, canonical: "Alcalde", status: "approved", entityCount: 0, createdAt: now, updatedAt: now },
      { id: "vt-b", federationId: DEFAULT_TEST_FEDERATION_ID, canonical: "Alcalde ordinario", status: "approved", entityCount: 0, createdAt: now, updatedAt: now },
    ]);
  });

  const url = () => `http://neogranadina.fisqua.test${mergeSearchPath("/admin/vocabularies/functions", " Alcalde ", "vt-a")}`;

  it("as a document request, gives the page the array, with no terms list to render", async () => {
    const context = await handler.query(new Request(url()), { requestContext: await requestContext() } as any);
    if (context instanceof Response) throw new Error("expected a render context");
    const data = context.loaderData.functions as Array<{ id: string }> & { terms?: unknown };
    expect(data.map((t) => t.id)).toEqual(["vt-b"]);
    expect(data.terms).toBeUndefined();
  });

  it("as the dialog's fetcher loads it, answers the matching terms, the source term left out", async () => {
    const res = await handler.queryRoute(new Request(url()), { routeId: "functions", requestContext: await requestContext() } as any);
    const data = (res instanceof Response ? await res.json() : res) as Array<{ id: string; displayName: string }>;
    expect(data.map((t) => [t.id, t.displayName])).toEqual([["vt-b", "Alcalde ordinario"]]);
  });
});

// @version v0.9.0
