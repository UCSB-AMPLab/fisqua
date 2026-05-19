-- Domain-table tenant_id rebuild: 5 sequential per-table 12-step rebuilds
--
-- This migration adds a NOT NULL FK column `tenant_id` referencing tenants(id)
-- ON DELETE RESTRICT to all 5 domain tables (users, repositories, descriptions,
-- entities, places). Every existing v0.3 row is back-filled to the
-- seeded `neogranadina` tenant inside the same INSERT...SELECT step.
--
-- SQLite cannot ALTER an existing column to NOT NULL without a table
-- rebuild. The recipe below is SQLite's canonical "Make Other Kinds Of
-- Table Schema Changes" recipe, adapted for one file with five rebuilds:
--
--   1. Defer FK enforcement to commit time via PRAGMA defer_foreign_keys=ON.
--      The original plan used PRAGMA foreign_keys=OFF, but SQLite silently
--      no-ops that PRAGMA when issued inside an active multi-statement
--      transaction -- and D1's migration runner wraps every file in a
--      Durable Object transaction. defer_foreign_keys, by contrast, IS
--      respected mid-transaction; it defers all FK checks until COMMIT,
--      auto-resets at transaction end, and lets the per-table DROP+RENAME
--      recipe complete even when dependent tables hold rows that reference
--      the parent being rebuilt (production scenario: users referenced by
--      magic_links/project_members/projects/volumes/qc_flags). At COMMIT,
--      since the rebuild preserves all referenced IDs, every FK still
--      resolves and the transaction lands cleanly.
--   2. For each table: CREATE _new; INSERT _new SELECT FROM old; DROP
--      old; ALTER _new RENAME; recreate indexes; recreate FTS5 triggers
--      if applicable; verify FK integrity inline.
--   3. (No explicit re-enable step needed -- defer_foreign_keys is per-
--      transaction and resets automatically at COMMIT/ROLLBACK.)
--
-- Note on transaction framing: D1's Durable-Object-backed migration
-- runner rejects explicit BEGIN/COMMIT and SAVEPOINT statements (the
-- runner wraps every migration file in its own DO transaction via
-- state.storage.transaction()). The plan originally prescribed per-
-- table BEGIN...COMMIT framing; under D1 the entire file is already a
-- single atomic unit, so a partial failure (e.g. on table 3) rolls
-- back tables 1 and 2 as well. This is *stronger* than per-table
-- commits for production -- there is no intermediate "two of five
-- rebuilt" state -- and `PRAGMA foreign_key_check` after each rebuild
-- still surfaces FK violations exactly as planned.
--
-- The back-fill literal is NEOGRANADINA_TENANT_ID from
-- app/lib/tenant.ts and must match byte-for-byte. It appears
-- exactly five times below (one per INSERT...SELECT back-fill).
--
-- ON DELETE RESTRICT is deliberate. Never CASCADE -- tenant
-- deletion must be a deliberate, audited operation that explicitly
-- handles the 106K+ child rows underneath, not a transitive consequence
-- of `DELETE FROM tenants`. v0.4 has soft-disable (status='suspended')
-- but no operator delete-tenant action.
--
-- FTS5 triggers on descriptions/entities/places are re-CREATED after
-- each rebuild because dropping the source table detaches them. The
-- trigger statements are verbatim from drizzle/0024 (descriptions) and
-- drizzle/0015 (entities, places). None of the five tables has any
-- index that references columns dropped or renamed by this migration,
-- so the indexed-column inventory is unchanged from v0.3.
--
-- Rebuild order: users -> repositories -> descriptions -> entities ->
-- places. This is independent of FK dependency direction (the only
-- inter-table FK among the five is descriptions -> repositories), but
-- we follow the table-cluster ordering in app/db/schema.ts so the
-- migration reads top-to-bottom alongside the schema declarations.
--
-- Version: v0.4.0

PRAGMA defer_foreign_keys=ON;

-- ============================================================================
-- Rebuild 1: users
-- ============================================================================

CREATE TABLE users_new (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_super_admin INTEGER NOT NULL DEFAULT 0,
  is_collab_admin INTEGER NOT NULL DEFAULT 0,
  is_archive_user INTEGER NOT NULL DEFAULT 0,
  is_user_manager INTEGER NOT NULL DEFAULT 0,
  is_cataloguer INTEGER NOT NULL DEFAULT 0,
  last_active_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  github_id TEXT UNIQUE
);

