/**
 * Tests — tenants table
 *
 * This suite verifies the tenants table shape, CHECK constraints (kind,
 * status, conditional descriptive_standard, slug GLOB),
 * capability-flag defaults, quota nullability, and the seeded
 * platform + neogranadina rows.
 *
 * @version v0.4.0
 */

import { describe, it, beforeAll, beforeEach, expect } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";
import {
  PLATFORM_TENANT_ID,
  NEOGRANADINA_TENANT_ID,
} from "../../app/lib/tenant";

// Bind for downstream plans that import this symbol; suppresses the
// unused-binding warning until a tenant_id FK plan flips a test that
// needs the alias.
void DEFAULT_TEST_TENANT_ID;

/**
 * Raw INSERT helper — bypasses Drizzle's enum: types so we can drive
 * malformed values straight at the DB CHECK constraint we want to
 * verify. Returns a promise that the test asserts against with
 * `.rejects.toThrow()`.
 */
function rawInsert(values: {
  id: string;
  slug: string;
  name?: string;
  kind?: string;
  descriptive_standard?: string | null;
  status?: string;
  crowdsourcing_enabled?: number;
  vocabulary_hub_enabled?: number;
  publish_pipeline_enabled?: number;
  multi_repository_enabled?: number;
  quota_storage_bytes?: number | null;
}): Promise<unknown> {
  const now = Date.now();
  return env.DB.prepare(
    "INSERT INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      values.id,
      values.slug,
      values.name ?? "Test Tenant",
      values.kind ?? "tenant",
      values.descriptive_standard === undefined ? "isadg" : values.descriptive_standard,
      values.status ?? "active",
      values.crowdsourcing_enabled ?? 0,
      values.vocabulary_hub_enabled ?? 1,
      values.publish_pipeline_enabled ?? 1,
      values.multi_repository_enabled ?? 0,
      values.quota_storage_bytes === undefined ? null : values.quota_storage_bytes,
      now,
      now,
    )
    .run();
}

