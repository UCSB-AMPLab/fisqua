-- Link promoted entries back to the description they created
--
-- Once a cataloguer finishes segmenting and describing a volume entry,
-- a project lead can promote that entry into a standalone archival
-- description. This column records the description row that was
-- created at promotion time so the entry page can show its promoted
-- status, offer a link to the resulting description, and block
-- duplicate promotions of the same entry.
--
-- Version: v0.3.0

ALTER TABLE entries ADD COLUMN promoted_description_id TEXT REFERENCES descriptions(id);
CREATE INDEX IF NOT EXISTS entry_promoted_idx ON entries(promoted_description_id);
