-- Display metadata for repository landing pages
--
-- Adds three columns to `repositories` so each archive can present a
-- richer landing page on the public frontend: a `display_title` that
-- overrides the short institutional code, a `subtitle` for a one-line
-- framing beneath it, and a `hero_image_url` for the header banner.
-- All three are nullable; repositories without display metadata fall
-- back to the plain name and short code.
--
-- Version: v0.3.0

ALTER TABLE repositories ADD COLUMN display_title TEXT;
ALTER TABLE repositories ADD COLUMN subtitle TEXT;
ALTER TABLE repositories ADD COLUMN hero_image_url TEXT;
