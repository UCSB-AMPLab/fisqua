-- Stored duplicate candidates, and the triggers that mark records for a recheck.
--
-- The duplicate-candidate list is computed ahead of time by a scheduled
-- job and read from three stored tables, so a page that shows candidates
-- reads rows instead of comparing every pair of entity records. This
-- migration adds the schema and the marking triggers. It writes no row;
-- the job that fills the tables is separate.
--
--   - `entities.name_key`, indexed with `federation_id`: the normalised
--     name the job groups records by. The column is empty until the job
--     fills it.
--   - `duplicate_recheck`: one row per record the job must look at again,
--     an entity (`description_id` empty) or an entity on one description.
--     The triggers delete a record's mark and insert it again, so marking a
--     record again gives its row a higher `seq` (AUTOINCREMENT never reuses one).
--     The job reads rows up to a `seq` and clears the rows it has read by
--     `seq`, so a mark made while it runs is kept for the next run.
--   - `duplicate_name_deletions`: the name-key deletion variants of each
--     entity, which the job uses to find names one edit apart.
--   - `duplicate_candidates`: the candidate pairs, with `id_a < id_b`, the
--     facts that bring each pair together as JSON, and a weight to sort by.
--
-- The marking triggers fire on these writes, each with
-- `marked_at = unixepoch() * 1000`:
--
--   - `entities`: insert; update of display_name, date_start, date_end,
--     dates_of_existence (the dates the stored facts show), merged_into
--     or tenant_id when the value changes; delete. An update
--     to any other column marks nothing.
--   - `entity_functions`: insert, update and delete, marking the entity.
--   - `description_entities`: insert, update and delete, marking the
--     entity with the description. A relation side is a row of this table,
--     so relations are marked too. An update marks the old and the new
--     entity, which covers a link moved from one entity to another, and
--     only when entity_id, description_id or related_to changes: the facts
--     read no other column of a link (its role, sequence, notes and
--     attributes, the office among them, count for nothing), so a reorder
--     or a note marks nothing.
--   - `authority_operations`: an entity separate, split or merge with a
--     target marks its source and its target.
--   - `pending_decisions`: a duplicate-pair row inserted, or its status
--     updated, marks the two ids held in `source_ref` as "<idA>|<idB>".
--
--   - Rows a REPLACE would displace: SQLite fires no DELETE or UPDATE
--     trigger for a row that INSERT OR REPLACE removes, so a BEFORE INSERT
--     trigger on `entities` (same id, or same federation and entity code),
--     `entity_functions` (same id) and `description_entities` (same id)
--     marks the row about to be displaced.
--
--   - Facts a record takes from its descriptions: a place added to, changed
--     on or removed from a description (`description_places`) marks every
--     entity with a non-relation link (`related_to` empty) to that
--     description, and an update of `descriptions.tenant_id` to a new value
--     does the same. These marks carry an empty `description_id`, and an
--     update of a place link marks the entities of the old and the new
--     description. Each is a set: one DELETE of the entities' marks, then
--     one INSERT ... SELECT DISTINCT.
--
-- Every mark is two statements: a DELETE of the record's existing mark,
-- then a plain INSERT. No conflict remains after the DELETE, so the INSERT
-- succeeds under any outer clause (OR IGNORE, OR ABORT, OR REPLACE) and a
-- re-mark always gets a new, higher `seq`. An OR REPLACE in the trigger
-- body would be overridden by an outer OR IGNORE, which keeps the old
-- `seq`, and would fail under an outer OR ABORT or OR FAIL.
--
-- Each trigger keeps its condition in the WHEN clause and its body free of
-- CASE expressions, which keeps clear of the workers-sdk #4326 trigger
-- parser quirk on remote D1.
--
-- Version: v0.9.0

