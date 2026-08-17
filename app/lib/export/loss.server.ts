/**
 * What a crosswalk costs — dropped, merged, flattened, with real counts
 *
 * This module deals with the one question the export surface asks
 * before it lets a lossy choice through: not "may data be lost" but
 * WHICH FIELDS, on HOW MANY RECORDS, in THIS scope. The choice-cost
 * card is explicit that the difference matters — «"Some data may be
 * lost" is not a warning, it is an apology» — so nothing here returns a
 * boolean or a severity. It returns fields and numbers, or it returns
 * null because there is nothing to say.
 *
 * THREE HARMS, NAMED SEPARATELY, because they are not the same harm.
 * DROPPED is absence: the field has no element in the target form and
 * simply will not appear. MERGED is ambiguity, and the card calls it
 * the most dangerous of the three, «because the file looks complete» —
 * two fields become one paragraph and no reader downstream can tell
 * which sentence came from where. FLATTENED is the loss of structure:
 * the records arrive, but nothing in the file says one sits inside
 * another. Collapsing them into a single "loss" count would tell a
 * cataloguer the least useful version of what is about to happen.
 *
 * EVERY NAME HERE IS A MACHINE CODE. `field` is the schema's own column
 * name — `arrangement`, `provenance`, `acquisitionInfo` — and `into` is
 * the Dublin Core element the pair lands in. The surface maps them to
 * the card's sentences in the reader's own language; this module holds
 * no English a person reads, so a copy change never touches it and a
 * code is never renamed once a locale bundle keys on it.
 *
 * WHAT IS COUNTED, AND HOW MUCH IT COSTS. All the per-field counts for
 * one chunk of the scope are ONE grouped statement — a dozen `sum(case
 * when …)` expressions over the same rows — rather than a read per
 * field or, worse, per record. The scope's id list is chunked at
 * `ID_CHUNK` because D1 caps bound parameters, and the tenant predicate
 * rides in the same statement as the id list, so a lost predicate is a
 * visible deletion rather than a silent widening (the keystone
 * discipline; it self-extends).
 *
 * THE DUBLIN CORE CASE IS THE CARD'S CASE. Its dropped set is the three
 * fields the card names — arrangement, custodial history (`provenance`)
 * and immediate source of acquisition (`acquisitionInfo`) — filtered to
 * the ones the workspace's own standard actually has, so an ISAD(G)
 * workspace is not warned about a column its form never offered. Dublin
 * Core drops more than three fields in truth; these are the three the
 * surface has copy for, and a report that named fields the page cannot
 * explain would be a worse report, not a more honest one. The merges
 * are the card's two pairs, on the same filter.
 *
 * THE STANDARD-TO-STANDARD CASE IS COMPUTED, NOT LISTED. ISAD(G), DACS
 * and RAD are three projections of one union schema, and
 * `allowedTargetFields` already states which columns each one carries,
 * so the dropped set is a set difference — no second table of mappings
 * to keep in step. Those crosswalks MERGE nothing (a column either
 * appears in the target projection or it does not) and FLATTEN nothing
 * (all three standards are hierarchical), so both come back empty. The
 * card draws only the Dublin Core case; this one is honest and cheap,
 * and the surface renders it with the same three blocks.
 *
 * @version v0.7.0
 */

import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { descriptions } from "../../db/schema";
import { allowedTargetFields } from "../import/target-fields";
import type { Standard } from "../standards/types";
import type { Tenant } from "../../context";
import type { ExportForm } from "./matrix";
import { isDescriptiveStandardForm } from "./matrix";
import { ID_CHUNK } from "./scopes.server";

/**
 * A field with no element in the target form, and how many records in
 * this scope actually carry it. A field nothing carries is not reported
 * — a warning about an empty column is noise.
 */
export interface CrosswalkDropped {
  field: string;
  count: number;
}

/** Two or more fields that land in one element, and how many records hold more than one. */
export interface CrosswalkMerged {
  fields: string[];
  into: string;
  count: number;
}

/** What the hierarchy was, for a form that cannot say there was one. */
export interface CrosswalkFlattened {
  belowTop: number;
  series: number;
  collections: number;
}

export interface CrosswalkLoss {
  dropped: CrosswalkDropped[];
  merged: CrosswalkMerged[];
  flattened: CrosswalkFlattened | null;
}

/**
 * The three fields the choice-cost card names as dropped by Dublin
 * Core, as schema column names: arrangement, custodial history, and
 * immediate source of acquisition.
 */
export const DC_DROPPED_FIELDS = ["arrangement", "provenance", "acquisitionInfo"] as const;

