-- Audit action for the scanner token, and the scanner's revision.
--
-- This migration adds `scanner_token` to the bounded `audit_log.action`
-- CHECK (0037): the row a tenant admin or federation steward leaves on
-- making, replacing or revoking the tenant's Captua scanner token from
-- the Scanner screen. `details` holds the step and the scanner's name,
-- never the token or its hash.
--
-- SQLite cannot alter a CHECK, so the table is rebuilt: a new table with
-- the same columns and the wider CHECK, every row copied across with its
-- values unchanged, the old table dropped (its indexes and its two
-- immutability triggers go with it), the new one renamed, and the three
-- indexes and two triggers created again exactly as 0037 has them. No
-- table references `audit_log`, so dropping it touches no foreign key.
-- The copy is an INSERT, which the triggers allow; nothing is updated
-- or deleted row by row.
--
-- `capture_scanners` gains `revision` and `write_id`. Every write to a
-- scanner's token (make, replace, revoke, by the Scanner screen or the
-- operator command) sets `revision` to one more than the value it read,
-- guarded by that value, and `write_id` to an id of its own. The screen
-- compares `revision` with the one the page showed, so an action taken
-- on a stale page is refused however close together the writes were;
-- the audit row and the re-read match `write_id`, so a write that lost a
-- race is never taken for the one that won. Existing scanners start at
-- revision 0 with no write id. The link's per-call update touches
-- neither.
--
-- Version: v0.8.0

ALTER TABLE capture_scanners ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE capture_scanners ADD COLUMN write_id TEXT;

CREATE TABLE audit_log_next (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_user_id_text TEXT NOT NULL,
  actor_tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN (
    'create_tenant',
    'soft_disable_tenant',
    'reset_superadmin',
    'login_as',
    'edit_on_behalf',
    'set_capability',
    'set_quota',
    'scanner_token'
  )),
  target_tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT,
  target_object_kind TEXT,
  target_object_id TEXT,
  impersonation_session_id TEXT,
  details TEXT
);

INSERT INTO audit_log_next (
  id, created_at, actor_user_id, actor_user_id_text, actor_tenant_id, action,
  target_tenant_id, target_object_kind, target_object_id, impersonation_session_id, details
)
SELECT
  id, created_at, actor_user_id, actor_user_id_text, actor_tenant_id, action,
  target_tenant_id, target_object_kind, target_object_id, impersonation_session_id, details
FROM audit_log;

DROP TABLE audit_log;

ALTER TABLE audit_log_next RENAME TO audit_log;

CREATE INDEX audit_log_target_tenant_idx ON audit_log (target_tenant_id, created_at DESC);
CREATE INDEX audit_log_actor_user_idx ON audit_log (actor_user_id, created_at DESC);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);

CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
WHEN NOT (
  OLD.actor_user_id IS NOT NULL
  AND NEW.actor_user_id IS NULL
  AND OLD.id IS NEW.id
  AND OLD.created_at IS NEW.created_at
  AND OLD.actor_user_id_text IS NEW.actor_user_id_text
  AND OLD.actor_tenant_id IS NEW.actor_tenant_id
  AND OLD.action IS NEW.action
  AND OLD.target_tenant_id IS NEW.target_tenant_id
  AND OLD.target_object_kind IS NEW.target_object_kind
  AND OLD.target_object_id IS NEW.target_object_id
  AND OLD.impersonation_session_id IS NEW.impersonation_session_id
  AND OLD.details IS NEW.details
)
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is immutable');
END;
