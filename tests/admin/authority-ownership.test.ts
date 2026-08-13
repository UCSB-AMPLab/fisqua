/**
 * Tests — tenant-owned authority spaces
 *
 * Migration 0067 gave `entities` and `places` an optional owner. A row
 * whose `tenant_id` is set belongs to that tenant; a row whose
 * `tenant_id` is NULL is federation-shared, which is what every row in
 * the platform is until somebody claims one. This suite holds the two
 * halves of that model against regression.
 *
 * VISIBILITY (`authorityScope`)
 *   A tenant sees the shared records plus its own and nothing else. The
 *   fixtures put THREE records in one federation — one shared, one owned
 *   by the request tenant, one owned by a sibling member tenant — so
 *   every query has something it must return and something it must not.
 *
 * GATING (`requireAuthorityMutation`, `requireAuthorityMint`)
 *   The matrix the design fixes: own record -> tenant admin is enough;
 *   shared record -> steward still required; another tenant's record ->
 *   404 rather than 403, because a foreign record must not be confirmed
 *   to exist. Merge and split pass BOTH ids, so the pair rule falls out
 *   of the same call: unrestricted only when every record involved is
 *   the request tenant's own, and specifically NOT for the mixed
 *   owned-plus-shared case, which is the interesting one.
 *
 * MINTING
 *   `shared_authorities_enabled` decides what a new record's owner is
 *   and therefore who may create it. Off -> the tenant mints its own,
 *   its admins need nothing further. On -> the mint lands in the shared
 *   space and needs a steward.
 *
 * THE REGRESSION THAT MATTERS MOST
 *   With no row owned by anybody — the state every federation is in the
 *   moment 0067 lands, and the state Neogranadina stays in — visibility
 *   and gating must behave exactly as they did before. The last describe
 *   block asserts that directly: the scope returns the whole federation,
 *   and the steward gate is still the only thing standing between a
 *   member admin and a shared record.
 *
 * Fixtures mirror `tests/lib/federation.test.ts`: a member tenant inside
 * the Neogranadina federation, so the cross-tenant paths are real rather
 * than cross-federation ones (which the pre-existing
 * entities/places-tenant-isolation suites already cover).
 *
 * @version v0.7.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import {
  NEOGRANADINA_TENANT_ID,
  NEOGRANADINA_FEDERATION_ID,
} from "../../app/lib/tenant";
import {
  authorityScope,
  authorityScopeSql,
  requireAuthorityMint,
  requireAuthorityMutation,
  resolveMintOwner,
} from "../../app/lib/authority-ownership.server";
import type { Tenant, User } from "../../app/context";

// Two member tenants inside the Neogranadina federation. ALPHA is the
// request tenant throughout; BETA is the sibling whose records ALPHA
// must never see or touch.
const ALPHA_TENANT_ID = "0a1a0000-0000-4000-8000-00000000000a";
const BETA_TENANT_ID = "0b1b0000-0000-4000-8000-00000000000b";

const LEAD_ADMIN_ID = "0c000000-0000-4000-8000-000000000001";
const ALPHA_ADMIN_ID = "0c000000-0000-4000-8000-000000000002";
const ALPHA_STAFF_ID = "0c000000-0000-4000-8000-000000000003";

// Authority record ids, one per ownership state, per table.
const SHARED_ENTITY_ID = "0e000000-0000-4000-8000-000000000001";
const ALPHA_ENTITY_ID = "0e000000-0000-4000-8000-000000000002";
const BETA_ENTITY_ID = "0e000000-0000-4000-8000-000000000003";
const SHARED_PLACE_ID = "0f000000-0000-4000-8000-000000000001";
const ALPHA_PLACE_ID = "0f000000-0000-4000-8000-000000000002";
const BETA_PLACE_ID = "0f000000-0000-4000-8000-000000000003";

function makeUser(
  overrides: Partial<User> & Pick<User, "id" | "tenantId">,
): User {
  return {
    email: `${overrides.id}@test.local`,
    name: null,
    isAdmin: false,
    isSuperAdmin: false,
    isCollabAdmin: false,
    isArchiveUser: false,
    isUserManager: false,
    isCataloguer: false,
    lastActiveAt: null,
    githubId: null,
    ...overrides,
  };
}

async function seedTenant(id: string, slug: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, federation_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id, slug, slug, "tenant", "isadg", "active",
      0, 1, 0, 0, null, NEOGRANADINA_FEDERATION_ID, now, now,
    )
    .run();
}

async function seedEntity(id: string, tenantId: string | null): Promise<void> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(schema.entities).values({
    id,
    federationId: NEOGRANADINA_FEDERATION_ID,
    tenantId,
    entityCode: `ne-${id.slice(-8)}`,
    displayName: `Entity ${id.slice(-4)}`,
    sortName: `entity ${id.slice(-4)}`,
    entityType: "person",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedPlace(id: string, tenantId: string | null): Promise<void> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(schema.places).values({
    id,
    federationId: NEOGRANADINA_FEDERATION_ID,
    tenantId,
    placeCode: `nl-${id.slice(-8)}`,
    label: `Place ${id.slice(-4)}`,
    displayName: `Place ${id.slice(-4)}`,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedFixtures(): Promise<void> {
  const now = Date.now();
  await seedTenant(ALPHA_TENANT_ID, "alpha-tenant");
  await seedTenant(BETA_TENANT_ID, "beta-tenant");

  const users: Array<[string, string, boolean]> = [
    [LEAD_ADMIN_ID, NEOGRANADINA_TENANT_ID, true],
    [ALPHA_ADMIN_ID, ALPHA_TENANT_ID, true],
    [ALPHA_STAFF_ID, ALPHA_TENANT_ID, false],
  ];
  for (const [id, tenantId, isAdmin] of users) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users (id, tenant_id, email, is_admin, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(id, tenantId, `${id}@test.local`, isAdmin ? 1 : 0, now, now)
      .run();
  }

  await seedEntity(SHARED_ENTITY_ID, null);
  await seedEntity(ALPHA_ENTITY_ID, ALPHA_TENANT_ID);
  await seedEntity(BETA_ENTITY_ID, BETA_TENANT_ID);
  await seedPlace(SHARED_PLACE_ID, null);
  await seedPlace(ALPHA_PLACE_ID, ALPHA_TENANT_ID);
  await seedPlace(BETA_PLACE_ID, BETA_TENANT_ID);
}

async function loadTenant(id: string): Promise<Tenant> {
  const db = drizzle(env.DB, { schema });
  const row = await db
    .select()
    .from(schema.tenants)
    .where(eq(schema.tenants.id, id))
    .get();
  if (!row) throw new Error(`tenant ${id} not seeded`);
  return row as Tenant;
}

async function setSharedAuthorities(enabled: boolean): Promise<void> {
  await env.DB.prepare(
    "UPDATE federations SET shared_authorities_enabled = ? WHERE id = ?",
  )
    .bind(enabled ? 1 : 0, NEOGRANADINA_FEDERATION_ID)
    .run();
}

/** Strip every owner, returning the federation to its pre-0067 state. */
async function unclaimEverything(): Promise<void> {
  await env.DB.prepare("UPDATE entities SET tenant_id = NULL").run();
  await env.DB.prepare("UPDATE places SET tenant_id = NULL").run();
}

