/**
 * Merge evidence — the facts and descriptions behind an entity merge
 *
 * This module deals with the evidence a steward gives for merging two
 * entity records (persons, organisations, families). A shared name is
 * never evidence that two records are one person: a merge needs at
 * least one independent fact, from the five in `MERGE_FACTS`, and at
 * least one description on each side that shows it. Fisqua checks that
 * the evidence was given and that each description cited is linked to
 * the record of its side; it does not judge whether the evidence is
 * right. Every path that merges two entity records calls this module
 * before it composes the merge, and the evidence it returns goes into
 * the `merge` ledger row's `detail.evidence`, written in the same batch
 * as the merge. Place merges do not use it.
 *
 * The list of facts and the names of the refusals live in
 * `./merge-facts.ts`, which the panel in the browser also reads; this
 * module re-exports them.
 *
 * `evidenceFromForm` reads what the evidence panel posts: repeated
 * `evidence_fact` fields, one per fact ticked, and repeated
 * `evidence_description` fields whose value is
 * `<entityId>:<descriptionId>`. A value without both parts is dropped.
 *
 * `checkMergeEvidence` checks the input against the two records as the
 * merge reads them, applying the rule in `judgeMergeEvidence`, which a
 * caller holding the links already read (the command line's change
 * files) applies directly. The facts are deduplicated and kept in the order of
 * `MERGE_FACTS`; an empty list or an unknown key is refused. The cited
 * descriptions are grouped by entity and deduplicated. A cited
 * description must belong to the acting tenant and be linked, in
 * `description_entities`, to the record of its side, links the merge
 * will drop as collisions included. One description may be cited for
 * both sides. The refusals come in a fixed order: the facts, the
 * merged-away side empty, the surviving side empty, a citation not
 * linked to its side (or naming an entity that is neither).
 *
 * `evidenceStillLinkedGuard` is a statement for the merge's batch that
 * fails the batch when a cited link is missing, so that a link
 * removed between the check and the batch refuses the merge whole; it
 * follows the guard pattern of `incomingReferencesAsReadGuard` in
 * `./pair-merge.server.ts`. `evidenceStillLinked` is the same condition
 * read on its own, which a caller uses after a failed batch to tell a
 * removed citation from other failures.
 *
 * `loadEvidenceDescriptions` reads, for a set of entity records, the
 * tenant's descriptions linked to each, in the order the pair page
 * lists them (`loadPairContext`), for the evidence panel on the
 * duplicates cards. The duplicates page reads it beside its scan of every
 * record of the federation, and D1 can refuse it as overloaded then
 * (error code 7429); the read is retried as the app's other reads are
 * (`retryD1Read`, named `evidence_descriptions` in the overload log).
 *
 * @version v0.9.0
 */

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { descriptionEntities, descriptions } from "../db/schema";
import { retryD1Read, type D1Site } from "./d1-overload";
import { MERGE_FACTS, type EvidenceError, type MergeFact } from "./merge-facts";

export { MERGE_FACTS, EVIDENCE_ERRORS, isEvidenceError, type EvidenceError, type MergeFact } from "./merge-facts";

/** The evidence as the ledger row keeps it: description ids, keyed by entity id. */
export interface MergeEvidence {
  facts: MergeFact[];
  descriptions: Record<string, string[]>;
}

/** The evidence as a form or a change file gives it, before it is checked. */
export interface MergeEvidenceInput {
  facts: string[];
  cited: Array<{ entityId: string; descriptionId: string }>;
}

/** Read the panel's repeated `evidence_fact` and `evidence_description` fields. */
export function evidenceFromForm(form: FormData): MergeEvidenceInput {
  const facts = form
    .getAll("evidence_fact")
    .map((v) => String(v).trim())
    .filter(Boolean);
  const cited: MergeEvidenceInput["cited"] = [];
  for (const raw of form.getAll("evidence_description")) {
    const value = String(raw).trim();
    const at = value.indexOf(":");
    if (at <= 0 || at === value.length - 1) continue;
    cited.push({ entityId: value.slice(0, at), descriptionId: value.slice(at + 1) });
  }
  return { facts, cited };
}

