/**
 * Tests — operator soft-disable + re-enable
 *
 * This suite pins the multi-intent action handler in
 * `app/routes/_operator.tenants.$slug.tsx` for the soft_disable +
 * re_enable intents:
 *
 *   1. POST soft_disable — confirmSlug matches → tenant.disabledAt set
 *      to now-ish; audit row action='soft_disable_tenant'.
 *   2. POST soft_disable — wrong confirmSlug → 422 / fieldError; no DB
 *      writes.
 *   3. POST re_enable on disabled tenant — disabledAt cleared; audit
 *      row action='set_capability' with details.capabilityChanged=
 *      're_enable_tenant' (repurposes set_capability to avoid
 *      amending the audit_log enum).
 *   4. POST soft_disable on platform tenant → 400 (operator does not
 *      lock themselves out — T-33-04-05).
 *
 * @version v0.4.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedDisabledTenant,
  seedOperatorUser,
  OPERATOR_TEST_USER_ID,
  OPERATOR_TEST_EMAIL,
  DEFAULT_TEST_TENANT_ID,
  DISABLED_TEST_TENANT_ID,
  DISABLED_TEST_TENANT_SLUG,
  getTestDb,
} from "../helpers/db";
import { tenantContext, userContext } from "../../app/context";
import { makeUserContext, makeTenantContext } from "../helpers/context";
import { PLATFORM_TENANT_ID } from "../../app/lib/tenant";
import * as schema from "../../app/db/schema";

function buildContext(): any {
  const ctx = new RouterContextProvider();
  ctx.set(
    userContext,
    makeUserContext({
      id: OPERATOR_TEST_USER_ID,
      tenantId: PLATFORM_TENANT_ID,
      isSuperAdmin: true,
      email: OPERATOR_TEST_EMAIL,
    }),
  );
  ctx.set(
    tenantContext,
    makeTenantContext({
      id: PLATFORM_TENANT_ID,
      slug: "platform",
      name: "Platform",
      kind: "platform",
      descriptiveStandard: null,
    }),
  );
  (ctx as any).cloudflare = { env };
  return ctx;
}

function buildPostRequest(
  slug: string,
  payload: Record<string, string>,
): Request {
  const body = new URLSearchParams(payload);
  return new Request(`https://platform.fisqua.test/operator/tenants/${slug}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

describe("/operator/tenants/:slug — soft_disable + re_enable", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedDisabledTenant();
    await seedOperatorUser();
  });

  it("POST soft_disable with matching confirmSlug — disables tenant + writes audit", async () => {
    const { action } = await import(
      "../../app/routes/_operator.tenants.$slug"
    );
    const request = buildPostRequest("neogranadina", {
      intent: "soft_disable",
      confirmSlug: "neogranadina",
    });
    const result = await action({
      request,
      context: buildContext(),
      params: { slug: "neogranadina" },
    } as any);

    expect((result as any).disabled).toBe(true);

    const db = getTestDb();
    const tenantRow = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, DEFAULT_TEST_TENANT_ID))
      .get();
    expect(tenantRow!.disabledAt).not.toBeNull();
    // disabledAt should be a recent timestamp.
    const ageMs = Date.now() - (tenantRow!.disabledAt as number);
    expect(ageMs).toBeGreaterThanOrEqual(0);
    expect(ageMs).toBeLessThan(5000);

    const auditRow = await env.DB.prepare(
      "SELECT action, target_tenant_id, target_object_kind, details FROM audit_log " +
        "WHERE target_tenant_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(DEFAULT_TEST_TENANT_ID)
      .first<{
        action: string;
        target_tenant_id: string;
        target_object_kind: string | null;
        details: string | null;
      }>();
    expect(auditRow!.action).toBe("soft_disable_tenant");
    expect(auditRow!.target_object_kind).toBe("tenant");
    const details = JSON.parse(auditRow!.details!);
    expect(details.slug).toBe("neogranadina");
    expect(details.action).toBe("disable");
  });

  it("POST soft_disable with wrong confirmSlug — fieldError, no DB writes", async () => {
    const { action } = await import(
      "../../app/routes/_operator.tenants.$slug"
    );
    const request = buildPostRequest("neogranadina", {
      intent: "soft_disable",
      confirmSlug: "wrong-slug",
    });
    const result = await action({
      request,
      context: buildContext(),
      params: { slug: "neogranadina" },
    } as any);

    expect((result as any).fieldErrors).toBeDefined();
    expect((result as any).fieldErrors.confirmSlug).toBeDefined();

    // Tenant remains active.
    const db = getTestDb();
    const tenantRow = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, DEFAULT_TEST_TENANT_ID))
      .get();
    expect(tenantRow!.disabledAt).toBeNull();

    // No audit row.
    const auditCount = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM audit_log WHERE target_tenant_id = ?",
    )
      .bind(DEFAULT_TEST_TENANT_ID)
      .first<{ c: number }>();
    expect(auditCount!.c).toBe(0);
  });

  it("POST re_enable on disabled tenant — clears disabledAt + writes audit (set_capability with re_enable_tenant)", async () => {
    const { action } = await import(
      "../../app/routes/_operator.tenants.$slug"
    );
    const request = buildPostRequest(DISABLED_TEST_TENANT_SLUG, {
      intent: "re_enable",
    });
    const result = await action({
      request,
      context: buildContext(),
      params: { slug: DISABLED_TEST_TENANT_SLUG },
    } as any);

    expect((result as any).reenabled).toBe(true);

    const db = getTestDb();
    const tenantRow = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, DISABLED_TEST_TENANT_ID))
      .get();
    expect(tenantRow!.disabledAt).toBeNull();

    const auditRow = await env.DB.prepare(
      "SELECT action, target_tenant_id, target_object_kind, details FROM audit_log " +
        "WHERE target_tenant_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(DISABLED_TEST_TENANT_ID)
      .first<{
        action: string;
        target_tenant_id: string;
        target_object_kind: string | null;
        details: string | null;
      }>();
    // Re-enable repurposes the set_capability audit action to avoid
    // amending the audit_log enum invariant.
    expect(auditRow!.action).toBe("set_capability");
    const details = JSON.parse(auditRow!.details!);
    expect(details.slug).toBe(DISABLED_TEST_TENANT_SLUG);
    expect(details.capabilityChanged).toBe("re_enable_tenant");
    expect(details.from).toBe("disabled");
    expect(details.to).toBe("active");
  });

  it("POST soft_disable on platform tenant → 400; platform stays active", async () => {
    const { action } = await import(
      "../../app/routes/_operator.tenants.$slug"
    );
    const request = buildPostRequest("platform", {
      intent: "soft_disable",
      confirmSlug: "platform",
    });
    const result = await action({
      request,
      context: buildContext(),
      params: { slug: "platform" },
    } as any);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);

    const db = getTestDb();
    const platformRow = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, PLATFORM_TENANT_ID))
      .get();
    expect(platformRow!.disabledAt).toBeNull();

    const auditCount = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM audit_log WHERE target_tenant_id = ?",
    )
      .bind(PLATFORM_TENANT_ID)
      .first<{ c: number }>();
    expect(auditCount!.c).toBe(0);
  });
});

// @version v0.4.0
