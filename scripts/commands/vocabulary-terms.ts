import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ImportResult } from "../lib/types";
import { escapeSql, generateInserts, writeSqlFiles } from "../lib/sql";

/**
 * Shape of each entry in canonical_functions_v2.json.
 * Keys are the original (raw) function strings; values describe the
 * canonical form, category, entity count, and resolution source.
 */
interface CanonicalFunctionEntry {
  canonical: string | null;
  canonical_parts?: { canonical: string }[];
  category: string | null;
  entity_count: number;
  source: string;
}

/** Intermediate record for a deduplicated canonical term */
interface TermRecord {
  id: string;
  canonical: string;
  category: string | null;
  entityCount: number;
}

const COLUMNS = [
  "id", "canonical", "category", "status", "merged_into",
  "entity_count", "proposed_by", "reviewed_by", "reviewed_at",
  "notes", "created_at", "updated_at",
];

/**
 * Import vocabulary terms from canonical_functions_v2.json.
 *
 * Deduplicates entries by canonical form — the JSON has ~27,695 input strings
 * mapping to ~16,185 distinct canonicals. Entries with null canonical are
 * skipped from the vocabulary_terms table but still appear in the lookup map
 * (mapped to null) so the migration script can handle them.
 *
 * Also generates a lookup map JSON file (.import/vocabulary-term-lookup.json)
 * mapping every input string (lowercased) to the generated term UUID.
 */
export async function importVocabularyTerms(
  inputPath: string,
  outputDir = ".import"
): Promise<ImportResult> {
  const raw = await fs.readFile(inputPath, "utf8");
  const data = JSON.parse(raw) as Record<string, CanonicalFunctionEntry>;

  const now = Math.floor(Date.now() / 1000);

  // Deduplicate by canonical form
  const termsByCanonical = new Map<string, TermRecord>();
  // Lookup map: lowercased original string -> term UUID (or null for unresolved)
  const lookupMap: Record<string, string | null> = {};

  let totalEntries = 0;
  let skippedNull = 0;

  for (const [originalKey, entry] of Object.entries(data)) {
    totalEntries++;
    const lowerKey = originalKey.toLowerCase();

    if (entry.canonical === null) {
      // Compound or unresolved function — skip from vocabulary_terms
      lookupMap[lowerKey] = null;
      skippedNull++;
      continue;
    }

    const canonical = entry.canonical;
    const canonicalLower = canonical.toLowerCase();

    let term = termsByCanonical.get(canonicalLower);
    if (!term) {
      term = {
        id: crypto.randomUUID(),
        canonical,
        category: entry.category,
        entityCount: 0,
      };
      termsByCanonical.set(canonicalLower, term);
    }

    // Sum entity counts across all entries sharing the same canonical
    term.entityCount += entry.entity_count;

    // Map this input string to the term's UUID
    lookupMap[lowerKey] = term.id;
  }

  // Build SQL rows
  const rows: string[][] = [];
  for (const term of termsByCanonical.values()) {
    rows.push([
      escapeSql(term.id),
      escapeSql(term.canonical),
      escapeSql(term.category),
      escapeSql("approved"),
      escapeSql(null), // merged_into
      escapeSql(term.entityCount),
      escapeSql(null), // proposed_by
      escapeSql(null), // reviewed_by
      escapeSql(null), // reviewed_at
      escapeSql(null), // notes
      escapeSql(now),
      escapeSql(now),
    ]);
  }

  const statements = generateInserts("vocabulary_terms", COLUMNS, rows, 100);
  const sqlFiles = await writeSqlFiles("vocabulary_terms", statements, 50, outputDir);

  // Write lookup map
  const lookupPath = path.join(outputDir, "vocabulary-term-lookup.json");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(lookupPath, JSON.stringify(lookupMap, null, 2), "utf8");

  return {
    table: "vocabulary_terms",
    total: totalEntries,
    imported: termsByCanonical.size,
    skipped: skippedNull,
    errors: [],
    sqlFiles: [...sqlFiles, lookupPath],
  };
}
