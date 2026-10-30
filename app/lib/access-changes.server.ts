/**
 * Access Changes — Role, Federation and Membership Writes With Their Audit
 *
 * This module deals with writing a change to a person's access and the
 * `audit_log` row that records it, together. The user detail page
 * (`/admin/users/:id`) is its caller: the role flags of one person, their
 * role in the workspace's federation, and their project memberships.
 * Who may make which change is decided before anything here runs
 * (`assignableRoleFlags`, `canGrantSteward` and `canGrantStaff` in
 * `permissions.server.ts`); this module only makes sure that what lands
 * is what the page showed changed, and that nothing lands unrecorded.
 *
 * `recordAccessChange` builds one audit INSERT for a change: action,
 * actor (their id, email and home workspace), the workspace acted in as
 * the target tenant, target kind `user` with the person's id, the
 * impersonation session if any, and the change's `details`. The INSERT
 * is a `SELECT ... WHERE` so it lands only while a condition holds.
 *
 * `applyRoleChanges` writes a set of role-flag changes and at most one
 * federation change for one person in ONE D1 batch, which D1 runs as
 * one transaction. Each change carries the value the page showed and
 * the value wanted. The batch opens with the audit rows, every one of
 * them guarded by the whole snapshot: every flag the page showed still
 * holds the value shown, the federation role is still the one shown,
 * and, when `isAdmin` is being removed, another person of the workspace
 * is still a workspace admin. The writes follow, each guarded by its
 * own shown value AND by the presence of the batch's first audit row
 * (the marker): that row exists only if the snapshot held, so either
 * every change lands with its row or none does. After the batch the
 * marker is read back. Missing, the answer is `last_workspace_admin`
 * when removing `isAdmin` would leave no workspace admin, and
 * `roles_changed` otherwise.
 *
 * `setFederationRole` builds the federation write for a change from one
 * role to another (`none`, `staff` or `steward`): an INSERT when the
 * person had none, a DELETE when they are to have none, an UPDATE of
 * the one row otherwise (`federation_memberships` holds one row per
 * person and federation).
 *
 * `recordInvitation` records an invitation once its email has gone,
 * in one batch: the `invite_user` row, always, and, when the invitation
 * opens with a role, the grant of that role with its own `set_user_role`
 * row. The account is created with no role, so a role never stands
 * without a row: the grant's row lands only while the flag is still off
 * (another admin may have granted it while the email was sending), and
 * the grant only with that row.
 *
 * `setProjectMembership` adds, re-roles or removes one project
 * membership the same way: the audit row first, guarded by the state
 * the change starts from, then the write, guarded by the audit row.
 * `project_members` has no tenant column; the caller has already
 * resolved the project inside the request tenant.
 *
 * @version v0.8.0
 */

import { users } from "../db/schema";
import type { User } from "../context";
import type { FederationRole } from "./federation.server";
import type { RoleFlag } from "./permissions.server";
import type { AuditAction } from "./audit-actions";
import type { ProjectRole } from "./validation/enums";

/** A federation role as the form posts it: none, or one of the two roles. */
export type FederationRoleChoice = "none" | FederationRole;

/** Who makes a change, as the audit row records them. */
export interface AccessActor {
  user: Pick<User, "id" | "email">;
  /** The actor's home workspace: `grant.homeTenantId` under a grant. */
  homeTenantId: string;
  impersonationSessionId: string | null;
}

/** One SQL statement and its parameters. */
export interface Statement {
  sql: string;
  params: unknown[];
}

/** A role flag as the page showed it and as it is wanted. */
export interface RoleChange {
  flag: RoleFlag;
  shown: boolean;
  to: boolean;
}

export type AccessChangeResult =
  | { ok: true }
  | { ok: false; error: "roles_changed" | "last_workspace_admin" };

/** The `users` column behind a role flag. */
function columnOf(flag: RoleFlag): string {
  return users[flag].name;
}

const AUDIT_INSERT =
  "INSERT INTO audit_log (id, created_at, actor_user_id, actor_user_id_text, actor_tenant_id, action, " +
  "target_tenant_id, target_object_kind, target_object_id, impersonation_session_id, details)\n" +
  "SELECT ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?, ?\n";

