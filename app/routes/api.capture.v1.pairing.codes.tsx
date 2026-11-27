/**
 * Capture Pairing — Codes API
 *
 * This API endpoint is where a Captua unit asks for the six-character
 * code it shows while it waits to be linked to its workspace (contract
 * §12.1). It is a machine route: outside the authenticated layout, with
 * no session, no token and no tenant, answering only on Fisqua's main
 * address (`CAPTURE_PAIRING_ORIGIN`) and with a bare 404 on every other
 * host, a workspace's own host included.
 *
 * `action` builds the handler's dependencies from the Worker's context
 * and hands the request to `handlePairingCodes`. `loader` hands GET and
 * HEAD to the same handler, which answers them 405 on the main address
 * and a bare 404 elsewhere.
 *
 * @version v0.9.0
 */
import type { Route } from "./+types/api.capture.v1.pairing.codes";
import {
  clientAddress,
  handlePairingCodes,
  type PairingDeps,
} from "../lib/capture/pairing.server";

async function deps(env: Env): Promise<PairingDeps> {
  const { drizzle } = await import("drizzle-orm/d1");
  return {
    db: drizzle(env.DB),
    env,
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    clientAddress,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  return handlePairingCodes(await deps(context.cloudflare.env), request);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  return handlePairingCodes(await deps(context.cloudflare.env), request);
}

// @version v0.9.0
