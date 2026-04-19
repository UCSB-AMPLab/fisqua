-- Link QC flags to their region-anchored comment
--
-- When a cataloguer raises a QC flag from the viewer's "Vincular a
-- region" affordance, they can either pick an existing region comment
-- on the page or draw a fresh region alongside the flag. Either way,
-- the flag needs a durable pointer back to the comment that holds
-- the region coordinates so that future views of the flag can jump
-- straight to the exact location on the page. This migration adds a
-- nullable `region_comment_id` foreign key on `qc_flags`, referencing
-- `comments(id)` with ON DELETE SET NULL.
--
-- ON DELETE SET NULL -- not CASCADE -- for two reasons. First, a lead
-- may delete the placeholder region comment to tidy up the page
-- overlay; the flag itself is a quality-control signal that has to
-- survive that cleanup until it is explicitly resolved. Second, the
-- inverse direction already cascades (deleting a flag deletes its
-- conversation thread via `comments.qc_flag_id`); making this side
-- cascade too would risk a flag-deletes-comment-deletes-flag loop
-- on future schema evolution.
--
-- The cross-table invariant -- the flag's `page_id` must match the
-- linked comment's `page_id`, and the comment must be page-targeted
-- with region coordinates set -- lives in the application layer in
-- the `/api/qc-flags` POST handler, not in a multi-table CHECK,
-- because SQLite CHECK constraints cannot reference other tables.
--
-- SQLite cannot add a foreign-key column in place on every version
-- Cloudflare D1 exposes, so the rebuild pattern applies: create
-- `qc_flags_new`, copy every row with NULL for the new column, drop
-- the old table, rename the new one into place, and rebuild the
-- indexes.
--
-- Version: v0.3.0

CREATE TABLE qc_flags_new (
  id TEXT PRIMARY KEY,
  volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES volume_pages(id) ON DELETE CASCADE,
  reported_by TEXT NOT NULL REFERENCES users(id),
  problem_type TEXT NOT NULL CHECK (problem_type IN ('damaged','repeated','out_of_order','missing','blank','other')),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','wontfix')),
  resolution_action TEXT CHECK (resolution_action IS NULL OR resolution_action IN ('retake_requested','reordered','marked_duplicate','ignored','other')),
  resolver_note TEXT,
  resolved_by TEXT REFERENCES users(id),
  resolved_at INTEGER,
  region_comment_id TEXT REFERENCES comments(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  CHECK (
    (status = 'open' AND resolution_action IS NULL AND resolved_by IS NULL AND resolved_at IS NULL)
    OR
    (status IN ('resolved','wontfix') AND resolution_action IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  CHECK (problem_type != 'other' OR length(description) > 0),
  CHECK (resolution_action != 'other' OR length(COALESCE(resolver_note, '')) > 0)
);

INSERT INTO qc_flags_new
  (id, volume_id, page_id, reported_by, problem_type, description,
   status, resolution_action, resolver_note, resolved_by, resolved_at,
   region_comment_id, created_at)
SELECT
  id, volume_id, page_id, reported_by, problem_type, description,
  status, resolution_action, resolver_note, resolved_by, resolved_at,
  NULL, created_at
FROM qc_flags;

DROP TABLE qc_flags;
ALTER TABLE qc_flags_new RENAME TO qc_flags;

CREATE INDEX qc_flags_volume_status_idx     ON qc_flags(volume_id, status);
CREATE INDEX qc_flags_page_idx              ON qc_flags(page_id);
CREATE INDEX qc_flags_reporter_idx          ON qc_flags(reported_by);
CREATE INDEX qc_flags_region_comment_idx    ON qc_flags(region_comment_id);
