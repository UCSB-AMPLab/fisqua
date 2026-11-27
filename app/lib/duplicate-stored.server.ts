/**
 * Stored duplicate pairs — what the possible-duplicates page reads
 *
 * This module deals with what the possible-duplicates page reads: the rows
 * the scheduled recheck keeps in `duplicate_candidates`, one per candidate
 * pair of entity records, with the facts that support the pair stored as
 * JSON. The page reads those rows rather than scanning the federation;
 * this module reads them for the acting workspace and prepares them for
 * the card.
 *
 *   - `readStoredPairs` — reads the workspace's rows in weight order,
 *     500 at a time, drops the pairs in the dismissed set, reads the two
 *     records of each remaining pair by id (live, and visible to the
 *     workspace), and stops when `max` pairs remain or the rows run out.
 *     A row whose record has been merged away or is not visible is
 *     skipped, since the job removes it on its next run. `total` is the
 *     workspace's row count minus the dismissed keys found among the
 *     rows, so a pair dismissed after it was stored is not counted.
 *   - `resolveFacts` — names in stored facts go stale when an associate
 *     or a place is renamed or a description retitled. For the visible
 *     pairs only, this reads the associates' names and codes, the
 *     places' names and the documents' titles from the stored ids, in
 *     statements of at most 500 ids each, and shows the current name,
 *     code and title in place of the stored text. An id that no longer
 *     resolves is dropped: an associate or a place that is gone, merged
 *     away or not visible to the workspace (`authorityScope`), and a
 *     document that is gone or belongs to another workspace, leaves the
 *     list, so the card never links to a missing page or shows a name
 *     the workspace may not see. The stored text is never shown.
 *
 * Ids travel as one JSON parameter per statement (`json_each`), which
 * keeps every statement under D1's bound-parameter limit.
 *
 * @version v0.9.0
 */

import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { descriptions, duplicateCandidates, entities, places } from "~/db/schema";
import { authorityScope } from "./authority-ownership.server";
import type { PairFacts } from "./duplicate-facts";
import { retryD1Read, type D1Site } from "./d1-overload";

/** Rows read per page of stored pairs. */
const PAGE = 500;

/** Ids per statement. */
const ID_CHUNK = 500;

export interface StoredEntityRecord {
  id: string;
  name: string;
  code: string | null;
  entityType: "person" | "family" | "corporate";
  sources: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  dates: string | null;
}

export interface StoredPair {
  key: string;
  idA: string;
  idB: string;
  facts: PairFacts;
}

