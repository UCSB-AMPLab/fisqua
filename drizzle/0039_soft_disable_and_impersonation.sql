-- Operator UI and audit log substrate.
--
-- This migration adds tenants.disabled_at (soft-disable) and the
-- impersonation_handoffs table (separate from oauth_handoffs; mirrors
-- 0038's single-use shape with role-based-impersonation columns).
-- Append-only audit log invariants (migration 0037) are NOT touched.
--
-- Soft-disable shape:
--   tenants.disabled_at INTEGER NULL — epoch-ms timestamp set when the
--   operator soft-disables a tenant. NULL means active. getTenantFromRequest
--   throws 404 on a tenant subdomain when this column is non-null AND the
--   request pathname does not start with /operator/ — operators retain
--   recovery access through their carve-out. Read-only mode was rejected
--   because it would force every action route to add a `requireNotDisabled`
--   check, leaking soft-disable awareness across the whole codebase.
--
-- Impersonation handoff shape:
--   impersonation_handoffs is the single-use D1 row the operator login-as
--   flow inserts on platform.fisqua.org and the tenant subdomain's
--   /handoff/impersonation route consumes. Mirrors oauth_handoffs's
--   single-use shape (0038) but is a separate table: keeps the OAuth
--   narrative pure, gives audit_log.impersonation_session_id a clean
--   FK-conceptual target, and lets the role-based impersonation columns
--   (target_tenant_id, target_role) shed the OAuth-shape pollution.
--
--   Single-use semantics: consumeImpersonationHandoff in
--   app/lib/impersonation-handoff.server.ts issues a single
--   UPDATE … RETURNING that flips consumed=0 → consumed=1 only when
--   expires_at > now AND consumed = 0. Replay attempts fail at the
--   rowcount-zero branch and the handoff route returns 410.
--
--   FK delete behaviour: actor_user_id and target_tenant_id both ON DELETE
--   RESTRICT. Forensic continuity matters more than orphan cleanup; if a
--   user or tenant is removed while a handoff is in flight, the migration
--   handling deletion must explicitly clear the handoff first. (audit_log
--   uses SET NULL on actor_user_id paired with denormalised
--   actor_user_id_text NOT NULL — that pattern is for the long-lived
--   audit trail; impersonation_handoffs are short-lived (30s TTL) so
--   RESTRICT is the simpler choice.)
--
--   target_role CHECK enforces the six role-flag literal names exactly.
--   Adding a new role flag elsewhere requires a migration that updates
--   this CHECK; the friction is the point.
--
--   TTL: 30s (IMPERSONATION_HANDOFF_TTL_MS). Browser hop is sub-second on
--   the happy path; 30s slack for slow networks; narrow replay window if
--   the token leaks via referer or browser history.
--
-- Version: v0.4.0

ALTER TABLE tenants ADD COLUMN disabled_at INTEGER;

CREATE TABLE impersonation_handoffs (
  id TEXT PRIMARY KEY NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  target_role TEXT NOT NULL CHECK (target_role IN ('isAdmin','isSuperAdmin','isCollabAdmin','isArchiveUser','isUserManager','isCataloguer')),
  reason TEXT,
  expires_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX impersonation_handoffs_expires_idx ON impersonation_handoffs(expires_at);
CREATE INDEX impersonation_handoffs_actor_idx ON impersonation_handoffs(actor_user_id, created_at);
