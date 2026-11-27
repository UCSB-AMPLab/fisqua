/**
 * Pair merge — the decisions surface's "same record" ruling.
 *
 * This module deals with the merge the duplicates worklist performs when
 * a pair is ruled the same record. The duplicates worklist puts one
 * question to a flagged pair: are these two records the same record?
 * `rulePairMerge` is the answer "yes", and it is deliberately NOT the
 * merge workbench. The workbench is a curation surface — the cataloguer
 * picks which description links travel, decides whether to fold the
 * loser's names in, and carries an optimistic lock because the
 * comparison it renders may be minutes old. A decision is a judgement
 * about identity: once the pair is one record, every link belongs to the
 * survivor and every name the loser answered to is a variant of the
 * survivor's. So this path is unselective by construction — all links,
 * names always folded — and the batch it writes is the workbench's batch
 * with the choices removed.
 *
 * What it owns, in order: the pair mutation gate, the two 409s that are
 * this surface's whole concurrency story (a record already merged away,
 * a pair already ruled), the repointing of the ruling tenant's links
 * with the workbench's per-link collision handling, the name fold, the
 * loser's mergedInto pointer and provenance line, the ledger row, and
 * the decision ruling itself — the last five in ONE `db.batch`, so a
 * merge and the trail recording it land together or not at all.
 *
 * ## Shared records: only the ruling tenant's links move
 *
 * A record in a federation's shared space can be linked from the
 * descriptions of several tenants. A merge, here or on the workbenches,
 * moves only the links whose description belongs to the tenant ruling
 * it. Every other tenant's links stay on the record merged away, whose
 * `mergedInto` names the survivor; the merge is not refused while they
 * exist. "Every link belongs to the survivor" above means every one of
 * the ruling tenant's links.
 *
 * ## Two trails, not one — the ledger and the journal
 *
 * `authority_operations` records that a merge HAPPENED: which record
 * absorbed which, on whose say-so, with the moved/dropped link counts.
 * That is the structural event, and it is the ledger's remit alone. It
 * is not, however, a before-image: it cannot tell you what
 * `name_variants` said before the fold, and it cannot put a repointed
 * junction row back. So every mutation in this batch ALSO composes a
 * stewardship journal row (spec §3), in the same batch as the effect it
 * records — the ledger discipline, not the older separate-insert one.
 *
 * A repointed link journals as an `unlink` of the old junction content
 * plus a `link` of the new: the row's id never changes, but the fact it
 * asserts does, and the two kinds are the only vocabulary the journal
 * has for a junction (a `update` row against a junction would be read
 * by a revert as a field write on the record table). Junction rows are
 * journaled AGAINST THE DESCRIPTION, not against the junction's own id:
 * `changelog.record_id` is what the history reader resolves to a page,
 * and a junction id resolves to nothing. The junction's own id travels
 * inside the diff, which is where a revert reads it from.
 *
 * Both record types run through the same implementation: the shape of
 * a merge does not differ between an entity and a place, only the table
 * and the junction column do. Where the tables genuinely diverge, they
 * diverge in the reads and the statements, not in the semantics —
 * `entities` carries a `sources` column for the provenance line and
 * `places` does not, exactly as the two workbench routes have it.
 *
 * ## Reads apart from statements
 *
 * The statements are composed by two synchronous functions that take
 * rows already read: `composeLinkMoves` (the per-link collision rule
 * and its journal rows) and `composeMergeStatements` (the loser's
 * pointer, the name fold, their journal rows and the ledger row).
 * `rulePairMerge` reads through the Worker's D1 binding and hands them
 * the rows. A bulk merge run from the command line, which cannot use
 * the binding, reads through wrangler, calls the same two functions and
 * renders their statements to SQL text, so a merge applied that way
 * writes what a merge ruled here writes. Such a caller may name entity
 * variants to leave out of the fold (`excludeVariants`).
 *
 * ## Functions travel with the merge
 *
 * An entity merge also carries the loser's `entity_functions` rows to
 * the survivor, in the same batch (`arrivingEntityFunctions`). A row of
 * a function the survivor does not hold moves, its id and every column
 * but `entity_id` kept; a row of a function the survivor holds, or that
 * an earlier row of the loser brought (text compared after trimming,
 * collapsing whitespace and case-folding), fills the held row's empty
 * fields and is deleted, so a function both records held is held once.
 * The caller passes the survivor's rows (`survivorFunctions`) as well
 * as the loser's. Both records take a new `updated_at`,
 * the merge's `now` or one past the version read when the clock has not
 * passed it (`nextVersion`), so a save that read either record before
 * the merge fails its version check after it, and the publish export's
 * change check sees the survivor; and the ledger row names the rows moved in
 * `detail.movedFunctions` and gives each row folded in full, with the row
 * it folded into and the fields it filled, in `detail.foldedFunctions`:
 * what a reversal gives back. The
 * caller reads the loser's rows and passes them (`loserFunctions`);
 * places have none. `rulePairMerge` opens its batch with a guard that
 * both entities are still unmerged and hold the version read, and each
 * the number of rows read (`entitiesAsReadGuard`), and follows the merge's statements
 * with a guard that the loser holds no rows
 * (`entityLeftWithoutFunctionsGuard`); an edit that lands in between
 * fails the whole batch, which the ruling reports as a 409.
 *
 * ## Repoints that would collide
 *
 * When both sides of one relation are recorded twice across the
 * survivor and the loser, the repoint of a dropped side's partner can
 * give one entity two links to a description in one role naming the
 * same link, which the unique index refuses: the batch would fail whole
 * and say nothing of why. `linkCollisions` finds such pairs from the
 * rows read and what the batch does to them; `planLinkMoves` checks
 * before composing the batch and throws `LinkCollisionError`, which
 * names the description's reference code, the entity's code and the
 * role. `rulePairMerge` plans the links before anything is written, and
 * a pair seen for the first time has its decision row filed by an INSERT
 * in the merge's own batch (`preparePairDecision`), so a merge refused
 * before the batch or by one of its guards leaves no row behind. The
 * batch opens with a guard that the pair's row is as read (none, or the
 * open row read), so a ruling another request files in between fails the
 * merge whole, which answers it as a 409, and is never overwritten. The merge
 * workbench and the command line's merges make the same check.
 *
 * A link counts as naming another only when both are on the same
 * description, one of the ruling tenant's (`sameDescriptionAsNamed`,
 * `linksNaming`): the reads that find the other sides and the collisions
 * see nothing elsewhere, and a refusal names only that tenant's codes.
 * A link elsewhere that names a link the batch deletes still fails the
 * batch's guard, which counts every link naming it, as stale data.
 *
 * ## Evidence for an entity merge
 *
 * A shared name is never evidence that two records are one. An entity
 * merge ruled here carries the facts and the cited descriptions the
 * steward gave, checked by `./merge-evidence.server.ts` before the link
 * plan and written into the ledger row's `detail.evidence`; a place
 * merge carries none.
 *
 * `composeLinkMoves`, `composeRepoints` and `composeMergeStatements`
 * take an optional `actedAs` that every journal row they compose
 * carries (`changelog.acted_as`, migration 0127); the command line
 * passes it for a platform admin or the lead's admin, and the app
 * passes none.
 *
 * @version v0.9.0
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  descriptionEntities,
  descriptionPlaces,
  descriptions,
  entities,
  pendingDecisions,
  places,
  type ChangelogActedAs,
} from "../db/schema";
import type { AuthorityRecordType } from "./authority-ownership.server";
import { logAuthorityOperation } from "./authority-operations.server";
import {
  entitiesAsReadGuard,
  entitiesStillAsRead,
  entityLeftWithoutFunctionsGuard,
  arrivingEntityFunctions,
  nextVersion,
  planFunctionArrivals,
  readEntityFunctionRows,
  type EntityAsRead,
  type EntityFunctionRow,
  type FunctionArrivals,
} from "./entity-functions.server";
import {
  checkMergeEvidence,
  evidenceStillLinked,
  evidenceStillLinkedGuard,
  type MergeEvidence,
  type MergeEvidenceInput,
} from "./merge-evidence.server";
import { composeJournalEntry, linkDiff, unlinkDiff } from "./stewardship.server";
import { formatIsoDateTime } from "./format";
import type { Tenant, User } from "../context";

export interface PairMergeResult {
  /** The pair's decision row — filed on first contact, now ruled. */
  decisionId: string;
  /** Loser links repointed at the survivor. */
  movedLinks: number;
  /** Loser links deleted because the survivor already held them. */
  droppedLinks: number;
}

