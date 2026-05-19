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
 * @version v0.4.0
 */
import { DEFAULT_TEST_TENANT_ID, getTestDb } from "./db";
import { users } from "../../app/db/schema";

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