INSERT INTO users_new (
  id, tenant_id, email, name,
  is_admin, is_super_admin, is_collab_admin, is_archive_user, is_user_manager, is_cataloguer,
  last_active_at, created_at, updated_at, github_id
)
SELECT
  id, 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', email, name,
  is_admin, is_super_admin, is_collab_admin, is_archive_user, is_user_manager, is_cataloguer,
  last_active_at, created_at, updated_at, github_id
FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- (no extra indexes on users beyond UNIQUE email + UNIQUE github_id, both recreated by their column-level UNIQUE markers above)

PRAGMA foreign_key_check;
-- ============================================================================
-- Rebuild 2: repositories
-- ============================================================================

CREATE TABLE repositories_new (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  short_name TEXT,
  country_code TEXT DEFAULT 'COL',
  country TEXT,
  city TEXT,
  address TEXT,
  website TEXT,
  notes TEXT,
  rights_text TEXT,
  display_title TEXT,
  subtitle TEXT,
  hero_image_url TEXT,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO repositories_new (
  id, tenant_id, code, name, short_name,
  country_code, country, city, address, website,
  notes, rights_text, display_title, subtitle, hero_image_url,
  enabled, created_at, updated_at
)
SELECT
  id, 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', code, name, short_name,
  country_code, country, city, address, website,
  notes, rights_text, display_title, subtitle, hero_image_url,
  enabled, created_at, updated_at
FROM repositories;

DROP TABLE repositories;
ALTER TABLE repositories_new RENAME TO repositories;

CREATE UNIQUE INDEX IF NOT EXISTS repo_code_idx ON repositories(code);

PRAGMA foreign_key_check;
-- ============================================================================
-- Rebuild 3: descriptions
-- ============================================================================

CREATE TABLE descriptions_new (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
  parent_id TEXT,
  position INTEGER DEFAULT 0 NOT NULL,
  root_description_id TEXT,
  depth INTEGER DEFAULT 0 NOT NULL,
  child_count INTEGER DEFAULT 0 NOT NULL,
  path_cache TEXT DEFAULT '',
  description_level TEXT NOT NULL,
  resource_type TEXT,
  genre TEXT DEFAULT '[]',
  reference_code TEXT NOT NULL,
  local_identifier TEXT NOT NULL,
  title TEXT NOT NULL,
  translated_title TEXT,
  uniform_title TEXT,
  date_expression TEXT,
  date_start TEXT,
  date_end TEXT,
  date_certainty TEXT,
  extent TEXT,
  dimensions TEXT,
  medium TEXT,
  imprint TEXT,
  edition_statement TEXT,
  series_statement TEXT,
  volume_number TEXT,
  issue_number TEXT,
  pages TEXT,
  provenance TEXT,
  scope_content TEXT,
  ocr_text TEXT DEFAULT '',
  arrangement TEXT,
  access_conditions TEXT,
  reproduction_conditions TEXT,
  language TEXT,
  location_of_originals TEXT,
  location_of_copies TEXT,
  related_materials TEXT,
  finding_aids TEXT,
  section_title TEXT,
  notes TEXT,
  internal_notes TEXT,
  creator_display TEXT,
  place_display TEXT,
  iiif_manifest_url TEXT,
  has_digital INTEGER DEFAULT 0,
  is_published INTEGER DEFAULT 0,
  last_exported_at INTEGER,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO descriptions_new (
  id, tenant_id, repository_id,
  parent_id, position, root_description_id, depth, child_count, path_cache,
  description_level, resource_type, genre,
  reference_code, local_identifier, title, translated_title, uniform_title,
  date_expression, date_start, date_end, date_certainty,
  extent, dimensions, medium,
  imprint, edition_statement, series_statement, volume_number, issue_number, pages,
  provenance, scope_content, ocr_text, arrangement,
  access_conditions, reproduction_conditions, language,
  location_of_originals, location_of_copies, related_materials, finding_aids,
  section_title, notes, internal_notes,
  creator_display, place_display,
  iiif_manifest_url, has_digital, is_published, last_exported_at,
  created_by, updated_by, created_at, updated_at
)
SELECT
  id, 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', repository_id,
  parent_id, position, root_description_id, depth, child_count, path_cache,
  description_level, resource_type, genre,
  reference_code, local_identifier, title, translated_title, uniform_title,
  date_expression, date_start, date_end, date_certainty,
  extent, dimensions, medium,
  imprint, edition_statement, series_statement, volume_number, issue_number, pages,
  provenance, scope_content, ocr_text, arrangement,
  access_conditions, reproduction_conditions, language,
  location_of_originals, location_of_copies, related_materials, finding_aids,
  section_title, notes, internal_notes,
  creator_display, place_display,
  iiif_manifest_url, has_digital, is_published, last_exported_at,
  created_by, updated_by, created_at, updated_at
FROM descriptions;

DROP TABLE descriptions;
ALTER TABLE descriptions_new RENAME TO descriptions;

CREATE INDEX IF NOT EXISTS desc_parent_pos_idx ON descriptions(parent_id, position);
CREATE INDEX IF NOT EXISTS desc_root_idx ON descriptions(root_description_id);
CREATE UNIQUE INDEX IF NOT EXISTS desc_ref_code_idx ON descriptions(reference_code);
CREATE INDEX IF NOT EXISTS desc_repo_idx ON descriptions(repository_id);
CREATE INDEX IF NOT EXISTS desc_local_id_idx ON descriptions(local_identifier);

-- Re-CREATE FTS5 sync triggers (verbatim from drizzle/0024_descriptions_fts5.sql).
-- The descriptions_fts virtual table itself survives the rebuild because we
-- only DROP/RENAME the base table; FTS5 contents are preserved unless the
-- virtual table is dropped explicitly. The triggers, however, are tied to
-- the dropped table by name and must be re-created against the renamed one.
CREATE TRIGGER IF NOT EXISTS descriptions_fts_ai AFTER INSERT ON descriptions BEGIN
  INSERT INTO descriptions_fts(rowid, reference_code, title)
  VALUES (new.rowid, new.reference_code, new.title);
END;

CREATE TRIGGER IF NOT EXISTS descriptions_fts_ad AFTER DELETE ON descriptions BEGIN
  INSERT INTO descriptions_fts(descriptions_fts, rowid, reference_code, title)
  VALUES ('delete', old.rowid, old.reference_code, old.title);
END;

CREATE TRIGGER IF NOT EXISTS descriptions_fts_au AFTER UPDATE ON descriptions BEGIN
  INSERT INTO descriptions_fts(descriptions_fts, rowid, reference_code, title)
  VALUES ('delete', old.rowid, old.reference_code, old.title);
  INSERT INTO descriptions_fts(rowid, reference_code, title)
  VALUES (new.rowid, new.reference_code, new.title);
END;

PRAGMA foreign_key_check;
-- ============================================================================
-- Rebuild 4: entities
-- ============================================================================

CREATE TABLE entities_new (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  entity_code TEXT,
  display_name TEXT NOT NULL,
  sort_name TEXT NOT NULL,
  surname TEXT,
  given_name TEXT,
  entity_type TEXT NOT NULL,
  honorific TEXT,
  primary_function TEXT,
  primary_function_id TEXT REFERENCES vocabulary_terms(id) ON DELETE SET NULL,
  name_variants TEXT DEFAULT '[]',
  dates_of_existence TEXT,
  date_start TEXT,
  date_end TEXT,
  history TEXT,
  legal_status TEXT,
  functions TEXT,
  sources TEXT,
  merged_into TEXT,
  wikidata_id TEXT,
  viaf_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO entities_new (
  id, tenant_id, entity_code,
  display_name, sort_name, surname, given_name,
  entity_type, honorific,
  primary_function, primary_function_id, name_variants,
  dates_of_existence, date_start, date_end,
  history, legal_status, functions, sources, merged_into,
  wikidata_id, viaf_id,
  created_at, updated_at
)
SELECT
  id, 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', entity_code,
  display_name, sort_name, surname, given_name,
  entity_type, honorific,
  primary_function, primary_function_id, name_variants,
  dates_of_existence, date_start, date_end,
  history, legal_status, functions, sources, merged_into,
  wikidata_id, viaf_id,
  created_at, updated_at
FROM entities;

DROP TABLE entities;
ALTER TABLE entities_new RENAME TO entities;

CREATE UNIQUE INDEX IF NOT EXISTS entity_code_idx ON entities(entity_code);
CREATE INDEX IF NOT EXISTS entity_sort_name_idx ON entities(sort_name);
CREATE INDEX IF NOT EXISTS entity_wikidata_idx ON entities(wikidata_id);
CREATE INDEX IF NOT EXISTS entity_pf_id_idx ON entities(primary_function_id);

-- Re-CREATE FTS5 sync triggers (verbatim from drizzle/0015_fts5_name_variants.sql lines 43-58).
CREATE TRIGGER IF NOT EXISTS entities_fts_ai AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(rowid, display_name, sort_name, name_variants)
  VALUES (new.rowid, new.display_name, new.sort_name, new.name_variants);
END;

CREATE TRIGGER IF NOT EXISTS entities_fts_ad AFTER DELETE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, display_name, sort_name, name_variants)
  VALUES ('delete', old.rowid, old.display_name, old.sort_name, old.name_variants);
END;

CREATE TRIGGER IF NOT EXISTS entities_fts_au AFTER UPDATE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, display_name, sort_name, name_variants)
  VALUES ('delete', old.rowid, old.display_name, old.sort_name, old.name_variants);
  INSERT INTO entities_fts(rowid, display_name, sort_name, name_variants)
  VALUES (new.rowid, new.display_name, new.sort_name, new.name_variants);
END;

PRAGMA foreign_key_check;
-- ============================================================================
-- Rebuild 5: places
-- ============================================================================

CREATE TABLE places_new (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  place_code TEXT,
  label TEXT NOT NULL,
  display_name TEXT NOT NULL,
  place_type TEXT,
  name_variants TEXT DEFAULT '[]',
  parent_id TEXT,
  latitude REAL,
  longitude REAL,
  coordinate_precision TEXT,
  historical_gobernacion TEXT,
  historical_partido TEXT,
  historical_region TEXT,
  country_code TEXT,
  admin_level_1 TEXT,
  admin_level_2 TEXT,
  needs_geocoding INTEGER DEFAULT 1,
  merged_into TEXT,
  tgn_id TEXT,
  hgis_id TEXT,
  whg_id TEXT,
  wikidata_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO places_new (
  id, tenant_id, place_code,
  label, display_name, place_type, name_variants, parent_id,
  latitude, longitude, coordinate_precision,
  historical_gobernacion, historical_partido, historical_region,
  country_code, admin_level_1, admin_level_2,
  needs_geocoding, merged_into,
  tgn_id, hgis_id, whg_id, wikidata_id,
  created_at, updated_at
)
SELECT
  id, 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', place_code,
  label, display_name, place_type, name_variants, parent_id,
  latitude, longitude, coordinate_precision,
  historical_gobernacion, historical_partido, historical_region,
  country_code, admin_level_1, admin_level_2,
  needs_geocoding, merged_into,
  tgn_id, hgis_id, whg_id, wikidata_id,
  created_at, updated_at
FROM places;

DROP TABLE places;
ALTER TABLE places_new RENAME TO places;

CREATE UNIQUE INDEX IF NOT EXISTS place_code_idx ON places(place_code);
CREATE INDEX IF NOT EXISTS place_label_idx ON places(label);
CREATE INDEX IF NOT EXISTS place_tgn_idx ON places(tgn_id);

-- Re-CREATE FTS5 sync triggers (verbatim from drizzle/0015_fts5_name_variants.sql lines 60-75).
CREATE TRIGGER IF NOT EXISTS places_fts_ai AFTER INSERT ON places BEGIN
  INSERT INTO places_fts(rowid, label, display_name, name_variants)
  VALUES (new.rowid, new.label, new.display_name, new.name_variants);
END;

CREATE TRIGGER IF NOT EXISTS places_fts_ad AFTER DELETE ON places BEGIN
  INSERT INTO places_fts(places_fts, rowid, label, display_name, name_variants)
  VALUES ('delete', old.rowid, old.label, old.display_name, old.name_variants);
END;

CREATE TRIGGER IF NOT EXISTS places_fts_au AFTER UPDATE ON places BEGIN
  INSERT INTO places_fts(places_fts, rowid, label, display_name, name_variants)
  VALUES ('delete', old.rowid, old.label, old.display_name, old.name_variants);
  INSERT INTO places_fts(rowid, label, display_name, name_variants)
  VALUES (new.rowid, new.label, new.display_name, new.name_variants);
END;

PRAGMA foreign_key_check;
-- defer_foreign_keys auto-resets at end of transaction; no explicit re-enable.
