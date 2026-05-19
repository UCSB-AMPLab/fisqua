/**
 * Tests — disabled-tenant resolution
 *
 * This suite pins the soft-disable branch in `getTenantFromRequest`,
 * which returns the tenant row to operator routes
 * (so a disabled tenant remains recoverable from the operator
 * surface) and 404s every other request shape on the tenant
 * subdomain — same response shape as an unknown host, so a probe
 * cannot tell whether a slug is unknown, disabled, or active without
 * passing through auth.
 *
 * Coverage:
 *   - getTenantFromRequest 404s a disabled tenant subdomain when the
 *     pathname does NOT start with /operator/.
 *   - same call returns the tenant row when the pathname starts with
 *     /operator/ (operator carve-out).
 *   - non-disabled tenant resolves normally regardless of pathname.
 *
 * The test inlines the disabled-tenant INSERT inside `beforeEach`
 * because Task 4 is what lands `seedDisabledTenant` in
 * `tests/helpers/db.ts`; for Task 3 the test owns the SQL so the
 * helper edits and these assertions can land independently.
 *
 * @version v0.4.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { getTenantFromRequest } from "../../app/lib/tenant";

const DISABLED_TEST_TENANT_ID = "33333333-3333-4333-8333-333333333333";
const DISABLED_TEST_TENANT_SLUG = "disabled-tenant";

async function seedDisabledTenantInline(): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, disabled_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      DISABLED_TEST_TENANT_ID,
      DISABLED_TEST_TENANT_SLUG,
      "Disabled Test Tenant",
      "tenant",
      "isadg",
      "active",
      0, 1, 1, 0,
      null,
      now - 1000,
      now,
      now,
    )
    .run();
}

describe("getTenantFromRequest — disabled tenant", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedDisabledTenantInline();
  });

  it("404s the disabled tenant subdomain when pathname does not start with /operator/", async () => {
    const db = drizzle(env.DB);
    const request = new Request(
      `https://${DISABLED_TEST_TENANT_SLUG}.fisqua.test/dashboard`,
    );
    try {
      await getTenantFromRequest(db, request);
      expect.fail("Should have thrown 404");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
  });

  it("returns the tenant when pathname starts with /operator/ (operator carve-out)", async () => {
    const db = drizzle(env.DB);
    const request = new Request(
      `https://${DISABLED_TEST_TENANT_SLUG}.fisqua.test/operator/tenants/${DISABLED_TEST_TENANT_SLUG}`,
    );
    const tenant = await getTenantFromRequest(db, request);
    expect(tenant.slug).toBe(DISABLED_TEST_TENANT_SLUG);
    expect(tenant.disabledAt).not.toBeNull();
  });

  it("non-disabled tenant resolves normally regardless of pathname", async () => {
    const db = drizzle(env.DB);
    // Neogranadina is seeded by cleanDatabase()'s seedTenants() call;
    // disabled_at is NULL there.
    const request = new Request("https://neogranadina.fisqua.test/dashboard");
    const tenant = await getTenantFromRequest(db, request);
    expect(tenant.slug).toBe("neogranadina");
    expect(tenant.disabledAt).toBeNull();
  });
});
