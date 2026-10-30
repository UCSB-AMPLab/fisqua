/**
 * Tests — db
 *
 * This helper is the hand-built test-DB harness. It mirrors the
 * production schema by
 * replaying `db.exec("CREATE TABLE ...")` statements against a fresh
 * in-Worker D1 binding so the existing 2520+ test suite can run
 * without invoking `wrangler d1 migrations apply`. Updates land
 * lock-step with each Drizzle migration.
 *
 * The `DEFAULT_TEST_TENANT_ID` export and the seed helpers
 * (`seedTenants`, `seedDisabledTenant`, `seedOperatorUser`) live
 * here so downstream test files share a single import surface for
 * tenant-aware fixtures.
 *
 * @version v0.8.0
 */
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import {
  NEOGRANADINA_TENANT_ID,
  PLATFORM_TENANT_ID,
  DACS_TEST_TENANT_ID,
  RAD_TEST_TENANT_ID,
  NEOGRANADINA_FEDERATION_ID,
  PLATFORM_FEDERATION_ID,
} from "../../app/lib/tenant";

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

  // tenants table mirrors drizzle/0034_tenants_table.sql verbatim --
  // same columns, same CHECK constraints, same indexes. Declared
  // before every table that carries a tenant_id FK so the FK
  // reference resolves at harness load.
  await db.exec(
    "CREATE TABLE IF NOT EXISTS tenants (" +
      "id TEXT PRIMARY KEY NOT NULL, " +
      "slug TEXT NOT NULL UNIQUE, " +
      "name TEXT NOT NULL, " +
      "kind TEXT NOT NULL DEFAULT 'tenant' CHECK (kind IN ('tenant','platform')), " +
      "descriptive_standard TEXT, " +
      "status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')), " +
      "crowdsourcing_enabled INTEGER NOT NULL DEFAULT 0, " +
      "vocabulary_hub_enabled INTEGER NOT NULL DEFAULT 1, " +
      "publish_pipeline_enabled INTEGER NOT NULL DEFAULT 1, " +
      "multi_repository_enabled INTEGER NOT NULL DEFAULT 0, " +
      // authorities capability (migration 0058). DEFAULT 1 —
      // behaviour-neutral; komuni/sbmal launch strings-only.
      "authorities_enabled INTEGER NOT NULL DEFAULT 1, " +
      // imports capability (migration 0061). DEFAULT 0 — operator-granted.
      "imports_enabled INTEGER NOT NULL DEFAULT 0, " +
      // media pipeline capability (migration 0081). DEFAULT 0 — operator-granted.
      "media_pipeline_enabled INTEGER NOT NULL DEFAULT 0, " +
      // digitization capability (migration 0098). DEFAULT 0 — operator-granted.
      "digitization_enabled INTEGER NOT NULL DEFAULT 0, " +
      "quota_storage_bytes INTEGER, " +
      // Nullable soft-disable timestamp.
      "disabled_at INTEGER, " +
      // federation_id (migration 0044): nullable-with-FK at the DB layer
      // (schema.ts enforces NOT NULL at the type layer). FK references
      // federations, created just below — SQLite allows a forward FK
      // reference at CREATE time (checked only at row ops).
      "federation_id TEXT REFERENCES federations(id) ON DELETE RESTRICT, " +
      // Authority code prefixes (migration 0068). Set only on tenants
      // that mint their OWN authority records; NULL everywhere else,
      // where the federation row carries the pair instead.
      "entity_code_prefix TEXT, " +
      "place_code_prefix TEXT, " +
      "created_at INTEGER NOT NULL, " +
      "updated_at INTEGER NOT NULL, " +
      // Manifest settings (migration 0090): the public site, provider
      // and METS location a pipeline manifest names. All nullable.
      "public_site_url TEXT, " +
      "public_site_name TEXT, " +
      "provider_name TEXT, " +
      "provider_url TEXT, " +
      "mets_base_url TEXT, " +
      // SQLite CHECK only rejects on FALSE (not NULL). The second
      // branch must explicitly guard descriptive_standard IS NOT NULL
      // so that `kind='tenant', descriptive_standard=NULL` does not
      // slip through (NULL IN (...) is NULL, not FALSE).
      "CHECK ((kind = 'platform' AND descriptive_standard IS NULL) OR (kind = 'tenant' AND descriptive_standard IS NOT NULL AND descriptive_standard IN ('isadg','dacs','rad'))), " +
      "CHECK (slug GLOB '[a-z][a-z0-9-]*[a-z0-9]' OR slug GLOB '[a-z]')" +
    ")",
  );
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_idx ON tenants(slug)");
  await db.exec("CREATE INDEX IF NOT EXISTS tenants_kind_idx ON tenants(kind)");
  await db.exec("CREATE INDEX IF NOT EXISTS tenants_federation_idx ON tenants(federation_id)");

  // federations table (migration 0044) mirrors drizzle/0044_federations.sql.
  // Declared right after tenants so its lead_tenant_id FK resolves; the
  // tenants.federation_id FK above forward-references this table (legal
  // at CREATE — SQLite checks FKs only at row ops). tenants <-> federations
  // is a circular FK pair, so seeding (seedTenants then seedFederations)
  // and teardown (NULL tenants.federation_id, drop federations, drop
  // tenants) sequence around it — D1 has no DEFERRED FK support.
  await db.exec(
    "CREATE TABLE IF NOT EXISTS federations (" +
      "id TEXT PRIMARY KEY NOT NULL, " +
      "slug TEXT NOT NULL UNIQUE, " +
      "name TEXT NOT NULL, " +
      "lead_tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, " +
      "status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')), " +
      "multi_member_enabled INTEGER NOT NULL DEFAULT 0, " +
      // shared_authorities_enabled (migration 0067): the minting default
      // for this federation's authority space. DEFAULT 0 — a federation
      // mints tenant-owned entities/places until it says otherwise.
      "shared_authorities_enabled INTEGER NOT NULL DEFAULT 0, " +
      // Authority code prefixes (migration 0068): the mark the minting
      // agency puts on the codes it issues. Carried here for records
      // minted into a federation's SHARED authority space; the same
      // pair on `tenants` covers tenant-owned records.
      "entity_code_prefix TEXT, " +
      "place_code_prefix TEXT, " +
      "created_at INTEGER NOT NULL, " +
      // Storage destination (migration 0091): where the media pipeline
      // writes the federation's output, each tenant's under its slug,
      // the masters bucket the runner reads, and the secret-name prefix.
      "pipeline_delivery_endpoint TEXT, " +
      "pipeline_tiles_bucket TEXT, " +
      "pipeline_masters_bucket TEXT, " +
      "pipeline_image_base_url TEXT, " +
      "manifest_endpoint TEXT, " +
      "manifest_bucket TEXT, " +
      "manifest_base_url TEXT, " +
      "storage_secret_prefix TEXT, " +
      // The optional review-tiles bucket (migration 0097).
      "pipeline_review_tiles_bucket TEXT" +
    ")",
  );
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS federations_slug_idx ON federations(slug)");
  await db.exec("CREATE INDEX IF NOT EXISTS federations_lead_tenant_idx ON federations(lead_tenant_id)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS federations_pipeline_tiles_bucket_idx ON federations(pipeline_tiles_bucket) WHERE pipeline_tiles_bucket IS NOT NULL");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS federations_pipeline_masters_bucket_idx ON federations(pipeline_masters_bucket) WHERE pipeline_masters_bucket IS NOT NULL");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS federations_manifest_bucket_idx ON federations(manifest_bucket) WHERE manifest_bucket IS NOT NULL");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS federations_manifest_base_url_idx ON federations(manifest_base_url) WHERE manifest_base_url IS NOT NULL");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS federations_storage_secret_prefix_idx ON federations(storage_secret_prefix) WHERE storage_secret_prefix IS NOT NULL");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS federations_pipeline_review_tiles_bucket_idx ON federations(pipeline_review_tiles_bucket) WHERE pipeline_review_tiles_bucket IS NOT NULL");

  // users carries tenant_id NOT NULL FK to tenants(id) ON DELETE
  // RESTRICT, immediately after id (mirrors drizzle/0035 column
  // order), plus the three notification/language preference columns
  // migration 0074 adds: digest_frequency (default 'hourly'),
  // last_digest_at (the sweep's per-user clock) and locale, and the
  // four area-admin flags migration 0107 adds after is_cataloguer.
  await db.exec("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, email TEXT NOT NULL UNIQUE, name TEXT, is_admin INTEGER NOT NULL DEFAULT 0, is_super_admin INTEGER NOT NULL DEFAULT 0, is_collab_admin INTEGER NOT NULL DEFAULT 0, is_archive_user INTEGER NOT NULL DEFAULT 0, is_user_manager INTEGER NOT NULL DEFAULT 0, is_cataloguer INTEGER NOT NULL DEFAULT 0, is_records_admin INTEGER NOT NULL DEFAULT 0, is_authorities_admin INTEGER NOT NULL DEFAULT 0, is_imports_admin INTEGER NOT NULL DEFAULT 0, is_digitization_admin INTEGER NOT NULL DEFAULT 0, digest_frequency TEXT NOT NULL DEFAULT 'hourly', last_digest_at INTEGER, locale TEXT, last_active_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, github_id TEXT UNIQUE)");

  // federation_memberships (migration 0049): the grant join table.
  // Declared after users + federations so both FKs resolve. Both FKs are
  // ON DELETE CASCADE; UNIQUE(user_id, federation_id) is the composite
  // index the schema declares by name (fed_memberships_user_federation_idx).
  await db.exec(
    "CREATE TABLE IF NOT EXISTS federation_memberships (" +
      "id TEXT PRIMARY KEY NOT NULL, " +
      "user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, " +
      "federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE CASCADE, " +
      "role TEXT NOT NULL CHECK (role IN ('steward','staff')), " +
      "created_at INTEGER NOT NULL" +
    ")",
  );
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS fed_memberships_user_federation_idx ON federation_memberships(user_id, federation_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS fed_memberships_federation_idx ON federation_memberships(federation_id)");

  // audit_log table mirrors drizzle/0037, with the action CHECK as
  // 0101 and 0108 widen it (scanner_token; set_user_role,
  // set_federation_role, set_project_membership, invite_user) — same 12 columns,
  // mixed FK delete behaviours (actor_user_id ON DELETE SET NULL
  // paired with denormalised actor_user_id_text NOT NULL for
  // forensic continuity; actor_tenant_id and target_tenant_id ON
  // DELETE RESTRICT), bounded action CHECK enum, 3 indexes with
  // created_at DESC ordering, and 2 BEFORE UPDATE / BEFORE DELETE
  // immutability triggers using the bare RAISE form (a
  // workers-sdk #4326 trigger-parser quirk avoidance).
  await db.exec(
    "CREATE TABLE IF NOT EXISTS audit_log (" +
      "id TEXT PRIMARY KEY NOT NULL, " +
      "created_at INTEGER NOT NULL, " +
      "actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL, " +
      "actor_user_id_text TEXT NOT NULL, " +
      "actor_tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, " +
      "action TEXT NOT NULL CHECK (action IN (" +
        "'create_tenant','soft_disable_tenant','reset_superadmin','login_as'," +
        "'edit_on_behalf','set_capability','set_quota','scanner_token'," +
        "'set_user_role','set_federation_role','set_project_membership','invite_user'" +
      ")), " +
      "target_tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT, " +
      "target_object_kind TEXT, " +
      "target_object_id TEXT, " +
      "impersonation_session_id TEXT, " +
      "details TEXT" +
    ")",
  );
  await db.exec("CREATE INDEX IF NOT EXISTS audit_log_target_tenant_idx ON audit_log(target_tenant_id, created_at DESC)");
  await db.exec("CREATE INDEX IF NOT EXISTS audit_log_actor_user_idx ON audit_log(actor_user_id, created_at DESC)");
  await db.exec("CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at DESC)");
  // Immutability triggers — bare RAISE form to dodge the
  // workers-sdk #4326 trigger-parser quirk. The append-only trigger
  // has a WHEN clause that allows the single FK-cascade transition
  // (actor_user_id going from non-null to NULL when the referenced
  // user is deleted). Every other UPDATE path still hits the trigger.
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log " +
      "WHEN NOT (" +
        "OLD.actor_user_id IS NOT NULL " +
        "AND NEW.actor_user_id IS NULL " +
        "AND OLD.id IS NEW.id " +
        "AND OLD.created_at IS NEW.created_at " +
        "AND OLD.actor_user_id_text IS NEW.actor_user_id_text " +
        "AND OLD.actor_tenant_id IS NEW.actor_tenant_id " +
        "AND OLD.action IS NEW.action " +
        "AND OLD.target_tenant_id IS NEW.target_tenant_id " +
        "AND OLD.target_object_kind IS NEW.target_object_kind " +
        "AND OLD.target_object_id IS NEW.target_object_id " +
        "AND OLD.impersonation_session_id IS NEW.impersonation_session_id " +
        "AND OLD.details IS NEW.details" +
      ") " +
      "BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log " +
      "BEGIN SELECT RAISE(ABORT, 'audit_log is immutable'); END",
  );

  await db.exec("CREATE TABLE IF NOT EXISTS magic_links (id TEXT PRIMARY KEY NOT NULL, token TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS magic_links_token_idx ON magic_links(token)");
  await db.exec("CREATE INDEX IF NOT EXISTS magic_links_expires_idx ON magic_links(expires_at)");

  // oauth_handoffs is the ephemeral, single-use rendezvous between
  // the apex GitHub OAuth callback and a tenant subdomain. No FKs
  // (rows are ephemeral; email + slug are re-validated at consume
  // time). 30s TTL bound is enforced by the helper, not the schema.
  await db.exec(
    "CREATE TABLE IF NOT EXISTS oauth_handoffs (" +
      "id TEXT PRIMARY KEY NOT NULL, " +
      "email TEXT NOT NULL, " +
      "github_id TEXT NOT NULL, " +
      "github_login TEXT NOT NULL, " +
      "return_to_slug TEXT NOT NULL, " +
      "expires_at INTEGER NOT NULL, " +
      "consumed INTEGER NOT NULL DEFAULT 0, " +
      "created_at INTEGER NOT NULL" +
    ")",
  );

  // impersonation_handoffs mirrors the single-use shape but is a
  // separate table (clean role-based columns; clean target for
  // audit_log.impersonation_session_id). FK delete behaviour:
  // actor_user_id and target_tenant_id both ON DELETE RESTRICT
  // (forensic continuity > orphan cleanup; rows are short-lived).
  // target_role CHECK enforces the six role-flag literal names
  // exactly.
  await db.exec(
    "CREATE TABLE IF NOT EXISTS impersonation_handoffs (" +
      "id TEXT PRIMARY KEY NOT NULL, " +
      "actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, " +
      "target_tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, " +
      "target_role TEXT NOT NULL CHECK (target_role IN ('isAdmin','isSuperAdmin','isCollabAdmin','isArchiveUser','isUserManager','isCataloguer')), " +
      "reason TEXT, " +
      "expires_at INTEGER NOT NULL, " +
      "consumed INTEGER NOT NULL DEFAULT 0, " +
      "created_at INTEGER NOT NULL" +
    ")",
  );
  await db.exec("CREATE INDEX IF NOT EXISTS impersonation_handoffs_expires_idx ON impersonation_handoffs(expires_at)");
  await db.exec("CREATE INDEX IF NOT EXISTS impersonation_handoffs_actor_idx ON impersonation_handoffs(actor_user_id, created_at)");

  // tenant_id NOT NULL DEFAULT (migration 0042) on the seven
  // crowdsourcing tables. ADD COLUMN in the migration; declared inline
  // here so the harness matches the post-0042 shape.
  await db.exec("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', name TEXT NOT NULL, description TEXT, conventions TEXT, settings TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER)");

  await db.exec("CREATE TABLE IF NOT EXISTS project_members (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('lead', 'cataloguer', 'reviewer')), created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS pm_project_idx ON project_members(project_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS pm_user_idx ON project_members(user_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS pm_project_user_idx ON project_members(project_id, user_id)");

  await db.exec("CREATE TABLE IF NOT EXISTS project_invites (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), email TEXT NOT NULL, roles TEXT NOT NULL, invited_by TEXT NOT NULL REFERENCES users(id), token TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, accepted_at INTEGER, created_at INTEGER NOT NULL)");

  await db.exec("CREATE TABLE IF NOT EXISTS volumes (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, reference_code TEXT NOT NULL, manifest_url TEXT NOT NULL, page_count INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'unstarted' CHECK(status IN ('unstarted', 'in_progress', 'segmented', 'sent_back', 'reviewed', 'approved')), assigned_to TEXT REFERENCES users(id), assigned_reviewer TEXT REFERENCES users(id), review_comment TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS vol_project_idx ON volumes(project_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS vol_status_idx ON volumes(project_id, status)");

  await db.exec("CREATE TABLE IF NOT EXISTS volume_pages (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE, position INTEGER NOT NULL, image_url TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, label TEXT, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS vp_volume_idx ON volume_pages(volume_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS vp_volume_pos_idx ON volume_pages(volume_id, position)");

  await db.exec("DROP TABLE IF EXISTS entries");
  // post-Wave-2 (migration 0032): `test_images` joins the
  // EntryType CHECK and a new nullable `subtype` column carries the
  // per-entry document subtype label (only meaningful for type='item').
  await db.exec("CREATE TABLE entries (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', volume_id TEXT NOT NULL REFERENCES volumes(id), parent_id TEXT, position INTEGER NOT NULL, start_page INTEGER NOT NULL, start_y REAL NOT NULL DEFAULT 0, end_page INTEGER, end_y REAL, type TEXT CHECK(type IN ('item', 'blank', 'front_matter', 'back_matter', 'test_images')), subtype TEXT, title TEXT, modified_by TEXT REFERENCES users(id), description_status TEXT DEFAULT 'unassigned' CHECK(description_status IN ('unassigned', 'assigned', 'in_progress', 'described', 'reviewed', 'approved', 'sent_back', 'promoted')), assigned_describer TEXT REFERENCES users(id), assigned_description_reviewer TEXT REFERENCES users(id), translated_title TEXT, resource_type TEXT CHECK(resource_type IN ('texto', 'imagen', 'cartografico', 'mixto')), date_expression TEXT, date_start TEXT, date_end TEXT, extent TEXT, scope_content TEXT, language TEXT, description_notes TEXT, internal_notes TEXT, description_level TEXT DEFAULT 'item', promoted_description_id TEXT REFERENCES descriptions(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
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
  await db.exec("CREATE TABLE qc_flags (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE, page_id TEXT NOT NULL REFERENCES volume_pages(id) ON DELETE CASCADE, reported_by TEXT NOT NULL REFERENCES users(id), problem_type TEXT NOT NULL CHECK(problem_type IN ('damaged','repeated','out_of_order','missing','blank','other')), description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','wontfix')), resolution_action TEXT CHECK(resolution_action IS NULL OR resolution_action IN ('retake_requested','reordered','marked_duplicate','ignored','other')), resolver_note TEXT, resolved_by TEXT REFERENCES users(id), resolved_at INTEGER, region_comment_id TEXT, created_at INTEGER NOT NULL, CHECK ((status = 'open' AND resolution_action IS NULL AND resolved_by IS NULL AND resolved_at IS NULL) OR (status IN ('resolved','wontfix') AND resolution_action IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)), CHECK (problem_type != 'other' OR length(description) > 0), CHECK (resolution_action != 'other' OR length(COALESCE(resolver_note, '')) > 0))");
  await db.exec("CREATE INDEX IF NOT EXISTS qc_flags_volume_status_idx ON qc_flags(volume_id, status)");
  await db.exec("CREATE INDEX IF NOT EXISTS qc_flags_page_idx ON qc_flags(page_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS qc_flags_reporter_idx ON qc_flags(reported_by)");
  await db.exec("CREATE INDEX IF NOT EXISTS qc_flags_region_comment_idx ON qc_flags(region_comment_id)");

  // comments (post-0071, the platform's one comment store) target
  // exactly one of entry_id, page_id, qc_flag_id, or decision_id
  // (four-way XOR CHECK); the author is exactly one of a user or an
  // agency label (CHECK). tenant_id and volume_id stay required for
  // the three volume-anchored targets (CHECKs); tenant_id keeps the
  // harness DEFAULT so pre-0042 tests that omit it still resolve.
  // decision_id's FK target (pending_decisions) is created further
  // down this function — SQLite does not resolve FK targets at CREATE
  // time, and no DML runs until applyMigrations() completes. Nullable
  // region_x/y/w/h REAL columns carry optional image-region
  // coordinates on page-targeted comments; quote/quote_ref/note carry
  // one quoted passage with its reference and an epistemic qualifier;
  // migration 0033's five nullable soft-delete/resolve/edit columns
  // complete the shape.
  await db.exec("CREATE TABLE comments (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', volume_id TEXT REFERENCES volumes(id) ON DELETE CASCADE, entry_id TEXT REFERENCES entries(id) ON DELETE CASCADE, page_id TEXT REFERENCES volume_pages(id) ON DELETE CASCADE, qc_flag_id TEXT REFERENCES qc_flags(id) ON DELETE CASCADE, decision_id TEXT REFERENCES pending_decisions(id) ON DELETE RESTRICT, region_x REAL, region_y REAL, region_w REAL, region_h REAL, parent_id TEXT, author_id TEXT REFERENCES users(id), author_label TEXT, author_role TEXT, text TEXT NOT NULL, quote TEXT, quote_ref TEXT, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, deleted_by TEXT REFERENCES users(id), resolved_at INTEGER, resolved_by TEXT REFERENCES users(id), edited_at INTEGER, CHECK ((entry_id IS NOT NULL AND page_id IS NULL AND qc_flag_id IS NULL AND decision_id IS NULL) OR (entry_id IS NULL AND page_id IS NOT NULL AND qc_flag_id IS NULL AND decision_id IS NULL) OR (entry_id IS NULL AND page_id IS NULL AND qc_flag_id IS NOT NULL AND decision_id IS NULL) OR (entry_id IS NULL AND page_id IS NULL AND qc_flag_id IS NULL AND decision_id IS NOT NULL)), CHECK ((author_id IS NULL) != (author_label IS NULL)), CHECK (decision_id IS NOT NULL OR volume_id IS NOT NULL), CHECK (decision_id IS NOT NULL OR tenant_id IS NOT NULL))");
  await db.exec("CREATE INDEX IF NOT EXISTS comment_volume_idx ON comments(volume_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS comment_entry_idx ON comments(entry_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS comment_page_idx ON comments(page_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS comment_qc_flag_idx ON comments(qc_flag_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS comment_parent_idx ON comments(parent_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS comment_decision_idx ON comments(decision_id, created_at)");

  await db.exec("DROP TABLE IF EXISTS resegmentation_flags");
  await db.exec("CREATE TABLE resegmentation_flags (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', volume_id TEXT NOT NULL REFERENCES volumes(id), reported_by TEXT NOT NULL REFERENCES users(id), entry_id TEXT NOT NULL REFERENCES entries(id), problem_type TEXT NOT NULL CHECK(problem_type IN ('incorrect_boundaries', 'merged_documents', 'split_document', 'missing_pages', 'other')), affected_entry_ids TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved')), resolved_by TEXT REFERENCES users(id), resolved_at INTEGER, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS reseg_volume_idx ON resegmentation_flags(volume_id)");

  await db.exec("CREATE TABLE IF NOT EXISTS activity_log (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', user_id TEXT NOT NULL REFERENCES users(id), project_id TEXT REFERENCES projects(id), volume_id TEXT REFERENCES volumes(id), event TEXT NOT NULL CHECK(event IN ('login', 'volume_opened', 'status_changed', 'review_submitted', 'assignment_changed', 'description_status_changed', 'description_assignment_changed', 'resegmentation_flagged', 'comment_added', 'comment_region_moved', 'comment_edited', 'comment_deleted', 'comment_resolved', 'comment_unresolved', 'qc_flag_raised', 'qc_flag_resolved')), detail TEXT, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS al_user_idx ON activity_log(user_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS al_project_idx ON activity_log(project_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS al_created_idx ON activity_log(created_at)");

  // Archival management tables. repositories carries tenant_id NOT
  // NULL FK after id.
  await db.exec("CREATE TABLE IF NOT EXISTS repositories (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, code TEXT NOT NULL, name TEXT NOT NULL, short_name TEXT, country_code TEXT DEFAULT 'COL', country TEXT, city TEXT, address TEXT, website TEXT, notes TEXT, rights_text TEXT, display_title TEXT, subtitle TEXT, hero_image_url TEXT, enabled INTEGER DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, manifest_rights TEXT, attribution_en TEXT, attribution_es TEXT)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS repo_code_idx ON repositories(tenant_id, code)");

  // descriptions carries the union-schema column set: 9 dead
  // columns dropped (related_materials), 6 new + 3 legacy_ids JSON
  // columns added (publication_title, legacy_ids), DACS/RAD
  // additions (admin_biog_history, preferred_citation,
  // acquisition_info, system_of_arrangement,
  // physical_characteristics), local_identifier nullable.
  await db.exec("CREATE TABLE IF NOT EXISTS descriptions (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, repository_id TEXT NOT NULL REFERENCES repositories(id), parent_id TEXT, position INTEGER DEFAULT 0 NOT NULL, root_description_id TEXT, depth INTEGER DEFAULT 0 NOT NULL, child_count INTEGER DEFAULT 0 NOT NULL, path_cache TEXT DEFAULT '', description_level TEXT NOT NULL, resource_type TEXT, genre TEXT DEFAULT '[]', reference_code TEXT NOT NULL, local_identifier TEXT, title TEXT NOT NULL, translated_title TEXT, uniform_title TEXT, date_expression TEXT, date_start TEXT, date_end TEXT, date_certainty TEXT, extent TEXT, dimensions TEXT, medium TEXT, imprint TEXT, edition_statement TEXT, series_statement TEXT, volume_number TEXT, issue_number TEXT, pages TEXT, publication_title TEXT, provenance TEXT, scope_content TEXT, arrangement TEXT, access_conditions TEXT, reproduction_conditions TEXT, language TEXT, location_of_originals TEXT, location_of_copies TEXT, finding_aids TEXT, section_title TEXT, notes TEXT, internal_notes TEXT, creator_display TEXT, place_display TEXT, iiif_manifest_url TEXT, has_digital INTEGER DEFAULT 0, is_published INTEGER DEFAULT 0, last_exported_at INTEGER, admin_biog_history TEXT, preferred_citation TEXT, acquisition_info TEXT, system_of_arrangement TEXT, physical_characteristics TEXT, legacy_ids TEXT NOT NULL DEFAULT '[]', created_by TEXT REFERENCES users(id), updated_by TEXT REFERENCES users(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS desc_parent_pos_idx ON descriptions(parent_id, position)");
  await db.exec("CREATE INDEX IF NOT EXISTS desc_root_idx ON descriptions(root_description_id)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS desc_ref_code_idx ON descriptions(tenant_id, reference_code)");
  await db.exec("CREATE INDEX IF NOT EXISTS desc_repo_idx ON descriptions(repository_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS desc_local_id_idx ON descriptions(local_identifier)");

  // descriptions_fts mirrors drizzle/0075 (the widened global-search
  // column set) with the 0041 trigger shape — direct row deletion in
  // AD/AU, because the external-content "delete command" idiom raises
  // `SQL logic error` on regular FTS5 tables under D1's trusted-schema
  // mode. Kept in lockstep with the migration, like entities_fts and
  // places_fts below.
  await db.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS descriptions_fts USING fts5(reference_code, title, scope_content, notes, legacy_ids, tokenize='unicode61')",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS descriptions_fts_ai AFTER INSERT ON descriptions BEGIN " +
      "INSERT INTO descriptions_fts(rowid, reference_code, title, scope_content, notes, legacy_ids) " +
      "VALUES (new.rowid, new.reference_code, new.title, new.scope_content, new.notes, new.legacy_ids); END",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS descriptions_fts_ad AFTER DELETE ON descriptions BEGIN " +
      "DELETE FROM descriptions_fts WHERE rowid = old.rowid; END",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS descriptions_fts_au AFTER UPDATE ON descriptions BEGIN " +
      "DELETE FROM descriptions_fts WHERE rowid = old.rowid; " +
      "INSERT INTO descriptions_fts(rowid, reference_code, title, scope_content, notes, legacy_ids) " +
      "VALUES (new.rowid, new.reference_code, new.title, new.scope_content, new.notes, new.legacy_ids); END",
  );

  // vocabulary_terms carries federation_id NOT NULL FK (migration 0045):
  // authorities are federation-scoped. The harness builds a fresh table
  // so it can declare the FK inline (production went through ADD COLUMN +
  // backfill because the rebuild pattern is prohibited).
  await db.exec("CREATE TABLE IF NOT EXISTS vocabulary_terms (id TEXT PRIMARY KEY NOT NULL, federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE RESTRICT, canonical TEXT NOT NULL, category TEXT, status TEXT NOT NULL DEFAULT 'approved', merged_into TEXT, entity_count INTEGER NOT NULL DEFAULT 0, proposed_by TEXT REFERENCES users(id) ON DELETE SET NULL, reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL, reviewed_at INTEGER, notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS vt_canonical_idx ON vocabulary_terms(canonical)");
  await db.exec("CREATE INDEX IF NOT EXISTS vt_category_idx ON vocabulary_terms(category)");
  await db.exec("CREATE INDEX IF NOT EXISTS vt_status_idx ON vocabulary_terms(status)");
  await db.exec("CREATE INDEX IF NOT EXISTS vt_federation_idx ON vocabulary_terms(federation_id)");

  // entities carries federation_id NOT NULL FK (migrations 0045-0048):
  // authorities are federation-scoped, and the code index is unique per
  // federation. tenant_id was dropped by 0048.
  // entities.tenant_id (migration 0067) is the OPTIONAL owner: NULL =
  // federation-shared, set = owned by that tenant. Nullable with a real
  // FK and no index, exactly as the migration adds it.
  await db.exec("CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY NOT NULL, federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE RESTRICT, tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT, entity_code TEXT, display_name TEXT NOT NULL, sort_name TEXT NOT NULL, surname TEXT, given_name TEXT, entity_type TEXT NOT NULL, honorific TEXT, primary_function TEXT, primary_function_id TEXT REFERENCES vocabulary_terms(id) ON DELETE SET NULL, name_variants TEXT DEFAULT '[]', dates_of_existence TEXT, date_start TEXT, date_end TEXT, history TEXT, functions TEXT, sources TEXT, merged_into TEXT, wikidata_id TEXT, viaf_id TEXT, dbe_id TEXT, legacy_ids TEXT NOT NULL DEFAULT '[]', notes TEXT, internal_notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS entity_code_idx ON entities(federation_id, entity_code)");
  await db.exec("CREATE INDEX IF NOT EXISTS entity_sort_name_idx ON entities(sort_name)");
  await db.exec("CREATE INDEX IF NOT EXISTS entity_wikidata_idx ON entities(wikidata_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS entity_pf_id_idx ON entities(primary_function_id)");

  // entities_fts mirrors drizzle/0015 (columns) with the 0041 trigger
  // shape, for the same reasons as places_fts below: unicode61 folds
  // diacritics (the entities list's accent-insensitive search
  // contract), and AD/AU must use direct row deletion — the
  // external-content "delete command" idiom raises `SQL logic error`
  // on regular FTS5 tables under D1's trusted-schema mode.
  await db.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(display_name, sort_name, name_variants, tokenize='unicode61')",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS entities_fts_ai AFTER INSERT ON entities BEGIN " +
      "INSERT INTO entities_fts(rowid, display_name, sort_name, name_variants) " +
      "VALUES (new.rowid, new.display_name, new.sort_name, new.name_variants); END",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS entities_fts_ad AFTER DELETE ON entities BEGIN " +
      "DELETE FROM entities_fts WHERE rowid = old.rowid; END",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS entities_fts_au AFTER UPDATE ON entities BEGIN " +
      "DELETE FROM entities_fts WHERE rowid = old.rowid; " +
      "INSERT INTO entities_fts(rowid, display_name, sort_name, name_variants) " +
      "VALUES (new.rowid, new.display_name, new.sort_name, new.name_variants); END",
  );

  await db.exec("CREATE TABLE IF NOT EXISTS entity_functions (id TEXT PRIMARY KEY NOT NULL, entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE, honorific TEXT, function TEXT NOT NULL, date_start TEXT, date_end TEXT, date_note TEXT, certainty TEXT DEFAULT 'probable', source TEXT, notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS ef_entity_idx ON entity_functions(entity_id)");

  // places loses 7 dead columns (historical_gobernacion,
  // historical_partido, historical_region, country_code,
  // admin_level_1, admin_level_2, wikidata_id — all 0% populated)
  // and gains fclass (5-value GeoNames feature class with CHECK
  // enforcement at the DB layer) + legacy_ids JSON.
  // places.tenant_id (migration 0067): same optional owner as entities.
  await db.exec("CREATE TABLE IF NOT EXISTS places (id TEXT PRIMARY KEY NOT NULL, federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE RESTRICT, tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT, place_code TEXT, label TEXT NOT NULL, display_name TEXT NOT NULL, place_type TEXT, name_variants TEXT DEFAULT '[]', parent_id TEXT, latitude REAL, longitude REAL, coordinate_precision TEXT, merged_into TEXT, tgn_id TEXT, hgis_id TEXT, whg_id TEXT, fclass TEXT CHECK (fclass IS NULL OR fclass IN ('P','H','A','T','S')), legacy_ids TEXT NOT NULL DEFAULT '[]', notes TEXT, internal_notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS place_code_idx ON places(federation_id, place_code)");
  await db.exec("CREATE INDEX IF NOT EXISTS place_label_idx ON places(label)");
  await db.exec("CREATE INDEX IF NOT EXISTS place_tgn_idx ON places(tgn_id)");
  // places_fts mirrors drizzle/0015 (columns) with the 0041 trigger
  // shape: the unicode61 tokenizer folds diacritics, which is the
  // accent-insensitive search contract the places list loader relies
  // on (`bogota` matches `Bogotá`). AD/AU use direct row deletion —
  // the external-content "delete command" idiom (0015/0036) raises
  // `SQL logic error` on regular FTS5 tables under D1's defensive
  // trusted-schema mode (the 0041 lesson; miniflare enforces the same
  // mode). cleanDatabase's DELETE FROM places flows through the AD
  // trigger, keeping the index in lockstep.
  await db.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS places_fts USING fts5(label, display_name, name_variants, tokenize='unicode61')",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS places_fts_ai AFTER INSERT ON places BEGIN " +
      "INSERT INTO places_fts(rowid, label, display_name, name_variants) " +
      "VALUES (new.rowid, new.label, new.display_name, new.name_variants); END",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS places_fts_ad AFTER DELETE ON places BEGIN " +
      "DELETE FROM places_fts WHERE rowid = old.rowid; END",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS places_fts_au AFTER UPDATE ON places BEGIN " +
      "DELETE FROM places_fts WHERE rowid = old.rowid; " +
      "INSERT INTO places_fts(rowid, label, display_name, name_variants) " +
      "VALUES (new.rowid, new.label, new.display_name, new.name_variants); END",
  );

  await db.exec("CREATE TABLE IF NOT EXISTS description_entities (id TEXT PRIMARY KEY NOT NULL, description_id TEXT NOT NULL REFERENCES descriptions(id) ON DELETE CASCADE, entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE RESTRICT, role TEXT NOT NULL, role_note TEXT, role_raw TEXT, sequence INTEGER DEFAULT 0 NOT NULL, honorific TEXT, function TEXT, name_as_recorded TEXT, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS de_desc_idx ON description_entities(description_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS de_entity_role_idx ON description_entities(entity_id, role)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS de_unique_idx ON description_entities(description_id, entity_id, role)");

  await db.exec("CREATE TABLE IF NOT EXISTS description_places (id TEXT PRIMARY KEY NOT NULL, description_id TEXT NOT NULL REFERENCES descriptions(id) ON DELETE CASCADE, place_id TEXT NOT NULL REFERENCES places(id) ON DELETE RESTRICT, role TEXT NOT NULL, role_note TEXT, role_raw TEXT, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS dp_desc_idx ON description_places(description_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS dp_place_role_idx ON description_places(place_id, role)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS dp_unique_idx ON description_places(description_id, place_id, role)");

  await db.exec("CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', record_id TEXT NOT NULL, record_type TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), snapshot TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  // Per-tenant unique draft index (migration 0050): two tenants may each
  // hold a draft on the same federation-shared record.
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS drafts_record_idx ON drafts(tenant_id, record_id, record_type)");
  await db.exec("CREATE INDEX IF NOT EXISTS drafts_user_idx ON drafts(user_id)");

  // changelog carries the stewardship-journal columns (migration 0063:
  // run_id + kind) and is append-only at the DB level — the harness
  // installs the same RAISE(ABORT) triggers as production so journal
  // immutability is testable.
  await db.exec("CREATE TABLE IF NOT EXISTS changelog (id TEXT PRIMARY KEY NOT NULL, record_id TEXT NOT NULL, record_type TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), note TEXT, diff TEXT NOT NULL, run_id TEXT, kind TEXT NOT NULL DEFAULT 'update' CHECK (kind IN ('create','update','delete','link','unlink')), created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS changelog_record_idx ON changelog(record_id, record_type, created_at)");
  await db.exec("CREATE INDEX IF NOT EXISTS changelog_run_idx ON changelog(run_id)");
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS changelog_no_update BEFORE UPDATE ON changelog " +
      "BEGIN SELECT RAISE(ABORT, 'changelog is append-only'); END",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS changelog_no_delete BEFORE DELETE ON changelog " +
      "BEGIN SELECT RAISE(ABORT, 'changelog is immutable'); END",
  );

  // stewardship_runs (migration 0062): the commit envelope for bulk
  // operations (import/revert). Lifecycle columns mirror export_runs;
  // revert linkage and profile pointers carry no FK by design.
  await db.exec("CREATE TABLE IF NOT EXISTS stewardship_runs (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, federation_id TEXT REFERENCES federations(id) ON DELETE RESTRICT, kind TEXT NOT NULL CHECK (kind IN ('import','revert')), message TEXT NOT NULL CHECK (length(trim(message)) > 0), justification TEXT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','complete','error')), reverts_run_id TEXT, reverted_by_run_id TEXT, profile_id TEXT, profile_version INTEGER, source_artifact TEXT, report_artifact TEXT, record_counts TEXT, accepted_findings TEXT, workflow_instance_id TEXT, current_step TEXT, steps_completed INTEGER NOT NULL DEFAULT 0, total_steps INTEGER NOT NULL DEFAULT 0, current_step_started_at INTEGER, current_step_completed_at INTEGER, last_heartbeat_at INTEGER, error_message TEXT, started_at INTEGER, completed_at INTEGER, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS stewardship_runs_tenant_idx ON stewardship_runs(tenant_id, created_at)");
  await db.exec("CREATE INDEX IF NOT EXISTS stewardship_runs_status_idx ON stewardship_runs(status)");
  await db.exec("CREATE INDEX IF NOT EXISTS stewardship_runs_reverts_idx ON stewardship_runs(reverts_run_id)");

  // import_profiles (migration 0064): named, per-tenant, versioned
  // mapping profiles; bindings is opaque Zod-validated JSON.
  await db.exec("CREATE TABLE IF NOT EXISTS import_profiles (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, name TEXT NOT NULL CHECK (length(trim(name)) > 0), version INTEGER NOT NULL DEFAULT 1, bindings TEXT NOT NULL, starter_key TEXT, shared_with_federation INTEGER NOT NULL DEFAULT 0 CHECK (shared_with_federation IN (0, 1)), created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, updated_by TEXT REFERENCES users(id) ON DELETE RESTRICT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS import_profiles_tenant_name_unq ON import_profiles(tenant_id, name)");
  await db.exec("CREATE INDEX IF NOT EXISTS import_profiles_tenant_idx ON import_profiles(tenant_id, updated_at)");

  // import_uploads (migration 0065): the metadata row behind every
  // staged CSV upload; run_id FK is safe (runs are never deleted),
  // profile_id is FK-free by design.
  await db.exec("CREATE TABLE IF NOT EXISTS import_uploads (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, filename TEXT NOT NULL, artifact_key TEXT NOT NULL, byte_size INTEGER NOT NULL, row_count INTEGER, headers TEXT, profile_id TEXT, profile_version INTEGER, report_artifact TEXT, check_findings TEXT, check_decisions TEXT, status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','committed','discarded')), run_id TEXT REFERENCES stewardship_runs(id) ON DELETE RESTRICT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS import_uploads_tenant_idx ON import_uploads(tenant_id, created_at)");
  await db.exec("CREATE INDEX IF NOT EXISTS import_uploads_status_idx ON import_uploads(status)");

  // export_runs carries four Cloudflare Workflows tracking columns
  // added in drizzle/0019_export_workflow.sql plus federation_id
  // (migration 0055: nullable-with-FK federation attribution for
  // aggregated publish runs); this harness mirrors them so the test
  // pool stays in sync with app/db/schema.ts.
  await db.exec("CREATE TABLE IF NOT EXISTS export_runs (id TEXT PRIMARY KEY NOT NULL, triggered_by TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'pending', selected_fonds TEXT NOT NULL, selected_types TEXT NOT NULL, federation_id TEXT REFERENCES federations(id), current_step TEXT, steps_completed INTEGER NOT NULL DEFAULT 0, total_steps INTEGER NOT NULL DEFAULT 0, record_counts TEXT, workflow_instance_id TEXT, current_step_started_at INTEGER, current_step_completed_at INTEGER, last_heartbeat_at INTEGER, error_message TEXT, started_at INTEGER, completed_at INTEGER, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS export_runs_status_idx ON export_runs(status)");
  await db.exec("CREATE INDEX IF NOT EXISTS export_runs_created_idx ON export_runs(created_at)");

  // authority_operations (migration 0057): the append-only ledger of
  // authority merge/split/delete, plus the resolve/separate values
  // reserved for the pipeline provenance backfill (spec §10). FKs to
  // federations + users (both RESTRICT); source_id/target_id carry no FK
  // by design. Two BEFORE UPDATE / BEFORE DELETE immutability triggers
  // use the bare RAISE form (workers-sdk #4326 quirk avoidance),
  // mirroring audit_log — so cleanDatabase() drops them, deletes, and
  // re-creates them.
  await db.exec(
    "CREATE TABLE IF NOT EXISTS authority_operations (" +
      "id TEXT PRIMARY KEY NOT NULL, " +
      "federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE RESTRICT, " +
      "record_type TEXT NOT NULL CHECK (record_type IN ('entity','place','vocabulary_term')), " +
      "operation TEXT NOT NULL CHECK (operation IN ('merge','split','delete','resolve','separate')), " +
      "source_id TEXT NOT NULL, " +
      "target_id TEXT, " +
      "user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, " +
      "detail TEXT, " +
      "created_at INTEGER NOT NULL" +
    ")",
  );
  await db.exec("CREATE INDEX IF NOT EXISTS authority_operations_federation_idx ON authority_operations(federation_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS authority_operations_source_idx ON authority_operations(source_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS authority_operations_target_idx ON authority_operations(target_id)");
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS authority_operations_no_update BEFORE UPDATE ON authority_operations " +
      "BEGIN SELECT RAISE(ABORT, 'authority_operations is append-only'); END",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS authority_operations_no_delete BEFORE DELETE ON authority_operations " +
      "BEGIN SELECT RAISE(ABORT, 'authority_operations is immutable'); END",
  );

  // pending_decisions (migration 0069): the ruling queue and its audit
  // trail. FKs to federations/tenants/users are all RESTRICT, so
  // cleanDatabase() wipes this table before it deletes any of those.
  await db.exec(
    "CREATE TABLE IF NOT EXISTS pending_decisions (" +
      "id TEXT PRIMARY KEY, " +
      "federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE RESTRICT, " +
      "tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT, " +
      "kind TEXT NOT NULL, " +
      "payload TEXT NOT NULL DEFAULT '{}', " +
      "source_module TEXT NOT NULL, " +
      "source_ref TEXT, " +
      "status TEXT NOT NULL DEFAULT 'open', " +
      "ruling TEXT, " +
      "ruling_note TEXT, " +
      "result_id TEXT, " +
      "ruled_by TEXT REFERENCES users(id) ON DELETE RESTRICT, " +
      "ruled_at INTEGER, " +
      "filed_by_user_id TEXT REFERENCES users(id), " +
      "created_at INTEGER NOT NULL" +
    ")",
  );
  await db.exec(
    "CREATE INDEX IF NOT EXISTS idx_pending_decisions_queue ON pending_decisions(federation_id, status, kind)",
  );

  // notification_outbox (migration 0074): one pending row per
  // recipient per event, coalesced into a digest by the sweep.
  // Declared after pending_decisions and users, whose FKs it carries
  // (RESTRICT on the decision, CASCADE on the user); cleanDatabase()
  // therefore wipes it before both.
  await db.exec(
    "CREATE TABLE IF NOT EXISTS notification_outbox (" +
      "id TEXT PRIMARY KEY, " +
      "user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, " +
      "kind TEXT NOT NULL, " +
      "decision_id TEXT NOT NULL REFERENCES pending_decisions(id) ON DELETE RESTRICT, " +
      "actor_user_id TEXT REFERENCES users(id), " +
      "created_at INTEGER NOT NULL, " +
      "sent_at INTEGER" +
    ")",
  );
  await db.exec(
    "CREATE INDEX IF NOT EXISTS idx_notification_outbox_pending ON notification_outbox (user_id, sent_at)",
  );

  // external_authority_links (migration 0076): what an outside
  // vocabulary calls a record we already hold. Declared after
  // federations and pending_decisions, whose FKs it carries (both
  // RESTRICT); cleanDatabase() therefore wipes it before both.
  // record_id carries no FK by design — record_type spans three
  // tables. `scheme` has no CHECK: the set of vocabularies is a
  // deployment fact.
  await db.exec(
    "CREATE TABLE IF NOT EXISTS external_authority_links (" +
      "id TEXT PRIMARY KEY, " +
      "federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE RESTRICT, " +
      "record_type TEXT NOT NULL CHECK (record_type IN ('entity','place','vocabulary_term')), " +
      "record_id TEXT NOT NULL, " +
      "scheme TEXT NOT NULL, " +
      "external_id TEXT NOT NULL, " +
      "matched_label TEXT NOT NULL, " +
      "matched_by TEXT NOT NULL CHECK (matched_by IN ('hand-picked','reconciled-confirmed','import')), " +
      "decision_id TEXT REFERENCES pending_decisions(id) ON DELETE RESTRICT, " +
      "status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated','redirected')), " +
      "label_checked_at INTEGER, " +
      "created_at INTEGER NOT NULL, " +
      "updated_at INTEGER NOT NULL" +
    ")",
  );
  await db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS eal_record_scheme_idx ON external_authority_links (record_type, record_id, scheme, external_id)",
  );
  await db.exec(
    "CREATE INDEX IF NOT EXISTS eal_federation_scheme_idx ON external_authority_links (federation_id, scheme)",
  );

  // carried_scopes (migration 0077): a search selection handed forward
  // to the export surface, materialised as a JSON id list at carry
  // time. Declared after tenants and users, whose FKs it carries
  // (tenant RESTRICT, user CASCADE); cleanDatabase() therefore wipes it
  // before both. member_ids carries no FK by design — it spans
  // descriptions, entities and places.
  await db.exec(
    "CREATE TABLE IF NOT EXISTS carried_scopes (" +
      "id TEXT PRIMARY KEY, " +
      "tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, " +
      "user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, " +
      "record_type TEXT NOT NULL CHECK (record_type IN ('records','entities','places')), " +
      "constraint_summary TEXT NOT NULL DEFAULT '{}', " +
      "member_ids TEXT NOT NULL DEFAULT '[]', " +
      "total INTEGER NOT NULL, " +
      "created_at INTEGER NOT NULL, " +
      "consumed_at INTEGER" +
    ")",
  );
  await db.exec(
    "CREATE INDEX IF NOT EXISTS carried_scopes_owner_idx ON carried_scopes (tenant_id, user_id, created_at)",
  );

  // handlists + handlist_members + handlist_shares (migration 0078): the
  // ordered, named, persistent sets a person keeps and works from.
  // Declared after tenants and users, whose FKs they carry (tenant
  // RESTRICT, owner RESTRICT, share user CASCADE); cleanDatabase()
  // therefore wipes all three before both. member_id carries no FK by
  // design — it spans descriptions, entities and places, and a deleted
  // record must stay in the handlist as a tombstone rather than
  // vanishing from it.
  await db.exec(
    "CREATE TABLE IF NOT EXISTS handlists (" +
      "id TEXT PRIMARY KEY, " +
      "tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, " +
      "owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, " +
      "name TEXT NOT NULL, " +
      "description TEXT, " +
      "record_type TEXT CHECK (record_type IS NULL OR record_type IN ('records','entities','places')), " +
      "workspace_visible INTEGER NOT NULL DEFAULT 0, " +
      "created_at INTEGER NOT NULL, " +
      "updated_at INTEGER NOT NULL" +
    ")",
  );
  await db.exec(
    "CREATE INDEX IF NOT EXISTS handlists_owner_idx ON handlists (tenant_id, owner_id)",
  );
  await db.exec(
    "CREATE TABLE IF NOT EXISTS handlist_members (" +
      "id TEXT PRIMARY KEY, " +
      "handlist_id TEXT NOT NULL REFERENCES handlists(id) ON DELETE CASCADE, " +
      "member_id TEXT NOT NULL, " +
      "position INTEGER NOT NULL, " +
      "added_by TEXT REFERENCES users(id) ON DELETE SET NULL, " +
      "created_at INTEGER NOT NULL" +
    ")",
  );
  await db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS handlist_members_member_idx ON handlist_members (handlist_id, member_id)",
  );
  await db.exec(
    "CREATE INDEX IF NOT EXISTS handlist_members_position_idx ON handlist_members (handlist_id, position)",
  );
  await db.exec(
    "CREATE TABLE IF NOT EXISTS handlist_shares (" +
      "id TEXT PRIMARY KEY, " +
      "handlist_id TEXT NOT NULL REFERENCES handlists(id) ON DELETE CASCADE, " +
      "user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, " +
      "role TEXT NOT NULL CHECK (role IN ('viewer','editor')), " +
      "created_at INTEGER NOT NULL" +
    ")",
  );
  await db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS handlist_shares_user_idx ON handlist_shares (handlist_id, user_id)",
  );

  // workspace_export_runs (migration 0079): the self-service export
  // ledger. Distinct from export_runs, which is the publish pipeline's
  // federation-attributed table and is created above. Both FKs RESTRICT
  // (tenant and user), so cleanDatabase() wipes this table before
  // tenants and users. The scope descriptor is stored JSON and is never
  // re-resolved, so no FK reaches into descriptions or handlists.
  await db.exec(
    "CREATE TABLE IF NOT EXISTS workspace_export_runs (" +
      "id TEXT PRIMARY KEY, " +
      "tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, " +
      "user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, " +
      "scope_kind TEXT NOT NULL CHECK (scope_kind IN ('workspace','branch','carried','handlist')), " +
      "scope_descriptor TEXT NOT NULL DEFAULT '{}', " +
      "record_class TEXT CHECK (record_class IS NULL OR record_class IN ('records','entities','places')), " +
      "include_authorities INTEGER NOT NULL DEFAULT 1, " +
      "form TEXT CHECK (form IS NULL OR form IN ('isadg','dacs','rad','dc','canonical')), " +
      "format TEXT CHECK (format IS NULL OR format IN ('csv','ead-xml','json','pdf')), " +
      "status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','cancelled')), " +
      "stage TEXT, " +
      "progress_done INTEGER, " +
      "progress_total INTEGER, " +
      "count_records INTEGER, " +
      "count_entities INTEGER, " +
      "count_places INTEGER, " +
      "file_name TEXT, " +
      "file_size INTEGER, " +
      "r2_key TEXT, " +
      "failure TEXT, " +
      "started_at INTEGER NOT NULL, " +
      "finished_at INTEGER, " +
      "created_at INTEGER NOT NULL" +
    ")",
  );
  await db.exec(
    "CREATE INDEX IF NOT EXISTS workspace_export_runs_tenant_idx ON workspace_export_runs (tenant_id, created_at DESC)",
  );

  // Media pipeline (migrations 0082-0084). Each statement is copied
  // from its migration and run through prepare(), which takes a
  // multi-line statement as it stands, so the copy keeps the
  // migration's layout and is easy to compare line by line. Every
  // table RESTRICTs its tenant, and most RESTRICT descriptions or
  // users, so cleanDatabase() wipes them before those tables.
  for (const statement of MEDIA_PIPELINE_DDL) {
    await db.prepare(statement).run();
  }
  // Capture link (0093), after the pipeline volumes its deliveries name.
  for (const statement of CAPTURE_LINK_DDL) {
    await db.prepare(statement).run();
  }
  // Capture QC (0094), after the deliveries its sets belong to.
  for (const statement of CAPTURE_QC_DDL) {
    await db.prepare(statement).run();
  }

  // Decision threads live in `comments` (decision_id target) since
  // migration 0071 folded the short-lived decision_comments table in.
  // The comments CREATE above carries the post-0071 shape; comments is
  // wiped before pending_decisions (RESTRICT) in cleanDatabase().

  // The 5 domain tables carry a NOT NULL FK to tenants(id). Seed
  // the two locked tenants here so any suite that calls
  // applyMigrations() but doesn't manage tenant rows itself can
  // still INSERT into users/repositories/etc. Tests that need a
  // tenants-empty state DELETE FROM tenants explicitly after
  // applyMigrations(); cleanDatabase() also re-seeds these rows
  // after wiping every domain table.
  await seedTenants();
  // Federations (migration 0044) — seeded AFTER tenants because each
  // federation's lead_tenant_id FK points at a tenant row, and each
  // tenant's federation_id is UPDATE-set to its federation here.
  await seedFederations();

  // OCR pages (0.8.0) -- mirrors drizzle/0085: an external-content index
  // over ocr_pages with 'delete'-command triggers. Kept in lockstep with
  // the migration, like descriptions_fts.
  await db.exec("CREATE TABLE IF NOT EXISTS ocr_pages (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, description_id TEXT NOT NULL REFERENCES descriptions(id) ON DELETE CASCADE, page_seq INTEGER NOT NULL CHECK (page_seq >= 1), text TEXT NOT NULL DEFAULT '', source_key TEXT, alto_key TEXT, run_id TEXT, created_at INTEGER NOT NULL)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ocr_pages_desc_seq_idx ON ocr_pages(description_id, page_seq)");
  await db.exec("CREATE INDEX IF NOT EXISTS ocr_pages_tenant_idx ON ocr_pages(tenant_id)");
  await db.exec("CREATE TABLE IF NOT EXISTS ocr_pages_staging (attempt_id TEXT NOT NULL, run_id TEXT NOT NULL, description_id TEXT NOT NULL, page_seq INTEGER NOT NULL CHECK (page_seq >= 1), tenant_id TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', source_key TEXT, alto_key TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (attempt_id, page_seq))");
  await db.exec("CREATE INDEX IF NOT EXISTS ocr_pages_staging_desc_idx ON ocr_pages_staging(tenant_id, description_id, created_at)");
  await db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS ocr_pages_fts USING fts5(text, content='ocr_pages', content_rowid='rowid', tokenize='unicode61')");
  await db.exec("CREATE TRIGGER IF NOT EXISTS ocr_pages_fts_ai AFTER INSERT ON ocr_pages BEGIN INSERT INTO ocr_pages_fts(rowid, text) VALUES (new.rowid, new.text); END");
  await db.exec("CREATE TRIGGER IF NOT EXISTS ocr_pages_fts_ad AFTER DELETE ON ocr_pages BEGIN INSERT INTO ocr_pages_fts(ocr_pages_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END");
  await db.exec("CREATE TRIGGER IF NOT EXISTS ocr_pages_fts_au AFTER UPDATE OF text ON ocr_pages BEGIN INSERT INTO ocr_pages_fts(ocr_pages_fts, rowid, text) VALUES ('delete', old.rowid, old.text); INSERT INTO ocr_pages_fts(rowid, text) VALUES (new.rowid, new.text); END");

  // Media pipeline publications (migration 0088). Copied statement by
  // statement from the migration, like the other pipeline tables; it
  // RESTRICTs volumes, runs, run volumes, users and tenants, so
  // cleanDatabase() wipes it before all of them.
  for (const statement of PIPELINE_PUBLICATIONS_DDL) {
    await db.prepare(statement).run();
  }
}

