-- Canvas labels on volume pages
--
-- This migration adds a nullable `label` text column to `volume_pages`
-- so the page label that IIIF manifests carry on each canvas — folio
-- numbers, recto/verso marks, plate captions — can be stored next to
-- the image URL and surfaced in the viewer's page gutter. Existing
-- rows get NULL; the manifest import path is updated in the same
-- release to backfill the value when present.
--
-- Version: v0.3.0

ALTER TABLE `volume_pages` ADD `label` text;