/**
 * Tests — the descriptions table of the command line's description suites
 *
 * This module gives the description suites of the command line
 * (`descriptions-cli.test.ts`, `descriptions-cli-create.test.ts`) the
 * `descriptions` table they run the command against, in an in-memory
 * `node:sqlite` database. The table has every column of the app's schema
 * (`app/db/schema.ts`), its defaults and the per-tenant unique index on
 * the reference code, so the command reads and writes the columns D1
 * holds. The NOT NULL constraints are those of the schema for the columns
 * a seed always gives (`REQUIRED`) and for the columns with a default;
 * `repository_id` and `created_at`, NOT NULL in D1, are left nullable so a
 * seed of the update suite need not give them.
 *
 * @version v0.9.0
 */

import { getTableColumns } from "drizzle-orm";
import { descriptions } from "../../app/db/schema";

/** The columns every seed gives, NOT NULL as in D1. */
const REQUIRED = new Set(["tenant_id", "reference_code", "description_level", "title", "updated_at"]);

const literal = (v: unknown) => (typeof v === "boolean" ? (v ? "1" : "0") : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/** `CREATE TABLE descriptions …` and its unique index, from the app's schema. */
export function descriptionsDdl(): string {
  const columns = Object.values(getTableColumns(descriptions)).map((c) => {
    const col = c as unknown as { name: string; columnType: string; notNull: boolean; hasDefault: boolean; default: unknown };
    const type = col.columnType === "SQLiteText" ? "TEXT" : "INTEGER";
    if (col.name === "id") return "id TEXT PRIMARY KEY";
    const notNull = REQUIRED.has(col.name) || (col.notNull && col.hasDefault) ? " NOT NULL" : "";
    const dflt = col.hasDefault && col.default !== undefined ? ` DEFAULT ${literal(col.default)}` : "";
    return `${col.name} ${type}${notNull}${dflt}`;
  });
  return `CREATE TABLE descriptions (${columns.join(", ")});\nCREATE UNIQUE INDEX desc_ref_code_idx ON descriptions (tenant_id, reference_code);\n`;
}

// @version v0.9.0
