/**
 * Tests — media pipeline capability, operator toggle
 *
 * This suite pins the operator side of the `media_pipeline`
 * capability: the tenant detail page's `set_capability` action flips
 * `tenants.media_pipeline_enabled` and writes exactly one audit row
 * whose details carry a single `media_pipeline` change, in both
 * directions. Every other flag is resubmitted at its current value, so
 * the only difference between the row and the form is the one under
 * test. Turning it on needs the tenant's storage destination: with a
 * column unset, or one of the four secrets missing, the action answers
 * with a `destination_unset` field error, leaves the flag off, writes no
 * audit row, and puts none of the destination's values in its answer.
 * Turning it off, or leaving it on, is never refused.
 *
 * Harness mirrors tests/admin/imports-capability.test.ts.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedFederations,
  seedOperatorUser,
  OPERATOR_TEST_USER_ID,
  OPERATOR_TEST_EMAIL,
  DEFAULT_TEST_TENANT_ID,
  getTestDb,
} from "../helpers/db";
import { tenantContext, userContext } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { PLATFORM_TENANT_ID } from "../../app/lib/tenant";
import { seedTenantDestination, TEST_DESTINATION } from "../helpers/media-pipeline";

function buildOperatorContext(envOverrides: Record<string, unknown> = {}): any {
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
  (ctx as any).cloudflare = { env: { ...env, ...envOverrides } };
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

// The seeded Neogranadina row has the five long-standing flags on and
// imports off; these are resubmitted unchanged.
const UNCHANGED_FLAGS = {
  crowdsourcingEnabled: "true",
  vocabularyHubEnabled: "true",
  publishPipelineEnabled: "true",
  multiRepositoryEnabled: "true",
  authoritiesEnabled: "true",
};

async function submit(mediaPipelineOn: boolean, envOverrides: Record<string, unknown> = {}) {
  const { action } = await import("../../app/routes/_operator.tenants.$slug");
  const payload: Record<string, string> = {
    intent: "set_capability",
    ...UNCHANGED_FLAGS,
  };
  if (mediaPipelineOn) payload.mediaPipelineEnabled = "on";
  return action({
    request: buildPostRequest("neogranadina", payload),
    context: buildOperatorContext(envOverrides),
    params: { slug: "neogranadina" },
  } as any);
}

async function readFlag(): Promise<boolean> {
  const row = await getTestDb()
    .select()
    .from(schema.tenants)
    .where(eq(schema.tenants.id, DEFAULT_TEST_TENANT_ID))
    .get();
  return row!.mediaPipelineEnabled as unknown as boolean;
}

async function readAuditRows() {
  const { results } = await env.DB.prepare(
    "SELECT action, details FROM audit_log " +
      "WHERE target_tenant_id = ? AND action = 'set_capability' " +
      "ORDER BY created_at ASC",
  )
    .bind(DEFAULT_TEST_TENANT_ID)
    .all<{ action: string; details: string | null }>();
  return results;
}

describe("media pipeline capability — operator toggle", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedFederations();
    await seedOperatorUser();
    // Make sure the seeded flags match UNCHANGED_FLAGS, so the only
    // difference a submission carries is the media pipeline flag.
    await env.DB.prepare(
      "UPDATE tenants SET crowdsourcing_enabled = 1, vocabulary_hub_enabled = 1, " +
        "publish_pipeline_enabled = 1, multi_repository_enabled = 1, " +
        "authorities_enabled = 1, imports_enabled = 0, media_pipeline_enabled = 0 " +
        "WHERE id = ?",
    )
      .bind(DEFAULT_TEST_TENANT_ID)
      .run();
  });

  it("turning it on flips the row and writes one media_pipeline change", async () => {
    await seedTenantDestination();
    const result = await submit(true);
    expect((result as any).saved).toBe(true);
    expect(await readFlag()).toBe(true);

    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
    const details = JSON.parse(rows[0].details!);
    expect(details.changes).toEqual([
      { capability: "media_pipeline", from: false, to: true },
    ]);
  });

  it("refuses to turn it on while the destination is incomplete, showing no value", async () => {
    // No destination at all.
    let result = (await submit(true)) as any;
    expect(result.fieldErrors).toEqual({ mediaPipelineEnabled: ["destination_unset"] });
    expect(await readFlag()).toBe(false);

    // Every column but one.
    await seedTenantDestination(undefined, { manifestBucket: null });
    result = (await submit(true)) as any;
    expect(result.fieldErrors).toEqual({ mediaPipelineEnabled: ["destination_unset"] });
    expect(await readFlag()).toBe(false);

    // Every column, one secret missing.
    await seedTenantDestination();
    result = (await submit(true, { TEST_TENANT_MANIFEST_WRITE_KEY_ID: undefined })) as any;
    expect(result.fieldErrors).toEqual({ mediaPipelineEnabled: ["destination_unset"] });
    expect(await readFlag()).toBe(false);
    const text = JSON.stringify(result);
    for (const value of Object.values(TEST_DESTINATION)) expect(text).not.toContain(String(value));

    expect(await readAuditRows()).toHaveLength(0);
  });

  it("leaves it on when other capabilities change, with no destination", async () => {
    await env.DB.prepare("UPDATE tenants SET media_pipeline_enabled = 1 WHERE id = ?")
      .bind(DEFAULT_TEST_TENANT_ID)
      .run();
    const result = (await submit(true)) as any;
    expect(result.saved).toBe(true);
    expect(await readFlag()).toBe(true);
  });

  it("turning it off flips the row back and writes one media_pipeline change", async () => {
    await env.DB.prepare(
      "UPDATE tenants SET media_pipeline_enabled = 1 WHERE id = ?",
    )
      .bind(DEFAULT_TEST_TENANT_ID)
      .run();

    const result = await submit(false);
    expect((result as any).saved).toBe(true);
    expect(await readFlag()).toBe(false);

    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
    const details = JSON.parse(rows[0].details!);
    expect(details.changes).toEqual([
      { capability: "media_pipeline", from: true, to: false },
    ]);
  });
});
