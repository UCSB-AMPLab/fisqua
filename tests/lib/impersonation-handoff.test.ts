/**
 * Tests — impersonation-handoff helper
 *
 * This suite pins the atomic single-use consume helper for the operator
 * login-as flow. It mirrors the oauth-handoff helper shape but is deliberately
 * a separate table so the OAuth narrative stays pure and the
 * role-based impersonation columns do not pollute the OAuth shape.
 *
 * Coverage:
 *   - insert + consume happy path returns the row's identity-bearing
 *     fields (actorUserId, targetTenantId, targetRole, reason).
 *   - double-consume returns null (race-safe single-use semantics).
 *   - expired row returns null on consume (TTL enforcement).
 *   - unknown id returns null on consume (no information leak).
 *   - IMPERSONATION_HANDOFF_TTL_MS constant equals 30_000.
 *   - reason nullable round-trips correctly (null in, null out).
 *
 * @version v0.4.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";
import {
  IMPERSONATION_HANDOFF_TTL_MS,
  insertImpersonationHandoff,
  consumeImpersonationHandoff,
} from "../../app/lib/impersonation-handoff.server";
import { PLATFORM_TENANT_ID } from "../../app/lib/tenant";

// Locked operator-user id for these tests. Once Task 4 lands
// `seedOperatorUser`, this constant moves to tests/helpers/db.ts; for
// now the test inlines the INSERT to keep Task 2 self-contained.
const TEST_OPERATOR_USER_ID = "44444444-4444-4444-8444-444444444444";

async function seedOperatorUserInline(): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO users (id, tenant_id, email, name, is_admin, is_super_admin, " +
      "is_collab_admin, is_archive_user, is_user_manager, is_cataloguer, " +
      "last_active_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      TEST_OPERATOR_USER_ID,
      PLATFORM_TENANT_ID,
      "operator@example.test",
      "Test Operator",
      1, 1, 0, 0, 1, 0,
      null, now, now,
    )
    .run();
}

describe("impersonation-handoff", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedOperatorUserInline();
  });

  it("IMPERSONATION_HANDOFF_TTL_MS is 30_000", () => {
    expect(IMPERSONATION_HANDOFF_TTL_MS).toBe(30_000);
  });

  it("insert + consume returns identity-bearing fields (happy path)", async () => {
    const db = drizzle(env.DB);
    const id = crypto.randomUUID();
    const now = Date.now();
    await insertImpersonationHandoff(db, {
      id,
      actorUserId: TEST_OPERATOR_USER_ID,
      targetTenantId: DEFAULT_TEST_TENANT_ID,
      targetRole: "isCataloguer",
      reason: "fixing a bug",
      now,
    });

    const consumed = await consumeImpersonationHandoff(db, id, now + 1);
    expect(consumed).not.toBeNull();
    expect(consumed!.actorUserId).toBe(TEST_OPERATOR_USER_ID);
    expect(consumed!.targetTenantId).toBe(DEFAULT_TEST_TENANT_ID);
    expect(consumed!.targetRole).toBe("isCataloguer");
    expect(consumed!.reason).toBe("fixing a bug");
  });

  it("double-consume returns null (single-use semantics)", async () => {
    const db = drizzle(env.DB);
    const id = crypto.randomUUID();
    const now = Date.now();
    await insertImpersonationHandoff(db, {
      id,
      actorUserId: TEST_OPERATOR_USER_ID,
      targetTenantId: DEFAULT_TEST_TENANT_ID,
      targetRole: "isAdmin",
      reason: null,
      now,
    });

    const first = await consumeImpersonationHandoff(db, id, now + 1);
    expect(first).not.toBeNull();
    const second = await consumeImpersonationHandoff(db, id, now + 2);
    expect(second).toBeNull();
  });

  it("expired row returns null on consume", async () => {
    const db = drizzle(env.DB);
    const id = crypto.randomUUID();
    const now = Date.now();
    await insertImpersonationHandoff(db, {
      id,
      actorUserId: TEST_OPERATOR_USER_ID,
      targetTenantId: DEFAULT_TEST_TENANT_ID,
      targetRole: "isSuperAdmin",
      reason: null,
      now,
    });

    // Consume well after TTL (TTL + 1ms past expiry).
    const consumed = await consumeImpersonationHandoff(
      db,
      id,
      now + IMPERSONATION_HANDOFF_TTL_MS + 1,
    );
    expect(consumed).toBeNull();
  });

  it("unknown id returns null on consume", async () => {
    const db = drizzle(env.DB);
    const consumed = await consumeImpersonationHandoff(
      db,
      "00000000-0000-0000-0000-000000000000",
      Date.now(),
    );
    expect(consumed).toBeNull();
  });

  it("reason nullable round-trips as null", async () => {
    const db = drizzle(env.DB);
    const id = crypto.randomUUID();
    const now = Date.now();
    await insertImpersonationHandoff(db, {
      id,
      actorUserId: TEST_OPERATOR_USER_ID,
      targetTenantId: DEFAULT_TEST_TENANT_ID,
      targetRole: "isCollabAdmin",
      reason: null,
      now,
    });

    const consumed = await consumeImpersonationHandoff(db, id, now + 1);
    expect(consumed).not.toBeNull();
    expect(consumed!.reason).toBeNull();
  });
});
