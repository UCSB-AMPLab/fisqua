/**
 * Carried scopes — a search selection, handed forward.
 *
 * This module owns the stash between the search results page and the
 * export surface: the records a person picked out of a result set, made
 * durable so they survive the navigation and every later search.
 *
 * WHY THE SET, NOT THE QUERY. A carry is a promise about particular
 * records — "these forty-one" — and the export must produce exactly
 * them. Storing the query instead would make the export a moving target
 * (the same question answers differently once anything is catalogued)
 * and would hand the export a second copy of the search's scope rules
 * to get wrong. So the members are resolved HERE, once, and everything
 * downstream reads a list.
 *
 * TWO MODES ARRIVE, ONE SHAPE IS STORED. `ids` mode is the explicit
 * tick list the page built, deduplicated — the count is simply its
 * length. `all` mode is the symbolic whole set, which the page never
 * materialised because it only ever held one page of it; that is
 * materialised here by RE-RUNNING the same scoped, faceted question the
 * results page ran, through the search module's own id enumeration
 * (`selectMatchingIds`). No SQL is written in this file: reusing that
 * read is what guarantees the carried set is the set the person was
 * looking at, tenant scope, exclusions, facets, date bounds and all.
 *
 * The stored `total` is the faceted result total — the number the
 * selection bar was showing — which for a well-formed carry equals the
 * member count. They are stored separately because they answer
 * different questions, and a divergence is worth being able to see.
 *
 * THE CAP IS A DESIGN INTENT, NOT A LIMIT OF THE MACHINERY. A carried
 * scope is a human-scale working set — a finding aid, a handlist, a
 * batch someone will look at. Ten thousand members is far past that and
 * well into "you meant to export the whole fonds", which is a different
 * feature with a different shape. A larger set is refused with a 400
 * that says the number, rather than truncated silently.
 *
 * OWNERSHIP IS THE WHOLE READ GATE. A scope belongs to one person in
 * one workspace, and `getCarriedScope` keys on both: another person's
 * scope, or another tenant's, 404s exactly as a scope that never
 * existed does. There is no shared or federated visibility here and no
 * admin override — an unconsumed selection is nobody else's business.
 *
 * @version v0.7.0
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { carriedScopes } from "../db/schema";
import { selectMatchingIds } from "./global-search.server";
import { hasCapability } from "./tenant";
import type {
  GlobalSearchFacets,
  SearchCategory,
  SearchQueryInput,
  SortSpec,
} from "./global-search.server";
import type { Tenant, User } from "../context";

/**
 * The surfaces a selection can be made on, in the vocabulary the search
 * tabs use — `records` is the descriptions category, because that is
 * the word the interface says to a person.
 */
export const CARRIED_RECORD_TYPES = ["records", "entities", "places"] as const;
export type CarriedRecordType = (typeof CARRIED_RECORD_TYPES)[number];

/** Ceiling on a carried scope's membership; see the header. */
export const CARRIED_SCOPE_MAX_MEMBERS = 10_000;

/** Which search category a carried record type reads from. */
const CATEGORY_FOR: Record<CarriedRecordType, SearchCategory> = {
  records: "descriptions",
  entities: "entities",
  places: "places",
};

/**
 * Enough of the search to ask it again: exactly what the results page
 * handed `runGlobalSearch`, minus the page number. Sort is optional
 * because it does not change the membership — only the order the
 * members are stored in, which is the order the person saw.
 */
export interface CarriedScopeQuery {
  /** The pills query model, the advanced form's rows, or nothing. */
  input: SearchQueryInput;
  /** The active category's facets, date bounds included. */
  facets: GlobalSearchFacets;
  sort?: SortSpec | null;
}

/** One pill, as it read on screen. Display-only. */
export interface CarriedConstraint {
  label: string;
}

export interface StashCarriedScopeInput {
  recordType: CarriedRecordType;
  /** `ids` carries the ticked list; `all` is the whole matching set. */
  mode: "ids" | "all";
  /** The ticked ids — required in `ids` mode, ignored in `all`. */
  ids?: string[];
  /** The pills, for the export page to say what this was chosen under. */
  constraints: CarriedConstraint[];
  query: CarriedScopeQuery;
  /** The browse surface this came from, when there was no query. */
  origin?: string;
  /**
   * The faceted result total at carry time — how many MATCHED, before
   * any unticking. In `ids` mode this is what lets the export page
   * print the honest arithmetic («6 found − 1 unticked → 5 will
   * export») instead of rounding a pruned set to "all matches". In
   * `all` mode it equals the materialised total and may be omitted.
   */
  found?: number;
}