interface Scope {
  id: string;
  federationId: string;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function jsonList(values: readonly string[]): SQL {
  return sql`(SELECT value FROM json_each(${JSON.stringify(values)}))`;
}

/** The entity records of `ids` that are live and visible to the workspace. */
async function readRecords(
  db: DrizzleD1Database<any>,
  tenant: Scope,
  ids: readonly string[],
): Promise<Map<string, StoredEntityRecord>> {
  const out = new Map<string, StoredEntityRecord>();
  for (const part of chunks([...new Set(ids)], ID_CHUNK)) {
    const rows = await db
      .select({
        id: entities.id,
        name: entities.displayName,
        code: entities.entityCode,
        entityType: entities.entityType,
        sources: entities.sources,
        dateStart: entities.dateStart,
        dateEnd: entities.dateEnd,
        dates: entities.datesOfExistence,
      })
      .from(entities)
      .where(
        and(
          authorityScope(entities, tenant.federationId, tenant.id),
          isNull(entities.mergedInto),
          inArray(entities.id, jsonList(part)),
        ),
      )
      .all();
    for (const r of rows) out.set(r.id, r as StoredEntityRecord);
  }
  return out;
}

/**
 * How many of the dismissed pairs are among the workspace's stored rows.
 * Each statement is retried while D1 refuses it as overloaded
 * (`retryD1Read`), logged under `site`'s name.
 */
export async function countDismissedStored(
  db: DrizzleD1Database<any>,
  tenantId: string,
  dismissed: ReadonlySet<string>,
  site: D1Site = { read: "dismissed_stored_pairs" },
): Promise<number> {
  const pairs = [...dismissed].map((k) => k.split("|"));
  let n = 0;
  for (const part of chunks(pairs, ID_CHUNK)) {
    const row = (await retryD1Read(
      () =>
        db.get(sql`
      SELECT count(*) AS n
      FROM json_each(${JSON.stringify(part)}) j
      JOIN duplicate_candidates c
        ON c.tenant_id = ${tenantId}
       AND c.id_a = json_extract(j.value, '$[0]')
       AND c.id_b = json_extract(j.value, '$[1]')
    `),
      undefined,
      undefined,
      site,
    )) as { n: number } | undefined;
    n += row?.n ?? 0;
  }
  return n;
}

export async function readStoredPairs(
  db: DrizzleD1Database<any>,
  tenant: Scope,
  dismissed: ReadonlySet<string>,
  max: number,
): Promise<{ pairs: StoredPair[]; records: Map<string, StoredEntityRecord>; total: number }> {
  const countRow = await db
    .select({ n: sql<number>`count(*)` })
    .from(duplicateCandidates)
    .where(eq(duplicateCandidates.tenantId, tenant.id))
    .get();
  const total = Math.max(0, (countRow?.n ?? 0) - (await countDismissedStored(db, tenant.id, dismissed)));

  const pairs: StoredPair[] = [];
  const records = new Map<string, StoredEntityRecord>();
  for (let offset = 0; pairs.length < max; offset += PAGE) {
    const page = await db
      .select({
        idA: duplicateCandidates.idA,
        idB: duplicateCandidates.idB,
        facts: duplicateCandidates.facts,
      })
      .from(duplicateCandidates)
      .where(eq(duplicateCandidates.tenantId, tenant.id))
      .orderBy(sql`${duplicateCandidates.weight} DESC`, duplicateCandidates.idA, duplicateCandidates.idB)
      .limit(PAGE)
      .offset(offset)
      .all();
    if (page.length === 0) break;

    const open = page.filter((r) => !dismissed.has(`${r.idA}|${r.idB}`));
    const found = await readRecords(
      db,
      tenant,
      open.flatMap((r) => [r.idA, r.idB]),
    );
    for (const r of open) {
      if (pairs.length >= max) break;
      const a = found.get(r.idA);
      const b = found.get(r.idB);
      if (!a || !b) continue;
      records.set(a.id, a);
      records.set(b.id, b);
      pairs.push({
        key: `${r.idA}|${r.idB}`,
        idA: r.idA,
        idB: r.idB,
        facts: JSON.parse(r.facts) as PairFacts,
      });
    }
    if (page.length < PAGE) break;
  }
  return { pairs, records, total };
}

/**
 * The facts with current names. `more` is the stored count, unchanged:
 * a dropped item does not promote one from the remainder.
 */
export async function resolveFacts(
  db: DrizzleD1Database<any>,
  tenant: Scope,
  facts: readonly PairFacts[],
): Promise<PairFacts[]> {
  const associateIds = [...new Set(facts.flatMap((f) => f.associates.map((a) => a.id)))];
  const documentIds = [...new Set(facts.flatMap((f) => f.documents.map((d) => d.id)))];
  const placeIds = [...new Set(facts.flatMap((f) => f.places.map((p) => p.id)))];

  const associates = new Map<string, { name: string; code: string | null }>();
  for (const part of chunks(associateIds, ID_CHUNK)) {
    const rows = await db
      .select({ id: entities.id, name: entities.displayName, code: entities.entityCode })
      .from(entities)
      .where(
        and(
          authorityScope(entities, tenant.federationId, tenant.id),
          isNull(entities.mergedInto),
          inArray(entities.id, jsonList(part)),
        ),
      )
      .all();
    for (const r of rows) associates.set(r.id, { name: r.name, code: r.code });
  }

  const documents = new Map<string, string>();
  for (const part of chunks(documentIds, ID_CHUNK)) {
    const rows = await db
      .select({ id: descriptions.id, title: descriptions.title })
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, tenant.id), inArray(descriptions.id, jsonList(part))))
      .all();
    for (const r of rows) documents.set(r.id, r.title);
  }

  const placeNames = new Map<string, string>();
  for (const part of chunks(placeIds, ID_CHUNK)) {
    const rows = await db
      .select({ id: places.id, name: places.displayName })
      .from(places)
      .where(
        and(
          authorityScope(places, tenant.federationId, tenant.id),
          isNull(places.mergedInto),
          inArray(places.id, jsonList(part)),
        ),
      )
      .all();
    for (const r of rows) placeNames.set(r.id, r.name);
  }

  return facts.map((f) => ({
    ...f,
    associates: f.associates.flatMap((a) => {
      const now = associates.get(a.id);
      return now ? [{ id: a.id, name: now.name, code: now.code }] : [];
    }),
    documents: f.documents.flatMap((d) => {
      const title = documents.get(d.id);
      return title === undefined ? [] : [{ id: d.id, title }];
    }),
    places: f.places.flatMap((p) => {
      const name = placeNames.get(p.id);
      return name === undefined ? [] : [{ id: p.id, name }];
    }),
  }));
}

// @version v0.9.0
