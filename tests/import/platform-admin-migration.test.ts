/**
 * Tests — migration 0114, the platform-admin flag
 *
 * This suite applies migration 0114 to an in-memory SQLite `users`
 * table shaped as before it, with two people in it, and pins what the
 * migration must do:
 *
 *   - every existing person keeps their row and every flag they held;
 *   - `is_platform_admin` reads 0 for every existing person, so no one
 *     gains access when it is applied;
 *   - a person inserted afterwards without the column reads 0, and the
 *     column refuses null.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const migration = readFileSync(
  fileURLToPath(new URL("../../drizzle/0114_users_platform_admin.sql", import.meta.url)),
  "utf8",
);

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, email TEXT NOT NULL UNIQUE, " +
      "is_admin INTEGER NOT NULL DEFAULT 0, is_super_admin INTEGER NOT NULL DEFAULT 0)",
  );
  db.exec(
    "INSERT INTO users (id, tenant_id, email, is_admin, is_super_admin) VALUES " +
      "('u-1', 't-1', 'admin@test.local', 1, 1), ('u-2', 't-2', 'member@test.local', 0, 0)",
  );
  return db;
}

describe("migration 0114", () => {
  it("keeps every person and their flags, the new flag 0", () => {
    const db = database();
    const before = db.prepare("SELECT * FROM users ORDER BY id").all();
    db.exec(migration);
    const after = db.prepare("SELECT * FROM users ORDER BY id").all();
    expect(after).toEqual(before.map((r) => ({ ...(r as object), is_platform_admin: 0 })));
    const column = (db.prepare("PRAGMA table_info(users)").all() as Array<Record<string, unknown>>).find(
      (c) => c.name === "is_platform_admin",
    );
    expect(column).toMatchObject({ type: "INTEGER", notnull: 1, dflt_value: "0" });
  });

  it("gives a person inserted afterwards 0, and refuses null", () => {
    const db = database();
    db.exec(migration);
    db.exec("INSERT INTO users (id, tenant_id, email) VALUES ('u-3', 't-1', 'new@test.local')");
    expect(db.prepare("SELECT is_platform_admin AS v FROM users WHERE id = 'u-3'").get()).toEqual({ v: 0 });
    expect(() => db.exec("UPDATE users SET is_platform_admin = NULL WHERE id = 'u-3'")).toThrow(/NOT NULL/);
  });
});

// @version v0.9.0
