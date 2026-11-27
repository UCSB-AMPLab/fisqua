/**
 * Scripts — guarding who acts, in a command line run's SQL file
 *
 * This module deals with guarding who acts, inside the SQL file of a
 * command line run. A run checks the acting user once, when it plans:
 * `resolveActor` (`../authority-links.ts`) finds the user by email, the
 * tenant `--tenant` names, and how the user may act there (a member, a
 * platform admin, or the workspace admin of the lead tenant of the
 * tenant's federation), stops on a disabled tenant, and settles the six
 * area flags that `canWorkInArea` decides with; `readScope` reads the
 * tenant's federation, whether its authorities are on, whether the
 * federation shares them, and whether the user is a steward of it. The SQL
 * file is applied later, so these guards open it and fail the file whole,
 * nothing written, unless every one of those values still holds as read.
 * Each guard is one SELECT over the rows read by primary key.
 *
 *   `actorGuards`  for a member, the user's id, email, tenant and
 *                  tenant slug, the tenant not disabled, and each area
 *                  flag as read (true or false, read as `resolveActor`
 *                  reads it: 1, '1' or 'true'). For a platform admin or
 *                  the lead's admin, the user's id, email, own tenant
 *                  and platform-admin flag as read; the tenant's id,
 *                  slug, kind, status and federation, and that
 *                  federation's status and lead, each as read; and the
 *                  tenant not disabled. For the lead's admin, also their
 *                  workspace-admin flag as read and their own tenant not
 *                  disabled. How the user acts is decided on these
 *                  values alone, so while they hold it is unchanged;
 *   `scopeGuards`  the tenant's federation and its slug, authorities
 *                  on, the federation's sharing as read, and the
 *                  steward test of `readScope` giving what it gave: the
 *                  federation active, and the user the workspace admin
 *                  of its lead acting on the lead itself, or holding a
 *                  steward membership.
 *
 * The capture verbs (`../capture-cli/`) check who acts as the Capture QC
 * screen checks it (`readCaptureAccess` in `../qc-decisions.ts`), not as
 * the editor's areas do: a platform admin on a live workspace, a user of
 * the tenant with workspace, super or digitization admin rights or a
 * steward membership, a user of another tenant with a steward or staff
 * membership in the tenant's active federation, or the workspace admin
 * of the federation's lead tenant. That check reads other values than `resolveActor`
 * and `readScope` read, so it has its own guards:
 *
 *   `captureAccessGuards`  the tenant's id and slug, not disabled, its
 *                  kind, its digitization capability, its status and
 *                  its federation's id and status, as read; and the
 *                  user's id, email and home tenant, the three admin
 *                  flags and the platform-admin flag the check reads,
 *                  and their membership role in that federation (or
 *                  none), as read. For the lead's admin, also the
 *                  federation's lead tenant as read and the user's own
 *                  tenant not disabled.
 *
 * `actorGuards` would also require the user's home tenant not to be
 * disabled, which the screen does not require of a grant, and
 * `scopeGuards` would require the tenant's authorities to be on, which
 * capture never reads; either would refuse at apply a run its plan
 * accepted.
 *
 * Every guard statement is `guard` (`./guard.ts`), which loads without
 * Node's child processes, so these guards also run in the Workers test
 * pool against a real D1 binding.
 *
 * @version v0.9.0
 */

import type { Actor, Scope } from "../authority-links";
import { guard } from "./guard";
import { escapeSql } from "../sql";

/** A flag as `resolveActor` reads it, in SQL. */
const truthySql = (column: string) => `(IFNULL(${column}, 0) IN (1, '1', 'true'))`;
const bit = (v: boolean) => (v ? 1 : 0);

export const ACTOR_MESSAGE = "the acting user's access has changed since it was read";
export const SCOPE_MESSAGE = "the tenant's authorities or federation have changed since they were read";

