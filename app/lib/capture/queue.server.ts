/**
 * Digitization Queue — Reads and Writes
 *
 * This module deals with a workspace's digitization queue: what it
 * holds, how it is read for the queue screen and for the Captua unit,
 * and every change a person makes to it. Every read and write is scoped
 * to the tenant passed in; who may call these is decided by the routes
 * (the digitization capability, then `captureAccess(...).worker`).
 *
 * WHAT THE QUEUE HOLDS. Two kinds of item, read together by
 * `loadQueueItems`:
 *
 *   - entries: descriptions someone added (`origin` 'queue'), one row
 *     each in `capture_queue_entries`, withdrawn rather than deleted;
 *   - retakes: every volume with rejected openings not yet approved or
 *     excluded again, read as the Retakes screen reads them, in one
 *     batch for the whole tenant (`readRetakeVolumes`).
 *     A retake is not stored: it enters the queue when capture QC
 *     rejects an opening and leaves it when the last retake is approved
 *     or excluded, with nothing to keep in step. A row is written for it
 *     only to hold what a person or the unit adds (an assignment, a note,
 *     an acknowledgement), with `origin` 'retake' and the pipeline
 *     volume's id as its id (`ensureRetakeRow`), so the item keeps one
 *     id before and after. Such a row is shown and served only while
 *     retakes are outstanding. A description already in the queue
 *     carries its volume's retakes on its own entry, so a reference code
 *     is never two items. While a volume has retakes its item's job is
 *     `spot-recapture` and it carries the rejected openings (Captua
 *     record id, pair id and the side the rejection names, in sequence
 *     order), whatever job its
 *     entry was given. The
 *     capture manifest does not say who captured a volume, so a retake
 *     starts unassigned.
 *
 * Each item's state is read by `queueStateOf` (`queue.ts`) from its
 * retakes, its reference code's handover (`loadReferenceScreenStates`)
 * and the unit's acknowledgement. Retakes come first, then entries by
 * position.
 *
 * WRITES. Every write stamps `changed_at` with a value strictly greater
 * than any stamp the tenant's entries carry (`STAMP`), so the largest
 * stamp orders the queue's revisions (`queue-link.server.ts`).
 *
 *   - `addToQueue` adds descriptions of the tenant at the end, in the
 *     order given, skipping any already queued and not withdrawn. A new
 *     row takes the description's pipeline volume id when it has one, so
 *     a retake served before it had a row keeps its item id. A withdrawn
 *     entry becomes live again on the same row, with the unit's
 *     acknowledgement cleared and `revived_stamp` set, so an
 *     acknowledgement under a revision served before cannot restore it, and a retake's row becomes a 'queue'
 *     entry. At most `MAX_ADD` at once.
 *   - `subtreeToQueue` gives the descriptions "add everything below this"
 *     adds: on each branch, the deepest volume- or file-level
 *     description. A volume or file with volume or file descriptions
 *     beneath it gives those (a box at file level gives its folders); one
 *     with none, only items or no children, gives itself. Item-level
 *     descriptions are never given, and other levels (fonds, series,
 *     sections, collections) are walked through and never given. The
 *     starting description is given only when the rule picks it. At most
 *     `MAX_BELOW` (`below-limit` past it); `pickBelow` counts the same
 *     picks and stops at one past the limit, and `countBelow` turns that
 *     into the number an "add the N below this" button shows, or null
 *     when there is no such button (none below, the description itself
 *     picked, or more than `MAX_BELOW`).
 *   - `handlistToQueue` gives what a records handlist's members resolve to
 *     now, in the handlist's order, leaving out a deleted one.
 *   - "Add every result" on the search page's Records tab resolves the
 *     whole matching set in the search route's action and adds it here,
 *     at most `MAX_RESULTS`, the bound "add everything below this" has.
 *   - `moveEntry` swaps an entry with the next live entry above or below.
 *   - `assignItems` assigns items to a scanner of the tenant and,
 *     optionally, one of its active operators, or unassigns them.
 *   - `setItemJob` sets an item's job and note.
 *   - `withdrawEntries` withdraws entries; an item with retakes
 *     outstanding cannot be withdrawn (`retakes`).
 *
 * EXPORT. `digitisationList` writes items as the contract §3
 * digitisation-list file, for a unit without the link: the envelope
 * (version 1.4, since items carry `action`), the list named after the
 * workspace with its repository code when every item shares one, and
 * each item numbered in the order given, with `typology` and
 * `expectedImages` null, since Fisqua holds neither.
 *
 * Refusals are thrown as `QueueError` with a code the routes map to a
 * status and the screen to a sentence.
 *
 * @version v0.9.0
 */

import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  captureDeliveries,
  captureQueueEntries,
  captureScannerOperators,
  captureScanners,
  descriptions,
  pipelineVolumes,
  repositories,
  users,
} from "../../db/schema";
import packageJson from "../../../package.json";
import type { Tenant, User } from "../../context";
import type { CaptureQueueAction } from "../validation/enums";
import { readStoredRecords } from "./link.server";
import { qcStatusOf } from "./manifest";
import { loadReferenceScreenStates } from "./screens.server";
import { containerLevelOf, queueStateOf, type ContainerLevel, type QueueState } from "./queue";

/** Descriptions one add may put in the queue. */
export const MAX_ADD = 5000;
/** Descriptions "add everything below this" may add at once. */
export const MAX_BELOW = 50;
/** Search results "add every result" may add at once: the same bound as `MAX_BELOW`. */
export const MAX_RESULTS = MAX_BELOW;
/** The longest note an entry keeps. */
export const MAX_QUEUE_NOTE = 2000;
/** Ids per `IN (...)` read, under D1's 100 bound parameters. */
const READ_CHUNK = 50;
/** Ids per JSON-bound write. */
const WRITE_CHUNK = 500;

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

