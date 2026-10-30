/**
 * Media Pipeline — Start Run
 *
 * This action-only resource route starts a media pipeline run. It has
 * no page of its own; the runs screen will post to it. The auth layout
 * has already resolved the session, the tenant and the user, so the
 * route only gathers its dependencies and hands the request to
 * `startRunAction`, which applies the capability and federation-lead
 * gate (a bare 404 or 403), validates the JSON body, starts the run and
 * answers with its id and chunk count, or with a refusal code and 400.
 *
 * The spec store is built only when the run first writes through it,
 * so a missing setting is reported as a refusal rather than an error.
 * The run limits and recipe presets come from `DEFAULT_RUN_CONFIG`. The
 * run's destination and its manifest ids come from the tenant's storage
 * destination, its federation's record under its slug; a tenant without
 * a complete one is refused with `tenant_destination_unset`. The
 * manifest inputs come from `manifestResolver`, built for the tenant's
 * manifest address (`{manifest_base_url}/{slug}`); a
 * refusal it raises, such as a repository without rights, answers with
 * its code and the repository it names. GET answers 405.
 *
 * @version v0.8.0
 */
import type { Route } from "./+types/_auth.admin.media.runs.start";
import { tenantContext, userContext } from "../context";

export async function action({ request, context }: Route.ActionArgs) {
  const tenant = context.get(tenantContext);
  const user = context.get(userContext);
  const { env } = context.cloudflare;
  const { drizzle } = await import("drizzle-orm/d1");
  const { startRunAction, DEFAULT_RUN_CONFIG } = await import("~/lib/pipeline/dispatch.server");
  const { getPipelineSpecStore } = await import("~/lib/pipeline/store.server");
  const { manifestResolver } = await import("~/lib/pipeline/manifest-inputs");
  return startRunAction(
    {
      db: drizzle(env.DB),
      env,
      specStore: {
        putSpec: (key, json) => getPipelineSpecStore(env).putSpec(key, json),
        presignGet: (key, expiresAt, now) => getPipelineSpecStore(env).presignGet(key, expiresAt, now),
      },
      fetchImpl: (input, init) => fetch(input, init),
      manifestResolverFor: manifestResolver,
      config: DEFAULT_RUN_CONFIG,
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
    },
    request,
    tenant,
    user,
  );
}

export async function loader() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

// @version v0.8.0
