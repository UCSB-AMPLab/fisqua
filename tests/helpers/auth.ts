/**
 * Tests — auth
 *
 * @version v0.3.0
 */
import { getTestDb } from "./db";
import { users } from "../../app/db/schema";

/**
 * Creates a test user in the database and returns the user record.
 */
export async function createTestUser(overrides: {
  id?: string;
  email?: string;
  name?: string;
  isAdmin?: boolean;
} = {}) {
  const db = getTestDb();
  const now = Date.now();

  const user = {
    id: overrides.id ?? crypto.randomUUID(),
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
