/**
 * Cataloguing Admin Layout
 *
 * This layout is the parent route for the cataloguing admin subsection in the sidebar.
 * Holds the guard, `requireCollabAdmin`, that admits cataloguing
 * admins, tenant admins and superadmins to Projects, Team and Promote
 * (Promote adds its own super-admin check). Renders the active child
 * route through `<Outlet />`.
 *
 * Layout-level capability gate. The first data-access action in the
 * loader is `requireCapability(tenant, "crowdsourcing")`, which
 * throws a bare `Response(null, {status: 404})` when the tenant has
 * the `crowdsourcing` capability flag off. The 404 is the structural
 * backstop for the sidebar gate: a UI user never sees the link, but
 * a direct-URL hit (or a dormant `isCataloguer=true` flag from a
 * prior tenant configuration) cannot reach the cataloguing surface
 * either.
 *
 * @version v0.8.0
 */

import { Outlet } from "react-router";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import type { Route } from "./+types/_auth.admin.cataloguing";

export async function loader({ context }: Route.LoaderArgs) {
  const { requireCollabAdmin } = await import("../lib/permissions.server");

  const user = context.get(userContext);
  requireCollabAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "crowdsourcing");

  return { user };
}

export default function AdminCataloguingLayout() {
  return (
    <div className="mx-auto max-w-7xl px-8 py-8">
      <Outlet />
    </div>
  );
}

// @version v0.8.0