export type QueueErrorCode = "not-found" | "operator" | "retakes" | "ceiling" | "below-limit" | "invalid";

export class QueueError extends Error {
  constructor(public code: QueueErrorCode) {
    super(code);
  }
}

export interface QueueDeps {
  db: DrizzleD1Database<any>;
  now: () => number;
  newId: () => string;
}

/** A stamp strictly later than every stamp the tenant's entries carry. */
function STAMP(tenantId: string, now: number): SQL {
  return sql`(SELECT MAX(${now}, COALESCE(MAX(s.changed_at), 0) + 1) FROM capture_queue_entries s WHERE s.tenant_id = ${tenantId})`;
}

function NEXT_POSITION(tenantId: string): SQL {
  return sql`(SELECT COALESCE(MAX(p.position), 0) FROM capture_queue_entries p WHERE p.tenant_id = ${tenantId})`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface RetakePair {
  captuaRecordId: number;
  /** The opening's pair id; null for a single-image opening, which has none. */
  pairId: string | null;
  /** The image the rejection asks to retake: the decision's side, or `both` when it gives none. */
  side: "left" | "right" | "both";
}

interface RetakeVolume {
  volumeId: string;
  descriptionId: string;
  referenceCode: string;
  askedAt: number;
  retakes: RetakePair[];
}

/**
 * The volumes the Retakes screen lists, as a SQL condition on the
 * registered delivery `d`: no run has named its volume, and its own
 * decision set, or a superseded delivery's, rejected an opening.
 */
function retakeCandidate(tenantId: string, only: SQL = sql``): SQL {
  return sql`d.tenant_id = ${tenantId} AND d.state = 'registered' AND d.pipeline_volume_id IS NOT NULL ${only}
    AND NOT EXISTS (SELECT 1 FROM pipeline_run_volumes rv WHERE rv.tenant_id = ${tenantId}
      AND rv.pipeline_volume_id = d.pipeline_volume_id)
    AND (EXISTS (SELECT 1 FROM capture_qc_sets rs WHERE rs.tenant_id = ${tenantId}
          AND rs.delivery_id = d.id AND rs.rejected_count > 0)
      OR EXISTS (SELECT 1 FROM capture_qc_sets es JOIN capture_deliveries ed ON ed.tenant_id = ${tenantId}
            AND ed.id = es.delivery_id
          WHERE es.tenant_id = ${tenantId} AND es.rejected_count > 0
            AND ed.pipeline_volume_id = d.pipeline_volume_id AND ed.state = 'superseded'))`;
}

/** Records per statement when reading current deliveries' record lists. */
const RECORDS_CHUNK = 10;

/**
 * Every volume with retakes outstanding, with each rejected opening's
 * pair id and side, in a fixed number of statements however many
 * volumes there are (plus one per `READ_CHUNK` volumes for pair ids and
 * one per `RECORDS_CHUNK` volumes with retakes for their current record
 * lists).
 *
 * It reads what the Retakes screen reads (`readVolumeRetakes`), keeping
 * only whether an opening is outstanding: an opening is a retake when
 * its current decision is a rejection, or when it has no current
 * decision and its latest earlier decision (of the volume's superseded
 * deliveries) is a rejection, unless the current manifest gives the
 * record as `excluded` (`qcStatusOf`, which reads a placeholder closed
 * with no image as `excluded`). The side is the rejecting decision's,
 * `both` when it gives none. A volume's retakes are in its order: by the
 * record's `sequence` in the current manifest, any record it does not
 * hold last, ties by record id. `volumeIds` limits the read to those volumes, bound
 * as one JSON value; `pairs: false` skips the pair ids.
 */
export async function readRetakeVolumes(
  db: DrizzleD1Database<any>,
  tenantId: string,
  opts: { volumeIds?: string[]; pairs?: boolean } = {},
): Promise<RetakeVolume[]> {
  if (opts.volumeIds && opts.volumeIds.length === 0) return [];
  const only = opts.volumeIds
    ? sql`AND d.pipeline_volume_id IN (SELECT value FROM json_each(${JSON.stringify(opts.volumeIds)}))`
    : sql``;
  const candidates = await db.all<{ deliveryId: string; volumeId: string; referenceCode: string; descriptionId: string }>(sql`
    SELECT d.id AS deliveryId, v.id AS volumeId, v.reference_code AS referenceCode, v.description_id AS descriptionId
    FROM capture_deliveries d JOIN pipeline_volumes v ON v.tenant_id = d.tenant_id AND v.id = d.pipeline_volume_id
    WHERE d.tenant_id = ${tenantId} AND v.tenant_id = ${tenantId} AND ${retakeCandidate(tenantId, only)}
    ORDER BY v.reference_code`);
  if (candidates.length === 0) return [];

  type D = { key: string; recordId: number; decision: string; side: string | null; decidedAt: number };
  const current = await db.all<D>(sql`
    SELECT q.delivery_id AS key, q.captua_record_id AS recordId, q.decision AS decision, q.side AS side,
      q.decided_at AS decidedAt
    FROM capture_qc_decisions q
    WHERE q.tenant_id = ${tenantId} AND q.delivery_id IN (SELECT d.id FROM capture_deliveries d
      WHERE d.tenant_id = ${tenantId} AND ${retakeCandidate(tenantId, only)})`);
  // Newest superseded delivery first, so a record's first row is its latest earlier decision.
  const earlier = await db.all<D>(sql`
    SELECT ed.pipeline_volume_id AS key, q.captua_record_id AS recordId, q.decision AS decision, q.side AS side,
      q.decided_at AS decidedAt
    FROM capture_qc_decisions q JOIN capture_deliveries ed ON ed.tenant_id = q.tenant_id AND ed.id = q.delivery_id
    WHERE q.tenant_id = ${tenantId} AND ed.state = 'superseded'
      AND ed.pipeline_volume_id IN (SELECT d.pipeline_volume_id FROM capture_deliveries d
        WHERE d.tenant_id = ${tenantId} AND ${retakeCandidate(tenantId, only)})
    ORDER BY ed.seq DESC`);

  const currentOf = new Map<string, Map<number, D>>();
  for (const d of current) {
    const m = currentOf.get(d.key) ?? new Map<number, D>();
    m.set(d.recordId, d);
    currentOf.set(d.key, m);
  }
  const earlierOf = new Map<string, Map<number, D>>();
  for (const d of earlier) {
    const m = earlierOf.get(d.key) ?? new Map<number, D>();
    if (!m.has(d.recordId)) m.set(d.recordId, d);
    earlierOf.set(d.key, m);
  }

  // Each candidate's outstanding rejections, and which come from earlier deliveries.
  const outstanding = new Map<string, D[]>();
  const fromEarlier = new Map<string, Set<number>>();
  for (const c of candidates) {
    const cur = currentOf.get(c.deliveryId) ?? new Map<number, D>();
    const list: D[] = [];
    for (const d of cur.values()) if (d.decision === "rejected") list.push(d);
    for (const [recordId, e] of earlierOf.get(c.volumeId) ?? new Map<number, D>()) {
      if (e.decision !== "rejected" || cur.has(recordId)) continue;
      list.push(e);
      const set = fromEarlier.get(c.deliveryId) ?? new Set<number>();
      set.add(recordId);
      fromEarlier.set(c.deliveryId, set);
    }
    outstanding.set(c.deliveryId, list);
  }

  // The current manifest's records, read only for deliveries with a
  // retake outstanding: their sequences, which order the retakes, and
  // the records read as excluded (`qcStatusOf`: excluded on the unit, or
  // a placeholder closed with no image).
  const excluded = new Map<string, Set<number>>();
  const sequenceOf = new Map<string, Map<number, number>>();
  const withRetakes = [...outstanding.entries()].filter(([, list]) => list.length > 0).map(([id]) => id);
  for (const part of chunks(withRetakes, RECORDS_CHUNK)) {
    const rows = await db
      .select({ id: captureDeliveries.id, records: captureDeliveries.records })
      .from(captureDeliveries)
      .where(and(eq(captureDeliveries.tenantId, tenantId), inArray(captureDeliveries.id, part)))
      .all();
    for (const r of rows) {
      const records = await readStoredRecords(r.records);
      excluded.set(r.id, new Set(records.filter((x) => qcStatusOf(x) === "excluded").map((x) => x.captuaRecordId)));
      sequenceOf.set(r.id, new Map(records.map((x) => [x.captuaRecordId, x.sequence])));
    }
  }

  const volumes = candidates
    .map((c) => ({
      c,
      rows: (outstanding.get(c.deliveryId) ?? []).filter(
        (d) => !(fromEarlier.get(c.deliveryId)?.has(d.recordId) && excluded.get(c.deliveryId)?.has(d.recordId)),
      ),
    }))
    .filter((v) => v.rows.length > 0);

  const pairs = new Map<string, Map<number, string | null>>();
  for (const part of chunks(opts.pairs === false ? [] : volumes.map((v) => v.c.volumeId), READ_CHUNK)) {
    // Newest delivery first, so a record's pair id is its latest.
    const images = await db.all<{ volumeId: string; recordId: number; pairId: string | null }>(sql`
      SELECT d.pipeline_volume_id AS volumeId, i.captua_record_id AS recordId, i.pair_id AS pairId
      FROM capture_images i JOIN capture_deliveries d ON d.tenant_id = i.tenant_id AND d.id = i.delivery_id
      WHERE i.tenant_id = ${tenantId} AND d.pipeline_volume_id IN (${sql.join(part.map((id) => sql`${id}`), sql`, `)})
      ORDER BY d.seq DESC`);
    for (const img of images) {
      const byRecord = pairs.get(img.volumeId) ?? new Map<number, string | null>();
      if (!byRecord.has(img.recordId) || (byRecord.get(img.recordId) === null && img.pairId !== null)) {
        byRecord.set(img.recordId, img.pairId);
      }
      pairs.set(img.volumeId, byRecord);
    }
  }

  const sideOf = (side: string | null): RetakePair["side"] => (side === "left" || side === "right" ? side : "both");
  // In the volume's order (contract §10.2): by the record's sequence in
  // the current manifest, a record it does not hold after every one it
  // does, ties by record id.
  return volumes.map(({ c, rows }) => {
    const seq = sequenceOf.get(c.deliveryId) ?? new Map<number, number>();
    const at = (id: number) => seq.get(id) ?? Number.MAX_SAFE_INTEGER;
    return {
      volumeId: c.volumeId,
      descriptionId: c.descriptionId,
      referenceCode: c.referenceCode,
      askedAt: Math.min(...rows.map((r) => r.decidedAt)),
      retakes: rows
        .map((r) => ({
          captuaRecordId: r.recordId,
          pairId: pairs.get(c.volumeId)?.get(r.recordId) ?? null,
          side: sideOf(r.side),
        }))
        .sort((a, b) => at(a.captuaRecordId) - at(b.captuaRecordId) || a.captuaRecordId - b.captuaRecordId),
    };
  });
}

export interface QueueItem {
  /** The entry's id, or the pipeline volume's for a retake with no row. */
  id: string;
  /** Whether a row holds the item. */
  stored: boolean;
  origin: "queue" | "retake";
  descriptionId: string;
  referenceCode: string;
  title: string;
  level: string;
  position: number;
  /** The job the unit is told: `spot-recapture` while retakes are outstanding. */
  action: CaptureQueueAction;
  /** The job set on the entry. */
  entryAction: CaptureQueueAction;
  note: string | null;
  scannerId: string | null;
  assignee: string | null;
  addedAt: number;
  addedByName: string | null;
  withdrawnAt: number | null;
  ackedRevision: number | null;
  skippedReason: string | null;
  retakes: RetakePair[];
  state: QueueState;
}

/**
 * Every item of the tenant's queue, withdrawn entries included (with
 * `withdrawnAt` set), retakes first, then entries by position.
 */
export async function loadQueueItems(db: DrizzleD1Database<any>, tenantId: string, now: number): Promise<QueueItem[]> {
  const rows = await db
    .select({
      id: captureQueueEntries.id,
      origin: captureQueueEntries.origin,
      descriptionId: captureQueueEntries.descriptionId,
      position: captureQueueEntries.position,
      action: captureQueueEntries.action,
      note: captureQueueEntries.note,
      scannerId: captureQueueEntries.scannerId,
      assignee: captureQueueEntries.assigneeUsername,
      addedAt: captureQueueEntries.addedAt,
      addedByName: users.name,
      withdrawnAt: captureQueueEntries.withdrawnAt,
      appliedAt: captureQueueEntries.appliedAt,
      skippedAt: captureQueueEntries.skippedAt,
      skippedReason: captureQueueEntries.skippedReason,
      ackedRevision: captureQueueEntries.ackedRevision,
      referenceCode: descriptions.referenceCode,
      title: descriptions.title,
      level: descriptions.descriptionLevel,
    })
    .from(captureQueueEntries)
    .innerJoin(
      descriptions,
      and(eq(descriptions.tenantId, tenantId), eq(descriptions.id, captureQueueEntries.descriptionId)),
    )
    .leftJoin(users, eq(users.id, captureQueueEntries.addedBy))
    .where(eq(captureQueueEntries.tenantId, tenantId))
    .orderBy(asc(captureQueueEntries.position))
    .all();

  const retakeVolumes = await readRetakeVolumes(db, tenantId);
  const retakesOf = new Map(retakeVolumes.map((r) => [r.descriptionId, r]));
  const stored = new Set(rows.map((r) => r.descriptionId));
  const orphans = retakeVolumes.filter((r) => !stored.has(r.descriptionId));
  const orphanDescriptions = new Map<string, { title: string; level: string }>();
  for (const part of chunks(orphans.map((o) => o.descriptionId), READ_CHUNK)) {
    const found = await db
      .select({ id: descriptions.id, title: descriptions.title, level: descriptions.descriptionLevel })
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, tenantId), inArray(descriptions.id, part)))
      .all();
    for (const d of found) orphanDescriptions.set(d.id, d);
  }

  const handovers = await loadReferenceScreenStates(db, tenantId, rows.map((r) => r.referenceCode), now);

  const items: QueueItem[] = [];
  for (const o of orphans) {
    const d = orphanDescriptions.get(o.descriptionId);
    if (!d) continue;
    items.push({
      id: o.volumeId,
      stored: false,
      origin: "retake",
      descriptionId: o.descriptionId,
      referenceCode: o.referenceCode,
      title: d.title,
      level: d.level,
      position: 0,
      action: "spot-recapture",
      entryAction: "spot-recapture",
      note: null,
      scannerId: null,
      assignee: null,
      addedAt: o.askedAt,
      addedByName: null,
      withdrawnAt: null,
      ackedRevision: null,
      skippedReason: null,
      retakes: o.retakes,
      state: "retakes_requested",
    });
  }
  for (const r of rows) {
    const retake = retakesOf.get(r.descriptionId);
    if (r.origin === "retake" && !retake) continue;
    items.push({
      id: r.id,
      stored: true,
      origin: r.origin,
      descriptionId: r.descriptionId,
      referenceCode: r.referenceCode,
      title: r.title,
      level: r.level,
      position: r.position,
      action: retake ? "spot-recapture" : r.action,
      entryAction: r.action,
      note: r.note,
      scannerId: r.scannerId,
      assignee: r.assignee,
      addedAt: r.addedAt,
      addedByName: r.addedByName ?? null,
      // Retakes outstanding keep an item in the queue whatever was withdrawn.
      withdrawnAt: retake ? null : r.withdrawnAt,
      ackedRevision: r.ackedRevision,
      skippedReason: r.skippedReason,
      retakes: retake?.retakes ?? [],
      state: queueStateOf({
        addedAt: r.addedAt,
        appliedAt: r.appliedAt,
        skippedAt: r.skippedAt,
        retakes: retake !== undefined,
        handover: handovers.get(r.referenceCode) ?? null,
      }),
    });
  }
  const first = (i: QueueItem) => (i.retakes.length > 0 ? 0 : 1);
  return items.sort(
    (a, b) =>
      first(a) - first(b) ||
      (first(a) === 0 ? a.referenceCode.localeCompare(b.referenceCode) : a.position - b.position),
  );
}

