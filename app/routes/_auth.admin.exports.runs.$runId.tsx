/**
 * Exports — one run, for the pollers
 *
 * A resource route with no UI: the dialog and the in-progress history
 * rows both need the same run row as it stands now, and a fetcher
 * needs somewhere to fetch it from. It exists rather than having the
 * pollers reload the exports loader, which would re-resolve the chosen
 * scope, re-read the hierarchy and re-run the retention sweep every
 * two and a half seconds to learn one number.
 *
 * Member-level and tenant-scoped, exactly like the surface. A run from
 * another workspace comes back as `null` rather than as a 404, because
 * the poller is a background read and a thrown response would surface
 * as an error boundary on a page that is otherwise fine — and `null`
 * leaks precisely as much as a 404 does, which is nothing.
 *
 * @version v0.7.0
 */
import { tenantContext } from "../context";
import type { Route } from "./+types/_auth.admin.exports.runs.$runId";

export async function loader({ context, params }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { getExportRun } = await import("~/lib/export/run.server");

  const tenant = context.get(tenantContext);
  const db = drizzle(context.cloudflare.env.DB);

  return { run: await getExportRun(db, tenant, params.runId) };
}
