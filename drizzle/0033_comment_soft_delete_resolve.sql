-- Comment soft-delete, resolve, and edit markers
--
-- Extends the `comments` table with five nullable columns so that a
-- comment can record soft-delete state, resolve state, and a last-edit
-- timestamp without a separate history table. Every column is
-- nullable; existing rows get NULL on arrival with no backfill.
-- Soft-delete filtering happens at read time inside the server
-- helpers (`getCommentsForEntry`, `getCommentsForPage`,
-- `getCommentsForQcFlag`, `getCommentsForVolume`) and at the outline
-- loader -- the database itself places no filter, so admin tooling
-- can still see deleted rows for auditing.
--
-- Semantics of the five new columns:
--
--   - `deleted_at` / `deleted_by` -- set by `softDeleteComment`.
--     Deleting a root cascades to its replies in the same UPDATE
--     by matching `parent_id` to the root id; deleting a reply
--     marks only that one row. There is no hard-delete path.
--   - `resolved_at` / `resolved_by` -- set only on roots
--     (`parent_id IS NULL`). Any editor can flip a thread to
--     resolved; only a lead can clear the resolve state.
--   - `edited_at` -- last body edit timestamp. Coordinate moves
--     (dragging a region pin to a new position, for instance)
--     bump `updated_at` but leave `edited_at` untouched, so the
--     card's "Editado" chip only lights up for true body edits.
--
-- No new indexes. Soft-deleted rows are cheap to filter at read
-- time on a per-volume or per-entry query, and adding `deleted_at`
-- to the existing indexes would churn for no practical benefit at
-- D1 scale.
--
-- Version: v0.3.0

ALTER TABLE comments ADD COLUMN deleted_at INTEGER;
--> statement-breakpoint
ALTER TABLE comments ADD COLUMN deleted_by TEXT REFERENCES users(id);
--> statement-breakpoint
ALTER TABLE comments ADD COLUMN resolved_at INTEGER;
--> statement-breakpoint
ALTER TABLE comments ADD COLUMN resolved_by TEXT REFERENCES users(id);
--> statement-breakpoint
ALTER TABLE comments ADD COLUMN edited_at INTEGER;
