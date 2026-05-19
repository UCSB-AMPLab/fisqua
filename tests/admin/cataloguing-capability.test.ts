/**
 * Tests — admin cataloguing layout capability gate
 *
 * This suite pins the `_auth.admin.cataloguing` layout loader, which throws
 * `Response(null, {status: 404})` when the resolved tenant has the
 * `crowdsourcing` capability flag off. Pairs with the sidebar gate
 * (UX layer) as belt-and-braces against direct-URL access; this file
 * exercises the structural layer.
 *
 * The dormant-flag case covers a key invariant: a user carrying
 * `isCataloguer = true` on a `crowdsourcing = off` tenant cannot
 * reach the cataloguing surface (the route 404s); the flag stays in
 * the DB unchanged because nothing auto-clears it. The flag becomes
 * a no-op precisely because every route that consumes it is gated by
 * `requireCapability(tenant, "crowdsourcing")`.
 *
 * Test mechanics: each case constructs a `RouterContextProvider`
 * pre-populated with `userContext`, `tenantContext`, and
 * `cloudflare.env`, then invokes the loader directly. The synthetic
 * `Request` uses `localhost` so no Host-header tenant resolution
 * runs — we set `tenantContext` on the context manually, mirroring
 * what `authMiddleware` would do at the edge. Throw-Response shape
 * follows `tests/admin/users.test.ts` (try / `expect.fail` / catch /
 * `Response` / `.status === 404`).
 *
 * Threat model coverage: direct-URL access to a capability-off
 * route; dormant-flag backstop.
 *
 * @version v0.4.0
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
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";

function buildContext(args: {
  user: User;
  crowdsourcingEnabled: boolean;
}): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, args.user);
  ctx.set(
    tenantContext,
    makeTenantContext({
      id: args.user.tenantId,
      slug:
        args.user.tenantId === SECOND_TEST_TENANT_ID
          ? "second-tenant"
          : "neogranadina",
      crowdsourcingEnabled: args.crowdsourcingEnabled,
      // Other capabilities stay ON so the crowdsourcing gate is
      // exercised in isolation.
      vocabularyHubEnabled: true,
      publishPipelineEnabled: true,
      multiRepositoryEnabled: true,
    }),
  );
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function seedUser(
  db: ReturnType<typeof drizzle>,
  args: { tenantId: string; flags?: Partial<typeof schema.users.$inferInsert> },
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(schema.users).values({
    tenantId: args.tenantId,
    id,
    email: `user-${id.slice(0, 8)}@example.com`,
    name: "Test User",
    isAdmin: false,
    isSuperAdmin: false,
    isCollabAdmin: false,
    isArchiveUser: false,
    isUserManager: false,
    isCataloguer: false,
    createdAt: now,
    updatedAt: now,
    ...args.flags,
  });
  return id;
}

describe("admin cataloguing layout capability gate", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("layout 404s when crowdsourcing is off (collab-admin user on second tenant)", async () => {
    // Seed an admin user on the second tenant (which has
    // crowdsourcing = off in the seed). Even with isCollabAdmin =
    // true, the route 404s because the capability gate runs after
    // the role guard.
    const collabAdmin = makeUserContext({
      tenantId: SECOND_TEST_TENANT_ID,
      isCollabAdmin: true,
    });
    const ctx = buildContext({
      user: collabAdmin,
      crowdsourcingEnabled: false,
    });

    const { loader } = await import(
      "../../app/routes/_auth.admin.cataloguing"
    );

    try {
      await loader({
        request: new Request(
          "http://second-tenant.fisqua.test/admin/cataloguing",
        ),
        context: ctx,
        params: {},
      } as any);
      expect.fail("Should have thrown 404");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
  });

  it("layout returns 200-equivalent (no throw) when crowdsourcing is on (Neogranadina)", async () => {
    const collabAdmin = makeUserContext({
      tenantId: DEFAULT_TEST_TENANT_ID,
      isCollabAdmin: true,
    });
    const ctx = buildContext({
      user: collabAdmin,
      crowdsourcingEnabled: true,
    });

    const { loader } = await import(
      "../../app/routes/_auth.admin.cataloguing"
    );

    // The collab-admin guard passes and the capability gate passes;
    // the loader returns its normal `{ user }` payload.
    const res = (await loader({
      request: new Request(
        "http://catalogacion.zasqua.org/admin/cataloguing",
      ),
      context: ctx,
      params: {},
    } as any)) as any;

    expect(res).toBeDefined();
    expect(res.user).toBeDefined();
    expect(res.user.tenantId).toBe(DEFAULT_TEST_TENANT_ID);
  });

 it("dormant flag: isCataloguer=true on crowdsourcing-off tenant cannot reach surface", async () => {
    const db = drizzle(env.DB);
    // Seed a user with isCataloguer=true on the second tenant. The
    // flag is dormant -- crowdsourcing is off, so it cannot activate
    // the cataloguing surface, and nothing auto-clears it.
    const userId = await seedUser(db, {
      tenantId: SECOND_TEST_TENANT_ID,
      flags: { isAdmin: true, isCollabAdmin: true, isCataloguer: true },
    });

    const dormantUser = makeUserContext({
      id: userId,
      tenantId: SECOND_TEST_TENANT_ID,
      isAdmin: true,
      isCollabAdmin: true,
      isCataloguer: true,
    });
    const ctx = buildContext({
      user: dormantUser,
      crowdsourcingEnabled: false,
    });

    const { loader } = await import(
      "../../app/routes/_auth.admin.cataloguing"
    );

    try {
      await loader({
        request: new Request(
          "http://second-tenant.fisqua.test/admin/cataloguing",
        ),
        context: ctx,
        params: {},
      } as any);
      expect.fail("Should have thrown 404");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }

    // The dormant flag stays in the DB unchanged -- no auto-clear.
    const row = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .get();
    expect(row).toBeTruthy();
    expect(row!.isCataloguer).toBeTruthy();
    expect(row!.isCollabAdmin).toBeTruthy();
  });
});
