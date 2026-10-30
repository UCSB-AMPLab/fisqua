/**
 * User Detail — Role Writes
 *
 * This module reads the role part of the user detail form and writes
 * it for one person. It is split out of `_auth.admin.users.$id.tsx` so
 * the server code it needs (`canGrantStaff`, `canGrantSteward`,
 * `applyRoleChanges`) stays out of the client bundle, and so the tests
 * can drive the write without the i18n and middleware wiring of a
 * request. The route's loader reads `writableRoleFlags` to decide which
 * checkboxes to enable; its action calls `applyUpdateRoles`.
 *
 * @version v0.8.0
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Tenant, User } from "../context";
import {
  canGrantStaff,
  canGrantSteward,
  type RoleFlag,
} from "../lib/permissions.server";
import {
  applyRoleChanges,
  type AccessActor,
  type FederationRoleChoice,
} from "../lib/access-changes.server";

/** The tenant capability behind each role flag of an optional area. */
const FLAG_CAPABILITY: Partial<
  Record<
    RoleFlag,
    "crowdsourcingEnabled" | "authoritiesEnabled" | "importsEnabled" | "digitizationEnabled"
  >
> = {
  isCollabAdmin: "crowdsourcingEnabled",
  isCataloguer: "crowdsourcingEnabled",
  isAuthoritiesAdmin: "authoritiesEnabled",
  isImportsAdmin: "importsEnabled",
  isDigitizationAdmin: "digitizationEnabled",
};

/**
 * The flags of `flags` the workspace has the area for: the cataloguing
 * pair needs crowdsourcing, and each area admin needs its area. The
 * others belong to every workspace.
 */
export function writableRoleFlags(
  flags: readonly RoleFlag[],
  tenant: Pick<
    Tenant,
    "crowdsourcingEnabled" | "authoritiesEnabled" | "importsEnabled" | "digitizationEnabled"
  >,
): RoleFlag[] {
  return flags.filter((flag) => {
    const capability = FLAG_CAPABILITY[flag];
    return !capability || tenant[capability];
  });
}

const FEDERATION_CHOICES: readonly string[] = ["none", "staff", "steward"];

export type UpdateRolesResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "invalid_request"
        | "role_not_assignable"
        | "roles_changed"
        | "last_workspace_admin";
    };

/**
 * Reads the role part of the form and writes it for one person.
 * Extracted from `action` so the tests can drive the write without the
 * i18n and middleware wiring of a request.
 *
 * Behaviour contract:
 *
 *   - `assignableFlags` is the ALLOWLIST of flags read out of the form,
 *     narrowed further to the areas the workspace has
 *     (`writableRoleFlags`). A flag outside it is never read, and its
 *     stored value is left exactly as it was.
 *   - Within that set, a flag is part of the save only when the form
 *     carries its shown value, `shown_<flag>` (`1` or `0`); its wanted
 *     value is the checkbox, an unchecked box arriving as missing. A
 *     checkbox posted without its shown value is an invalid request.
 *   - `federationRole` and `federationRoleShown`, when posted, are each
 *     `none`, `staff` or `steward`. A change that touches `steward`
 *     needs `canGrantSteward`; any other needs `canGrantStaff`.
 *     Otherwise the whole save is refused with `role_not_assignable`.
 *   - The changes go to `applyRoleChanges`, which writes them all with
 *     their audit rows or none of them.
 */
export async function applyUpdateRoles(args: {
  db: DrizzleD1Database<any>;
  d1: D1Database;
  tenant: Tenant;
  targetUserId: string;
  formData: FormData;
  assignableFlags: readonly RoleFlag[];
  currentUser: User;
  actor: AccessActor;
  now: number;
  newId: () => string;
}): Promise<UpdateRolesResult> {
  const { formData } = args;

  const changes: Array<{ flag: RoleFlag; shown: boolean; to: boolean }> = [];
  for (const flag of writableRoleFlags(args.assignableFlags, args.tenant)) {
    const shown = formData.get(`shown_${flag}`);
    if (shown === null) {
      if (formData.has(flag)) return { ok: false, error: "invalid_request" };
      continue;
    }
    if (shown !== "1" && shown !== "0") return { ok: false, error: "invalid_request" };
    changes.push({ flag, shown: shown === "1", to: formData.get(flag) === "on" });
  }

  let federation: { shown: FederationRoleChoice; to: FederationRoleChoice } | null = null;
  const to = formData.get("federationRole");
  const shown = formData.get("federationRoleShown");
  if (to !== null || shown !== null) {
    if (
      typeof to !== "string" ||
      typeof shown !== "string" ||
      !FEDERATION_CHOICES.includes(to) ||
      !FEDERATION_CHOICES.includes(shown)
    ) {
      return { ok: false, error: "invalid_request" };
    }
    federation = { shown: shown as FederationRoleChoice, to: to as FederationRoleChoice };
    if (federation.shown !== federation.to) {
      const touchesSteward = federation.shown === "steward" || federation.to === "steward";
      const allowed = touchesSteward
        ? await canGrantSteward(args.db, args.currentUser, args.tenant)
        : await canGrantStaff(args.db, args.currentUser, args.tenant);
      if (!allowed) return { ok: false, error: "role_not_assignable" };
    }
  }

  return applyRoleChanges({
    d1: args.d1,
    tenant: args.tenant,
    targetUserId: args.targetUserId,
    changes,
    federation,
    actor: args.actor,
    now: args.now,
    newId: args.newId,
  });
}
