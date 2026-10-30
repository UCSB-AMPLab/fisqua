/**
 * Tests — migration 0098, the digitization capability
 *
 * This suite applies migration 0098 to an in-memory SQLite holding a
 * stand-in `tenants` table with the capability columns before it and
 * two existing rows, and pins what the migration must do:
 *
 *   - every existing tenant gets `digitization_enabled` = 0, so no
 *     tenant has the Digitization section until an operator grants it;
 *   - a tenant inserted afterwards without the column also gets 0;
 *   - the column takes 1, and refuses NULL;
 *   - nothing else in the existing rows changes.
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
  fileURLToPath(new URL("../../drizzle/0098_digitization_capability.sql", import.meta.url)),
  "utf8",
);

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE tenants (
      id TEXT PRIMARY KEY NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      authorities_enabled INTEGER NOT NULL DEFAULT 1,
      imports_enabled INTEGER NOT NULL DEFAULT 0,
      media_pipeline_enabled INTEGER NOT NULL DEFAULT 0
    )`,
  );
  db.exec(
    `INSERT INTO tenants (id, slug, authorities_enabled, imports_enabled, media_pipeline_enabled)
     VALUES ('t-1', 'alpha', 1, 1, 1), ('t-2', 'beta', 0, 0, 0)`,
  );
  return db;
}

describe("migration 0098: digitization_enabled", () => {
  it("adds the column, off for every existing tenant, leaving the rest unchanged", () => {
    const db = database();
    db.exec(migration);
    const rows = db.prepare("SELECT * FROM tenants ORDER BY id").all();
    expect(rows).toEqual([
      { id: "t-1", slug: "alpha", authorities_enabled: 1, imports_enabled: 1, media_pipeline_enabled: 1, digitization_enabled: 0 },
      { id: "t-2", slug: "beta", authorities_enabled: 0, imports_enabled: 0, media_pipeline_enabled: 0, digitization_enabled: 0 },
    ]);
  });

  it("defaults a new tenant to off, takes 1, and refuses NULL", () => {
    const db = database();
    db.exec(migration);
    db.exec("INSERT INTO tenants (id, slug) VALUES ('t-3', 'gamma')");
    expect(db.prepare("SELECT digitization_enabled AS v FROM tenants WHERE id = 't-3'").get()).toEqual({ v: 0 });
    db.exec("UPDATE tenants SET digitization_enabled = 1 WHERE id = 't-3'");
    expect(db.prepare("SELECT digitization_enabled AS v FROM tenants WHERE id = 't-3'").get()).toEqual({ v: 1 });
    expect(() => db.exec("UPDATE tenants SET digitization_enabled = NULL WHERE id = 't-3'")).toThrow(/NOT NULL/);
  });
});

// @version v0.8.0
