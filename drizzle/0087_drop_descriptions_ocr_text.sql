-- Retire descriptions.ocr_text.
--
-- This migration retires `descriptions.ocr_text`. OCR text now lives in
-- ocr_pages (0085, backfilled by 0086), and no code reads or writes the
-- column. Between 0086 running and the code that stopped writing the
-- column being deployed, a cataloguer could still have saved a
-- transcript; the three statements below carry those saves across before
-- the column goes: a transcript cleared to NULL or the empty string
-- deletes its migrated page-1 row, a changed transcript updates that
-- row, and a newly filled one gets a row. Without the delete, a cleared
-- transcript would stay searchable and exportable from the row 0086
-- copied it into. A migrated row is the one 0086 writes: page 1 with
-- run_id, source_key and alto_key all null. Pages written by a pipeline
-- run (run_id set) are never touched. The full-text index follows
-- through the ocr_pages triggers from 0085.
--
-- ALTER TABLE ... DROP COLUMN is safe here for the reasons 0048 gives:
-- ocr_text is not a key, not indexed, and referenced by no trigger or
-- view (the record index's triggers name reference_code, title,
-- scope_content, notes and legacy_ids only).
--
-- Version: v0.8.0

DELETE FROM ocr_pages
WHERE run_id IS NULL AND source_key IS NULL AND alto_key IS NULL AND page_seq = 1
  AND EXISTS (
    SELECT 1 FROM descriptions d
    WHERE d.id = ocr_pages.description_id
      AND (d.ocr_text IS NULL OR d.ocr_text = '')
  );
--> statement-breakpoint

UPDATE ocr_pages
SET text = (SELECT d.ocr_text FROM descriptions d WHERE d.id = ocr_pages.description_id)
WHERE run_id IS NULL AND page_seq = 1
  AND EXISTS (
    SELECT 1 FROM descriptions d
    WHERE d.id = ocr_pages.description_id
      AND d.ocr_text IS NOT NULL AND d.ocr_text != '' AND d.ocr_text != ocr_pages.text
  );
--> statement-breakpoint

INSERT INTO ocr_pages (id, tenant_id, description_id, page_seq, text, source_key, alto_key, run_id, created_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6))),
  d.tenant_id, d.id, 1, d.ocr_text, NULL, NULL, NULL, CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM descriptions d
WHERE d.ocr_text IS NOT NULL AND d.ocr_text != ''
  AND NOT EXISTS (SELECT 1 FROM ocr_pages p WHERE p.description_id = d.id);
--> statement-breakpoint

ALTER TABLE descriptions DROP COLUMN ocr_text;
