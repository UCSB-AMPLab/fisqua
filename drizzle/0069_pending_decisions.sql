-- Pending decisions: the queue where a workspace's open questions wait
-- for a ruling (design note: pending-decisions-design.md, in the
-- workspace repo's 0.7.0 release folder).
--
-- WHAT A ROW IS
-- -------------
-- One question and, once answered, its ruling — kept as the audit
-- trail. Two kinds so far:
--
--   authority-proposal   A source string with a proposed resolution
--                        (type it, mint it, or link it), its evidence,
--                        and its provenance. Produced by imports and
--                        subject-index-style loads; later by the
--                        extraction module. Created OPEN; a ruling
--                        (accepted / amended / rejected) closes it and,
--                        for mints, records what it produced in
--                        `result_id`.
--
--   duplicate-dismissal  The one piece of state the duplicates surface
--                        has always lacked: "not a duplicate",
--                        remembered. Created already RULED (ruling
--                        'dismissed') — the scan recomputes candidate
--                        pairs live, as before, and subtracts the pairs
--                        recorded here.
--
-- The vocabulary queue does NOT get rows here: vocabulary_terms already
-- carries its own status machine, and the Pending decisions surface
-- reads it directly. One front door, three sources — not one table over
-- everything.
--
-- OWNERSHIP AND WHO RULES
-- -----------------------
-- `tenant_id` follows 0067's shape exactly: set = this tenant's own
-- question, ruled by its admins; NULL = a shared-space question, ruled
-- by a federation steward. The gates are the ones that already exist
-- (requireAuthorityMutation / requireAuthorityMint); this table adds no
-- new permission rule.
--
-- Ruled rows are kept, not deleted: the row records who ruled what, on
-- which evidence, and what it produced. `payload` is JSON because the
-- two kinds carry different shapes and neither is queried by its parts;
-- everything the queue filters on is a real column.
--
-- Single CREATE TABLE plus one index on the queue's read path
-- (federation, status, kind); no backfill, no rewrite, no cascade.
--
-- Version: v0.7.0

CREATE TABLE pending_decisions (
  id TEXT PRIMARY KEY,
  federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE restrict,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE restrict,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  source_module TEXT NOT NULL,
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  ruling TEXT,
  ruling_note TEXT,
  result_id TEXT,
  ruled_by TEXT REFERENCES users(id) ON DELETE restrict,
  ruled_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_pending_decisions_queue
  ON pending_decisions (federation_id, status, kind);
