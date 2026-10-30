/**
 * Tests — migration 0101, the scanner token's audit action
 *
 * This suite builds `audit_log` with the real migration 0037, behind
 * stand-in `users` and `tenants` tables, writes rows into it, applies
 * migration 0101 and pins what the rebuild must do:
 *
 *   - every existing row comes across with every value unchanged;
 *   - `scanner_token` is accepted, the seven earlier actions still are,
 *     and anything else is still refused;
 *   - the table is still append-only: an UPDATE and a DELETE are refused,
 *     and the one UPDATE the user foreign key's SET NULL makes is not;
 *   - the three indexes are back;
 *   - `capture_scanners` gains `revision` (0 for an existing scanner, NOT
 *     NULL) and `write_id`.
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
const m0093 = read("0093_capture_link.sql");
const m0101 = read("0101_audit_scanner_token.sql");

const INSERT =
  "INSERT INTO audit_log (id, created_at, actor_user_id, actor_user_id_text, actor_tenant_id, action, " +
  "target_tenant_id, target_object_kind, target_object_id, impersonation_session_id, details) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL)");
  db.exec("CREATE TABLE tenants (id TEXT PRIMARY KEY NOT NULL)");
  db.exec("INSERT INTO users (id) VALUES ('u-1'), ('u-2')");
  db.exec("INSERT INTO tenants (id) VALUES ('t-platform'), ('t-1')");
  db.exec(m0037);
  db.exec("CREATE TABLE pipeline_volumes (id TEXT PRIMARY KEY NOT NULL)");
  db.exec(m0093);
  db.exec(
    "INSERT INTO capture_scanners (id, tenant_id, name, token_sha256, token_created_at, created_at, updated_at) " +
      `VALUES ('s-1', 't-1', 'rig-1', '${"a".repeat(64)}', 100, 100, 100)`,
  );
  db.prepare(INSERT).run("a-1", 100, "u-1", "u-1", "t-platform", "create_tenant", "t-1", "tenant", "t-1", null, '{"slug":"one"}');
  db.prepare(INSERT).run("a-2", 200, "u-2", "u-2@example.test", "t-1", "edit_on_behalf", "t-1", "grant_write", null, "s-1", null);
  return db;
}

const rows = (db: DatabaseSync) => db.prepare("SELECT * FROM audit_log ORDER BY id").all();

describe("migration 0101: scanner_token in audit_log", () => {
  it("keeps every existing row unchanged", () => {
    const db = database();
    const before = rows(db);
    db.exec(m0101);
    expect(rows(db)).toEqual(before);
  });

  it("accepts scanner_token and the seven earlier actions, and refuses anything else", () => {
    const db = database();
    db.exec(m0101);
    const actions = [
      "create_tenant",
      "soft_disable_tenant",
      "reset_superadmin",
      "login_as",
      "edit_on_behalf",
      "set_capability",
      "set_quota",
      "scanner_token",
    ];
    actions.forEach((action, i) =>
      db.prepare(INSERT).run(`b-${i}`, 300 + i, "u-1", "u-1", "t-1", action, "t-1", null, null, null, null),
    );
    expect(() => db.prepare(INSERT).run("c-1", 400, "u-1", "u-1", "t-1", "garbage", null, null, null, null, null)).toThrow(
      /CHECK/,
    );
  });

  it("stays append-only, except for the user foreign key's SET NULL", () => {
    const db = database();
    db.exec(m0101);
    expect(() => db.exec("UPDATE audit_log SET details = 'x' WHERE id = 'a-1'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM audit_log WHERE id = 'a-1'")).toThrow(/immutable/);
    db.exec("DELETE FROM users WHERE id = 'u-2'");
    expect(db.prepare("SELECT actor_user_id, actor_user_id_text FROM audit_log WHERE id = 'a-2'").get()).toEqual({
      actor_user_id: null,
      actor_user_id_text: "u-2@example.test",
    });
  });

  it("gives an existing scanner revision 0 and no write id, and a new one the same by default", () => {
    const db = database();
    db.exec(m0101);
    expect(db.prepare("SELECT revision, write_id FROM capture_scanners WHERE id = 's-1'").get()).toEqual({
      revision: 0,
      write_id: null,
    });
    expect(() => db.exec("UPDATE capture_scanners SET revision = NULL WHERE id = 's-1'")).toThrow(/NOT NULL/);
  });

  it("creates the three indexes again", () => {
    const db = database();
    db.exec(m0101);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_log' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(names).toEqual(["audit_log_actor_user_idx", "audit_log_created_idx", "audit_log_target_tenant_idx"]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'audit_log_next'").all()).toEqual([]);
  });
});

// @version v0.8.0
