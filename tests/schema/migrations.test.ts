/**
 * Tests — migrations
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = join(fileURLToPath(import.meta.url), "..");
const DRIZZLE_DIR = resolve(__dirname, "../../drizzle");
const META_DIR = join(DRIZZLE_DIR, "meta");

describe("migration files (SCHEMA-07)", () => {
  it("migration journal contains entry for 0010_github_login", () => {
    const journalPath = join(META_DIR, "_journal.json");
    expect(existsSync(journalPath)).toBe(true);

    const journal = JSON.parse(readFileSync(journalPath, "utf-8"));
    const hasEntry = journal.entries.some(
      (e: { tag: string }) => e.tag === "0010_github_login"
    );
    expect(hasEntry).toBe(true);
  });

  it("schema tables migration file exists (glob drizzle/0011_*.sql)", () => {
    const files = readdirSync(DRIZZLE_DIR);
    const match = files.find(
      (f) => f.startsWith("0011_") && f.endsWith(".sql")
    );
    expect(match).toBeDefined();
  });

  it("schema tables migration contains CREATE TABLE for all 7 tables", () => {
    const files = readdirSync(DRIZZLE_DIR);
    const migrationFile = files.find(
      (f) => f.startsWith("0011_") && f.endsWith(".sql")
    );
    expect(migrationFile).toBeDefined();

    const sql = readFileSync(join(DRIZZLE_DIR, migrationFile!), "utf-8");

    const expectedTables = [
      "repositories",
      "descriptions",
      "entities",
      "places",
      "description_entities",
      "description_places",
      "entity_functions",
    ];

    for (const table of expectedTables) {
      expect(sql).toContain(`CREATE TABLE \`${table}\``);
    }
  });

  it("FTS5 migration file exists (glob drizzle/0012_*.sql)", () => {
    const files = readdirSync(DRIZZLE_DIR);
    const match = files.find(
      (f) => f.startsWith("0012_") && f.endsWith(".sql")
    );
    expect(match).toBeDefined();
  });

  it("FTS5 migration contains CREATE VIRTUAL TABLE for entities_fts and places_fts", () => {
    const files = readdirSync(DRIZZLE_DIR);
    const migrationFile = files.find(
      (f) => f.startsWith("0012_") && f.endsWith(".sql")
    );
    expect(migrationFile).toBeDefined();

    const sql = readFileSync(join(DRIZZLE_DIR, migrationFile!), "utf-8");
    expect(sql).toContain("CREATE VIRTUAL TABLE");
    expect(sql).toContain("entities_fts");
    expect(sql).toContain("places_fts");
  });

  it("FTS5 migration contains unicode61 tokeniser", () => {
    const files = readdirSync(DRIZZLE_DIR);
    const migrationFile = files.find(
      (f) => f.startsWith("0012_") && f.endsWith(".sql")
    );
    expect(migrationFile).toBeDefined();

    const sql = readFileSync(join(DRIZZLE_DIR, migrationFile!), "utf-8");
    expect(sql).toContain("unicode61");
  });
});