export interface ItemDetails {
  referenceCode: string;
  title: string;
  dates: { display: string | null; start: string | null; end: string | null };
  extent: string | null;
  repositoryCode: string | null;
  containerPath: Array<{ level: ContainerLevel; title: string; referenceCode: string | null }>;
}

/**
 * A description's dates as the contract gives them: the date expression
 * to display, and the normalized start and end. The digitisation-list
 * file, the queue served to the unit and the reference-code lookup all
 * give them this way.
 */
export function contractDates(d: {
  dateExpression: string | null;
  dateStart: string | null;
  dateEnd: string | null;
}): ItemDetails["dates"] {
  return { display: d.dateExpression, start: d.dateStart, end: d.dateEnd };
}

/** The contract §3 fields of each description: its own, and its ancestors' as `containerPath`, root first. */
export async function readItemDetails(
  db: DrizzleD1Database<any>,
  tenantId: string,
  descriptionIds: string[],
): Promise<Map<string, ItemDetails>> {
  type Row = {
    id: string;
    parentId: string | null;
    level: string;
    referenceCode: string;
    title: string;
    dateExpression: string | null;
    dateStart: string | null;
    dateEnd: string | null;
    extent: string | null;
    repositoryCode: string | null;
  };
  const known = new Map<string, Row>();
  let wanted = [...new Set(descriptionIds)];
  while (wanted.length > 0) {
    const next: string[] = [];
    for (const part of chunks(wanted, READ_CHUNK)) {
      const rows = await db
        .select({
          id: descriptions.id,
          parentId: descriptions.parentId,
          level: descriptions.descriptionLevel,
          referenceCode: descriptions.referenceCode,
          title: descriptions.title,
          dateExpression: descriptions.dateExpression,
          dateStart: descriptions.dateStart,
          dateEnd: descriptions.dateEnd,
          extent: descriptions.extent,
          repositoryCode: repositories.code,
        })
        .from(descriptions)
        .leftJoin(repositories, eq(repositories.id, descriptions.repositoryId))
        .where(and(eq(descriptions.tenantId, tenantId), inArray(descriptions.id, part)))
        .all();
      for (const r of rows) {
        known.set(r.id, r);
        if (r.parentId && !known.has(r.parentId)) next.push(r.parentId);
      }
    }
    wanted = [...new Set(next)].filter((id) => !known.has(id));
  }
  const out = new Map<string, ItemDetails>();
  for (const id of descriptionIds) {
    const d = known.get(id);
    if (!d) continue;
    const path: ItemDetails["containerPath"] = [];
    const seen = new Set<string>([id]);
    let parent = d.parentId ? known.get(d.parentId) : undefined;
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      path.unshift({ level: containerLevelOf(parent.level), title: parent.title, referenceCode: parent.referenceCode });
      parent = parent.parentId ? known.get(parent.parentId) : undefined;
    }
    out.set(id, {
      referenceCode: d.referenceCode,
      title: d.title,
      dates: contractDates(d),
      extent: d.extent,
      repositoryCode: d.repositoryCode,
      containerPath: path,
    });
  }
  return out;
}