/**
 * The columns the merge reads from whichever authority table applies.
 * `sources` is always present in the shape and always null for places,
 * whose table has no such column — the provenance line is an entity
 * affordance, and the merge writes it only where there is somewhere to
 * write it.
 */
export interface AuthorityRecordSnapshot {
  id: string;
  displayName: string;
  /** entity_code / place_code, carried into the provenance line. */
  code: string | null;
  nameVariants: string | null;
  mergedInto: string | null;
  sources: string | null;
  /**
   * The record's version as read; entities only. The merge gives the
   * record `nextVersion` of it, past the version read.
   */
  updatedAt?: number;
}

/** Read one record on the tenant's visible scope, as the workbench does. */
async function loadRecord(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  recordType: AuthorityRecordType,
  id: string,
): Promise<AuthorityRecordSnapshot | undefined> {
  const { authorityScope } = await import("./authority-ownership.server");
  if (recordType === "place") {
    const row = await db
      .select({
        id: places.id,
        displayName: places.displayName,
        code: places.placeCode,
        nameVariants: places.nameVariants,
        mergedInto: places.mergedInto,
      })
      .from(places)
      .where(
        and(
          authorityScope(places, tenant.federationId, tenant.id),
          eq(places.id, id),
        ),
      )
      .get();
    return row ? { ...row, sources: null } : undefined;
  }
  return db
    .select({
      id: entities.id,
      displayName: entities.displayName,
      code: entities.entityCode,
      nameVariants: entities.nameVariants,
      mergedInto: entities.mergedInto,
      sources: entities.sources,
      updatedAt: entities.updatedAt,
    })
    .from(entities)
    .where(
      and(
        authorityScope(entities, tenant.federationId, tenant.id),
        eq(entities.id, id),
      ),
    )
    .get();
}

/**
 * The record `id` was merged into in the end: `merged_into` followed,
 * on the tenant's visible scope, to a record not merged away. A record
 * not merged away is its own; null when the chain loops, or reaches a
 * record missing or outside the scope.
 */
export async function finalSurvivorId(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  recordType: AuthorityRecordType,
  id: string,
): Promise<string | null> {
  const seen = new Set<string>();
  let current: string | null = id;
  while (current !== null) {
    if (seen.has(current)) return null;
    seen.add(current);
    const record = await loadRecord(db, tenant, recordType, current);
    if (!record) return null;
    if (!record.mergedInto) return record.id;
    current = record.mergedInto;
  }
  return null;
}

/** A stored JSON name-variants array, defensively parsed (workbench rule). */
export function parseVariants(json: string | null): string[] {
  try {
    return JSON.parse(json || "[]");
  } catch {
    return [];
  }
}

export interface LinkPlan {
  statements: any[];
  /** Full content of every conflict-deleted junction row, for the ledger. */
  droppedLinks: unknown[];
  movedLinks: number;
  /** Each dropped entity link and the link kept in its place, to which any link naming the dropped one is repointed. */
  repointed: Array<{ droppedId: string; keptId: string }>;
  /**
   * The entity links the plan deletes and the ids of the links read that
   * name one of them, for `incomingReferencesAsReadGuard`; absent when the
   * plan deletes no entity link.
   */
  incoming?: IncomingReferences;
}