describe("tenant-owned authority spaces", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedFixtures();
  });

  describe("visibility — authorityScope", () => {
    it("a member tenant sees shared records plus its own, never a sibling's", async () => {
      const db = drizzle(env.DB);
      const rows = await db
        .select({ id: schema.entities.id })
        .from(schema.entities)
        .where(
          authorityScope(
            schema.entities,
            NEOGRANADINA_FEDERATION_ID,
            ALPHA_TENANT_ID,
          ),
        )
        .all();
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(SHARED_ENTITY_ID);
      expect(ids).toContain(ALPHA_ENTITY_ID);
      expect(ids).not.toContain(BETA_ENTITY_ID);
      expect(ids).toHaveLength(2);
    });

    it("applies identically to places", async () => {
      const db = drizzle(env.DB);
      const rows = await db
        .select({ id: schema.places.id })
        .from(schema.places)
        .where(
          authorityScope(
            schema.places,
            NEOGRANADINA_FEDERATION_ID,
            ALPHA_TENANT_ID,
          ),
        )
        .all();
      const ids = rows.map((r) => r.id);
      expect(ids.sort()).toEqual([SHARED_PLACE_ID, ALPHA_PLACE_ID].sort());
    });

    it("a by-id read of a sibling's record returns nothing", async () => {
      const db = drizzle(env.DB);
      const row = await db
        .select({ id: schema.entities.id })
        .from(schema.entities)
        .where(
          and(
            authorityScope(
              schema.entities,
              NEOGRANADINA_FEDERATION_ID,
              ALPHA_TENANT_ID,
            ),
            eq(schema.entities.id, BETA_ENTITY_ID),
          ),
        )
        .get();
      expect(row).toBeUndefined();
    });

    it("the sibling sees its own record and the shared one, symmetrically", async () => {
      const db = drizzle(env.DB);
      const rows = await db
        .select({ id: schema.entities.id })
        .from(schema.entities)
        .where(
          authorityScope(
            schema.entities,
            NEOGRANADINA_FEDERATION_ID,
            BETA_TENANT_ID,
          ),
        )
        .all();
      expect(rows.map((r) => r.id).sort()).toEqual(
        [SHARED_ENTITY_ID, BETA_ENTITY_ID].sort(),
      );
    });

    it("a tenant-id list spans several members (the federation export shape)", async () => {
      const db = drizzle(env.DB);
      const rows = await db
        .select({ id: schema.entities.id })
        .from(schema.entities)
        .where(
          authorityScope(schema.entities, NEOGRANADINA_FEDERATION_ID, [
            ALPHA_TENANT_ID,
            BETA_TENANT_ID,
          ]),
        )
        .all();
      expect(rows).toHaveLength(3);
    });

    it("an empty tenant-id list degenerates to shared records only", async () => {
      const db = drizzle(env.DB);
      const rows = await db
        .select({ id: schema.entities.id })
        .from(schema.entities)
        .where(authorityScope(schema.entities, NEOGRANADINA_FEDERATION_ID, []))
        .all();
      expect(rows.map((r) => r.id)).toEqual([SHARED_ENTITY_ID]);
    });

    it("the raw-SQL form matches the Drizzle form", async () => {
      const db = drizzle(env.DB);
      const { sql } = await import("drizzle-orm");
      const rows = (await db.all(sql`
        SELECT e.id AS id
        FROM entities e
        WHERE ${authorityScopeSql("e", NEOGRANADINA_FEDERATION_ID, ALPHA_TENANT_ID)}
      `)) as Array<{ id: string }>;
      expect(rows.map((r) => r.id).sort()).toEqual(
        [SHARED_ENTITY_ID, ALPHA_ENTITY_ID].sort(),
      );
    });
  });

  describe("gating matrix — requireAuthorityMutation", () => {
    it("a tenant admin may mutate its OWN record with no steward", async () => {
      const db = drizzle(env.DB);
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      await expect(
        requireAuthorityMutation(db, admin, alpha, "entity", [ALPHA_ENTITY_ID]),
      ).resolves.toBeUndefined();
    });

    it("a NON-admin of the owning tenant is still refused", async () => {
      const db = drizzle(env.DB);
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const staff = makeUser({
        id: ALPHA_STAFF_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: false,
      });
      await expect(
        requireAuthorityMutation(db, staff, alpha, "entity", [ALPHA_ENTITY_ID]),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("a tenant admin may NOT mutate a SHARED record without stewardship", async () => {
      const db = drizzle(env.DB);
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      await expect(
        requireAuthorityMutation(db, admin, alpha, "entity", [
          SHARED_ENTITY_ID,
        ]),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("a federation steward may still mutate a shared record", async () => {
      const db = drizzle(env.DB);
      const lead = await loadTenant(NEOGRANADINA_TENANT_ID);
      const leadAdmin = makeUser({
        id: LEAD_ADMIN_ID,
        tenantId: NEOGRANADINA_TENANT_ID,
        isAdmin: true,
      });
      await expect(
        requireAuthorityMutation(db, leadAdmin, lead, "entity", [
          SHARED_ENTITY_ID,
        ]),
      ).resolves.toBeUndefined();
    });

    it("another tenant's record 404s — never a 403, which would confirm it exists", async () => {
      const db = drizzle(env.DB);
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      await expect(
        requireAuthorityMutation(db, admin, alpha, "entity", [BETA_ENTITY_ID]),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("a steward gets the same 404 on another tenant's record", async () => {
      const db = drizzle(env.DB);
      const lead = await loadTenant(NEOGRANADINA_TENANT_ID);
      const leadAdmin = makeUser({
        id: LEAD_ADMIN_ID,
        tenantId: NEOGRANADINA_TENANT_ID,
        isAdmin: true,
      });
      await expect(
        requireAuthorityMutation(db, leadAdmin, lead, "entity", [
          BETA_ENTITY_ID,
        ]),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("an unknown id falls through to the steward gate, as it did before", async () => {
      const db = drizzle(env.DB);
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      await expect(
        requireAuthorityMutation(db, admin, alpha, "entity", [
          "00000000-0000-4000-8000-00000000dead",
        ]),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("places gate on the places table, not the entities one", async () => {
      const db = drizzle(env.DB);
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      await expect(
        requireAuthorityMutation(db, admin, alpha, "place", [ALPHA_PLACE_ID]),
      ).resolves.toBeUndefined();
      await expect(
        requireAuthorityMutation(db, admin, alpha, "place", [BETA_PLACE_ID]),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("the pair rule — merge and split", () => {
    it("both records owned by the request tenant: allowed, no steward", async () => {
      const db = drizzle(env.DB);
      const second = "0e000000-0000-4000-8000-000000000004";
      await seedEntity(second, ALPHA_TENANT_ID);
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      await expect(
        requireAuthorityMutation(db, admin, alpha, "entity", [
          ALPHA_ENTITY_ID,
          second,
        ]),
      ).resolves.toBeUndefined();
    });

    it("MIXED owned + shared falls through to the steward gate", async () => {
      const db = drizzle(env.DB);
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      // The owning tenant's admin is not a steward, so the mixed pair is
      // refused even though it owns one of the two records.
      await expect(
        requireAuthorityMutation(db, admin, alpha, "entity", [
          ALPHA_ENTITY_ID,
          SHARED_ENTITY_ID,
        ]),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("a steward MAY perform the mixed owned + shared merge", async () => {
      const db = drizzle(env.DB);
      const lead = await loadTenant(NEOGRANADINA_TENANT_ID);
      const leadAdmin = makeUser({
        id: LEAD_ADMIN_ID,
        tenantId: NEOGRANADINA_TENANT_ID,
        isAdmin: true,
      });
      // The mixed case is not forbidden, it is escalated: a steward on
      // the pair's own federation may do it. Both records must be
      // reachable from the request tenant, so the owned half is the lead
      // tenant's own.
      const leadOwned = "0e000000-0000-4000-8000-000000000005";
      await seedEntity(leadOwned, NEOGRANADINA_TENANT_ID);
      await expect(
        requireAuthorityMutation(db, leadAdmin, lead, "entity", [
          leadOwned,
          SHARED_ENTITY_ID,
        ]),
      ).resolves.toBeUndefined();
    });

    it("a pair spanning two tenants 404s rather than reaching the steward gate", async () => {
      const db = drizzle(env.DB);
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      await expect(
        requireAuthorityMutation(db, admin, alpha, "entity", [
          ALPHA_ENTITY_ID,
          BETA_ENTITY_ID,
        ]),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("two shared records keep the steward gate exactly as before", async () => {
      const db = drizzle(env.DB);
      const other = "0e000000-0000-4000-8000-000000000006";
      await seedEntity(other, null);
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const lead = await loadTenant(NEOGRANADINA_TENANT_ID);
      const leadAdmin = makeUser({
        id: LEAD_ADMIN_ID,
        tenantId: NEOGRANADINA_TENANT_ID,
        isAdmin: true,
      });
      await expect(
        requireAuthorityMutation(db, admin, alpha, "entity", [
          SHARED_ENTITY_ID,
          other,
        ]),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        requireAuthorityMutation(db, leadAdmin, lead, "entity", [
          SHARED_ENTITY_ID,
          other,
        ]),
      ).resolves.toBeUndefined();
    });
  });

  describe("minting default — shared_authorities_enabled", () => {
    it("sharing OFF mints a tenant-owned record, and a tenant admin may do it", async () => {
      const db = drizzle(env.DB);
      await setSharedAuthorities(false);
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      expect(await resolveMintOwner(db, alpha)).toBe(ALPHA_TENANT_ID);
      await expect(requireAuthorityMint(db, admin, alpha)).resolves.toBe(
        ALPHA_TENANT_ID,
      );
    });

    it("sharing OFF still refuses a non-admin", async () => {
      const db = drizzle(env.DB);
      await setSharedAuthorities(false);
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const staff = makeUser({
        id: ALPHA_STAFF_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: false,
      });
      await expect(requireAuthorityMint(db, staff, alpha)).rejects.toMatchObject(
        { status: 403 },
      );
    });

    it("sharing ON mints a shared record and needs a steward", async () => {
      const db = drizzle(env.DB);
      await setSharedAuthorities(true);
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      expect(await resolveMintOwner(db, alpha)).toBeNull();
      await expect(requireAuthorityMint(db, admin, alpha)).rejects.toMatchObject(
        { status: 403 },
      );

      const lead = await loadTenant(NEOGRANADINA_TENANT_ID);
      const leadAdmin = makeUser({
        id: LEAD_ADMIN_ID,
        tenantId: NEOGRANADINA_TENANT_ID,
        isAdmin: true,
      });
      await expect(requireAuthorityMint(db, leadAdmin, lead)).resolves.toBeNull();
    });

    it("the seeded Neogranadina federation ships with sharing ON", async () => {
      const db = drizzle(env.DB);
      const fed = await db
        .select({ shared: schema.federations.sharedAuthoritiesEnabled })
        .from(schema.federations)
        .where(eq(schema.federations.id, NEOGRANADINA_FEDERATION_ID))
        .get();
      expect(fed?.shared).toBe(true);
    });
  });

  describe("no owner anywhere — the pre-0067 platform is unchanged", () => {
    beforeEach(async () => {
      await unclaimEverything();
    });

    it("every member tenant sees the whole federation", async () => {
      const db = drizzle(env.DB);
      for (const tenantId of [
        NEOGRANADINA_TENANT_ID,
        ALPHA_TENANT_ID,
        BETA_TENANT_ID,
      ]) {
        const rows = await db
          .select({ id: schema.entities.id })
          .from(schema.entities)
          .where(
            authorityScope(
              schema.entities,
              NEOGRANADINA_FEDERATION_ID,
              tenantId,
            ),
          )
          .all();
        expect(rows).toHaveLength(3);
      }
    });

    it("the scope is equivalent to the bare federation filter it replaced", async () => {
      const db = drizzle(env.DB);
      const scoped = await db
        .select({ id: schema.places.id })
        .from(schema.places)
        .where(
          authorityScope(
            schema.places,
            NEOGRANADINA_FEDERATION_ID,
            ALPHA_TENANT_ID,
          ),
        )
        .all();
      const bare = await db
        .select({ id: schema.places.id })
        .from(schema.places)
        .where(eq(schema.places.federationId, NEOGRANADINA_FEDERATION_ID))
        .all();
      expect(scoped.map((r) => r.id).sort()).toEqual(
        bare.map((r) => r.id).sort(),
      );
    });

    it("every mutation is steward-gated, exactly as before", async () => {
      const db = drizzle(env.DB);
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const memberAdmin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const lead = await loadTenant(NEOGRANADINA_TENANT_ID);
      const leadAdmin = makeUser({
        id: LEAD_ADMIN_ID,
        tenantId: NEOGRANADINA_TENANT_ID,
        isAdmin: true,
      });
      for (const id of [SHARED_ENTITY_ID, ALPHA_ENTITY_ID, BETA_ENTITY_ID]) {
        await expect(
          requireAuthorityMutation(db, memberAdmin, alpha, "entity", [id]),
        ).rejects.toMatchObject({ status: 403 });
        await expect(
          requireAuthorityMutation(db, leadAdmin, lead, "entity", [id]),
        ).resolves.toBeUndefined();
      }
    });

    it("no 404 branch can trigger while nothing is owned", async () => {
      const db = drizzle(env.DB);
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const memberAdmin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      await expect(
        requireAuthorityMutation(db, memberAdmin, alpha, "entity", [
          ALPHA_ENTITY_ID,
          BETA_ENTITY_ID,
        ]),
      ).rejects.toMatchObject({ status: 403 });
    });
  });
});
