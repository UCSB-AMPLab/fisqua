/**
 * Tests — helpers for the place suites of the command line's authority changes
 *
 * This module holds what `authorities-cli-places.test.ts` and
 * `authorities-cli-places-proof.test.ts` share: the in-memory SQLite
 * schema with the tables and columns the engine reads and writes
 * (foreign keys on, D1's expression depth limit of 100), the CSV writer
 * for a change file, and `runFile`, which runs `runAuthorities` against
 * a database and applies the SQL file it writes as one unit, as
 * `wrangler d1 execute --file` applies it. Nothing here reaches D1.
 *
 * @version v0.9.0
 */
import { DatabaseSync } from "node:sqlite";
import { parseChangeFile } from "../../scripts/lib/authorities-cli/change-file";
import { runAuthorities, type AuthoritiesReport } from "../../scripts/lib/authorities-cli/run";
import { d1Read } from "./d1-limits";

export const D1_LIMITS = { limits: { exprDepth: 100 } } as unknown as ConstructorParameters<typeof DatabaseSync>[1];

export const PLACES_DDL = `
PRAGMA foreign_keys = ON;
CREATE TABLE federations (id TEXT PRIMARY KEY, slug TEXT, status TEXT, lead_tenant_id TEXT, shared_authorities_enabled INTEGER,
  entity_code_prefix TEXT, place_code_prefix TEXT);
CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, federation_id TEXT, disabled_at INTEGER, authorities_enabled INTEGER,
  entity_code_prefix TEXT, place_code_prefix TEXT);
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, tenant_id TEXT, is_admin INTEGER DEFAULT 0, is_super_admin INTEGER DEFAULT 0,
  is_records_admin INTEGER DEFAULT 0, is_authorities_admin INTEGER DEFAULT 0, is_imports_admin INTEGER DEFAULT 0,
  is_digitization_admin INTEGER DEFAULT 0);
CREATE TABLE federation_memberships (id TEXT PRIMARY KEY, user_id TEXT, federation_id TEXT, role TEXT);
CREATE TABLE descriptions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, reference_code TEXT);
CREATE TABLE vocabulary_terms (id TEXT PRIMARY KEY, federation_id TEXT, canonical TEXT, merged_into TEXT, entity_count INTEGER DEFAULT 0,
  updated_at INTEGER);
CREATE TABLE vocabulary_values (id TEXT PRIMARY KEY NOT NULL, federation_id TEXT NOT NULL, list TEXT NOT NULL, code TEXT NOT NULL,
  label_es TEXT, label_en TEXT, group_code TEXT, position INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'approved',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, inverse_code TEXT);
CREATE UNIQUE INDEX vocabulary_values_federation_list_code_idx ON vocabulary_values (federation_id, list, code);
CREATE TABLE entities (id TEXT PRIMARY KEY, federation_id TEXT NOT NULL, tenant_id TEXT, entity_code TEXT, display_name TEXT NOT NULL,
  sort_name TEXT NOT NULL, surname TEXT, given_name TEXT, entity_type TEXT NOT NULL, honorific TEXT, primary_function TEXT,
  primary_function_id TEXT, name_variants TEXT DEFAULT '[]', dates_of_existence TEXT, date_start TEXT, date_end TEXT, history TEXT,
  functions TEXT, sources TEXT, merged_into TEXT, wikidata_id TEXT, viaf_id TEXT, dbe_id TEXT, legacy_ids TEXT NOT NULL DEFAULT '[]',
  notes TEXT, internal_notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, gender TEXT,
  known_only_from_relation INTEGER NOT NULL DEFAULT 0, qualified_name TEXT, name_key TEXT);
CREATE UNIQUE INDEX entity_code_idx ON entities (federation_id, entity_code);
CREATE TABLE places (id TEXT PRIMARY KEY, federation_id TEXT NOT NULL, tenant_id TEXT, place_code TEXT, label TEXT NOT NULL,
  display_name TEXT NOT NULL, place_type TEXT, name_variants TEXT DEFAULT '[]', parent_id TEXT, latitude REAL, longitude REAL,
  coordinate_precision TEXT, merged_into TEXT, tgn_id TEXT, hgis_id TEXT, whg_id TEXT,
  fclass TEXT CHECK (fclass IS NULL OR fclass IN ('P','H','A','T','S')), legacy_ids TEXT NOT NULL DEFAULT '[]', notes TEXT,
  internal_notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX place_code_idx ON places (federation_id, place_code);
CREATE TABLE description_entities (id TEXT PRIMARY KEY, description_id TEXT NOT NULL REFERENCES descriptions(id),
  entity_id TEXT NOT NULL REFERENCES entities(id), role TEXT NOT NULL,
  role_note TEXT, role_raw TEXT, sequence INTEGER NOT NULL DEFAULT 0, honorific TEXT, name_as_recorded TEXT,
  created_at INTEGER NOT NULL, related_to TEXT REFERENCES description_entities(id) ON DELETE NO ACTION,
  relation_certainty TEXT CHECK (relation_certainty IS NULL OR relation_certainty IN ('doubtful','inferred','derived')),
  attributes TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes) AND json_type(attributes) = 'object'));
CREATE UNIQUE INDEX de_unique_idx ON description_entities (description_id, entity_id, role, COALESCE(related_to, ''));
CREATE TABLE description_places (id TEXT PRIMARY KEY, description_id TEXT NOT NULL REFERENCES descriptions(id),
  place_id TEXT NOT NULL REFERENCES places(id), role TEXT NOT NULL, role_note TEXT, role_raw TEXT, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX dp_unique_idx ON description_places (description_id, place_id, role);
CREATE TABLE entity_functions (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, honorific TEXT, function TEXT NOT NULL, date_start TEXT,
  date_end TEXT, date_note TEXT, certainty TEXT DEFAULT 'probable', source TEXT, notes TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
CREATE TABLE changelog (id TEXT PRIMARY KEY, record_id TEXT NOT NULL, record_type TEXT NOT NULL, user_id TEXT NOT NULL, note TEXT,
  diff TEXT NOT NULL, run_id TEXT, kind TEXT NOT NULL DEFAULT 'update', created_at INTEGER NOT NULL, acted_as TEXT);
CREATE TABLE authority_operations (id TEXT PRIMARY KEY, federation_id TEXT NOT NULL, record_type TEXT NOT NULL, operation TEXT NOT NULL,
  source_id TEXT NOT NULL, target_id TEXT, user_id TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
`;

