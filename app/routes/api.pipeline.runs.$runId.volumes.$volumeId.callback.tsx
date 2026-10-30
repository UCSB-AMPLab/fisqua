/**
 * Media Pipeline Callback API
 *
 * This API endpoint receives the per-volume report the media pipeline
 * runner posts after each volume it processes. It is a machine route:
 * it sits outside the authenticated layout, reads no session cookie and
 * runs no auth middleware. It answers only on the configured callback
 * origin (a bare 404 on every other host, for every method), takes a
 * bearer token minted for one run, and takes its tenant from that run's
 * row, never from the host.
 *
 * `action` hands the request to `handleVolumeCallback`, which does the
 * host, size, token, replay and validation checks and writes the
 * report. `loader` answers GET and HEAD with 405 on the callback origin.
 * The media object reader is built only when the handler first reads
 * through it, so a misconfigured reader cannot turn away a report.
 *
 * @version v0.8.0
 */
import type { Route } from "./+types/api.pipeline.runs.$runId.volumes.$volumeId.callback";
import {
  handleVolumeCallback,
  methodNotAllowed,
  requirePipelineOrigin,
} from "../lib/pipeline/callback.server";
import { getMediaObjectReader } from "../lib/pipeline/store.server";

export async function action({ request, context, params }: Route.ActionArgs) {
  const { env, ctx } = context.cloudflare;
  requirePipelineOrigin(request, env);
  const { drizzle } = await import("drizzle-orm/d1");
  return handleVolumeCallback(
    {
      db: drizzle(env.DB),
      env,
      reader: { getText: (bucket, key) => getMediaObjectReader(env).getText(bucket, key) },
      waitUntil: (p) => ctx.waitUntil(p),
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
    },
    request,
    { runId: params.runId, volumeId: params.volumeId },
  );
}

export async function loader({ request, context }: Route.LoaderArgs) {
  requirePipelineOrigin(request, context.cloudflare.env);
  return methodNotAllowed();
}

// @version v0.8.0
