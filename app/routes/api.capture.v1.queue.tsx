/**
 * Capture Link Queue API
 *
 * This API endpoint answers a Captua unit under contract 1.7:
 * `GET /api/capture/v1/queue` answers the digitization queue the unit is to see, with its revision as an ETag, or 304 when the unit already has it. Like the link's other calls, it is a machine route
 * outside the authenticated layout, with no session, no auth middleware
 * and no Origin check, answering on the tenant's own host, authenticated
 * by the unit's bearer token.
 *
 * `loader` and `action` both hand the request to `handleQueueGet`
 * (`queue-link.server.ts`), which answers any method other than
 * GET with 405.
 *
 * @version v0.9.0
 */
import type { Route } from "./+types/api.capture.v1.queue";
import type { CaptureLinkDeps } from "../lib/capture/link.server";
import { handleQueueGet } from "../lib/capture/queue-link.server";

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
  return handleQueueGet(await deps(context.cloudflare.env), request);
}

export async function action({ request, context }: Route.ActionArgs) {
  return handleQueueGet(await deps(context.cloudflare.env), request);
}

// @version v0.9.0
