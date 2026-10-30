-- Capture images: the rotation that makes an image upright.
--
-- This migration stores the rotation that makes a capture image upright.
-- The Captua exchange contract lets a capture manifest image carry
-- `rotateDeg`: 0, 90, 180 or 270 degrees clockwise, counted from the
-- stored pixels of the image the pipeline reads (the preview where there
-- is one, otherwise the capture), with any EXIF Orientation tag ignored.
-- An image without it is read by its EXIF tag. A capture QC rotation
-- (`capture_qc_rotations.quarter_turns`) is counted after it.
--
-- `capture_images.rotate_deg` holds the value as the manifest gave it,
-- under the name the runner's spec gives the page field. It is null
-- when the manifest left it out, which is every row written before this
-- migration, and that null is kept apart from 0: null follows the EXIF
-- tag, 0 says the stored pixels are already upright. A column CHECK
-- holds the four values; every existing row takes null, which passes
-- it.
--
-- Version: v0.8.0

ALTER TABLE capture_images ADD COLUMN rotate_deg INTEGER
  CHECK (rotate_deg IS NULL OR rotate_deg IN (0, 90, 180, 270));
