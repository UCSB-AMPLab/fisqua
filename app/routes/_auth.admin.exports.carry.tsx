/**
 * Carry a list selection to the export page
 *
 * The browse surfaces — the descriptions list, the entities and places
 * lists — grow the same two bulk errands the search page carries: put
 * these in a handlist, or take these to export. The handlist half
 * already has its own resource route; this is the export half.
 *
 * WHY A ROUTE OF ITS OWN. The search page stashes its carried scope
 * inside its own action, because it holds the query that a "select all
 * matching" would have to re-run. A list has no query to re-run: it
 * hands over the ids it actually holds, and nothing else. So the carry
 * is the same stash in `ids` mode, and the three list surfaces share
 * one endpoint rather than each growing a near-identical action.
 *
 * WHAT IT ANSWERS. A redirect to `/admin/exports?scope=<id>`, exactly
 * as the search page's own "Send to export" does — the export surface
 * cannot tell the two doors apart, and should not: what arrived is a
 * set of records somebody chose, which is what the carried tile says
 * either way.
 *
 * THE LABEL is the caller's own words for where the selection was
 * made ("Descriptions", "Entities · Person"), stored as the scope's
 * single constraint pill. It is display-only and never re-parsed —
 * the same contract the search page's pills keep.
 *
 * @version v0.7.0
 */

import { redirect } from "react-router";
import { tenantContext, userContext } from "../context";
import type { Route } from "./+types/_auth.admin.exports.carry";

/** The kinds a list can carry, in the vocabulary the stash uses. */
const CARRY_TYPES = ["records", "entities", "places"] as const;
type CarryType = (typeof CARRY_TYPES)[number];

function readCarryType(value: FormDataEntryValue | null): CarryType | null {
  return typeof value === "string" &&
    (CARRY_TYPES as readonly string[]).includes(value)
    ? (value as CarryType)
    : null;
}

/**
 * The ids travel as one JSON array rather than as repeated fields, for
 * the reason the handlist route gives: an explicit array is easier to
 * reason about than a `getAll` whose ordering is the browser's
 * business.
 */
function readMemberIds(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (id): id is string => typeof id === "string" && id !== "",
    );
  } catch {
    return [];
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { stashCarriedScope } = await import("~/lib/carried-scopes.server");
  const { parseSearch } = await import("~/lib/search-query");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const db = drizzle(context.cloudflare.env.DB);

  const formData = await request.formData();
  const recordType = readCarryType(formData.get("recordType"));
  const memberIds = readMemberIds(formData.get("memberIds"));
  const label = ((formData.get("label") as string) || "").trim();

  if (recordType === null || memberIds.length === 0) {
    throw new Response("Nothing to carry", { status: 400 });
  }

  // `ids` mode never re-runs the query, so the stash is handed the
  // empty one rather than a fabricated query that would claim this
  // selection came from a search it did not. The surface's name rides
  // as `origin`, NOT as a constraint pill: a pill is a query term, and
  // the export tile reads "has pills" as "came from a question" — a
  // list carry has no question, and must be able to say so.
  const scopeId = await stashCarriedScope(db, user, tenant, {
    recordType,
    mode: "ids",
    ids: memberIds,
    constraints: [],
    origin: label || undefined,
    query: { input: parseSearch([]), facets: {} },
    // Nothing was pruned from a wider result set: what was ticked is
    // the whole of what was found, so the export tile states a plain
    // count rather than an arithmetic it has no left-hand side for.
    found: memberIds.length,
  });

  return redirect(`/admin/exports?scope=${scopeId}`);
}

/* @version v0.7.0 */
