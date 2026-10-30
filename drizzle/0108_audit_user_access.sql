-- Audit actions for a person's access.
--
-- This migration adds four actions to the bounded `audit_log.action`
-- CHECK (0037, as 0101 left it), one for each kind of change the users
-- area makes to what a person may do in a workspace:
--
--   - `set_user_role`: a role flag on `users` granted or revoked from
--     the user detail page; `details` is `{ flag, step }`, with `step`
--     `granted` or `revoked`.
--   - `set_federation_role`: the person's membership in the
--     workspace's federation added, changed or removed; `details` is
--     `{ federation_id, from, to }`, each of `from` and `to` one of
--     `none`, `staff` or `steward`.
--   - `set_project_membership`: the person added to a project, their
--     role in it changed, or their membership removed, from the user
--     detail page; `details` is `{ project_id, step, role }`, with
--     `step` `added`, `changed` or `removed`.
--   - `invite_user`: the person invited to the workspace; `details` is
--     `{ role }`, the opening role the inviter chose.
--
-- Each row names the person in `target_object_kind` `user` and
-- `target_object_id`, the workspace in `target_tenant_id`, and the
-- actor's home workspace in `actor_tenant_id`.
--
-- SQLite cannot alter a CHECK, so the table is rebuilt as 0101 rebuilt
-- it: a new table with the same columns and the wider CHECK, every row
-- copied across with its values unchanged, the old table dropped (its
-- indexes and its two immutability triggers go with it), the new one
-- renamed, and the three indexes and two triggers created again exactly
-- as 0037 has them. No table references `audit_log`, so dropping it
-- touches no foreign key. The copy is an INSERT, which the triggers
-- allow; nothing is updated or deleted row by row.
--
-- Version: v0.8.0

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
    'invite_user'
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
