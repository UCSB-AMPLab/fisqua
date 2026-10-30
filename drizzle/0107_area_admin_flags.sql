-- Users: the four area-admin flags.
--
-- This migration adds the four area-admin flags to users. A workspace's
-- administration splits by area. `is_admin` stays the workspace admin,
-- who passes every area; each of the four columns below names the admin
-- of one area, who passes that area alone:
--
--   - `is_records_admin`: descriptions, repositories, vocabularies,
--     entity functions and vocabulary decisions;
--   - `is_authorities_admin`: entities, places, authority handlists
--     and the authority decisions;
--   - `is_imports_admin`: imports;
--   - `is_digitization_admin`: the Digitization screens and capture QC.
--
-- Each column is declared as `is_cataloguer` is: an integer boolean,
-- not null, default 0. No existing user takes a flag here; every row
-- reads 0 until an admin grants one, so no one gains or loses access
-- when the migration is applied. Workspace admins (and super admins)
-- keep every area they reach today.
--
-- Version: v0.8.0

ALTER TABLE users ADD COLUMN is_records_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN is_authorities_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN is_imports_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN is_digitization_admin INTEGER NOT NULL DEFAULT 0;
