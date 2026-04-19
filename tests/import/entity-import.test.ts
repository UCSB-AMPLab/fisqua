/**
 * Tests — entity import
 *
 * @version v0.3.0
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const OUTPUT_DIR = ".import";

async function cleanOutput() {
  try {
    await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe("importEntities", () => {
  beforeEach(cleanOutput);
  afterEach(cleanOutput);

  it("returns correct row count and IdMap for all input records", async () => {
    const { importEntities } = await import("../../scripts/commands/entities");
    const fixturePath = path.resolve("tests/import/fixtures/entities.json");
    const { result, idMap } = await importEntities(fixturePath);

    expect(result.table).toBe("entities");
    expect(result.total).toBe(5);
    expect(result.imported).toBe(5);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(idMap.size).toBe(5);
    // All old IDs mapped
    expect(idMap.has(100)).toBe(true);
    expect(idMap.has(101)).toBe(true);
    expect(idMap.has(102)).toBe(true);
    expect(idMap.has(103)).toBe(true);
    expect(idMap.has(104)).toBe(true);
  });

  it("generates SQL files in .import/ directory", async () => {
    const { importEntities } = await import("../../scripts/commands/entities");
    const fixturePath = path.resolve("tests/import/fixtures/entities.json");
    const { result } = await importEntities(fixturePath);

    expect(result.sqlFiles.length).toBeGreaterThan(0);
    for (const file of result.sqlFiles) {
      const stat = await fs.stat(file);
      expect(stat.isFile()).toBe(true);
    }
  });

  it("generates SQL with valid INSERT INTO entities statements", async () => {
    const { importEntities } = await import("../../scripts/commands/entities");
    const fixturePath = path.resolve("tests/import/fixtures/entities.json");
    const { result } = await importEntities(fixturePath);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    expect(content).toContain("PRAGMA defer_foreign_keys = true");
    expect(content).toContain("INSERT INTO entities");
  });

  it("generates entity_code values matching /^ne-[a-z2-9]{6}$/", async () => {
    const { importEntities } = await import("../../scripts/commands/entities");
    const fixturePath = path.resolve("tests/import/fixtures/entities.json");
    const { result } = await importEntities(fixturePath);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    const codePattern = /ne-[a-z2-9]{6}/g;
    const codes = content.match(codePattern);
    expect(codes).not.toBeNull();
    expect(codes!.length).toBe(5);
    // Each code is unique
    const unique = new Set(codes);
    expect(unique.size).toBe(5);
  });

  it("converts created_at to epoch seconds (integer, not ISO string)", async () => {
    const { importEntities } = await import("../../scripts/commands/entities");
    const fixturePath = path.resolve("tests/import/fixtures/entities.json");
    const { result } = await importEntities(fixturePath);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    // Should NOT contain ISO datetime strings for created_at
    expect(content).not.toContain("2023-07-01T10:00:00Z");
    // Should contain epoch seconds (e.g. 1688205600)
    expect(content).toContain("1688205600");
  });

  it("handles name_variants as JSON string (not double-encoded)", async () => {
    const { importEntities } = await import("../../scripts/commands/entities");
    const fixturePath = path.resolve("tests/import/fixtures/entities.json");
    const { result } = await importEntities(fixturePath);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    // Should contain the JSON array as a string value
    expect(content).toContain("Joan de Castellanos");
    // Should NOT be double-encoded
    expect(content).not.toContain('\\"Joan de Castellanos\\"');
  });

  it("escapes single quotes in string values (e.g. O'Brien)", async () => {
    const { importEntities } = await import("../../scripts/commands/entities");
    const fixturePath = path.resolve("tests/import/fixtures/entities.json");
    const { result } = await importEntities(fixturePath);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    // O'Brien should be escaped as O''Brien in SQL
    expect(content).toContain("O''Brien");
  });

  it("UUIDs in IdMap are valid v4 format", async () => {
    const { importEntities } = await import("../../scripts/commands/entities");
    const fixturePath = path.resolve("tests/import/fixtures/entities.json");
    const { idMap } = await importEntities(fixturePath);

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const uuid of idMap.values()) {
      expect(uuid).toMatch(uuidPattern);
    }
  });
});

describe("importRepositories", () => {
  beforeEach(cleanOutput);
  afterEach(cleanOutput);

  it("returns correct row count and IdMap", async () => {
    const { importRepositories } = await import("../../scripts/commands/repositories");
    const fixturePath = path.resolve("tests/import/fixtures/repositories.json");
    const { result, idMap } = await importRepositories(fixturePath);

    expect(result.table).toBe("repositories");
    expect(result.total).toBe(2);
    expect(result.imported).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(idMap.size).toBe(2);
    expect(idMap.has(1)).toBe(true);
    expect(idMap.has(2)).toBe(true);
  });

  it("generates SQL with INSERT INTO repositories", async () => {
    const { importRepositories } = await import("../../scripts/commands/repositories");
    const fixturePath = path.resolve("tests/import/fixtures/repositories.json");
    const { result } = await importRepositories(fixturePath);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    expect(content).toContain("INSERT INTO repositories");
    expect(content).toContain("AHRB");
    expect(content).toContain("AGN");
  });
});
