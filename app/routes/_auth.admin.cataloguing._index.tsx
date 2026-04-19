/**
 * Cataloguing Admin Redirect
 *
 * The cataloguing admin landing URL has no content of its own — it
 * just redirects to the Projects panel, which is the primary surface
 * cataloguing admins work from.
 *
 * @version v0.3.0
 */

import { redirect } from "react-router";

export function loader() {
  return redirect("/admin/cataloguing/projects");
}