/** The links a batch deletes, the links read whose `related_to` names one of them, and the links kept in their place. */
export interface IncomingReferences {
  deletedIds: string[];
  readIds: string[];
  /** The links the repoints name; each must still exist when the batch runs. */
  keptIds: string[];
}

/** json() of text that is not JSON raises the error that fails the batch. */
const failUnless = (condition: SQL, message: string) =>
  sql<number>`CASE WHEN ${condition} THEN 1 ELSE json(${sql.raw(`'${message}'`)}) END`;

/**
 * The condition that the links naming a deleted link are exactly those
 * read, and that every kept link still exists. Six bound parameters,
 * however many links.
 */
function incomingAsRead(refs: IncomingReferences): SQL {
  const deleted = sql`(SELECT value FROM json_each(${JSON.stringify(refs.deletedIds)}))`;
  return sql`(SELECT count(*) FROM ${descriptionEntities} WHERE ${descriptionEntities.relatedTo} IN ${deleted}) = ${refs.readIds.length}
    AND NOT EXISTS (SELECT 1 FROM ${descriptionEntities} WHERE ${descriptionEntities.relatedTo} IN ${deleted}
      AND ${descriptionEntities.id} NOT IN (SELECT value FROM json_each(${JSON.stringify(refs.readIds)})))
    AND (SELECT count(*) FROM ${descriptionEntities} WHERE ${descriptionEntities.id} IN (SELECT value FROM json_each(${JSON.stringify(refs.keptIds)}))) = ${refs.keptIds.length}`;
}

/**
 * The statement that fails the batch it is in unless the links whose
 * `related_to` names a link the batch deletes are exactly the links read.
 * Put first in a batch that deletes entity links and repoints the links
 * naming them. The foreign key on `related_to` already refuses any write
 * of the batch that would leave a link naming a link that is gone (a
 * link that came to name a deleted link after the read, or a kept link
 * removed since); this guard fails the batch first, on the same change,
 * so the caller can tell it from other failures and answer it as stale
 * data, as `entitiesAsReadGuard` lets it answer an entity changed since
 * it was read.
 */
export function incomingReferencesAsReadGuard(db: DrizzleD1Database<any>, refs: IncomingReferences): BatchItem<"sqlite"> {
  return db
    .select({ incoming: failUnless(incomingAsRead(refs), "the links naming a deleted link changed since they were read") })
    .from(sql`(SELECT 1)`);
}

/** Whether the links naming a deleted link are still exactly those read. */
export async function incomingReferencesStillAsRead(db: DrizzleD1Database<any>, refs: IncomingReferences): Promise<boolean> {
  const row = await db
    .select({ ok: sql<number>`CASE WHEN ${incomingAsRead(refs)} THEN 1 ELSE 0 END` })
    .from(sql`(SELECT 1)`)
    .get();
  return row?.ok === 1;
}

/**
 * A junction row as the merge reads it: the full row, keyed as Drizzle
 * returns it. Places carry `placeId`, entities `entityId`; the rest of
 * the content travels into the journal diffs as it was read.
 */
export type JunctionRow = {
  id: string;
  descriptionId: string;
  role: string | null;
} & Record<string, unknown>;

/**
 * The key the junction table's unique index holds per record. An entity
 * link's index also takes the link it points to (migration 0125), so a
 * document-role link and a relation side with the same role do not
 * collide; a place link has no `relatedTo`.
 */
export function heldKey(link: { descriptionId: string; role: string | null; relatedTo?: unknown }): string {
  const related = typeof link.relatedTo === "string" ? link.relatedTo : "";
  return `${link.descriptionId}|${link.role ?? ""}|${related}`;
}

/**
 * Resolve what happens to EVERY one of the loser's description links —
 * no client selection reaches this surface. Per link, the workbench's
 * rule: a survivor row already holding the same (descriptionId, role,
 * and for an entity link relatedTo) would collide with the junction
 * table's unique index, so the loser's
 * row is captured in full and deleted; otherwise it is repointed.
 *
 * `survivorHolds` maps each held key to the id of the link that holds
 * it. Each dropped entity link is returned in `repointed` with the link
 * kept under the same key; the caller repoints the links that name it
 * with `composeRepoints`, in the same batch (migration 0125). A dropped
 * link with no kept link to repoint to is refused.
 *
 * `current` holds, for a link a repoint earlier in the same batch has
 * changed, its content after that repoint (`composeRepoints`' `after`).
 * Collisions are decided on the links as read; the journal records each
 * link from its current content, so a link's entries form one chain in
 * which each entry's content before is the previous entry's content
 * after, and the last is the row as stored.
 *
 * Every statement it plans is followed by the journal row that records
 * it (module header): a dropped link is one `unlink`, a repointed link
 * is an `unlink` of the old content plus a `link` of the new. They ride
 * in the same `statements` array so the caller's single batch commits
 * effect and journal together without having to know which is which.
 */
