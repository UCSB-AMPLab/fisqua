-- This migration fixes the FTS5 delete triggers that the 2026-05-03 production
-- import attempt surfaced as broken. The AD (after-delete) and AU
-- (after-update) FTS5 triggers on `descriptions`, `entities`, and `places`
-- use the "delete command" idiom
--
--   INSERT INTO <fts>(<fts>, rowid, ...) VALUES('delete', old.rowid, ...);
--
-- which is documented for *external content* FTS5 tables. Our tables
-- are regular FTS5 (data stored inside the FTS table itself) — the
-- correct delete pattern for regular FTS5 is direct row deletion:
--
--   DELETE FROM <fts> WHERE rowid = old.rowid;
--
-- D1's defensive trusted-schema mode rejects the external-content
-- idiom in regular tables as `unsafe use of virtual table`, returning
-- `SQL logic error: SQLITE_ERROR [code: 7500]` whenever the trigger
-- fires (verified against fisqua-db --remote during the production
-- round-1 attempt: clear succeeded against an empty domain, then
-- failed against a non-empty domain). Local miniflare enforces the
-- same defensive mode; round 1 succeeded only because local was
-- always cleaned to an empty state before each retry.
--
-- This migration drops the 6 affected triggers and recreates them
-- with the regular-FTS5 pattern. AI (after-insert) triggers are
-- unchanged — `INSERT INTO <fts>(rowid, ...) VALUES (new.rowid, ...)`
-- is the standard regular-table form and works correctly.
--
-- Affected triggers (6): descriptions_fts_ad, descriptions_fts_au,
-- entities_fts_ad, entities_fts_au, places_fts_ad, places_fts_au.

DROP TRIGGER IF EXISTS descriptions_fts_ad;
--> statement-breakpoint
CREATE TRIGGER descriptions_fts_ad AFTER DELETE ON descriptions BEGIN
  DELETE FROM descriptions_fts WHERE rowid = old.rowid;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS descriptions_fts_au;
--> statement-breakpoint
CREATE TRIGGER descriptions_fts_au AFTER UPDATE ON descriptions BEGIN
  DELETE FROM descriptions_fts WHERE rowid = old.rowid;
  INSERT INTO descriptions_fts(rowid, reference_code, title)
  VALUES (new.rowid, new.reference_code, new.title);
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS entities_fts_ad;
--> statement-breakpoint
CREATE TRIGGER entities_fts_ad AFTER DELETE ON entities BEGIN
  DELETE FROM entities_fts WHERE rowid = old.rowid;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS entities_fts_au;
--> statement-breakpoint
CREATE TRIGGER entities_fts_au AFTER UPDATE ON entities BEGIN
  DELETE FROM entities_fts WHERE rowid = old.rowid;
  INSERT INTO entities_fts(rowid, display_name, sort_name, name_variants)
  VALUES (new.rowid, new.display_name, new.sort_name, new.name_variants);
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS places_fts_ad;
--> statement-breakpoint
CREATE TRIGGER places_fts_ad AFTER DELETE ON places BEGIN
  DELETE FROM places_fts WHERE rowid = old.rowid;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS places_fts_au;
--> statement-breakpoint
CREATE TRIGGER places_fts_au AFTER UPDATE ON places BEGIN
  DELETE FROM places_fts WHERE rowid = old.rowid;
  INSERT INTO places_fts(rowid, label, display_name, name_variants)
  VALUES (new.rowid, new.label, new.display_name, new.name_variants);
END;