/**
 * Cleans all data from tables (order matters due to foreign keys)
 * and re-seeds the two tenant rows so the NOT NULL FKs on
 * users/repositories/descriptions/entities/places resolve
 * immediately.
 *
 * Re-seeding here (rather than asking every test to call
 * seedTenants() in its own beforeEach) keeps the harness backwards-
 * compatible with the 2520+ existing pre-v0.4 tests; they were
 * written against a schema where tenants did not exist, and adding
 * a manual seed call to each one is mechanical churn that adds no
 * signal. Tests that genuinely need a tenants-empty state call
 * seedTenants() themselves; tests that need additional tenants
 * (cross-tenant scenarios) insert them on top of the two seeded
 * rows.
 */
export async function cleanDatabase() {
  const db = env.DB;

  // audit_log immutability triggers prevent DELETE — DROP
  // both, DELETE the rows, then re-CREATE the triggers. This keeps
  // test isolation while honouring the schema-level append-only
  // invariant in production. audit_log is wiped first because its FK
  // to users(id) ON DELETE SET NULL would otherwise quietly clear
  // actor_user_id during the users delete, leaving stale rows.
  await db.exec("DROP TRIGGER IF EXISTS audit_log_no_update");
  await db.exec("DROP TRIGGER IF EXISTS audit_log_no_delete");
  await db.exec("DELETE FROM audit_log");
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log " +
      "WHEN NOT (" +
        "OLD.actor_user_id IS NOT NULL " +
        "AND NEW.actor_user_id IS NULL " +
        "AND OLD.id IS NEW.id " +
        "AND OLD.created_at IS NEW.created_at " +
        "AND OLD.actor_user_id_text IS NEW.actor_user_id_text " +
        "AND OLD.actor_tenant_id IS NEW.actor_tenant_id " +
        "AND OLD.action IS NEW.action " +
        "AND OLD.target_tenant_id IS NEW.target_tenant_id " +
        "AND OLD.target_object_kind IS NEW.target_object_kind " +
        "AND OLD.target_object_id IS NEW.target_object_id " +
        "AND OLD.impersonation_session_id IS NEW.impersonation_session_id " +
        "AND OLD.details IS NEW.details" +
      ") " +
      "BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log " +
      "BEGIN SELECT RAISE(ABORT, 'audit_log is immutable'); END",
  );

  // comments and notification_outbox before pending_decisions: both
  // RESTRICT their decision (0071, 0074). The tables loop below
  // deletes comments again, harmlessly. pending_decisions before
  // federations/tenants/users, whose FKs are all RESTRICT.
  await db.exec("DELETE FROM notification_outbox");
  await db.exec("DELETE FROM comments");
  // external_authority_links RESTRICTs both its decision and its
  // federation (0076), so it goes before pending_decisions here and
  // before federations in the loop below.
  await db.exec("DELETE FROM external_authority_links");
  await db.exec("DELETE FROM pending_decisions");
  // carried_scopes RESTRICTs its tenant (0077), so it goes before
  // tenants — and before users, whose CASCADE would otherwise take the
  // rows out silently rather than by this wipe.
  await db.exec("DELETE FROM carried_scopes");
  // Handlists (0078) RESTRICT both their tenant and their owner, so all
  // three tables go before tenants and users. Members and shares would
  // CASCADE with the handlist, but they are wiped explicitly so a
  // half-migrated harness fails loudly rather than leaving orphans.
  await db.exec("DELETE FROM handlist_members");
  await db.exec("DELETE FROM handlist_shares");
  await db.exec("DELETE FROM handlists");
  // workspace_export_runs (0079) RESTRICTs both its tenant and its user,
  // so it goes before tenants and users. The publish pipeline's
  // export_runs is wiped in the tables loop below; the two are separate
  // ledgers and neither cascades into the other.
  await db.exec("DELETE FROM workspace_export_runs");

  // authority_operations immutability triggers prevent DELETE — same
  // DROP / DELETE / re-CREATE dance as audit_log, and wiped here (before
  // the tables loop below) because its FKs to users + federations
  // (ON DELETE RESTRICT) would otherwise block those deletes.
  await db.exec("DROP TRIGGER IF EXISTS authority_operations_no_update");
  await db.exec("DROP TRIGGER IF EXISTS authority_operations_no_delete");
  await db.exec("DELETE FROM authority_operations");
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS authority_operations_no_update BEFORE UPDATE ON authority_operations " +
      "BEGIN SELECT RAISE(ABORT, 'authority_operations is append-only'); END",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS authority_operations_no_delete BEFORE DELETE ON authority_operations " +
      "BEGIN SELECT RAISE(ABORT, 'authority_operations is immutable'); END",
  );

  // changelog carries the same append-only triggers (migration 0063) and
  // therefore needs the same dance. It was in the tables loop below until
  // a test first left journal rows behind: a BEFORE DELETE trigger fires
  // per ROW, so `DELETE FROM changelog` on an empty table never aborted
  // and the gap stayed invisible. Wiped here, before the loop, because
  // changelog.user_id RESTRICTs users.
  await db.exec("DROP TRIGGER IF EXISTS changelog_no_update");
  await db.exec("DROP TRIGGER IF EXISTS changelog_no_delete");
  await db.exec("DELETE FROM changelog");
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS changelog_no_update BEFORE UPDATE ON changelog " +
      "BEGIN SELECT RAISE(ABORT, 'changelog is append-only'); END",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS changelog_no_delete BEFORE DELETE ON changelog " +
      "BEGIN SELECT RAISE(ABORT, 'changelog is immutable'); END",
  );

  // Break the tenants <-> federations circular FK before deleting either:
  // clear tenants.federation_id so federations has no incoming refs, then
  // the loop can DELETE federations before tenants (D1 enforces FK RESTRICT
  // per-statement with no DEFERRED support, so an un-NULLed federation_id
  // would block both deletes).
  await db.exec("UPDATE tenants SET federation_id = NULL");

  const tables = [
    "export_runs",
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
    // Media pipeline tables (0082-0084), children before parents. They
    // RESTRICT descriptions, users and tenants, so they go before all
    // three. Review items and gate passes RESTRICT runs and declarations,
    // and run volumes RESTRICT declarations, so all three come before
    // pipeline_recipe_declarations.
    // Capture images (0093) RESTRICT their delivery; deliveries RESTRICT
    // pipeline volumes and scanners, and scanners RESTRICT tenants, so all
    // three go before the pipeline.
    // Capture QC (0094): rotations RESTRICT their decision, decisions
    // their set, and sets their delivery, so all four go before the
    // capture link's tables. Fetches (0100) RESTRICT their delivery.
    // Review runs (0103) RESTRICT their delivery, run and volume.
    "capture_review_runs",
    "capture_qc_fetches",
    "capture_qc_rotations",
    "capture_qc_decisions",
    "capture_qc_sets",
    "capture_qc_reviewers",
    "capture_images",
    "capture_deliveries",
    "capture_scanners",
    // Publications (0088) RESTRICT volumes, runs and run volumes, so
    // they go first.
    "pipeline_publications",
    "pipeline_review_items",
    "pipeline_gate_passes",
    "pipeline_run_volumes",
    "pipeline_run_chunks",
    "pipeline_runs",
    "pipeline_volume_pages",
    "pipeline_volumes",
    "pipeline_recipe_declarations",
    // OCR pages (0085) CASCADE with their description but RESTRICT their
    // tenant; wiped explicitly so the order does not rest on the cascade.
    "ocr_pages_staging",
    "ocr_pages",
    "descriptions",
    "places",
    "entities",
    "vocabulary_terms",
    "repositories",
    "projects",
    "magic_links",
    "oauth_handoffs",
    // impersonation_handoffs has FKs to users + tenants ON DELETE
    // RESTRICT, so it MUST be wiped before users and tenants below.
    "impersonation_handoffs",
    // federation_memberships FKs users + federations (CASCADE), wiped
    // before both.
    "federation_memberships",
    "users",
    // federations before tenants: federations.lead_tenant_id references
    // tenants (RESTRICT), and tenants.federation_id was NULLed above, so
    // federations now has no incoming refs and drops cleanly here.
    "federations",
    // tenants last -- every child row must already be gone before
    // tenants can drop with the NOT NULL FKs in place.
    "tenants",
  ];

  for (const table of tables) {
    await db.exec(`DELETE FROM ${table}`);
  }

  // Re-seed the two locked tenant rows so subsequent helper inserts
  // against the 5 domain tables satisfy the tenant_id FK without
  // every existing test having to opt in. Tests that want to verify
  // tenants-empty behaviour must DELETE FROM tenants explicitly after
  // cleanDatabase(). Federations re-seeded after tenants (lead FK +
  // federation_id backfill).
  await seedTenants();
  await seedFederations();
}

