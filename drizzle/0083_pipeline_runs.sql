-- Media pipeline: runs, their dispatch chunks and their volumes.
--
-- This migration adds the run ledger. A run is one request to process a
-- set of pipeline volumes; it is dispatched to the runner in chunks,
-- and each volume in it gets one row recording what happened to it.
--
-- `tenant_id` is first class on all three tables, and progress is kept
-- per volume with per-stage outcomes in `stages`, so the two gaps of
-- the export-run ledger (no tenant column, run-level progress only) are
-- not inherited. The recipe fields are required: `runner_image`,
-- `script_version` and `arch` on the run, and the complete resolved
-- recipe on every run volume. `runner_image` must end in `@sha256:`
-- and 64 lower-case hex digits after at least one character of
-- repository, so a run always names its image by digest and never by
-- tag. `pipeline_run_volumes.declaration_id` is the exact declaration
-- row resolved from the volume's family when the run was dispatched,
-- so the ledger records which version was applied. No quota or
-- guarantee-implying column ships; `tiles_bytes`, `ocr_bytes` and
-- `elapsed_s` are the meter's data source. `regenerates_run_id` has no
-- foreign key, following `stewardship_runs`.
--
-- Only the SHA-256 digest of the callback token is stored, never the
-- token. `token_revoked_at` marks the run closed, and a CHECK ties it
-- to the status: pending, dispatched and running runs are open;
-- completed, error and cancelled runs are closed; a halted run may be
-- either, because a halted run stays open until its chunks have
-- reported or its token expires. The spec URL must expire before the
-- token does.
--
-- `claim_id` is the compare-and-swap value that makes a callback's
-- batch apply at most once; `idempotency_key`, `body_sha256` and
-- `stored_response` let an exact replay get the response it got the
-- first time. `pipeline_run_volumes.flags` holds the open flags of the
-- accepted callback, each with the review-item id Fisqua assigned, and
-- is the source the review-item insert reads in the same batch.
-- `flags_ingest_attempts` counts the scheduled retries of a truncated
-- flag list that made no progress; past a fixed bound the sweep stops
-- retrying the row, which stays un-ingested for someone to look at.
--
-- `pipeline_run_chunks` holds one row per dispatch chunk with its
-- dispatch outcome and its completion report, keyed and replayed like a
-- volume callback. The run closes when no chunk is pending, dispatched
-- or failed. Rows in these tables are never deleted by application
-- code.
--
-- Version: v0.8.0

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  federation_id TEXT REFERENCES federations(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('volume_run','item_pdf')),
  purpose TEXT NOT NULL CHECK (purpose IN ('sample','wave')),
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
      OR status = 'halted')
);
CREATE INDEX IF NOT EXISTS pipeline_runs_tenant_idx ON pipeline_runs (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS pipeline_runs_open_idx ON pipeline_runs (token_revoked_at, token_expires_at);

CREATE TABLE IF NOT EXISTS pipeline_run_chunks (
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

CREATE TABLE IF NOT EXISTS pipeline_run_volumes (
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
CREATE INDEX IF NOT EXISTS pipeline_run_volumes_volume_idx ON pipeline_run_volumes (pipeline_volume_id, created_at);
CREATE INDEX IF NOT EXISTS pipeline_run_volumes_chunk_idx ON pipeline_run_volumes (run_id, chunk_index, status);
CREATE INDEX IF NOT EXISTS pipeline_run_volumes_flags_idx ON pipeline_run_volumes (flags_truncated, flags_ingested_at);