/** Bound parameters per read, within D1's limit. */
const CHUNK = 90;

/**
 * The rule itself, on links already read: `linked(entityId,
 * descriptionId)` says whether the description is the tenant's and
 * linked to that record. The command line's change files, which read
 * through wrangler, judge their merge rows with it; `checkMergeEvidence`
 * reads the links through the binding and judges with it too.
 */
export function judgeMergeEvidence(
  loserId: string,
  survivorId: string,
  input: MergeEvidenceInput,
  linked: (entityId: string, descriptionId: string) => boolean,
): { ok: true; evidence: MergeEvidence } | { ok: false; error: EvidenceError } {
  const given = new Set(input.facts);
  if (given.size === 0 || [...given].some((f) => !(MERGE_FACTS as readonly string[]).includes(f))) {
    return { ok: false, error: "evidence_facts" };
  }
  const facts = MERGE_FACTS.filter((f) => given.has(f));

  const bySide = new Map<string, string[]>([[loserId, []], [survivorId, []]]);
  let stray = false;
  for (const { entityId, descriptionId } of input.cited) {
    const side = bySide.get(entityId);
    if (!side) {
      stray = true;
      continue;
    }
    if (!side.includes(descriptionId)) side.push(descriptionId);
  }
  if (bySide.get(loserId)!.length === 0) return { ok: false, error: "evidence_loser" };
  if (bySide.get(survivorId)!.length === 0) return { ok: false, error: "evidence_survivor" };
  if (stray) return { ok: false, error: "evidence_unlinked" };
  for (const [entityId, ids] of bySide) {
    if (ids.some((d) => !linked(entityId, d))) return { ok: false, error: "evidence_unlinked" };
  }
  return {
    ok: true,
    evidence: { facts, descriptions: { [loserId]: bySide.get(loserId)!, [survivorId]: bySide.get(survivorId)! } },
  };
}

/**
 * Check the evidence for merging `loserId` into `survivorId`, against
 * the acting tenant's links as they are now.
 */
export async function checkMergeEvidence(
  db: DrizzleD1Database<any>,
  tenantId: string,
  loserId: string,
  survivorId: string,
  input: MergeEvidenceInput,
): Promise<{ ok: true; evidence: MergeEvidence } | { ok: false; error: EvidenceError }> {
  // The links of the two records to the cited descriptions, on the tenant's descriptions only.
  const cited = [...new Set(input.cited.map((c) => c.descriptionId))];
  const linked = new Set<string>();
  for (let i = 0; i < cited.length; i += CHUNK) {
    const rows = await db
      .select({ entityId: descriptionEntities.entityId, descriptionId: descriptionEntities.descriptionId })
      .from(descriptionEntities)
      .innerJoin(descriptions, eq(descriptions.id, descriptionEntities.descriptionId))
      .where(
        and(
          inArray(descriptionEntities.entityId, [loserId, survivorId]),
          inArray(descriptionEntities.descriptionId, cited.slice(i, i + CHUNK)),
          eq(descriptions.tenantId, tenantId),
        ),
      )
      .all();
    for (const r of rows) linked.add(`${r.entityId}|${r.descriptionId}`);
  }
  return judgeMergeEvidence(loserId, survivorId, input, (e, d) => linked.has(`${e}|${d}`));
}

/** The cited (entity, description) pairs, as JSON for `json_each`. */
function citedPairs(evidence: MergeEvidence): string {
  return JSON.stringify(
    Object.entries(evidence.descriptions).flatMap(([entityId, ids]) => ids.map((d) => [entityId, d])),
  );
}

/**
 * The condition that every cited description is still linked to its
 * side and still the tenant's. Two bound parameters, however many
 * descriptions are cited.
 */
