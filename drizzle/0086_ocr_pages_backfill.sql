-- Move the OCR blobs into page rows.
--
-- This migration moves the OCR blobs into page rows. Every description
-- with a non-empty `ocr_text` gets one `ocr_pages` row at page 1 holding
-- its whole transcript. The blobs carry no page boundaries and none are
-- invented here: a transcript that was one string stays one page until a
-- pipeline run replaces it with real pages. `source_key`, `alto_key` and
-- `run_id` stay null because no object and no run stand behind this text.
--
-- The copy runs in four modulo chunks for the reason 0075 gives: each
-- INSERT tokenises its rows into the full-text index through the
-- insert trigger, and a quarter of the corpus per statement stays well
-- inside D1's per-statement budget.
--
-- Ids are UUID version 4 strings built from randomblob(), in the form
-- every other table uses.
--
-- The `ocr_text` column is left in place; 0087 drops it once nothing
-- reads it.
--
-- Version: v0.8.0

INSERT INTO ocr_pages (id, tenant_id, description_id, page_seq, text, source_key, alto_key, run_id, created_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6))),
  tenant_id, id, 1, ocr_text, NULL, NULL, NULL, CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM descriptions
WHERE ocr_text IS NOT NULL AND ocr_text != '' AND rowid % 4 = 0;
--> statement-breakpoint

INSERT INTO ocr_pages (id, tenant_id, description_id, page_seq, text, source_key, alto_key, run_id, created_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6))),
  tenant_id, id, 1, ocr_text, NULL, NULL, NULL, CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM descriptions
WHERE ocr_text IS NOT NULL AND ocr_text != '' AND rowid % 4 = 1;
--> statement-breakpoint

INSERT INTO ocr_pages (id, tenant_id, description_id, page_seq, text, source_key, alto_key, run_id, created_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6))),
  tenant_id, id, 1, ocr_text, NULL, NULL, NULL, CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM descriptions
WHERE ocr_text IS NOT NULL AND ocr_text != '' AND rowid % 4 = 2;
--> statement-breakpoint

INSERT INTO ocr_pages (id, tenant_id, description_id, page_seq, text, source_key, alto_key, run_id, created_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6))),
  tenant_id, id, 1, ocr_text, NULL, NULL, NULL, CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM descriptions
WHERE ocr_text IS NOT NULL AND ocr_text != '' AND rowid % 4 = 3;
