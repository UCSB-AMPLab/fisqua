-- Add `name_variants` to the entity and place FTS indexes
--
-- The entity and place authority records carry a JSON array of spelling
-- variants alongside the canonical display name -- "Maria", "María",
-- and "Mariana" may all point at the same person, and searchers in the
-- admin often type the variant they remember from a document rather
-- than the canonical form. This migration rebuilds both FTS5 virtual
-- tables to include `name_variants` as a third indexed column so those
-- variants are reachable from the search box without a separate query.
--
-- SQLite FTS5 cannot add a column in place, so both tables are dropped
-- and recreated with the new column list, and the sync triggers are
-- replaced in lockstep. On D1 the FTS contents are rebuilt lazily the
-- first time a row is updated; a full reindex is not needed because
-- every write path touches FTS via the triggers below.
--
-- Version: v0.3.0

DROP TRIGGER IF EXISTS entities_fts_ai;
DROP TRIGGER IF EXISTS entities_fts_ad;
DROP TRIGGER IF EXISTS entities_fts_au;
DROP TRIGGER IF EXISTS places_fts_ai;
DROP TRIGGER IF EXISTS places_fts_ad;
DROP TRIGGER IF EXISTS places_fts_au;

DROP TABLE IF EXISTS entities_fts;
DROP TABLE IF EXISTS places_fts;

CREATE VIRTUAL TABLE entities_fts USING fts5(
  display_name,
  sort_name,
  name_variants,
  tokenize='unicode61'
);

CREATE VIRTUAL TABLE places_fts USING fts5(
  label,
  display_name,
  name_variants,
  tokenize='unicode61'
);

CREATE TRIGGER entities_fts_ai AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(rowid, display_name, sort_name, name_variants)
  VALUES (new.rowid, new.display_name, new.sort_name, new.name_variants);
END;

CREATE TRIGGER entities_fts_ad AFTER DELETE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, display_name, sort_name, name_variants)
  VALUES ('delete', old.rowid, old.display_name, old.sort_name, old.name_variants);
END;

CREATE TRIGGER entities_fts_au AFTER UPDATE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, display_name, sort_name, name_variants)
  VALUES ('delete', old.rowid, old.display_name, old.sort_name, old.name_variants);
  INSERT INTO entities_fts(rowid, display_name, sort_name, name_variants)
  VALUES (new.rowid, new.display_name, new.sort_name, new.name_variants);
END;

CREATE TRIGGER places_fts_ai AFTER INSERT ON places BEGIN
  INSERT INTO places_fts(rowid, label, display_name, name_variants)
  VALUES (new.rowid, new.label, new.display_name, new.name_variants);
END;

CREATE TRIGGER places_fts_ad AFTER DELETE ON places BEGIN
  INSERT INTO places_fts(places_fts, rowid, label, display_name, name_variants)
  VALUES ('delete', old.rowid, old.label, old.display_name, old.name_variants);
END;

CREATE TRIGGER places_fts_au AFTER UPDATE ON places BEGIN
  INSERT INTO places_fts(places_fts, rowid, label, display_name, name_variants)
  VALUES ('delete', old.rowid, old.label, old.display_name, old.name_variants);
  INSERT INTO places_fts(rowid, label, display_name, name_variants)
  VALUES (new.rowid, new.label, new.display_name, new.name_variants);
END;
