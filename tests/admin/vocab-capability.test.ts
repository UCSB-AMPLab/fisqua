/**
 * Tests — admin vocabularies layout capability gate
 *
 * This suite pins the `_auth.admin.vocabularies` layout loader, which throws
 * `Response(null, {status: 404})` when the resolved tenant has the
 * `vocabulary_hub` capability flag off. Pairs with the sidebar gate
 * as belt-and-braces against direct-URL access.
 *
 * The seed fixture's second tenant has `vocabulary_hub_enabled = 1`
 * (the "deliberately mixed" capability profile in
 * `tests/helpers/db.ts` flips crowdsourcing and publish off but
 * keeps vocab on). To exercise the off case, the test overrides the
 * tenant context's `vocabularyHubEnabled` to `false` rather than
 * mutating the seeded row -- this keeps the seeded fixture
 * deterministic and makes the off-case explicit at the call site.
 *
 * The child routes (the landing page, enums, functions and a single
 * function) are also pinned to 404 with the hub off, loaders and
 * actions alike, since a data request for one child skips the layout.
 *
 * @version v0.8.0
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
  vocabularyHubEnabled: boolean;
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
      vocabularyHubEnabled: args.vocabularyHubEnabled,
      // Other capabilities stay ON so the vocabulary_hub gate is
      // exercised in isolation.
      crowdsourcingEnabled: true,
      publishPipelineEnabled: true,
      multiRepositoryEnabled: true,
    }),
  );
  (ctx as any).cloudflare = { env };
  return ctx;
}

describe("admin vocabularies layout capability gate", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("layout 404s when vocabulary_hub is off", async () => {
    const admin = makeUserContext({
      tenantId: SECOND_TEST_TENANT_ID,
      isAdmin: true,
    });
    const ctx = buildContext({
      user: admin,
      vocabularyHubEnabled: false,
    });

    const { loader } = await import(
      "../../app/routes/_auth.admin.vocabularies"
    );

    try {
      await loader({
        request: new Request(
          "http://second-tenant.fisqua.test/admin/vocabularies",
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

  it("layout returns normally when vocabulary_hub is on (Neogranadina)", async () => {
    const admin = makeUserContext({
      tenantId: DEFAULT_TEST_TENANT_ID,
      isAdmin: true,
    });
    const ctx = buildContext({
      user: admin,
      vocabularyHubEnabled: true,
    });

    const { loader } = await import(
      "../../app/routes/_auth.admin.vocabularies"
    );

    const res = (await loader({
      request: new Request(
        "http://catalogacion.zasqua.org/admin/vocabularies",
      ),
      context: ctx,
      params: {},
    } as any)) as any;

    expect(res).toBeDefined();
    expect(res.user).toBeDefined();
    expect(res.user.tenantId).toBe(DEFAULT_TEST_TENANT_ID);
  });
});

describe("vocabulary child routes carry their own capability gate", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  // A data request for one child route runs its loader or action
  // without the layout's, so each child must refuse on its own.
  async function status(run: () => Promise<unknown>): Promise<number> {
    try {
      await run();
      return 200;
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      return (e as Response).status;
    }
  }

  function postForm(path: string, fields: Record<string, string>): Request {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return new Request(`http://neogranadina.fisqua.test${path}`, { method: "POST", body: form });
  }

  const superAdmin = () =>
    makeUserContext({ tenantId: DEFAULT_TEST_TENANT_ID, isSuperAdmin: true });
  const off = () => buildContext({ user: superAdmin(), vocabularyHubEnabled: false });
  const fnId = "00000000-0000-4000-8000-0000000000f1";

  it("the landing, enums and functions loaders 404 with the hub off", async () => {
    const landing = await import("../../app/routes/_auth.admin.vocabularies._index");
    const enums = await import("../../app/routes/_auth.admin.vocabularies.enums");
    const functions = await import("../../app/routes/_auth.admin.vocabularies.functions");
    const fn = await import("../../app/routes/_auth.admin.vocabularies.functions.$id");
    const get = (path: string) => new Request(`http://neogranadina.fisqua.test${path}`);
    expect(await status(() => landing.loader({ request: get("/admin/vocabularies"), context: off(), params: {} } as any))).toBe(404);
    expect(await status(() => enums.loader({ request: get("/admin/vocabularies/enums?vocab=entity-roles"), context: off(), params: {} } as any))).toBe(404);
    expect(await status(() => functions.loader({ request: get("/admin/vocabularies/functions"), context: off(), params: {} } as any))).toBe(404);
    expect(await status(() => fn.loader({ request: get(`/admin/vocabularies/functions/${fnId}`), context: off(), params: { id: fnId } } as any))).toBe(404);
  });

  it("the landing loader 403s for someone outside the records area", async () => {
    const landing = await import("../../app/routes/_auth.admin.vocabularies._index");
    const ctx = buildContext({
      user: makeUserContext({ tenantId: DEFAULT_TEST_TENANT_ID, isAuthoritiesAdmin: true }),
      vocabularyHubEnabled: true,
    });
    expect(await status(() => landing.loader({ request: new Request("http://neogranadina.fisqua.test/admin/vocabularies"), context: ctx, params: {} } as any))).toBe(403);
  });

  it("the enums and functions actions 404 with the hub off", async () => {
    const enums = await import("../../app/routes/_auth.admin.vocabularies.enums");
    const functions = await import("../../app/routes/_auth.admin.vocabularies.functions");
    const fn = await import("../../app/routes/_auth.admin.vocabularies.functions.$id");
    expect(await status(() => enums.action({ request: postForm("/admin/vocabularies/enums", { _action: "add_term", vocab: "entity-roles", value: "x" }), context: off(), params: {} } as any))).toBe(404);
    expect(await status(() => functions.action({ request: postForm("/admin/vocabularies/functions", { _action: "create", canonical: "x" }), context: off(), params: {} } as any))).toBe(404);
    expect(await status(() => fn.action({ request: postForm(`/admin/vocabularies/functions/${fnId}`, { _action: "update", canonical: "x" }), context: off(), params: { id: fnId } } as any))).toBe(404);
  });
});

