-- A federation gains its hosting statement, the part of each member
-- repository's attribution line that says where the materials are
-- hosted.
--
-- The statement is free text, held as an `_es`/`_en` column pair, either
-- of which may be null, and is used in the line as written. The line is
-- composed from the repository's name and place, its credit statement,
-- this statement and the image licence label, in that order; a
-- federation without a statement gets a line without it. The same line
-- feeds the export's `attribution` and the IIIF `requiredStatement`.
--
-- Both columns are nullable, so federations written before this
-- migration stay valid.
--
-- Version: v0.9.0

ALTER TABLE federations ADD COLUMN hosting_statement_es TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN hosting_statement_en TEXT;