/**
 * Locked test tenant id — equal to the seeded `neogranadina` row.
 * Use as the `tenant_id` value on every domain-table insert in
 * tests; the 5 domain tables carry a NOT NULL FK to tenants(id).
 */
export const DEFAULT_TEST_TENANT_ID: string = NEOGRANADINA_TENANT_ID;

/**
 * Locked test federation id — the Neogranadina federation, whose lead is
 * the DEFAULT_TEST_TENANT_ID tenant. Use as the `federation_id` value on
 * authority-table inserts (entities/places/vocabulary_terms) in tests
 * after migrations 0045-0048 lifted those tables to federation scope.
 */
export const DEFAULT_TEST_FEDERATION_ID: string = NEOGRANADINA_FEDERATION_ID;

/**
 * Second tenant id used by cross-tenant negative tests.
 * Deterministic literal so test fixtures are stable across runs and
 * across files; kept distinct from the production-locked PLATFORM
 * and NEOGRANADINA UUIDs. The seed in `seedTenants()` deliberately
 * gives this tenant a mixed capability profile
 * (`crowdsourcing_enabled=0`, `vocabulary_hub_enabled=1`,
 * `publish_pipeline_enabled=0`, `multi_repository_enabled=0`) so
 * capability-off paths can be exercised without flipping the
 * Neogranadina seed row.
 */
