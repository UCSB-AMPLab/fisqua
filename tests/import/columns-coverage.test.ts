/**
 * Tests — columns coverage
 *
 * This suite is the meta-grep keystone for the import row-builders: every
 * `scripts/commands/<table>.ts` carries a `COLUMNS` array literal
 * that MUST match the column declarations on the matching
 * `sqliteTable(...)` block in `app/db/schema.ts`. The v0.4 union
 * schema dropped `related_materials`, `legal_status`, and the seven
 * dead `places.*` columns and added `publication_title`, `fclass`,
 * `dbe_id`, `legacy_ids`, and the DACS/RAD-only fields; this test
 * pins the resulting COLUMNS-vs-schema parity.
 *
 * Approach mirrors `tests/i18n-coverage.test.ts` (the project's
 * only other meta-grep test): files load via Vite's
 * `import.meta.glob({ query: "?raw" })` so the assertion runs
 * against verbatim file contents, not a re-parsed AST. The COLUMNS
 * literals are simple arrays of double-quoted strings, and the
 * schema's column declarations follow the `text("col_name")` /
 * `integer("col_name")` (with optional `, { ... }` suffix) shape
 * used everywhere — both are stable enough for a regex-driven scan.
 *
 * The five tables in scope are the five tenanted domain tables (the
 * same set the cross-tenant keystone enforces) plus `entity_functions`
 * because it has its own command file:
 *
 *   - repositories
 *   - entities
 *   - places
 *   - descriptions
 *   - entity_functions
 *
 * The check is "every column the schema declares MUST appear in the
 * COLUMNS array". A COLUMNS array can carry extra entries that the
 * schema doesn't (e.g. for fields the row-builder writes through a
 * default), but the schema is the source of truth: a column declared
 * in `app/db/schema.ts` and missing from COLUMNS is a hard fail.
 *
 * @version v0.4.0
 */
import { describe, it, expect } from "vitest";

// Vite's `import.meta.glob({ query: "?raw" })` returns the verbatim
// source string for every match. Mirrors `tests/i18n-coverage.test.ts`
// (the only other meta-grep test in the project) and the
// `tests/db/cross-tenant-coverage.test.ts` keystone.
const schemaFiles = import.meta.glob("../../app/db/schema.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const commandFiles = import.meta.glob("../../scripts/commands/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

interface CommandSpec {
  table: string;
  // suffix of the path key in commandFiles
  commandSuffix: string;
}

const COMMANDS: CommandSpec[] = [
  { table: "repositories", commandSuffix: "repositories.ts" },
  { table: "entities", commandSuffix: "entities.ts" },
  { table: "places", commandSuffix: "places.ts" },
  { table: "descriptions", commandSuffix: "descriptions.ts" },
  { table: "entity_functions", commandSuffix: "entity-functions.ts" },
];

/**
 * Extract the column names declared on a sqliteTable("<table>", ...)
 * block. Walks forward from the opening paren until paren depth
 * returns to zero, capturing every `text("col")` / `integer("col")` /
 * `real("col")` invocation.
 */
function extractSchemaColumns(source: string, tableName: string): string[] {
  const startMatch = source.match(
    new RegExp(`sqliteTable\\(\\s*"${tableName}"`, "m"),
  );
  if (!startMatch || startMatch.index === undefined) {
    throw new Error(
      `sqliteTable("${tableName}", ...) declaration not found in schema`,
    );
  }
  let depth = 0;
  let started = false;
  let endIndex = -1;
  for (let i = startMatch.index; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") {
      depth++;
      started = true;
    } else if (ch === ")") {
      depth--;
      if (started && depth === 0) {
        endIndex = i;
        break;
      }
    }
  }
  if (endIndex === -1) {
    throw new Error(`unterminated sqliteTable("${tableName}", ...) block`);
  }
  const block = source.slice(startMatch.index, endIndex + 1);
  const cols = new Set<string>();
  const colRegex = /\b(?:text|integer|real|blob)\(\s*"([a-z0-9_]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = colRegex.exec(block)) !== null) {
    cols.add(m[1]);
  }
  return Array.from(cols);
}

/**
 * Extract the COLUMNS array literal contents from a command file.
 * Looks for `COLUMNS = [ ... ]` and pulls every double-quoted
 * identifier inside the brackets.
 */
function extractCommandColumns(source: string): string[] {
  const start = source.indexOf("COLUMNS");
  if (start === -1) {
    throw new Error("COLUMNS literal not found in command file");
  }
  const openBracket = source.indexOf("[", start);
  if (openBracket === -1) {
    throw new Error("COLUMNS array open bracket not found");
  }
  let depth = 0;
  let endIndex = -1;
  for (let i = openBracket; i < source.length; i++) {
    const ch = source[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        endIndex = i;
        break;
      }
    }
  }
  if (endIndex === -1) {
    throw new Error("unterminated COLUMNS array literal");
  }
  const body = source.slice(openBracket + 1, endIndex);
  const cols: string[] = [];
  const idRegex = /"([a-z0-9_]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = idRegex.exec(body)) !== null) {
    cols.push(m[1]);
  }
  return cols;
}

function findCommandSource(suffix: string): string {
  for (const [key, value] of Object.entries(commandFiles)) {
    if (key.endsWith(suffix)) return value;
  }
  throw new Error(`command file matching suffix "${suffix}" not found`);
}

function getSchemaSource(): string {
  const entries = Object.values(schemaFiles);
  if (entries.length === 0) throw new Error("schema.ts not loaded");
  return entries[0];
}

describe("columns coverage — schema vs scripts/commands COLUMNS arrays", () => {
  for (const spec of COMMANDS) {
    it(`${spec.table}: every schema column appears in COLUMNS`, () => {
      const schemaSource = getSchemaSource();
      const commandSource = findCommandSource(spec.commandSuffix);
      const schemaCols = extractSchemaColumns(schemaSource, spec.table);
      const commandCols = extractCommandColumns(commandSource);
      const missing = schemaCols.filter((c) => !commandCols.includes(c));
      expect(
        missing,
        `\n  table: ${spec.table}\n  missing from COLUMNS: ${missing.join(", ")}\n  schema cols (${schemaCols.length}): ${schemaCols.join(", ")}\n  COLUMNS (${commandCols.length}): ${commandCols.join(", ")}\n`,
      ).toEqual([]);
    });
  }
});

// Version: v0.4.0
