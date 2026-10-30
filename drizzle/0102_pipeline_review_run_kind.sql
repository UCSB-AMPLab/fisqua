-- Media pipeline: the review run as a kind of run.
--
-- This migration adds the review run as a kind of pipeline run. When
-- Fisqua registers a capture delivery it starts a review run, which
-- tiles the delivery's previews as captured into the federation's
-- review-tiles bucket for capture QC. The review run is a pipeline run
-- like any other as far as the run ledger is concerned: it has a spec, a
-- callback token, dispatch chunks and an expiry, so it is a row of
-- `pipeline_runs`. It differs in three ways, which this migration makes
-- the table accept:
--
--   - `kind` takes `review_run` beside `volume_run` and `item_pdf`;
--   - `purpose` (sample or wave) is null exactly for a review run, which
--     needs no gate and publishes nothing;
--   - `user_id` may be null for a review run, which a delivery over the
--     link starts with no person behind it. Every other kind still names
--     the user who started it.
--
-- What a review run did with each volume is not written to
-- `pipeline_run_volumes`: that table is what the capture QC hold, the
-- open-run checks and the processing states read, and a review run must
-- move none of them. Migration 0103 adds the review run's own table.
--
-- SQLite cannot change a CHECK in place, so `pipeline_runs` is rebuilt.
-- Four tables reference it with ON DELETE RESTRICT (`pipeline_run_chunks`,
-- `pipeline_run_volumes`, `pipeline_review_items` and
-- `pipeline_publications`, which also references `pipeline_run_volumes`),
-- and RESTRICT acts at once, without regard to `defer_foreign_keys`, so
-- the parent cannot be dropped under populated children. All five are
-- therefore rebuilt together, as 0095 rebuilt the capture tables: each
-- is copied to a plain holding table; the children are dropped, then the
-- parent; each is created again, parent first, with its definition
-- unchanged except for the three changes above (`pipeline_publications`
-- with the two columns 0089 added, in the place ADD COLUMN put them);
-- each is filled from its holding table with explicit column lists; and
-- the holding tables are dropped. Every index is created again under its
-- own name. The `tenants_slug_frozen` trigger (0091) reads
-- `pipeline_run_volumes` by name and is untouched. The file runs as one
-- D1 transaction, so a failure leaves the tables as they were.
--
-- Version: v0.8.0

CREATE TABLE pipeline_runs_hold AS SELECT * FROM pipeline_runs;
--> statement-breakpoint
CREATE TABLE pipeline_run_chunks_hold AS SELECT * FROM pipeline_run_chunks;
--> statement-breakpoint
CREATE TABLE pipeline_run_volumes_hold AS SELECT * FROM pipeline_run_volumes;
--> statement-breakpoint
CREATE TABLE pipeline_review_items_hold AS SELECT * FROM pipeline_review_items;
--> statement-breakpoint
CREATE TABLE pipeline_publications_hold AS SELECT * FROM pipeline_publications;
--> statement-breakpoint
DROP TABLE pipeline_publications;
--> statement-breakpoint
DROP TABLE pipeline_review_items;
--> statement-breakpoint
DROP TABLE pipeline_run_volumes;
--> statement-breakpoint
DROP TABLE pipeline_run_chunks;
--> statement-breakpoint
DROP TABLE pipeline_runs;
--> statement-breakpoint
CREATE TABLE pipeline_runs (
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
);
--> statement-breakpoint
CREATE INDEX pipeline_runs_tenant_idx ON pipeline_runs (tenant_id, created_at);
--> statement-breakpoint
CREATE INDEX pipeline_runs_open_idx ON pipeline_runs (token_revoked_at, token_expires_at);
--> statement-breakpoint
CREATE TABLE pipeline_run_chunks (
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
);
--> statement-breakpoint
CREATE TABLE pipeline_run_volumes (
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
  UNIQUE (run_id, pipeline_volume_id)
);
--> statement-breakpoint
CREATE INDEX pipeline_run_volumes_volume_idx ON pipeline_run_volumes (pipeline_volume_id, created_at);
--> statement-breakpoint
CREATE INDEX pipeline_run_volumes_chunk_idx ON pipeline_run_volumes (run_id, chunk_index, status);
--> statement-breakpoint
CREATE INDEX pipeline_run_volumes_flags_idx ON pipeline_run_volumes (flags_truncated, flags_ingested_at);
--> statement-breakpoint
CREATE TABLE pipeline_review_items (
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
);
--> statement-breakpoint
CREATE INDEX pipeline_review_items_open_idx
  ON pipeline_review_items (tenant_id, pipeline_volume_id) WHERE verdict IS NULL;
