/**
 * Tests — vocabulary migration
 *
 * @version v0.3.0
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { migrateEntityFunctions } from "../../scripts/commands/vocabulary-migration";

describe("migrateEntityFunctions", () => {
  let tmpDir: string;
  let lookupPath: string;
  let entitiesPath: string;

  const termUuid1 = "aaaaaaaa-1111-4000-8000-000000000001";
  const termUuid2 = "aaaaaaaa-1111-4000-8000-000000000002";

  const lookupMap: Record<string, string | null> = {
    doctor: termUuid1,
    "dr.": termUuid1,
    alcalde: termUuid2,
    "gobernador y capitán general": null, // compound function
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vocab-mig-test-"));
    lookupPath = path.join(tmpDir, "vocabulary-term-lookup.json");
    entitiesPath = path.join(tmpDir, "entities.json");
    await fs.writeFile(lookupPath, JSON.stringify(lookupMap), "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("matches entity primaryFunction to vocabulary term via lookup", async () => {
    const entities = [
      { id: "e-001", primary_function: "Doctor" },
      { id: "e-002", primary_function: "Alcalde" },
    ];
    await fs.writeFile(entitiesPath, JSON.stringify(entities), "utf8");

    const result = await migrateEntityFunctions(lookupPath, entitiesPath, tmpDir);

    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);

    // Check SQL contains UPDATE statements with correct UUIDs
    const sqlFiles = result.sqlFiles.filter((f) => f.endsWith(".sql"));
    const sql = await fs.readFile(sqlFiles[0], "utf8");
    expect(sql).toContain(termUuid1); // Doctor
    expect(sql).toContain(termUuid2); // Alcalde
    expect(sql).toContain("UPDATE entities SET primary_function_id");
  });

  it("creates proposed vocabulary term for unmatched values", async () => {
    const entities = [
      { id: "e-003", primary_function: "Obispo" }, // not in lookup
    ];
    await fs.writeFile(entitiesPath, JSON.stringify(entities), "utf8");

    const result = await migrateEntityFunctions(lookupPath, entitiesPath, tmpDir);

    expect(result.imported).toBe(1); // 1 unmatched = still "imported" (linked)

    const sqlFiles = result.sqlFiles.filter((f) => f.endsWith(".sql"));
    const sql = await fs.readFile(sqlFiles[0], "utf8");
    expect(sql).toContain("INSERT INTO vocabulary_terms");
    expect(sql).toContain("'proposed'");
    expect(sql).toContain("Obispo");
    expect(sql).toContain("UPDATE entities SET primary_function_id");
  });

  it("skips entities with null primaryFunction", async () => {
    const entities = [
      { id: "e-004", primary_function: null },
      { id: "e-005", primary_function: "Doctor" },
    ];
    await fs.writeFile(entitiesPath, JSON.stringify(entities), "utf8");

    const result = await migrateEntityFunctions(lookupPath, entitiesPath, tmpDir);

    expect(result.total).toBe(2);
    expect(result.imported).toBe(1); // only Doctor
    expect(result.skipped).toBe(1); // null skipped
  });

  it("performs case-insensitive matching", async () => {
    const entities = [
      { id: "e-006", primary_function: "DOCTOR" },
      { id: "e-007", primary_function: "doctor" },
      { id: "e-008", primary_function: "Doctor" },
    ];
    await fs.writeFile(entitiesPath, JSON.stringify(entities), "utf8");

    const result = await migrateEntityFunctions(lookupPath, entitiesPath, tmpDir);

    expect(result.imported).toBe(3);

    const sqlFiles = result.sqlFiles.filter((f) => f.endsWith(".sql"));
    const sql = await fs.readFile(sqlFiles[0], "utf8");
    // All three should reference the same term UUID
    const matches = sql.match(new RegExp(termUuid1, "g"));
    expect(matches).toHaveLength(3);
  });

  it("skips null-canonical compound entries from lookup", async () => {
    const entities = [
      { id: "e-009", primary_function: "Gobernador y Capitán General" },
    ];
    await fs.writeFile(entitiesPath, JSON.stringify(entities), "utf8");

    const result = await migrateEntityFunctions(lookupPath, entitiesPath, tmpDir);

    // Null-canonical entries are skipped, not linked
    expect(result.skipped).toBe(1);
    expect(result.imported).toBe(0);
  });

  it("deduplicates proposed terms for repeated unmatched values", async () => {
    const entities = [
      { id: "e-010", primary_function: "Virrey" },
      { id: "e-011", primary_function: "Virrey" },
      { id: "e-012", primary_function: "virrey" }, // same, different case
    ];
    await fs.writeFile(entitiesPath, JSON.stringify(entities), "utf8");

    const result = await migrateEntityFunctions(lookupPath, entitiesPath, tmpDir);

    expect(result.imported).toBe(3);

    const sqlFiles = result.sqlFiles.filter((f) => f.endsWith(".sql"));
    const sql = await fs.readFile(sqlFiles[0], "utf8");
    // Only one INSERT for the proposed term "Virrey"
    const insertMatches = sql.match(/INSERT INTO vocabulary_terms/g);
    expect(insertMatches).toHaveLength(1);
    // But three UPDATE statements
    const updateMatches = sql.match(/UPDATE entities SET primary_function_id/g);
    expect(updateMatches).toHaveLength(3);
  });
});
