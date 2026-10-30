-- Capture QC: the review runs of a delivery, and the purge of their tiles.
--
-- This migration records the review runs of a capture delivery and the
-- purge of their tiles. A review run (kind `review_run`, 0102) tiles one
-- capture delivery's previews as captured into the federation's
-- review-tiles bucket, under `{slug}/{delivery id}/`, so capture QC can
-- look at them. Its row in `pipeline_runs` carries the token, spec and
-- chunks; what it did with the delivery is recorded here, in
-- `capture_review_runs`, one row per run and volume. It is not written to
-- `pipeline_run_volumes`, which the capture QC hold, the open-run checks
-- and the processing states read: a review run holds nothing, releases no
-- hold and leaves the volume in Received.
--
-- `review_prefix` is the prefix the spec named for the delivery, which
-- the runner's report must name back. `status` starts `dispatched` and
-- takes the runner's outcome: `review_ready` once the tiles are written
-- and verified, or `aborted` or `halted` with `error`. `claim_id`,
-- `idempotency_key`, `body_sha256`, `stored_response` and `attempt`
-- make a callback apply at most once and let an exact replay get the
-- answer it got the first time, as on `pipeline_run_volumes`;
-- `tiles_bytes` and `report_key` come from the report. A retried review
-- run of the same delivery is a new run and a new row.
--
-- The review tiles are deleted by the processing run once the volume's
-- own tiles are verified: its spec names the prefixes of the volume's
-- deliveries, and its report says what became of them.
-- `pipeline_run_volumes.review_purge` keeps that report as it came
-- (`status` purged, failed or not_reached, the prefixes, and each
-- failure). Each review row whose prefix the purge deleted takes
-- `purge_status` `purged` and `purged_at`; one it failed to delete takes
-- `failed`, and nothing retries it.
--
-- Every key within the module carries the tenant.
--
-- Version: v0.8.0

CREATE TABLE capture_review_runs (
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
);
--> statement-breakpoint
CREATE INDEX capture_review_runs_delivery_idx ON capture_review_runs (tenant_id, delivery_id, created_at);
--> statement-breakpoint
CREATE INDEX capture_review_runs_volume_idx ON capture_review_runs (tenant_id, pipeline_volume_id, created_at);
--> statement-breakpoint
ALTER TABLE pipeline_run_volumes ADD COLUMN review_purge TEXT
  CHECK (review_purge IS NULL OR json_valid(review_purge));