export interface OperatorOption {
  scannerId: string;
  scannerName: string;
  username: string;
  displayName: string;
  active: boolean;
}

/** Every operator the tenant's scanners sent, active ones first. */
export async function loadOperators(db: DrizzleD1Database<any>, tenantId: string): Promise<OperatorOption[]> {
  const rows = await db
    .select({
      scannerId: captureScannerOperators.scannerId,
      scannerName: captureScanners.name,
      username: captureScannerOperators.username,
      displayName: captureScannerOperators.displayName,
      active: captureScannerOperators.active,
    })
    .from(captureScannerOperators)
    .innerJoin(
      captureScanners,
      and(eq(captureScanners.tenantId, tenantId), eq(captureScanners.id, captureScannerOperators.scannerId)),
    )
    .where(eq(captureScannerOperators.tenantId, tenantId))
    .orderBy(asc(captureScannerOperators.username))
    .all();
  return rows.sort((a, b) => Number(b.active) - Number(a.active));
}

/** The tenant's scanners, by name, with the mode each last reported. */
export async function loadScanners(db: DrizzleD1Database<any>, tenantId: string) {
  return db
    .select({
      id: captureScanners.id,
      name: captureScanners.name,
      mode: captureScanners.mode,
      revokedAt: captureScanners.revokedAt,
    })
    .from(captureScanners)
    .where(eq(captureScanners.tenantId, tenantId))
    .orderBy(asc(captureScanners.name))
    .all();
}

