/**
 * Capture Link Volume Decisions API
 *
 * This API endpoint answers a Captua unit asking what Fisqua's capture
 * QC decided about a volume it handed over, as the Captua exchange
 * contract defines the call: `GET
 * /api/capture/v1/volumes/<ref>/decisions`. The unit asks only when the
 * `decisionsId` in the volume's status differs from the last set it
 * applied. Like the link's other calls, it is a machine
 * route outside the authenticated layout, with no session, no auth
 * middleware and no Origin check, answering on the tenant's own host,
 * authenticated by the unit's bearer token.
 *
 * `loader` hands the request to `handleVolumeDecisions`, which answers
 * with the decisions of the volume's current delivery (`records: []`
 * once every decision of its set has been cleared), or 404 with the
 * problem `no-decisions` when it has no set. `action` answers every other method with 405.
 *
 * @version v0.8.0
 */
import type { Route } from "./+types/api.capture.v1.volumes.$ref.decisions";
import type { CaptureLinkDeps } from "../lib/capture/link.server";
import { handleVolumeDecisions } from "../lib/capture/qc.server";

async function deps(env: Env): Promise<CaptureLinkDeps> {
  const { drizzle } = await import("drizzle-orm/d1");
  return {
    db: drizzle(env.DB),
    env,
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
  };
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  return handleVolumeDecisions(await deps(context.cloudflare.env), request, params.ref);
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return handleVolumeDecisions(await deps(context.cloudflare.env), request, params.ref);
}

// @version v0.8.0