/** Guards that the acting user, the tenant and how the user acts there are as read. */
export function actorGuards(actor: Actor): string[] {
  const a = actor.access;
  if (actor.basis === "member" || actor.standing === null) {
    const flags: Array<[string, boolean | undefined]> = [
      ["is_admin", a.isAdmin], ["is_super_admin", a.isSuperAdmin], ["is_records_admin", a.isRecordsAdmin],
      ["is_authorities_admin", a.isAuthoritiesAdmin], ["is_imports_admin", a.isImportsAdmin], ["is_digitization_admin", a.isDigitizationAdmin],
    ];
    const condition = [
      `u.id = ${escapeSql(actor.id)}`,
      `lower(u.email) = lower(${escapeSql(actor.email)})`,
      `u.tenant_id = ${escapeSql(actor.tenantId)}`,
      `t.slug = ${escapeSql(actor.tenantSlug)}`,
      `IFNULL(t.disabled_at, '') = ''`,
      ...flags.map(([c, v]) => `${truthySql(`u.${c}`)} = ${bit(!!v)}`),
    ].join(" AND ");
    return [guard(`(SELECT count(*) FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE ${condition}) = 1`, ACTOR_MESSAGE)];
  }
  const s = actor.standing;
  const user = [
    `u.id = ${escapeSql(actor.id)}`,
    `lower(u.email) = lower(${escapeSql(actor.email)})`,
    `u.tenant_id = ${escapeSql(actor.homeTenantId)}`,
    `(CASE WHEN IFNULL(u.is_platform_admin, 0) = 1 THEN 1 ELSE 0 END) = ${bit(s.isPlatformAdmin)}`,
    ...(actor.basis === "lead-admin" ? [`${truthySql("u.is_admin")} = ${bit(s.isAdmin)}`, `IFNULL(h.disabled_at, '') = ''`] : []),
  ];
  const tenant = [
    `t.id = ${escapeSql(actor.tenantId)}`,
    `t.slug = ${escapeSql(actor.tenantSlug)}`,
    `IFNULL(t.disabled_at, '') = ''`,
    `IFNULL(t.kind, '') = ${escapeSql(s.tenantKind)}`,
    `IFNULL(t.status, '') = ${escapeSql(s.tenantStatus)}`,
    `IFNULL(t.federation_id, '') = ${escapeSql(s.federationId)}`,
    `IFNULL(f.status, '') = ${escapeSql(s.federationStatus)}`,
    `IFNULL(f.lead_tenant_id, '') = ${escapeSql(s.leadTenantId)}`,
  ];
  return [
    guard(
      `(SELECT count(*) FROM users u JOIN tenants h ON h.id = u.tenant_id WHERE ${user.join(" AND ")}) = 1 AND ` +
        `(SELECT count(*) FROM tenants t LEFT JOIN federations f ON f.id = t.federation_id WHERE ${tenant.join(" AND ")}) = 1`,
      ACTOR_MESSAGE,
    ),
  ];
}

/** Guards that what `readScope` read for the acting user still holds. */
export function scopeGuards(actor: Actor, scope: Scope): string[] {
  const T = escapeSql(actor.tenantId);
  const F = escapeSql(scope.federationId);
  const U = escapeSql(actor.id);
  const isAdmin = `(SELECT ${truthySql("is_admin")} FROM users WHERE id = ${U})`;
  // A platform admin is the workspace admin of the tenant they act in; anyone else, as their row says.
  const adminHere = actor.basis === "platform-admin" ? "1" : isAdmin;
  const steward =
    `(CASE WHEN f.status = 'active' AND ((f.lead_tenant_id = ${T} AND ${adminHere}) ` +
    `OR EXISTS (SELECT 1 FROM federation_memberships WHERE user_id = ${U} AND federation_id = ${F} AND role = 'steward')) THEN 1 ELSE 0 END)`;
  const condition = [
    `t.id = ${T}`,
    `t.federation_id = ${F}`,
    `f.slug = ${escapeSql(scope.federationSlug)}`,
    `${truthySql("t.authorities_enabled")} = 1`,
    `${truthySql("f.shared_authorities_enabled")} = ${bit(scope.owner === null)}`,
    `${steward} = ${bit(scope.steward)}`,
  ].join(" AND ");
  return [guard(`(SELECT count(*) FROM tenants t JOIN federations f ON f.id = t.federation_id WHERE ${condition}) = 1`, SCOPE_MESSAGE)];
}

