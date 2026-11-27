/**
 * Tests — auth
 *
 * This helper module wraps user-row creation for the test suite.
 * Every user row carries a tenant_id NOT NULL FK to tenants(id), so
 * tests must call `seedTenants()` in beforeEach before invoking
 * createTestUser. The helper defaults to DEFAULT_TEST_TENANT_ID
 * (= NEOGRANADINA_TENANT_ID); pass `tenantId` to assign a different
 * tenant for cross-tenant test scenarios.
 *
 * `createGrantUser` stands up a person who reaches the default tenant
 * through a federation grant: a user row in another tenant (the second
 * test tenant unless told otherwise), a `federation_memberships` row in
 * the default tenant's federation with the given role, and the user as
 * the auth middleware hands it to a loader under that grant, with the
 * grant's effective flags applied (`applyGrantEffectiveRole`). Tests
 * that check what a `staff` or `steward` grant may do use it in place of
 * a hand-built flag set.
 *
 * @version v0.9.0
 */
import {
  DEFAULT_TEST_FEDERATION_ID,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
  getTestDb,
} from "./db";
import { makeUserContext } from "./context";
import { federationMemberships, users } from "../../app/db/schema";
import { applyGrantEffectiveRole, type FederationRole } from "../../app/lib/federation.server";
import type { User } from "../../app/context";

/**
 * Creates a test user in the database and returns the user record.
 */
export async function createTestUser(overrides: {
  id?: string;
  tenantId?: string;
  email?: string;
  name?: string;
  isAdmin?: boolean;
} = {}) {
  const db = getTestDb();
  const now = Date.now();

  const user = {
    id: overrides.id ?? crypto.randomUUID(),
    tenantId: overrides.tenantId ?? DEFAULT_TEST_TENANT_ID,
    email: overrides.email ?? `test-${crypto.randomUUID()}@example.com`,
    name: overrides.name ?? "Test User",
    isAdmin: overrides.isAdmin ?? false,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(users).values(user);
  return user;
}

/**
 * Creates a session cookie value for a given user ID.
 * This is a simplified helper for testing -- in production, sessions
 * are managed by createCookieSessionStorage.
 */
export function createTestSessionCookie(userId: string, secret: string): string {
  // For unit tests that don't go through the full HTTP stack,
  // we'll use the session storage directly in the test setup.
  // This placeholder returns the userId for direct injection.
  return userId;
}

/**
 * Creates a user of another tenant with a `role` membership in the
 * default tenant's federation, and returns the effective user a request
 * under that grant carries.
 */
export async function createGrantUser(
  role: FederationRole,
  opts: { tenantId?: string; federationId?: string; name?: string } = {},
): Promise<User> {
  const homeTenantId = opts.tenantId ?? SECOND_TEST_TENANT_ID;
  const federationId = opts.federationId ?? DEFAULT_TEST_FEDERATION_ID;
  const row = await createTestUser({ tenantId: homeTenantId, name: opts.name ?? `Test ${role}` });
  await getTestDb().insert(federationMemberships).values({
    id: crypto.randomUUID(),
    userId: row.id,
    federationId,
    role,
    createdAt: Date.now(),
  });
  return applyGrantEffectiveRole(
    makeUserContext({ id: row.id, tenantId: row.tenantId, email: row.email, name: row.name }),
    { role, federationId, homeTenantId },
  );
}

// @version v0.9.0
