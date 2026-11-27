/**
 * Scripts — setting and clearing a platform admin
 *
 * This module deals with the one write of `users.is_platform_admin`
 * (migration 0114) there is: the operator command in
 * `scripts/commands/set-platform-admin.ts`, a thin shell around
 * `runSetPlatformAdmin` here. No route, form or loader writes the
 * column. Every provider is an argument, so the tests run the command
 * against an in-memory database.
 *
 *   - `set` turns the flag on for the person with the email given;
 *   - `clear` turns it off.
 *
 * The person is found by email, lowercased and trimmed, as the app
 * stores it; the email is unique, so it names one row. A person already
 * in the wanted state is reported and left, with no audit row. The
 * stored `tenant_id` is never touched. `set` refuses a person stored on
 * the platform tenant: that is an operator, whom the app never admits
 * as a platform admin. `clear` is allowed for them, so a flag set on
 * such a row by other means can still be removed.
 *
 * Each change is recorded in `audit_log` as `set_user_role`, the action
 * the users area records a role flag with, with `details` of
 * `{ flag: "isPlatformAdmin", step }`, `step` being `granted` or
 * `revoked`. The actor is the command itself: no user id,
 * `set-platform-admin` as the actor text, and the platform tenant as
 * the actor's tenant. The target is the person (`user`, their id), with
 * no target tenant, as the flag belongs to no one workspace.
 *
 * The write is one `--file` of two statements: the audit row, inserted
 * only while the row with the id read still has the email given and
 * the flag value read, then the flag, changed only under the same
 * guard and while the audit row exists. A row changed between the read
 * and the write, its flag or its email, is left as it was, with no
 * audit row; the re-read, of id, email and flag, then shows it and the
 * command stops, naming the audit row id so the operator can check
 * whether an audit row landed and needs correcting. The SQL file is
 * removed once applied.
 *
 * A dry run, the default, reads and prints what it would do; it writes
 * nothing. The flag is read from the row on every request, so a change
 * takes effect on the person's next request.
 *
 * @version v0.9.0
 */

import { escapeSql } from "./sql";
import { ProvisionStop, type Log, type Target } from "./tenant-storage";
import type { RowReader } from "./capture-registration";
import { PLATFORM_TENANT_ID } from "../../app/lib/tenant";

export const SET_PLATFORM_ADMIN_ACTIONS = ["set", "clear"] as const;
export type SetPlatformAdminAction = (typeof SET_PLATFORM_ADMIN_ACTIONS)[number];

export interface SetPlatformAdminOptions {
  action: SetPlatformAdminAction;
  email: string;
  target: Target;
  apply: boolean;
}

export interface SetPlatformAdminProviders {
  rows: RowReader;
  writeFile: (path: string, text: string) => void;
  applyFile: (path: string) => void;
  removeFile: (path: string) => void;
  now: () => number;
  newId: () => string;
}

export interface SetPlatformAdminResult {
  action: SetPlatformAdminAction;
  /** What was done, or would be: `set`, `clear` or `none`. */
  step: SetPlatformAdminAction | "none";
  applied: boolean;
  userId: string;
}

/** The text the audit row names the command by. */
export const ACTOR_TEXT = "set-platform-admin";

export const OUTPUT_DIR = ".import";

export function sqlPath(now: number): string {
  return `${OUTPUT_DIR}/set-platform-admin_${now}.sql`;
}

/** The two statements of one change, values written in as literals. */
export function changeStatements(args: {
  auditId: string;
  userId: string;
  /** The resolved email, lowercased. */
  email: string;
  from: 0 | 1;
  to: 0 | 1;
  now: number;
}): string {
  const id = escapeSql(args.userId);
  const email = escapeSql(args.email);
  const auditId = escapeSql(args.auditId);
  const details = escapeSql(
    JSON.stringify({ flag: "isPlatformAdmin", step: args.to === 1 ? "granted" : "revoked" }),
  );
  return [
    "INSERT INTO audit_log (id, created_at, actor_user_id, actor_user_id_text, actor_tenant_id, action, " +
      "target_tenant_id, target_object_kind, target_object_id, impersonation_session_id, details) " +
      `SELECT ${auditId}, ${args.now}, NULL, ${escapeSql(ACTOR_TEXT)}, ${escapeSql(PLATFORM_TENANT_ID)}, ` +
      `'set_user_role', NULL, 'user', ${id}, NULL, ${details} ` +
      `WHERE EXISTS (SELECT 1 FROM users WHERE id = ${id} AND lower(email) = ${email} ` +
      `AND is_platform_admin = ${args.from});`,
    `UPDATE users SET is_platform_admin = ${args.to}, updated_at = ${args.now} ` +
      `WHERE id = ${id} AND lower(email) = ${email} AND is_platform_admin = ${args.from} ` +
      `AND EXISTS (SELECT 1 FROM audit_log WHERE id = ${auditId});`,
  ].join("\n");
}

/** Sets or clears the platform-admin flag for one person (module header). */
export async function runSetPlatformAdmin(
  options: SetPlatformAdminOptions,
  providers: SetPlatformAdminProviders,
  log: Log,
): Promise<SetPlatformAdminResult> {
  const { action, apply } = options;
  const email = options.email.trim().toLowerCase();
  if (!email) throw new ProvisionStop("--email is required");

  const [row] = await providers.rows(
    `SELECT id, email, tenant_id, is_platform_admin FROM users WHERE email = ${escapeSql(email)};`,
  );
  if (!row) throw new ProvisionStop(`No user has the email ${email}`);
  const userId = String(row.id);
  const from: 0 | 1 = Number(row.is_platform_admin) === 1 ? 1 : 0;
  const to: 0 | 1 = action === "set" ? 1 : 0;

  log(`Platform admin for ${email} (${userId}), target ${options.target}${apply ? "" : ", dry run"}`);
  log(`  currently ${from === 1 ? "a platform admin" : "not a platform admin"}; stored workspace ${String(row.tenant_id)}`);
  if (action === "set" && String(row.tenant_id) === PLATFORM_TENANT_ID) {
    throw new ProvisionStop(
      `${email} is stored on the platform tenant (an operator); an operator is never admitted as a platform admin`,
    );
  }
  if (from === to) {
    log(`  [exists] already ${to === 1 ? "a platform admin" : "not a platform admin"}; nothing to do`);
    return { action, step: "none", applied: false, userId };
  }

  const wording = to === 1 ? "set the platform-admin flag" : "clear the platform-admin flag";
  if (!apply) {
    log(`  [${action}] would ${wording}, with one audit row`);
    return { action, step: action, applied: false, userId };
  }

  const now = providers.now();
  const auditId = providers.newId();
  const file = sqlPath(now);
  providers.writeFile(file, changeStatements({ auditId, userId, email, from, to, now }) + "\n");
  try {
    providers.applyFile(file);
  } finally {
    providers.removeFile(file);
  }

  const landed = await providers.rows(
    `SELECT 1 AS landed FROM users WHERE id = ${escapeSql(userId)} AND lower(email) = ${escapeSql(email)} ` +
      `AND is_platform_admin = ${to} AND EXISTS (SELECT 1 FROM audit_log WHERE id = ${escapeSql(auditId)});`,
  );
  if (landed.length !== 1) {
    throw new ProvisionStop(
      "The re-read does not show the write; the person's row changed between the read and the write. " +
        `The audit row ${auditId} may need correcting: check whether it landed. Run the command again`,
    );
  }
  log(`  [${action}] ${wording.replace(/^\w/, (c) => c.toUpperCase())}: done; it takes effect on their next request`);
  return { action, step: action, applied: true, userId };
}

// @version v0.9.0
