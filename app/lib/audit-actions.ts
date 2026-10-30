/**
 * Audit Log Action Enum
 *
 * This module deals with the twelve bounded action values that
 * `audit_log.action` accepts. The enum lives here, in a tiny
 * constants-only module, so it can be
 * imported from BOTH `app/db/schema.ts` (for the Drizzle column's
 * `enum:` runtime hint that gives TypeScript narrowing on selects) AND
 * `app/lib/audit.server.ts` (for the `withAuditLog` wrapper's
 * compile-time `AuditAction` type). Putting the constant in either
 * downstream file would create a circular import — `audit.server.ts`
 * imports the table from `schema.ts`, so `schema.ts` cannot import the
 * constant from `audit.server.ts`.
 *
 * The DB layer's CHECK constraint on `audit_log.action` (migrations
 * 0037, 0101 and 0108) is the structural source of truth; this constant is the
 * TypeScript mirror that lets the `withAuditLog` wrapper's signature
 * reject typos at compile time. If the migration ever extends the
 * enum, this constant extends in lockstep — and the keystone
 * `tests/db/audit-log.test.ts` "action CHECK" assertion will catch
 * a drift in either direction.
 *
 * @version v0.8.0
 */

/**
 * The twelve bounded `audit_log.action` values.
 *
 *   - `create_tenant` — operator creates a new tenant. The
 *     bootstrap-superadmin user insert is part of this action's
 *     scope; it does not get its own audit row.
 *   - `soft_disable_tenant` — operator flips `tenants.disabled_at` to
 *     the current epoch.
 *   - `reset_superadmin` — reserved enum slot; no UI in v0.4.
 *     Recovery flows through `login_as` + tenant-side admin UI.
 *   - `login_as` — operator mints an impersonation handoff and the
 *     tenant subdomain consumes it.
 *   - `edit_on_behalf` — the federation grant-write chokepoint: every
 *     non-GET request served under a live federation grant records one
 *     row with actor = the grant-holder's home tenant and target = the
 *     member tenant (see federation.server.ts `logGrantWrite`).
 *   - `set_capability` — operator toggles one of the five capability
 *     booleans on a tenant.
 *   - `set_quota` — reserved enum slot; quota columns exist on
 *     `tenants` but no code path enforces them in v0.4.
 *   - `scanner_token` — a tenant admin or federation steward makes,
 *     replaces or revokes the tenant's Captua scanner token on the
 *     Scanner screen (migration 0101). `details.step` says which; the
 *     token and its hash are never recorded.
 *
 * The last four record changes to a person's access, each with target
 * kind `user`, the person's id, the workspace acted in as the target
 * tenant and the actor's home workspace as the actor tenant (migration
 * 0108):
 *
 *   - `set_user_role` — a role flag granted or revoked on the user
 *     detail page; `details` is `{ flag, step }`, `step` being
 *     `granted` or `revoked`.
 *   - `set_federation_role` — the person's membership in the
 *     workspace's federation added, changed or removed; `details` is
 *     `{ federation_id, from, to }`, each `none`, `staff` or `steward`.
 *   - `set_project_membership` — a project membership added, re-roled
 *     or removed on the user detail page; `details` is
 *     `{ project_id, step, role }`, `step` being `added`, `changed` or
 *     `removed`.
 *   - `invite_user` — the person invited, recorded once the invitation
 *     email has gone; `details` is `{ role }`, the opening role chosen.
 */
export const AUDIT_LOG_ACTIONS = [
  "create_tenant",
  "soft_disable_tenant",
  "reset_superadmin",
  "login_as",
  "edit_on_behalf",
  "set_capability",
  "set_quota",
  "scanner_token",
  "set_user_role",
  "set_federation_role",
  "set_project_membership",
  "invite_user",
] as const;

/**
 * Compile-time narrowing of the twelve valid action values. Used by
 * `withAuditLog`'s parameter type so a typo in a route handler is
 * a TypeScript error, not a runtime CHECK violation surfaced to the
 * operator as a 500.
 */
export type AuditAction = (typeof AUDIT_LOG_ACTIONS)[number];

// @version v0.8.0
