-- Who publishes a federation's records, as its METS files name it.
--
-- This migration adds four columns to `federations`: `publisher_name`,
-- the organisation that publishes the federation's records;
-- `publisher_tax_id`, its tax or registration number as it should be
-- printed, for example 'NIT 900.861.407'; `publisher_location`, where
-- it is, for example 'Bogotá, Colombia'; and `publisher_url`, its web
-- address. A publish writes the METS creator agent from them for every
-- member's records, whichever member holds them: the name, followed by
-- the tax id in parentheses and the location after a comma when they
-- are set, and the address as the agent's note.
--
-- The columns are nullable. A federation without a publisher name
-- falls back to its lead tenant's provider name, then to its own name;
-- a workspace that is not in a multi-member federation uses its own
-- provider name and address, then its name. They are set by the
-- operator; no page edits them yet.
--
-- Version: v0.9.0
ALTER TABLE federations ADD COLUMN publisher_name TEXT;
ALTER TABLE federations ADD COLUMN publisher_tax_id TEXT;
ALTER TABLE federations ADD COLUMN publisher_location TEXT;
ALTER TABLE federations ADD COLUMN publisher_url TEXT;
