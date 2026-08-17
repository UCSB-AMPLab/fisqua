-- One decision row per duplicate pair.
--
-- 0072 gave pair rows a findable key: source_ref carries the sorted
-- pairKey, and the server files rows lazily with a find-or-create.
-- A find-or-create built on select-then-insert has a race: two first
-- contacts with the same never-seen pair (say, two admins commenting
-- at once) can both miss the select and both insert, leaving two open
-- rows for one question.
--
-- This partial unique index closes it. The insert side uses ON
-- CONFLICT DO NOTHING and re-selects by key, so the race's loser gets
-- the winner's row instead of an error. Scoped to the duplicate-pair
-- kind: authority proposals reuse source_ref for provenance strings
-- that are NOT unique per row, so a blanket index would break them.
--
-- Data precondition: every existing duplicate-pair row already carries
-- a source_ref (backfilled by 0072), and pair keys are unique today —
-- the old dismissal flow only ever wrote one row per pair.
--
-- Version: v0.7.0

CREATE UNIQUE INDEX idx_pending_decisions_pair_key
  ON pending_decisions (federation_id, source_ref)
  WHERE kind = 'duplicate-pair' AND source_ref IS NOT NULL;