/** The audit INSERT for one change, landing only while `condition` holds. */
export function recordAccessChange(args: {
  id: string;
  now: number;
  actor: AccessActor;
  action: AuditAction;
  tenantId: string;
  targetUserId: string;
  details: Record<string, unknown>;
  condition: Statement;
}): Statement {
  return {
    sql: `${AUDIT_INSERT}WHERE ${args.condition.sql};`,
    params: [
      args.id,
      args.now,
      args.actor.user.id,
      args.actor.user.email,
      args.actor.homeTenantId,
      args.action,
      args.tenantId,
      args.targetUserId,
      args.actor.impersonationSessionId,
      JSON.stringify(args.details),
      ...args.condition.params,
    ],
  };
}

/** Joins conditions with AND. */
function all(conditions: Statement[]): Statement {
  return {
    sql: conditions.map((c) => `(${c.sql})`).join(" AND "),
    params: conditions.flatMap((c) => c.params),
  };
}

/** The person's federation role is `role` (`none`: no membership). */
function federationRoleIs(userId: string, federationId: string, role: FederationRoleChoice): Statement {
  return role === "none"
    ? {
        sql: "NOT EXISTS (SELECT 1 FROM federation_memberships WHERE user_id = ? AND federation_id = ?)",
        params: [userId, federationId],
      }
    : {
        sql: "EXISTS (SELECT 1 FROM federation_memberships WHERE user_id = ? AND federation_id = ? AND role = ?)",
        params: [userId, federationId, role],
      };
}

/** The audit row `id` exists: the batch's snapshot held. */
function markerExists(id: string): Statement {
  return { sql: "EXISTS (SELECT 1 FROM audit_log WHERE id = ?)", params: [id] };
}

/** Another person of the workspace is a workspace admin. */
function anotherWorkspaceAdmin(tenantId: string, userId: string): Statement {
  return {
    sql: "EXISTS (SELECT 1 FROM users WHERE tenant_id = ? AND id <> ? AND is_admin = 1)",
    params: [tenantId, userId],
  };
}

/**
 * The federation write taking `userId` from `from` to `to` in
 * `federationId`, landing only while `condition` holds.
 */
export function setFederationRole(args: {
  userId: string;
  federationId: string;
  from: FederationRoleChoice;
  to: FederationRoleChoice;
  newId: string;
  now: number;
  condition: Statement;
}): Statement {
  const { userId, federationId, from, to, condition } = args;
  if (from === "none") {
    return {
      sql:
        "INSERT INTO federation_memberships (id, user_id, federation_id, role, created_at)\n" +
        `SELECT ?, ?, ?, ?, ? WHERE ${condition.sql};`,
      params: [args.newId, userId, federationId, to, args.now, ...condition.params],
    };
  }
  if (to === "none") {
    return {
      sql: `DELETE FROM federation_memberships WHERE user_id = ? AND federation_id = ? AND role = ? AND ${condition.sql};`,
      params: [userId, federationId, from, ...condition.params],
    };
  }
  return {
    sql: `UPDATE federation_memberships SET role = ? WHERE user_id = ? AND federation_id = ? AND role = ? AND ${condition.sql};`,
    params: [to, userId, federationId, from, ...condition.params],
  };
}

/**
 * Writes `changes` (and `federation`, if given) for one person in one
 * batch, each with its audit row, or nothing at all (module header).
 * Changes whose `shown` equals `to` are part of the snapshot but write
 * nothing.
 */
