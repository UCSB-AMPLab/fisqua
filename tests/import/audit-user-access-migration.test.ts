/**
 * Tests — migration 0108, the audit actions for a person's access
 *
 * This suite builds `audit_log` with the real migrations 0037 and 0101,
 * behind stand-in `users`, `tenants` and `capture_scanners` tables,
 * writes rows into it, applies migration 0108 and pins what the rebuild
 * must do:
 *
 *   - every existing row comes across with every value unchanged;
 *   - `set_user_role`, `set_federation_role`, `set_project_membership`
 *     and `invite_user` are accepted, the eight earlier actions still
 *     are, and anything else is still refused;
 *   - the table is still append-only: an UPDATE and a DELETE are
 *     refused, and the one UPDATE the user foreign key's SET NULL makes
 *     is not;
 *   - the three indexes are back, and no `audit_log_next` is left.
 *
 * Every value here is a test value.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../../drizzle/${name}`, import.meta.url)), "utf8");
const m0037 = read("0037_audit_log.sql");
const m0101 = read("0101_audit_scanner_token.sql");
const m0108 = read("0108_audit_user_access.sql");

const INSERT =
  "INSERT INTO audit_log (id, created_at, actor_user_id, actor_user_id_text, actor_tenant_id, action, " +
  "target_tenant_id, target_object_kind, target_object_id, impersonation_session_id, details) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL)");
  db.exec("CREATE TABLE tenants (id TEXT PRIMARY KEY NOT NULL)");
  db.exec("CREATE TABLE capture_scanners (id TEXT PRIMARY KEY NOT NULL)");
  db.exec("INSERT INTO users (id) VALUES ('u-1'), ('u-2')");
  db.exec("INSERT INTO tenants (id) VALUES ('t-platform'), ('t-1')");
  db.exec(m0037);
  db.exec(m0101);
  db.prepare(INSERT).run("a-1", 100, "u-1", "u-1", "t-platform", "create_tenant", "t-1", "tenant", "t-1", null, '{"slug":"one"}');
  db.prepare(INSERT).run("a-2", 200, "u-2", "u-2@example.test", "t-1", "edit_on_behalf", "t-1", "grant_write", null, "s-1", null);
  db.prepare(INSERT).run("a-3", 300, "u-1", "u-1", "t-1", "scanner_token", "t-1", "capture_scanner", "c-1", null, '{"step":"create"}');
  return db;
}

const rows = (db: DatabaseSync) => db.prepare("SELECT * FROM audit_log ORDER BY id").all();

describe("migration 0108: access actions in audit_log", () => {
  it("keeps every existing row unchanged", () => {
    const db = database();
    const before = rows(db);
    db.exec(m0108);
    expect(rows(db)).toEqual(before);
  });

  it("accepts the four access actions and the eight earlier ones, and refuses anything else", () => {
    const db = database();
    expect(() => db.prepare(INSERT).run("x-1", 1, "u-1", "u-1", "t-1", "set_user_role", "t-1", "user", "u-2", null, "{}")).toThrow(
      /CHECK/,
    );
    db.exec(m0108);
    const actions = [
      "create_tenant",
      "soft_disable_tenant",
      "reset_superadmin",
      "login_as",
      "edit_on_behalf",
      "set_capability",
      "set_quota",
      "scanner_token",
      "set_user_role",
      "set_federation_role",
      "set_project_membership",
      "invite_user",
    ];
    actions.forEach((action, i) =>
      db.prepare(INSERT).run(`b-${i}`, 400 + i, "u-1", "u-1", "t-1", action, "t-1", "user", "u-2", null, "{}"),
    );
    expect(() => db.prepare(INSERT).run("c-1", 500, "u-1", "u-1", "t-1", "garbage", null, null, null, null, null)).toThrow(
      /CHECK/,
    );
  });

  it("stays append-only, except for the user foreign key's SET NULL", () => {
    const db = database();
    db.exec(m0108);
    expect(() => db.exec("UPDATE audit_log SET details = 'x' WHERE id = 'a-1'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM audit_log WHERE id = 'a-1'")).toThrow(/immutable/);
    db.exec("DELETE FROM users WHERE id = 'u-2'");
    expect(db.prepare("SELECT actor_user_id, actor_user_id_text FROM audit_log WHERE id = 'a-2'").get()).toEqual({
      actor_user_id: null,
      actor_user_id_text: "u-2@example.test",
    });
  });

  it("creates the three indexes and the two triggers again", () => {
    const db = database();
    db.exec(m0108);
    const names = (type: string) =>
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = 'audit_log' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .all(type)
        .map((r) => (r as { name: string }).name);
    expect(names("index")).toEqual(["audit_log_actor_user_idx", "audit_log_created_idx", "audit_log_target_tenant_idx"]);
    expect(names("trigger")).toEqual(["audit_log_no_delete", "audit_log_no_update"]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'audit_log_next'").all()).toEqual([]);
  });
});

// @version v0.8.0
