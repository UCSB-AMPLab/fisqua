/**
 * Tests — migration 0113, a workspace's default interface language
 *
 * This suite applies migration 0113 to an in-memory SQLite holding a
 * stand-in `tenants` table with four existing rows (the platform, the
 * `ahr` and `neogranadina` workspaces, and one other workspace), and
 * pins what the migration must do:
 *
 *   - `default_locale` is added, nullable;
 *   - the `ahr` and `neogranadina` workspaces get `es`, and every other
 *     row stays NULL;
 *   - the column takes `en`, `es` or NULL, and refuses anything else;
 *   - a workspace inserted afterwards without the column gets NULL;
 *   - nothing else in the existing rows changes.
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
  fileURLToPath(new URL("../../drizzle/0113_tenant_default_locale.sql", import.meta.url)),
  "utf8",
);

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE tenants (
      id TEXT PRIMARY KEY NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'tenant',
      digitization_enabled INTEGER NOT NULL DEFAULT 0
    )`,
  );
  db.exec(
    `INSERT INTO tenants (id, slug, kind, digitization_enabled)
     VALUES ('t-1', 'platform', 'platform', 0), ('t-2', 'ahr', 'tenant', 1),
            ('t-3', 'neogranadina', 'tenant', 0), ('t-4', 'sbmal', 'tenant', 0)`,
  );
  return db;
}

const column = (db: DatabaseSync) =>
  (db.prepare("PRAGMA table_info(tenants)").all() as Array<Record<string, unknown>>).find(
    (c) => c.name === "default_locale",
  );

describe("migration 0113: tenants.default_locale", () => {
  it("adds a nullable column, sets ahr and neogranadina to es, and leaves the rest unchanged", () => {
    const db = database();
    db.exec(migration);
    expect(column(db)).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });
    expect(db.prepare("SELECT * FROM tenants ORDER BY id").all()).toEqual([
      { id: "t-1", slug: "platform", kind: "platform", digitization_enabled: 0, default_locale: null },
      { id: "t-2", slug: "ahr", kind: "tenant", digitization_enabled: 1, default_locale: "es" },
      { id: "t-3", slug: "neogranadina", kind: "tenant", digitization_enabled: 0, default_locale: "es" },
      { id: "t-4", slug: "sbmal", kind: "tenant", digitization_enabled: 0, default_locale: null },
    ]);
  });

  it("takes en, es or NULL and refuses any other value", () => {
    const db = database();
    db.exec(migration);
    const set = (value: string | null) =>
      db.prepare("UPDATE tenants SET default_locale = ? WHERE id = 't-4'").run(value);
    set("en");
    set("es");
    set(null);
    expect(() => set("fr")).toThrow(/CHECK constraint failed/);
    expect(() => set("ES")).toThrow(/CHECK constraint failed/);
    expect(() => set("")).toThrow(/CHECK constraint failed/);
  });

  it("gives a workspace inserted afterwards no default", () => {
    const db = database();
    db.exec(migration);
    db.exec("INSERT INTO tenants (id, slug) VALUES ('t-5', 'gamma')");
    expect(db.prepare("SELECT default_locale AS v FROM tenants WHERE id = 't-5'").get()).toEqual({ v: null });
  });
});

// @version v0.9.0
