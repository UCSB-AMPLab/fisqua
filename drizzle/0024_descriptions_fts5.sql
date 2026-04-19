-- Full-text search for archival descriptions
--
-- Adds an FTS5 virtual table that indexes description reference codes
-- and titles so the admin and the column-view explorer can search
-- across the 100,000+ record tree without scanning the whole
-- `descriptions` table on every keystroke. The `unicode61` tokeniser
-- folds Spanish diacritics so typing `cordoba` matches `Córdoba`
-- alongside its variants.
--
-- Three triggers keep the FTS index in sync with the source table on
-- insert, delete, and update. A final rebuild statement populates the
-- index from any descriptions that were already in the database when
-- the migration ran, so search works on the first request.
--
-- D1's bulk export excludes virtual tables, which is fine -- the
-- published JSON snapshot is consumed by the static frontend's
-- Pagefind index and never reads FTS state directly.
--
-- Version: v0.3.0

CREATE VIRTUAL TABLE IF NOT EXISTS descriptions_fts USING fts5(
  reference_code, title,
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS descriptions_fts_ai AFTER INSERT ON descriptions BEGIN
  INSERT INTO descriptions_fts(rowid, reference_code, title)
  VALUES (new.rowid, new.reference_code, new.title);
END;

CREATE TRIGGER IF NOT EXISTS descriptions_fts_ad AFTER DELETE ON descriptions BEGIN
  INSERT INTO descriptions_fts(descriptions_fts, rowid, reference_code, title)
  VALUES ('delete', old.rowid, old.reference_code, old.title);
END;

CREATE TRIGGER IF NOT EXISTS descriptions_fts_au AFTER UPDATE ON descriptions BEGIN
  INSERT INTO descriptions_fts(descriptions_fts, rowid, reference_code, title)
  VALUES ('delete', old.rowid, old.reference_code, old.title);
  INSERT INTO descriptions_fts(rowid, reference_code, title)
  VALUES (new.rowid, new.reference_code, new.title);
END;

-- Backfill the index from rows that were already in the table.
INSERT INTO descriptions_fts(descriptions_fts) VALUES('rebuild');