// ---------------------------------------------------------------------------
// Adding
// ---------------------------------------------------------------------------

export interface AddResult {
  added: number;
  alreadyQueued: number;
}

export async function addToQueue(
  deps: QueueDeps,
  tenant: Tenant,
  user: Pick<User, "id">,
  descriptionIds: string[],
): Promise<AddResult> {
  const ids = [...new Set(descriptionIds)];
  if (ids.length > MAX_ADD) throw new QueueError("ceiling");
  if (ids.length === 0) return { added: 0, alreadyQueued: 0 };
  const { db } = deps;

  const existing = new Set<string>();
  const live = new Set<string>();
  for (const part of chunks(ids, READ_CHUNK)) {
    const found = await db
      .select({ id: descriptions.id })
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, tenant.id), inArray(descriptions.id, part)))
      .all();
    for (const d of found) existing.add(d.id);
    const queued = await db
      .select({ descriptionId: captureQueueEntries.descriptionId })
      .from(captureQueueEntries)
      .where(
        and(
          eq(captureQueueEntries.tenantId, tenant.id),
          inArray(captureQueueEntries.descriptionId, part),
          sql`${captureQueueEntries.withdrawnAt} IS NULL`,
          eq(captureQueueEntries.origin, "queue"),
        ),
      )
      .all();
    for (const q of queued) live.add(q.descriptionId);
  }
  const toAdd = ids.filter((id) => existing.has(id) && !live.has(id));
  if (existing.size === 0) throw new QueueError("not-found");

  // A description with a pipeline volume takes the volume's id, the id a
  // retake of it is served under before it has a row.
  const volumeOf = new Map<string, string>();
  for (const part of chunks(toAdd, READ_CHUNK)) {
    const found = await db
      .select({ id: pipelineVolumes.id, descriptionId: pipelineVolumes.descriptionId })
      .from(pipelineVolumes)
      .where(and(eq(pipelineVolumes.tenantId, tenant.id), inArray(pipelineVolumes.descriptionId, part)))
      .all();
    for (const v of found) volumeOf.set(v.descriptionId, v.id);
  }
  const now = deps.now();
  for (const part of chunks(toAdd, WRITE_CHUNK)) {
    const rows = JSON.stringify(
      part.map((descriptionId, i) => ({ id: volumeOf.get(descriptionId) ?? deps.newId(), descriptionId, i })),
    );
    await db.run(sql`
      INSERT INTO capture_queue_entries
        (id, tenant_id, description_id, position, origin, action, added_by, added_at, changed_at)
      SELECT json_extract(j.value, '$.id'), ${tenant.id}, json_extract(j.value, '$.descriptionId'),
        ${NEXT_POSITION(tenant.id)} + 1 + json_extract(j.value, '$.i'), 'queue', 'full-digitisation',
        ${user.id}, ${now}, ${STAMP(tenant.id, now)}
      FROM json_each(${rows}) j WHERE true
      ON CONFLICT (tenant_id, description_id) DO UPDATE SET
        origin = 'queue',
        applied_at = CASE WHEN capture_queue_entries.withdrawn_at IS NULL THEN capture_queue_entries.applied_at END,
        collection_id = CASE WHEN capture_queue_entries.withdrawn_at IS NULL THEN capture_queue_entries.collection_id END,
        skipped_at = CASE WHEN capture_queue_entries.withdrawn_at IS NULL THEN capture_queue_entries.skipped_at END,
        skipped_reason = CASE WHEN capture_queue_entries.withdrawn_at IS NULL THEN capture_queue_entries.skipped_reason END,
        acked_revision = CASE WHEN capture_queue_entries.withdrawn_at IS NULL THEN capture_queue_entries.acked_revision END,
        revived_stamp = CASE WHEN capture_queue_entries.withdrawn_at IS NULL THEN capture_queue_entries.revived_stamp
          ELSE excluded.changed_at END,
        withdrawn_at = NULL,
        position = excluded.position,
        added_by = excluded.added_by,
        added_at = excluded.added_at,
        changed_at = excluded.changed_at
      WHERE capture_queue_entries.withdrawn_at IS NOT NULL OR capture_queue_entries.origin = 'retake'`);
  }
  return { added: toAdd.length, alreadyQueued: ids.filter((id) => live.has(id)).length };
}