function stillLinked(tenantId: string, evidence: MergeEvidence): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM json_each(${citedPairs(evidence)}) AS cited
    WHERE NOT EXISTS (SELECT 1 FROM ${descriptionEntities}
      JOIN ${descriptions} ON ${descriptions.id} = ${descriptionEntities.descriptionId}
      WHERE ${descriptionEntities.entityId} = json_extract(cited.value, '$[0]')
        AND ${descriptionEntities.descriptionId} = json_extract(cited.value, '$[1]')
        AND ${descriptions.tenantId} = ${tenantId}))`;
}

/**
 * The statement that fails the batch it is in unless every cited link
 * is still there. json() of text that is not JSON raises the error.
 */
export function evidenceStillLinkedGuard(
  db: DrizzleD1Database<any>,
  tenantId: string,
  evidence: MergeEvidence,
): BatchItem<"sqlite"> {
  return db
    .select({
      evidence: sql<number>`CASE WHEN ${stillLinked(tenantId, evidence)} THEN 1 ELSE json('a cited description is not linked to its record') END`,
    })
    .from(sql`(SELECT 1)`);
}

/** Whether every cited link is still there. */
export async function evidenceStillLinked(
  db: DrizzleD1Database<any>,
  tenantId: string,
  evidence: MergeEvidence,
): Promise<boolean> {
  const row = await db
    .select({ ok: sql<number>`CASE WHEN ${stillLinked(tenantId, evidence)} THEN 1 ELSE 0 END` })
    .from(sql`(SELECT 1)`)
    .get();
  return row?.ok === 1;
}

/** A description the evidence panel offers for one side. */
export interface EvidenceDescription {
  id: string;
  code: string;
  date: string | null;
  title: string;
}

/** Descriptions offered per record, as the pair page lists them. */
export const EVIDENCE_DESCRIPTION_LIMIT = 10;

/**
 * The tenant's descriptions linked to each of `entityIds`, earliest
 * first, then by reference code, at most `EVIDENCE_DESCRIPTION_LIMIT`
 * per record. The date is the description's date expression, or its
 * start date when it has none.
 */
export async function loadEvidenceDescriptions(
  db: DrizzleD1Database<any>,
  tenantId: string,
  entityIds: readonly string[],
  opts: { site?: D1Site; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Record<string, EvidenceDescription[]>> {
  const out: Record<string, EvidenceDescription[]> = {};
  for (const id of entityIds) out[id] = [];
  const ids = [...new Set(entityIds)];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    // The page reads this beside the full scan of the federation's records,
    // and D1 can refuse it as overloaded: it is read again after a wait.
    const rows = await retryD1Read(() => db.all<{
      entity_id: string;
      id: string;
      code: string;
      date: string | null;
      title: string;
    }>(sql`
      SELECT entity_id, id, code, date, title FROM (
        SELECT l.entity_id AS entity_id, d.id AS id, d.reference_code AS code,
               COALESCE(d.date_expression, d.date_start) AS date, d.title AS title,
               ROW_NUMBER() OVER (
                 PARTITION BY l.entity_id
                 ORDER BY d.date_start IS NULL, d.date_start, d.reference_code
               ) AS rn
          FROM description_entities l
          JOIN descriptions d ON d.id = l.description_id
         WHERE l.entity_id IN (${sql.join(part.map((p) => sql`${p}`), sql`, `)})
           AND d.tenant_id = ${tenantId}
         GROUP BY l.entity_id, d.id
      )
      WHERE rn <= ${EVIDENCE_DESCRIPTION_LIMIT}
      ORDER BY entity_id, rn
    `), undefined, opts.sleep, { read: "evidence_descriptions", ...opts.site });
    for (const r of rows) {
      (out[r.entity_id] ??= []).push({ id: r.id, code: r.code, date: r.date ?? null, title: r.title });
    }
  }
  return out;
}

// @version v0.9.0
