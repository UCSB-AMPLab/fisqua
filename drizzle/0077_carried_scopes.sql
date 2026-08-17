-- Carried scopes: a search selection handed forward to the export
-- surface (selection layer ruled in the workspace repo's
-- exports-handlists design handoff, 2026-08-15).
--
-- WHAT A ROW IS
-- -------------
-- One set of records a person picked out of a result page and sent on.
-- The set is MATERIALISED here, as a JSON array of ids plus the count
-- the results page was showing when they sent it. Nothing about the
-- query survives except a display-only summary of the pills, because
-- the carry is a promise about a fixed set of records, not a saved
-- search: the export must produce exactly what was ticked, even if the
-- same query would answer differently an hour later.
--
-- WHY MATERIALISE "ALL MATCHING" TOO
-- ----------------------------------
-- A person may take the whole result set without ticking each row. The
-- alternative — storing the query and re-running it at export time —
-- makes the export a moving target and hands the export code a second
-- copy of the search's scope rules to get wrong. So the ids are
-- resolved once, at carry time, under the SAME scoped statement the
-- results page ran, and the export reads a list.
--
-- SCOPE AND OWNERSHIP
-- -------------------
-- tenant_id and user_id are both NOT NULL: a carried scope is one
-- person's working set inside one workspace, and the read that consumes
-- it keys on both, so a foreign scope is indistinguishable from an
-- absent one. tenant_id is RESTRICT for the reason every tenant FK is;
-- user_id is CASCADE because this is scratch state — when the person is
-- gone, so is their unconsumed selection, and nothing references it.
--
-- record_type names the surface the ids came from, in the vocabulary
-- the search tabs use ('records' for descriptions), not the table name:
-- the export page speaks to a person about records, entities and
-- places.
--
-- member_ids carries NO foreign key: record_type spans three tables
-- (descriptions, entities, places), which SQLite cannot express as one
-- constraint, and a JSON array could not carry one anyway. The same
-- polymorphic shape is precedent in external_authority_links (0076).
--
-- total is stored beside the array rather than derived from it because
-- the two answer different questions: the array is what will be
-- exported, the total is what the person was told they were taking. On
-- a well-formed row they agree, and a later divergence is a bug worth
-- being able to see.
--
-- consumed_at is set by the export surface when the scope is spent. It
-- stays NULL here: filing a carry never consumes it.
--
-- Version: v0.7.0

CREATE TABLE IF NOT EXISTS carried_scopes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  record_type TEXT NOT NULL CHECK (record_type IN ('records','entities','places')),
  constraint_summary TEXT NOT NULL DEFAULT '{}',
  member_ids TEXT NOT NULL DEFAULT '[]',
  total INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS carried_scopes_owner_idx
  ON carried_scopes (tenant_id, user_id, created_at);
