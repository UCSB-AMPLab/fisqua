/**
 * Tests — publish page renders before its counts
 *
 * This suite pins the split between the publish page loader
 * (`_auth.admin.publish.tsx`) and the counts resource route
 * (`_auth.admin.publish.counts.tsx`). The page loader returns the
 * fonds list, the active export and the run history without running
 * the pre-flight counts: `getPublishChangelog` is replaced here by a
 * stub that never settles and records its calls, so a loader that
 * awaited it would hang and the test would time out. The counts route
 * returns the changelog as JSON for the page to fetch after it renders.
 *
 * The counts route keeps the page's gates: it 404s when the tenant has
 * `publish_pipeline` off (before anything else, superadmin or not),
 * 403s for anyone who is not a superadmin, and passes the export
 * scope's member tenants, the federation and the authorities
 * capability to `getPublishChangelog`. When the counts fail it answers
 * 500 with `{ ok: false }`, which the page turns into its retry notice
 * while the publish form stays usable.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { AHR_TENANT_ID } from "../../app/lib/tenant";
import { seedFederationFixture } from "../helpers/federation-fixture";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";

const counts = vi.hoisted(() => ({
  calls: [] as unknown[],
  mode: "pending" as "pending" | "resolve" | "reject",
}));

vi.mock("~/lib/export/publish-changelog.server", () => ({
  getPublishChangelog: (_db: unknown, scope: unknown) => {
    counts.calls.push(scope);
    if (counts.mode === "reject") return Promise.reject(new Error("D1 timeout"));
    if (counts.mode === "resolve") {
      return Promise.resolve({
        descriptions: [{ fonds: "co-ahrb-gob", fondsLabel: "Gobierno", added: 1, modified: 2, unpublished: 0 }],
        repositories: { modified: 3 },
        entities: { modified: 4 },
        places: { modified: 5 },
      });
    }
    return new Promise(() => {});
  },
}));

function buildContext(user: User, overrides: { publishPipelineEnabled?: boolean; authoritiesEnabled?: boolean } = {}): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(
    tenantContext,
    makeTenantContext({
      publishPipelineEnabled: overrides.publishPipelineEnabled ?? true,
      authoritiesEnabled: overrides.authoritiesEnabled ?? true,
    }),
  );
  (ctx as any).cloudflare = { env };
  return ctx;
}

const superAdmin = () => makeUserContext({ tenantId: DEFAULT_TEST_TENANT_ID, isSuperAdmin: true, isAdmin: true });

describe("publish page loader", () => {
  beforeAll(async () => {
    await applyMigrations();
    await import("../../app/routes/_auth.admin.publish");
  });

  beforeEach(async () => {
    await cleanDatabase();
    counts.calls = [];
    counts.mode = "pending";
  });

  it("returns the page data without waiting for the counts", async () => {
    const { loader } = await import("../../app/routes/_auth.admin.publish");
    const data = (await loader({
      request: new Request("https://example.com/admin/publish"),
      context: buildContext(superAdmin()),
      params: {},
    } as any)) as any;

    expect(data.authorized).toBe(true);
    expect(Array.isArray(data.fondsList)).toBe(true);
    expect(data.activeExport).toBeNull();
    expect(data.history).toEqual([]);
    expect(data).not.toHaveProperty("changelog");
    expect(counts.calls).toHaveLength(0);
  });
});

describe("publish counts resource route", () => {
  beforeAll(async () => {
    await applyMigrations();
    await import("../../app/routes/_auth.admin.publish.counts");
  });

  beforeEach(async () => {
    await cleanDatabase();
    counts.calls = [];
    counts.mode = "resolve";
  });

  async function call(user: User, overrides?: { publishPipelineEnabled?: boolean; authoritiesEnabled?: boolean }) {
    const { loader } = await import("../../app/routes/_auth.admin.publish.counts");
    try {
      return (await loader({
        request: new Request("https://example.com/admin/publish/counts"),
        context: buildContext(user, overrides),
        params: {},
      } as any)) as Response;
    } catch (e) {
      if (e instanceof Response) return e;
      throw e;
    }
  }

  it("returns the changelog for the export scope", async () => {
    // A second member of the lead's federation (`ahr`) and a tenant in
    // another federation (the seeded second tenant): the scope must be
    // exactly the two members.
    await seedFederationFixture(drizzle(env.DB, { schema }));
    const res = await call(superAdmin(), { authoritiesEnabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      changelog: {
        descriptions: [{ fonds: "co-ahrb-gob", fondsLabel: "Gobierno", added: 1, modified: 2, unpublished: 0 }],
        repositories: { modified: 3 },
        entities: { modified: 4 },
        places: { modified: 5 },
      },
    });
    expect(counts.calls).toHaveLength(1);
    const scope = counts.calls[0] as { memberTenantIds: string[]; federationId: string; authoritiesEnabled: boolean };
    expect([...scope.memberTenantIds].sort()).toEqual(
      [DEFAULT_TEST_TENANT_ID, AHR_TENANT_ID].sort(),
    );
    expect(scope.memberTenantIds).not.toContain(SECOND_TEST_TENANT_ID);
    expect(scope.federationId).toBe(makeTenantContext().federationId);
    expect(scope.authoritiesEnabled).toBe(false);
  });

  it("answers 500 with ok: false when the counts fail", async () => {
    counts.mode = "reject";
    const res = await call(superAdmin());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false });
  });

  it("refuses anyone who is not a superadmin", async () => {
    const res = await call(makeUserContext({ tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true }));
    expect(res.status).toBe(403);
    expect(counts.calls).toHaveLength(0);
  });

  it("404s when the publish pipeline is off, superadmin or not", async () => {
    // The capability gate runs before the superadmin check, so a
    // non-superadmin gets 404 here, not 403.
    const users = [
      superAdmin(),
      makeUserContext({ tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true }),
    ];
    for (const user of users) {
      const res = await call(user, { publishPipelineEnabled: false });
      expect(res.status, `isSuperAdmin=${user.isSuperAdmin}`).toBe(404);
    }
    expect(counts.calls).toHaveLength(0);
  });
});

// @version v0.9.0
