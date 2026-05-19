/**
 * Tests — FTS rebuild
 *
 * This suite asserts that `generateFtsRebuild()` emits all THREE FTS rebuild
 * lines. An earlier version of the function rebuilt only
 * `entities_fts` and `places_fts`; the v0.4 union schema also uses
 * `descriptions_fts`, and forgetting to rebuild it after a
 * clear-and-reimport leaves search broken until the next row write
 * touches the FTS triggers. The current implementation rebuilds all
 * three FTS5 tables.
 *
 * @version v0.4.0
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";

const OUTPUT_DIR = ".import";
async function cleanOutput() {
  try {
    await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe("generateFtsRebuild — all three FTS tables", () => {
  beforeEach(cleanOutput);
  afterEach(cleanOutput);

  it("emits a rebuild line for entities_fts", async () => {
    const { generateFtsRebuild } = await import(
      "../../scripts/commands/clear"
    );
    const sqlFiles = await generateFtsRebuild();
    const content = await fs.readFile(sqlFiles[0], "utf8");
    expect(content).toContain(
      "INSERT INTO entities_fts(entities_fts) VALUES('rebuild')",
    );
  });

  it("emits a rebuild line for places_fts", async () => {
    const { generateFtsRebuild } = await import(
      "../../scripts/commands/clear"
    );
    const sqlFiles = await generateFtsRebuild();
    const content = await fs.readFile(sqlFiles[0], "utf8");
    expect(content).toContain(
      "INSERT INTO places_fts(places_fts) VALUES('rebuild')",
    );
  });

  it("emits a rebuild line for descriptions_fts", async () => {
    const { generateFtsRebuild } = await import(
      "../../scripts/commands/clear"
    );
    const sqlFiles = await generateFtsRebuild();
    const content = await fs.readFile(sqlFiles[0], "utf8");
    // descriptions_fts is now part of the rebuild list.
    expect(content).toContain(
      "INSERT INTO descriptions_fts(descriptions_fts) VALUES('rebuild')",
    );
  });
});

// Version: v0.4.0
