/**
 * Tests — migration 0107, the four area-admin flags
 *
 * This suite applies migration 0107 to an in-memory SQLite `users`
 * table shaped as before it, with a workspace admin and a member
 * already in it, and pins what the migration must do:
 *
 *   - every existing user keeps their row and every flag they held;
 *   - each of the four new columns reads 0 for every existing user, so
 *     no one gains or loses access when it is applied;
 *   - a user inserted afterwards without the columns also reads 0, and
 *     a column refuses null.
 *
 * Every value here is a test value.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const migration = readFileSync(
  fileURLToPath(new URL("../../drizzle/0107_area_admin_flags.sql", import.meta.url)),
  "utf8",
);

const FLAGS = [
  "is_records_admin",
  "is_authorities_admin",
  "is_imports_admin",
  "is_digitization_admin",
];

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL, " +
      "is_admin INTEGER NOT NULL DEFAULT 0, is_super_admin INTEGER NOT NULL DEFAULT 0, " +
      "is_cataloguer INTEGER NOT NULL DEFAULT 0)",
  );
  db.exec(
    "INSERT INTO users (id, email, is_admin, is_cataloguer) VALUES " +
      "('admin-1', 'admin@test.local', 1, 0), ('member-1', 'member@test.local', 0, 1)",
  );
  return db;
}

describe("migration 0107", () => {
  it("keeps every user and their flags, each new flag 0", () => {
    const db = database();
    const before = db.prepare("SELECT * FROM users ORDER BY id").all();
    db.exec(migration);
    const after = db.prepare("SELECT * FROM users ORDER BY id").all();
    expect(after).toEqual(
      before.map((r) => ({
        ...(r as object),
        is_records_admin: 0,
        is_authorities_admin: 0,
        is_imports_admin: 0,
        is_digitization_admin: 0,
      })),
    );
  });

  it("defaults a new user's flags to 0 and refuses null", () => {
    const db = database();
    db.exec(migration);
    db.exec("INSERT INTO users (id, email) VALUES ('new-1', 'new@test.local')");
    const row = db.prepare(`SELECT ${FLAGS.join(", ")} FROM users WHERE id = 'new-1'`).get();
    expect(row).toEqual(Object.fromEntries(FLAGS.map((f) => [f, 0])));
    for (const flag of FLAGS) {
      expect(() => db.exec(`UPDATE users SET ${flag} = NULL WHERE id = 'new-1'`)).toThrow(
        /NOT NULL constraint failed/,
      );
    }
  });
});
