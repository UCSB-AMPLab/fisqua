-- OCR text as page rows.
--
-- Until now each description carried its whole OCR transcript in one
-- `ocr_text` column: no page boundaries, no index, and a size that
-- forced import truncation, a three-tier lazy load in the authorities
-- worklist, and a full rewrite of the transcript on every save. This
-- migration adds the table that replaces it: one row per page, keyed by
-- the description and the page's position in the manifest's canvas
-- order, so a search hit names a page and the viewer can open at it.
--
-- `source_key` names the canonical page-text object in delivery storage
-- when the media pipeline produced the row; it is null for text that
-- has no object behind it (the rows migrated from `ocr_text`).
-- `alto_key` names the page's ALTO object the same way, and is also
-- null for pages that have no ALTO (the item-PDF path). Both are
-- stored as given, never derived from a path convention. `run_id`
-- names the pipeline run that wrote the row and carries no foreign key,
-- so this migration depends on no other table set.
--
-- `ocr_pages_staging` holds one ingest attempt's pages while they are
-- being read in. Rows are keyed by the attempt, not the run, so two
-- overlapping attempts for the same run never touch each other's rows.
-- The ingest moves a complete attempt into `ocr_pages` and clears it in
-- one batch, so a reader sees either the previous pages or the new
-- ones, never part of each. `created_at` lets a later attempt clear
-- rows an abandoned one left behind.
--
-- The index is an external-content FTS5 table: it reads page text from
-- `ocr_pages` by rowid and does not store the text a second time, which
-- the record indexes (regular FTS5 tables) do. Its triggers remove an
-- entry with FTS5's 'delete' command, passing the old text, since an
-- external-content index cannot look up what it indexed. D1 rejected
-- that idiom inside triggers on regular FTS5 tables (0041), but accepts
-- it on a real external-content table: tests/db/ocr-fts-probe.test.ts
-- runs the same statements on the local engine, and they were run once
-- against the remote staging database, where FTS5's integrity check
-- passed. The update trigger fires only for an UPDATE that sets `text`,
-- so setting any other column leaves the index alone. snippet() and
-- highlight() read the text through the content table.
--
-- The index is keyed by `ocr_pages`' implicit rowid, as the record
-- indexes are keyed by theirs, and every read joins the two tables on
-- it. Should the two ever fall out of step, FTS5's 'rebuild' command
-- rebuilds this index from `ocr_pages` alone.
--
-- Version: v0.8.0

CREATE TABLE ocr_pages (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  description_id TEXT NOT NULL REFERENCES descriptions(id) ON DELETE CASCADE,
  page_seq INTEGER NOT NULL CHECK (page_seq >= 1),
  text TEXT NOT NULL DEFAULT '',
  source_key TEXT,
  alto_key TEXT,
  run_id TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX ocr_pages_desc_seq_idx ON ocr_pages(description_id, page_seq);
--> statement-breakpoint
CREATE INDEX ocr_pages_tenant_idx ON ocr_pages(tenant_id);
--> statement-breakpoint

CREATE TABLE ocr_pages_staging (
  attempt_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  description_id TEXT NOT NULL,
  page_seq INTEGER NOT NULL CHECK (page_seq >= 1),
  tenant_id TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  source_key TEXT,
  alto_key TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, page_seq)
);
--> statement-breakpoint
CREATE INDEX ocr_pages_staging_desc_idx ON ocr_pages_staging(tenant_id, description_id, created_at);
--> statement-breakpoint

CREATE VIRTUAL TABLE ocr_pages_fts USING fts5(
  text,
  content='ocr_pages',
  content_rowid='rowid',
  tokenize='unicode61'
);
--> statement-breakpoint

CREATE TRIGGER ocr_pages_fts_ai AFTER INSERT ON ocr_pages BEGIN
  INSERT INTO ocr_pages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
--> statement-breakpoint

CREATE TRIGGER ocr_pages_fts_ad AFTER DELETE ON ocr_pages BEGIN
  INSERT INTO ocr_pages_fts(ocr_pages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
--> statement-breakpoint

CREATE TRIGGER ocr_pages_fts_au AFTER UPDATE OF text ON ocr_pages BEGIN
  INSERT INTO ocr_pages_fts(ocr_pages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO ocr_pages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
