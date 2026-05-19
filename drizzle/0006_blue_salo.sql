-- Project archival timestamp
--
-- This migration adds a nullable `archived_at` epoch-ms column to
-- `projects` so a finished project can be soft-archived rather than
-- deleted. The project list filters on `archived_at IS NULL` for the
-- active view; the archive view inverts that filter. Existing rows
-- remain active by default.
--
-- Version: v0.3.0

ALTER TABLE `projects` ADD `archived_at` integer;