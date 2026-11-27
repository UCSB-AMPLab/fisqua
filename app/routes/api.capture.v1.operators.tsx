/**
 * Capture Link Operators API
 *
 * This API endpoint answers a Captua unit under contract 1.7:
 * `PUT /api/capture/v1/operators` replaces the operator list the unit holds for its scanner with the one it sends. Like the link's other calls, it is a machine route
 * outside the authenticated layout, with no session, no auth middleware
 * and no Origin check, answering on the tenant's own host, authenticated
 * by the unit's bearer token.
 *
 * `loader` and `action` both hand the request to `handleOperatorsPut`
 * (`queue-link.server.ts`), which answers any method other than
 * PUT with 405.
 *
 * @version v0.9.0
 */
import type { Route } from "./+types/api.capture.v1.operators";
import type { CaptureLinkDeps } from "../lib/capture/link.server";
import { handleOperatorsPut } from "../lib/capture/queue-link.server";

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

export async function loader({ request, context }: Route.LoaderArgs) {
  return handleOperatorsPut(await deps(context.cloudflare.env), request);
}

export async function action({ request, context }: Route.ActionArgs) {
  return handleOperatorsPut(await deps(context.cloudflare.env), request);
}

// @version v0.9.0
