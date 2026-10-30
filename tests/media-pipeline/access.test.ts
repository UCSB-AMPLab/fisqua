/**
 * Tests — media pipeline access gate
 *
 * This suite pins `requireMediaPipelineAccess`, the two-part gate in
 * front of every media pipeline surface: the tenant's
 * `media_pipeline` capability first (a bare 404, so a disabled tenant
 * cannot learn anything about the user), then the user-scoped
 * federation steward check (a bare 403).
 *
 * The fixtures put the AHR tenant inside the Neogranadina federation as
 * a member, with Neogranadina as the lead, and give one Neogranadina
 * user a `staff` membership and another a `steward` membership, so the
 * member and grant paths are real. Grant-holders are built the way the
 * middleware builds them, through `resolveGrant` and
 * `applyGrantEffectiveRole`. The gate admits what
 * `isFederationSteward` admits: the lead's home admin on the lead, and
 * a `steward` grant into a member tenant; a member's home admin, a
 * `staff` grant and anyone in a suspended federation are refused.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedFederations,
} from "../helpers/db";
import { makeUserContext } from "../helpers/context";
import {
  AHR_TENANT_ID,
  NEOGRANADINA_TENANT_ID,
  NEOGRANADINA_FEDERATION_ID,
} from "../../app/lib/tenant";
import { requireMediaPipelineAccess } from "../../app/lib/pipeline/access.server";
import { applyGrantEffectiveRole, resolveGrant } from "../../app/lib/federation.server";
import type { Tenant, User } from "../../app/context";

const LEAD_ADMIN_ID = "1b000000-0000-4000-8000-000000000001";
const LEAD_CATALOGUER_ID = "1b000000-0000-4000-8000-000000000002";
const STAFF_GRANT_ID = "1b000000-0000-4000-8000-000000000003";
const AHR_ADMIN_ID = "1b000000-0000-4000-8000-000000000004";
const STEWARD_ID = "1b000000-0000-4000-8000-000000000005";

async function seedFixtures(): Promise<void> {
  const now = Date.now();
  // AHR as a member tenant of the Neogranadina federation.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, federation_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      AHR_TENANT_ID, "ahr", "Archivo Histórico de Rionegro", "tenant", "isadg", "active",
      0, 1, 0, 0, null, NEOGRANADINA_FEDERATION_ID, now, now,
    )
    .run();

  const users: Array<[string, string, number, number]> = [
    [LEAD_ADMIN_ID, NEOGRANADINA_TENANT_ID, 1, 0],
    [LEAD_CATALOGUER_ID, NEOGRANADINA_TENANT_ID, 0, 1],
    [STAFF_GRANT_ID, NEOGRANADINA_TENANT_ID, 0, 1],
    [AHR_ADMIN_ID, AHR_TENANT_ID, 1, 0],
    // The steward is not a home admin of the lead: the steward row is
    // the appointment.
    [STEWARD_ID, NEOGRANADINA_TENANT_ID, 0, 1],
  ];
  for (const [id, tenantId, isAdmin, isCataloguer] of users) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users (id, tenant_id, email, is_admin, is_cataloguer, created_at, updated_at) " +
        "VALUES (?,?,?,?,?,?,?)",
    )
      .bind(id, tenantId, `${id}@test.local`, isAdmin, isCataloguer, now, now)
      .run();
  }

  await env.DB.prepare(
    "INSERT OR IGNORE INTO federation_memberships (id, user_id, federation_id, role, created_at) VALUES (?,?,?,?,?)",
  )
    .bind(crypto.randomUUID(), STAFF_GRANT_ID, NEOGRANADINA_FEDERATION_ID, "staff", now)
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO federation_memberships (id, user_id, federation_id, role, created_at) VALUES (?,?,?,?,?)",
  )
    .bind(crypto.randomUUID(), STEWARD_ID, NEOGRANADINA_FEDERATION_ID, "steward", now)
    .run();
}

/**
 * The acting user as the middleware hands it to a route in `tenant`:
 * the home user row, with a resolved grant's effective role applied.
 */
async function actingUser(home: User, tenant: Tenant): Promise<User> {
  const db = drizzle(env.DB);
  const grant = await resolveGrant(db, home, tenant);
  return grant ? applyGrantEffectiveRole(home, grant) : home;
}

async function loadTenant(id: string, mediaPipelineEnabled: boolean): Promise<Tenant> {
  const db = drizzle(env.DB, { schema });
  const row = await db.select().from(schema.tenants).where(eq(schema.tenants.id, id)).get();
  if (!row) throw new Error(`tenant ${id} not seeded`);
  return { ...(row as Tenant), mediaPipelineEnabled };
}

async function expectStatus(promise: Promise<unknown>, status: number) {
  try {
    await promise;
    expect.fail(`should throw ${status}`);
  } catch (e) {
    expect(e).toBeInstanceOf(Response);
    expect((e as Response).status).toBe(status);
    expect((e as Response).body).toBeNull();
  }
}