ALTER TABLE entities ADD COLUMN name_key TEXT;
--> statement-breakpoint
CREATE INDEX entities_name_key_idx ON entities(federation_id, name_key);
--> statement-breakpoint
CREATE TABLE duplicate_recheck (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  description_id TEXT NOT NULL DEFAULT '',
  marked_at INTEGER NOT NULL,
  UNIQUE (entity_id, description_id)
);
--> statement-breakpoint
CREATE TABLE duplicate_name_deletions (
  federation_id TEXT NOT NULL,
  deletion TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (federation_id, deletion, entity_id)
);
--> statement-breakpoint
CREATE INDEX duplicate_name_deletions_entity_idx ON duplicate_name_deletions(entity_id);
--> statement-breakpoint
CREATE TABLE duplicate_candidates (
  id_a TEXT NOT NULL,
  id_b TEXT NOT NULL,
  federation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  facts TEXT NOT NULL,
  weight INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id_a, id_b)
);
--> statement-breakpoint
CREATE INDEX duplicate_candidates_weight_idx ON duplicate_candidates(tenant_id, weight DESC);
--> statement-breakpoint
CREATE INDEX duplicate_candidates_id_a_idx ON duplicate_candidates(id_a);
--> statement-breakpoint
CREATE INDEX duplicate_candidates_id_b_idx ON duplicate_candidates(id_b);
--> statement-breakpoint
CREATE TRIGGER entities_duplicate_recheck_insert
AFTER INSERT ON entities
BEGIN
  DELETE FROM duplicate_recheck WHERE entity_id = NEW.id AND description_id = '';
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) VALUES (NEW.id, '', unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER entities_duplicate_recheck_update
AFTER UPDATE OF display_name, date_start, date_end, dates_of_existence, merged_into, tenant_id ON entities
WHEN OLD.display_name IS NOT NEW.display_name OR OLD.date_start IS NOT NEW.date_start OR OLD.date_end IS NOT NEW.date_end OR OLD.dates_of_existence IS NOT NEW.dates_of_existence OR OLD.merged_into IS NOT NEW.merged_into OR OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  DELETE FROM duplicate_recheck WHERE entity_id = NEW.id AND description_id = '';
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) VALUES (NEW.id, '', unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER entities_duplicate_recheck_delete
AFTER DELETE ON entities
BEGIN
  DELETE FROM duplicate_recheck WHERE entity_id = OLD.id AND description_id = '';
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) VALUES (OLD.id, '', unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER entity_functions_duplicate_recheck_insert
AFTER INSERT ON entity_functions
BEGIN
  DELETE FROM duplicate_recheck WHERE entity_id = NEW.entity_id AND description_id = '';
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) VALUES (NEW.entity_id, '', unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER entity_functions_duplicate_recheck_update
AFTER UPDATE ON entity_functions
BEGIN
  DELETE FROM duplicate_recheck WHERE entity_id = OLD.entity_id AND description_id = '';
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) VALUES (OLD.entity_id, '', unixepoch() * 1000);
  DELETE FROM duplicate_recheck WHERE entity_id = NEW.entity_id AND description_id = '';
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) VALUES (NEW.entity_id, '', unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER entity_functions_duplicate_recheck_delete
AFTER DELETE ON entity_functions
BEGIN
  DELETE FROM duplicate_recheck WHERE entity_id = OLD.entity_id AND description_id = '';
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) VALUES (OLD.entity_id, '', unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER description_entities_duplicate_recheck_insert
AFTER INSERT ON description_entities
BEGIN
  DELETE FROM duplicate_recheck WHERE entity_id = NEW.entity_id AND description_id = NEW.description_id;
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) VALUES (NEW.entity_id, NEW.description_id, unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER description_entities_duplicate_recheck_update
AFTER UPDATE ON description_entities
WHEN OLD.entity_id IS NOT NEW.entity_id OR OLD.description_id IS NOT NEW.description_id OR OLD.related_to IS NOT NEW.related_to
BEGIN
  DELETE FROM duplicate_recheck WHERE entity_id = OLD.entity_id AND description_id = OLD.description_id;
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) VALUES (OLD.entity_id, OLD.description_id, unixepoch() * 1000);
  DELETE FROM duplicate_recheck WHERE entity_id = NEW.entity_id AND description_id = NEW.description_id;
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) VALUES (NEW.entity_id, NEW.description_id, unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER description_entities_duplicate_recheck_delete
AFTER DELETE ON description_entities
BEGIN
  DELETE FROM duplicate_recheck WHERE entity_id = OLD.entity_id AND description_id = OLD.description_id;
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) VALUES (OLD.entity_id, OLD.description_id, unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER authority_operations_duplicate_recheck
AFTER INSERT ON authority_operations
WHEN NEW.record_type = 'entity' AND NEW.operation IN ('separate', 'split', 'merge') AND NEW.target_id IS NOT NULL
BEGIN
  DELETE FROM duplicate_recheck WHERE entity_id = NEW.source_id AND description_id = '';
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) VALUES (NEW.source_id, '', unixepoch() * 1000);
  DELETE FROM duplicate_recheck WHERE entity_id = NEW.target_id AND description_id = '';
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) VALUES (NEW.target_id, '', unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER pending_decisions_duplicate_recheck_insert
AFTER INSERT ON pending_decisions
WHEN NEW.kind = 'duplicate-pair' AND NEW.source_ref LIKE '%|%'
BEGIN
  DELETE FROM duplicate_recheck WHERE entity_id = substr(NEW.source_ref, 1, instr(NEW.source_ref, '|') - 1) AND description_id = '';
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) VALUES (substr(NEW.source_ref, 1, instr(NEW.source_ref, '|') - 1), '', unixepoch() * 1000);
  DELETE FROM duplicate_recheck WHERE entity_id = substr(NEW.source_ref, instr(NEW.source_ref, '|') + 1) AND description_id = '';
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) VALUES (substr(NEW.source_ref, instr(NEW.source_ref, '|') + 1), '', unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER pending_decisions_duplicate_recheck_update
AFTER UPDATE OF status ON pending_decisions
WHEN NEW.kind = 'duplicate-pair' AND NEW.source_ref LIKE '%|%'
BEGIN
  DELETE FROM duplicate_recheck WHERE entity_id = substr(NEW.source_ref, 1, instr(NEW.source_ref, '|') - 1) AND description_id = '';
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) VALUES (substr(NEW.source_ref, 1, instr(NEW.source_ref, '|') - 1), '', unixepoch() * 1000);
  DELETE FROM duplicate_recheck WHERE entity_id = substr(NEW.source_ref, instr(NEW.source_ref, '|') + 1) AND description_id = '';
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) VALUES (substr(NEW.source_ref, instr(NEW.source_ref, '|') + 1), '', unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER entities_duplicate_recheck_replace
BEFORE INSERT ON entities
WHEN EXISTS (SELECT 1 FROM entities WHERE id = NEW.id OR (federation_id = NEW.federation_id AND entity_code = NEW.entity_code))
BEGIN
  DELETE FROM duplicate_recheck WHERE description_id = '' AND entity_id IN (SELECT id FROM entities WHERE id = NEW.id OR (federation_id = NEW.federation_id AND entity_code = NEW.entity_code));
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) SELECT id, '', unixepoch() * 1000 FROM entities WHERE id = NEW.id OR (federation_id = NEW.federation_id AND entity_code = NEW.entity_code);
END;
--> statement-breakpoint
CREATE TRIGGER entity_functions_duplicate_recheck_replace
BEFORE INSERT ON entity_functions
WHEN EXISTS (SELECT 1 FROM entity_functions WHERE id = NEW.id)
BEGIN
  DELETE FROM duplicate_recheck WHERE description_id = '' AND entity_id IN (SELECT entity_id FROM entity_functions WHERE id = NEW.id);
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) SELECT entity_id, '', unixepoch() * 1000 FROM entity_functions WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER description_entities_duplicate_recheck_replace
BEFORE INSERT ON description_entities
WHEN EXISTS (SELECT 1 FROM description_entities WHERE id = NEW.id)
BEGIN
  DELETE FROM duplicate_recheck WHERE EXISTS (SELECT 1 FROM description_entities AS old WHERE old.id = NEW.id AND old.entity_id = duplicate_recheck.entity_id AND old.description_id = duplicate_recheck.description_id);
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) SELECT entity_id, description_id, unixepoch() * 1000 FROM description_entities WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER description_places_duplicate_recheck_insert
AFTER INSERT ON description_places
BEGIN
  DELETE FROM duplicate_recheck WHERE description_id = '' AND entity_id IN (SELECT entity_id FROM description_entities WHERE description_id = NEW.description_id AND related_to IS NULL);
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) SELECT DISTINCT entity_id, '', unixepoch() * 1000 FROM description_entities WHERE description_id = NEW.description_id AND related_to IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER description_places_duplicate_recheck_update
AFTER UPDATE ON description_places
BEGIN
  DELETE FROM duplicate_recheck WHERE description_id = '' AND entity_id IN (SELECT entity_id FROM description_entities WHERE description_id = OLD.description_id AND related_to IS NULL);
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) SELECT DISTINCT entity_id, '', unixepoch() * 1000 FROM description_entities WHERE description_id = OLD.description_id AND related_to IS NULL;
  DELETE FROM duplicate_recheck WHERE description_id = '' AND entity_id IN (SELECT entity_id FROM description_entities WHERE description_id = NEW.description_id AND related_to IS NULL);
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) SELECT DISTINCT entity_id, '', unixepoch() * 1000 FROM description_entities WHERE description_id = NEW.description_id AND related_to IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER description_places_duplicate_recheck_delete
AFTER DELETE ON description_places
BEGIN
  DELETE FROM duplicate_recheck WHERE description_id = '' AND entity_id IN (SELECT entity_id FROM description_entities WHERE description_id = OLD.description_id AND related_to IS NULL);
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) SELECT DISTINCT entity_id, '', unixepoch() * 1000 FROM description_entities WHERE description_id = OLD.description_id AND related_to IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER descriptions_duplicate_recheck_tenant
AFTER UPDATE OF tenant_id ON descriptions
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  DELETE FROM duplicate_recheck WHERE description_id = '' AND entity_id IN (SELECT entity_id FROM description_entities WHERE description_id = NEW.id AND related_to IS NULL);
  INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) SELECT DISTINCT entity_id, '', unixepoch() * 1000 FROM description_entities WHERE description_id = NEW.id AND related_to IS NULL;
END;
