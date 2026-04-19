-- Full-text search for entities and places
--
-- Adds SQLite's FTS5 virtual tables on top of entities and places so the
-- admin UI can do accent-insensitive search against display and sort
-- names without scanning the whole table. The `unicode61` tokeniser
-- folds diacritics so that typing `muzo` matches both `Muzo` and
-- `Muzó`, which is essential for Colombian Spanish corpora where the
-- same name is often recorded with and without accents across
-- centuries.
--
-- Three per-table triggers keep each FTS index in sync with its source:
-- insert-after adds the row, delete-after writes the tombstone, and
-- update-after replays delete + insert. This is the standard FTS5
-- external-content pattern adapted for tables with text primary keys;
-- all SQLite tables still carry an implicit rowid, so the FTS table
-- joins back to the source by rowid on read.
--
-- Caveat: D1's bulk export pipeline excludes virtual tables, so the
-- published JSON snapshot does not contain FTS state. That is fine --
-- the static frontend uses Pagefind for its own search and never
-- reads FTS state directly.
--
-- Version: v0.3.0

CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  display_name,
  sort_name,
  tokenize='unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS places_fts USING fts5(
  label,
  display_name,
  tokenize='unicode61'
);

-- Sync triggers keep FTS state in lockstep with each source table.
-- Uses the implicit rowid that SQLite assigns to every table row.

CREATE TRIGGER IF NOT EXISTS entities_fts_ai AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(rowid, display_name, sort_name)
  VALUES (new.rowid, new.display_name, new.sort_name);
END;

CREATE TRIGGER IF NOT EXISTS entities_fts_ad AFTER DELETE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, display_name, sort_name)
  VALUES ('delete', old.rowid, old.display_name, old.sort_name);
END;

CREATE TRIGGER IF NOT EXISTS entities_fts_au AFTER UPDATE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, display_name, sort_name)
  VALUES ('delete', old.rowid, old.display_name, old.sort_name);
  INSERT INTO entities_fts(rowid, display_name, sort_name)
  VALUES (new.rowid, new.display_name, new.sort_name);
END;

CREATE TRIGGER IF NOT EXISTS places_fts_ai AFTER INSERT ON places BEGIN
  INSERT INTO places_fts(rowid, label, display_name)
  VALUES (new.rowid, new.label, new.display_name);
END;

CREATE TRIGGER IF NOT EXISTS places_fts_ad AFTER DELETE ON places BEGIN
  INSERT INTO places_fts(places_fts, rowid, label, display_name)
  VALUES ('delete', old.rowid, old.label, old.display_name);
END;

CREATE TRIGGER IF NOT EXISTS places_fts_au AFTER UPDATE ON places BEGIN
  INSERT INTO places_fts(places_fts, rowid, label, display_name)
  VALUES ('delete', old.rowid, old.label, old.display_name);
  INSERT INTO places_fts(rowid, label, display_name)
  VALUES (new.rowid, new.label, new.display_name);
END;
