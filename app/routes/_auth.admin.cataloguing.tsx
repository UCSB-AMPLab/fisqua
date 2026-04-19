/**
 * Cataloguing Admin Layout
 *
 * Parent route for the cataloguing admin subsection in the sidebar.
 * Holds the guard that gates access to cataloguing admins and
 * superadmins, plus the secondary navigation bar that links between
 * Projects, Team, Users, and Promote. Renders the active child route
 * through `<Outlet />`.
 *
 * @version v0.3.0
 */

import { Outlet } from "react-router";
import { userContext } from "../context";
import type { Route } from "./+types/_auth.admin.cataloguing";

export async function loader({ context }: Route.LoaderArgs) {
  const { requireCollabAdmin } = await import("../lib/permissions.server");

  const user = context.get(userContext);
  requireCollabAdmin(user);

  return { user };
}

export default function AdminCataloguingLayout() {
  return (
    <div className="mx-auto max-w-7xl px-8 py-8">
      <Outlet />
    </div>
  );
}
