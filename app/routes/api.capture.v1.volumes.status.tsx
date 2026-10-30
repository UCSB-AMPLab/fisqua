/**
 * Capture Link Volume Status API
 *
 * This API endpoint answers a Captua unit asking how the volumes it
 * handed over are getting on, under the Captua exchange contract:
 * `GET /api/capture/v1/volumes/status?refs=<ref>,<ref>,...`, up to 100
 * reference codes. Like manifest delivery beside it, it is a machine
 * route outside the authenticated layout, with no session, no auth
 * middleware and no Origin check, answering on the tenant's own host,
 * authenticated by the unit's bearer token.
 *
 * `loader` hands the request to `handleVolumeStatus`, which answers
 * `{ volumes: [...] }`, one entry per reference code asked for.
 * `action` answers every other method with 405.
 *
 * @version v0.8.0
 */
import type { Route } from "./+types/api.capture.v1.volumes.status";
import { handleVolumeStatus, type CaptureLinkDeps } from "../lib/capture/link.server";

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
  return handleVolumeStatus(await deps(context.cloudflare.env), request);
}

export async function action({ request, context }: Route.ActionArgs) {
  return handleVolumeStatus(await deps(context.cloudflare.env), request);
}

// @version v0.8.0
