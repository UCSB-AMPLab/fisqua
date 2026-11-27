-- Audit action for capture QC decisions.
--
-- This migration adds one action to the bounded `audit_log.action`
-- CHECK (0037, as 0108 left it):
--
--   - `capture_qc_decision`: one saved request of decisions on a
--     volume's openings in capture QC, recorded only when the write
--     landed. The row names the reviewer as the actor, their home
--     workspace in `actor_tenant_id`, the workspace in
--     `target_tenant_id`, and the volume in `target_object_kind`
--     `pipeline_volume` and `target_object_id`. `details` is
--     `{ manifestId, revision, counts: { accepted, rejected, excluded,
--     cleared }, rejections: [{ captuaRecordId, reason, side? }],
--     cleared: [captuaRecordId], truncated? }`, at most 40,000 bytes.
--
-- SQLite cannot alter a CHECK, so the table is rebuilt as 0108 rebuilt
-- it: a new table with the same columns and the wider CHECK, every row
-- copied across with its values unchanged, the old table dropped (its
-- indexes and its two immutability triggers go with it), the new one
-- renamed, and the three indexes and two triggers created again exactly
-- as 0108 has them. No table references `audit_log`, so dropping it
-- touches no foreign key. The copy is an INSERT, which the triggers
-- allow; nothing is updated or deleted row by row.
--
-- Version: v0.9.0

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
    'scanner_token',
    'set_user_role',
    'set_federation_role',
    'set_project_membership',
    'invite_user',
    'capture_qc_decision'
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
