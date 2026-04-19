/**
 * Superadmin Route Guard
 *
 * Throws a React Router redirect from route loaders and actions whenever
 * the current user is not flagged as a superadmin. Used on the publish
 * dashboard and other routes that must be off-limits to ordinary admins.
 *
 * @version v0.3.0
 */

import { redirect } from "react-router";

interface UserWithSuperAdmin {
  id: string;
  isSuperAdmin: boolean;
  isAdmin: boolean;
}

/**
 * Guard that throws a redirect if the user is not a superadmin.
 * Use in route loaders and actions for superadmin-only pages.
 */
export function requireSuperAdmin(user: UserWithSuperAdmin): void {
  if (!user.isSuperAdmin) {
    throw redirect("/admin/descriptions");
  }
}
