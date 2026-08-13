/**
 * Authority ownership — visibility and mutation rights on entities/places
 *
 * This module deals with the one question the authority surfaces ask
 * over and over after migration 0067: which entity and place records may
 * the tenant behind this request SEE, and which of them may it CHANGE.
 *
 * Since the authorities lift (migrations 0045-0048) an authority record
 * belongs to a federation, and every mutation runs through
 * `requireFederationSteward` (`app/lib/federation.server.ts`). Migration
 * 0067 adds a nullable owner one level below that: `entities.tenant_id`
 * and `places.tenant_id`. A record with the column SET is owned by that
 * tenant; a record with it NULL is federation-shared, exactly as before.
 * Sharing became an option rather than the only shape because federations
 * differ in kind — some hold archives that genuinely share people and
 * places, others hold unrelated archives co-located for operational
 * reasons, and the second sort should not have to run private
 * housekeeping through a shared steward.
 *
 * Four responsibilities, in the order a request meets them:
 *
 *   - `authorityScope` builds the VISIBILITY predicate and is the only
 *     place it is written. Every read of `entities` or `places` — list,
 *     detail, typeahead, duplicate worklist, vocabulary count, export —
 *     composes it instead of filtering on `federationId` alone. It reads
 *     `federation_id = <the request tenant's federation> AND (tenant_id
 *     IS NULL OR tenant_id = <the request tenant>)`: the shared space
 *     plus your own, never anyone else's. The owner argument accepts an
 *     ARRAY as well, for the one caller that legitimately spans several
 *     tenants at once (the federation-wide export, which emits every
 *     member tenant's published material in one run).
 *
 *     The federation id and the tenant id are passed EXPLICITLY rather
 *     than derived from a `Tenant` object inside the helper. That is
 *     deliberate: the cross-tenant coverage keystone
 *     (`tests/db/cross-tenant-coverage.test.ts`) scans every authority
 *     statement in the admin surface for a `federationId` reference, and
 *     a helper that swallowed the scope would hide it from that scan.
 *     Passing it through keeps the guard honest and keeps the scope
 *     visible at the call site while the predicate itself lives here.
 *
 *   - `authorityScopeSql` is the same predicate for the handful of
 *     raw-SQL sites (the FTS-joined entity search, the duplicate badge
 *     counts) that cannot compose a Drizzle expression. It takes the
 *     table alias so it can be dropped into an existing WHERE chain.
 *
 *   - `requireAuthorityMutation` is the MUTATION gate, and it replaces
 *     the bare `requireFederationSteward` call that used to open every
 *     authority action. It loads the records the mutation touches and
 *     then decides:
 *
 *       every record owned by the request tenant -> the ordinary tenant
 *         admin check is enough, no steward involved;
 *       any record owned by ANOTHER tenant       -> 404, never a 403 —
 *         a foreign record must not be confirmed to exist;
 *       anything else (all shared, or a mix of shared and owned, or no
 *         such record at all)                    -> `requireFederationSteward`,
 *         unchanged from the 2026-07-08 rule.
 *
 *     The pair rule for merge and split falls straight out of that,
 *     because those callers pass BOTH ids: a merge is free-and-clear only
 *     when every record involved is the request tenant's own. Merging a
 *     tenant-owned record into a shared one changes what the surviving
 *     shared record is, so it needs a steward; merging across two tenants
 *     never gets that far, because the foreign record 404s first.
 *
 *   - `requireAuthorityMint` is the same gate for CREATION, where there
 *     is no record to load yet. What a new record's owner should be is
 *     the federation's own setting (`shared_authorities_enabled`): off
 *     mints tenant-owned, on mints shared. Minting a shared record is a
 *     change to the shared space and keeps the steward gate; minting your
 *     own does not. The function performs the check and RETURNS the owner
 *     to stamp, so a caller cannot accidentally gate on one rule and
 *     stamp by another.
 *
 * Split is the one mutation that both loads and mints. It passes the
 * source record's own owner to the new row rather than re-deriving the
 * federation default: a split preserves what the record already was, so
 * splitting a shared record yields shared records and splitting an owned
 * one yields owned records. `requireAuthorityMutation` on the source
 * already licensed the operation.
 *
 * Nothing here weakens `requireFederationSteward`; it is the branch taken
 * for shared records, which is still every record in every federation
 * until one is explicitly claimed.
 *
 * @version v0.7.0
 */

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { entities, federations, places } from "../db/schema";
import type { Tenant, User } from "../context";

/** The two authority tables that carry an optional owner. */
export type AuthorityTable = typeof entities | typeof places;

/** Record-type discriminator used by the mutation gate and the ledger. */
export type AuthorityRecordType = "entity" | "place";

function tableFor(recordType: AuthorityRecordType): AuthorityTable {
  return recordType === "entity" ? entities : places;
}

/**
 * The authority VISIBILITY predicate: the request tenant's federation,
 * narrowed to the records it may see inside it — the federation-shared
 * ones (`tenant_id IS NULL`) plus its own (`tenant_id = <tenant>`).
 *
 * Compose it wherever a bare `eq(entities.federationId, …)` used to sit:
 *
 *   .where(and(authorityScope(entities, tenant.federationId, tenant.id),
 *              eq(entities.id, id)))
 *
 * `owner` may be a list of tenant ids for a caller that legitimately
 * spans several member tenants in one query (the federation export). An
 * EMPTY list degenerates to "shared records only", which is the correct
 * reading of "no member tenants in scope".
 */