export const CAPTURE_TENANT_MESSAGE = "the tenant's capture access has changed since it was read";

/** What the capture check read: the tenant and the user, each value as read (empty for NULL). */
export interface CaptureAccess {
  tenant: {
    id: string;
    slug: string;
    federationId: string;
    federationStatus: string;
    status: string;
    /** `tenant` or `platform`. */
    kind: string;
    digitizationEnabled: boolean;
  };
  user: {
    id: string;
    email: string;
    /** The user's home tenant: the tenant itself for a member, another for a grant. */
    tenantId: string;
    isAdmin: boolean;
    isSuperAdmin: boolean;
    isDigitizationAdmin: boolean;
    /** `users.is_platform_admin`, read as the app reads it: exactly 1. */
    isPlatformAdmin: boolean;
    /** The user's membership role in the tenant's federation, or empty for none. */
    federationRole: string;
  };
  /** For the lead's admin: the federation's lead tenant as read, which is the user's own. */
  lead?: { leadTenantId: string };
}

/** Guards that the tenant and the user are as the capture check read them. */
export function captureAccessGuards(access: CaptureAccess): string[] {
  const t = access.tenant;
  const u = access.user;
  const tenant = [
    `t.id = ${escapeSql(t.id)}`,
    `t.slug = ${escapeSql(t.slug)}`,
    `IFNULL(t.disabled_at, '') = ''`,
    `${truthySql("t.digitization_enabled")} = ${bit(t.digitizationEnabled)}`,
    `IFNULL(t.status, '') = ${escapeSql(t.status)}`,
    `IFNULL(t.kind, '') = ${escapeSql(t.kind)}`,
    `IFNULL(t.federation_id, '') = ${escapeSql(t.federationId)}`,
    `IFNULL(f.status, '') = ${escapeSql(t.federationStatus)}`,
  ].join(" AND ");
  const role =
    `IFNULL((SELECT m.role FROM federation_memberships m WHERE m.user_id = u.id ` +
    `AND m.federation_id = ${escapeSql(t.federationId)}), '')`;
  const user = [
    `u.id = ${escapeSql(u.id)}`,
    `lower(u.email) = lower(${escapeSql(u.email)})`,
    `u.tenant_id = ${escapeSql(u.tenantId)}`,
    `${truthySql("u.is_admin")} = ${bit(u.isAdmin)}`,
    `${truthySql("u.is_super_admin")} = ${bit(u.isSuperAdmin)}`,
    `${truthySql("u.is_digitization_admin")} = ${bit(u.isDigitizationAdmin)}`,
    `(CASE WHEN IFNULL(u.is_platform_admin, 0) = 1 THEN 1 ELSE 0 END) = ${bit(u.isPlatformAdmin)}`,
    `${role} = ${escapeSql(u.federationRole)}`,
  ].join(" AND ");
  const lead = access.lead
    ? ` AND IFNULL(f.lead_tenant_id, '') = ${escapeSql(access.lead.leadTenantId)}`
    : "";
  // The lead's admin also needs their own tenant, the lead, not disabled.
  const home = access.lead
    ? ` AND (SELECT count(*) FROM tenants h WHERE h.id = ${escapeSql(u.tenantId)} AND IFNULL(h.disabled_at, '') = '') = 1`
    : "";
  return [
    guard(`(SELECT count(*) FROM tenants t LEFT JOIN federations f ON f.id = t.federation_id WHERE ${tenant}${lead}) = 1`, CAPTURE_TENANT_MESSAGE),
    guard(`(SELECT count(*) FROM users u WHERE ${user}) = 1${home}`, ACTOR_MESSAGE),
  ];
}

// @version v0.9.0