describe("requireMediaPipelineAccess", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedFederations();
    await seedFixtures();
  });

  it("answers 404, not 403, when the capability is off, even for a lead-tenant home admin", async () => {
    const db = drizzle(env.DB);
    const user = makeUserContext({
      id: LEAD_ADMIN_ID,
      tenantId: NEOGRANADINA_TENANT_ID,
      isAdmin: true,
    });
    const lead = await loadTenant(NEOGRANADINA_TENANT_ID, false);
    await expectStatus(requireMediaPipelineAccess(db, lead, user), 404);
  });

  it("refuses a non-admin cataloguer on the lead tenant with 403", async () => {
    const db = drizzle(env.DB);
    const user = makeUserContext({
      id: LEAD_CATALOGUER_ID,
      tenantId: NEOGRANADINA_TENANT_ID,
      isCataloguer: true,
    });
    const lead = await loadTenant(NEOGRANADINA_TENANT_ID, true);
    await expectStatus(requireMediaPipelineAccess(db, lead, user), 403);
  });

  it("refuses a federation staff grant into a member tenant with 403", async () => {
    const db = drizzle(env.DB);
    // Under a staff grant the middleware clears administration; the
    // user's home tenant is the lead.
    const member = await loadTenant(AHR_TENANT_ID, true);
    const user = await actingUser(
      makeUserContext({
        id: STAFF_GRANT_ID,
        tenantId: NEOGRANADINA_TENANT_ID,
        isCataloguer: true,
      }),
      member,
    );
    expect(user.isAdmin).toBe(false);
    await expectStatus(requireMediaPipelineAccess(db, member, user), 403);
  });

  it("refuses a home admin of a member tenant that is not the federation lead with 403", async () => {
    const db = drizzle(env.DB);
    const user = makeUserContext({
      id: AHR_ADMIN_ID,
      tenantId: AHR_TENANT_ID,
      isAdmin: true,
    });
    const member = await loadTenant(AHR_TENANT_ID, true);
    await expectStatus(requireMediaPipelineAccess(db, member, user), 403);
  });

  it("admits a federation steward grant into a member tenant", async () => {
    const db = drizzle(env.DB);
    const member = await loadTenant(AHR_TENANT_ID, true);
    const user = await actingUser(
      makeUserContext({
        id: STEWARD_ID,
        tenantId: NEOGRANADINA_TENANT_ID,
        isCataloguer: true,
      }),
      member,
    );
    expect(user.isAdmin).toBe(true);
    await expect(requireMediaPipelineAccess(db, member, user)).resolves.toBeUndefined();
  });

  it("answers 404 to a steward grant when the member tenant's capability is off", async () => {
    const db = drizzle(env.DB);
    const member = await loadTenant(AHR_TENANT_ID, false);
    const user = await actingUser(
      makeUserContext({
        id: STEWARD_ID,
        tenantId: NEOGRANADINA_TENANT_ID,
        isCataloguer: true,
      }),
      member,
    );
    await expectStatus(requireMediaPipelineAccess(db, member, user), 404);
  });

  it("refuses a steward in a suspended federation with 403", async () => {
    await env.DB.prepare("UPDATE federations SET status = 'suspended' WHERE id = ?")
      .bind(NEOGRANADINA_FEDERATION_ID)
      .run();
    const db = drizzle(env.DB);
    const member = await loadTenant(AHR_TENANT_ID, true);
    // The middleware would not resolve a grant here at all; the gate is
    // checked on its own with the steward's admin-equivalent flags, so
    // the refusal does not depend on the middleware.
    const user = makeUserContext({
      id: STEWARD_ID,
      tenantId: NEOGRANADINA_TENANT_ID,
      isAdmin: true,
      isCollabAdmin: true,
    });
    expect(await resolveGrant(db, user, member)).toBeNull();
    await expectStatus(requireMediaPipelineAccess(db, member, user), 403);
    // The lead's home admin is refused too.
    const lead = await loadTenant(NEOGRANADINA_TENANT_ID, true);
    const admin = makeUserContext({
      id: LEAD_ADMIN_ID,
      tenantId: NEOGRANADINA_TENANT_ID,
      isAdmin: true,
    });
    await expectStatus(requireMediaPipelineAccess(db, lead, admin), 403);
  });

  it("admits a lead-tenant home admin acting on the lead tenant", async () => {
    const db = drizzle(env.DB);
    const user = makeUserContext({
      id: LEAD_ADMIN_ID,
      tenantId: NEOGRANADINA_TENANT_ID,
      isAdmin: true,
    });
    const lead = await loadTenant(NEOGRANADINA_TENANT_ID, true);
    await expect(requireMediaPipelineAccess(db, lead, user)).resolves.toBeUndefined();
  });

  it.todo("a superadmin compared with a plain admin on the lead tenant");
});