export const SECOND_TEST_TENANT_ID = "22222222-2222-4222-8222-222222222222" as const;

/**
 * Seed the two tenant rows (platform + neogranadina) into the test
 * `tenants` table created by `applyMigrations()`. Mirrors the seed
 * INSERTs in drizzle/0034_tenants_table.sql byte-for-byte on UUIDs,
 * kind, descriptive_standard, and capability flags. Uses the current
 * wall clock for created_at/updated_at instead of the migration's
 * fixed timestamp because tests can run repeatedly against a stable
 * harness; the migration's fixed timestamp is for production journal
 * determinism, not for harness behaviour.
 */
export async function seedTenants(): Promise<void> {
  const now = Date.now();
  // Platform tenant -- operator-gate target. All capabilities OFF;
  // descriptive_standard NULL (enforced by the conditional CHECK).
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      PLATFORM_TENANT_ID, "platform", "Platform", "platform", null, "active",
      0, 0, 0, 0,
      null, now, now,
    )
    .run();
  // Neogranadina tenant -- the initial production tenant. All
  // capabilities ON; descriptive_standard='isadg'.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      NEOGRANADINA_TENANT_ID, "neogranadina", "Neogranadina", "tenant", "isadg", "active",
      1, 1, 1, 1,
      null, now, now,
    )
    .run();
  // Second test tenant -- cross-tenant fixture. Mixed
  // capabilities (crowdsourcing OFF, vocabulary_hub ON, publish OFF,
  // multi_repository OFF) so capability-off code paths can be
  // exercised without mutating the Neogranadina row.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      SECOND_TEST_TENANT_ID, "second-tenant", "Second Test Tenant", "tenant", "isadg", "active",
      0, 1, 0, 0,
      null, now, now,
    )
    .run();
  // DACS test tenant -- standard-toggle integration tests. All
  // four capability flags ON; descriptive_standard 'dacs'.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      DACS_TEST_TENANT_ID, "dacs-test", "DACS Test Tenant", "tenant", "dacs", "active",
      1, 1, 1, 1,
      null, now, now,
    )
    .run();
  // RAD test tenant -- standard-toggle integration tests. Same
  // shape as DACS test tenant; descriptive_standard 'rad'.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      RAD_TEST_TENANT_ID, "rad-test", "RAD Test Tenant", "tenant", "rad", "active",
      1, 1, 1, 1,
      null, now, now,
    )
    .run();
}