export async function applyRoleChanges(args: {
  d1: D1Database;
  tenant: { id: string; federationId: string };
  targetUserId: string;
  changes: RoleChange[];
  federation: { shown: FederationRoleChoice; to: FederationRoleChoice } | null;
  actor: AccessActor;
  now: number;
  newId: () => string;
}): Promise<AccessChangeResult> {
  const { d1, tenant, targetUserId, actor, now } = args;
  const changed = args.changes.filter((c) => c.shown !== c.to);
  const federationChanged = args.federation !== null && args.federation.shown !== args.federation.to;
  if (changed.length === 0 && !federationChanged) return { ok: true };

  const removesWorkspaceAdmin = changed.some((c) => c.flag === "isAdmin" && !c.to);

  // The snapshot: every shown flag, the shown federation role, and the
  // last-admin rule when it applies.
  const snapshot: Statement[] = [
    {
      sql:
        "EXISTS (SELECT 1 FROM users WHERE id = ? AND tenant_id = ?" +
        args.changes.map((c) => ` AND ${columnOf(c.flag)} = ?`).join("") +
        ")",
      params: [targetUserId, tenant.id, ...args.changes.map((c) => (c.shown ? 1 : 0))],
    },
  ];
  if (args.federation) {
    snapshot.push(federationRoleIs(targetUserId, tenant.federationId, args.federation.shown));
  }
  if (removesWorkspaceAdmin) snapshot.push(anotherWorkspaceAdmin(tenant.id, targetUserId));
  const condition = all(snapshot);

  const audits: Statement[] = [];
  const ids: string[] = [];
  const audit = (action: AuditAction, details: Record<string, unknown>) => {
    const id = args.newId();
    ids.push(id);
    audits.push(
      recordAccessChange({ id, now, actor, action, tenantId: tenant.id, targetUserId, details, condition }),
    );
  };
  for (const c of changed) {
    audit("set_user_role", { flag: c.flag, step: c.to ? "granted" : "revoked" });
  }
  if (federationChanged) {
    audit("set_federation_role", {
      federation_id: tenant.federationId,
      from: args.federation!.shown,
      to: args.federation!.to,
    });
  }
  const marker = markerExists(ids[0]);

  const writes: Statement[] = changed.map((c) => ({
    sql: `UPDATE users SET ${columnOf(c.flag)} = ? WHERE id = ? AND tenant_id = ? AND ${columnOf(c.flag)} = ? AND ${marker.sql};`,
    params: [c.to ? 1 : 0, targetUserId, tenant.id, c.shown ? 1 : 0, ...marker.params],
  }));
  if (federationChanged) {
    writes.push(
      setFederationRole({
        userId: targetUserId,
        federationId: tenant.federationId,
        from: args.federation!.shown,
        to: args.federation!.to,
        newId: args.newId(),
        now,
        condition: marker,
      }),
    );
  }

  await d1.batch([...audits, ...writes].map((s) => d1.prepare(s.sql).bind(...s.params)));

  const landed = await d1.prepare(`SELECT 1 AS landed WHERE ${marker.sql}`).bind(...marker.params).first();
  if (landed) return { ok: true };
  if (removesWorkspaceAdmin) {
    const other = anotherWorkspaceAdmin(tenant.id, targetUserId);
    const stillAnother = await d1.prepare(`SELECT 1 AS found WHERE ${other.sql}`).bind(...other.params).first();
    if (!stillAnother) return { ok: false, error: "last_workspace_admin" };
  }
  return { ok: false, error: "roles_changed" };
}

/**
 * Records an invitation and grants its opening role (module header).
 * `role` is the value the invite form posted, `none` included; `flag`
 * is the flag it grants, or null.
 *
 * `landed` says whether the batch committed. D1 runs a batch as one
 * transaction, so a batch call that returns has committed everything
 * in it. A call that throws may still have committed (a transport or
 * decode error can arrive after the commit), so the invitation's
 * `invite_user` row, which the batch writes unconditionally, is looked
 * for by its id: found, the batch landed; not found, it did not. If
 * that check fails too, the outcome is unknown and `landed` is false,
 * so the caller answers as for a batch that did not land. `granted`
 * says whether the role was granted here (its `set_user_role` row
 * exists; false when the flag was already on), and is null when the
 * batch landed but reading that back failed.
 */
