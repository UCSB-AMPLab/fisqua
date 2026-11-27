/**
 * Capture Link Description Search API
 *
 * This API endpoint answers a Captua unit under contract 1.10:
 * `GET /api/capture/v1/descriptions?q=<text>` searches the reference
 * codes and titles of the workspace's descriptions, so an admin creating
 * a volume by hand on the unit can find the code to give it. Like the
 * link's other calls, it is a machine route outside the authenticated
 * layout, with no session, no auth middleware and no Origin check,
 * answering on the tenant's own host, authenticated by the unit's bearer
 * token.
 *
 * `loader` and `action` both hand the request to
 * `handleDescriptionSearch` (`description-link.server.ts`), which
 * answers any method other than GET with 405.
 *
 * @version v0.9.0
 */
import type { Route } from "./+types/api.capture.v1.descriptions";
import type { CaptureLinkDeps } from "../lib/capture/link.server";
import { handleDescriptionSearch } from "../lib/capture/description-link.server";

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
  return handleDescriptionSearch(await deps(context.cloudflare.env), request);
}

export async function action({ request, context }: Route.ActionArgs) {
  return handleDescriptionSearch(await deps(context.cloudflare.env), request);
}

// @version v0.9.0
