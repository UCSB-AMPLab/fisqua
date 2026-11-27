-- Capture deliveries: calibration shots and what a volume says of them.
--
-- Version 1.12 of the Captua exchange contract (§13) lets a volume of a
-- capture manifest carry calibration shots, photographs of a colour
-- reference card that each camera takes under the light and settings of
-- the pages, at the start of the volume and again whenever exposure or
-- zoom changes. It also lets the volume say whether it has them,
-- `present` or `skipped`, with an optional reason for a skip. A shot is
-- never a page: it is no record, opening or pair member, so it is kept
-- apart from `capture_images`, which capture QC, the pages, carry-over,
-- Retakes and dispatch all read.
--
-- `capture_deliveries` gains `calibration_status` (null when the volume
-- says nothing, which is every row written before this migration and
-- every delivery of a manifest before 1.12) and
-- `calibration_skipped_reason`, kept only with `skipped`.
--
-- `capture_calibration_shots` holds a delivery's shots, one row each,
-- under the delivery as its images are (a composite foreign key), with
-- `seq` its place in the manifest's list from 1. The objects are kept as
-- an image's are: the capture by its full key in the masters bucket, its
-- digest and the size the listing gave, and the preview where there is
-- one. `camera`, `captured_at` and `applies_from_capture_id` are kept as
-- the manifest gives them, and `settings` as the JSON object it gives.
--
-- The migration writes no row; every existing row keeps its values and
-- takes null in the two new columns.
--
-- Version: v0.9.0

ALTER TABLE capture_deliveries ADD COLUMN calibration_status TEXT
  CHECK (calibration_status IS NULL OR calibration_status IN ('present','skipped'));
--> statement-breakpoint
ALTER TABLE capture_deliveries ADD COLUMN calibration_skipped_reason TEXT
  CHECK (calibration_skipped_reason IS NULL OR calibration_status = 'skipped');
--> statement-breakpoint
CREATE TABLE capture_calibration_shots (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  delivery_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  capture_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  camera TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  settings TEXT NOT NULL CHECK (json_valid(settings) AND json_type(settings) = 'object'),
  applies_from_capture_id TEXT NOT NULL,
  capture_key TEXT NOT NULL,
  capture_sha256 TEXT NOT NULL CHECK (length(capture_sha256) = 64 AND capture_sha256 NOT GLOB '*[^0-9a-f]*'),
  capture_bytes INTEGER,
  preview_key TEXT,
  preview_sha256 TEXT CHECK (preview_sha256 IS NULL OR (length(preview_sha256) = 64 AND preview_sha256 NOT GLOB '*[^0-9a-f]*')),
  preview_bytes INTEGER,
  rotate_deg INTEGER CHECK (rotate_deg IS NULL OR rotate_deg IN (0, 90, 180, 270)),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES capture_deliveries(tenant_id, id) ON DELETE RESTRICT,
  CHECK ((preview_key IS NULL) = (preview_sha256 IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX capture_calibration_shots_delivery_idx ON capture_calibration_shots (tenant_id, delivery_id, seq);
