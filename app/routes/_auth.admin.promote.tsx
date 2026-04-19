/**
 * Legacy Promote Redirect
 *
 * Old crowdsourcing promotion URL. Issues a 301 to the new path under
 * /admin/cataloguing/promote so existing bookmarks keep working.
 *
 * @version v0.3.0
 */

import { redirect } from "react-router";
import type { Route } from "./+types/_auth.admin.promote";

export function loader(_args: Route.LoaderArgs) {
  return redirect("/admin/cataloguing/promote", 301);
}
