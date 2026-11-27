/**
 * Tests — the operator's setting for a workspace's default language
 *
 * This suite pins the operator's setting for a workspace's default
 * language. The operator tenant detail page sets `tenants.default_locale`
 * through the `set_default_locale` intent: `en`, `es`, or an empty value
 * for no default (the browser's language decides). It pins that the
 * action:
 *
 *   - saves English or Spanish and clears the default;
 *   - audits a change as `set_capability` with
 *     `details.settingsChanged = 'default_locale'` and its before and
 *     after;
 *   - writes nothing, audit included, when the value is unchanged;
 *   - refuses any other value, naming the field, and leaves the row as
 *     it was;
 *   - refuses the platform tenant, as every intent does.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedOperatorUser,
  OPERATOR_TEST_USER_ID,
  OPERATOR_TEST_EMAIL,
  SECOND_TEST_TENANT_ID,
  getTestDb,
} from "../helpers/db";
import { tenantContext, userContext } from "../../app/context";
import { makeUserContext, makeTenantContext } from "../helpers/context";
import { PLATFORM_TENANT_ID } from "../../app/lib/tenant";
import * as schema from "../../app/db/schema";

const ROUTE = "../../app/routes/_operator.tenants.$slug";
const SLUG = "second-tenant";

function operatorContext(): any {
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

async function submit(slug: string, defaultLocale: string): Promise<any> {
  const { action } = await import(ROUTE);
  const body = new URLSearchParams({ intent: "set_default_locale", defaultLocale });
  return action({
    request: new Request(`https://platform.fisqua.test/operator/tenants/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }),
    context: operatorContext(),
    params: { slug },
  } as any);
}

async function storedDefault(): Promise<string | null> {
  const row = await getTestDb()
    .select({ defaultLocale: schema.tenants.defaultLocale })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, SECOND_TEST_TENANT_ID))
    .get();
  return row!.defaultLocale;
}

async function auditRows(): Promise<Array<{ action: string; details: string }>> {
  const { results } = await env.DB.prepare(
    "SELECT action, details FROM audit_log WHERE target_tenant_id = ? ORDER BY rowid",
  )
    .bind(SECOND_TEST_TENANT_ID)
    .all<{ action: string; details: string }>();
  return results;
}

async function resetDefaults(): Promise<void> {
  await env.DB.prepare("UPDATE tenants SET default_locale = NULL").run();
}

describe("operator: a workspace's default language", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedOperatorUser();
    await resetDefaults();
  });

  afterAll(resetDefaults);

  it("saves English, then Spanish, then clears the default, auditing each change", async () => {
    expect(await submit(SLUG, "en")).toMatchObject({ localeSaved: true, noop: false });
    expect(await storedDefault()).toBe("en");
    expect(await submit(SLUG, "es")).toMatchObject({ localeSaved: true, noop: false });
    expect(await storedDefault()).toBe("es");
    expect(await submit(SLUG, "")).toMatchObject({ localeSaved: true, noop: false });
    expect(await storedDefault()).toBeNull();

    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual(["set_capability", "set_capability", "set_capability"]);
    expect(rows.map((r) => JSON.parse(r.details))).toEqual([
      { slug: SLUG, settingsChanged: "default_locale", from: null, to: "en" },
      { slug: SLUG, settingsChanged: "default_locale", from: "en", to: "es" },
      { slug: SLUG, settingsChanged: "default_locale", from: "es", to: null },
    ]);
  });

  it("writes nothing when the value is unchanged", async () => {
    expect(await submit(SLUG, "")).toMatchObject({ localeSaved: true, noop: true });
    expect(await storedDefault()).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it("refuses any other value, naming the field, and keeps the stored default", async () => {
    await submit(SLUG, "es");
    const before = (await auditRows()).length;
    const result = await submit(SLUG, "fr");
    expect(result.fieldErrors?.defaultLocale).toHaveLength(1);
    expect(result.localeSaved).toBeUndefined();
    expect(await storedDefault()).toBe("es");
    expect(await auditRows()).toHaveLength(before);
  });

  it("refuses the platform tenant", async () => {
    const result = await submit("platform", "es");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });
});

// @version v0.9.0
