/**
 * Media Pipeline — Publish a Volume
 *
 * This action-only resource route publishes one ready pipeline volume.
 * It has no page of its own; the volume screens will post to it. The
 * auth layout has already resolved the session, the tenant and the
 * user, so the route builds its dependencies from the environment and
 * the tenant's storage destination and hands the request to `publishVolumeAction`, which applies the
 * capability and federation-lead gate (a bare 404 or 403), reads the
 * JSON body `{ "run_id": ... }`, publishes the volume from that run and
 * answers with the publication, or with a refusal code.
 *
 * Publishing stays off unless the environment sets
 * `PIPELINE_PUBLISH_ENABLED` to `"true"`; until then a valid request is
 * refused and nothing is written. A tenant whose storage destination is
 * not set up is refused with `tenant_destination_unset`. The canonical
 * manifest is written to the tenant's manifest bucket, and its URL must
 * sit under the tenant's `manifest_base_url` at the key promotion
 * writes. The object reader is
 * built at its first read, so a missing reader setting is reported as a
 * refusal rather than an error. GET answers 405.
 *
 * @version v0.8.0
 */
import type { Route } from "./+types/_auth.admin.media.volumes.$volumeId.publish";
import { tenantContext, userContext } from "../context";

export async function action({ request, context, params }: Route.ActionArgs) {
  const tenant = context.get(tenantContext);
  const user = context.get(userContext);
  const { env } = context.cloudflare;
  const { publishVolumeAction, publishDepsFromEnv } = await import("~/lib/pipeline/publish.server");
  return publishVolumeAction(await publishDepsFromEnv(env, tenant), request, params.volumeId, tenant, user);
}

export async function loader() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

// @version v0.8.0