/**
 * Federation ids for the fixture tenants that are federations-of-one
 * (second-tenant, dacs-test, rad-test). The neogranadina and platform
 * fixtures reuse the production federation ids
 * (NEOGRANADINA_FEDERATION_ID / PLATFORM_FEDERATION_ID). Deterministic
 * literals, distinct from the tenant fixture UUIDs (leading 'f' =
 * federation) so query logs stay debuggable.
 */
export const SECOND_TEST_FEDERATION_ID = "f2222222-2222-4222-8222-222222222222" as const;
export const DACS_TEST_FEDERATION_ID = "f6666666-6666-4666-8666-666666666666" as const;
export const RAD_TEST_FEDERATION_ID = "f7777777-7777-4777-8777-777777777777" as const;
export const DISABLED_TEST_FEDERATION_ID = "f3333333-3333-4333-8333-333333333333" as const;

/**
 * Seed one federation per seeded fixture tenant (federation spec §2 —
 * every tenant belongs to exactly one federation; a standalone tenant is
 * a federation of one). MUST run after seedTenants(): each federation's
 * lead_tenant_id points at a tenant row, and each tenant's federation_id
 * is UPDATE-set here. neogranadina + AMPL-style leads carry
 * multi_member_enabled=1; the rest are federations-of-one (0).
 *
 * `shared_authorities_enabled` (migration 0067) mirrors what the
 * migration leaves in production: 1 for Neogranadina, whose authority
 * space is genuinely shared and whose new records must keep landing in
 * it, and 0 everywhere else. Fixtures that need the other setting flip
 * the single row themselves rather than changing this baseline.
 *
 * The authority code prefixes (migration 0068) mirror it in the same
 * way: 'ne'/'nl' on the Neogranadina federation, whose shared space
 * mints those codes and always has, and NULL on every other fixture
 * federation — NULL being the production truth for an agency that has
 * not been given a prefix, and the state the mint path must refuse to
 * paper over.
 */
