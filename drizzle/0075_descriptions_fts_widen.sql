-- Widen the descriptions full-text index for global search.
--
-- descriptions_fts has indexed only reference_code + title since 0024,
-- which leaves scope and content, notes, and legacy references entirely
-- dark to search: a partner searching a citation their own scholarship
-- uses ("Geiger 155") finds nothing. Devised titles that carry the
-- scope's first clause have masked the gap; a corpus with real titles
-- would expose it completely.
--
-- FTS5 columns cannot be added in place, so this is the 0015 shape:
-- drop the virtual table and its three triggers, recreate both with the
-- widened column set, and rebuild the index over every existing row.
-- Trigger bodies use the 0041 delete idiom (DELETE ... WHERE rowid =
-- old.rowid) -- D1's trusted-schema mode rejects the external-content
-- idiom on regular FTS5 tables.
--
-- legacy_ids is indexed as its raw JSON text. Crude -- provider tags
-- like "former-reference-geiger" become tokens too -- but it makes the
-- identifiers findable, which is the point, and stray tags are harmless
-- extra tokens rather than false matches. internal_notes is deliberately
-- NOT indexed: internal means internal.
--
-- The backfill is split into four modulo chunks (~27K rows each of the
-- 106,509 production descriptions) so each INSERT..SELECT tokenizes
-- well inside D1's per-statement budget -- the same reason the 0051-54
-- tenant backfill was chunked.
--
-- Version: v0.7.0

DROP TRIGGER IF EXISTS descriptions_fts_ai;
--> statement-breakpoint
DROP TRIGGER IF EXISTS descriptions_fts_ad;
--> statement-breakpoint
DROP TRIGGER IF EXISTS descriptions_fts_au;
--> statement-breakpoint
DROP TABLE IF EXISTS descriptions_fts;
--> statement-breakpoint

CREATE VIRTUAL TABLE descriptions_fts USING fts5(
  reference_code,
  title,
  scope_content,
  notes,
  legacy_ids,
  tokenize='unicode61'
);
--> statement-breakpoint

CREATE TRIGGER descriptions_fts_ai AFTER INSERT ON descriptions BEGIN
  INSERT INTO descriptions_fts(rowid, reference_code, title, scope_content, notes, legacy_ids)
  VALUES (new.rowid, new.reference_code, new.title, new.scope_content, new.notes, new.legacy_ids);
END;
--> statement-breakpoint

CREATE TRIGGER descriptions_fts_ad AFTER DELETE ON descriptions BEGIN
  DELETE FROM descriptions_fts WHERE rowid = old.rowid;
END;
--> statement-breakpoint

CREATE TRIGGER descriptions_fts_au AFTER UPDATE ON descriptions BEGIN
  DELETE FROM descriptions_fts WHERE rowid = old.rowid;
  INSERT INTO descriptions_fts(rowid, reference_code, title, scope_content, notes, legacy_ids)
  VALUES (new.rowid, new.reference_code, new.title, new.scope_content, new.notes, new.legacy_ids);
END;
--> statement-breakpoint

INSERT INTO descriptions_fts(rowid, reference_code, title, scope_content, notes, legacy_ids)
SELECT rowid, reference_code, title, scope_content, notes, legacy_ids
FROM descriptions WHERE rowid % 4 = 0;
--> statement-breakpoint
INSERT INTO descriptions_fts(rowid, reference_code, title, scope_content, notes, legacy_ids)
SELECT rowid, reference_code, title, scope_content, notes, legacy_ids
FROM descriptions WHERE rowid % 4 = 1;
--> statement-breakpoint
INSERT INTO descriptions_fts(rowid, reference_code, title, scope_content, notes, legacy_ids)
SELECT rowid, reference_code, title, scope_content, notes, legacy_ids
FROM descriptions WHERE rowid % 4 = 2;
--> statement-breakpoint
INSERT INTO descriptions_fts(rowid, reference_code, title, scope_content, notes, legacy_ids)
SELECT rowid, reference_code, title, scope_content, notes, legacy_ids
FROM descriptions WHERE rowid % 4 = 3;