/**
 * The card's two merges. Both are real: the Dublin Core crosswalk
 * (`dc/crosswalk.ts`, the `workspace-export` reading) joins exactly
 * these pairs into exactly these elements, so the warning and the
 * behaviour cannot drift apart.
 */
export const DC_MERGED_GROUPS: ReadonlyArray<{ fields: string[]; into: string }> = [
  { fields: ["scopeContent", "adminBiogHistory"], into: "dc:description" },
  { fields: ["accessConditions", "reproductionConditions"], into: "dc:rights" },
];

/** Levels that count as a series when naming what a flattened set sat in. */
const SERIES_LEVELS = ["series", "subseries"];

/** Levels that count as a collection, on the same reading. */
const COLLECTION_LEVELS = ["fonds", "collection"];

/** How far up the tree the container walk climbs before it stops trusting it. */
const MAX_ANCESTOR_WALK = 24;

function chunk<T>(items: readonly T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The `descriptions` column behind a field code, or null when the code
 * names something the table does not have. `allowedTargetFields`
 * carries structural pseudo-columns the import template needs (`parent`
 * above all), and those are not countable.
 */
const DESCRIPTION_COLUMNS = getTableColumns(descriptions) as Record<
  string,
  SQLiteColumn | undefined
>;

function columnFor(field: string): SQLiteColumn | null {
  return DESCRIPTION_COLUMNS[field] ?? null;
}

/** Field codes that name a real, countable column on `descriptions`. */
function countableFields(fields: readonly string[]): string[] {
  return fields.filter((field) => columnFor(field) !== null);
}

/**
 * "Carries this field" means a value that is neither null nor
 * whitespace. A column holding an empty string is a column a cataloguer
 * never filled, and counting it would inflate every warning on the
 * page.
 */
function carriesExpression(field: string): SQL<number> {
  const column = columnFor(field);
  return sql<number>`sum(case when ${column} is not null and trim(${column}) != '' then 1 else 0 end)`;
}

/** Records holding at least two of a merged group — the ambiguous ones. */
function mergeExpression(fields: string[]): SQL<number> {
  const terms = fields.map(
    (field) => sql`(case when ${columnFor(field)} is not null and trim(${columnFor(field)}) != '' then 1 else 0 end)`,
  );
  const total = sql.join(terms, sql` + `);
  return sql<number>`sum(case when (${total}) >= 2 then 1 else 0 end)`;
}

/**
 * Crosswalk loss for a scope, or null when there is none to state.
 *
 * Null means LOSSLESS, and there are three ways to be lossless: the
 * chosen form is the workspace's own standard, the chosen form is the
 * canonical shape (which is the union schema itself), or the scope
 * holds nothing. Null is also what an authority scope gets, because the
 * fields counted here are description columns and the card's warning is
 * a warning about descriptions.
 *
 * @param memberIds The scope's resolved members, in any order. Only
 *                  description ids are meaningful; an authority scope's
 *                  members are ignored (see above).
 */
export async function computeCrosswalkLoss(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  memberIds: string[],
  form: ExportForm,
  ownStandard: Standard,
): Promise<CrosswalkLoss | null> {
  if (memberIds.length === 0) return null;
  if (form === "canonical" || form === ownStandard) return null;

  const ownFields = allowedTargetFields(ownStandard);

  const droppedFields =
    form === "dc"
      ? countableFields(DC_DROPPED_FIELDS.filter((f) => ownFields.includes(f)))
      : countableFields(
          ownFields.filter((f) => !allowedTargetFields(form as Standard).includes(f)),
        );

  const mergedGroups =
    form === "dc"
      ? DC_MERGED_GROUPS.map((group) => ({
          into: group.into,
          fields: countableFields(group.fields.filter((f) => ownFields.includes(f))),
        })).filter((group) => group.fields.length >= 2)
      : [];

  const counts = await countCarriers(db, tenant, memberIds, droppedFields, mergedGroups);

  const dropped = droppedFields
    .map((field) => ({ field, count: counts.dropped.get(field) ?? 0 }))
    .filter((entry) => entry.count > 0);

  const merged = mergedGroups
    .map((group) => ({
      fields: group.fields,
      into: group.into,
      count: counts.merged.get(group.into) ?? 0,
    }))
    .filter((entry) => entry.count > 0);

  // Only Dublin Core flattens. The other two descriptive standards
  // express hierarchy as well as this one does, so a crosswalk between
  // them loses fields and nothing else.
  const flattened =
    form === "dc" && counts.belowTop > 0
      ? {
          belowTop: counts.belowTop,
          ...(await countContainers(db, tenant, memberIds)),
        }
      : null;

  if (dropped.length === 0 && merged.length === 0 && flattened === null) return null;
  return { dropped, merged, flattened };
}

/**
 * One grouped statement per chunk: every dropped field's carriers,
 * every merged group's ambiguous records, and how many members sit
 * below the top of the hierarchy — all aggregates over the same rows,
 * so they are one read rather than a dozen.
 */
async function countCarriers(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  memberIds: string[],
  droppedFields: string[],
  mergedGroups: ReadonlyArray<{ fields: string[]; into: string }>,
): Promise<{ dropped: Map<string, number>; merged: Map<string, number>; belowTop: number }> {
  const dropped = new Map<string, number>();
  const merged = new Map<string, number>();
  let belowTop = 0;

  // Aliases rather than the codes themselves: `into` values carry a
  // colon and a field code could collide with the structural key.
  const selection: Record<string, SQL<number>> = {
    belowTop: sql<number>`sum(case when ${descriptions.parentId} is not null then 1 else 0 end)`,
  };
  droppedFields.forEach((field, i) => {
    selection[`d${i}`] = carriesExpression(field);
  });
  mergedGroups.forEach((group, i) => {
    selection[`m${i}`] = mergeExpression(group.fields);
  });

  for (const part of chunk(memberIds)) {
    const row = await db
      .select(selection)
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, tenant.id), inArray(descriptions.id, part)))
      .get();
    if (!row) continue;
    const values = row as unknown as Record<string, number | null>;
    belowTop += Number(values.belowTop ?? 0);
    droppedFields.forEach((field, i) => {
      dropped.set(field, (dropped.get(field) ?? 0) + Number(values[`d${i}`] ?? 0));
    });
    mergedGroups.forEach((group, i) => {
      merged.set(group.into, (merged.get(group.into) ?? 0) + Number(values[`m${i}`] ?? 0));
    });
  }

  return { dropped, merged, belowTop };
}

