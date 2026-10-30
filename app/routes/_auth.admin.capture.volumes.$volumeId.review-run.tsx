/**
 * Capture QC — Prepare or Retry the Review Images
 *
 * This action-only resource route starts the review run of one
 * pipeline volume's current delivery: the run that tiles the delivery's
 * images as captured for the capture QC viewer. The Volumes screen
 * posts to it from its Prepare and Retry steps. A direct request to a
 * resource route skips React Router's own Origin check, so the action
 * first requires the request to come from this Worker's own origin
 * (`requireSameOrigin`; a bare 403 otherwise). A tenant without the
 * digitization capability then gets a bare 404; the route then hands
 * the request to `reviewRunAction`, which lets through only the
 * tenant's digitization admins and the federation's stewards (anyone else gets a
 * bare 403) and answers with the run started, `review_run_open`, or
 * `review_not_applicable` with its reason. GET answers 405.
 *
 * @version@version v0.8.0
 */
import type { Route } from "./+types/_auth.admin.capture.volumes.$volumeId.review-run";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { requireSameOrigin } from "../lib/same-origin.server";

export async function action({ request, context, params }: Route.ActionArgs) {
  requireSameOrigin(request, context.cloudflare.env);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "digitization");
  const user = context.get(userContext);
  const { reviewRunAction, reviewRunDepsFor } = await import("~/lib/capture/review-run.server");
  return reviewRunAction(reviewRunDepsFor(context.cloudflare.env), request, params.volumeId, tenant, user);
}

export async function loader() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

// @version@version v0.8.0