/** A stashed scope as its consumer reads it back. */
export interface CarriedScope {
  id: string;
  recordType: CarriedRecordType;
  /** The pills as they read when the carry was made. Display-only. */
  constraints: CarriedConstraint[];
  /** What will be exported. */
  memberIds: string[];
  /** What the person was told they were taking. */
  total: number;
  /** The faceted total at carry time (≥ total when the set was pruned). */
  found: number;
  /** The browse surface it came from, or null when it came from a query. */
  origin: string | null;
  createdAt: number;
  /** Set when the export surface spends the scope; never set here. */
  consumedAt: number | null;
}

/** The JSON `constraint_summary` holds — display-only, never re-parsed
 *  into query structure. */
interface ConstraintSummary {
  pills: CarriedConstraint[];
  total: number;
  /**
   * Where the selection was made, when it was not made by asking a
   * question — a browse list's own name. It is NOT a pill: pills are
   * query terms, and a set carried off a list has no query to re-run.
   * Keeping the two apart is what lets the export tile say "ticked one
   * by one · no query" honestly while still naming the surface.
   */
  origin?: string;
}

/**
 * Stash a selection and return its id.
 *
 * In `ids` mode the ticked list is taken as given, deduplicated (the
 * page can tick the same row twice across a re-render, and a member
 * counted twice would inflate the promise); the total is its length.
 *
 * In `all` mode the question is asked again — the same scope, the same
 * compiled expression, the same facets and date bounds, one statement,
 * through `selectMatchingIds` — and every matching id is materialised.
 * The total is the faceted result total, which is the number the
 * selection bar had on screen.
 *
 * Either way, a set larger than CARRIED_SCOPE_MAX_MEMBERS is refused
 * with a 400 naming the cap rather than stored short: a carry that
 * silently dropped members would export the wrong thing.
 *
 * The caller has already gated the search itself; what is stamped here
 * is that caller's user and tenant, and those two are the only key the
 * scope can later be read by.
 */
export async function stashCarriedScope(
  db: DrizzleD1Database<any>,
  user: User,
  tenant: Tenant,
  input: StashCarriedScopeInput,
  now: number = Date.now(),
): Promise<string> {
  const { memberIds, total } =
    input.mode === "ids"
      ? tickedMembers(input.ids ?? [])
      : await materialiseMatching(db, tenant, input);

  const id = crypto.randomUUID();
  const summary: ConstraintSummary = {
    pills: input.constraints,
    // The FOUND count, not the ticked count: the summary is the only
    // place the pruning arithmetic's left-hand side survives.
    total: Math.max(input.found ?? total, total),
    ...(input.origin ? { origin: input.origin } : {}),
  };
  await db.insert(carriedScopes).values({
    id,
    tenantId: tenant.id,
    userId: user.id,
    recordType: input.recordType,
    constraintSummary: JSON.stringify(summary),
    memberIds: JSON.stringify(memberIds),
    total,
    createdAt: now,
    consumedAt: null,
  });
  return id;
}

/** The ticked list, deduplicated and checked against the cap. */
function tickedMembers(ids: string[]): { memberIds: string[]; total: number } {
  const memberIds = [...new Set(ids)];
  refuseOversized(memberIds.length);
  return { memberIds, total: memberIds.length };
}

/**
 * The whole matching set, resolved by re-running the results page's own
 * question. The cap is checked against the TOTAL before the ids are
 * trusted, because the enumeration's own limit would otherwise turn an
 * oversized set into a quietly truncated one.
 */
async function materialiseMatching(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  input: StashCarriedScopeInput,
): Promise<{ memberIds: string[]; total: number }> {
  const { total, ids } = await selectMatchingIds(
    db,
    {
      tenantId: tenant.id,
      federationId: tenant.federationId,
      includeAuthorities: hasCapability(tenant, "authorities"),
    },
    input.query.input,
    {
      category: CATEGORY_FOR[input.recordType],
      facets: input.query.facets,
      sort: input.query.sort ?? null,
      // One past the cap: enough to see that the set is too large even
      // if the count and the rows ever disagreed, and never more.
      limit: CARRIED_SCOPE_MAX_MEMBERS + 1,
    },
  );
  refuseOversized(Math.max(total, ids.length));
  return { memberIds: ids, total };
}

