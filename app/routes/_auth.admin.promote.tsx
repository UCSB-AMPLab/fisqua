/**
 * Legacy Promote Redirect
 *
 * This route is the legacy crowdsourcing promotion URL. It issues a
 * 301 to the new path under `/admin/cataloguing/promote` so existing
 * bookmarks keep working.
 *
 * Capability gate runs before the redirect. Promote is a cataloguing
 * feature, so `requireCapability(tenant, "crowdsourcing")` runs first
 * and a crowdsourcing-off tenant 404s here rather than chasing the 301
 * into the cataloguing layout, which would 404 it anyway. The publish
 * pipeline has no part in Promote: the sidebar shows the item to a
 * super admin on any tenant with crowdsourcing on, and this route
 * follows the same rule.
 *
 * @version v0.8.0
 */

import { redirect } from "react-router";
import { tenantContext } from "../context";
import { requireCapability } from "../lib/tenant";
import type { Route } from "./+types/_auth.admin.promote";

export function loader({ context }: Route.LoaderArgs) {
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "crowdsourcing");
  return redirect("/admin/cataloguing/promote", 301);
}

// @version v0.8.0