export function composeLinkMoves(
  db: DrizzleD1Database<any>,
  recordType: AuthorityRecordType,
  survivorId: string,
  links: JunctionRow[],
  survivorHolds: ReadonlyMap<string, string>,
  userId: string,
  now: number,
  current: ReadonlyMap<string, JunctionRow> = new Map(),
  actedAs: ChangelogActedAs | null = null,
): LinkPlan {
  const statements: any[] = [];
  const droppedLinks: unknown[] = [];
  const repointed: LinkPlan["repointed"] = [];
  let movedLinks = 0;
  const junction = recordType === "place" ? descriptionPlaces : descriptionEntities;
  const pointer = recordType === "place" ? "placeId" : "entityId";

  for (const link of links) {
    const snapshot = current.get(link.id) ?? link;
    if (survivorHolds.has(heldKey(link))) {
      const keptId = survivorHolds.get(heldKey(link));
      if (recordType === "entity" && !keptId) {
        throw new Error(`link ${link.id} collides with no kept link to repoint its relation to`);
      }
      droppedLinks.push(link);
      statements.push(
        db.delete(junction).where(eq(junction.id, link.id)),
        composeJournalEntry(db, {
          recordId: link.descriptionId,
          recordType: "description",
          userId,
          actedAs,
          kind: "unlink",
          diff: unlinkDiff(snapshot),
          now,
        }),
      );
      if (recordType === "entity") repointed.push({ droppedId: link.id, keptId: keptId! });
    } else {
      movedLinks += 1;
      statements.push(
        db
          .update(junction as typeof descriptionPlaces)
          .set({ [pointer]: survivorId } as { placeId: string })
          .where(eq(junction.id, link.id)),
        composeJournalEntry(db, {
          recordId: link.descriptionId,
          recordType: "description",
          userId,
          actedAs,
          kind: "unlink",
          diff: unlinkDiff(snapshot),
          now,
        }),
        composeJournalEntry(db, {
          recordId: link.descriptionId,
          recordType: "description",
          userId,
          actedAs,
          kind: "link",
          diff: linkDiff({ ...snapshot, [pointer]: survivorId }),
          now,
        }),
      );
    }
  }
  return { statements, droppedLinks, movedLinks, repointed };
}

/**
 * Repoint the other side of each dropped relation side. `pointing` holds,
 * for each dropped link id, the links read whose `related_to` names it.
 * A link that is itself dropped is not repointed. Each repoint is an
 * UPDATE that touches the row only while it still names the dropped
 * link, journaled as the merge journals a moved link: an `unlink` of the
 * content before and a `link` of the content after. The statements go
 * before the batch's moves and drops, since the foreign key on
 * `related_to` refuses the delete of a link that is still named; the
 * content journaled before is therefore the link as read.
 *
 * `after` holds each repointed link's content after the repoint, for
 * the caller to pass to `composeLinkMoves` (or to the split's journal)
 * so that a later move of the same link journals from it. A caller
 * whose moves are not journaled (the merge workbench) passes
 * `finalEntity`, the entity each repointed link will hold once the
 * batch's moves are made, and the repoint's content after is then the
 * row as the batch leaves it.
 */
export function composeRepoints(
  db: DrizzleD1Database<any>,
  repointed: ReadonlyArray<{ droppedId: string; keptId: string }>,
  pointing: ReadonlyMap<string, readonly JunctionRow[]>,
  dropped: ReadonlySet<string>,
  userId: string,
  now: number,
  finalEntity: ReadonlyMap<string, string> = new Map(),
  actedAs: ChangelogActedAs | null = null,
): { statements: any[]; rows: Array<{ id: string; relatedTo: string }>; after: Map<string, JunctionRow> } {
  const statements: any[] = [];
  const rows: Array<{ id: string; relatedTo: string }> = [];
  const after = new Map<string, JunctionRow>();
  for (const { droppedId, keptId } of repointed) {
    for (const p of pointing.get(droppedId) ?? []) {
      if (dropped.has(p.id)) continue;
      const before = { ...p };
      const next = { ...before, relatedTo: keptId };
      after.set(p.id, next);
      rows.push({ id: p.id, relatedTo: keptId });
      statements.push(
        db
          .update(descriptionEntities)
          .set({ relatedTo: keptId })
          .where(and(eq(descriptionEntities.id, p.id), eq(descriptionEntities.relatedTo, droppedId))),
        composeJournalEntry(db, {
          recordId: p.descriptionId,
          recordType: "description",
          userId,
          actedAs,
          kind: "unlink",
          diff: unlinkDiff(before),
          now,
        }),
        composeJournalEntry(db, {
          recordId: p.descriptionId,
          recordType: "description",
          userId,
          actedAs,
          kind: "link",
          diff: linkDiff(finalEntity.has(p.id) ? { ...next, entityId: finalEntity.get(p.id) } : next),
          now,
        }),
      );
    }
  }
  return { statements, rows, after };
}

/** A link as the unique index on `description_entities` reads it. */
export interface IndexedLink {
  id: string;
  descriptionId: string;
  entityId?: unknown;
  role: string | null;
  relatedTo?: unknown;
}

/** Two links a batch would leave under one key of the unique index. */
export interface LinkCollision {
  descriptionId: string;
  /** The entity both links would hold. */
  entityId: string;
  role: string | null;
  /** The link both would name; null for two document-role links. */
  relatedTo: string | null;
  /** The two links, the one read first first. */
  linkIds: [string, string];
}

/**
 * The pairs of links a batch would leave under one key of the unique
 * index `(description_id, entity_id, role, COALESCE(related_to, ''))`.
 *
 * `rows` are the links as read; `change` says what the batch does to
 * them: the entity each moved link takes (`entityOf`), the link each
 * repointed link names (`relatedToOf`), and the links it deletes
 * (`dropped`). A pair is reported only when the batch changes one of
 * its links, since two links as read never share a key. D1 refuses a
 * batch that leaves such a pair, with nothing written and no word of
 * which links; a merge checks first and refuses with this pair named.
 *
 * A repoint collides when both sides of one relation are recorded
 * twice across the survivor and the loser: the loser's side is dropped
 * because the survivor's holds its key, and the other side that named it
 * would come to name the survivor's side, which another link of the same
 * entity and role already names.
 */
