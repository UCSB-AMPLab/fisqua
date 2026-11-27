-- The catalogue licence moves from the federation to each repository, a
-- repository gains its home-page order, and a federation's citation
-- template splits into a site template and a record template.
--
-- A repository holds its own catalogue licence, the licence on the
-- metadata describing its holdings: `repositories.catalogue_licence_uri`
-- is a URI only, and its label is derived from the URI elsewhere. The
-- column is nullable, so repositories written before this migration stay
-- valid. `federations.catalogue_licence_uri`, added by migration 0119,
-- is dropped.
--
-- A federation cites itself in two places: the colophon, which uses the
-- site template, and each description page, which uses the record
-- template. Each template is an `_es`/`_en` column pair, either of which
-- may be null. `federations.citation_template_es` and
-- `citation_template_en`, added by migration 0119, are dropped.
--
-- `repositories.home_order` is the position of a repository's card on a
-- site's home page: an integer, ascending. It is nullable; a repository
-- without one sorts after the rest, by name.
--
-- None of the dropped columns has an index, constraint or default, so
-- `DROP COLUMN` is valid on D1.
--
-- Version: v0.9.0

ALTER TABLE repositories ADD COLUMN catalogue_licence_uri TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN home_order INTEGER;
--> statement-breakpoint
ALTER TABLE federations DROP COLUMN catalogue_licence_uri;
--> statement-breakpoint
ALTER TABLE federations DROP COLUMN citation_template_es;
--> statement-breakpoint
ALTER TABLE federations DROP COLUMN citation_template_en;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN citation_template_site_es TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN citation_template_site_en TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN citation_template_record_es TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN citation_template_record_en TEXT;