/**
 * The containers the scope's records sit in — «47 series across 6
 * collections». Walked upwards a level at a time from the members'
 * parents, deduplicating as it climbs, because the containers are
 * usually NOT in the scope: a search result names a thousand items and
 * not one of the series that hold them.
 *
 * The frontier shrinks fast (a thousand records have a few dozen
 * distinct parents, which have a handful of distinct grandparents), so
 * the walk costs a few statements rather than one per record. It is
 * bounded twice over: by `MAX_ANCESTOR_WALK` levels and by the seen
 * set, so a cyclic parent link cannot spin.
 */
async function countContainers(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  memberIds: string[],
): Promise<{ series: number; collections: number }> {
  const seen = new Set<string>();
  const series = new Set<string>();
  const collections = new Set<string>();

  let frontier = await readParentIds(db, tenant, memberIds);

  for (let depth = 0; depth < MAX_ANCESTOR_WALK && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const part of chunk(frontier)) {
      const rows = await db
        .select({
          id: descriptions.id,
          parentId: descriptions.parentId,
          level: descriptions.descriptionLevel,
        })
        .from(descriptions)
        .where(and(eq(descriptions.tenantId, tenant.id), inArray(descriptions.id, part)))
        .all();
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        if (SERIES_LEVELS.includes(row.level)) series.add(row.id);
        if (COLLECTION_LEVELS.includes(row.level)) collections.add(row.id);
        if (row.parentId !== null && !seen.has(row.parentId)) next.push(row.parentId);
      }
    }
    frontier = [...new Set(next)];
  }

  return { series: series.size, collections: collections.size };
}

/** The distinct parents of a set of members. The walk's first frontier. */
async function readParentIds(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  memberIds: string[],
): Promise<string[]> {
  const parents = new Set<string>();
  for (const part of chunk(memberIds)) {
    const rows = await db
      .selectDistinct({ parentId: descriptions.parentId })
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, tenant.id), inArray(descriptions.id, part)))
      .all();
    for (const row of rows) if (row.parentId !== null) parents.add(row.parentId);
  }
  return [...parents];
}

/**
 * Whether a form crosswalks at all, for a surface deciding whether to
 * pay for the counts. Pure, and deliberately the same three questions
 * `computeCrosswalkLoss` answers null to.
 */
export function formCrosswalks(form: ExportForm, ownStandard: Standard): boolean {
  if (form === "canonical" || form === ownStandard) return false;
  return form === "dc" || isDescriptiveStandardForm(form);
}

/* @version v0.7.0 */
