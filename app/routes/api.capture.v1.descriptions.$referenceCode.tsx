/**
 * Capture Link Reference-Code Lookup API
 *
 * This API endpoint answers a Captua unit under contract 1.8:
 * `GET /api/capture/v1/descriptions/<referenceCode>` says whether the
 * workspace holds a description with that exact reference code, with its
 * title, level and dates when it does, so the unit can check the stem of
 * a volume an admin creates or corrects by hand. Like the link's other
 * calls, it is a machine route outside the authenticated layout, with no
 * session, no auth middleware and no Origin check, answering on the
 * tenant's own host, authenticated by the unit's bearer token.
 *
 * `loader` and `action` both hand the request to
 * `handleDescriptionLookup` (`description-link.server.ts`), which
 * answers any method other than GET with 405. The handler reads the
 * code from the request's URL, decoded once, rather than from
 * `params.referenceCode`, which the router can decode more than once.
 *
 * @version v0.9.0
 */
import type { Route } from "./+types/api.capture.v1.descriptions.$referenceCode";
import type { CaptureLinkDeps } from "../lib/capture/link.server";
import { handleDescriptionLookup } from "../lib/capture/description-link.server";

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
  return handleDescriptionLookup(await deps(context.cloudflare.env), request);
}

export async function action({ request, context }: Route.ActionArgs) {
  return handleDescriptionLookup(await deps(context.cloudflare.env), request);
}

// @version v0.9.0