export async function seedFederations(): Promise<void> {
  const now = Date.now();
  // [federationId, slug, name, leadTenantId, multiMemberEnabled, sharedAuthoritiesEnabled]
  // [federationId, slug, name, leadTenantId, multiMemberEnabled,
  //  sharedAuthoritiesEnabled, entityCodePrefix, placeCodePrefix]
  const feds: Array<
    [string, string, string, string, number, number, string | null, string | null]
  > = [
    [NEOGRANADINA_FEDERATION_ID, "neogranadina", "Neogranadina", NEOGRANADINA_TENANT_ID, 1, 1, "ne", "nl"],
    [PLATFORM_FEDERATION_ID, "platform", "Platform", PLATFORM_TENANT_ID, 0, 0, null, null],
    [SECOND_TEST_FEDERATION_ID, "second-tenant", "Second Test Federation", SECOND_TEST_TENANT_ID, 0, 0, null, null],
    [DACS_TEST_FEDERATION_ID, "dacs-test", "DACS Test Federation", DACS_TEST_TENANT_ID, 0, 0, null, null],
    [RAD_TEST_FEDERATION_ID, "rad-test", "RAD Test Federation", RAD_TEST_TENANT_ID, 0, 0, null, null],
  ];
  for (const [
    id, slug, name, leadTenantId, multiMember, sharedAuthorities,
    entityCodePrefix, placeCodePrefix,
  ] of feds) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO federations (id, slug, name, lead_tenant_id, status, multi_member_enabled, shared_authorities_enabled, entity_code_prefix, place_code_prefix, created_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id, slug, name, leadTenantId, "active", multiMember, sharedAuthorities,
        entityCodePrefix, placeCodePrefix, now,
      )
      .run();
    await env.DB.prepare("UPDATE tenants SET federation_id = ? WHERE id = ?")
      .bind(id, leadTenantId)
      .run();
  }
}

// Re-export DACS/RAD test tenant ids for convenience so test files
// that already import from `tests/helpers/db` get the new fixtures
// without hopping through `app/lib/tenant`.
export { DACS_TEST_TENANT_ID, RAD_TEST_TENANT_ID } from "../../app/lib/tenant";

/**
 * Disabled-tenant fixture: a tenant row with `disabled_at` set.
 * Opt-in via explicit `await seedDisabledTenant()` so the
 * five-tenant count assertion in `seedTenants()` is preserved
 * (this helper only inserts when called explicitly).
 *
 * Use this fixture from tests that exercise the
 * `getTenantFromRequest` disabled-tenant 404 branch, the
 * `/operator/*` carve-out, or the tenant-detail re-enable path.
 */
export const DISABLED_TEST_TENANT_ID = "33333333-3333-4333-8333-333333333333" as const;
export const DISABLED_TEST_TENANT_SLUG = "disabled-tenant" as const;

export async function seedDisabledTenant(): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, disabled_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      DISABLED_TEST_TENANT_ID,
      DISABLED_TEST_TENANT_SLUG,
      "Disabled Test Tenant",
      "tenant",
      "isadg",
      "active",
      0, 1, 1, 0,
      null,
      now - 1000, // disabled 1 second ago
      now,
      now,
    )
    .run();
  // Federation-of-one for the disabled tenant (every tenant has a
  // federation). Insert the federation (lead = the disabled tenant, which
  // exists by now) then point the tenant's federation_id at it.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO federations (id, slug, name, lead_tenant_id, status, multi_member_enabled, created_at) " +
      "VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      DISABLED_TEST_FEDERATION_ID,
      DISABLED_TEST_TENANT_SLUG,
      "Disabled Test Federation",
      DISABLED_TEST_TENANT_ID,
      "active",
      0,
      now,
    )
    .run();
  await env.DB.prepare("UPDATE tenants SET federation_id = ? WHERE id = ?")
    .bind(DISABLED_TEST_FEDERATION_ID, DISABLED_TEST_TENANT_ID)
    .run();
}