export async function recordInvitation(args: {
  d1: D1Database;
  tenantId: string;
  userId: string;
  role: string;
  flag: RoleFlag | null;
  actor: AccessActor;
  now: number;
  newId: () => string;
}): Promise<{ landed: boolean; granted: boolean | null }> {
  const { d1, tenantId, userId, flag, actor, now } = args;
  const inviteId = args.newId();
  const statements: Statement[] = [
    recordAccessChange({
      id: inviteId,
      now,
      actor,
      action: "invite_user",
      tenantId,
      targetUserId: userId,
      details: { role: args.role },
      condition: { sql: "1", params: [] },
    }),
  ];
  let grantMarker: Statement | null = null;
  if (flag) {
    const grantId = args.newId();
    grantMarker = markerExists(grantId);
    statements.push(
      recordAccessChange({
        id: grantId,
        now,
        actor,
        action: "set_user_role",
        tenantId,
        targetUserId: userId,
        details: { flag, step: "granted" },
        condition: {
          sql: `EXISTS (SELECT 1 FROM users WHERE id = ? AND tenant_id = ? AND ${columnOf(flag)} = 0)`,
          params: [userId, tenantId],
        },
      }),
      {
        sql: `UPDATE users SET ${columnOf(flag)} = 1 WHERE id = ? AND tenant_id = ? AND ${columnOf(flag)} = 0 AND ${grantMarker.sql};`,
        params: [userId, tenantId, ...grantMarker.params],
      },
    );
  }
  try {
    await d1.batch(statements.map((s) => d1.prepare(s.sql).bind(...s.params)));
  } catch {
    const invite = markerExists(inviteId);
    try {
      const found = await d1.prepare(`SELECT 1 AS landed WHERE ${invite.sql}`).bind(...invite.params).first();
      if (!found) return { landed: false, granted: false };
    } catch {
      return { landed: false, granted: false };
    }
  }
  if (!grantMarker) return { landed: true, granted: false };
  try {
    const found = await d1.prepare(`SELECT 1 AS landed WHERE ${grantMarker.sql}`).bind(...grantMarker.params).first();
    return { landed: true, granted: !!found };
  } catch {
    return { landed: true, granted: null };
  }
}

/** One project membership change, as the user detail page makes it. */
export type MembershipChange =
  | { step: "added"; projectId: string; role: ProjectRole }
  | { step: "changed"; membershipId: string; projectId: string; shown: ProjectRole; role: ProjectRole }
  | { step: "removed"; membershipId: string; projectId: string; role: ProjectRole };

/**
 * Adds, re-roles or removes one project membership with its audit row
 * (module header). Returns false when, at write time, the state the
 * change starts from does not hold: the person is already in the
 * project (added), or the membership is missing or holds another role
 * than the one the page showed (changed: `shown`; removed: `role`).
 * `role` of a removal is that shown role, which the audit row records;
 * of a change, the new role.
 */
export async function setProjectMembership(args: {
  d1: D1Database;
  tenantId: string;
  targetUserId: string;
  change: MembershipChange;
  actor: AccessActor;
  now: number;
  newId: () => string;
}): Promise<boolean> {
  const { d1, change, targetUserId } = args;
  const auditId = args.newId();
  const marker = markerExists(auditId);

  let from: Statement;
  let write: Statement;
  if (change.step === "added") {
    from = {
      sql: "NOT EXISTS (SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?)",
      params: [change.projectId, targetUserId],
    };
    write = {
      sql:
        "INSERT INTO project_members (id, project_id, user_id, role, created_at)\n" +
        `SELECT ?, ?, ?, ?, ? WHERE ${marker.sql};`,
      params: [args.newId(), change.projectId, targetUserId, change.role, Math.floor(args.now / 1000), ...marker.params],
    };
  } else if (change.step === "changed") {
    from = {
      sql: "EXISTS (SELECT 1 FROM project_members WHERE id = ? AND user_id = ? AND role = ?)",
      params: [change.membershipId, targetUserId, change.shown],
    };
    write = {
      sql: `UPDATE project_members SET role = ? WHERE id = ? AND user_id = ? AND ${marker.sql};`,
      params: [change.role, change.membershipId, targetUserId, ...marker.params],
    };
  } else {
    from = {
      sql: "EXISTS (SELECT 1 FROM project_members WHERE id = ? AND user_id = ? AND role = ?)",
      params: [change.membershipId, targetUserId, change.role],
    };
    write = {
      sql: `DELETE FROM project_members WHERE id = ? AND user_id = ? AND ${marker.sql};`,
      params: [change.membershipId, targetUserId, ...marker.params],
    };
  }

  const audit = recordAccessChange({
    id: auditId,
    now: args.now,
    actor: args.actor,
    action: "set_project_membership",
    tenantId: args.tenantId,
    targetUserId,
    details: { project_id: change.projectId, step: change.step, role: change.role },
    condition: from,
  });
  await d1.batch([audit, write].map((s) => d1.prepare(s.sql).bind(...s.params)));
  return !!(await d1.prepare(`SELECT 1 AS landed WHERE ${marker.sql}`).bind(...marker.params).first());
}

// @version v0.8.0
