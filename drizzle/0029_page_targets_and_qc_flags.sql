-- Page-level annotations and digitisation quality-control flags
--
-- Extends the annotation model in two directions. First, comments can
-- now attach to either an entry (as before) or a specific page of a
-- volume -- but never both and never neither. A new `volume_id` column
-- on `comments` denormalises the owning volume so the viewer can
-- fetch a volume's annotations in one query regardless of whether
-- they anchor to entries or pages. Second, a new `qc_flags` table
-- captures typed digitisation problems against individual page
-- images (damaged, repeated, out-of-order, missing, blank, other)
-- with a resolution workflow that lets project leads mark them
-- resolved or wontfix.
--
-- SQLite cannot add a CHECK constraint or relax NOT NULL on an
-- existing table in place, so `comments` is rebuilt: create a
-- `comments_new` with the new shape and CHECK, copy every row over
-- with `volume_id` derived from the entry it already targets, drop
-- the old table, rename the new one into place. Every pre-existing
-- comment is entry-targeted by construction because `page_id` did
-- not exist before this migration.
--
-- The QC-flag table carries three CHECK constraints that catch
-- invalid transitions beyond what per-column enums can express:
--
--   1. An open flag has no resolution metadata; a resolved or
--      wontfix flag must carry all three fields (action, resolver,
--      resolved-at).
--   2. `problem_type = 'other'` requires a non-empty description.
--   3. `resolution_action = 'other'` requires a non-empty
--      resolver_note.
--
-- The `activity_log.event` column is plain TEXT at the SQLite
-- level, so the two new events this surface introduces
-- (`qc_flag_raised`, `qc_flag_resolved`) need no DDL here -- the
-- app layer's Drizzle enum owns the constraint.
--
-- Version: v0.3.0

CREATE TABLE comments_new (
  id TEXT PRIMARY KEY,
  volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
  entry_id TEXT REFERENCES entries(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES volume_pages(id) ON DELETE CASCADE,
  parent_id TEXT,
  author_id TEXT NOT NULL REFERENCES users(id),
  author_role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (entry_id IS NOT NULL AND page_id IS NULL) OR
    (entry_id IS NULL AND page_id IS NOT NULL)
  )
);

INSERT INTO comments_new (id, volume_id, entry_id, page_id, parent_id, author_id, author_role, text, created_at, updated_at)
SELECT c.id, e.volume_id, c.entry_id, NULL, c.parent_id, c.author_id, c.author_role, c.text, c.created_at, c.updated_at
FROM comments c
JOIN entries e ON e.id = c.entry_id;

DROP TABLE comments;
ALTER TABLE comments_new RENAME TO comments;

CREATE INDEX comment_volume_idx ON comments(volume_id);
CREATE INDEX comment_entry_idx  ON comments(entry_id);
CREATE INDEX comment_page_idx   ON comments(page_id);
CREATE INDEX comment_parent_idx ON comments(parent_id);

CREATE TABLE qc_flags (
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
  created_at INTEGER NOT NULL,
  CHECK (
    (status = 'open' AND resolution_action IS NULL AND resolved_by IS NULL AND resolved_at IS NULL)
    OR
    (status IN ('resolved','wontfix') AND resolution_action IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  CHECK (problem_type != 'other' OR length(description) > 0),
  CHECK (resolution_action != 'other' OR length(COALESCE(resolver_note, '')) > 0)
);

CREATE INDEX qc_flags_volume_status_idx ON qc_flags(volume_id, status);
CREATE INDEX qc_flags_page_idx          ON qc_flags(page_id);
CREATE INDEX qc_flags_reporter_idx      ON qc_flags(reported_by);
