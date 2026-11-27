-- A repository gains its credit statement, the part of the attribution
-- line that says who digitized the materials, with whom and with whose
-- support.
--
-- The statement is free text, one or more sentences written per
-- repository, held as an `_es`/`_en` column pair, either of which may be
-- null. There is no taxonomy of roles behind it, so a federation can
-- state its own arrangement. The attribution line is composed from the
-- repository's name, its place, the credit statement as written and the
-- image licence label; the structured funders in `repository_funders`
-- no longer feed the line.
--
-- Both columns are nullable, so repositories written before this
-- migration stay valid.
--
-- Version: v0.9.0

ALTER TABLE repositories ADD COLUMN credit_statement_es TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN credit_statement_en TEXT;
