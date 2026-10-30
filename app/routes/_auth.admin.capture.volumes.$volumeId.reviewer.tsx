/**
 * Capture QC — Assign the Reviewer
 *
 * This action-only resource route assigns, reassigns or clears the
 * capture QC reviewer of one pipeline volume that came from a Captua
 * delivery. It has no page of its own; the Capture QC queue posts to
 * it. The auth layout has already resolved the session, the tenant and
 * the user, so the route hands the request to `assignReviewerAction`,
 * which lets through only the tenant's digitization admins and the federation's
 * stewards (anyone else gets a bare 403), reads `{ "reviewerId": ... }`
 * (null clears it) and answers with the reviewer now assigned, or with
 * a refusal code. A tenant without the digitization capability gets a
 * bare 404 first. GET answers 405.
 *
 * @version@version v0.8.0
 */
import type { Route } from "./+types/_auth.admin.capture.volumes.$volumeId.reviewer";
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
  const { assignReviewerAction } = await import("~/lib/capture/qc.server");
  return assignReviewerAction(
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
