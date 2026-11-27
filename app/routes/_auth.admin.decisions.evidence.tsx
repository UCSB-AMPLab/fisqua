/**
 * Pending Decisions — the descriptions a duplicate pair's merge may cite
 *
 * This loader-only resource route gives the merge dialog on a duplicates
 * card the descriptions its evidence panel offers, for the two records
 * of one pair (`?a=<entity id>&b=<entity id>`). The duplicates page
 * already scans every record of the federation on each load, so it does
 * not read these as well: the dialog loads them through a fetcher when
 * it opens, and React Router loads them again after a ruling is
 * submitted, so a citation whose link has gone is pruned from the open
 * dialog.
 *
 * Gating is the duplicates page's: the authorities area and the
 * `authorities` capability. The pair is two distinct records that exist,
 * are in the acting tenant's visible scope and are not merged away;
 * anything else is answered 404, and nothing else is read. A pair that
 * has gone (a record merged away, out of scope or missing) is answered
 * with `{ a, b, gone: true }` and status 404, returned rather than thrown:
 * React Router reloads the dialog's fetcher after each ruling, the
 * pair's own merge among them, and a returned 404 reaches the fetcher as
 * data, where a thrown one would reach the page's error boundary. Only
 * the acting tenant's descriptions are listed
 * (`loadEvidenceDescriptions`, in the pair page's order, retried as the
 * app's other reads are when D1 refuses it as overloaded). The answer is
 * JSON, `{ a, b, descriptions: { [entityId]: [...] } }`; POST answers 405.
 *
 * @version v0.9.0
 */
import type { Route } from "./+types/_auth.admin.decisions.evidence";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { requireAreaWork } = await import("~/lib/user-access.server");
  const { authorityScope } = await import("~/lib/authority-ownership.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, inArray, isNull } = await import("drizzle-orm");
  const { entities } = await import("~/db/schema");
  const { loadEvidenceDescriptions } = await import("~/lib/merge-evidence.server");

  const user = context.get(userContext);
  requireAreaWork(user, "authorities");
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");
  const db = drizzle(context.cloudflare.env.DB);

  const search = new URL(request.url).searchParams;
  const a = (search.get("a") ?? "").trim();
  const b = (search.get("b") ?? "").trim();
  if (!a || !b || a === b) throw new Response("Not found", { status: 404 });

  // Both records exist, are in the tenant's visible scope and are not merged away, or the pair is not found.
  const live = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(authorityScope(entities, tenant.federationId, tenant.id), inArray(entities.id, [a, b]), isNull(entities.mergedInto)))
    .all();
  // Returned, not thrown: the dialog's fetcher is reloaded after the pair's own merge,
  // and a thrown 404 would put the whole duplicates page behind the error boundary.
  if (live.length !== 2) return Response.json({ a, b, gone: true }, { status: 404 });
  const descriptions = await loadEvidenceDescriptions(db, tenant.id, [a, b], {
    site: { read: "evidence_descriptions", request, context },
  });
  return Response.json({ a, b, descriptions });
}

export async function action() {
  return new Response(null, { status: 405, headers: { Allow: "GET" } });
}

// @version v0.9.0
