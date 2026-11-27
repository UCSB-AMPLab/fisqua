/**
 * Tests — migration 0127 under D1
 *
 * This suite runs migration 0127 under workerd's D1, the engine production
 * uses. `tests/import/changelog-acted-as-migration.test.ts` pins what the
 * migration does under Node's SQLite; this suite runs the same file on a
 * `changelog` built as the test mirror built it before 0127, and pins
 * that:
 *
 *   - the file runs, writes no row, and leaves the table, column for
 *     column and word for word, as the mirror in `tests/helpers/db.ts`
 *     creates it, so the mirror the other suites use cannot drift from
 *     the file;
 *   - D1 takes the two values and refuses `member`;
 *   - the app's own journal insert (`composeJournalEntry`) writes NULL
 *     unless it is given a value.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { applyMigrations, cleanDatabase, seedTenants } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { runMigrationFile } from "../helpers/migration-file";
import { composeJournalEntry } from "../../app/lib/stewardship.server";

type Column = { name: string; type: string; notnull: number; dflt_value: unknown; pk: number };

const run = (sql: string) => env.DB.prepare(sql).run();
const columns = async () => (await env.DB.prepare("PRAGMA table_info(changelog)").all<Column>()).results;
const tableSql = async () =>
  (await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'changelog'").first<{ sql: string }>())!.sql.replace(/\s+/g, " ").trim();

describe("migration 0127 under D1", () => {
  let mirror: { columns: Column[]; sql: string };
  let userId: string;
  let before: Record<string, unknown>[];

  beforeAll(async () => {
    await applyMigrations();
    await cleanDatabase();
    await seedTenants();
    userId = (await createTestUser({ email: "acted-as-0127@example.test" })).id;
    mirror = { columns: await columns(), sql: await tableSql() };
    // changelog as the mirror built it before 0127, with its indexes and triggers.
    await run("DROP TABLE changelog");
    await run("CREATE TABLE changelog (id TEXT PRIMARY KEY NOT NULL, record_id TEXT NOT NULL, record_type TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), note TEXT, diff TEXT NOT NULL, run_id TEXT, kind TEXT NOT NULL DEFAULT 'update' CHECK (kind IN ('create','update','delete','link','unlink')), created_at INTEGER NOT NULL)");
    await run("CREATE INDEX changelog_record_idx ON changelog(record_id, record_type, created_at)");
    await run("CREATE INDEX changelog_run_idx ON changelog(run_id)");
    await run("CREATE TRIGGER changelog_no_update BEFORE UPDATE ON changelog BEGIN SELECT RAISE(ABORT, 'changelog is append-only'); END");
    await run("CREATE TRIGGER changelog_no_delete BEFORE DELETE ON changelog BEGIN SELECT RAISE(ABORT, 'changelog is immutable'); END");
    await env.DB.prepare("INSERT INTO changelog (id, record_id, record_type, user_id, note, diff, kind, created_at) VALUES ('c-0127', 'd-1', 'description', ?, 'A note', '{}', 'update', 1)")
      .bind(userId)
      .run();
    before = (await env.DB.prepare("SELECT * FROM changelog").all()).results;
    await runMigrationFile("0127_changelog_acted_as.sql");
  });

  it("writes no row, and leaves the table as the test mirror creates it", async () => {
    const after = (await env.DB.prepare("SELECT * FROM changelog").all()).results;
    expect(after).toEqual(before.map((r) => ({ ...r, acted_as: null })));
    expect(await columns()).toEqual(mirror.columns);
    expect(await tableSql()).toBe(mirror.sql);
  });

  it("takes platform-admin and lead-admin, and refuses member", async () => {
    const insert = (id: string, value: string) =>
      env.DB.prepare("INSERT INTO changelog (id, record_id, record_type, user_id, diff, created_at, acted_as) VALUES (?, 'd-1', 'description', ?, '{}', 2, ?)")
        .bind(id, userId, value)
        .run();
    await insert("c-p", "platform-admin");
    await insert("c-l", "lead-admin");
    await expect(insert("c-m", "member")).rejects.toThrow(/CHECK constraint failed/);
  });

  it("writes NULL from the app's journal insert unless it is given a value", async () => {
    const db = drizzle(env.DB);
    await composeJournalEntry(db, { recordId: "d-2", recordType: "description", userId, kind: "update", diff: {}, now: 3 });
    await composeJournalEntry(db, { recordId: "d-3", recordType: "description", userId, kind: "update", diff: {}, now: 3, actedAs: "lead-admin" });
    const { results } = await env.DB.prepare("SELECT record_id, acted_as FROM changelog WHERE record_id IN ('d-2', 'd-3') ORDER BY record_id").all();
    expect(results).toEqual([{ record_id: "d-2", acted_as: null }, { record_id: "d-3", acted_as: "lead-admin" }]);
  });
});

// @version v0.9.0
