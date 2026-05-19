/**
 * Tests — admin publish + promote layout capability gate
 *
 * This suite pins the `_auth.admin.publish` page loader and the
 * `_auth.admin.promote` legacy redirect, both of which throw
 * `Response(null, {status: 404})` when
 * the resolved tenant has the `publish_pipeline` capability flag
 * off. Pairs with the sidebar gate (which hides the Publish nav item
 * AND the Promote sub-item under cataloguing when publish_pipeline
 * is off) as belt-and-braces against direct-URL access.
 *
 * The seed fixture's second tenant has
 * `publish_pipeline_enabled = 0`, so the off-case here exercises the
 * seeded shape directly. The on-case overrides the second tenant's
 * `publishPipelineEnabled` to `true` so we can confirm the gate
 * does not throw on a permissive tenant; we test the
 * non-superadmin branch (which returns `authorized: false`) to avoid
 * exercising the heavy CTE/D1 queries the superadmin branch fans out
 * to (those are covered by the `_auth.admin.publish.tsx` integration
 * suite when run end-to-end off-laptop).
 *
 * Threat model coverage: T-31-04-02.
 *
 * @version v0.4.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
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
  publishPipelineEnabled: boolean;
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
      publishPipelineEnabled: args.publishPipelineEnabled,
      // Other capabilities stay ON so the publish_pipeline gate is
      // exercised in isolation.
      crowdsourcingEnabled: true,
      vocabularyHubEnabled: true,
      multiRepositoryEnabled: true,
    }),
  );
  (ctx as any).cloudflare = { env };
  return ctx;
}

describe("admin publish layout capability gate", () => {
  beforeAll(async () => {
    await applyMigrations();
    // Warm the publish-route module cache so the first `it` does not
    // pay cold-load cost inside its 5s timeout. On warm dev laptops
    // the lazy import resolves in <100ms; on a cold CI runner the
    // initial Workers-pool transform pushes past 5s and the first
    // test times out. Hoisting the import here keeps the per-test
    // budget honest.
    await import("../../app/routes/_auth.admin.publish");
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("publish layout 404s when publish_pipeline is off (superadmin user, second tenant)", async () => {
    // Even a superadmin on a publish-off tenant cannot reach the
    // publish surface -- the capability gate runs before the
    // authorized check.
    const superAdmin = makeUserContext({
      tenantId: SECOND_TEST_TENANT_ID,
      isSuperAdmin: true,
    });
    const ctx = buildContext({
      user: superAdmin,
      publishPipelineEnabled: false,
    });

    const { loader } = await import("../../app/routes/_auth.admin.publish");

    try {
      await loader({
        request: new Request(
          "http://second-tenant.fisqua.test/admin/publish",
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

  it("publish layout returns the unauthorized shape (no throw) when publish_pipeline is on but user is not superadmin", async () => {
    // Non-superadmin path stays as v0.3 behaviour: the loader returns
    // `{ authorized: false, ... }` and the JSX surfaces a "superadmin
    // required" notice. Capability is on, so the gate does not throw.
    const archiveUser = makeUserContext({
      tenantId: DEFAULT_TEST_TENANT_ID,
      isArchiveUser: true,
    });
    const ctx = buildContext({
      user: archiveUser,
      publishPipelineEnabled: true,
    });

    const { loader } = await import("../../app/routes/_auth.admin.publish");

    const res = (await loader({
      request: new Request("http://catalogacion.zasqua.org/admin/publish"),
      context: ctx,
      params: {},
    } as any)) as any;

    expect(res).toBeDefined();
    expect(res.authorized).toBe(false);
    // Shape preserved: empty fondsList, null changelog, null
    // activeExport, empty history.
    expect(res.fondsList).toEqual([]);
    expect(res.changelog).toBeNull();
    expect(res.activeExport).toBeNull();
    expect(res.history).toEqual([]);
  });
});

describe("admin promote legacy redirect capability gate", () => {
  beforeAll(async () => {
    await applyMigrations();
    // Warm the promote-route module cache; same cold-load reason as
    // the publish describe block above.
    await import("../../app/routes/_auth.admin.promote");
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("promote redirect 404s when publish_pipeline is off", async () => {
    const admin = makeUserContext({
      tenantId: SECOND_TEST_TENANT_ID,
      isCollabAdmin: true,
    });
    const ctx = buildContext({
      user: admin,
      publishPipelineEnabled: false,
    });

    const { loader } = await import("../../app/routes/_auth.admin.promote");

    try {
      await loader({
        request: new Request(
          "http://second-tenant.fisqua.test/admin/promote",
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

  it("promote redirect issues a 301 when publish_pipeline is on", async () => {
    const admin = makeUserContext({
      tenantId: DEFAULT_TEST_TENANT_ID,
      isCollabAdmin: true,
    });
    const ctx = buildContext({
      user: admin,
      publishPipelineEnabled: true,
    });

    const { loader } = await import("../../app/routes/_auth.admin.promote");

    // The redirect throws a Response with a Location header in
    // React Router 7's `redirect()` API (compatible with vintage
    // Remix). Because `redirect()` returns the Response rather than
    // throwing, the loader returns it directly.
    const res = await loader({
      request: new Request(
        "http://catalogacion.zasqua.org/admin/promote",
      ),
      context: ctx,
      params: {},
    } as any);

    expect(res).toBeInstanceOf(Response);
    const response = res as Response;
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe(
      "/admin/cataloguing/promote",
    );
  });
});
