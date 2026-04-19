/**
 * Tests — place import
 *
 * @version v0.3.0
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { IdMap } from "../../scripts/lib/types";

const OUTPUT_DIR = ".import";

async function cleanOutput() {
  try {
    await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe("importPlaces", () => {
  beforeEach(cleanOutput);
  afterEach(cleanOutput);

  it("returns correct row count and IdMap for all input records", async () => {
    const { importPlaces } = await import("../../scripts/commands/places");
    const fixturePath = path.resolve("tests/import/fixtures/places.json");
    const { result, idMap } = await importPlaces(fixturePath);

    expect(result.table).toBe("places");
    expect(result.total).toBe(4);
    expect(result.imported).toBe(4);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(idMap.size).toBe(4);
  });

  it("resolves parent_id to UUID (not original integer)", async () => {
    const { importPlaces } = await import("../../scripts/commands/places");
    const fixturePath = path.resolve("tests/import/fixtures/places.json");
    const { result, idMap } = await importPlaces(fixturePath);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    // Boyaca (id=201) has parent_id=200, so its parent should be Colombia's UUID
    const colombiaUuid = idMap.get(200)!;
    expect(content).toContain(colombiaUuid);
  });

  it("root place has parent_id = NULL in SQL", async () => {
    const { importPlaces } = await import("../../scripts/commands/places");
    const fixturePath = path.resolve("tests/import/fixtures/places.json");
    const { result } = await importPlaces(fixturePath);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    // Colombia (id=200) has parent_id=null, so SQL should contain NULL for it
    expect(content).toContain("NULL");
  });

  it("place_code values match /^nl-[a-z2-9]{6}$/", async () => {
    const { importPlaces } = await import("../../scripts/commands/places");
    const fixturePath = path.resolve("tests/import/fixtures/places.json");
    const { result } = await importPlaces(fixturePath);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    const codePattern = /nl-[a-z2-9]{6}/g;
    const codes = content.match(codePattern);
    expect(codes).not.toBeNull();
    expect(codes!.length).toBe(4);
    const unique = new Set(codes);
    expect(unique.size).toBe(4);
  });

  it("renames colonial_* fields to historical_* in SQL output", async () => {
    const { importPlaces } = await import("../../scripts/commands/places");
    const fixturePath = path.resolve("tests/import/fixtures/places.json");
    const { result } = await importPlaces(fixturePath);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    // SQL column names should be historical_*, not colonial_*
    expect(content).toContain("historical_gobernacion");
    expect(content).toContain("historical_partido");
    expect(content).toContain("historical_region");
    expect(content).not.toContain("colonial_gobernacion");
    expect(content).not.toContain("colonial_partido");
    expect(content).not.toContain("colonial_region");
    // Tunja (id=202) has colonial_gobernacion="Tunja" — should appear as value
    expect(content).toContain("Tunja");
  });

  it("handles needs_geocoding as boolean -> integer", async () => {
    const { importPlaces } = await import("../../scripts/commands/places");
    const fixturePath = path.resolve("tests/import/fixtures/places.json");
    const { result } = await importPlaces(fixturePath);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    // needs_geocoding should be 0 or 1, not true/false strings
    expect(content).not.toContain("'true'");
    expect(content).not.toContain("'false'");
  });
});

describe("importEntityFunctions", () => {
  beforeEach(cleanOutput);
  afterEach(cleanOutput);

  it("resolves entity_id FK via entity IdMap", async () => {
    const { importEntityFunctions } = await import(
      "../../scripts/commands/entity-functions"
    );
    const fixturePath = path.resolve(
      "tests/import/fixtures/entity_functions.json"
    );

    // Build a mock entity IdMap
    const entityIdMap: IdMap = new Map([
      [100, "aaaaaaaa-0000-0000-0000-000000000100"],
      [101, "aaaaaaaa-0000-0000-0000-000000000101"],
    ]);

    const result = await importEntityFunctions(fixturePath, entityIdMap);

    expect(result.table).toBe("entity_functions");
    expect(result.total).toBe(3);
    expect(result.imported).toBe(3);
    expect(result.errors).toHaveLength(0);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    expect(content).toContain("aaaaaaaa-0000-0000-0000-000000000100");
    expect(content).toContain("aaaaaaaa-0000-0000-0000-000000000101");
  });

  it("missing entity_id reference produces error (not crash)", async () => {
    const { importEntityFunctions } = await import(
      "../../scripts/commands/entity-functions"
    );
    const fixturePath = path.resolve(
      "tests/import/fixtures/entity_functions.json"
    );

    // IdMap only has entity 100, not 101
    const entityIdMap: IdMap = new Map([
      [100, "aaaaaaaa-0000-0000-0000-000000000100"],
    ]);

    const result = await importEntityFunctions(fixturePath, entityIdMap);

    // Entity 100 has 2 functions (rows 0,1), entity 101 has 1 function (row 2)
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].errors[0]).toContain("entity_id");
  });

  it("generates SQL with INSERT INTO entity_functions", async () => {
    const { importEntityFunctions } = await import(
      "../../scripts/commands/entity-functions"
    );
    const fixturePath = path.resolve(
      "tests/import/fixtures/entity_functions.json"
    );
    const entityIdMap: IdMap = new Map([
      [100, "aaaaaaaa-0000-0000-0000-000000000100"],
      [101, "aaaaaaaa-0000-0000-0000-000000000101"],
    ]);

    const result = await importEntityFunctions(fixturePath, entityIdMap);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    expect(content).toContain("INSERT INTO entity_functions");
    expect(content).toContain("PRAGMA defer_foreign_keys = true");
  });
});
