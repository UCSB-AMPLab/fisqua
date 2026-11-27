-- Relations between people named in a document.
--
-- A relation stated in a document is two links to that description, one
-- for each person, each pointing to the other. The roles, their groups,
-- their inverses and the link attributes are each federation's own
-- vocabulary; Fisqua names none of them. This migration gives the three
-- tables what that needs.
--
-- `vocabulary_values` takes three more lists: `relation_role`,
-- `link_attribute` and `gender` (the codes `entities.gender` holds). It
-- gains, for those lists only:
--   - `connector_es`, `connector_en`: the word between a relation's
--     label and the other person's name (null means the default, "de" /
--     "of");
--   - `inverse_code`: the code on the other side of a relation, the same
--     code for a symmetric one;
--   - `hide_when_group`: on a link attribute, the relation group whose
--     presence on the same row hides it on Zasqua;
--   - four label forms per language, `label_<lang>_female`, `_male`,
--     `_unrecorded` (gender not recorded) and `_alone` (no name after
--     it; null where it is the same as the unrecorded form).
-- `label_es` and `label_en` keep their meaning. SQLite cannot alter a
-- CHECK, so the table is rebuilt as 0124 rebuilt `audit_log`: a new
-- table with every old column, the new ones and the wider CHECK, every
-- row copied with its values unchanged, the old table dropped, the new
-- one renamed and its two indexes created again as 0119 has them. No
-- table, trigger or view references `vocabulary_values`.
--
-- `entities` gains `gender` (a vocabulary code, or null when not
-- recorded), `known_only_from_relation` (1 for a person recorded only
-- because a relation names them; 0 on every existing row) and
-- `qualified_name` (a stored name that tells apart a person known by a
-- given name alone). ADD COLUMN leaves the FTS triggers as they are:
-- they name content columns only.
--
-- `description_entities` gains `related_to` (on a relation side, the id
-- of the other person's link in the same description, a foreign key to
-- the table itself),
-- `relation_certainty` (null when the document states the relation;
-- otherwise `doubtful`, `inferred` or `derived`, Fisqua's own values)
-- and `attributes` (a JSON object from attribute key to the value as
-- written). Every non-empty `function` moves into `attributes` under
-- `office`, encoded by json_object so quotes and backslashes keep their
-- value; a null or empty one leaves `{}`. `function` is then dropped:
-- it is in no index, trigger, view or CHECK, so DROP COLUMN rewrites the
-- one table and issues no DELETE (0048's reasoning).
--
-- The unique index on links becomes (description_id, entity_id, role,
-- COALESCE(related_to, '')), under the same name: a person may hold a
-- document-role link and a relation side with the same role on one
-- description, or relation sides towards two different people, but not
-- two links that are the same in all four. The new index is strictly
-- weaker than the old one, so no existing row can violate it.
-- `de_related_to_idx` finds the link that points to a given link (the
-- other side, when one side is changed or removed); it covers relation
-- sides only, and serves the foreign key's check on every delete.
--
-- The foreign key holds the invariant that no link names a link that is
-- gone, whatever path writes: D1 enforces foreign keys, so a DELETE of a
-- link another link names, or a `related_to` naming a missing link,
-- fails its statement and the batch around it. It is ON DELETE NO
-- ACTION, not RESTRICT: NO ACTION checks at the end of the statement,
-- so deleting a description (whose links go by its CASCADE), or both
-- sides of a relation in one DELETE, still succeeds, while RESTRICT
-- refuses a row the moment it goes even when the row naming it goes in
-- the same statement. Either way a single side cannot be removed while
-- named. ADD COLUMN may carry REFERENCES because the default is NULL.
--
-- Version: v0.9.0

CREATE TABLE vocabulary_values_next (
  id TEXT PRIMARY KEY NOT NULL,
  federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE RESTRICT,
  list TEXT NOT NULL
    CHECK (list IN ('entity_type','place_type','entity_role','place_role','role_group','relation_role','link_attribute','gender')),
  code TEXT NOT NULL,
  label_es TEXT,
  label_en TEXT,
  group_code TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  external_scheme TEXT,
  external_uri TEXT,
  external_label TEXT,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','proposed','deprecated')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  connector_es TEXT,
  connector_en TEXT,
  inverse_code TEXT,
  hide_when_group TEXT,
  label_es_female TEXT,
  label_es_male TEXT,
  label_es_unrecorded TEXT,
  label_es_alone TEXT,
  label_en_female TEXT,
  label_en_male TEXT,
  label_en_unrecorded TEXT,
  label_en_alone TEXT
);
--> statement-breakpoint
INSERT INTO vocabulary_values_next (
  id, federation_id, list, code, label_es, label_en, group_code, position,
  external_scheme, external_uri, external_label, status, created_at, updated_at
)
SELECT
  id, federation_id, list, code, label_es, label_en, group_code, position,
  external_scheme, external_uri, external_label, status, created_at, updated_at
FROM vocabulary_values;
--> statement-breakpoint
DROP TABLE vocabulary_values;
--> statement-breakpoint
ALTER TABLE vocabulary_values_next RENAME TO vocabulary_values;
--> statement-breakpoint
CREATE UNIQUE INDEX vocabulary_values_federation_list_code_idx ON vocabulary_values (federation_id, list, code);
--> statement-breakpoint
CREATE INDEX vocabulary_values_position_idx ON vocabulary_values (federation_id, list, position);
--> statement-breakpoint
ALTER TABLE entities ADD COLUMN gender TEXT;
--> statement-breakpoint
ALTER TABLE entities ADD COLUMN known_only_from_relation INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE entities ADD COLUMN qualified_name TEXT;
--> statement-breakpoint
ALTER TABLE description_entities ADD COLUMN related_to TEXT REFERENCES description_entities(id) ON DELETE NO ACTION;
--> statement-breakpoint
ALTER TABLE description_entities ADD COLUMN relation_certainty TEXT
  CHECK (relation_certainty IS NULL OR relation_certainty IN ('doubtful','inferred','derived'));
--> statement-breakpoint
ALTER TABLE description_entities ADD COLUMN attributes TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(attributes) AND json_type(attributes) = 'object');
--> statement-breakpoint
UPDATE description_entities
SET attributes = json_object('office', function)
WHERE function IS NOT NULL AND function <> '';
--> statement-breakpoint
ALTER TABLE description_entities DROP COLUMN function;
--> statement-breakpoint
DROP INDEX de_unique_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX de_unique_idx ON description_entities (description_id, entity_id, role, COALESCE(related_to, ''));
--> statement-breakpoint
CREATE INDEX de_related_to_idx ON description_entities (related_to) WHERE related_to IS NOT NULL;
