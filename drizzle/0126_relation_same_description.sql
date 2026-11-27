-- A relation side names a link on its own description.
--
-- A relation stated in a document is two links to that description, each
-- naming the other in `related_to` (0125). The foreign key on
-- `related_to` lets a link name any link at all, on any description and
-- of any tenant. This migration adds four triggers on
-- `description_entities` so the database itself refuses a `related_to`
-- that names a link elsewhere, whatever path writes it:
--
--   - `description_entities_related_to_insert`, BEFORE INSERT, and
--     `description_entities_related_to_update`, BEFORE UPDATE OF
--     related_to: a non-null `related_to` must name a link that exists
--     and is on the row's own description. A link naming itself passes:
--     `add-relation` writes its first side naming itself, the second
--     naming the first, and then the first naming the second, so the
--     foreign key holds at every statement. The insert trigger also
--     refuses a row whose id a link on another description already names,
--     which an INSERT OR REPLACE of a named link would otherwise allow,
--     since no update trigger fires on a replace.
--   - `description_entities_related_to_move`, BEFORE UPDATE OF
--     description_id: a link that names another may not move to a
--     description other than that link's, and a link that another names
--     may not move away from the description of the link naming it.
--
--   - `description_entities_id_fixed`, BEFORE UPDATE OF id: a link's id
--     never changes. Without it, an UPDATE OR REPLACE or an upsert that
--     renames a row onto a named link's id would bypass the other three.
--
-- The first three refuse with RAISE(ABORT) and the same message. The condition is
-- in the WHEN clause and the body is a bare RAISE, as in 0037, which
-- keeps clear of the workers-sdk #4326 trigger-parser quirk with CASE
-- expressions on remote D1. Nothing in the app or the command line moves
-- a link to another description; a merge, a split or a link move changes
-- `entity_id`, which no trigger watches.
--
-- The migration writes no row. Staging held 1,856 relation links when it
-- was written, none naming a link on another description; production
-- held no relation links.
--
-- Version: v0.9.0

CREATE TRIGGER description_entities_related_to_insert
BEFORE INSERT ON description_entities
WHEN (
    NEW.related_to IS NOT NULL
    AND NEW.related_to IS NOT NEW.id
    AND NOT EXISTS (
      SELECT 1 FROM description_entities AS named
      WHERE named.id = NEW.related_to AND named.description_id = NEW.description_id
    )
  )
  OR EXISTS (
    SELECT 1 FROM description_entities AS naming
    WHERE naming.related_to = NEW.id AND naming.id IS NOT NEW.id AND naming.description_id IS NOT NEW.description_id
  )
BEGIN
  SELECT RAISE(ABORT, 'a relation side must name a link on its own description');
END;
--> statement-breakpoint
CREATE TRIGGER description_entities_related_to_update
BEFORE UPDATE OF related_to ON description_entities
WHEN NEW.related_to IS NOT NULL
  AND NEW.related_to IS NOT NEW.id
  AND NOT EXISTS (
    SELECT 1 FROM description_entities AS named
    WHERE named.id = NEW.related_to AND named.description_id = NEW.description_id
  )
BEGIN
  SELECT RAISE(ABORT, 'a relation side must name a link on its own description');
END;
--> statement-breakpoint
CREATE TRIGGER description_entities_related_to_move
BEFORE UPDATE OF description_id ON description_entities
WHEN (
    NEW.related_to IS NOT NULL
    AND NEW.related_to IS NOT NEW.id
    AND NOT EXISTS (
      SELECT 1 FROM description_entities AS named
      WHERE named.id = NEW.related_to AND named.description_id = NEW.description_id
    )
  )
  OR EXISTS (
    SELECT 1 FROM description_entities AS naming
    WHERE naming.related_to = NEW.id AND naming.id IS NOT NEW.id AND naming.description_id IS NOT NEW.description_id
  )
BEGIN
  SELECT RAISE(ABORT, 'a relation side must name a link on its own description');
END;

--> statement-breakpoint
CREATE TRIGGER description_entities_id_fixed
BEFORE UPDATE OF id ON description_entities
WHEN NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT, 'a link''s id cannot be changed');
END;