export function linkCollisions(
  rows: Iterable<IndexedLink>,
  change: {
    entityOf?: ReadonlyMap<string, string>;
    relatedToOf?: ReadonlyMap<string, string>;
    dropped?: ReadonlySet<string>;
  },
): LinkCollision[] {
  const seen = new Set<string>();
  const byKey = new Map<string, { id: string; changed: boolean }>();
  const out: LinkCollision[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (change.dropped?.has(row.id)) continue;
    const entityId = change.entityOf?.get(row.id) ?? String(row.entityId ?? "");
    const named = change.relatedToOf?.get(row.id) ?? (typeof row.relatedTo === "string" ? row.relatedTo : null);
    const changed = (change.entityOf?.has(row.id) ?? false) || (change.relatedToOf?.has(row.id) ?? false);
    const key = JSON.stringify([row.descriptionId, entityId, row.role ?? "", named ?? ""]);
    const held = byKey.get(key);
    if (!held) {
      byKey.set(key, { id: row.id, changed });
      continue;
    }
    if (held.changed || changed) {
      out.push({ descriptionId: row.descriptionId, entityId, role: row.role, relatedTo: named, linkIds: [held.id, row.id] });
    }
  }
  return out;
}

/**
 * The sentence a refusal of colliding links gives, from the codes of the
 * description and the entity. `subject` names what would make the pair:
 * the merge, unless a caller names another row or rows.
 */
export function linkCollisionMessage(c: { referenceCode: string; entityCode: string; role: string | null }, subject = "the merge"): string {
  return `${subject} would leave ${c.entityCode} with two links to ${c.referenceCode} as ${c.role ?? ""} that name the same link`;
}

/**
 * A merge refused because its batch would leave two links under one key
 * of the unique index (`linkCollisions`). `collision` names the
 * description by its reference code, the entity by its code, and the
 * role, for the page to show.
 */
export class LinkCollisionError extends Error {
  constructor(public readonly collision: { referenceCode: string; entityCode: string; role: string | null }) {
    super(linkCollisionMessage(collision));
    this.name = "LinkCollisionError";
  }
}

/**
 * The refusal for a collision: the description's reference code and the
 * entity's code read. The collision's links are all on one of the
 * tenant's descriptions (the reads that find it are scoped to them); the
 * description is read on the tenant all the same, and a code not found
 * is left blank rather than given as an id.
 */
export async function linkCollisionError(db: DrizzleD1Database<any>, c: LinkCollision, tenantId: string): Promise<LinkCollisionError> {
  const d = await db
    .select({ code: descriptions.referenceCode })
    .from(descriptions)
    .where(and(eq(descriptions.id, c.descriptionId), eq(descriptions.tenantId, tenantId)))
    .get();
  const e = d
    ? await db.select({ code: entities.entityCode }).from(entities).where(eq(entities.id, c.entityId)).get()
    : undefined;
  return new LinkCollisionError({ referenceCode: d?.code ?? "", entityCode: e?.code ?? "", role: c.role });
}

/**
 * The condition, on a `description_entities` row, that the link it names
 * in `related_to` is on the same description: only such a link is a
 * relation side of it.
 */
export const sameDescriptionAsNamed = (): SQL =>
  // Qualified by the table's name: Drizzle leaves a column unqualified in
  // a query on one table, and inside the subquery an unqualified name
  // would name the subquery's row.
  sql`"description_entities"."description_id" = (SELECT named.description_id FROM description_entities AS named
    WHERE named.id = "description_entities"."related_to")`;

/**
 * The links whose `related_to` names one of `ids` on the same
 * description, on the tenant's descriptions only, read in parts within
 * D1's bound-parameter limit.
 */
export async function linksNaming(db: DrizzleD1Database<any>, ids: readonly string[], tenantId: string): Promise<JunctionRow[]> {
  const out: JunctionRow[] = [];
  const tenantDescriptions = db.select({ id: descriptions.id }).from(descriptions).where(eq(descriptions.tenantId, tenantId));
  for (let i = 0; i < ids.length; i += 90) {
    out.push(...((await db
      .select()
      .from(descriptionEntities)
      .where(and(
        inArray(descriptionEntities.relatedTo, ids.slice(i, i + 90)),
        inArray(descriptionEntities.descriptionId, tenantDescriptions),
        sameDescriptionAsNamed(),
      ))
      .all()) as JunctionRow[]));
  }
  return out;
}

/** Each link's held key mapped to its id, the first link holding a key keeping it. */
export function heldLinks(links: ReadonlyArray<{ id: string; descriptionId: string; role: string | null; relatedTo?: unknown }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of links) if (!out.has(heldKey(l))) out.set(heldKey(l), l.id);
  return out;
}

/**
 * Read the loser's links and the survivor's (descriptionId, role) set —
 * two reads however many links the loser carries; the record with
 * hundreds of links is exactly the one this surface merges — and plan
 * every move.
 *
 * Both reads see only links whose description belongs to the request
 * tenant (`tenantId`). A shared record can carry links from several
 * tenants of its federation; a merge ruled in one tenant moves that
 * tenant's links and leaves every other tenant's where they are, on
 * the record merged away.
 */
