/**
 * Cataloguing users — moved
 *
 * The workspace's users are managed in one place, /admin/users. This
 * route keeps the old cataloguing address resolving for bookmarks and
 * links written before, and sends it there with `?area=cataloguing`,
 * which names the cataloguing roles as the part of the page the
 * visitor was looking for.
 *
 * It is registered outside the cataloguing layout on purpose. Inside
 * it, the layout's `requireCollabAdmin` and crowdsourcing gates would
 * run first and refuse a user manager, who may open /admin/users. The
 * destination applies its own gate, `canManageTenantUsers`, so the
 * redirect itself needs none.
 *
 * @version v0.8.0
 */

import { redirect } from "react-router";

export function loader() {
  return redirect("/admin/users?area=cataloguing");
}

// @version v0.8.0
