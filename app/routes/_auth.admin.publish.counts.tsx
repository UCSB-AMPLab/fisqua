/**
 * Publish Pre-flight Counts — resource route
 *
 * This loader-only route serves the publish page's changelog: what a
 * run would add, modify or unpublish for every fonds, and how many
 * repositories, entities and places have changed since the last
 * completed export. The counts take several seconds on the federation
 * lead, so the publish page renders without them and fetches this
 * route once it has mounted, showing a progress notice meanwhile.
 *
 * A resource route rather than a deferred loader promise: React
 * Router aborts an unsettled deferred promise after the entry's
 * `streamTimeout` (4.95 s when the entry exports none), shorter than
 * these counts take on production. The page fetches this route with a
 * plain `fetch` rather than a fetcher, because a failed fetcher load
 * renders the route's error boundary in place of the page, and the
 * publish form must stay usable when the counts fail.
 *
 * The gates are the page's, in the same order: the `publish_pipeline`
 * capability first (404 for everyone when it is off), then superadmin
 * only (403 here, since nothing renders a notice for a fetch). The
 * export scope comes from `resolveExportScope`, so on the federation
 * lead the counts span every member tenant. The queries themselves
 * live in `getPublishChangelog`. The response is
 * `{ ok: true, changelog }`, or `{ ok: false }` with status 500 when
 * the counts fail; the error goes to the Worker log.
 *
 * @version v0.9.0
 */

import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import type { Route } from "./+types/_auth.admin.publish.counts";

export async function loader({ context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "publish_pipeline");

  if (!user.isSuperAdmin) {
    throw new Response(null, { status: 403 });
  }

  // Same invariant as the page loader: a tenant row with no
  // descriptive standard cannot publish.
  if (!tenant.descriptiveStandard) {
    throw new Error(
      `Tenant ${tenant.slug} has no descriptive_standard (kind=platform tenants cannot publish)`
    );
  }

  const { drizzle } = await import("drizzle-orm/d1");
  const { resolveExportScope } = await import(
    "../lib/export/federation-scope.server"
  );
  const { getPublishChangelog } = await import(
    "~/lib/export/publish-changelog.server"
  );

  const db = drizzle(context.cloudflare.env.DB);

  try {
    const scope = await resolveExportScope(db, {
      id: tenant.id,
      federationId: tenant.federationId,
      slug: tenant.slug,
      descriptiveStandard: tenant.descriptiveStandard,
    });
    const changelog = await getPublishChangelog(db, {
      publishTenantId: tenant.id,
      memberTenantIds: scope.memberTenantIds,
      federationId: tenant.federationId,
      authoritiesEnabled: tenant.authoritiesEnabled,
    });
    return Response.json({ ok: true, changelog });
  } catch (error) {
    console.error("publish counts failed", error);
    return Response.json({ ok: false }, { status: 500 });
  }
}
