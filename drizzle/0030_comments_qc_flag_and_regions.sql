-- Unified comments: QC-flag threads and image-region pins
--
-- Extends the `comments` table twice over to fold QC-flag triage and
-- image-region annotation into a single conversation model.
--
-- First: comments can now attach to a `qc_flag` so that a flag stops
-- being a single description field and becomes a proper thread of
-- discussion between the reporter, the resolver, and anyone else
-- weighing in. A new nullable `qc_flag_id` foreign key references
-- `qc_flags(id)` with ON DELETE CASCADE, mirroring how `entry_id`
-- and `page_id` cascade today.
--
-- Second: page-targeted comments can carry image-region coordinates.
-- Four REAL columns -- `region_x`, `region_y`, `region_w`, `region_h`
-- -- hold a bounding box in the 0-1 normalised page coordinate space.
-- A single click becomes a pin (w = h = 0 or NULL) and a drag becomes
-- a box; either way, the viewer renders the region over the page
-- image. Regions live only alongside a `page_id`; they never attach
-- to an entry or a flag directly.
--
-- The one-of CHECK on `comments` extends from the earlier two-way XOR
-- on `(entry_id, page_id)` to a three-way XOR on `(entry_id, page_id,
-- qc_flag_id)`. Region columns are independent of this CHECK; the
-- "region requires page_id" invariant lives in the application layer
-- (`createComment` in `app/lib/comments.server.ts`) rather than the
-- database, because expressing it in a single CHECK would require
-- referencing two columns in a way that reads awkwardly against the
-- XOR above.
--
-- Every pre-existing comment survives cleanly. They are either
-- entry-targeted or page-targeted, never QC-flag-targeted (the column
-- did not exist), and none carry regions; the backfill below writes
-- NULL into the five new columns, which satisfies the new three-way
-- CHECK verbatim.
--
-- SQLite cannot alter a table's CHECK in place, so the standard
-- rebuild pattern applies: create `comments_new`, copy every row,
-- drop the old table, rename the new one into place, and rebuild
-- the indexes.
--
-- Version: v0.3.0

CREATE TABLE comments_new (
  id TEXT PRIMARY KEY,
  volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
  entry_id TEXT REFERENCES entries(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES volume_pages(id) ON DELETE CASCADE,
  qc_flag_id TEXT REFERENCES qc_flags(id) ON DELETE CASCADE,
  region_x REAL,
  region_y REAL,
  region_w REAL,
  region_h REAL,
  parent_id TEXT,
  author_id TEXT NOT NULL REFERENCES users(id),
  author_role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (entry_id IS NOT NULL AND page_id IS NULL     AND qc_flag_id IS NULL) OR
    (entry_id IS NULL     AND page_id IS NOT NULL AND qc_flag_id IS NULL) OR
    (entry_id IS NULL     AND page_id IS NULL     AND qc_flag_id IS NOT NULL)
  )
);

INSERT INTO comments_new
  (id, volume_id, entry_id, page_id, qc_flag_id,
   region_x, region_y, region_w, region_h,
   parent_id, author_id, author_role, text, created_at, updated_at)
SELECT
  id, volume_id, entry_id, page_id, NULL,
  NULL, NULL, NULL, NULL,
  parent_id, author_id, author_role, text, created_at, updated_at
FROM comments;

DROP TABLE comments;
ALTER TABLE comments_new RENAME TO comments;

CREATE INDEX comment_volume_idx   ON comments(volume_id);
CREATE INDEX comment_entry_idx    ON comments(entry_id);
CREATE INDEX comment_page_idx     ON comments(page_id);
CREATE INDEX comment_qc_flag_idx  ON comments(qc_flag_id);
CREATE INDEX comment_parent_idx   ON comments(parent_id);
