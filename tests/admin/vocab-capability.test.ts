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
