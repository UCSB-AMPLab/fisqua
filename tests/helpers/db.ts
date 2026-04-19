/**
 * Tests — db
 *
 * @version v0.3.0
 */
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";

/**
 * Creates a Drizzle instance bound to the test D1 database.
 */
export function getTestDb() {
  return drizzle(env.DB, { schema });
}

/**
 * Applies the schema to the test D1 database.
 * Uses D1 batch API (prepare + run) for each statement.
 */
export async function applyMigrations() {
  const db = env.DB;

  await db.exec("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL UNIQUE, name TEXT, is_admin INTEGER NOT NULL DEFAULT 0, is_super_admin INTEGER NOT NULL DEFAULT 0, is_collab_admin INTEGER NOT NULL DEFAULT 0, is_archive_user INTEGER NOT NULL DEFAULT 0, is_user_manager INTEGER NOT NULL DEFAULT 0, is_cataloguer INTEGER NOT NULL DEFAULT 0, last_active_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, github_id TEXT UNIQUE)");

  await db.exec("CREATE TABLE IF NOT EXISTS magic_links (id TEXT PRIMARY KEY NOT NULL, token TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS magic_links_token_idx ON magic_links(token)");
  await db.exec("CREATE INDEX IF NOT EXISTS magic_links_expires_idx ON magic_links(expires_at)");

  await db.exec("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT, conventions TEXT, settings TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER)");

  await db.exec("CREATE TABLE IF NOT EXISTS project_members (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('lead', 'cataloguer', 'reviewer')), created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS pm_project_idx ON project_members(project_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS pm_user_idx ON project_members(user_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS pm_project_user_idx ON project_members(project_id, user_id)");

  await db.exec("CREATE TABLE IF NOT EXISTS project_invites (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), email TEXT NOT NULL, roles TEXT NOT NULL, invited_by TEXT NOT NULL REFERENCES users(id), token TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, accepted_at INTEGER, created_at INTEGER NOT NULL)");

  await db.exec("CREATE TABLE IF NOT EXISTS volumes (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, reference_code TEXT NOT NULL, manifest_url TEXT NOT NULL, page_count INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'unstarted' CHECK(status IN ('unstarted', 'in_progress', 'segmented', 'sent_back', 'reviewed', 'approved')), assigned_to TEXT REFERENCES users(id), assigned_reviewer TEXT REFERENCES users(id), review_comment TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS vol_project_idx ON volumes(project_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS vol_status_idx ON volumes(project_id, status)");

  await db.exec("CREATE TABLE IF NOT EXISTS volume_pages (id TEXT PRIMARY KEY NOT NULL, volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE, position INTEGER NOT NULL, image_url TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, label TEXT, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS vp_volume_idx ON volume_pages(volume_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS vp_volume_pos_idx ON volume_pages(volume_id, position)");

  await db.exec("DROP TABLE IF EXISTS entries");
  // post-Wave-2 (migration 0032): `test_images` joins the
  // EntryType CHECK and a new nullable `subtype` column carries the
  // per-entry document subtype label (only meaningful for type='item').
  await db.exec("CREATE TABLE entries (id TEXT PRIMARY KEY NOT NULL, volume_id TEXT NOT NULL REFERENCES volumes(id), parent_id TEXT, position INTEGER NOT NULL, start_page INTEGER NOT NULL, start_y REAL NOT NULL DEFAULT 0, end_page INTEGER, end_y REAL, type TEXT CHECK(type IN ('item', 'blank', 'front_matter', 'back_matter', 'test_images')), subtype TEXT, title TEXT, modified_by TEXT REFERENCES users(id), description_status TEXT DEFAULT 'unassigned' CHECK(description_status IN ('unassigned', 'assigned', 'in_progress', 'described', 'reviewed', 'approved', 'sent_back', 'promoted')), assigned_describer TEXT REFERENCES users(id), assigned_description_reviewer TEXT REFERENCES users(id), translated_title TEXT, resource_type TEXT CHECK(resource_type IN ('texto', 'imagen', 'cartografico', 'mixto')), date_expression TEXT, date_start TEXT, date_end TEXT, extent TEXT, scope_content TEXT, language TEXT, description_notes TEXT, internal_notes TEXT, description_level TEXT DEFAULT 'item', promoted_description_id TEXT REFERENCES descriptions(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS entry_promoted_idx ON entries(promoted_description_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS entry_volume_idx ON entries(volume_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS entry_parent_idx ON entries(parent_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS entry_volume_pos_idx ON entries(volume_id, position)");

  await db.exec("DROP TABLE IF EXISTS comments");
  await db.exec("DROP TABLE IF EXISTS qc_flags");

  // qc_flags -- page-scoped QC signals with a resolution workflow.
  // Declared before comments because adds a FK from comments.qc_flag_id.
  //
  // region_comment_id is a legacy/deprecated column from the (reverted)
  // "Vincular a región" follow-up. The column
  // still exists in D1 (migration 0031 is NOT rolled back) and the test
  // helper preserves it so schema assertions match real DB state, but no
  // application code reads or writes it after the 2026-04-18 cleanup.
  await db.exec("CREATE TABLE qc_flags (id TEXT PRIMARY KEY NOT NULL, volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE, page_id TEXT NOT NULL REFERENCES volume_pages(id) ON DELETE CASCADE, reported_by TEXT NOT NULL REFERENCES users(id), problem_type TEXT NOT NULL CHECK(problem_type IN ('damaged','repeated','out_of_order','missing','blank','other')), description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','wontfix')), resolution_action TEXT CHECK(resolution_action IS NULL OR resolution_action IN ('retake_requested','reordered','marked_duplicate','ignored','other')), resolver_note TEXT, resolved_by TEXT REFERENCES users(id), resolved_at INTEGER, region_comment_id TEXT, created_at INTEGER NOT NULL, CHECK ((status = 'open' AND resolution_action IS NULL AND resolved_by IS NULL AND resolved_at IS NULL) OR (status IN ('resolved','wontfix') AND resolution_action IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)), CHECK (problem_type != 'other' OR length(description) > 0), CHECK (resolution_action != 'other' OR length(COALESCE(resolver_note, '')) > 0))");
  await db.exec("CREATE INDEX IF NOT EXISTS qc_flags_volume_status_idx ON qc_flags(volume_id, status)");
  await db.exec("CREATE INDEX IF NOT EXISTS qc_flags_page_idx ON qc_flags(page_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS qc_flags_reporter_idx ON qc_flags(reported_by)");
  await db.exec("CREATE INDEX IF NOT EXISTS qc_flags_region_comment_idx ON qc_flags(region_comment_id)");

  // comments target exactly one of entry_id, page_id, or
  // qc_flag_id (three-way XOR CHECK). Nullable region_x/y/w/h REAL columns
  // carry optional image-region coordinates on page-targeted comments.
  // task 13 (migration 0033): five additional nullable columns
  // for soft-delete + resolve + last-edit tracking. All nullable, no
  // backfill, no new CHECK constraints.
  await db.exec("CREATE TABLE comments (id TEXT PRIMARY KEY NOT NULL, volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE, entry_id TEXT REFERENCES entries(id) ON DELETE CASCADE, page_id TEXT REFERENCES volume_pages(id) ON DELETE CASCADE, qc_flag_id TEXT REFERENCES qc_flags(id) ON DELETE CASCADE, region_x REAL, region_y REAL, region_w REAL, region_h REAL, parent_id TEXT, author_id TEXT NOT NULL REFERENCES users(id), author_role TEXT NOT NULL CHECK(author_role IN ('cataloguer', 'reviewer', 'lead')), text TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, deleted_by TEXT REFERENCES users(id), resolved_at INTEGER, resolved_by TEXT REFERENCES users(id), edited_at INTEGER, CHECK ((entry_id IS NOT NULL AND page_id IS NULL AND qc_flag_id IS NULL) OR (entry_id IS NULL AND page_id IS NOT NULL AND qc_flag_id IS NULL) OR (entry_id IS NULL AND page_id IS NULL AND qc_flag_id IS NOT NULL)))");
  await db.exec("CREATE INDEX IF NOT EXISTS comment_volume_idx ON comments(volume_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS comment_entry_idx ON comments(entry_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS comment_page_idx ON comments(page_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS comment_qc_flag_idx ON comments(qc_flag_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS comment_parent_idx ON comments(parent_id)");

  await db.exec("DROP TABLE IF EXISTS resegmentation_flags");
  await db.exec("CREATE TABLE resegmentation_flags (id TEXT PRIMARY KEY NOT NULL, volume_id TEXT NOT NULL REFERENCES volumes(id), reported_by TEXT NOT NULL REFERENCES users(id), entry_id TEXT NOT NULL REFERENCES entries(id), problem_type TEXT NOT NULL CHECK(problem_type IN ('incorrect_boundaries', 'merged_documents', 'split_document', 'missing_pages', 'other')), affected_entry_ids TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved')), resolved_by TEXT REFERENCES users(id), resolved_at INTEGER, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS reseg_volume_idx ON resegmentation_flags(volume_id)");

  await db.exec("CREATE TABLE IF NOT EXISTS activity_log (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), project_id TEXT REFERENCES projects(id), volume_id TEXT REFERENCES volumes(id), event TEXT NOT NULL CHECK(event IN ('login', 'volume_opened', 'status_changed', 'review_submitted', 'assignment_changed', 'description_status_changed', 'description_assignment_changed', 'resegmentation_flagged', 'comment_added', 'comment_region_moved', 'comment_edited', 'comment_deleted', 'comment_resolved', 'comment_unresolved', 'qc_flag_raised', 'qc_flag_resolved')), detail TEXT, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS al_user_idx ON activity_log(user_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS al_project_idx ON activity_log(project_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS al_created_idx ON activity_log(created_at)");

  // Phase 17: archival management tables
  await db.exec("CREATE TABLE IF NOT EXISTS repositories (id TEXT PRIMARY KEY NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, short_name TEXT, country_code TEXT DEFAULT 'COL', country TEXT, city TEXT, address TEXT, website TEXT, notes TEXT, rights_text TEXT, display_title TEXT, subtitle TEXT, hero_image_url TEXT, enabled INTEGER DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS repo_code_idx ON repositories(code)");

  await db.exec("CREATE TABLE IF NOT EXISTS descriptions (id TEXT PRIMARY KEY NOT NULL, repository_id TEXT NOT NULL REFERENCES repositories(id), parent_id TEXT, position INTEGER DEFAULT 0 NOT NULL, root_description_id TEXT, depth INTEGER DEFAULT 0 NOT NULL, child_count INTEGER DEFAULT 0 NOT NULL, path_cache TEXT DEFAULT '', description_level TEXT NOT NULL, resource_type TEXT, genre TEXT DEFAULT '[]', reference_code TEXT NOT NULL, local_identifier TEXT NOT NULL, title TEXT NOT NULL, translated_title TEXT, uniform_title TEXT, date_expression TEXT, date_start TEXT, date_end TEXT, date_certainty TEXT, extent TEXT, dimensions TEXT, medium TEXT, imprint TEXT, edition_statement TEXT, series_statement TEXT, volume_number TEXT, issue_number TEXT, pages TEXT, provenance TEXT, scope_content TEXT, ocr_text TEXT DEFAULT '', arrangement TEXT, access_conditions TEXT, reproduction_conditions TEXT, language TEXT, location_of_originals TEXT, location_of_copies TEXT, related_materials TEXT, finding_aids TEXT, section_title TEXT, notes TEXT, internal_notes TEXT, creator_display TEXT, place_display TEXT, iiif_manifest_url TEXT, has_digital INTEGER DEFAULT 0, is_published INTEGER DEFAULT 0, last_exported_at INTEGER, created_by TEXT REFERENCES users(id), updated_by TEXT REFERENCES users(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS desc_parent_pos_idx ON descriptions(parent_id, position)");
  await db.exec("CREATE INDEX IF NOT EXISTS desc_root_idx ON descriptions(root_description_id)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS desc_ref_code_idx ON descriptions(reference_code)");
  await db.exec("CREATE INDEX IF NOT EXISTS desc_repo_idx ON descriptions(repository_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS desc_local_id_idx ON descriptions(local_identifier)");

  await db.exec("CREATE TABLE IF NOT EXISTS vocabulary_terms (id TEXT PRIMARY KEY NOT NULL, canonical TEXT NOT NULL, category TEXT, status TEXT NOT NULL DEFAULT 'approved', merged_into TEXT, entity_count INTEGER NOT NULL DEFAULT 0, proposed_by TEXT REFERENCES users(id) ON DELETE SET NULL, reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL, reviewed_at INTEGER, notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS vt_canonical_idx ON vocabulary_terms(canonical)");
  await db.exec("CREATE INDEX IF NOT EXISTS vt_category_idx ON vocabulary_terms(category)");
  await db.exec("CREATE INDEX IF NOT EXISTS vt_status_idx ON vocabulary_terms(status)");

  await db.exec("CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY NOT NULL, entity_code TEXT, display_name TEXT NOT NULL, sort_name TEXT NOT NULL, surname TEXT, given_name TEXT, entity_type TEXT NOT NULL, honorific TEXT, primary_function TEXT, primary_function_id TEXT REFERENCES vocabulary_terms(id) ON DELETE SET NULL, name_variants TEXT DEFAULT '[]', dates_of_existence TEXT, date_start TEXT, date_end TEXT, history TEXT, legal_status TEXT, functions TEXT, sources TEXT, merged_into TEXT, wikidata_id TEXT, viaf_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS entity_code_idx ON entities(entity_code)");
  await db.exec("CREATE INDEX IF NOT EXISTS entity_sort_name_idx ON entities(sort_name)");
  await db.exec("CREATE INDEX IF NOT EXISTS entity_wikidata_idx ON entities(wikidata_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS entity_pf_id_idx ON entities(primary_function_id)");

  await db.exec("CREATE TABLE IF NOT EXISTS entity_functions (id TEXT PRIMARY KEY NOT NULL, entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE, honorific TEXT, function TEXT NOT NULL, date_start TEXT, date_end TEXT, date_note TEXT, certainty TEXT DEFAULT 'probable', source TEXT, notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS ef_entity_idx ON entity_functions(entity_id)");

  await db.exec("CREATE TABLE IF NOT EXISTS places (id TEXT PRIMARY KEY NOT NULL, place_code TEXT, label TEXT NOT NULL, display_name TEXT NOT NULL, place_type TEXT, name_variants TEXT DEFAULT '[]', parent_id TEXT, latitude REAL, longitude REAL, coordinate_precision TEXT, historical_gobernacion TEXT, historical_partido TEXT, historical_region TEXT, country_code TEXT, admin_level_1 TEXT, admin_level_2 TEXT, needs_geocoding INTEGER DEFAULT 1, merged_into TEXT, tgn_id TEXT, hgis_id TEXT, whg_id TEXT, wikidata_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS place_code_idx ON places(place_code)");
  await db.exec("CREATE INDEX IF NOT EXISTS place_label_idx ON places(label)");
  await db.exec("CREATE INDEX IF NOT EXISTS place_tgn_idx ON places(tgn_id)");

  await db.exec("CREATE TABLE IF NOT EXISTS description_entities (id TEXT PRIMARY KEY NOT NULL, description_id TEXT NOT NULL REFERENCES descriptions(id) ON DELETE CASCADE, entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE RESTRICT, role TEXT NOT NULL, role_note TEXT, sequence INTEGER DEFAULT 0 NOT NULL, honorific TEXT, function TEXT, name_as_recorded TEXT, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS de_desc_idx ON description_entities(description_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS de_entity_role_idx ON description_entities(entity_id, role)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS de_unique_idx ON description_entities(description_id, entity_id, role)");

  await db.exec("CREATE TABLE IF NOT EXISTS description_places (id TEXT PRIMARY KEY NOT NULL, description_id TEXT NOT NULL REFERENCES descriptions(id) ON DELETE CASCADE, place_id TEXT NOT NULL REFERENCES places(id) ON DELETE RESTRICT, role TEXT NOT NULL, role_note TEXT, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS dp_desc_idx ON description_places(description_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS dp_place_role_idx ON description_places(place_id, role)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS dp_unique_idx ON description_places(description_id, place_id, role)");

  await db.exec("CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY NOT NULL, record_id TEXT NOT NULL, record_type TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), snapshot TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS drafts_record_idx ON drafts(record_id, record_type)");
  await db.exec("CREATE INDEX IF NOT EXISTS drafts_user_idx ON drafts(user_id)");

  await db.exec("CREATE TABLE IF NOT EXISTS changelog (id TEXT PRIMARY KEY NOT NULL, record_id TEXT NOT NULL, record_type TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), note TEXT, diff TEXT NOT NULL, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS changelog_record_idx ON changelog(record_id, record_type, created_at)");

  await db.exec("CREATE TABLE IF NOT EXISTS export_runs (id TEXT PRIMARY KEY NOT NULL, triggered_by TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'pending', selected_fonds TEXT NOT NULL, selected_types TEXT NOT NULL, current_step TEXT, steps_completed INTEGER NOT NULL DEFAULT 0, total_steps INTEGER NOT NULL DEFAULT 0, record_counts TEXT, error_message TEXT, started_at INTEGER, completed_at INTEGER, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS export_runs_status_idx ON export_runs(status)");
  await db.exec("CREATE INDEX IF NOT EXISTS export_runs_created_idx ON export_runs(created_at)");
}

/**
 * Cleans all data from tables (order matters due to foreign keys).
 */
export async function cleanDatabase() {
  const db = env.DB;
  const tables = [
    "export_runs",
    "changelog",
    "drafts",
    "description_places",
    "description_entities",
    "entity_functions",
    "activity_log",
    "comments",
    "qc_flags",
    "resegmentation_flags",
    "entries",
    "volume_pages",
    "volumes",
    "project_invites",
    "project_members",
    "descriptions",
    "places",
    "entities",
    "vocabulary_terms",
    "repositories",
    "projects",
    "magic_links",
    "users",
  ];

  for (const table of tables) {
    await db.exec(`DELETE FROM ${table}`);
  }
}