const CAPTURED_LEVELS = new Set(["volume", "file"]);

/**
 * What "add everything below this" picks under a description, as
 * `subtreeToQueue` would add it (module header), read level by level and
 * stopping once more than `limit` are picked. A volume or file found
 * becomes a pick and disqualifies every volume or file above it, so the
 * number of picks never falls as the walk goes deeper; once it passes
 * `limit` the answer is `more` and the walk stops, so a fonds with
 * thousands below costs a few reads. Item-level descriptions are never
 * read.
 */
export async function pickBelow(
  db: DrizzleD1Database<any>,
  tenantId: string,
  descriptionId: string,
  limit: number,
): Promise<{ ids: string[]; more: boolean }> {
  const start = await db
    .select({ id: descriptions.id, level: descriptions.descriptionLevel, childCount: descriptions.childCount })
    .from(descriptions)
    .where(and(eq(descriptions.tenantId, tenantId), eq(descriptions.id, descriptionId)))
    .get();
  if (!start) throw new QueueError("not-found");
  if (start.level === "item") return { ids: [], more: false };

  const parentOf = new Map<string, string | null>([[start.id, null]]);
  const levelOf = new Map<string, string>([[start.id, start.level]]);
  // Picks in the order found; a disqualified one is deleted.
  const picks = new Set<string>();
  if (CAPTURED_LEVELS.has(start.level)) picks.add(start.id);
  let frontier = start.childCount > 0 ? [start.id] : [];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const part of chunks(frontier, READ_CHUNK)) {
      const children = await db
        .select({
          id: descriptions.id,
          parentId: descriptions.parentId,
          level: descriptions.descriptionLevel,
          childCount: descriptions.childCount,
        })
        .from(descriptions)
        .where(
          and(
            eq(descriptions.tenantId, tenantId),
            inArray(descriptions.parentId, part),
            sql`${descriptions.descriptionLevel} <> 'item'`,
          ),
        )
        .orderBy(asc(descriptions.parentId), asc(descriptions.position))
        .all();
      for (const c of children) {
        if (parentOf.has(c.id)) continue;
        parentOf.set(c.id, c.parentId);
        levelOf.set(c.id, c.level);
        if (CAPTURED_LEVELS.has(c.level)) {
          picks.add(c.id);
          // Every volume or file above it is no longer the deepest.
          for (let up = c.parentId; up !== null && up !== undefined; up = parentOf.get(up) ?? null) {
            if (CAPTURED_LEVELS.has(levelOf.get(up) ?? "")) picks.delete(up);
          }
        }
        if (c.childCount > 0) next.push(c.id);
      }
      if (picks.size > limit) return { ids: [...picks], more: true };
    }
    frontier = next;
  }
  return { ids: [...picks], more: false };
}

/**
 * How many "add everything below this" would add under a description,
 * when the add-below action applies: from 1 to `MAX_BELOW`, and only
 * when the rule picks descriptions below it rather than the description
 * itself. Null otherwise, and for a description not in the tenant.
 */
export async function countBelow(
  db: DrizzleD1Database<any>,
  tenantId: string,
  descriptionId: string,
): Promise<number | null> {
  let picked: { ids: string[]; more: boolean };
  try {
    picked = await pickBelow(db, tenantId, descriptionId, MAX_BELOW);
  } catch (thrown) {
    if (thrown instanceof QueueError) return null;
    throw thrown;
  }
  if (picked.more || picked.ids.length === 0 || picked.ids.includes(descriptionId)) return null;
  return picked.ids.length;
}