async function planLinkMoves(
  db: DrizzleD1Database<any>,
  recordType: AuthorityRecordType,
  survivorId: string,
  loserId: string,
  userId: string,
  now: number,
  tenantId: string,
): Promise<LinkPlan> {
  const held = (rows: Array<{ id: string; descriptionId: string; role: string | null; relatedTo?: string | null }>) =>
    heldLinks(rows);
  const tenantDescriptions = db
    .select({ id: descriptions.id })
    .from(descriptions)
    .where(eq(descriptions.tenantId, tenantId));

  if (recordType === "place") {
    const [links, survivorLinks] = await Promise.all([
      db
        .select()
        .from(descriptionPlaces)
        .where(
          and(
            eq(descriptionPlaces.placeId, loserId),
            inArray(descriptionPlaces.descriptionId, tenantDescriptions),
          ),
        )
        .all(),
      db
        .select({
          id: descriptionPlaces.id,
          descriptionId: descriptionPlaces.descriptionId,
          role: descriptionPlaces.role,
        })
        .from(descriptionPlaces)
        .where(
          and(
            eq(descriptionPlaces.placeId, survivorId),
            inArray(descriptionPlaces.descriptionId, tenantDescriptions),
          ),
        )
        .all(),
    ]);
    return composeLinkMoves(
      db, recordType, survivorId, links, held(survivorLinks), userId, now,
    );
  }

  const [links, survivorLinks] = await Promise.all([
    db
      .select()
      .from(descriptionEntities)
      .where(
        and(
          eq(descriptionEntities.entityId, loserId),
          inArray(descriptionEntities.descriptionId, tenantDescriptions),
        ),
      )
      .all(),
    db
      .select({
        id: descriptionEntities.id,
        descriptionId: descriptionEntities.descriptionId,
        role: descriptionEntities.role,
        relatedTo: descriptionEntities.relatedTo,
      })
      .from(descriptionEntities)
      .where(
        and(
          eq(descriptionEntities.entityId, survivorId),
          inArray(descriptionEntities.descriptionId, tenantDescriptions),
        ),
      )
      .all(),
  ]);
  // Collisions are decided first; when a drop is named by other links,
  // those are repointed ahead of everything else and the moves are then
  // composed from the repointed content, so each link journals one chain.
  const decided = composeLinkMoves(
    db, recordType, survivorId, links, held(survivorLinks), userId, now,
  );
  if (decided.repointed.length === 0) return decided;
  // The links naming the loser's links: the other sides of its relations,
  // on the same description, which is the tenant's. A link elsewhere that
  // names one is no relation side of it; the batch's guard counts every
  // link naming a deleted one, so such a link fails the merge as stale
  // data, and nothing of it is read or shown.
  const pointingRows = await db
    .select()
    .from(descriptionEntities)
    .where(
      and(
        inArray(
          descriptionEntities.relatedTo,
          db
            .select({ id: descriptionEntities.id })
            .from(descriptionEntities)
            .where(
              and(
                eq(descriptionEntities.entityId, loserId),
                inArray(descriptionEntities.descriptionId, tenantDescriptions),
              ),
            ),
        ),
        sameDescriptionAsNamed(),
      ),
    )
    .all();
  const pointing = new Map<string, JunctionRow[]>();
  for (const p of pointingRows) pointing.set(p.relatedTo!, [...(pointing.get(p.relatedTo!) ?? []), p as JunctionRow]);
  const droppedIds = new Set(decided.repointed.map((r) => r.droppedId));
  // The repoints go first: the foreign key on `related_to` refuses the
  // delete of a link that is still named, so each link naming a dropped
  // one must name the kept one before the drop.
  const repoints = composeRepoints(db, decided.repointed, pointing, droppedIds, userId, now);
  // A repoint must not leave two links under one key of the unique index:
  // the links that could share a key with a moved or repointed link are
  // the loser's, the survivor's, and those naming a link the repoints name.
  const keptIds = [...new Set(decided.repointed.map((r) => r.keptId))];
  const collisions = linkCollisions(
    [
      ...survivorLinks.map((l) => ({ ...l, entityId: survivorId })),
      ...links,
      ...pointingRows,
      ...(await linksNaming(db, keptIds, tenantId)),
    ],
    {
      entityOf: new Map(links.filter((l) => !droppedIds.has(l.id)).map((l) => [l.id, survivorId])),
      relatedToOf: new Map(repoints.rows.map((r) => [r.id, r.relatedTo])),
      dropped: droppedIds,
    },
  );
  if (collisions.length > 0) throw await linkCollisionError(db, collisions[0], tenantId);
  const plan = composeLinkMoves(
    db, recordType, survivorId, links, held(survivorLinks), userId, now, repoints.after,
  );
  plan.statements.unshift(...repoints.statements);
  // The guard's read set is exactly the links naming a link the batch
  // deletes; links naming a loser link that moves are not in it.
  plan.incoming = {
    deletedIds: [...droppedIds],
    readIds: pointingRows.filter((p) => droppedIds.has(p.relatedTo!)).map((p) => p.id),
    keptIds: [...new Set(plan.repointed.map((r) => r.keptId))],
  };
  return plan;
}

export interface MergeComposition {
  recordType: AuthorityRecordType;
  /** The scope predicate both record updates carry. */
  scope: SQL | undefined;
  federationId: string;
  survivor: AuthorityRecordSnapshot;
  loser: AuthorityRecordSnapshot;
  linkPlan: LinkPlan;
  userId: string;
  reason: string | null;
  now: number;
  /**
   * The acting member's IANA time zone (`requestTimeZone(request)`);
   * the provenance line's date is the day of `now` in this zone. A run
   * with no request behind it passes none and gets the default zone in
   * `app/lib/format.ts`.
   */
  timeZone?: string;
  /** Further keys for the ledger row's detail, after the standard ones. */
  detailExtra?: Record<string, unknown>;
  /** How a command line actor acted (`changelog.acted_as`); omitted for the app. */
  actedAs?: ChangelogActedAs | null;
  /**
   * Names left out of the survivor's variants after the fold: a reviewed
   * bulk merge drops transcription slips this way. The decisions surface
   * passes none, and every name folds.
   */
  excludeVariants?: ReadonlySet<string>;
  /**
   * The loser's function rows, in entry order, which move to the
   * survivor or fold into its rows. Entities only; omitted, or for a
   * place, nothing moves.
   */
  loserFunctions?: ReadonlyArray<EntityFunctionRow>;
  /** The survivor's function rows, in entry order, as read: what a loser's row may fold into. */
  survivorFunctions?: ReadonlyArray<EntityFunctionRow>;
}

/**
 * The merge itself, from rows already read: the planned link moves,
 * the loser's function rows (entities), the loser's `mergedInto` pointer (and, for an entity, its provenance
 * line), the name fold onto the survivor, a journal row for each, and
 * the ledger row — in that order. Returns the statements, the
 * survivor's `name_variants` after the fold and what became of the
 * loser's function rows (`functions`, with the survivor's rows after),
 * which a caller merging several losers into one survivor carries into
 * the next pair.
 */
