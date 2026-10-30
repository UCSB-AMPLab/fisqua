/**
 * Media Pipeline Chunk-Complete API
 *
 * This API endpoint receives the report a pipeline chunk's completion
 * job posts once every job in the chunk has ended: which of the chunk's
 * volumes never got a callback through, and which of those halted. It
 * is a machine route like the per-volume callback beside it: outside
 * the authenticated layout, with no session cookie and no auth
 * middleware, answering only on the configured callback origin (a bare
 * 404 on every other host, for every method), authenticated by the
 * run's bearer token, and taking its tenant from the run row.
 *
 * `action` hands the request to `handleChunkComplete`, which records the
 * volumes that never reported, halts the run on a halt the runner could
 * not report, and closes the run once no chunk is left to report.
 * `loader` answers GET and HEAD with 405 on the callback origin.
 *
 * @version v0.8.0
 */
import type { Route } from "./+types/api.pipeline.runs.$runId.complete";
import {
  handleChunkComplete,
  methodNotAllowed,
  requirePipelineOrigin,
} from "../lib/pipeline/callback.server";

export async function action({ request, context, params }: Route.ActionArgs) {
  const { env } = context.cloudflare;
  requirePipelineOrigin(request, env);
  const { drizzle } = await import("drizzle-orm/d1");
  return handleChunkComplete(
    {
      db: drizzle(env.DB),
      env,
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
    },
    request,
    { runId: params.runId },
  );
}

export async function loader({ request, context }: Route.LoaderArgs) {
  requirePipelineOrigin(request, context.cloudflare.env);
  return methodNotAllowed();
}

// @version v0.8.0
