-- Collaborative cataloguing admin and archive-user role flags
--
-- Adds two boolean flags to `users` for the evolving permission model.
-- `is_collab_admin` grants a user the ability to run the collaborative
-- cataloguing surfaces -- creating projects, inviting cataloguers and
-- reviewers, assigning volumes -- without needing full superadmin
-- access. `is_archive_user` is a reserved placeholder for a future
-- read-only research role that browses descriptions but cannot edit
-- them; no UI consumes it yet, but having the column in place avoids
-- a second migration when that role ships.
--
-- Both columns are additive and default to 0, so existing users
-- retain their current permissions with no backfill step.
--
-- Version: v0.3.0

ALTER TABLE users ADD COLUMN is_collab_admin INTEGER NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE users ADD COLUMN is_archive_user INTEGER NOT NULL DEFAULT 0;