/** The cap, stated in the refusal so the number is not a mystery. */
function refuseOversized(count: number): void {
  if (count > CARRIED_SCOPE_MAX_MEMBERS) {
    throw new Response(
      `A carried scope holds at most ${CARRIED_SCOPE_MAX_MEMBERS} records; this selection has ${count}. Narrow the search before sending it to export.`,
      { status: 400 },
    );
  }
}

/**
 * Read a stashed scope back. Owner-only: the tenant and the user are
 * both part of the key, so a scope belonging to someone else, or to
 * another workspace, is indistinguishable from one that was never
 * created — all three are the same 404.
 */
export async function getCarriedScope(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  id: string,
): Promise<CarriedScope> {
  const row = await db
    .select()
    .from(carriedScopes)
    .where(
      and(
        eq(carriedScopes.id, id),
        eq(carriedScopes.tenantId, tenant.id),
        eq(carriedScopes.userId, user.id),
      ),
    )
    .get();
  if (!row) {
    throw new Response("Not found", { status: 404 });
  }
  const summary = parseSummary(row.constraintSummary);
  return {
    id: row.id,
    recordType: row.recordType,
    constraints: summary.pills,
    memberIds: parseMemberIds(row.memberIds),
    total: row.total,
    // Stashes from before the summary carried the found count read
    // back found === total — honestly "nothing known to be pruned".
    found: Math.max(summary.total ?? row.total, row.total),
    origin: summary.origin ?? null,
    createdAt: row.createdAt,
    consumedAt: row.consumedAt,
  };
}

/** A stash as the export page's recent-searches list reads it. */
export interface RecentCarriedScope {
  id: string;
  recordType: CarriedRecordType;
  /** The pills as they read when the carry was made. Display-only. */
  pills: CarriedConstraint[];
  /** What the person was told they were taking. */
  total: number;
  createdAt: number;
}

/**
 * The stashes this person has made and not yet spent, newest first —
 * the list the export page offers when the carried door is chosen with
 * an empty hand.
 *
 * UNCONSUMED IS THE WHOLE FILTER. A scope is spent when a run starts
 * from it, so an unspent one is a selection still waiting to be used
 * and a spent one is a run that already happened and lives in the
 * export history instead. Offering a spent scope back would invite the
 * same export twice under the pretence of being a fresh choice.
 *
 * Owner-scoped in the same statement as the tenant, exactly as
 * `getCarriedScope` is: an unconsumed selection is nobody else's
 * business, and the list must not become the read that says otherwise.
 * The member ids are deliberately NOT read — the list shows what a
 * search was and how much it found, and materialising ten thousand
 * ids per row to print a count would be a page's worth of work for a
 * number the row already carries.
 */
export async function listRecentCarriedScopes(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  limit = 6,
): Promise<RecentCarriedScope[]> {
  const rows = await db
    .select({
      id: carriedScopes.id,
      recordType: carriedScopes.recordType,
      constraintSummary: carriedScopes.constraintSummary,
      total: carriedScopes.total,
      createdAt: carriedScopes.createdAt,
    })
    .from(carriedScopes)
    .where(
      and(
        eq(carriedScopes.tenantId, tenant.id),
        eq(carriedScopes.userId, user.id),
        isNull(carriedScopes.consumedAt),
      ),
    )
    .orderBy(desc(carriedScopes.createdAt))
    .limit(limit)
    .all();

  return rows.map((row) => ({
    id: row.id,
    recordType: row.recordType,
    pills: parseSummary(row.constraintSummary).pills,
    total: row.total,
    createdAt: row.createdAt,
  }));
}

/**
 * The stored JSON, read defensively. These two columns are written by
 * this module alone, so malformed content means a bad migration or a
 * hand-edited row — neither of which should take the export page down
 * with a parse error where an empty summary will do.
 */
function parseSummary(raw: string): ConstraintSummary {
  try {
    const parsed = JSON.parse(raw) as Partial<ConstraintSummary>;
    return {
      pills: Array.isArray(parsed?.pills) ? parsed.pills : [],
      total: typeof parsed?.total === "number" ? parsed.total : 0,
      ...(typeof parsed?.origin === "string" && parsed.origin
        ? { origin: parsed.origin }
        : {}),
    };
  } catch {
    return { pills: [], total: 0 };
  }
}

function parseMemberIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
