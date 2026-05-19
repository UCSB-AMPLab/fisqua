-- Audit log: append-only forensic record for every operator action
--
-- This migration lands the table, the bounded action CHECK enum, and the
-- immutability semantics so the schema-layer guarantees exist before any
-- operator code runs — the operator UI is the first writer.
--
-- Column shape:
--
--   id, created_at         — epoch-ms PK, immutable.
--   actor_user_id          — FK to users(id) ON DELETE SET NULL.
--   actor_user_id_text     — denormalised text copy of the original
--                            user id, NOT NULL. If the user is deleted
--                            later the FK clears but the literal id
--                            stays for forensic continuity. The
--                            one place denormalisation buys real audit
--                            integrity.
--   actor_tenant_id        — FK to tenants(id) ON DELETE RESTRICT.
--                            Always the platform tenant in practice.
--   action                 — bounded CHECK enum. Initial set:
--                            create_tenant, soft_disable_tenant,
--                            reset_superadmin, login_as, edit_on_behalf,
--                            set_capability, set_quota. Adding a new
--                            operator action later requires a migration
--                            that updates this CHECK; the friction is
--                            the point.
--   target_tenant_id       — FK to tenants(id) ON DELETE RESTRICT,
--                            nullable (some actions target the platform
--                            itself).
--   target_object_kind     — nullable text: description / entity /
--                            place / user / tenant / capability /
--                            quota / null.
--   target_object_id       — nullable text id of the touched object.
--   impersonation_session_id — nullable; set when login_as / edit_on_behalf
--                              mints a tenant-scoped session.
--   details                — nullable JSON blob, action-specific (e.g.
--                            for set_capability the before/after value).
--
-- Indexes:
--
--   1. (target_tenant_id, created_at DESC) — primary read path is
--      "latest audit rows for tenant X".
--   2. (actor_user_id, created_at DESC) — secondary read path for the
--      operator-activity view.
--   3. (created_at DESC) — fallback read path; instance-wide chronological.
--
-- Immutability triggers:
--
-- BEFORE UPDATE and BEFORE DELETE both RAISE(ABORT). The only way around
-- is DROP TRIGGER in a migration, which is auditable in source control.
-- The bare RAISE form (no CASE expression) sidesteps the workers-sdk
-- #4326 trigger-parser quirk that affects compound CASE expressions on
-- remote D1 (bare form passes both local and remote — verified by a
-- smoke test that runs UPDATE and DELETE against the live triggers).
--
-- Retention: forever. Audit volumes are small (a handful of rows
-- per provisioning event); recovery may need them years later. Revisit
-- only if volume grows materially.
--
-- Version: v0.4.0

CREATE TABLE audit_log (
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
    'set_quota'
  )),
  target_tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT,
  target_object_kind TEXT,
  target_object_id TEXT,
  impersonation_session_id TEXT,
  details TEXT
);

CREATE INDEX audit_log_target_tenant_idx ON audit_log(target_tenant_id, created_at DESC);
CREATE INDEX audit_log_actor_user_idx    ON audit_log(actor_user_id, created_at DESC);
CREATE INDEX audit_log_created_idx       ON audit_log(created_at DESC);

-- Append-only trigger.
--
-- The trigger fires for every UPDATE *except* the one transition the
-- FK cascade legitimately performs: actor_user_id going from a
-- non-null value to NULL (because the referenced user was deleted)
-- with every other column unchanged. The WHEN clause below encodes
-- that single exception. A real application UPDATE that touches any
-- other column still hits the trigger, so the schema-level
-- append-only invariant holds.
--
-- The condition uses `IS` rather than `=` so NULL-on-both-sides
-- compares equal (otherwise nullable columns would produce NULL,
-- which folds into FALSE and the trigger would fire even on the
-- legitimate cascade). This is plain boolean logic in a WHEN clause
-- (not a CASE expression in the trigger body), so the workers-sdk
-- #4326 trigger-parser quirk does not apply.
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
