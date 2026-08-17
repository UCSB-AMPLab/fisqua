-- External authority links: what an outside vocabulary calls a record
-- we already hold (registry shape ruled in the workspace repo's
-- external-authorities scoping note, 2026-08-13).
--
-- WHAT A ROW IS
-- -------------
-- One (record, scheme, external identifier) match, with the label the
-- scheme carried when the match was made and a statement of how it was
-- made. Not a property of the record: a separate row, so a record can
-- carry as many matches as there are vocabularies describing it, and so
-- a match can be retired without editing the record at all.
--
-- WHY NOT MORE COLUMNS ON entities/places
-- ---------------------------------------
-- entities already carries wikidata_id, viaf_id and dbe_id; places
-- carries tgn_id, hgis_id and whg_id. Those are one slot per scheme,
-- with nowhere to put who matched, on what grounds, or when the label
-- was last checked — and every new vocabulary costs a migration. This
-- table answers all of that once.
--
-- SCHEME IS OPEN TEXT
-- -------------------
-- Deliberately no CHECK on `scheme`. Which vocabularies a partner
-- reconciles against is a deployment fact, not a platform one; LCNAF,
-- LCSH and GeoNames are simply the first three. `matched_by` IS
-- enumerated, because that column is about us, and its three values are
-- the whole of how a match can arrive: picked by hand, confirmed off a
-- reconciliation candidate the pipeline stamped, or carried in by an
-- import.
--
-- DECISION LINKAGE
-- ----------------
-- decision_id is set when the match was confirmed while ruling an
-- authority proposal, and is RESTRICT for the reason comments'
-- decision FK is: a decision carrying its case file is never
-- hard-deleted. federation_id is RESTRICT for the same reason every
-- other federation-scoped table's is.
--
-- record_id carries NO foreign key: record_type spans three tables
-- (entities, places, vocabulary_terms), which SQLite cannot express as
-- one constraint, and the same polymorphic shape is already precedent
-- in authority_operations.source_id (0057).
--
-- The unique key makes a repeat confirmation a no-op rather than a
-- duplicate, which is what lets the ruling path insert with
-- ON CONFLICT DO NOTHING.
--
-- Version: v0.7.0

CREATE TABLE IF NOT EXISTS external_authority_links (
  id TEXT PRIMARY KEY,
  federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE RESTRICT,
  record_type TEXT NOT NULL CHECK (record_type IN ('entity','place','vocabulary_term')),
  record_id TEXT NOT NULL,
  scheme TEXT NOT NULL,
  external_id TEXT NOT NULL,
  matched_label TEXT NOT NULL,
  matched_by TEXT NOT NULL CHECK (matched_by IN ('hand-picked','reconciled-confirmed','import')),
  decision_id TEXT REFERENCES pending_decisions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated','redirected')),
  label_checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS eal_record_scheme_idx
  ON external_authority_links (record_type, record_id, scheme, external_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS eal_federation_scheme_idx
  ON external_authority_links (federation_id, scheme);
