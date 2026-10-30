/**
 * Tests — media pipeline capability flag
 *
 * This suite pins the `media_pipeline` capability added in migration
 * 0081. The flag gates every media pipeline surface (run start, the
 * ledger views, recipe settings) and, like the imports flag, is off
 * unless an operator grants it.
 *
 *   - `hasCapability` reads `mediaPipelineEnabled` and is false on a
 *     fresh tenant context;
 *   - `requireCapability` throws a bare 404 with no body when the flag
 *     is off, so a disabled tenant sees a missing route;
 *   - the migrated `tenants` table carries `media_pipeline_enabled`
 *     with a default of 0.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { hasCapability, requireCapability } from "../../app/lib/tenant";
import { makeTenantContext } from "../helpers/context";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";

describe("media_pipeline capability", () => {
  it("is off by default on a fresh tenant context", () => {
    expect(hasCapability(makeTenantContext(), "media_pipeline")).toBe(false);
  });

  it("is on when the flag is set", () => {
    expect(
      hasCapability(
        makeTenantContext({ mediaPipelineEnabled: true }),
        "media_pipeline",
      ),
    ).toBe(true);
  });

  it("requireCapability throws a bare 404 when off", () => {
    try {
      requireCapability(
        makeTenantContext({ mediaPipelineEnabled: false }),
        "media_pipeline",
      );
      expect.fail("should throw");
    } catch (e) {
      expect((e as Response).status).toBe(404);
      expect((e as Response).body).toBeNull();
    }
  });
});

describe("media_pipeline_enabled column", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
  });

  it("defaults to 0 on a seeded tenant row", async () => {
    const row = await env.DB.prepare(
      "SELECT media_pipeline_enabled FROM tenants WHERE id = ?",
    )
      .bind(DEFAULT_TEST_TENANT_ID)
      .first<{ media_pipeline_enabled: number }>();
    expect(row).not.toBeNull();
    expect(row!.media_pipeline_enabled).toBe(0);
  });
});
