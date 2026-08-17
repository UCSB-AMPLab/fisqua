/**
 * Places duplicates — moved
 *
 * The place possible-duplicates worklist now lives as one tab of the
 * Pending decisions surface, at `/admin/decisions/duplicates?type=places`,
 * beside the authority proposals and the vocabulary review queue. This
 * route stays registered so bookmarks and any link written before the
 * move keep resolving; it holds nothing but the forward.
 *
 * @version v0.7.0
 */

import { redirect } from "react-router";

export function loader() {
  return redirect("/admin/decisions/duplicates?type=places");
}