export function composeMergeStatements(
  db: DrizzleD1Database<any>,
  c: MergeComposition,
): { statements: any[]; survivorVariants: string; functions: FunctionArrivals } {
  const { recordType, scope, survivor, loser, linkPlan, userId, reason, now } = c;
  const actedAs = c.actedAs ?? null;
  // Each record's new version is past the one read, whatever the clock.
  const versionOf = (r: AuthorityRecordSnapshot) =>
    r.updatedAt === undefined ? now : nextVersion(r.updatedAt, now);
  const loserVersion = versionOf(loser);
  const survivorVersion = versionOf(survivor);

  // Names fold unconditionally: the pair is one record, so every form
  // the loser answered to is a form of the survivor.
  const survivorVariants = JSON.stringify(
    Array.from(
      new Set([
        ...parseVariants(survivor.nameVariants),
        loser.displayName,
        ...parseVariants(loser.nameVariants),
      ]),
    ).filter((name) => !c.excludeVariants?.has(name)),
  );

  const day = formatIsoDateTime(now, c.timeZone).slice(0, 10);
  const sourceNote = `Merged into ${survivor.displayName} (${survivor.code}) on ${day}`;

  const table = recordType === "place" ? places : entities;
  // Places have no `sources` column, so the provenance line is written
  // only where there is somewhere to write it — computed once here so
  // the update and the journal row that records it cannot drift.
  const loserSources = loser.sources
    ? `${loser.sources}\n${sourceNote}`
    : sourceNote;
  const loserUpdate =
    recordType === "place"
      ? db
          .update(places)
          .set({ mergedInto: survivor.id, updatedAt: loserVersion })
          .where(and(scope, eq(places.id, loser.id)))
      : db
          .update(entities)
          .set({
            mergedInto: survivor.id,
            sources: loserSources,
            updatedAt: loserVersion,
          })
          .where(and(scope, eq(entities.id, loser.id)));

  // `updated_at` is deliberately absent from both diffs: it is a clock
  // stamp, not editorial content, and a revert that wrote an old
  // timestamp back would defeat the conflict test that reads it.
  const loserDiff: Record<string, { old: unknown; new: unknown }> = {
    mergedInto: { old: loser.mergedInto, new: survivor.id },
    ...(recordType === "place"
      ? {}
      : { sources: { old: loser.sources, new: loserSources } }),
  };

  // A loser's row of a function the survivor holds folds into it.
  const functions = planFunctionArrivals(
    recordType === "entity" ? (c.survivorFunctions ?? []) : [],
    recordType === "entity" ? (c.loserFunctions ?? []) : [],
  );
  const movedFunctions = functions.moved;

  const statements: any[] = [
    ...linkPlan.statements,
    ...arrivingEntityFunctions(db, loser.id, survivor.id, functions, scope, now),
    loserUpdate,
    composeJournalEntry(db, {
      recordId: loser.id,
      recordType,
      userId,
      actedAs,
      kind: "update",
      diff: loserDiff,
      note: reason,
      now,
    }),
    db
      .update(table as any)
      .set({ nameVariants: survivorVariants, updatedAt: survivorVersion })
      .where(and(scope, eq(table.id, survivor.id))),
    composeJournalEntry(db, {
      recordId: survivor.id,
      recordType,
      userId,
      actedAs,
      kind: "update",
      diff: {
        nameVariants: { old: survivor.nameVariants, new: survivorVariants },
      },
      note: reason,
      now,
    }),
    logAuthorityOperation(db, {
      federationId: c.federationId,
      recordType,
      operation: "merge",
      sourceId: loser.id,
      targetId: survivor.id,
      userId,
      // `addVariants` and `leftBehind` are constants on this surface —
      // names always fold, and none of the ruling tenant's links is left
      // behind — but they are written anyway so every merge ledger row
      // reads the same, whichever surface produced it. `leftBehind`
      // counts the ruling tenant's links only: other tenants' links on a
      // shared record stay on the record merged away (module header) and
      // are not counted.
      detail: {
        reason,
        movedLinks: linkPlan.movedLinks,
        droppedLinks: linkPlan.droppedLinks,
        addVariants: true,
        leftBehind: 0,
        ...(recordType === "entity" ? { movedFunctions, foldedFunctions: functions.folded } : {}),
        ...(c.detailExtra ?? {}),
      },
      now,
    }),
  ];
  return { statements, survivorVariants, functions };
}

/**
 * Rule a duplicate pair "merged": the loser keeps its page with
 * `mergedInto` set (the soft merge the workbench performs), every link
 * it held now belongs to the survivor, and the pair's decision row
 * records who ruled it and which record survived.
 *
 * Concurrency is 409s and nothing else. A record already merged away is
 * not a record this ruling may touch, a pair already ruled is settled,
 * and an entity edited between the ruling's reads and its batch fails
 * the batch — none is a conflict a "force" flag should be able to talk
 * its way past, which is why this surface, unlike the workbench,
 * carries no form-level optimistic lock.
 *
 * `timeZone` is the ruling member's zone, for the day written into the
 * loser's provenance line.
 *
 * An entity merge needs `evidenceInput`: the facts and the cited
 * descriptions the steward gave (`checkMergeEvidence`). Without them, or
 * with a citation not linked to its side, the merge is refused with a
 * 400 whose body is the `EvidenceError`, before anything is written. The
 * evidence goes into the ledger row's `detail.evidence`, and the batch
 * opens with a guard that every cited link is still there; a citation
 * removed in between fails the batch, answered as a 409 whose body is
 * `evidence_stale`. A place merge ignores `evidenceInput`.
 */
