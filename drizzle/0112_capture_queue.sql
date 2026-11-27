-- Digitization queue and scanner operators.
--
-- This migration adds the two tables behind a workspace's digitization
-- queue and its sync with a Captua unit (contract 1.7).
--
-- `capture_scanner_operators` keeps the user list each unit sends with
-- `PUT /api/capture/v1/operators`, one row per scanner and username. The
-- unit's list replaces the one held for that scanner. Operators are not
-- Fisqua accounts; the queue's assignment picker lists the active ones.
--
-- `capture_queue_entries` holds the queue: one row per description per
-- tenant (the unique index), never deleted. Withdrawing sets
-- `withdrawn_at`; adding the same description again clears it on the
-- same row, so the unit sees one `itemId` per reference code. Each entry
-- has its position, its job (`action`, the contract 1.4 codes), a note,
-- and an optional scanner and operator (`assignee_username`, which names
-- an operator of that scanner and needs the scanner).
--
-- `changed_at` is stamped by every write to an entry and is strictly
-- greater than every earlier stamp of the tenant's entries, so its
-- maximum orders the queue's revisions; `withdrawn_at` carries the stamp
-- of the withdrawal. The unit's acknowledgement is recorded per entry:
-- `applied_at` and `collection_id` when it took the item, `skipped_at`
-- and `skipped_reason` when it could not, and `acked_revision`, the
-- highest revision stamp it acknowledged the entry under. A withdrawn
-- entry is served to the unit until it is acknowledged under a revision
-- stamped at or after its withdrawal.
--
-- A volume with retakes outstanding is in the queue without a row: its
-- item is read from the capture QC decisions. A row is written for it
-- only when someone assigns it, notes it or the unit acknowledges it,
-- with `origin` 'retake' and the pipeline volume's id as its own, so the
-- unit's `itemId` stays the same before and after the row exists. Such
-- a row is shown and served only while retakes are outstanding. Adding
-- the description to the queue makes it a 'queue' row.
--
-- `revived_stamp` is the stamp at which a withdrawn entry was added again;
-- an acknowledgement under a revision served before it does not count,
-- so a late acknowledgement cannot undo the reset of a revived entry.
--
-- `descriptions_tenant_updated_idx` lets the queue's revision read the
-- latest edit to any of the tenant's descriptions (an item's own fields
-- and its ancestors' titles) with one index lookup.
--
-- `pipeline_run_chunks_tenant_idx` and `pipeline_run_volumes_tenant_idx`
-- let the queue's revision count a tenant's run history by status
-- without reading other tenants'.
--
-- `capture_queue_served` records each queue revision answered to a
-- scanner with its stamp. An acknowledgement counts only under a
-- revision served to the scanner that sends it, so a unit cannot
-- acknowledge a withdrawal it never fetched. Rows older than 30 days are
-- dropped when the scanner is next served.
--
-- `capture_scanners.mode` is the mode the unit last reported with its
-- user list (`offline`, `backup` or `fisqua`), with when it reported it;
-- null until it reports one. A unit not in `fisqua` mode does not pick
-- up queue entries, which the queue screen warns about.
--
-- An entry goes with its description (ON DELETE CASCADE), so queueing a
-- description never blocks deleting it.
--
-- Version: v0.9.0

CREATE TABLE capture_scanner_operators (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  scanner_id TEXT NOT NULL REFERENCES capture_scanners(id) ON DELETE RESTRICT,
  username TEXT NOT NULL CHECK (length(username) BETWEEN 1 AND 256),
  display_name TEXT NOT NULL CHECK (length(display_name) <= 256),
  role TEXT NOT NULL CHECK (role IN ('admin','operator')),
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scanner_id, username)
);
--> statement-breakpoint
CREATE INDEX capture_scanner_operators_tenant_idx ON capture_scanner_operators (tenant_id, scanner_id);
--> statement-breakpoint
CREATE TABLE capture_queue_entries (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  description_id TEXT NOT NULL REFERENCES descriptions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'queue' CHECK (origin IN ('queue','retake')),
  action TEXT NOT NULL DEFAULT 'full-digitisation'
    CHECK (action IN ('full-digitisation','full-rescan','spot-recapture','complete')),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  scanner_id TEXT REFERENCES capture_scanners(id) ON DELETE RESTRICT,
  assignee_username TEXT,
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  added_at INTEGER NOT NULL,
  changed_at INTEGER NOT NULL,
  withdrawn_at INTEGER,
  applied_at INTEGER,
  collection_id TEXT,
  skipped_at INTEGER,
  skipped_reason TEXT CHECK (skipped_reason IS NULL OR length(skipped_reason) <= 2000),
  acked_revision INTEGER,
  revived_stamp INTEGER,
  CHECK (assignee_username IS NULL OR scanner_id IS NOT NULL),
  CHECK ((skipped_at IS NULL) = (skipped_reason IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX capture_queue_entries_description_idx ON capture_queue_entries (tenant_id, description_id);
--> statement-breakpoint
CREATE INDEX capture_queue_entries_position_idx ON capture_queue_entries (tenant_id, position);
--> statement-breakpoint
CREATE INDEX capture_queue_entries_scanner_idx ON capture_queue_entries (tenant_id, scanner_id);
--> statement-breakpoint
CREATE TABLE capture_queue_served (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  scanner_id TEXT NOT NULL REFERENCES capture_scanners(id) ON DELETE RESTRICT,
  revision TEXT NOT NULL CHECK (length(revision) <= 64),
  stamp INTEGER NOT NULL,
  served_at INTEGER NOT NULL,
  PRIMARY KEY (scanner_id, revision)
);
--> statement-breakpoint
CREATE INDEX capture_queue_served_age_idx ON capture_queue_served (tenant_id, scanner_id, served_at);
--> statement-breakpoint
ALTER TABLE capture_scanners ADD COLUMN mode TEXT CHECK (mode IS NULL OR mode IN ('offline','backup','fisqua'));
--> statement-breakpoint
ALTER TABLE capture_scanners ADD COLUMN mode_reported_at INTEGER;
--> statement-breakpoint
CREATE INDEX descriptions_tenant_updated_idx ON descriptions (tenant_id, updated_at);
--> statement-breakpoint
CREATE INDEX pipeline_run_chunks_tenant_idx ON pipeline_run_chunks (tenant_id, status);
--> statement-breakpoint
CREATE INDEX pipeline_run_volumes_tenant_idx ON pipeline_run_volumes (tenant_id, status, reported_at);
