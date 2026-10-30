-- Storage destinations per federation.
--
-- This migration adds storage destinations to each federation. The
-- media pipeline writes a tenant's tiles, page text and manifests to
-- storage named on its federation's row. The buckets belong to the
-- federation, and each tenant's output sits under its own slug inside
-- them (`{slug}/` for tiles and page text, `{slug}/iiif/` for
-- manifests), so turning the pipeline on for a tenant cannot write into
-- another tenant's part of the buckets. These columns hold the names
-- and addresses of that storage; they never hold a key.
--
--   - `pipeline_delivery_endpoint`: the S3 endpoint of the tiles bucket;
--   - `pipeline_tiles_bucket`: the bucket the runner writes tiles and
--     page text to;
--   - `pipeline_masters_bucket`: the private bucket the runner reads the
--     federation's masters from, each tenant's under its slug. Fisqua
--     itself does not read it; the operator's tenant command limits the
--     runner's masters key to it;
--   - `pipeline_image_base_url`: the public address the tiles are
--     served from, the bucket's root;
--   - `manifest_endpoint`: the S3 endpoint of the manifest bucket;
--   - `manifest_bucket`: the bucket canonical manifests are written to;
--   - `manifest_base_url`: the public address the manifests are served
--     from, the bucket's root;
--   - `storage_secret_prefix`: the prefix of the four Worker secrets
--     that hold the federation's keys (`{prefix}_DELIVERY_READ_KEY_ID`,
--     `{prefix}_DELIVERY_READ_SECRET_KEY`, `{prefix}_MANIFEST_WRITE_KEY_ID`,
--     `{prefix}_MANIFEST_WRITE_SECRET_KEY`).
--
-- Nothing in the app edits these columns. The operator's federation
-- storage command writes them, after creating the storage or, for
-- storage that already exists, adopting it. A tenant whose federation's
-- columns are not all set, or whose secrets are missing, is refused at
-- dispatch, publishing and promotion, and its pipeline switch cannot be
-- turned on.
--
-- Separate nullable columns, as the other settings are. Every existing
-- row is null. The unique indexes keep two federations from naming the
-- same bucket, manifest address or secret prefix; a null is not
-- compared, so federations without a destination do not collide.
--
-- A tenant's slug names its part of the federation's buckets and every
-- address under it, so it cannot change once the tenant has pipeline
-- output. `tenants_slug_frozen` refuses an UPDATE that changes the slug
-- of a tenant that has any `pipeline_run_volumes` row: a volume is in a
-- run from the moment it is dispatched, and from then on the runner may
-- have written under the slug, whatever became of the run. Volumes past
-- `received` and published manifests all have such a row. Nothing in
-- the app changes a slug; the trigger holds for a change made by hand.
--
-- Version: v0.8.0

ALTER TABLE federations ADD COLUMN pipeline_delivery_endpoint TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN pipeline_tiles_bucket TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN pipeline_masters_bucket TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN pipeline_image_base_url TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN manifest_endpoint TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN manifest_bucket TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN manifest_base_url TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN storage_secret_prefix TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX federations_pipeline_tiles_bucket_idx ON federations(pipeline_tiles_bucket) WHERE pipeline_tiles_bucket IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX federations_pipeline_masters_bucket_idx ON federations(pipeline_masters_bucket) WHERE pipeline_masters_bucket IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX federations_manifest_bucket_idx ON federations(manifest_bucket) WHERE manifest_bucket IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX federations_manifest_base_url_idx ON federations(manifest_base_url) WHERE manifest_base_url IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX federations_storage_secret_prefix_idx ON federations(storage_secret_prefix) WHERE storage_secret_prefix IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER tenants_slug_frozen
BEFORE UPDATE OF slug ON tenants
WHEN NEW.slug IS NOT OLD.slug
  AND EXISTS (SELECT 1 FROM pipeline_run_volumes WHERE tenant_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'tenant_slug_frozen: the tenant has pipeline output under its slug');
END;
