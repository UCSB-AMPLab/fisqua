/**
 * Tests — vocabulary terms
 *
 * @version v0.3.0
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { importVocabularyTerms } from "../../scripts/commands/vocabulary-terms";

describe("importVocabularyTerms", () => {
  let tmpDir: string;
  let inputPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vocab-test-"));
    inputPath = path.join(tmpDir, "canonical_functions_v2.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const mockData = {
    "1er Comandante": {
      canonical: "Primer comandante",
      category: "military_rank",
      entity_count: 1,
      source: "pattern_match",
    },
    "1er. Cmte.": {
      canonical: "Primer comandante",
      category: "military_rank",
      entity_count: 3,
      source: "agent",
    },
    "Doctor": {
      canonical: "Doctor",
      category: "honorific",
      entity_count: 50,
      source: "deterministic",
    },
    "Dr.": {
      canonical: "Doctor",
      category: "honorific",
      entity_count: 20,
      source: "deterministic",
    },
    Alcalde: {
      canonical: "Alcalde",
      category: "civil_office",
      entity_count: 10,
      source: "deterministic",
    },
    "Gobernador y Capitán General": {
      canonical: null,
      canonical_parts: [
        { canonical: "Gobernador" },
        { canonical: "Capitán general" },
      ],
      category: null,
      entity_count: 5,
      source: "agent",
    },
    Escribano: {
      canonical: "Escribano",
      category: "documentary_role",
      entity_count: 15,
      source: "deterministic",
    },
  };

  it("deduplicates entries by canonical form and sums entity counts", async () => {
    await fs.writeFile(inputPath, JSON.stringify(mockData), "utf8");
    const result = await importVocabularyTerms(inputPath, tmpDir);

    // 7 input entries, 4 distinct canonicals (Primer comandante, Doctor, Alcalde, Escribano)
    // "Gobernador y Capitán General" has null canonical — skipped
    expect(result.total).toBe(7);
    expect(result.imported).toBe(4);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("generates lookup map with lowercased keys for all input strings", async () => {
    await fs.writeFile(inputPath, JSON.stringify(mockData), "utf8");
    await importVocabularyTerms(inputPath, tmpDir);

    const lookupRaw = await fs.readFile(
      path.join(tmpDir, "vocabulary-term-lookup.json"),
      "utf8"
    );
    const lookup = JSON.parse(lookupRaw) as Record<string, string | null>;

    // All 7 input strings present as lowercased keys
    expect(Object.keys(lookup)).toHaveLength(7);
    expect(lookup["1er comandante"]).toBeDefined();
    expect(lookup["1er. cmte."]).toBeDefined();
    expect(lookup["doctor"]).toBeDefined();
    expect(lookup["dr."]).toBeDefined();
    expect(lookup["alcalde"]).toBeDefined();
    expect(lookup["escribano"]).toBeDefined();

    // Duplicates map to the same UUID
    expect(lookup["1er comandante"]).toBe(lookup["1er. cmte."]);
    expect(lookup["doctor"]).toBe(lookup["dr."]);

    // Null-canonical entry maps to null
    expect(lookup["gobernador y capitán general"]).toBeNull();
  });

  it("generates batched INSERT SQL with batch size 100", async () => {
    await fs.writeFile(inputPath, JSON.stringify(mockData), "utf8");
    const result = await importVocabularyTerms(inputPath, tmpDir);

    // With 4 rows and batch size 100, one SQL file with one INSERT statement
    const sqlFiles = result.sqlFiles.filter((f) => f.endsWith(".sql"));
    expect(sqlFiles).toHaveLength(1);

    const sqlContent = await fs.readFile(sqlFiles[0], "utf8");
    expect(sqlContent).toContain("INSERT INTO vocabulary_terms");
    expect(sqlContent).toContain("Primer comandante");
    expect(sqlContent).toContain("Doctor");
    expect(sqlContent).toContain("Alcalde");
    expect(sqlContent).toContain("Escribano");

    // Summed entity counts: Primer comandante = 1+3 = 4
    expect(sqlContent).toContain("4"); // entity_count for Primer comandante
  });

  it("sums entity counts correctly for deduplicated canonicals", async () => {
    await fs.writeFile(inputPath, JSON.stringify(mockData), "utf8");
    await importVocabularyTerms(inputPath, tmpDir);

    const lookupRaw = await fs.readFile(
      path.join(tmpDir, "vocabulary-term-lookup.json"),
      "utf8"
    );
    const lookup = JSON.parse(lookupRaw) as Record<string, string | null>;

    // Verify Doctor and Dr. point to the same UUID (entity_count = 50 + 20 = 70)
    const doctorId = lookup["doctor"];
    const drId = lookup["dr."];
    expect(doctorId).toBe(drId);
    expect(doctorId).not.toBeNull();
  });

  it("handles empty input file", async () => {
    await fs.writeFile(inputPath, JSON.stringify({}), "utf8");
    const result = await importVocabularyTerms(inputPath, tmpDir);

    expect(result.total).toBe(0);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
  });
});