type Cells = Record<string, string>;

/** A change file's text: the header, then each row's cells in its order. */
export const csvOf = (header: string[], rows: Cells[]) =>
  [header.join(","), ...rows.map((r) => header.map((h) => {
    const v = r[h] ?? "";
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(","))].join("\n") + "\n";

/** Applies the statements as one unit: all of them or none. */
export function applyAsOneUnit(db: DatabaseSync, statements: string[]): void {
  db.exec("BEGIN");
  try {
    db.exec(statements.join("\n"));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface RunOptions {
  apply?: boolean;
  now?: number;
  header?: string[];
  file?: string;
  email?: string;
  tenant?: string;
  /** Called with the database just before the SQL file is applied. */
  beforeApply?: (db: DatabaseSync) => void;
}

/** Runs a change file against the database, as `staging`. */
export async function runFile(
  db: DatabaseSync,
  rows: Cells[],
  opts: RunOptions & { header: string[]; file: string; now: number },
): Promise<{ report: AuthoritiesReport; applied: string[][]; written: Map<string, string> }> {
  const written = new Map<string, string>();
  const applied: string[][] = [];
  let n = 0;
  const report = await runAuthorities(
    { file: opts.file, rows: parseChangeFile(csvOf(opts.header, rows), opts.file) },
    {
      target: "staging", tenant: opts.tenant ?? "neogranadina", actorEmail: opts.email ?? "admin@example.org", apply: opts.apply ?? false,
      confirmProduction: false,
    },
    {
      rows: async (sql) => d1Read(db, sql),
      writeFile: (p, t) => written.set(p, t),
      createFile: (p, t) => {
        if (written.has(p)) throw new Error(`EEXIST: ${p}`);
        written.set(p, t);
      },
      readFile: (p) => written.get(p) ?? "",
      newId: () => `0f1e2d3c-0000-4000-8000-${String(++n).padStart(12, "0")}`,
      applyFile: (_p, statements) => {
        applied.push(statements);
        opts.beforeApply?.(db);
        applyAsOneUnit(db, statements);
      },
      now: () => opts.now,
    },
    () => {},
  );
  return { report, applied, written };
}

// @version v0.9.0
