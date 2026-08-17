-- Unified comments: decision_comments folds into comments (rebuild #3)
--
-- Ruling (2026-08-13, "Comments are one record class"):
-- comments are one archival record class. Fisqua's import synthesis, a
-- colleague's reading, an intern's merge proposal, and a reviewer's
-- send-back note are the same kind of object, so they share one table;
-- surfaces differ, storage does not. decision_comments (0070) shipped
-- to no environment beyond local dev, so this fold is a rename of an
-- idea, not a data migration: production applies 0069-0071 as one
-- sequence and never holds a populated decision_comments.
--
-- comments has been rebuilt twice before (0029 added page targets and
-- the XOR CHECK; 0030 added qc-flag targets and regions); this is the
-- same recipe, third application, under 0035's transaction rules:
-- defer_foreign_keys=ON (foreign_keys=OFF is a silent no-op inside
-- D1's per-file Durable Object transaction), explicit column lists on
-- every INSERT...SELECT, indexes recreated after the rename, and a
-- foreign_key_check before the file ends.
--
-- 0042's caveat -- defer_foreign_keys defers constraint CHECKS but not
-- ON DELETE actions, so dropping a table with populated cascade
-- children destroys them mid-migration -- does not bite here. The only
-- inbound FK to comments is qc_flags.region_comment_id, ON DELETE SET
-- NULL and documented dead (no application code reads or writes it;
-- see app/db/schema.ts). Dropping the old comments table nulls that
-- dead column on any row still holding a value, which is harmless and
-- accepted. decision_comments has no children at all.
--
-- What changes on comments:
--   * decision_id: fourth XOR target, FK to pending_decisions ON
--     DELETE RESTRICT -- the database now enforces that a decision
--     carrying its case file is never hard-deleted.
--   * author becomes person-XOR-agency: author_id relaxes to nullable,
--     author_label arrives ("Fisqua" for the system's own comments),
--     exactly one set (CHECK).
--   * volume_id and tenant_id relax to nullable, each CHECKed to stay
--     required for the three volume-anchored targets; a decision
--     comment copies its decision's tenant (null for federation-level
--     decisions).
--   * author_role relaxes to nullable: still a role snapshot at post
--     time (now including tenant-level roles on decision comments);
--     null only for label authors.
--   * quote, quote_ref, note: one quoted passage per comment with its
--     reference, and an epistemic qualifier. Prose stays in text
--     (NOT NULL); the "quoted from this workspace's own catalogue"
--     line is render-time i18n, never stored.
--
-- pending_decisions gains filed_by_user_id (nullable FK): pipeline
-- filings leave it null and speak through a label-authored comment;
-- human-filed proposals record their proposer.
--
-- Version: v0.7.0

PRAGMA defer_foreign_keys=ON;

CREATE TABLE comments_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  volume_id TEXT REFERENCES volumes(id) ON DELETE CASCADE,
  entry_id TEXT REFERENCES entries(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES volume_pages(id) ON DELETE CASCADE,
  qc_flag_id TEXT REFERENCES qc_flags(id) ON DELETE CASCADE,
  decision_id TEXT REFERENCES pending_decisions(id) ON DELETE RESTRICT,
  region_x REAL,
  region_y REAL,
  region_w REAL,
  region_h REAL,
  parent_id TEXT,
  author_id TEXT REFERENCES users(id),
  author_label TEXT,
  author_role TEXT,
  text TEXT NOT NULL,
  quote TEXT,
  quote_ref TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_by TEXT REFERENCES users(id),
  resolved_at INTEGER,
  resolved_by TEXT REFERENCES users(id),
  edited_at INTEGER,
  CHECK (
    (entry_id IS NOT NULL AND page_id IS NULL     AND qc_flag_id IS NULL     AND decision_id IS NULL) OR
    (entry_id IS NULL     AND page_id IS NOT NULL AND qc_flag_id IS NULL     AND decision_id IS NULL) OR
    (entry_id IS NULL     AND page_id IS NULL     AND qc_flag_id IS NOT NULL AND decision_id IS NULL) OR
    (entry_id IS NULL     AND page_id IS NULL     AND qc_flag_id IS NULL     AND decision_id IS NOT NULL)
  ),
  CHECK ((author_id IS NULL) != (author_label IS NULL)),
  CHECK (decision_id IS NOT NULL OR volume_id IS NOT NULL),
  CHECK (decision_id IS NOT NULL OR tenant_id IS NOT NULL)
);

INSERT INTO comments_new
  (id, tenant_id, volume_id, entry_id, page_id, qc_flag_id,
   region_x, region_y, region_w, region_h,
   parent_id, author_id, author_role, text,
   created_at, updated_at,
   deleted_at, deleted_by, resolved_at, resolved_by, edited_at)
SELECT
  id, tenant_id, volume_id, entry_id, page_id, qc_flag_id,
  region_x, region_y, region_w, region_h,
  parent_id, author_id, author_role, text,
  created_at, updated_at,
  deleted_at, deleted_by, resolved_at, resolved_by, edited_at
FROM comments;

-- Fold the decision threads in: body becomes text, the insert-only
-- table's created_at doubles as updated_at, and the tenant stamp is
-- copied from the decision so tenant-scoped reads stay one-table.
INSERT INTO comments_new
  (id, tenant_id, decision_id, author_id, author_label, text,
   created_at, updated_at)
SELECT
  dc.id, pd.tenant_id, dc.decision_id, dc.author_user_id,
  dc.author_label, dc.body, dc.created_at, dc.created_at
FROM decision_comments dc
JOIN pending_decisions pd ON pd.id = dc.decision_id;

DROP TABLE decision_comments;
DROP TABLE comments;
ALTER TABLE comments_new RENAME TO comments;

CREATE INDEX comment_volume_idx   ON comments(volume_id);
CREATE INDEX comment_entry_idx    ON comments(entry_id);
CREATE INDEX comment_page_idx     ON comments(page_id);
CREATE INDEX comment_qc_flag_idx  ON comments(qc_flag_id);
CREATE INDEX comment_parent_idx   ON comments(parent_id);
CREATE INDEX comment_decision_idx ON comments(decision_id, created_at);

ALTER TABLE pending_decisions ADD COLUMN filed_by_user_id TEXT REFERENCES users(id);

PRAGMA foreign_key_check;