--> statement-breakpoint
CREATE TABLE pipeline_publications (
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX pipeline_publications_in_flight
  ON pipeline_publications (pipeline_volume_id) WHERE status IN ('claimed','copying');
--> statement-breakpoint
CREATE UNIQUE INDEX pipeline_publications_published
  ON pipeline_publications (pipeline_volume_id) WHERE status = 'published';
--> statement-breakpoint
CREATE UNIQUE INDEX pipeline_publications_canonical_key
  ON pipeline_publications (canonical_key) WHERE status IN ('claimed','copying','published');
--> statement-breakpoint
CREATE INDEX pipeline_publications_tenant_idx
  ON pipeline_publications (tenant_id, status, claimed_at);
--> statement-breakpoint
CREATE INDEX pipeline_publications_stalled_idx
  ON pipeline_publications (needs_person, resolve_attempts, status, copying_at, claimed_at)
  WHERE status IN ('claimed','copying');
--> statement-breakpoint
INSERT INTO pipeline_runs (id, tenant_id, federation_id, user_id, kind, purpose, regenerates_run_id, status,
  runner_image, script_version, arch, max_review_frac, spec_key, spec_sha256, spec_url_expires_at, chunk_count,
  volume_count, volumes_reported, callback_token_hash, token_expires_at, token_revoked_at, error, created_at,
  dispatched_at, completed_at)
SELECT id, tenant_id, federation_id, user_id, kind, purpose, regenerates_run_id, status,
  runner_image, script_version, arch, max_review_frac, spec_key, spec_sha256, spec_url_expires_at, chunk_count,
  volume_count, volumes_reported, callback_token_hash, token_expires_at, token_revoked_at, error, created_at,
  dispatched_at, completed_at
FROM pipeline_runs_hold;
--> statement-breakpoint
INSERT INTO pipeline_run_chunks (id, run_id, tenant_id, chunk_index, status, dispatch_error, claim_id,
  idempotency_key, body_sha256, stored_response, attempt, conclusion, unreported_volume_ids, dispatched_at,
  reported_at, created_at)
SELECT id, run_id, tenant_id, chunk_index, status, dispatch_error, claim_id,
  idempotency_key, body_sha256, stored_response, attempt, conclusion, unreported_volume_ids, dispatched_at,
  reported_at, created_at
FROM pipeline_run_chunks_hold;
--> statement-breakpoint
INSERT INTO pipeline_run_volumes (id, run_id, tenant_id, pipeline_volume_id, declaration_id, job_index,
  chunk_index, reference_code, tile_root, expected_count, resolved_recipe, status, claim_id, idempotency_key,
  body_sha256, stored_response, attempt, runner_versions, stages, qc, verification, flags_count, flags,
  flags_truncated, flags_ingested_at, flags_ingest_attempts, tiles_bytes, ocr_bytes, elapsed_s, manifest_key,
  report_key, error, reported_at, created_at)
SELECT id, run_id, tenant_id, pipeline_volume_id, declaration_id, job_index,
  chunk_index, reference_code, tile_root, expected_count, resolved_recipe, status, claim_id, idempotency_key,
  body_sha256, stored_response, attempt, runner_versions, stages, qc, verification, flags_count, flags,
  flags_truncated, flags_ingested_at, flags_ingest_attempts, tiles_bytes, ocr_bytes, elapsed_s, manifest_key,
  report_key, error, reported_at, created_at
FROM pipeline_run_volumes_hold;
--> statement-breakpoint
INSERT INTO pipeline_review_items (id, tenant_id, pipeline_volume_id, run_id, page_key, stage, code, summary,
  declaration_id, declaration_version, script_version, verdict, verdict_note, verdict_by, verdict_at, created_at)
SELECT id, tenant_id, pipeline_volume_id, run_id, page_key, stage, code, summary,
  declaration_id, declaration_version, script_version, verdict, verdict_note, verdict_by, verdict_at, created_at
FROM pipeline_review_items_hold;
--> statement-breakpoint
INSERT INTO pipeline_publications (id, tenant_id, pipeline_volume_id, run_id, run_volume_id, user_id, status,
  claim_id, canonical_url, canonical_key, manifest_sha256, canonical_expect, description_before,
  previous_catalogue_url, previous_manifest_sha256, previous_manifest_etag, previous_manifest_copy_key,
  previous_image_roots, retirement_status, ocr_pages_written, ocr_bytes_read, error, needs_person,
  resolve_attempts, claimed_at, copying_at, published_at, finished_at, previous_ocr_copy_key, previous_ocr_sha256)
SELECT id, tenant_id, pipeline_volume_id, run_id, run_volume_id, user_id, status,
  claim_id, canonical_url, canonical_key, manifest_sha256, canonical_expect, description_before,
  previous_catalogue_url, previous_manifest_sha256, previous_manifest_etag, previous_manifest_copy_key,
  previous_image_roots, retirement_status, ocr_pages_written, ocr_bytes_read, error, needs_person,
  resolve_attempts, claimed_at, copying_at, published_at, finished_at, previous_ocr_copy_key, previous_ocr_sha256
FROM pipeline_publications_hold;
--> statement-breakpoint
DROP TABLE pipeline_publications_hold;
--> statement-breakpoint
DROP TABLE pipeline_review_items_hold;
--> statement-breakpoint
DROP TABLE pipeline_run_volumes_hold;
--> statement-breakpoint
DROP TABLE pipeline_run_chunks_hold;
--> statement-breakpoint
DROP TABLE pipeline_runs_hold;
