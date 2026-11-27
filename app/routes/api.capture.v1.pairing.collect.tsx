/**
 * Capture Pairing — Collect API
 *
 * This API endpoint is where a Captua unit polls, with its pairing code
 * and collect secret, until an administrator has approved the code and
 * it can collect its link token, bucket keys and backup key, once
 * (contract §12.2). It is a machine route: outside the authenticated
 * layout, with no session, no token and no tenant, answering only on
 * Fisqua's main address (`CAPTURE_PAIRING_ORIGIN`) and with a bare 404
 * on every other host, a workspace's own host included.
 *
 * `action` builds the handler's dependencies from the Worker's context
 * and hands the request to `handlePairingCollect`. `loader` hands GET
 * and HEAD to the same handler, which answers them 405 on the main
 * address and a bare 404 elsewhere.
 *
 * @version v0.9.0
 */
import type { Route } from "./+types/api.capture.v1.pairing.collect";
import { clientAddress, type PairingDeps } from "../lib/capture/pairing.server";
import { handlePairingCollect } from "../lib/capture/pairing-collect.server";

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
  return handlePairingCollect(await deps(context.cloudflare.env), request);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  return handlePairingCollect(await deps(context.cloudflare.env), request);
}

// @version v0.9.0
