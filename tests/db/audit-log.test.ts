/**
 * Tests — audit_log table
 *
 * This suite verifies audit_log shape (12 columns + 3 indexes),
 * bounded action CHECK enum, and BEFORE UPDATE / BEFORE DELETE
 * immutability triggers. Forensic-continuity test for actor_user_id_text
 * denormalisation.
 *
 * The harness mirrors the SQL migration verbatim including the two
 * RAISE(ABORT) triggers, so all rejection paths exercise the exact
 * same trigger bodies that production runs.
 *
 * @version v0.4.0
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
} from "../helpers/db";
import {
  PLATFORM_TENANT_ID,
  NEOGRANADINA_TENANT_ID,
} from "../../app/lib/tenant";

describe("audit_log", () => {
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    db = drizzle(env.DB, { schema });
  });

  it("schema — audit_log exists with bounded action CHECK and three indexes", async () => {
    const now = Date.now();
    const id = crypto.randomUUID();

    // Round-trip a valid row through every column to assert the shape
    // matches the migration. action='create_tenant' is one of the
    // seven bounded values; actor_tenant_id is the platform; target
    // is the neogranadina tenant (operator action against a tenant).
    await env.DB.prepare(
      "INSERT INTO audit_log (id, created_at, actor_user_id, actor_user_id_text, " +
        "actor_tenant_id, action, target_tenant_id, target_object_kind, " +
        "target_object_id, impersonation_session_id, details) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        now,
        null, // actor_user_id is nullable (no FK row pre-existing here)
        "operator-1",
        PLATFORM_TENANT_ID,
        "create_tenant",
        NEOGRANADINA_TENANT_ID,
        "tenant",
        NEOGRANADINA_TENANT_ID,
        null,
        JSON.stringify({ note: "round-trip" }),
      )
      .run();

    const row = await env.DB.prepare(
      "SELECT id, created_at, actor_user_id, actor_user_id_text, actor_tenant_id, " +
        "action, target_tenant_id, target_object_kind, target_object_id, " +
        "impersonation_session_id, details FROM audit_log WHERE id = ?",
    )
      .bind(id)
      .first<{
        id: string;
        created_at: number;
        actor_user_id: string | null;
        actor_user_id_text: string;
        actor_tenant_id: string;
        action: string;
        target_tenant_id: string | null;
        target_object_kind: string | null;
        target_object_id: string | null;
        impersonation_session_id: string | null;
        details: string | null;
      }>();
    expect(row).not.toBeNull();
    expect(row!.id).toBe(id);
    expect(row!.created_at).toBe(now);
    expect(row!.actor_user_id).toBeNull();
    expect(row!.actor_user_id_text).toBe("operator-1");
    expect(row!.actor_tenant_id).toBe(PLATFORM_TENANT_ID);
    expect(row!.action).toBe("create_tenant");
    expect(row!.target_tenant_id).toBe(NEOGRANADINA_TENANT_ID);
    expect(row!.target_object_kind).toBe("tenant");
    expect(row!.target_object_id).toBe(NEOGRANADINA_TENANT_ID);
    expect(row!.impersonation_session_id).toBeNull();
    expect(JSON.parse(row!.details!)).toEqual({ note: "round-trip" });

    // Three indexes: target_tenant + created_at, actor_user
    // + created_at, created_at standalone.
    const indexes = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_log'",
    ).all<{ name: string }>();
    const names = (indexes.results ?? []).map((r) => r.name);
    expect(names).toContain("audit_log_target_tenant_idx");
    expect(names).toContain("audit_log_actor_user_idx");
    expect(names).toContain("audit_log_created_idx");
  });

  it("action CHECK — INSERT with action='garbage' rejects (bounded enum)", async () => {
    const now = Date.now();

    // Bare-SQL INSERT bypasses Drizzle's TS enum guard so we exercise
    // the actual CHECK constraint at the DB layer.
    await expect(
      env.DB.prepare(
        "INSERT INTO audit_log (id, created_at, actor_user_id_text, actor_tenant_id, action) " +
          "VALUES (?,?,?,?,?)",
      )
        .bind(
          crypto.randomUUID(),
          now,
          "operator-1",
          PLATFORM_TENANT_ID,
          "garbage",
        )
        .run(),
    ).rejects.toThrow();

    // Each of the seven bounded action values must succeed.
    const validActions = [
      "create_tenant",
      "soft_disable_tenant",
      "reset_superadmin",
      "login_as",
      "edit_on_behalf",
      "set_capability",
      "set_quota",
    ] as const;
    for (const action of validActions) {
      await env.DB.prepare(
        "INSERT INTO audit_log (id, created_at, actor_user_id_text, actor_tenant_id, action) " +
          "VALUES (?,?,?,?,?)",
      )
        .bind(
          crypto.randomUUID(),
          now,
          "operator-1",
          PLATFORM_TENANT_ID,
          action,
        )
        .run();
    }
    // Read back the count -- 7 valid rows landed.
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM audit_log",
    ).first<{ c: number }>();
    expect(count!.c).toBe(7);
  });

  it("no UPDATE — UPDATE on audit_log fails with RAISE(ABORT) 'audit_log is append-only'", async () => {
    const now = Date.now();
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO audit_log (id, created_at, actor_user_id_text, actor_tenant_id, action) " +
        "VALUES (?,?,?,?,?)",
    )
      .bind(id, now, "operator-1", PLATFORM_TENANT_ID, "create_tenant")
      .run();

    // BEFORE UPDATE trigger fires RAISE(ABORT, 'audit_log is append-only').
    await expect(
      env.DB.prepare("UPDATE audit_log SET action = ? WHERE id = ?")
        .bind("login_as", id)
        .run(),
    ).rejects.toThrow(/audit_log is append-only/);

    // The row stays untouched.
    const row = await env.DB.prepare(
      "SELECT action FROM audit_log WHERE id = ?",
    )
      .bind(id)
      .first<{ action: string }>();
    expect(row!.action).toBe("create_tenant");
  });

  it("no DELETE — DELETE on audit_log fails with RAISE(ABORT) 'audit_log is immutable'", async () => {
    const now = Date.now();
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO audit_log (id, created_at, actor_user_id_text, actor_tenant_id, action) " +
        "VALUES (?,?,?,?,?)",
    )
      .bind(id, now, "operator-1", PLATFORM_TENANT_ID, "create_tenant")
      .run();

    // BEFORE DELETE trigger fires RAISE(ABORT, 'audit_log is immutable').
    await expect(
      env.DB.prepare("DELETE FROM audit_log WHERE id = ?").bind(id).run(),
    ).rejects.toThrow(/audit_log is immutable/);

    // The row stays.
    const row = await env.DB.prepare(
      "SELECT id FROM audit_log WHERE id = ?",
    )
      .bind(id)
      .first<{ id: string }>();
    expect(row!.id).toBe(id);
  });

  it("forensic continuity — actor_user_id clears on user delete (SET NULL) but actor_user_id_text retains literal id", async () => {
    const now = Date.now();
    const userId = crypto.randomUUID();
    // Seed a real user row so we can exercise the FK SET NULL path.
    await env.DB.prepare(
      "INSERT INTO users (id, tenant_id, email, created_at, updated_at) " +
        "VALUES (?,?,?,?,?)",
    )
      .bind(userId, PLATFORM_TENANT_ID, `op-${userId}@example.com`, now, now)
      .run();

    const auditId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO audit_log (id, created_at, actor_user_id, actor_user_id_text, " +
        "actor_tenant_id, action) VALUES (?,?,?,?,?,?)",
    )
      .bind(auditId, now, userId, userId, PLATFORM_TENANT_ID, "create_tenant")
      .run();

    // Delete the user. The FK is ON DELETE SET NULL, so actor_user_id
    // clears -- but actor_user_id_text MUST keep the original literal
    // for forensic continuity. The denormalised text column
    // is the one place denormalisation buys real audit integrity.
    await env.DB.prepare("DELETE FROM users WHERE id = ?")
      .bind(userId)
      .run();

    const row = await env.DB.prepare(
      "SELECT actor_user_id, actor_user_id_text FROM audit_log WHERE id = ?",
    )
      .bind(auditId)
      .first<{
        actor_user_id: string | null;
        actor_user_id_text: string;
      }>();
    expect(row!.actor_user_id).toBeNull();
    expect(row!.actor_user_id_text).toBe(userId);
  });
});