/**
 * The descriptions "add everything below this" adds (module header);
 * `below-limit` past `MAX_BELOW`.
 */
export async function subtreeToQueue(
  db: DrizzleD1Database<any>,
  tenantId: string,
  descriptionId: string,
): Promise<string[]> {
  const picked = await pickBelow(db, tenantId, descriptionId, MAX_BELOW);
  if (picked.more) throw new QueueError("below-limit");
  return picked.ids;
}

/** A records handlist's members, in its order, under the handlist's own visibility rule. */
export async function handlistToQueue(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
  handlistId: string,
): Promise<string[]> {
  const { getWithMembers } = await import("../handlists.server");
  let detail;
  try {
    detail = await getWithMembers(db, tenant, user, handlistId);
  } catch (thrown) {
    if (thrown instanceof Response) throw new QueueError("not-found");
    throw thrown;
  }
  if (detail.recordType !== "records") throw new QueueError("invalid");
  // What each member resolves to now; a deleted one resolves to nothing.
  return [...new Set(detail.members.map((m) => m.resolvedId).filter((id): id is string => id !== null))];
}

// ---------------------------------------------------------------------------
// Changing
// ---------------------------------------------------------------------------

/**
 * The volume ids of the retakes in the queue without a row of their
 * own: the only volume ids a row may be written under
 * (`ensureRetakeRow`).
 */
export async function derivedRetakeIds(db: DrizzleD1Database<any>, tenantId: string): Promise<Set<string>> {
  const volumes = await readRetakeVolumes(db, tenantId);
  const stored = new Set<string>();
  for (const part of chunks(volumes.map((v) => v.descriptionId), READ_CHUNK)) {
    const rows = await db
      .select({ descriptionId: captureQueueEntries.descriptionId })
      .from(captureQueueEntries)
      .where(and(eq(captureQueueEntries.tenantId, tenantId), inArray(captureQueueEntries.descriptionId, part)))
      .all();
    for (const r of rows) stored.add(r.descriptionId);
  }
  return new Set(volumes.filter((v) => !stored.has(v.descriptionId)).map((v) => v.volumeId));
}

/**
 * The entry id of each item id: an entry's own, or, for a retake in the
 * queue without a row, the row `ensureRetakeRow` writes under its
 * volume's id. Anything else is `not-found`.
 */
async function resolveItems(deps: QueueDeps, tenantId: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  const out: string[] = [];
  let derived: Set<string> | null = null;
  for (const part of chunks(unique, READ_CHUNK)) {
    const found = await deps.db
      .select({ id: captureQueueEntries.id })
      .from(captureQueueEntries)
      .where(and(eq(captureQueueEntries.tenantId, tenantId), inArray(captureQueueEntries.id, part)))
      .all();
    const have = new Set(found.map((f) => f.id));
    for (const id of part) {
      if (have.has(id)) out.push(id);
      else {
        derived ??= await derivedRetakeIds(deps.db, tenantId);
        const made = await ensureRetakeRow(deps, tenantId, id, derived);
        if (!made) throw new QueueError("not-found");
        out.push(made);
      }
    }
  }
  return out;
}

/**
 * Writes the 'retake' row of a retake in the queue without one, under
 * its volume's id, and returns that id. Null when `volumeId` is not in
 * `derived` (`derivedRetakeIds`), or when its description got a row of
 * its own meanwhile, so an id never resolves to another entry.
 */
export async function ensureRetakeRow(
  deps: QueueDeps,
  tenantId: string,
  volumeId: string,
  derived: Set<string>,
): Promise<string | null> {
  if (!derived.has(volumeId)) return null;
  const volume = await deps.db
    .select({ descriptionId: pipelineVolumes.descriptionId })
    .from(pipelineVolumes)
    .where(and(eq(pipelineVolumes.tenantId, tenantId), eq(pipelineVolumes.id, volumeId)))
    .get();
  if (!volume) return null;
  const now = deps.now();
  await deps.db.run(sql`
    INSERT INTO capture_queue_entries
      (id, tenant_id, description_id, position, origin, action, added_at, changed_at)
    VALUES (${volumeId}, ${tenantId}, ${volume.descriptionId}, ${NEXT_POSITION(tenantId)} + 1, 'retake',
      'spot-recapture', ${now}, ${STAMP(tenantId, now)})
    ON CONFLICT (tenant_id, description_id) DO NOTHING`);
  const row = await deps.db
    .select({ id: captureQueueEntries.id })
    .from(captureQueueEntries)
    .where(and(eq(captureQueueEntries.tenantId, tenantId), eq(captureQueueEntries.descriptionId, volume.descriptionId)))
    .get();
  return row?.id === volumeId ? volumeId : null;
}

/** Swaps a live 'queue' entry with its neighbour above or below; false when it has none. */
export async function moveEntry(
  deps: QueueDeps,
  tenantId: string,
  entryId: string,
  direction: "up" | "down",
): Promise<boolean> {
  const { db } = deps;
  const entry = await db
    .select({ id: captureQueueEntries.id, position: captureQueueEntries.position })
    .from(captureQueueEntries)
    .where(
      and(
        eq(captureQueueEntries.tenantId, tenantId),
        eq(captureQueueEntries.id, entryId),
        eq(captureQueueEntries.origin, "queue"),
        sql`${captureQueueEntries.withdrawnAt} IS NULL`,
      ),
    )
    .get();
  if (!entry) throw new QueueError("not-found");
  const neighbour = await db
    .select({ id: captureQueueEntries.id, position: captureQueueEntries.position })
    .from(captureQueueEntries)
    .where(
      and(
        eq(captureQueueEntries.tenantId, tenantId),
        eq(captureQueueEntries.origin, "queue"),
        sql`${captureQueueEntries.withdrawnAt} IS NULL`,
        direction === "up"
          ? sql`${captureQueueEntries.position} < ${entry.position}`
          : sql`${captureQueueEntries.position} > ${entry.position}`,
      ),
    )
    .orderBy(direction === "up" ? sql`${captureQueueEntries.position} DESC` : asc(captureQueueEntries.position))
    .limit(1)
    .get();
  if (!neighbour) return false;
  const now = deps.now();
  const swap = (id: string, from: number, to: number) =>
    db
      .update(captureQueueEntries)
      .set({ position: to, changedAt: STAMP(tenantId, now) })
      .where(
        and(
          eq(captureQueueEntries.tenantId, tenantId),
          eq(captureQueueEntries.id, id),
          eq(captureQueueEntries.position, from),
        ),
      );
  await db.batch([swap(entry.id, entry.position, neighbour.position), swap(neighbour.id, neighbour.position, entry.position)]);
  return true;
}

