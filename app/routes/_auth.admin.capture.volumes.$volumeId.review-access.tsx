/**
 * Capture QC — Review Tile Access
 *
 * This loader-only resource route gives the capture QC viewer what it
 * needs to read one pipeline volume's review tiles from the
 * federation's private review-tiles bucket: the bucket's download
 * address and one short-lived download authorisation token per delivery
 * of the volume, each limited to that delivery's prefix. It has no page
 * of its own. The auth layout has already resolved the session, the
 * tenant and the user, so the route hands them to `reviewAccessLoader`,
 * which checks the digitization capability (a bare 404), the volume, the
 * caller (the volume's reviewer, the tenant's digitization admins and the
 * federation's stewards; anyone else gets a bare 403) and the bucket,
 * and asks B2 for the tokens. POST answers 405.
 *
 * @version@version v0.8.0
 */
import type { Route } from "./+types/_auth.admin.capture.volumes.$volumeId.review-access";
import { tenantContext, userContext } from "../context";

export async function loader({ context, params }: Route.LoaderArgs) {
  const tenant = context.get(tenantContext);
  const user = context.get(userContext);
  const { drizzle } = await import("drizzle-orm/d1");
  const { reviewAccessLoader } = await import("~/lib/capture/review-access.server");
  return reviewAccessLoader(
    {
      db: drizzle(context.cloudflare.env.DB),
      env: context.cloudflare.env,
      fetch: (input, init) => fetch(input, init),
      now: () => Date.now(),
    },
    params.volumeId,
    tenant,
    user,
  );
}

export async function action() {
  return new Response(null, { status: 405, headers: { Allow: "GET" } });
}

// @version@version v0.8.0
