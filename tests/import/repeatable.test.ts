/**
 * Tests — repeatable
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

describe("generateClearSql", () => {
  beforeEach(cleanOutput);
  afterEach(cleanOutput);

  it("produces DELETE statements in reverse FK order", async () => {
    const { generateClearSql } = await import(
      "../../scripts/commands/clear"
    );

    const sqlFiles = await generateClearSql();

    expect(sqlFiles.length).toBeGreaterThan(0);
    const content = await fs.readFile(sqlFiles[0], "utf8");

    // Verify reverse FK order: junctions first, then leaf tables, then root tables
    const dpIdx = content.indexOf("DELETE FROM description_places");
    const deIdx = content.indexOf("DELETE FROM description_entities");
    const efIdx = content.indexOf("DELETE FROM entity_functions");
    const dIdx = content.indexOf("DELETE FROM descriptions");
    const pIdx = content.indexOf("DELETE FROM places");
    const eIdx = content.indexOf("DELETE FROM entities");
    const rIdx = content.indexOf("DELETE FROM repositories");

    // All should be present
    expect(dpIdx).toBeGreaterThanOrEqual(0);
    expect(deIdx).toBeGreaterThanOrEqual(0);
    expect(efIdx).toBeGreaterThanOrEqual(0);
    expect(dIdx).toBeGreaterThanOrEqual(0);
    expect(pIdx).toBeGreaterThanOrEqual(0);
    expect(eIdx).toBeGreaterThanOrEqual(0);
    expect(rIdx).toBeGreaterThanOrEqual(0);

    // Order: description_places before descriptions
    expect(dpIdx).toBeLessThan(dIdx);
    // description_entities before descriptions
    expect(deIdx).toBeLessThan(dIdx);
    // entity_functions before entities
    expect(efIdx).toBeLessThan(eIdx);
    // descriptions before repositories
    expect(dIdx).toBeLessThan(rIdx);
    // entities before repositories (or at least after descriptions)
    expect(eIdx).toBeLessThan(rIdx);
    // places before repositories (or at least after descriptions)
    expect(pIdx).toBeLessThan(rIdx);
  });

  it("includes PRAGMA defer_foreign_keys", async () => {
    const { generateClearSql } = await import(
      "../../scripts/commands/clear"
    );

    const sqlFiles = await generateClearSql();
    const content = await fs.readFile(sqlFiles[0], "utf8");

    expect(content).toContain("PRAGMA defer_foreign_keys = true");
  });
});

describe("generateFtsRebuild", () => {
  beforeEach(cleanOutput);
  afterEach(cleanOutput);

  it("produces rebuild commands for entities_fts and places_fts", async () => {
    const { generateFtsRebuild } = await import(
      "../../scripts/commands/clear"
    );

    const sqlFiles = await generateFtsRebuild();

    expect(sqlFiles.length).toBeGreaterThan(0);
    const content = await fs.readFile(sqlFiles[0], "utf8");

    expect(content).toContain(
      "INSERT INTO entities_fts(entities_fts) VALUES('rebuild')"
    );
    expect(content).toContain(
      "INSERT INTO places_fts(places_fts) VALUES('rebuild')"
    );
  });
});

describe("importDescriptionEntities", () => {
  beforeEach(cleanOutput);
  afterEach(cleanOutput);

  it("resolves both description and entity FKs via IdMaps", async () => {
    const { importDescriptionEntities } = await import(
      "../../scripts/commands/junctions"
    );
    const type = await import("../../scripts/lib/types");

    // Build mock IdMaps matching fixture data
    const descIdMap: InstanceType<typeof Map<number, string>> = new Map([
      [400, "desc-uuid-400"],
      [405, "desc-uuid-405"],
    ]);
    const entityIdMap: InstanceType<typeof Map<number, string>> = new Map([
      [101, "entity-uuid-101"],
      [102, "entity-uuid-102"],
      [104, "entity-uuid-104"],
    ]);

    const fixturePath = path.resolve(
      "tests/import/fixtures/description_entities.json"
    );
    const result = await importDescriptionEntities(
      fixturePath,
      descIdMap,
      entityIdMap
    );

    expect(result.table).toBe("description_entities");
    expect(result.total).toBe(3);
    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify SQL was generated
    expect(result.sqlFiles.length).toBeGreaterThan(0);
    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    expect(content).toContain("INSERT INTO description_entities");
    expect(content).toContain("desc-uuid-405");
    expect(content).toContain("entity-uuid-102");
  });

  it("skips rows with missing FK references and reports errors", async () => {
    const { importDescriptionEntities } = await import(
      "../../scripts/commands/junctions"
    );

    // Partial IdMaps -- missing entity 104
    const descIdMap = new Map<number, string>([
      [400, "desc-uuid-400"],
      [405, "desc-uuid-405"],
    ]);
    const entityIdMap = new Map<number, string>([
      [101, "entity-uuid-101"],
      [102, "entity-uuid-102"],
      // 104 is missing
    ]);

    const fixturePath = path.resolve(
      "tests/import/fixtures/description_entities.json"
    );
    const result = await importDescriptionEntities(
      fixturePath,
      descIdMap,
      entityIdMap
    );

    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].errors[0]).toContain("entity_id");
  });
});

describe("importDescriptionPlaces", () => {
  beforeEach(cleanOutput);
  afterEach(cleanOutput);

  it("resolves both description and place FKs via IdMaps", async () => {
    const { importDescriptionPlaces } = await import(
      "../../scripts/commands/junctions"
    );

    const descIdMap = new Map<number, string>([
      [405, "desc-uuid-405"],
    ]);
    const placeIdMap = new Map<number, string>([
      [202, "place-uuid-202"],
      [203, "place-uuid-203"],
    ]);

    const fixturePath = path.resolve(
      "tests/import/fixtures/description_places.json"
    );
    const result = await importDescriptionPlaces(
      fixturePath,
      descIdMap,
      placeIdMap
    );

    expect(result.table).toBe("description_places");
    expect(result.total).toBe(2);
    expect(result.imported).toBe(2);
    expect(result.errors).toHaveLength(0);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    expect(content).toContain("INSERT INTO description_places");
    expect(content).toContain("desc-uuid-405");
    expect(content).toContain("place-uuid-202");
  });
});
