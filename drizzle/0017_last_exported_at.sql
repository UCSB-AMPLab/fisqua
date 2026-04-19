-- Track last publish time per description
--
-- Adds a nullable `last_exported_at` timestamp to `descriptions` so the
-- admin publish dashboard can show a Live, Pending publish, or Pending
-- removal badge against every record. A record that has never been
-- exported carries NULL; once the publish pipeline writes a snapshot to
-- R2, this column is set to the completion timestamp and compared
-- against `updated_at` on subsequent views to detect pending edits.
--
-- Version: v0.3.0

ALTER TABLE descriptions ADD COLUMN last_exported_at INTEGER;
