/**
 * Capture QC — Record Decisions
 *
 * This action-only resource route records capture QC decisions on the
 * openings of one pipeline volume's current Captua delivery. It has no
 * page of its own; the capture QC viewer posts to it. The auth
 * layout has already resolved the session, the tenant and the user, so
 * the route hands the request to `recordDecisionsAction`, which lets
 * through the volume's assigned reviewer, the tenant's digitization admins and the
 * federation's stewards (anyone else gets a bare 403), checks the JSON
 * body against the delivery, writes the decisions in one batch (an
 * entry whose decision is null clears that opening's decision) and
 * answers with the set's new `decisionsId` and `revision`, or with a
 * refusal code (`revision_changed` when the body's `expectedRevision`
 * is no longer the set's).
 * A tenant without the digitization capability gets a bare 404 first.
 * GET answers 405.
 *
 * @version@version v0.8.0
 */
import type { Route } from "./+types/_auth.admin.capture.volumes.$volumeId.decisions";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";

export async function action({ request, context, params }: Route.ActionArgs) {
  const tenant = context.get(tenantContext);
  // The digitization capability gates the interface: with it off these
  // actions answer a bare 404, as the screens do. The Captua link's own
  // endpoints (manifests, status, and the unit's decisions read) are not
  // gated by it, so a unit keeps working whatever the interface shows.
  requireCapability(tenant, "digitization");
  const user = context.get(userContext);
  const { drizzle } = await import("drizzle-orm/d1");
  const { recordDecisionsAction } = await import("~/lib/capture/qc.server");
  return recordDecisionsAction(
    { db: drizzle(context.cloudflare.env.DB), now: () => Date.now(), newId: () => crypto.randomUUID() },
    request,
    params.volumeId,
    tenant,
    user,
  );
}

export async function loader() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

// @version@version v0.8.0
