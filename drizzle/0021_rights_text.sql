-- Rights statement on repositories
--
-- Adds a free-form `rights_text` column to `repositories` so the
-- display page for each archive can surface the institution's own
-- licensing or reuse statement next to its description. Stored as
-- plain text to accept anything from a short CC-BY line to a long
-- institutional policy paragraph; downstream renderers sanitise
-- before display.
--
-- Version: v0.3.0

ALTER TABLE repositories ADD COLUMN rights_text TEXT;
