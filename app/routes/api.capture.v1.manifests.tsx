/**
 * Capture Link Manifest Delivery API
 *
 * This API endpoint receives the capture manifest a Captua unit sends
 * at a volume's handover, under the Captua exchange contract. It is a machine
 * route like the media pipeline's callbacks: outside the authenticated
 * layout, with no session cookie, no auth middleware and no Origin
 * check, answering on the tenant's own host, authenticated by the
 * unit's bearer token and taking its tenant from the host.
 *
 * `action` hands the request to `handleManifestDelivery`, which checks
 * the manifest, registers its volume with the media pipeline and
 * answers with the state, or refuses it with its problems. A delivery
 * this request registered starts its review run after the answer, in
 * `waitUntil` (`startReviewRun`); a start that is declined or fails is
 * logged by its reason and is left to the Volumes screen. `loader`
 * answers GET and HEAD with 405 through the same handler.
 *
 * @version v0.8.0
 */
import type { Route } from "./+types/api.capture.v1.manifests";
import { handleManifestDelivery, type CaptureLinkDeps } from "../lib/capture/link.server";

async function deps(env: Env, waitUntil?: (p: Promise<unknown>) => void): Promise<CaptureLinkDeps> {
  const { drizzle } = await import("drizzle-orm/d1");
  return {
    db: drizzle(env.DB),
    env,
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    onRegistered: waitUntil
      ? (tenant, deliveryId) =>
          waitUntil(
            (async () => {
              const { reviewRunDepsFor, startReviewRun } = await import("../lib/capture/review-run.server");
              const outcome = await startReviewRun(reviewRunDepsFor(env), tenant, deliveryId, null);
              if (!outcome.started) console.log(`review run not started for ${deliveryId}: ${outcome.reason}`);
            })().catch((err) => {
              console.error(`review run start failed for ${deliveryId}: ${err instanceof Error ? err.name : "error"}`);
            }),
          )
      : undefined,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, ctx } = context.cloudflare;
  return handleManifestDelivery(await deps(env, (p) => ctx.waitUntil(p)), request);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  return handleManifestDelivery(await deps(context.cloudflare.env), request);
}

// @version v0.8.0
