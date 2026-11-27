/**
 * Area Access
 *
 * This module deals with who may administer each area of a workspace.
 * A workspace's administration splits into four areas, each with its
 * own admin flag on `users` (migration 0107):
 *
 *   - `records`: descriptions, repositories, vocabularies, entity
 *     functions and vocabulary decisions (`isRecordsAdmin`);
 *   - `authorities`: entities, places, authority handlists and the
 *     authority decisions (`isAuthoritiesAdmin`);
 *   - `imports`: the imports area (`isImportsAdmin`);
 *   - `digitization`: the Digitization screens and capture QC
 *     (`isDigitizationAdmin`).
 *
 * `AREA_ADMIN_FLAGS` maps each area to its flag. `canAdministerArea`
 * answers whether a user passes an area: a workspace admin (`isAdmin`)
 * passes every area, a super admin passes every area, and an area
 * admin passes their own area and no other. `requireArea` is the guard
 * form, throwing the same bare 403 `Response` that `requireAdmin`
 * throws, so a route moves from one to the other without changing what
 * a refused caller sees.
 *
 * `isWorkspaceAdmin` reads `isAdmin` alone. It names the surfaces that
 * stay with the workspace admin whatever area flags a user holds: the
 * users area, project creation and the project-role override.
 * `requireAdmin` (`permissions.server.ts`) remains the guard for them.
 *
 * Doing an area's work is a separate question from administering it.
 * `canWorkInArea` answers it: whoever administers the area works in it,
 * and so does a holder of a federation `staff` grant, whose effective
 * user carries `worksInEveryArea` (`grantEffectiveRoleFlags`). Staff
 * open and act on every working area of a member workspace (records,
 * authorities, imports, digitization) without any admin flag, so every
 * check that stays on `canAdministerArea` or `requireArea` still
 * excludes them. `requireAreaWork` is its guard form, with the same
 * bare 403. A route that is work calls the work check; a route that is
 * administration (users and roles, workspace settings, the scanner
 * token, starting runs, publication) keeps the admin check.
 *
 * `mayExportMachineReadable` holds the rule for the bulk
 * machine-readable export formats (CSV, EAD XML, JSON): workspace
 * admins, super admins, the admin of the area the exported record class
 * belongs to (records for descriptions; authorities for entities and
 * places), and the imports admin, whose work is moving data in and out
 * in those formats.
 *
 * The flags read here are the request's effective flags. Under a
 * federation grant `grantEffectiveRoleFlags` sets every area flag to
 * false, so an area admin at home is no area admin in a member tenant;
 * a steward grant carries `isAdmin` and passes every area as a
 * workspace admin. Operators impersonate the six role flags only, never
 * an area flag, and never `worksInEveryArea`.
 *
 * @version v0.9.0
 */

import type { User } from "../context";
import type { ExportRecordClass } from "./export/matrix";

/** The four administrative areas of a workspace. */
export type AccessArea = "records" | "authorities" | "imports" | "digitization";

/** The `users` flag that makes someone an area's admin. */
export type AreaFlag =
  | "isRecordsAdmin"
  | "isAuthoritiesAdmin"
  | "isImportsAdmin"
  | "isDigitizationAdmin";

/** The part of `User` the access checks read. */
export type AccessUser = Pick<
  User,
  "isAdmin" | "isSuperAdmin" | AreaFlag | "worksInEveryArea"
>;

/** Each area's admin flag. */
export const AREA_ADMIN_FLAGS: Record<AccessArea, AreaFlag> = {
  records: "isRecordsAdmin",
  authorities: "isAuthoritiesAdmin",
  imports: "isImportsAdmin",
  digitization: "isDigitizationAdmin",
};

/** Whether the user is the workspace admin (`isAdmin`). */
export function isWorkspaceAdmin(user: Pick<User, "isAdmin">): boolean {
  return !!user.isAdmin;
}

/**
 * Whether the user may administer `area`: a workspace admin, a super
 * admin, or the admin of that area.
 */
export function canAdministerArea(user: AccessUser, area: AccessArea): boolean {
  return (
    isWorkspaceAdmin(user) ||
    !!user.isSuperAdmin ||
    !!user[AREA_ADMIN_FLAGS[area]]
  );
}

/**
 * Throws a 403 Response unless the user may administer `area`.
 */
export function requireArea(user: AccessUser, area: AccessArea): void {
  if (!canAdministerArea(user, area)) {
    throw new Response("Forbidden", { status: 403 });
  }
}

/**
 * Whether the user may do the work of `area`: whoever may administer
 * it, and a federation staff grant (`worksInEveryArea`). Passing this
 * check confers no administration of the area.
 */
export function canWorkInArea(user: AccessUser, area: AccessArea): boolean {
  return canAdministerArea(user, area) || !!user.worksInEveryArea;
}

/**
 * Throws a 403 Response unless the user may do the work of `area`.
 */
export function requireAreaWork(user: AccessUser, area: AccessArea): void {
  if (!canWorkInArea(user, area)) {
    throw new Response("Forbidden", { status: 403 });
  }
}

/** The area an export record class belongs to. */
function areaOfRecordClass(recordClass: ExportRecordClass): AccessArea {
  return recordClass === "records" ? "records" : "authorities";
}

/**
 * Whether the user may take machine-readable exports (CSV, EAD XML,
 * JSON) of `recordClass`: a workspace admin, a super admin, the admin
 * of the record class's area, or the imports admin.
 */
export function mayExportMachineReadable(
  user: AccessUser,
  recordClass: ExportRecordClass,
): boolean {
  return (
    canAdministerArea(user, areaOfRecordClass(recordClass)) ||
    !!user.isImportsAdmin
  );
}

/* @version v0.9.0 */
