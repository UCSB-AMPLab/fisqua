-- The federation's review-tiles bucket.
--
-- This migration adds the federation's review-tiles bucket. When Fisqua
-- registers a capture delivery, the review run tiles the delivery's
-- previews, exactly as captured, into a private B2 bucket of the
-- tenant's federation, each tenant's under its slug
-- (`{slug}/{deliveryId}/{page_key}/`). The capture QC viewer reads them
-- from B2 with a download authorisation Fisqua issues. Fisqua deletes
-- them once the volume is approved and processed.
--
--   - `pipeline_review_tiles_bucket`: the name of that bucket. It holds
--     a name, never a key. Fisqua's key on it is a Worker secret pair
--     named from `storage_secret_prefix`
--     (`{prefix}_REVIEW_SHARE_KEY_ID`, `{prefix}_REVIEW_SHARE_SECRET_KEY`).
--
-- The column is optional, unlike the eight destination columns of 0091:
-- a federation without it is still a complete destination, and its
-- volumes skip the review run. Every existing row is null, so every
-- existing destination stays complete. The operator's federation
-- storage command writes it when it creates or adopts the bucket.
--
-- The unique index keeps two federations from naming the same bucket,
-- as 0091's indexes do for the other buckets; a null is not compared.
--
-- Version: v0.8.0

ALTER TABLE federations ADD COLUMN pipeline_review_tiles_bucket TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX federations_pipeline_review_tiles_bucket_idx ON federations(pipeline_review_tiles_bucket) WHERE pipeline_review_tiles_bucket IS NOT NULL;
