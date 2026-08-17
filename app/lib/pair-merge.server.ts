/**
 * Pair merge — the decisions surface's "same record" ruling.
 *
 * The duplicates worklist puts one question to a flagged pair: are
 * these two records the same record? `rulePairMerge` is the answer
 * "yes", and it is deliberately NOT the merge workbench. The workbench
 * is a curation surface — the cataloguer picks which description links
 * travel, decides whether to fold the loser's names in, and carries an
 * optimistic lock because the comparison it renders may be minutes old.
 * A decision is a judgement about identity: once the pair is one
 * record, every link belongs to the survivor and every name the loser
 * answered to is a variant of the survivor's. So this path is
 * unselective by construction — all links, names always folded — and
 * the batch it writes is the workbench's batch with the choices removed.
 *
 * What it owns, in order: the pair mutation gate, the two 409s that are
 * this surface's whole concurrency story (a record already merged away,
 * a pair already ruled), the link repointing with the workbench's
 * per-link collision handling, the name fold, the loser's mergedInto
 * pointer and provenance line, the ledger row, and the decision ruling
 * itself — the last five in ONE `db.batch`, so a merge and the trail
 * recording it land together or not at all.
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
 * @version v0.7.0
 */

import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  descriptionEntities,
  descriptionPlaces,
  entities,
  pendingDecisions,
  places,
} from "../db/schema";
import type { AuthorityRecordType } from "./authority-ownership.server";
import { composeJournalEntry, linkDiff, unlinkDiff } from "./stewardship.server";
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
interface AuthorityRecordSnapshot {
  id: string;
  displayName: string;
  /** entity_code / place_code, carried into the provenance line. */
  code: string | null;
  nameVariants: string | null;
  mergedInto: string | null;
  sources: string | null;
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

/** A stored JSON name-variants array, defensively parsed (workbench rule). */
function parseVariants(json: string | null): string[] {
  try {
    return JSON.parse(json || "[]");
  } catch {
    return [];
  }
}

interface LinkPlan {
  statements: any[];
  /** Full content of every conflict-deleted junction row, for the ledger. */
  droppedLinks: unknown[];
  movedLinks: number;
}

/**
 * Resolve what happens to EVERY one of the loser's description links —
 * no client selection reaches this surface. Per link, the workbench's
 * rule: a survivor row already holding the same (descriptionId, role)
 * would collide with the junction table's unique index, so the loser's
 * row is captured in full and deleted; otherwise it is repointed. Two
 * reads total — the loser's links and the survivor's (descriptionId,
 * role) set — however many links the loser carries; the record with
 * hundreds of links is exactly the one this surface merges.
 *
 * Every statement it plans is followed by the journal row that records
 * it (module header): a dropped link is one `unlink`, a repointed link
 * is an `unlink` of the old content plus a `link` of the new. They ride
 * in the same `statements` array so the caller's single batch commits
 * effect and journal together without having to know which is which.
 */
async function planLinkMoves(
  db: DrizzleD1Database<any>,
  recordType: AuthorityRecordType,
  survivorId: string,
  loserId: string,
  userId: string,
  now: number,
): Promise<LinkPlan> {
  const statements: any[] = [];
  const droppedLinks: unknown[] = [];
  let movedLinks = 0;
  const held = (rows: Array<{ descriptionId: string; role: string | null }>) =>
    new Set(rows.map((r) => `${r.descriptionId}|${r.role ?? ""}`));

  if (recordType === "place") {
    const [links, survivorLinks] = await Promise.all([
      db
        .select()
        .from(descriptionPlaces)
        .where(eq(descriptionPlaces.placeId, loserId))
        .all(),
      db
        .select({
          descriptionId: descriptionPlaces.descriptionId,
          role: descriptionPlaces.role,
        })
        .from(descriptionPlaces)
        .where(eq(descriptionPlaces.placeId, survivorId))
        .all(),
    ]);
    const survivorHolds = held(survivorLinks);
    for (const link of links) {
      if (survivorHolds.has(`${link.descriptionId}|${link.role ?? ""}`)) {
        droppedLinks.push(link);
        statements.push(
          db.delete(descriptionPlaces).where(eq(descriptionPlaces.id, link.id)),
          composeJournalEntry(db, {
            recordId: link.descriptionId,
            recordType: "description",
            userId,
            kind: "unlink",
            diff: unlinkDiff(link),
            now,
          }),
        );
      } else {
        movedLinks += 1;
        statements.push(
          db
            .update(descriptionPlaces)
            .set({ placeId: survivorId })
            .where(eq(descriptionPlaces.id, link.id)),
          composeJournalEntry(db, {
            recordId: link.descriptionId,
            recordType: "description",
            userId,
            kind: "unlink",
            diff: unlinkDiff(link),
            now,
          }),
          composeJournalEntry(db, {
            recordId: link.descriptionId,
            recordType: "description",
            userId,
            kind: "link",
            diff: linkDiff({ ...link, placeId: survivorId }),
            now,
          }),
        );
      }
    }
    return { statements, droppedLinks, movedLinks };
  }

  const [links, survivorLinks] = await Promise.all([
    db
      .select()
      .from(descriptionEntities)
      .where(eq(descriptionEntities.entityId, loserId))
      .all(),
    db
      .select({
        descriptionId: descriptionEntities.descriptionId,
        role: descriptionEntities.role,
      })
      .from(descriptionEntities)
      .where(eq(descriptionEntities.entityId, survivorId))
      .all(),
  ]);
  const survivorHolds = held(survivorLinks);
  for (const link of links) {
    if (survivorHolds.has(`${link.descriptionId}|${link.role ?? ""}`)) {
      droppedLinks.push(link);
      statements.push(
        db.delete(descriptionEntities).where(eq(descriptionEntities.id, link.id)),
        composeJournalEntry(db, {
          recordId: link.descriptionId,
          recordType: "description",
          userId,
          kind: "unlink",
          diff: unlinkDiff(link),
          now,
        }),
      );
    } else {
      movedLinks += 1;
      statements.push(
        db
          .update(descriptionEntities)
          .set({ entityId: survivorId })
          .where(eq(descriptionEntities.id, link.id)),
        composeJournalEntry(db, {
          recordId: link.descriptionId,
          recordType: "description",
          userId,
          kind: "unlink",
          diff: unlinkDiff(link),
          now,
        }),
        composeJournalEntry(db, {
          recordId: link.descriptionId,
          recordType: "description",
          userId,
          kind: "link",
          diff: linkDiff({ ...link, entityId: survivorId }),
          now,
        }),
      );
    }
  }
  return { statements, droppedLinks, movedLinks };
}

/**
 * Rule a duplicate pair "merged": the loser keeps its page with
 * `mergedInto` set (the soft merge the workbench performs), every link
 * it held now belongs to the survivor, and the pair's decision row
 * records who ruled it and which record survived.
 *
 * Concurrency is two 409s and nothing else. A record already merged
 * away is not a record this ruling may touch, and a pair already ruled
 * is settled — neither is a conflict a "force" flag should be able to
 * talk its way past, which is why this surface, unlike the workbench,
 * carries no optimistic lock.
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
): Promise<PairMergeResult> {
  const { authorityScope, requireAuthorityMutation } = await import(
    "./authority-ownership.server"
  );
  const { logAuthorityOperation } = await import(
    "./authority-operations.server"
  );
  const { getOrCreatePairDecision } = await import("./pending-decisions.server");

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

  // The pair's decision row, filed open on first contact if this is it.
  // The call re-runs the mutation gate; that is a cheap read and the
  // alternative is a second copy of the get-or-create.
  const decision = await getOrCreatePairDecision(
    db,
    user,
    tenant,
    recordType,
    survivorId,
    loserId,
    now,
  );
  if (decision.status === "ruled") {
    throw new Response("Already ruled", { status: 409 });
  }

  const { statements, droppedLinks, movedLinks } = await planLinkMoves(
    db,
    recordType,
    survivorId,
    loserId,
    user.id,
    now,
  );

  // Names fold unconditionally: the pair is one record, so every form
  // the loser answered to is a form of the survivor.
  const survivorVariants = JSON.stringify(
    Array.from(
      new Set([
        ...parseVariants(survivor.nameVariants),
        loser.displayName,
        ...parseVariants(loser.nameVariants),
      ]),
    ),
  );

  const day = new Date(now).toISOString().slice(0, 10);
  const sourceNote = `Merged into ${survivor.displayName} (${survivor.code}) on ${day}`;

  const table = recordType === "place" ? places : entities;
  const scope = authorityScope(table, tenant.federationId, tenant.id);
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
          .set({ mergedInto: survivorId, updatedAt: now })
          .where(and(scope, eq(places.id, loserId)))
      : db
          .update(entities)
          .set({
            mergedInto: survivorId,
            sources: loserSources,
            updatedAt: now,
          })
          .where(and(scope, eq(entities.id, loserId)));

  // `updated_at` is deliberately absent from both diffs: it is a clock
  // stamp, not editorial content, and a revert that wrote an old
  // timestamp back would defeat the conflict test that reads it.
  const loserDiff: Record<string, { old: unknown; new: unknown }> = {
    mergedInto: { old: loser.mergedInto, new: survivorId },
    ...(recordType === "place"
      ? {}
      : { sources: { old: loser.sources, new: loserSources } }),
  };

  const batch: any[] = [
    ...statements,
    loserUpdate,
    composeJournalEntry(db, {
      recordId: loserId,
      recordType,
      userId: user.id,
      kind: "update",
      diff: loserDiff,
      note: reason,
      now,
    }),
    db
      .update(table as any)
      .set({ nameVariants: survivorVariants, updatedAt: now })
      .where(and(scope, eq(table.id, survivorId))),
    composeJournalEntry(db, {
      recordId: survivorId,
      recordType,
      userId: user.id,
      kind: "update",
      diff: {
        nameVariants: { old: survivor.nameVariants, new: survivorVariants },
      },
      note: reason,
      now,
    }),
    logAuthorityOperation(db, {
      federationId: tenant.federationId,
      recordType,
      operation: "merge",
      sourceId: loserId,
      targetId: survivorId,
      userId: user.id,
      // `addVariants` and `leftBehind` are constants on this surface —
      // names always fold, and no link is ever left behind — but they
      // are written anyway so every merge ledger row reads the same,
      // whichever surface produced it.
      detail: {
        reason,
        movedLinks,
        droppedLinks,
        addVariants: true,
        leftBehind: 0,
      },
      now,
    }),
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
      .where(eq(pendingDecisions.id, decision.id)),
  ];

  await db.batch(batch as any);

  // The merge and its ruling have landed together; whoever filed the
  // pair can now be told how it was answered.
  const { enqueueDecisionNotifications } = await import(
    "./notifications.server"
  );
  await enqueueDecisionNotifications(db, {
    kind: "decision_ruled",
    decisionId: decision.id,
    actorUserId: user.id,
    now,
  });

  return {
    decisionId: decision.id,
    movedLinks,
    droppedLinks: droppedLinks.length,
  };
}