/**
 * Operator-user fixture: a user living in the platform tenant.
 * Mirrors the shape the login-as flow writes for production
 * operator accounts: tenantId=PLATFORM_TENANT_ID,
 * isSuperAdmin=true, isUserManager=true. The fixture is opt-in via
 * explicit `await seedOperatorUser()` so user-count assertions in
 * tests that don't care about operators stay green.
 */
export const OPERATOR_TEST_USER_ID = "44444444-4444-4444-8444-444444444444" as const;
export const OPERATOR_TEST_EMAIL = "operator@example.test" as const;

export async function seedOperatorUser(): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, tenant_id, email, name, is_admin, is_super_admin, " +
      "is_collab_admin, is_archive_user, is_user_manager, is_cataloguer, " +
      "last_active_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      OPERATOR_TEST_USER_ID,
      PLATFORM_TENANT_ID,
      OPERATOR_TEST_EMAIL,
      "Test Operator",
      1, 1, 0, 0, 1, 0,
      null, now, now,
    )
    .run();
}

/**
 * The media pipeline tables, statement by statement, as their
 * migrations create them (0082 recipe declarations, volumes and pages;
 * 0083 runs, chunks and run volumes; 0084 review items and gate
 * passes). The page table's `sha256` column, which 0092 adds, is
 * declared inline after `pdf_page`, where its ADD COLUMN puts it, so the
 * statements stay safe to run twice. The gate passes carry 0105's `note`
 * and `carried_from` inline at the end. The runs table is as 0102 rebuilds
 * it, taking a review run with no purpose and no user, and the run
 * volumes carry 0103's `review_purge` inline at the end, where its ADD
 * COLUMN puts it. `applyMigrations()` runs them in this order, after every
 * table they reference.
 */
const MEDIA_PIPELINE_DDL: readonly string[] = [
  // 0082
  `CREATE TABLE IF NOT EXISTS pipeline_recipe_declarations (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  scope_description_id TEXT NOT NULL REFERENCES descriptions(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  platen TEXT NOT NULL CHECK (platen IN ('v','none')),
  background TEXT NOT NULL CHECK (background IN ('dark','light')),
  output_class TEXT NOT NULL CHECK (output_class IN ('tonal','bilevel')),
  ocr INTEGER NOT NULL DEFAULT 0,
  ocr_lang TEXT,
  tone_preset TEXT NOT NULL,
  advanced_params TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(advanced_params)),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  CHECK (ocr = 0 OR output_class = 'bilevel'),
  CHECK (ocr = 0 OR ocr_lang IS NOT NULL),
  UNIQUE (tenant_id, scope_description_id, version)
)`,
  `CREATE TABLE IF NOT EXISTS pipeline_volumes (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  description_id TEXT NOT NULL REFERENCES descriptions(id) ON DELETE RESTRICT,
  reference_code TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('volume_run','item_pdf')),
  state TEXT NOT NULL DEFAULT 'received' CHECK (state IN ('received','prepared','ready','published')),
  masters_backend TEXT NOT NULL CHECK (masters_backend IN ('b2','r2')),
  masters_endpoint TEXT NOT NULL,
  masters_bucket TEXT NOT NULL,
  masters_prefix TEXT,
  masters_key TEXT,
  checksums_key TEXT,
  expected_count INTEGER NOT NULL CHECK (expected_count >= 1),
  recipe_scope_description_id TEXT NOT NULL REFERENCES descriptions(id) ON DELETE RESTRICT,
  restricted INTEGER NOT NULL DEFAULT 0 CHECK (restricted IN (0,1)),
  restriction_checked_at INTEGER,
  current_tile_root TEXT,
  open_review_count INTEGER NOT NULL DEFAULT 0,
  last_run_id TEXT,
  held_by_run_id TEXT,
  last_error TEXT CHECK (last_error IS NULL OR json_valid(last_error)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  pages_revision INTEGER NOT NULL DEFAULT 0,
  CHECK ((kind = 'volume_run' AND masters_prefix IS NOT NULL AND masters_key IS NULL)
      OR (kind = 'item_pdf'   AND masters_key IS NOT NULL AND masters_prefix IS NULL)),
  UNIQUE (tenant_id, reference_code),
  UNIQUE (tenant_id, description_id)
)`,
  "CREATE INDEX IF NOT EXISTS pipeline_volumes_state_idx ON pipeline_volumes (tenant_id, state)",
  "CREATE INDEX IF NOT EXISTS pipeline_volumes_held_idx ON pipeline_volumes (tenant_id, held_by_run_id)",
  `CREATE TABLE IF NOT EXISTS pipeline_volume_pages (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  pipeline_volume_id TEXT NOT NULL REFERENCES pipeline_volumes(id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  page_key TEXT NOT NULL CHECK (
    length(page_key) > 0
    AND substr(page_key, 1, 1) GLOB '[A-Za-z0-9_-]'
    AND page_key NOT GLOB '*[^A-Za-z0-9._-]*'),
  master_key TEXT CHECK (master_key IS NULL OR length(master_key) > 0),
  pdf_page INTEGER CHECK (pdf_page IS NULL OR pdf_page >= 1),
  sha256 TEXT CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  CHECK ((master_key IS NOT NULL AND pdf_page IS NULL)
      OR (master_key IS NULL AND pdf_page IS NOT NULL)),
  UNIQUE (pipeline_volume_id, seq),
  UNIQUE (pipeline_volume_id, page_key)
)`,
  // 0083
  `CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  federation_id TEXT REFERENCES federations(id) ON DELETE RESTRICT,
  user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('volume_run','item_pdf','review_run')),
  purpose TEXT CHECK (purpose IS NULL OR purpose IN ('sample','wave')),
  regenerates_run_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','dispatched','running','completed','halted','error','cancelled')),
  runner_image TEXT NOT NULL CHECK (
    length(runner_image) > 72
    AND substr(runner_image, -72, 8) = '@sha256:'
    AND substr(runner_image, -64) NOT GLOB '*[^0-9a-f]*'),
  script_version TEXT NOT NULL CHECK (length(trim(script_version)) > 0),
  arch TEXT NOT NULL CHECK (arch = 'x64'),
  max_review_frac REAL NOT NULL CHECK (max_review_frac >= 0 AND max_review_frac <= 1),
  spec_key TEXT NOT NULL,
  spec_sha256 TEXT NOT NULL CHECK (length(spec_sha256) = 64),
  spec_url_expires_at INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL CHECK (chunk_count >= 1),
  volume_count INTEGER NOT NULL CHECK (volume_count >= 1),
  volumes_reported INTEGER NOT NULL DEFAULT 0,
  callback_token_hash TEXT NOT NULL CHECK (length(callback_token_hash) = 64),
  token_expires_at INTEGER NOT NULL,
  token_revoked_at INTEGER,
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  completed_at INTEGER,
  CHECK (spec_url_expires_at < token_expires_at),
  CHECK ((status IN ('pending','dispatched','running') AND token_revoked_at IS NULL)
      OR (status IN ('completed','error','cancelled') AND token_revoked_at IS NOT NULL)
      OR status = 'halted'),
  CHECK ((kind = 'review_run') = (purpose IS NULL)),
  CHECK (kind = 'review_run' OR user_id IS NOT NULL)
)`,
  "CREATE INDEX IF NOT EXISTS pipeline_runs_tenant_idx ON pipeline_runs (tenant_id, created_at)",
  "CREATE INDEX IF NOT EXISTS pipeline_runs_open_idx ON pipeline_runs (token_revoked_at, token_expires_at)",
  `CREATE TABLE IF NOT EXISTS pipeline_run_chunks (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','dispatched','failed','not_sent','completed')),
  dispatch_error TEXT CHECK (dispatch_error IS NULL OR json_valid(dispatch_error)),
  claim_id TEXT,
  idempotency_key TEXT,
  body_sha256 TEXT,
  stored_response TEXT,
  attempt TEXT,
  conclusion TEXT CHECK (conclusion IS NULL OR conclusion IN ('success','failure','cancelled')),
  unreported_volume_ids TEXT CHECK (unreported_volume_ids IS NULL OR json_valid(unreported_volume_ids)),
  dispatched_at INTEGER,
  reported_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, chunk_index)
)`,
  `CREATE TABLE IF NOT EXISTS pipeline_run_volumes (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  pipeline_volume_id TEXT NOT NULL REFERENCES pipeline_volumes(id) ON DELETE RESTRICT,
  declaration_id TEXT NOT NULL REFERENCES pipeline_recipe_declarations(id) ON DELETE RESTRICT,
  job_index INTEGER NOT NULL CHECK (job_index >= 0),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  reference_code TEXT NOT NULL,
  tile_root TEXT NOT NULL,
  expected_count INTEGER NOT NULL CHECK (expected_count >= 1),
  resolved_recipe TEXT NOT NULL CHECK (json_valid(resolved_recipe)),
  status TEXT NOT NULL DEFAULT 'dispatched'
    CHECK (status IN ('dispatched','prepared','review_pending','aborted','halted')),
  claim_id TEXT,
  idempotency_key TEXT,
  body_sha256 TEXT,
  stored_response TEXT,
  attempt TEXT,
  runner_versions TEXT,
  stages TEXT,
  qc TEXT,
  verification TEXT,
  flags_count INTEGER,
  flags TEXT CHECK (flags IS NULL OR json_valid(flags)),
  flags_truncated INTEGER NOT NULL DEFAULT 0,
  flags_ingested_at INTEGER,
  flags_ingest_attempts INTEGER NOT NULL DEFAULT 0 CHECK (flags_ingest_attempts >= 0),
  tiles_bytes INTEGER,
  ocr_bytes INTEGER,
  elapsed_s REAL,
  manifest_key TEXT,
  report_key TEXT,
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  reported_at INTEGER,
  created_at INTEGER NOT NULL,
  review_purge TEXT CHECK (review_purge IS NULL OR json_valid(review_purge)),
  UNIQUE (run_id, pipeline_volume_id)
)`,
  "CREATE INDEX IF NOT EXISTS pipeline_run_volumes_volume_idx ON pipeline_run_volumes (pipeline_volume_id, created_at)",
  "CREATE INDEX IF NOT EXISTS pipeline_run_volumes_chunk_idx ON pipeline_run_volumes (run_id, chunk_index, status)",
  "CREATE INDEX IF NOT EXISTS pipeline_run_volumes_flags_idx ON pipeline_run_volumes (flags_truncated, flags_ingested_at)",
  // 0084
  `CREATE TABLE IF NOT EXISTS pipeline_review_items (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  pipeline_volume_id TEXT NOT NULL REFERENCES pipeline_volumes(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  page_key TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('preprocess','render','ocr','tile')),
  code TEXT NOT NULL,
  summary TEXT NOT NULL,
  declaration_id TEXT NOT NULL,
  declaration_version INTEGER NOT NULL,
  script_version TEXT NOT NULL,
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('accept','amend','accept_with_record')),
  verdict_note TEXT,
  verdict_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
  verdict_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, pipeline_volume_id, page_key, stage, code)
)`,
  `CREATE INDEX IF NOT EXISTS pipeline_review_items_open_idx
  ON pipeline_review_items (tenant_id, pipeline_volume_id) WHERE verdict IS NULL`,
  `CREATE TABLE IF NOT EXISTS pipeline_gate_passes (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  declaration_id TEXT NOT NULL REFERENCES pipeline_recipe_declarations(id) ON DELETE RESTRICT,
  script_version TEXT NOT NULL,
  sample_run_id TEXT,
  passed_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  passed_at INTEGER NOT NULL,
  note TEXT,
  carried_from TEXT,
  UNIQUE (declaration_id, script_version)
)`,
];

/**
 * The publication ledger, statement by statement, as migrations 0088
 * and 0089 leave it (0089's two columns declared inline, last, where
 * its ADD COLUMNs put them), and the slug freeze trigger from 0091.
 * `applyMigrations()` runs it last, after the run tables it references.
 */
