/**
 * Tests — promotion route and the tenant's storage destination
 *
 * Promotion writes each manifest to the tenant's own manifest bucket and
 * builds the description's manifest URL under the tenant's manifest
 * base. This suite pins the refusal: a tenant without a complete storage
 * destination (an unset column, or a missing secret) is answered with
 * the `tenant_destination_unset` token, which the page maps to its own
 * message, before any description or manifest is written.
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
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { TEST_DESTINATION } from "../helpers/media-pipeline";
import { tenantContext, userContext, type Tenant } from "../../app/context";
import { action } from "../../app/routes/_auth.admin.cataloguing.promote";

function context(tenant: Tenant, envOver: Record<string, unknown> = {}): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, makeUserContext({ tenantId: DEFAULT_TEST_TENANT_ID, isSuperAdmin: true, isAdmin: true }));
  ctx.set(tenantContext, tenant);
  (ctx as any).cloudflare = { env: { ...env, ...envOver }, ctx: { waitUntil: () => {} } };
  return ctx;
}

function post(): Request {
  const body = new URLSearchParams({
    entryIds: JSON.stringify(["e1"]),
    referenceCodes: JSON.stringify({ e1: "AHRB-001-d001" }),
    volumeId: "vol-001",
  });
  return new Request("http://neogranadina.fisqua.test/admin/cataloguing/promote", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

async function descriptionCount(): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM descriptions").first<{ n: number }>())!.n;
}

describe("promotion route — tenant destination", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedFederations();
  });

  it("refuses a tenant without a destination, writing nothing", async () => {
    const before = await descriptionCount();
    const result = await action({
      request: post(),
      context: context(makeTenantContext({ id: DEFAULT_TEST_TENANT_ID })),
      params: {},
    } as any);
    expect(result).toEqual({ error: "tenant_destination_unset" });
    expect(await descriptionCount()).toBe(before);
    expect((await (env as any).MANIFESTS_BUCKET.list()).objects).toEqual([]);
  });

  it("refuses a tenant one of whose secrets is missing", async () => {
    const result = await action({
      request: post(),
      context: context(makeTenantContext({ id: DEFAULT_TEST_TENANT_ID, ...TEST_DESTINATION }), {
        TEST_TENANT_MANIFEST_WRITE_SECRET_KEY: undefined,
      }),
      params: {},
    } as any);
    expect(result).toEqual({ error: "tenant_destination_unset" });
  });
});

// @version v0.8.0