export function authorityScope(
  table: AuthorityTable,
  federationId: string,
  owner: string | readonly string[],
): SQL {
  const ownerArm = Array.isArray(owner)
    ? owner.length > 0
      ? or(isNull(table.tenantId), inArray(table.tenantId, owner as string[]))
      : isNull(table.tenantId)
    : or(isNull(table.tenantId), eq(table.tenantId, owner as string));
  return and(eq(table.federationId, federationId), ownerArm) as SQL;
}

/**
 * The same predicate as a raw SQL fragment, for the query sites that
 * hand-write SQL (the FTS-joined entity search, the duplicate badge
 * counts). `alias` is the table alias used in the surrounding statement
 * — pass the alias, not the table name, when the query aliases it.
 *
 * The fragment is parenthesised, so it drops into an `AND` chain
 * without changing how the surrounding disjunctions bind.
 */
export function authorityScopeSql(
  alias: string,
  federationId: string,
  ownerTenantId: string,
): SQL {
  const col = (name: string) => sql.raw(`${alias}.${name}`);
  return sql`(${col("federation_id")} = ${federationId} AND (${col("tenant_id")} IS NULL OR ${col("tenant_id")} = ${ownerTenantId}))`;
}

/**
 * Resolve the owner a NEW authority record minted by `tenant` should
 * carry: the tenant's own id when its federation keeps authorities
 * private (`shared_authorities_enabled` off, the default), or NULL when
 * the federation shares them.
 *
 * A missing federation row resolves to tenant-owned. That is the safe
 * direction: an unresolvable federation should not silently mint into a
 * shared space.
 */
export async function resolveMintOwner(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
): Promise<string | null> {
  const fed = await db
    .select({ shared: federations.sharedAuthoritiesEnabled })
    .from(federations)
    .where(eq(federations.id, tenant.federationId))
    .get();
  return fed?.shared ? null : tenant.id;
}

/**
 * Gate an authority mutation that touches EXISTING records, and let the
 * records' ownership decide who may perform it.
 *
 * Pass every record the mutation touches: one id for an edit or a
 * delete, both ids for a merge or a split's source pair. The pair rule
 * is a consequence of passing them together — the mutation is
 * tenant-owned only when EVERY record involved belongs to the request
 * tenant.
 *
 *   - any record owned by another tenant -> bare 404. The caller must
 *     not learn that a foreign record exists, so this outranks the other
 *     branches and is checked first.
 *   - every record owned by the request tenant -> the ordinary tenant
 *     admin check (`requireAdmin`), no steward.
 *   - otherwise (all shared, mixed shared/owned, or the ids match
 *     nothing in this federation) -> `requireFederationSteward`,
 *     unchanged.
 *
 * The "matches nothing" case falling through to the steward gate
 * preserves today's behaviour exactly: before 0067 a bad id met the
 * steward gate first and its caller's own not-found handling second.
 */
export async function requireAuthorityMutation(
  db: DrizzleD1Database<any>,
  user: User,
  tenant: Tenant,
  recordType: AuthorityRecordType,
  recordIds: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  const { requireAdmin } = await import("./permissions.server");
  const { requireFederationSteward } = await import("./federation.server");

  const ids = Array.from(
    new Set(recordIds.filter((id): id is string => typeof id === "string" && id.length > 0)),
  );

  const table = tableFor(recordType);
  const rows = ids.length
    ? await db
        .select({ id: table.id, tenantId: table.tenantId })
        .from(table)
        .where(and(eq(table.federationId, tenant.federationId), inArray(table.id, ids)))
        .all()
    : [];

  // Foreign-owned record anywhere in the set: 404 before anything else,
  // so the response is indistinguishable from a record that is not there.
  if (rows.some((r) => r.tenantId !== null && r.tenantId !== tenant.id)) {
    throw new Response("Not found", { status: 404 });
  }

  // Every record involved is this tenant's own: ordinary admin rights.
  if (rows.length > 0 && rows.every((r) => r.tenantId === tenant.id)) {
    requireAdmin(user);
    return;
  }

  // Shared, mixed, or unknown: the shared-authority space rule applies.
  await requireFederationSteward(db, user, tenant);
}

/**
 * Gate the CREATION of an authority record and return the owner to stamp
 * on it (`tenantId`), so the gate and the stamp cannot disagree.
 *
 * A federation that shares its authorities mints into the shared space,
 * which is a steward act. A federation that does not mints the request
 * tenant's own record, which its admins may do freely.
 */
export async function requireAuthorityMint(
  db: DrizzleD1Database<any>,
  user: User,
  tenant: Tenant,
): Promise<string | null> {
  const { requireAdmin } = await import("./permissions.server");
  const { requireFederationSteward } = await import("./federation.server");

  const owner = await resolveMintOwner(db, tenant);
  if (owner === null) {
    await requireFederationSteward(db, user, tenant);
  } else {
    requireAdmin(user);
  }
  return owner;
}
