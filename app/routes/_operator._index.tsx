/**
 * Operator Landing Redirect
 *
 * The `_operator` layout (`app/routes.ts`) only ever registered
 * path-specific children -- `operator/tenants`, `.../new`, `.../:slug`,
 * `.../:slug/login-as` -- so the bare `/operator` prefix had no route
 * of its own and fell through to React Router's no-match handling
 * (a 404, or worse, a 500 if the i18next context wasn't populated for
 * the unmatched request -- see `app/entry.server.tsx`). Operators land
 * on the bare prefix from bookmarks and muscle memory more often than
 * a URL bar would suggest, so this route exists purely to forward them
 * to the tenant list, the operator surface's actual home screen.
 *
 * @version v0.6.0
 */

import { redirect } from "react-router";

export function loader() {
  return redirect("/operator/tenants");
}

// @version v0.6.0
