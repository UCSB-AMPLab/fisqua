/**
 * Tests — area admins at the route boundary
 *
 * This suite checks area admins at the route boundary. Each area admin
 * reaches their own area's admin pages and nothing else. For every area
 * this suite calls one of the area's loaders, the other areas' loaders,
 * and the two surfaces that stay with the workspace admin
 * (`/projects/new` and `/admin/users`), as a user who holds that area's
 * flag alone:
 *
 *   - records: `/admin/descriptions` answers, `/admin/entities` 403s;
 *   - authorities: `/admin/entities` answers, `/admin/descriptions` 403s;
 *   - imports: `/admin/imports` answers, both module pages 403;
 *   - digitization: every page here 403s (its own screens are pinned in
 *     `tests/capture/screens.test.ts`);
 *
 * and `/projects/new` and `/admin/users` 403 for all four. The Pending
 * decisions layout admits records and authorities admins, shows each
 * only its own area's tabs, and refuses the other two; its proposals
 * tab redirects a records-only admin to the vocabulary tab. A workspace
 * admin is the control: every page answers.
 *
 * The dashboard's Pending decisions counts follow the same split: with
 * one open authority proposal and one proposed vocabulary term waiting,
 * a records admin is given only the vocabulary count, an authorities
 * admin only the authority count, a workspace admin both, and the
 * imports and digitization admins no card at all. Each count also needs
 * its tab's capability: authorities for proposals, the vocabulary hub
 * for vocabulary.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedFederations,
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { loader as descriptionsLoader } from "../../app/routes/_auth.admin.descriptions";
import { loader as entitiesLoader } from "../../app/routes/_auth.admin.entities";
import { loader as importsLoader } from "../../app/routes/_auth.admin.imports";
import { loader as decisionsLayoutLoader } from "../../app/routes/_auth.admin.decisions";
import { loader as proposalsLoader } from "../../app/routes/_auth.admin.decisions._index";
import { loader as newProjectLoader } from "../../app/routes/_auth.projects.new";
import { loader as usersLoader } from "../../app/routes/_auth.admin.users";
import { loader as dashboardLoader } from "../../app/routes/_auth.dashboard";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import { NEOGRANADINA_FEDERATION_ID } from "../../app/lib/tenant";

type Loader = (args: any) => Promise<unknown>;

function context(user: User): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ id: user.tenantId, importsEnabled: true }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function status(loader: Loader, path: string, user: User): Promise<number> {
  try {
    await loader({
      request: new Request(`http://neogranadina.fisqua.test${path}`),
      context: context(user),
      params: {},
    });
    return 200;
  } catch (e) {
    if (e instanceof Response) return e.status;
    throw e;
  }
}

const PAGES: Record<string, [Loader, string]> = {
  descriptions: [descriptionsLoader, "/admin/descriptions"],
  entities: [entitiesLoader, "/admin/entities"],
  imports: [importsLoader, "/admin/imports"],
  newProject: [newProjectLoader, "/projects/new"],
  users: [usersLoader, "/admin/users"],
};

const EXPECTED: Record<string, Record<keyof typeof PAGES, number>> = {
  isRecordsAdmin: { descriptions: 200, entities: 403, imports: 403, newProject: 403, users: 403 },
  isAuthoritiesAdmin: { descriptions: 403, entities: 200, imports: 403, newProject: 403, users: 403 },
  isImportsAdmin: { descriptions: 403, entities: 403, imports: 200, newProject: 403, users: 403 },
  isDigitizationAdmin: { descriptions: 403, entities: 403, imports: 403, newProject: 403, users: 403 },
  isAdmin: { descriptions: 200, entities: 200, imports: 200, newProject: 200, users: 200 },
};

async function userWith(flag: string): Promise<User> {
  const row = await createTestUser({});
  return makeUserContext({ id: row.id, tenantId: DEFAULT_TEST_TENANT_ID, [flag]: true });
}

describe("area admins at the route boundary", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
  });

  for (const [flag, pages] of Object.entries(EXPECTED)) {
    for (const [page, expected] of Object.entries(pages)) {
      const [loader, path] = PAGES[page];
      it(`${flag}: ${path} answers ${expected}`, async () => {
        expect(await status(loader, path, await userWith(flag))).toBe(expected);
      });
    }
  }

  it("the Pending decisions layout shows each admin only their own area's tabs", async () => {
    const run = async (flag: string) =>
      (await decisionsLayoutLoader({
        request: new Request("http://neogranadina.fisqua.test/admin/decisions"),
        context: context(await userWith(flag)),
        params: {},
      } as any)) as { authorities: boolean; vocabulary: boolean };
    expect(await run("isRecordsAdmin")).toEqual({ authorities: false, vocabulary: true });
    expect(await run("isAuthoritiesAdmin")).toEqual({ authorities: true, vocabulary: false });
    expect(await run("isAdmin")).toEqual({ authorities: true, vocabulary: true });
    for (const flag of ["isImportsAdmin", "isDigitizationAdmin"]) {
      expect(await status(decisionsLayoutLoader as Loader, "/admin/decisions", await userWith(flag))).toBe(403);
    }
  });

  it("the proposals tab sends a records-only admin to the vocabulary tab", async () => {
    const open = async (flag: string) => {
      try {
        await proposalsLoader({
          request: new Request("http://neogranadina.fisqua.test/admin/decisions"),
          context: context(await userWith(flag)),
          params: {},
        } as any);
        return "200";
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        const res = e as Response;
        return res.status === 302 ? `302 ${res.headers.get("Location")}` : String(res.status);
      }
    };
    expect(await open("isRecordsAdmin")).toBe("302 /admin/decisions/vocabulary");
    expect(await open("isAuthoritiesAdmin")).toBe("200");
    expect(await open("isImportsAdmin")).toBe("403");
  });

  it("the dashboard gives each admin only their own area's pending counts", async () => {
    const db = drizzle(env.DB, { schema });
    const now = Date.now();
    await db.insert(schema.pendingDecisions).values({
      id: crypto.randomUUID(),
      federationId: NEOGRANADINA_FEDERATION_ID,
      tenantId: DEFAULT_TEST_TENANT_ID,
      kind: "authority-proposal",
      payload: JSON.stringify({
        heading: "Testamentos",
        proposedType: "topic",
        proposedName: "Testamentos",
        action: "mint",
      }),
      sourceModule: "test-fixture",
      status: "open",
      createdAt: now,
    });
    await db.insert(schema.vocabularyTerms).values({
      id: crypto.randomUUID(),
      federationId: NEOGRANADINA_FEDERATION_ID,
      canonical: "escribano de prueba",
      status: "proposed",
      createdAt: now,
      updatedAt: now,
    });
    const counts = async (
      flag: string,
      caps: { authoritiesEnabled?: boolean; vocabularyHubEnabled?: boolean } = {},
    ) => {
      const user = await userWith(flag);
      const ctx = new RouterContextProvider();
      ctx.set(userContext, user);
      ctx.set(
        tenantContext,
        makeTenantContext({ id: user.tenantId, crowdsourcingEnabled: false, ...caps }),
      );
      (ctx as any).cloudflare = { env };
      const data = (await dashboardLoader({
        request: new Request("http://neogranadina.fisqua.test/dashboard"),
        context: ctx,
        params: {},
      } as any)) as { pendingDecisions: unknown };
      return data.pendingDecisions;
    };
    expect(await counts("isRecordsAdmin")).toEqual({ authorityProposals: 0, vocabularyProposals: 1 });
    expect(await counts("isAuthoritiesAdmin")).toEqual({ authorityProposals: 1, vocabularyProposals: 0 });
    expect(await counts("isAdmin")).toEqual({ authorityProposals: 1, vocabularyProposals: 1 });
    expect(await counts("isImportsAdmin")).toBeNull();
    // Each count also needs the capability its tab sits behind.
    expect(await counts("isAuthoritiesAdmin", { authoritiesEnabled: false })).toBeNull();
    expect(await counts("isRecordsAdmin", { vocabularyHubEnabled: false })).toBeNull();
    expect(await counts("isAdmin", { authoritiesEnabled: false })).toEqual({
      authorityProposals: 0,
      vocabularyProposals: 1,
    });
    expect(await counts("isAdmin", { vocabularyHubEnabled: false })).toEqual({
      authorityProposals: 1,
      vocabularyProposals: 0,
    });
    expect(await counts("isDigitizationAdmin")).toBeNull();
  });
});