export async function rulePairMerge(
  db: DrizzleD1Database<any>,
  user: User,
  tenant: Tenant,
  recordType: AuthorityRecordType,
  survivorId: string,
  loserId: string,
  reason: string | null,
  now: number = Date.now(),
  timeZone?: string,
  evidenceInput?: MergeEvidenceInput,
): Promise<PairMergeResult> {
  const { authorityScope, requireAuthorityMutation } = await import(
    "./authority-ownership.server"
  );
  const { preparePairDecision } = await import("./pending-decisions.server");

  // A record cannot be its own duplicate, and letting the ids coincide
  // would classify every link as a self-collision and delete the lot.
  if (survivorId === loserId) {
    throw new Response("Cannot merge a record into itself", { status: 400 });
  }

  // A merge rewrites BOTH sides, so the pair rule applies exactly as it
  // does on the workbench: free-and-clear only when this tenant owns
  // the survivor and the loser alike.
  await requireAuthorityMutation(db, user, tenant, recordType, [
    survivorId,
    loserId,
  ]);

  const survivor = await loadRecord(db, tenant, recordType, survivorId);
  const loser = await loadRecord(db, tenant, recordType, loserId);
  if (!survivor || !loser) {
    throw new Response("Not found", { status: 404 });
  }
  if (survivor.mergedInto || loser.mergedInto) {
    throw new Response("Already merged", { status: 409 });
  }

  // An entity merge needs its evidence: a fact and a cited description
  // on each side, linked as read. A place merge takes none.
  let evidence: MergeEvidence | null = null;
  if (recordType === "entity") {
    const checked = await checkMergeEvidence(db, tenant.id, loserId, survivorId, evidenceInput ?? { facts: [], cited: [] });
    if (!checked.ok) throw new Response(checked.error, { status: 400 });
    evidence = checked.evidence;
  }

  // The link plan reads only, and refuses a collision before anything is
  // written: a refused merge files no decision row either.
  const linkPlan = await planLinkMoves(
    db,
    recordType,
    survivorId,
    loserId,
    user.id,
    now,
    tenant.id,
  );

  // The pair's decision row. On first contact its INSERT goes in the
  // merge's batch, so a merge refused there files no row either. The call
  // re-runs the mutation gate; that is a cheap read.
  const decision = await preparePairDecision(
    db,
    user,
    tenant,
    recordType,
    survivorId,
    loserId,
    now,
  );
  if (decision.existing?.status === "ruled") {
    throw new Response("Already ruled", { status: 409 });
  }

  const loserFunctions =
    recordType === "entity" ? await readEntityFunctionRows(db, loserId) : [];
  const survivorFunctions =
    recordType === "entity" ? await readEntityFunctionRows(db, survivorId) : [];

  const table = recordType === "place" ? places : entities;
  const { statements } = composeMergeStatements(db, {
    recordType,
    scope: authorityScope(table, tenant.federationId, tenant.id),
    federationId: tenant.federationId,
    survivor,
    loser,
    linkPlan,
    userId: user.id,
    reason,
    now,
    timeZone,
    loserFunctions,
    survivorFunctions,
    ...(evidence ? { detailExtra: { evidence } } : {}),
  });

  // An entity merge runs only while both records are as read: the
  // loser's rows are the ones the move names (module header).
  const asRead: EntityAsRead[] =
    recordType === "entity"
      ? [
          { id: loserId, version: loser.updatedAt!, unmerged: true, functionIds: loserFunctions.map((r) => r.id) },
          { id: survivorId, version: survivor.updatedAt!, unmerged: true, functionIds: survivorFunctions.map((r) => r.id) },
        ]
      : [];

  const incoming = linkPlan.incoming;
  const batch: any[] = [
    // The cited links are as read: one removed since fails the merge whole.
    ...(evidence ? [evidenceStillLinkedGuard(db, tenant.id, evidence)] : []),
    // The pair's decision row is as read: none, or the open row read. A
    // ruling filed in between fails the whole batch, merge included.
    db
      .select({ decision: failUnless(decision.asRead, "the pair was ruled since it was read") })
      .from(sql`(SELECT 1)`),
    ...(asRead.length > 0 ? [entitiesAsReadGuard(db, asRead)] : []),
    ...(incoming ? [incomingReferencesAsReadGuard(db, incoming)] : []),
    ...statements,
    ...(asRead.length > 0 ? [entityLeftWithoutFunctionsGuard(db, loserId)] : []),
    ...(decision.insert ? [decision.insert] : []),
    db
      .update(pendingDecisions)
      .set({
        status: "ruled",
        ruling: "merged",
        resultId: survivorId,
        rulingNote: reason,
        ruledBy: user.id,
        ruledAt: now,
      })
      .where(decision.key),
  ];

  try {
    await db.batch(batch as any);
  } catch (err) {
    if (evidence && !(await evidenceStillLinked(db, tenant.id, evidence))) {
      throw new Response("evidence_stale", { status: 409 });
    }
    if (
      !(await decision.stillAsRead()) ||
      (asRead.length > 0 && !(await entitiesStillAsRead(db, asRead))) ||
      (incoming && !(await incomingReferencesStillAsRead(db, incoming)))
    ) {
      throw new Response("Changed since read", { status: 409 });
    }
    throw err;
  }

  // The merge and its ruling have landed together; whoever filed the
  // pair can now be told how it was answered.
  const ruled = decision.existing ?? (await db.select().from(pendingDecisions).where(decision.key).get())!;
  const { enqueueDecisionNotifications } = await import(
    "./notifications.server"
  );
  await enqueueDecisionNotifications(db, {
    kind: "decision_ruled",
    decisionId: ruled.id,
    actorUserId: user.id,
    now,
  });

  return {
    decisionId: ruled.id,
    movedLinks: linkPlan.movedLinks,
    droppedLinks: linkPlan.droppedLinks.length,
  };
}

// @version v0.9.0