describe("tenants table", () => {
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    db = drizzle(env.DB, { schema });
  });

  it("tenants table — exists with the locked column set", async () => {
    const rows = await db.select().from(schema.tenants);
    // Five seeds: platform + neogranadina (production tenants),
    // the cross-tenant fixture `second-tenant`, and the two
    // standard-toggle fixtures `dacs-test` + `rad-test`
    // added to seedTenants() in tests/helpers/db.ts (Pitfall 6
    // lockstep with the seed extension).
    expect(rows.length).toBe(5);
    // Cross-check by reading every expected column on each seed row.
    const slugs = rows.map((r) => r.slug).sort();
    expect(slugs).toEqual([
      "dacs-test",
      "neogranadina",
      "platform",
      "rad-test",
      "second-tenant",
    ]);
    for (const r of rows) {
      expect(r.id).toBeDefined();
      expect(r.name).toBeDefined();
      expect(r.kind).toBeDefined();
      expect(r.status).toBeDefined();
      expect(r.createdAt).toBeTypeOf("number");
      expect(r.updatedAt).toBeTypeOf("number");
    }
  });

  it("seed — platform row exists with kind='platform' and descriptive_standard NULL", async () => {
    const rows = await db.select().from(schema.tenants).where(eq(schema.tenants.slug, "platform"));
    expect(rows.length).toBe(1);
    const platform = rows[0];
    expect(platform).toMatchObject({
      id: PLATFORM_TENANT_ID,
      slug: "platform",
      name: "Platform",
      kind: "platform",
      descriptiveStandard: null,
      status: "active",
      crowdsourcingEnabled: false,
      vocabularyHubEnabled: false,
      publishPipelineEnabled: false,
      multiRepositoryEnabled: false,
      quotaStorageBytes: null,
    });
  });

  it("seed — neogranadina row exists with kind='tenant', descriptive_standard='isadg', all four capability flags true", async () => {
    const rows = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, "neogranadina"));
    expect(rows.length).toBe(1);
    const neo = rows[0];
    expect(neo).toMatchObject({
      id: NEOGRANADINA_TENANT_ID,
      slug: "neogranadina",
      name: "Neogranadina",
      kind: "tenant",
      descriptiveStandard: "isadg",
      status: "active",
      crowdsourcingEnabled: true,
      vocabularyHubEnabled: true,
      publishPipelineEnabled: true,
      multiRepositoryEnabled: true,
      quotaStorageBytes: null,
    });
  });

  it("kind CHECK — rejects values outside ('tenant','platform')", async () => {
    await expect(
      rawInsert({
        id: crypto.randomUUID(),
        slug: "bad-kind",
        kind: "garbage",
        descriptive_standard: "isadg",
      }),
    ).rejects.toThrow();
  });

  it("status CHECK — rejects values outside ('active','suspended')", async () => {
    await expect(
      rawInsert({
        id: crypto.randomUUID(),
        slug: "bad-status",
        kind: "tenant",
        descriptive_standard: "isadg",
        status: "garbage",
      }),
    ).rejects.toThrow();
  });

  it("descriptive_standard conditional — NULL allowed only when kind='platform'", async () => {
    // kind='tenant' with descriptive_standard NULL must be rejected.
    await expect(
      rawInsert({
        id: crypto.randomUUID(),
        slug: "tenant-null-std",
        kind: "tenant",
        descriptive_standard: null,
      }),
    ).rejects.toThrow();

    // kind='platform' with a non-null descriptive_standard must also
    // be rejected (the conditional is XOR-shaped).
    await expect(
      rawInsert({
        id: crypto.randomUUID(),
        slug: "platform-with-std",
        kind: "platform",
        descriptive_standard: "isadg",
      }),
    ).rejects.toThrow();
  });

  it("descriptive_standard conditional — must be one of isadg/dacs/rad when kind='tenant'", async () => {
    await expect(
      rawInsert({
        id: crypto.randomUUID(),
        slug: "bad-std",
        kind: "tenant",
        descriptive_standard: "garbage",
      }),
    ).rejects.toThrow();

    // Sanity: each of the three valid standards is accepted.
    for (const std of ["isadg", "dacs", "rad"]) {
      await rawInsert({
        id: crypto.randomUUID(),
        slug: `t-${std}`,
        kind: "tenant",
        descriptive_standard: std,
      });
    }
    const all = await db.select().from(schema.tenants);
    // 5 seeds (platform + neogranadina + second-tenant + dacs-test +
    // rad-test) + 3 newly inserted
    expect(all.length).toBe(8);
  });

  it("slug GLOB — rejects 'Bad-Slug', leading hyphen, trailing hyphen", async () => {
    await expect(
      rawInsert({
        id: crypto.randomUUID(),
        slug: "Bad-Slug",
        kind: "tenant",
        descriptive_standard: "isadg",
      }),
    ).rejects.toThrow();

    await expect(
      rawInsert({
        id: crypto.randomUUID(),
        slug: "-leading",
        kind: "tenant",
        descriptive_standard: "isadg",
      }),
    ).rejects.toThrow();

    await expect(
      rawInsert({
        id: crypto.randomUUID(),
        slug: "trailing-",
        kind: "tenant",
        descriptive_standard: "isadg",
      }),
    ).rejects.toThrow();
  });

  it("capability defaults — crowdsourcing=false, vocab_hub=true, publish=true, multi_repo=false", async () => {
    const id = crypto.randomUUID();
    const now = Date.now();
    // Insert minimal row that only specifies the columns without defaults.
    // The four capability flags must take their column-level defaults.
    await env.DB.prepare(
      "INSERT INTO tenants (id, slug, name, kind, descriptive_standard, created_at, updated_at) " +
        "VALUES (?,?,?,?,?,?,?)",
    )
      .bind(id, "test-tenant", "Test", "tenant", "isadg", now, now)
      .run();

    const [row] = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, id));

    expect(row.crowdsourcingEnabled).toBe(false);
    expect(row.vocabularyHubEnabled).toBe(true);
    expect(row.publishPipelineEnabled).toBe(true);
    expect(row.multiRepositoryEnabled).toBe(false);
    expect(row.status).toBe("active"); // status default
    expect(row.kind).toBe("tenant"); // kind default
  });

  it("quota_storage_bytes — accepts NULL and integer values", async () => {
    const idNull = crypto.randomUUID();
    const idQuota = crypto.randomUUID();

    await rawInsert({
      id: idNull,
      slug: "quota-null",
      kind: "tenant",
      descriptive_standard: "isadg",
      quota_storage_bytes: null,
    });

    await rawInsert({
      id: idQuota,
      slug: "quota-1k",
      kind: "tenant",
      descriptive_standard: "isadg",
      quota_storage_bytes: 1000,
    });

    const [nullRow] = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, idNull));
    const [quotaRow] = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, idQuota));

    expect(nullRow.quotaStorageBytes).toBeNull();
    expect(quotaRow.quotaStorageBytes).toBe(1000);
  });
});
