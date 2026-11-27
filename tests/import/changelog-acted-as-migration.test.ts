/**
 * Tests — migration 0127, how the actor of a changelog row acted
 *
 * This suite builds `changelog` in the shape 0126 leaves it, with its
 * append-only triggers and two rows, applies migration 0127 under
 * Node's SQLite and pins what it must do:
 *
 *   - it writes no row: every row is as it was, and reads `acted_as`
 *     NULL;
 *   - a row inserted afterwards without the column reads NULL, as every
 *     app write does;
 *   - the column takes `platform-admin` and `lead-admin` and refuses any
 *     other value, `member` among them;
 *   - the table stays append-only.
 *
 * `tests/schema/changelog-acted-as-migration.test.ts` runs the same file
 * under workerd's D1.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const m0127 = readFileSync(fileURLToPath(new URL("../../drizzle/0127_changelog_acted_as.sql", import.meta.url)), "utf8");

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE changelog (id TEXT PRIMARY KEY NOT NULL, record_id TEXT NOT NULL, record_type TEXT NOT NULL, user_id TEXT NOT NULL,
    note TEXT, diff TEXT NOT NULL, run_id TEXT, kind TEXT NOT NULL DEFAULT 'update' CHECK (kind IN ('create','update','delete','link','unlink')),
    created_at INTEGER NOT NULL);
    CREATE TRIGGER changelog_no_update BEFORE UPDATE ON changelog BEGIN SELECT RAISE(ABORT, 'changelog is append-only'); END;
    CREATE TRIGGER changelog_no_delete BEFORE DELETE ON changelog BEGIN SELECT RAISE(ABORT, 'changelog is immutable'); END;`);
  db.exec(`INSERT INTO changelog (id, record_id, record_type, user_id, note, diff, run_id, kind, created_at) VALUES
    ('c-1', 'd-1', 'description', 'u-1', 'A note', '{"title":{"old":"a","new":"b"}}', NULL, 'update', 1),
    ('c-2', 'e-1', 'entity', 'u-2', NULL, '{}', 'run-1', 'create', 2)`);
  return db;
}

const rows = (db: DatabaseSync) => db.prepare("SELECT * FROM changelog ORDER BY id").all() as Array<Record<string, unknown>>;
const insert = (db: DatabaseSync, id: string, actedAs: string) =>
  db.exec(`INSERT INTO changelog (id, record_id, record_type, user_id, diff, created_at, acted_as) VALUES ('${id}', 'd-1', 'description', 'u-1', '{}', 3, '${actedAs}')`);

describe("migration 0127", () => {
  it("writes no row; every row reads acted_as NULL", () => {
    const db = database();
    const before = rows(db);
    db.exec(m0127);
    expect(rows(db)).toEqual(before.map((r) => ({ ...r, acted_as: null })));
    const column = (db.prepare("PRAGMA table_info(changelog)").all() as Array<Record<string, unknown>>).find((c) => c.name === "acted_as");
    expect(column).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });
  });

  it("gives a row inserted without the column NULL, and takes the two values", () => {
    const db = database();
    db.exec(m0127);
    db.exec("INSERT INTO changelog (id, record_id, record_type, user_id, diff, created_at) VALUES ('c-3', 'd-1', 'description', 'u-1', '{}', 3)");
    insert(db, "c-4", "platform-admin");
    insert(db, "c-5", "lead-admin");
    expect(db.prepare("SELECT id, acted_as FROM changelog WHERE id IN ('c-3', 'c-4', 'c-5') ORDER BY id").all()).toEqual([
      { id: "c-3", acted_as: null }, { id: "c-4", acted_as: "platform-admin" }, { id: "c-5", acted_as: "lead-admin" },
    ]);
  });

  it("refuses any other value, member among them", () => {
    const db = database();
    db.exec(m0127);
    expect(() => insert(db, "c-6", "member")).toThrow(/CHECK constraint failed/);
    expect(() => insert(db, "c-7", "steward")).toThrow(/CHECK constraint failed/);
  });

  it("leaves the table append-only", () => {
    const db = database();
    db.exec(m0127);
    expect(() => db.exec("UPDATE changelog SET acted_as = 'lead-admin' WHERE id = 'c-1'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM changelog WHERE id = 'c-1'")).toThrow(/immutable/);
  });
});

// @version v0.9.0
