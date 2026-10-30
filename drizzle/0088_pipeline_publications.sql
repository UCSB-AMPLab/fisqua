-- The media pipeline's publication ledger.
--
-- This migration adds the media pipeline's publication ledger. A
-- publication is one attempt to publish a ready pipeline volume: to
-- copy the manifest the runner held back to its canonical URL and point
-- the volume's catalogue row at it. Each attempt is a row, and rows are
-- never deleted by application code, so the table is also the record of
-- who published what and when.
--
-- `claimed` and `copying` are in flight, and at most one row per volume
-- may be in flight at a time. `copying` means a canonical put may have
-- happened: such a row is finished or failed by looking at the
-- canonical key, never by simply abandoning it. `canonical_expect` is
-- the condition the put is made under (`{"absent": true}` or
-- `{"etag": "..."}`), recorded when the row is claimed so a later
-- check can tell an untouched key from one someone else changed. A
-- volume is published once, so at most one row per volume is
-- `published`: a published volume cannot be run again.
--
-- The canonical key space is shared by every tenant, so at most one
-- in-flight or published row may name a canonical key across all
-- tenants. That index is the backstop for the ownership check the
-- publish action makes before it claims a key.
--
-- The `previous_*` columns record a chain of delivery objects that
-- predates the pipeline: the catalogue URL the description pointed at
-- before, and the object that sat at the canonical key, preserved
-- byte for byte in Fisqua's own bucket, with the image roots it names.
-- Nothing in Fisqua deletes that chain; `retirement_status` says
-- whether one is waiting to be retired.
--
-- `needs_person` marks a stalled row the scheduled sweep must not
-- decide on its own; `resolve_attempts` counts sweep visits that could
-- not decide, so a row that keeps failing sinks below newer ones.
--
-- `run_id` and the other references are foreign keys because this
-- table is created after the run tables.
--
-- Version: v0.8.0

CREATE TABLE IF NOT EXISTS pipeline_publications (
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
  CHECK ((status = 'published') = (published_at IS NOT NULL)),
  CHECK (status <> 'copying' OR copying_at IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_publications_in_flight
  ON pipeline_publications (pipeline_volume_id) WHERE status IN ('claimed','copying');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_publications_published
  ON pipeline_publications (pipeline_volume_id) WHERE status = 'published';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_publications_canonical_key
  ON pipeline_publications (canonical_key) WHERE status IN ('claimed','copying','published');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pipeline_publications_tenant_idx
  ON pipeline_publications (tenant_id, status, claimed_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pipeline_publications_stalled_idx
  ON pipeline_publications (needs_person, resolve_attempts, status, copying_at, claimed_at)
  WHERE status IN ('claimed','copying');
