/**
 * Tests — migration 0115, the workspace of a publish run
 *
 * This suite applies migration 0115 to an in-memory SQLite holding
 * stand-in `tenants`, `users` and `export_runs` tables with runs already
 * in them, and pins what the migration must do:
 *
 *   - `export_runs.tenant_id` is added, nullable, referencing `tenants`;
 *   - every existing run gets the stored workspace of the user who
 *     triggered it, which is what the readers scoped on before;
 *   - nothing else in the existing rows changes;
 *   - a run inserted afterwards may name its workspace, and a workspace
 *     that does not exist is refused.
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
  fileURLToPath(new URL("../../drizzle/0115_export_runs_tenant.sql", import.meta.url)),
  "utf8",
);

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE tenants (id TEXT PRIMARY KEY NOT NULL)");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id))");
  db.exec(
    "CREATE TABLE export_runs (id TEXT PRIMARY KEY NOT NULL, triggered_by TEXT NOT NULL REFERENCES users(id), " +
      "status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL)",
  );
  db.exec("INSERT INTO tenants (id) VALUES ('t-1'), ('t-2')");
  db.exec("INSERT INTO users (id, tenant_id) VALUES ('u-1', 't-1'), ('u-2', 't-2')");
  db.exec(
    "INSERT INTO export_runs (id, triggered_by, status, created_at) VALUES " +
      "('r-1', 'u-1', 'complete', 1), ('r-2', 'u-2', 'error', 2), ('r-3', 'u-1', 'running', 3)",
  );
  return db;
}

describe("migration 0115: export_runs.tenant_id", () => {
  it("adds a nullable column and backfills each run with its trigger's workspace", () => {
    const db = database();
    db.exec(migration);
    const column = (db.prepare("PRAGMA table_info(export_runs)").all() as Array<Record<string, unknown>>).find(
      (c) => c.name === "tenant_id",
    );
    expect(column).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });
    expect(db.prepare("SELECT * FROM export_runs ORDER BY id").all()).toEqual([
      { id: "r-1", triggered_by: "u-1", status: "complete", created_at: 1, tenant_id: "t-1" },
      { id: "r-2", triggered_by: "u-2", status: "error", created_at: 2, tenant_id: "t-2" },
      { id: "r-3", triggered_by: "u-1", status: "running", created_at: 3, tenant_id: "t-1" },
    ]);
  });

  it("references tenants", () => {
    const db = database();
    db.exec(migration);
    const fks = db.prepare("PRAGMA foreign_key_list(export_runs)").all() as Array<Record<string, unknown>>;
    expect(fks.some((f) => f.from === "tenant_id" && f.table === "tenants" && f.to === "id")).toBe(true);
    db.exec("INSERT INTO export_runs (id, triggered_by, created_at, tenant_id) VALUES ('r-4', 'u-1', 4, 't-2')");
    expect(() =>
      db.exec("INSERT INTO export_runs (id, triggered_by, created_at, tenant_id) VALUES ('r-5', 'u-1', 5, 't-9')"),
    ).toThrow(/FOREIGN KEY/);
  });
});

// @version v0.9.0
