-- Migrated OCR text kept by a publication.
--
-- This migration keeps the migrated OCR text that a publication
-- replaces. When a volume is published and its description still holds
-- the page-1 transcript migrated from the old `ocr_text` column, the
-- pipeline's pages replace that row. Before the row is replaced, its
-- text is written to Fisqua's own bucket under
-- `{tenantId}/pipeline-publications/{publicationId}/previous-ocr.txt`,
-- the way a previous manifest is kept. These two columns record where
-- that copy is and the SHA-256 of its bytes. Both are null on every
-- publication that replaced no migrated text, which includes every row
-- written before this migration.
--
-- Version: v0.8.0

ALTER TABLE pipeline_publications ADD COLUMN previous_ocr_copy_key TEXT;
--> statement-breakpoint
ALTER TABLE pipeline_publications ADD COLUMN previous_ocr_sha256 TEXT
  CHECK (previous_ocr_sha256 IS NULL OR length(previous_ocr_sha256) = 64);