const PIPELINE_PUBLICATIONS_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS pipeline_publications (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  pipeline_volume_id TEXT NOT NULL REFERENCES pipeline_volumes(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  run_volume_id TEXT NOT NULL REFERENCES pipeline_run_volumes(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('claimed','copying','published','failed','abandoned')),
  claim_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  canonical_expect TEXT NOT NULL CHECK (json_valid(canonical_expect)),
  description_before TEXT CHECK (description_before IS NULL OR json_valid(description_before)),
  previous_catalogue_url TEXT,
  previous_manifest_sha256 TEXT,
  previous_manifest_etag TEXT,
  previous_manifest_copy_key TEXT,
  previous_image_roots TEXT CHECK (previous_image_roots IS NULL OR json_valid(previous_image_roots)),
  retirement_status TEXT NOT NULL DEFAULT 'none' CHECK (retirement_status IN ('none','pending')),
  ocr_pages_written INTEGER,
  ocr_bytes_read INTEGER,
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  needs_person INTEGER NOT NULL DEFAULT 0 CHECK (needs_person IN (0,1)),
  resolve_attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER NOT NULL,
  copying_at INTEGER,
  published_at INTEGER,
  finished_at INTEGER,
  previous_ocr_copy_key TEXT,
  previous_ocr_sha256 TEXT CHECK (previous_ocr_sha256 IS NULL OR length(previous_ocr_sha256) = 64),
  CHECK ((status = 'published') = (published_at IS NOT NULL)),
  CHECK (status <> 'copying' OR copying_at IS NOT NULL)
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS pipeline_publications_in_flight
  ON pipeline_publications (pipeline_volume_id) WHERE status IN ('claimed','copying')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS pipeline_publications_published
  ON pipeline_publications (pipeline_volume_id) WHERE status = 'published'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS pipeline_publications_canonical_key
  ON pipeline_publications (canonical_key) WHERE status IN ('claimed','copying','published')`,
  `CREATE INDEX IF NOT EXISTS pipeline_publications_tenant_idx
  ON pipeline_publications (tenant_id, status, claimed_at)`,
  `CREATE INDEX IF NOT EXISTS pipeline_publications_stalled_idx
  ON pipeline_publications (needs_person, resolve_attempts, status, copying_at, claimed_at)
  WHERE status IN ('claimed','copying')`,
  // The slug freeze (0091), here because it reads the run tables: a
  // tenant's slug cannot change once it has a volume in any run.
  `CREATE TRIGGER IF NOT EXISTS tenants_slug_frozen
  BEFORE UPDATE OF slug ON tenants
  WHEN NEW.slug IS NOT OLD.slug
    AND EXISTS (SELECT 1 FROM pipeline_run_volumes WHERE tenant_id = OLD.id)
  BEGIN
    SELECT RAISE(ABORT, 'tenant_slug_frozen: the tenant has pipeline output under its slug');
  END`,
];

/**
 * The capture link's scanners and deliveries, statement by statement,
 * as migration 0093 creates them and 0095 rebuilds the deliveries, with
 * their route, a scanner only for a link delivery, and their openings,
 * and 0104's `review_declined_at` and 0110's `rejected_records` inline
 * at the end, in that order, where their ADD COLUMNs put them, as
 * 0109's `rotate_deg` is at the end of the images' columns.
 * `applyMigrations()` runs them after
 * the pipeline volumes a delivery names.
 */
const CAPTURE_LINK_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS capture_scanners (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 32 AND name NOT GLOB '*[^a-z0-9-]*'),
  token_sha256 TEXT CHECK (token_sha256 IS NULL OR (length(token_sha256) = 64 AND token_sha256 NOT GLOB '*[^0-9a-f]*')),
  token_created_at INTEGER,
  last_seen_at INTEGER,
  revoked_at INTEGER,
  rate_window_start INTEGER,
  rate_window_calls INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  write_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (token_sha256 IS NOT NULL OR revoked_at IS NULL)
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS capture_scanners_tenant_idx ON capture_scanners (tenant_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS capture_scanners_token_idx ON capture_scanners (token_sha256)`,
  `CREATE TABLE IF NOT EXISTS capture_deliveries (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('link','file')),
  scanner_id TEXT REFERENCES capture_scanners(id) ON DELETE RESTRICT,
  reference_code TEXT,
  pipeline_volume_id TEXT REFERENCES pipeline_volumes(id) ON DELETE RESTRICT,
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64 AND body_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('received','registered','refused','superseded')),
  problems TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(problems)),
  answer_status INTEGER NOT NULL,
  answer_body TEXT NOT NULL CHECK (json_valid(answer_body)),
  records TEXT CHECK (records IS NULL OR json_valid(records)),
  openings INTEGER NOT NULL CHECK (openings >= 0),
  received_at INTEGER NOT NULL,
  superseded_by TEXT,
  superseded_at INTEGER,
  seq INTEGER NOT NULL,
  write_id TEXT,
  review_declined_at INTEGER,
  rejected_records INTEGER NOT NULL DEFAULT 0 CHECK (rejected_records >= 0),
  PRIMARY KEY (tenant_id, id),
  CHECK ((route = 'link') = (scanner_id IS NOT NULL)),
  CHECK ((state = 'superseded') = (superseded_by IS NOT NULL)),
  CHECK (state NOT IN ('registered','superseded') OR pipeline_volume_id IS NOT NULL)
)`,
  `CREATE INDEX IF NOT EXISTS capture_deliveries_ref_idx ON capture_deliveries (tenant_id, reference_code, received_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS capture_deliveries_seq_idx ON capture_deliveries (tenant_id, seq)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS capture_deliveries_holder_idx ON capture_deliveries (tenant_id, pipeline_volume_id)
  WHERE state = 'registered'`,
  `CREATE TABLE IF NOT EXISTS capture_images (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  delivery_id TEXT NOT NULL,
  captua_record_id INTEGER NOT NULL,
  capture_id TEXT NOT NULL,
  pair_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('left','right','single')),
  page_key TEXT NOT NULL,
  capture_key TEXT NOT NULL,
  capture_sha256 TEXT NOT NULL CHECK (length(capture_sha256) = 64 AND capture_sha256 NOT GLOB '*[^0-9a-f]*'),
  capture_bytes INTEGER,
  preview_key TEXT,
  preview_sha256 TEXT CHECK (preview_sha256 IS NULL OR (length(preview_sha256) = 64 AND preview_sha256 NOT GLOB '*[^0-9a-f]*')),
  preview_bytes INTEGER,
  record_status TEXT CHECK (record_status IS NULL OR record_status IN ('captured','in_review','approved','rejected')),
  rotate_deg INTEGER CHECK (rotate_deg IS NULL OR rotate_deg IN (0, 90, 180, 270)),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES capture_deliveries(tenant_id, id) ON DELETE RESTRICT,
  CHECK ((preview_key IS NULL) = (preview_sha256 IS NULL))
)`,
  `CREATE INDEX IF NOT EXISTS capture_images_delivery_idx ON capture_images (tenant_id, delivery_id)`,
];

/**
 * Capture QC's decision sets, decisions, rotations and reviewers,
 * statement by statement, as migration 0094 creates them and 0096
 * gives the rotations their key, which includes the image's role; and,
 * as 0100 adds them, the set's `carried_from`, the decision's
 * `set_revision`, the unit's fetches and the images' index by record.
 * The images' `record_status` (0100) is in the capture link's table.
 * The review runs of a delivery (0103) close the list. `applyMigrations()` runs them after the
 * capture link's tables.
 */
const CAPTURE_QC_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS capture_qc_sets (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  delivery_id TEXT NOT NULL,
  pipeline_volume_id TEXT NOT NULL REFERENCES pipeline_volumes(id) ON DELETE RESTRICT,
  decisions_id TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  opening_count INTEGER NOT NULL CHECK (opening_count >= 1),
  decided_count INTEGER NOT NULL DEFAULT 0,
  approved_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  notes_bytes INTEGER NOT NULL DEFAULT 0 CHECK (notes_bytes <= 1000000),
  state TEXT NOT NULL CHECK (state IN ('in_capture_qc','retakes_requested','approved')),
  state_entered_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  carried_from TEXT,
  PRIMARY KEY (tenant_id, delivery_id),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES capture_deliveries(tenant_id, id) ON DELETE RESTRICT,
  CHECK (approved_count + rejected_count = decided_count AND decided_count <= opening_count)
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS capture_qc_sets_decisions_idx ON capture_qc_sets (tenant_id, decisions_id)`,
  `CREATE INDEX IF NOT EXISTS capture_qc_sets_volume_idx ON capture_qc_sets (tenant_id, pipeline_volume_id)`,
  `CREATE TABLE IF NOT EXISTS capture_qc_decisions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  delivery_id TEXT NOT NULL,
  captua_record_id INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('blur','glare','shadow','focus','exposure','dirt','framing','obstruction','other')),
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  decided_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decided_by_name TEXT NOT NULL CHECK (length(decided_by_name) BETWEEN 1 AND 256),
  decided_at INTEGER NOT NULL,
  set_revision INTEGER NOT NULL DEFAULT 0,
  side TEXT CHECK (side IS NULL OR side IN ('left','right','both')) CHECK (side IS NULL OR decision = 'rejected'),
  PRIMARY KEY (tenant_id, delivery_id, captua_record_id),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES capture_qc_sets(tenant_id, delivery_id) ON DELETE RESTRICT,
  CHECK ((decision = 'rejected') = (reason IS NOT NULL)),
  CHECK (reason IS NOT 'other' OR note IS NOT NULL)
)`,
  `CREATE TABLE IF NOT EXISTS capture_qc_rotations (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  delivery_id TEXT NOT NULL,
  captua_record_id INTEGER NOT NULL,
  capture_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('left','right','single')),
  quarter_turns INTEGER NOT NULL CHECK (quarter_turns BETWEEN 1 AND 3),
  PRIMARY KEY (tenant_id, delivery_id, captua_record_id, capture_id, role),
  FOREIGN KEY (tenant_id, delivery_id, captua_record_id)
    REFERENCES capture_qc_decisions(tenant_id, delivery_id, captua_record_id) ON DELETE RESTRICT
)`,
  `CREATE TABLE IF NOT EXISTS capture_qc_reviewers (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  pipeline_volume_id TEXT NOT NULL REFERENCES pipeline_volumes(id) ON DELETE RESTRICT,
  reviewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, pipeline_volume_id)
)`,
  `CREATE INDEX IF NOT EXISTS capture_qc_reviewers_reviewer_idx ON capture_qc_reviewers (tenant_id, reviewer_id)`,
  `CREATE TABLE IF NOT EXISTS capture_qc_fetches (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  delivery_id TEXT NOT NULL,
  decisions_id TEXT NOT NULL,
  set_revision INTEGER NOT NULL,
  first_fetched_at INTEGER NOT NULL,
  last_fetched_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, decisions_id),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES capture_deliveries(tenant_id, id) ON DELETE RESTRICT,
  CHECK (last_fetched_at >= first_fetched_at)
)`,
  `CREATE INDEX IF NOT EXISTS capture_qc_fetches_delivery_idx ON capture_qc_fetches (tenant_id, delivery_id, set_revision)`,
  `CREATE INDEX IF NOT EXISTS capture_images_record_idx ON capture_images (tenant_id, delivery_id, captua_record_id)`,
  // 0103
  `CREATE TABLE IF NOT EXISTS capture_review_runs (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  delivery_id TEXT NOT NULL,
  pipeline_volume_id TEXT NOT NULL REFERENCES pipeline_volumes(id) ON DELETE RESTRICT,
  review_prefix TEXT NOT NULL CHECK (length(review_prefix) > 1 AND substr(review_prefix, -1) = '/'),
  status TEXT NOT NULL DEFAULT 'dispatched'
    CHECK (status IN ('dispatched','review_ready','aborted','halted')),
  claim_id TEXT,
  idempotency_key TEXT,
  body_sha256 TEXT,
  stored_response TEXT,
  attempt TEXT,
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  tiles_bytes INTEGER,
  report_key TEXT,
  reported_at INTEGER,
  created_at INTEGER NOT NULL,
  purge_status TEXT CHECK (purge_status IS NULL OR purge_status IN ('purged','failed')),
  purged_at INTEGER,
  PRIMARY KEY (tenant_id, run_id, pipeline_volume_id),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES capture_deliveries(tenant_id, id) ON DELETE RESTRICT,
  CHECK ((purge_status IS 'purged') = (purged_at IS NOT NULL))
)`,
  `CREATE INDEX IF NOT EXISTS capture_review_runs_delivery_idx ON capture_review_runs (tenant_id, delivery_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS capture_review_runs_volume_idx ON capture_review_runs (tenant_id, pipeline_volume_id, created_at)`,
];

// @version v0.8.0
