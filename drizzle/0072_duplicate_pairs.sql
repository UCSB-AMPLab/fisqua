-- Duplicate pairs become decisions (design note:
-- duplicates-vocabulary-design.md, in the workspace repo's 0.7.0
-- release folder).
--
-- WHAT CHANGES
-- ------------
-- The 'duplicate-dismissal' kind (0069) recorded exactly one outcome:
-- "not a duplicate", created already ruled. The duplicates design round
-- makes a pair a full decision — it can carry a comment thread while
-- open, and it closes with one of two rulings: 'merged' (the pair was
-- the same record; the survivor is stamped in result_id) or
-- 'kept_both' (the pair stays two records — the same judgement the old
-- dismissal recorded, under the name the surface now uses).
--
-- So the old kind is absorbed rather than kept alongside: every
-- existing dismissal row becomes a ruled 'duplicate-pair' with ruling
-- 'kept_both'. Nothing else about the rows changes — ruler, timestamp,
-- payload (recordType + sorted pair) all stand.
--
-- SOURCE_REF BACKFILL
-- -------------------
-- The scan stays live and unpersisted; a pair row is created lazily,
-- when a comment lands on the pair or it is ruled. That get-or-create
-- needs a findable key, so source_ref now carries the order-independent
-- pair key ("<idA>|<idB>", ids sorted — the payload already stores the
-- pair sorted). Backfilled here from the payload JSON; dismissal rows
-- never set source_ref, so nothing is overwritten.
--
-- Data-only: kind and ruling have no CHECK constraints (they are
-- app-level enums), so no table rebuild is needed. No new columns, no
-- index changes.
--
-- Version: v0.7.0

UPDATE pending_decisions
SET kind = 'duplicate-pair',
    ruling = 'kept_both',
    source_ref = json_extract(payload, '$.pair[0]') || '|' ||
                 json_extract(payload, '$.pair[1]')
WHERE kind = 'duplicate-dismissal';
