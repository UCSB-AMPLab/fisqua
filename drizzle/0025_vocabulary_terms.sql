-- Controlled vocabulary for entity functions
--
-- Entities in the authority pipeline carry a free-text `primary_function`
-- -- escribano, alcalde, cabildo, oidor -- which started life as a
-- cataloguer-typed label and drifted into dozens of near-duplicates over
-- time. This migration introduces `vocabulary_terms` as the canonical
-- list: each row captures one approved function label with an optional
-- category, a review workflow (`approved`, `proposed`, `deprecated`, etc.),
-- a `merged_into` pointer that lets curators redirect a wrong term to
-- its canonical sibling, and a running `entity_count` that the
-- vocabularies hub uses to rank by usage.
--
-- The companion column on `entities` -- `primary_function_id` as a
-- nullable FK into this table -- lets the UI migrate entities onto the
-- controlled list progressively: existing rows keep their free-text
-- `primary_function` until a curator picks a canonical term for them.
-- A null FK means "still free-text"; a non-null FK means "linked to the
-- controlled term" and takes precedence on display.
--
-- ON DELETE SET NULL on both the `primary_function_id` FK and the two
-- user-reference columns ensures that deleting a term or user does not
-- cascade through the graph and delete entities or vocabulary history.
--
-- Version: v0.3.0

CREATE TABLE IF NOT EXISTS vocabulary_terms (
  id TEXT PRIMARY KEY NOT NULL,
  canonical TEXT NOT NULL,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'approved',
  merged_into TEXT,
  entity_count INTEGER NOT NULL DEFAULT 0,
  proposed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at INTEGER,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS vt_canonical_idx ON vocabulary_terms(canonical);
CREATE INDEX IF NOT EXISTS vt_category_idx ON vocabulary_terms(category);
CREATE INDEX IF NOT EXISTS vt_status_idx ON vocabulary_terms(status);

ALTER TABLE entities ADD COLUMN primary_function_id TEXT REFERENCES vocabulary_terms(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS entity_pf_id_idx ON entities(primary_function_id);