/**
 * Assigns items to a scanner of the tenant and, when `username` is
 * given, one of its active operators; `null` unassigns them.
 */
export async function assignItems(
  deps: QueueDeps,
  tenantId: string,
  ids: string[],
  to: { scannerId: string; username: string | null } | null,
): Promise<number> {
  const { db } = deps;
  if (to) {
    const scanner = await db
      .select({ id: captureScanners.id })
      .from(captureScanners)
      .where(and(eq(captureScanners.tenantId, tenantId), eq(captureScanners.id, to.scannerId)))
      .get();
    if (!scanner) throw new QueueError("operator");
    if (to.username !== null) {
      const operator = await db
        .select({ active: captureScannerOperators.active })
        .from(captureScannerOperators)
        .where(
          and(
            eq(captureScannerOperators.tenantId, tenantId),
            eq(captureScannerOperators.scannerId, to.scannerId),
            eq(captureScannerOperators.username, to.username),
          ),
        )
        .get();
      if (!operator || !operator.active) throw new QueueError("operator");
    }
  }
  const entryIds = await resolveItems(deps, tenantId, ids);
  const now = deps.now();
  for (const part of chunks(entryIds, READ_CHUNK)) {
    await db.run(sql`UPDATE capture_queue_entries SET
        scanner_id = ${to?.scannerId ?? null}, assignee_username = ${to?.username ?? null},
        changed_at = ${STAMP(tenantId, now)}
      WHERE tenant_id = ${tenantId} AND id IN (${sql.join(part.map((id) => sql`${id}`), sql`, `)})`);
  }
  return entryIds.length;
}

/** Sets an item's job and note. */
export async function setItemJob(
  deps: QueueDeps,
  tenantId: string,
  id: string,
  job: { action: CaptureQueueAction; note: string | null },
): Promise<void> {
  const note = job.note === null ? null : job.note.trim() === "" ? null : job.note.trim();
  if (note !== null && note.length > MAX_QUEUE_NOTE) throw new QueueError("invalid");
  const [entryId] = await resolveItems(deps, tenantId, [id]);
  await deps.db.run(sql`UPDATE capture_queue_entries SET action = ${job.action}, note = ${note},
      changed_at = ${STAMP(tenantId, deps.now())}
    WHERE tenant_id = ${tenantId} AND id = ${entryId}`);
}

/** Withdraws entries. An item with retakes outstanding is refused as `retakes`, and nothing is withdrawn. */
export async function withdrawEntries(deps: QueueDeps, tenantId: string, ids: string[]): Promise<number> {
  const { db } = deps;
  const unique = [...new Set(ids)];
  if (unique.length === 0) return 0;
  const items = await loadQueueItems(db, tenantId, deps.now());
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const id of unique) {
    const item = byId.get(id);
    if (!item || !item.stored) {
      if (item && item.retakes.length > 0) throw new QueueError("retakes");
      throw new QueueError("not-found");
    }
    if (item.retakes.length > 0) throw new QueueError("retakes");
  }
  const now = deps.now();
  let withdrawn = 0;
  for (const part of chunks(unique, READ_CHUNK)) {
    const result = await db.run(sql`UPDATE capture_queue_entries SET
        withdrawn_at = ${STAMP(tenantId, now)}, changed_at = ${STAMP(tenantId, now)}
      WHERE tenant_id = ${tenantId} AND withdrawn_at IS NULL
        AND id IN (${sql.join(part.map((id) => sql`${id}`), sql`, `)})`);
    withdrawn += Number((result as any)?.meta?.changes ?? 0);
  }
  return withdrawn;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** The contract §3 digitisation-list file of `items`, in their order. */
export async function digitisationList(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  items: QueueItem[],
  generated: { id: string; at: number },
) {
  const details = await readItemDetails(db, tenant.id, items.map((i) => i.descriptionId));
  const listed = items.filter((i) => details.has(i.descriptionId));
  const codes = new Set(listed.map((i) => details.get(i.descriptionId)!.repositoryCode));
  return {
    contract: "fisqua-captua-exchange",
    version: "1.4",
    kind: "digitisation-list",
    id: generated.id,
    generatedAt: new Date(generated.at).toISOString(),
    generatedBy: { system: "fisqua", instance: tenant.slug, systemVersion: packageJson.version },
    inReplyTo: null,
    list: {
      name: tenant.name,
      tenant: tenant.slug,
      repositoryCode: codes.size === 1 ? [...codes][0] : null,
      notes: null,
    },
    items: listed.map((item, i) => {
      const d = details.get(item.descriptionId)!;
      return {
        referenceCode: d.referenceCode,
        sequence: i + 1,
        title: d.title,
        dates: d.dates,
        typology: null,
        extent: d.extent,
        containerPath: d.containerPath,
        filenameStem: d.referenceCode,
        expectedImages: null,
        notes: item.note,
        action: item.action,
      };
    }),
  };
}

// @version v0.9.0
