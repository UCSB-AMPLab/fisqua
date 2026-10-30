/**
 * Digitization Screens — What the Volumes Screen and the Queue Read
 *
 * This module deals with the reads behind the Digitization section:
 * who may see each screen, the volumes a tenant's scanner handed over,
 * and the capture QC queue with the people a volume can be assigned to.
 * Every read is scoped to the request's tenant; nothing here writes.
 * Assigning a reviewer stays with `assignReviewerAction` (`qc.server.ts`),
 * which the queue posts to.
 *
 * `captureAccess` answers who the user is to capture work on the tenant:
 * a manager (whoever passes the digitization area, or a steward of the
 * tenant's federation,
 * the people `qc.server.ts` lets assign) and whether they are the
 * assigned reviewer of any of the tenant's volumes. The Volumes screen
 * is for managers; the queue for managers and reviewers.
 *
 * `loadCaptureVolumes` lists one row per reference code the tenant's
 * scanner (or the registration command) handed over, each with the
 * delivery the status call would report for it (`statusRows`: the one
 * that holds the volume, or the latest when none does), the pipeline
 * volume and its description's title, the latest run that named it
 * (`readLatestRuns`), the holding delivery's decision set and the
 * assigned reviewer, and, on a retake whose approvals were carried over
 * (`carried_from`), how many openings it brought back changed and still
 * to review again (`countUnchangedRejections` leaves out a rejected one
 * brought back unchanged). Its
 * state is the one the unit is told
 * (`captureLinkState`), mapped to the screen's states (`screens.ts`). A
 * refused handover carries the rule of its first problem, which the page
 * shows translated; a failed run carries the message the run recorded
 * for the volume (`readRunError`), or the status call's sentence when it
 * recorded none. Rows are ordered by handover, newest first.
 *
 * `loadVolumeScreenStates` gives the same screen state for a handful
 * of named volumes without reading the whole tenant: it reads only those
 * volumes' reference codes, runs, decision sets and review runs, and
 * none of the problem details, reviewers or earlier handovers. The user
 * detail page uses it for the volumes one person reviews. Both readers
 * share `readStatusDeliveries`, `readHolderSets` and
 * `deriveScreenState`, so the two cannot disagree on a volume's state.
 *
 * `loadCaptureQueue` keeps the volumes waiting for capture review
 * (`inQueue`) that have a pipeline volume to review; a user who is not a
 * manager sees only the volumes assigned to them. `loadReviewerCandidates`
 * lists who may be assigned, as `assignReviewerAction` allows: the
 * tenant's own users (archive staff), then the other people holding a
 * membership in its federation, under the federation's name.
 *
 * @version v0.8.0
 */

import { and, asc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  captureDeliveries,
  captureQcReviewers,
  captureQcSets,
  descriptions,
  federationMemberships,
  federations,
  pipelineRunVolumes,
  pipelineVolumes,
  users,
} from "../../db/schema";
import type { Tenant, User } from "../../context";
import type { CaptureDeliveryState, CaptureLinkState } from "../validation/enums";
import { isFederationSteward } from "../federation.server";
import { canAdministerArea } from "../user-access.server";
import { readLatestRuns, readProblems, statusRows, type StatusRow } from "./link.server";
import { countUnchangedRejections } from "./retakes.server";
import { captureLinkState, type StatusRun } from "./status";
import { inQueue, nextStepOf, screenStateFor, type NextStep, type ReviewStep, type ScreenState } from "./screens";
import { federationHasReviewBucket, readLatestReviewRuns, type LatestReviewRun } from "./review-run.server";

/** Ids per `IN (...)` read, under D1's 100 bound parameters. */
const READ_CHUNK = 50;

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

export interface CaptureAccess {
  /** Passes the digitization area, or is a steward of the tenant's federation. */
  manager: boolean;
  /** The assigned reviewer of at least one of the tenant's volumes. */
  reviewer: boolean;
}

export async function captureAccess(db: DrizzleD1Database<any>, tenant: Tenant, user: User): Promise<CaptureAccess> {
  const manager =
    canAdministerArea(user, "digitization") || (await isFederationSteward(db, user, tenant));
  const assigned = await db
    .select({ id: captureQcReviewers.pipelineVolumeId })
    .from(captureQcReviewers)
    .where(and(eq(captureQcReviewers.tenantId, tenant.id), eq(captureQcReviewers.reviewerId, user.id)))
    .limit(1)
    .all();
  return { manager, reviewer: assigned.length > 0 };
}

export interface CaptureVolumeRow {
  referenceCode: string;
  /** The pipeline volume; null while the handover is unregistered or was refused. */
  volumeId: string | null;
  descriptionId: string | null;
  title: string | null;
  /** The reported delivery's openings. */
  openings: number;
  /** When the reported delivery was received, in ms. */
  handedOverAt: number;
  linkState: CaptureLinkState;
  state: ScreenState;
  nextStep: NextStep | null;
  /**
   * Why the volume stopped: a refused handover's first rule, shown
   * translated, or a failed run's pipeline error, shown as it came.
   */
  problem: { kind: "refusal"; rule: string } | { kind: "pipeline"; message: string } | null;
  reviewer: { id: string; name: string } | null;
  hasEarlierDelivery: boolean;
  /** The holding delivery's decisions. */
  approved: number;
  rejected: number;
  decided: number;
  /**
   * On a retake whose approvals were carried over, the openings it
   * brought back changed and still undecided; null otherwise. An opening
   * rejected earlier and brought back unchanged is not one of them.
   */
  reviewAgain: number | null;
}

type DeliveryLight = StatusRow;

export async function loadCaptureVolumes(
  db: DrizzleD1Database<any>,
  tenantId: string,
  now: number,
): Promise<CaptureVolumeRow[]> {
  const deliveryRows = await readStatusDeliveries(db, tenantId, null);
  const byRef = new Map<string, DeliveryLight[]>();
  for (const r of deliveryRows) {
    const list = byRef.get(r.referenceCode as string) ?? [];
    list.push(r);
    byRef.set(r.referenceCode as string, list);
  }
  if (byRef.size === 0) return [];

  // The pipeline volumes those handovers registered, with their titles.
  const volumes = await db
    .select({
      id: pipelineVolumes.id,
      referenceCode: pipelineVolumes.referenceCode,
      descriptionId: pipelineVolumes.descriptionId,
      title: descriptions.title,
      state: pipelineVolumes.state,
      createdAt: pipelineVolumes.createdAt,
      updatedAt: pipelineVolumes.updatedAt,
      heldByRunId: pipelineVolumes.heldByRunId,
    })
    .from(pipelineVolumes)
    .innerJoin(
      descriptions,
      and(eq(descriptions.id, pipelineVolumes.descriptionId), eq(descriptions.tenantId, tenantId)),
    )
    .where(
      and(
        eq(pipelineVolumes.tenantId, tenantId),
        sql`EXISTS (SELECT 1 FROM capture_deliveries cd WHERE cd.tenant_id = ${tenantId} AND cd.pipeline_volume_id = ${pipelineVolumes.id})`,
      ),
    )
    .all();
  const volumeByRef = new Map(volumes.map((v) => [v.referenceCode, v]));

  const runs = await readLatestRuns(db, tenantId, volumes.map((v) => v.id), now);
  const reviewBucket = await federationHasReviewBucket(db, tenantId);

  // The decision sets of the holding deliveries.
  const holderIds = deliveryRows.filter((r) => r.state === "registered").map((r) => r.id);
  const sets = await readHolderSets(db, tenantId, holderIds);

  // The holding deliveries' latest review runs.
  const reviews = await readLatestReviewRuns(db, tenantId, holderIds, now);

  // Reviewers, by name as the queue shows them.
  const reviewerRows = await db
    .select({
      volumeId: captureQcReviewers.pipelineVolumeId,
      reviewerId: captureQcReviewers.reviewerId,
      name: users.name,
      email: users.email,
    })
    .from(captureQcReviewers)
    .innerJoin(users, eq(users.id, captureQcReviewers.reviewerId))
    .where(eq(captureQcReviewers.tenantId, tenantId))
    .all();
  const reviewerOf = new Map(
    reviewerRows.map((r) => [r.volumeId, { id: r.reviewerId, name: personName(r.name, r.email) }]),
  );

  // Volumes an earlier handover was superseded on: a retake came back.
  const earlier = await db
    .select({ volumeId: captureDeliveries.pipelineVolumeId })
    .from(captureDeliveries)
    .where(
      and(
        eq(captureDeliveries.tenantId, tenantId),
        eq(captureDeliveries.state, "superseded"),
        isNotNull(captureDeliveries.pipelineVolumeId),
      ),
    )
    .groupBy(captureDeliveries.pipelineVolumeId)
    .all();
  const retaken = new Set(earlier.map((r) => r.volumeId as string));

  const out: CaptureVolumeRow[] = [];
  for (const [ref, rows] of byRef) {
    const chosen = statusRows(rows);
    if (!chosen) continue;
    const d = chosen.reported as DeliveryLight;
    const v = volumeByRef.get(ref) ?? null;
    const { set, review, linked, reviewStep, state } = deriveScreenState({
      delivery: d,
      volume: v,
      run: v ? runs.get(v.id) ?? null : null,
      sets,
      reviews,
      reviewBucket,
    });
    if (state === null) continue;

    let problem: CaptureVolumeRow["problem"] = null;
    if (linked.state === "refused") {
      const [first] = await readProblems(db, tenantId, d, 1);
      problem = { kind: "refusal", rule: first && first.rule !== "problems-truncated" ? first.rule : "" };
    } else if (linked.state === "failed") {
      // The runner's own words where it recorded them; otherwise what the
      // status call says.
      const run = v ? runs.get(v.id) ?? null : null;
      const recorded = v && run ? await readRunError(db, tenantId, run.runId, v.id) : null;
      const last = linked.problems[linked.problems.length - 1];
      const message = recorded ?? last?.message ?? null;
      problem = message ? { kind: "pipeline", message } : null;
    } else if (state === "review_failed") {
      // The review row's own words, where it recorded any.
      const message = review ? errorMessageOf(review.error) : null;
      problem = message ? { kind: "pipeline", message } : null;
    }

    // A pipeline volume a reviewer can be assigned to: held by this delivery.
    const registered = v !== null && d.state === "registered";
    const reviewer = v ? reviewerOf.get(v.id) ?? null : null;
    const hasEarlierDelivery = v !== null && retaken.has(v.id);
    out.push({
      referenceCode: ref,
      volumeId: v?.id ?? null,
      descriptionId: v?.descriptionId ?? null,
      title: v?.title ?? null,
      openings: d.openings,
      handedOverAt: d.receivedAt,
      linkState: linked.state,
      state,
      nextStep: nextStepOf({
        linkState: linked.state,
        registered,
        hasReviewer: reviewer !== null,
        hasEarlierDelivery,
        review: reviewStep,
      }),
      problem,
      reviewer,
      hasEarlierDelivery,
      approved: set?.approvedCount ?? 0,
      rejected: set?.rejectedCount ?? 0,
      decided: set?.decidedCount ?? 0,
      reviewAgain:
        set?.carriedFrom && v
          ? Math.max(
              0,
              d.openings - set.decidedCount - (await countUnchangedRejections(db, tenantId, d.id, v.id, now)),
            )
          : null,
    });
  }
  out.sort((a, b) => b.handedOverAt - a.handedOverAt || a.referenceCode.localeCompare(b.referenceCode));
  return out;
}

/**
 * The light columns of the deliveries the status call would weigh for
 * each reference code: the holder and the latest committed. With
 * `refs`, only those reference codes are read.
 */
async function readStatusDeliveries(
  db: DrizzleD1Database<any>,
  tenantId: string,
  refs: string[] | null,
): Promise<DeliveryLight[]> {
  const read = (only: string[] | null) =>
    db
      .select({
        id: captureDeliveries.id,
        state: captureDeliveries.state,
        seq: captureDeliveries.seq,
        referenceCode: captureDeliveries.referenceCode,
        pipelineVolumeId: captureDeliveries.pipelineVolumeId,
        receivedAt: captureDeliveries.receivedAt,
        supersededAt: captureDeliveries.supersededAt,
        openings: captureDeliveries.openings,
        rejectedRecords: captureDeliveries.rejectedRecords,
      })
      .from(captureDeliveries)
      .where(
        and(
          eq(captureDeliveries.tenantId, tenantId),
          only ? inArray(captureDeliveries.referenceCode, only) : isNotNull(captureDeliveries.referenceCode),
          sql`(${captureDeliveries.state} = 'registered' OR ${captureDeliveries.seq} = (SELECT MAX(s.seq) FROM capture_deliveries s WHERE s.tenant_id = ${tenantId} AND s.reference_code = ${captureDeliveries.referenceCode}))`,
        ),
      )
      .all();
  if (refs === null) return read(null);
  const out: DeliveryLight[] = [];
  for (const part of chunks(refs, READ_CHUNK)) out.push(...(await read(part)));
  return out;
}

interface HolderSet {
  state: "in_capture_qc" | "retakes_requested" | "approved";
  stateEnteredAt: number;
  approvedCount: number;
  rejectedCount: number;
  decidedCount: number;
  carriedFrom: string | null;
}

/** The decision sets of the holding deliveries, by delivery id. */
async function readHolderSets(
  db: DrizzleD1Database<any>,
  tenantId: string,
  holderIds: string[],
): Promise<Map<string, HolderSet>> {
  const sets = new Map<string, HolderSet>();
  for (const part of chunks(holderIds, READ_CHUNK)) {
    const rows = await db
      .select({
        deliveryId: captureQcSets.deliveryId,
        state: captureQcSets.state,
        stateEnteredAt: captureQcSets.stateEnteredAt,
        approvedCount: captureQcSets.approvedCount,
        rejectedCount: captureQcSets.rejectedCount,
        decidedCount: captureQcSets.decidedCount,
        carriedFrom: captureQcSets.carriedFrom,
      })
      .from(captureQcSets)
      .where(and(eq(captureQcSets.tenantId, tenantId), inArray(captureQcSets.deliveryId, part)))
      .all();
    for (const r of rows) sets.set(r.deliveryId, r);
  }
  return sets;
}

interface VolumeLight {
  id: string;
  state: (typeof pipelineVolumes.$inferSelect)["state"];
  createdAt: number;
  updatedAt: number;
  heldByRunId: string | null;
}

/**
 * The state the status call gives the delivery it reports for a
 * reference code (`captureLinkState`), and the screen state it maps to
 * (`screenStateFor`); null for a state the screens do not show.
 */
function deriveScreenState(args: {
  delivery: DeliveryLight;
  volume: VolumeLight | null;
  run: StatusRun | null;
  sets: Map<string, HolderSet>;
  reviews: Map<string, LatestReviewRun>;
  reviewBucket: boolean;
}) {
  const d = args.delivery;
  const v = args.volume;
  const set = d.state === "registered" ? args.sets.get(d.id) ?? null : null;
  const review = d.state === "registered" ? args.reviews.get(d.id) ?? null : null;
  const linked = captureLinkState({
    delivery: {
      id: d.id,
      state: d.state as CaptureDeliveryState,
      problems: [],
      receivedAt: d.receivedAt,
      supersededAt: d.supersededAt,
      openings: d.openings,
      rejectedRecords: d.rejectedRecords,
    },
    volume: v && {
      id: v.id,
      state: v.state,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
      heldByRunId: v.heldByRunId,
    },
    run: args.run,
    captureQc: set && { state: set.state, enteredAt: set.stateEnteredAt },
    review: review && { state: review.state, enteredAt: review.enteredAt },
  });
  const reviewStep: ReviewStep = !args.reviewBucket ? "not_applicable" : review ? review.state : "none";
  return { set, review, linked, reviewStep, state: screenStateFor(linked.state, reviewStep) };
}

/**
 * The Volumes screen's state of each of `volumeIds`, as
 * `loadCaptureVolumes` derives it, reading only what those volumes
 * need: their reference codes' deliveries, their runs, their holding
 * deliveries' decision sets and review runs. Reviewers, earlier
 * handovers and problem details are not read. A volume the screen
 * would not list has no entry.
 */
export async function loadVolumeScreenStates(
  db: DrizzleD1Database<any>,
  tenantId: string,
  volumeIds: string[],
  now: number,
): Promise<Map<string, ScreenState>> {
  const out = new Map<string, ScreenState>();
  if (volumeIds.length === 0) return out;

  const volumes: Array<VolumeLight & { referenceCode: string }> = [];
  for (const part of chunks(volumeIds, READ_CHUNK)) {
    volumes.push(
      ...(await db
        .select({
          id: pipelineVolumes.id,
          referenceCode: pipelineVolumes.referenceCode,
          state: pipelineVolumes.state,
          createdAt: pipelineVolumes.createdAt,
          updatedAt: pipelineVolumes.updatedAt,
          heldByRunId: pipelineVolumes.heldByRunId,
        })
        .from(pipelineVolumes)
        .where(and(eq(pipelineVolumes.tenantId, tenantId), inArray(pipelineVolumes.id, part)))
        .all()),
    );
  }
  if (volumes.length === 0) return out;

  const deliveryRows = await readStatusDeliveries(db, tenantId, [...new Set(volumes.map((v) => v.referenceCode))]);
  const byRef = new Map<string, DeliveryLight[]>();
  for (const r of deliveryRows) {
    const list = byRef.get(r.referenceCode as string) ?? [];
    list.push(r);
    byRef.set(r.referenceCode as string, list);
  }
  const runs = await readLatestRuns(db, tenantId, volumes.map((v) => v.id), now);
  const reviewBucket = await federationHasReviewBucket(db, tenantId);
  const holderIds = deliveryRows.filter((r) => r.state === "registered").map((r) => r.id);
  const sets = await readHolderSets(db, tenantId, holderIds);
  const reviews = await readLatestReviewRuns(db, tenantId, holderIds, now);

  for (const v of volumes) {
    const chosen = statusRows(byRef.get(v.referenceCode) ?? []);
    if (!chosen) continue;
    const { state } = deriveScreenState({
      delivery: chosen.reported as DeliveryLight,
      volume: v,
      run: runs.get(v.id) ?? null,
      sets,
      reviews,
      reviewBucket,
    });
    if (state !== null) out.set(v.id, state);
  }
  return out;
}

/** The `message` of a recorded error (JSON `{ class, message }`), or its class when it has none. */
function errorMessageOf(error: string | null): string | null {
  if (!error) return null;
  try {
    const parsed = JSON.parse(error) as { class?: unknown; message?: unknown };
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
    return typeof parsed.class === "string" ? parsed.class : null;
  } catch {
    return null;
  }
}

/**
 * The message a run recorded for one of its volumes (`pipeline_run_volumes.error`,
 * JSON `{ class, message }`), or null when it recorded none. The status
 * call reports only the class; the screen shows the message as written.
 */
export async function readRunError(
  db: DrizzleD1Database<any>,
  tenantId: string,
  runId: string,
  volumeId: string,
): Promise<string | null> {
  const row = await db
    .select({ error: pipelineRunVolumes.error })
    .from(pipelineRunVolumes)
    .where(
      and(
        eq(pipelineRunVolumes.tenantId, tenantId),
        eq(pipelineRunVolumes.runId, runId),
        eq(pipelineRunVolumes.pipelineVolumeId, volumeId),
      ),
    )
    .get();
  if (!row?.error) return null;
  try {
    const parsed = JSON.parse(row.error) as { message?: unknown };
    return typeof parsed.message === "string" && parsed.message.trim().length > 0 ? parsed.message : null;
  } catch {
    return null;
  }
}

/**
 * The volumes waiting for capture review that have a pipeline volume to
 * review. A user who is not a manager sees only those assigned to them.
 */
export async function loadCaptureQueue(
  db: DrizzleD1Database<any>,
  tenantId: string,
  user: Pick<User, "id">,
  manager: boolean,
  now: number,
): Promise<CaptureVolumeRow[]> {
  const rows = await loadCaptureVolumes(db, tenantId, now);
  return rows.filter(
    (r) => r.volumeId !== null && inQueue(r.linkState) && (manager || r.reviewer?.id === user.id),
  );
}

export interface ReviewerCandidates {
  /** The tenant's own users. */
  staff: Array<{ id: string; name: string }>;
  /** The federation's name, as the group of its members is labelled. */
  federationName: string | null;
  /** Users of other tenants holding a membership in the tenant's federation. */
  federation: Array<{ id: string; name: string }>;
}

export async function loadReviewerCandidates(db: DrizzleD1Database<any>, tenant: Tenant): Promise<ReviewerCandidates> {
  const staffRows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.tenantId, tenant.id))
    .orderBy(asc(users.name), asc(users.email))
    .all();
  const memberRows = await db
    .selectDistinct({ id: users.id, name: users.name, email: users.email })
    .from(federationMemberships)
    .innerJoin(users, eq(users.id, federationMemberships.userId))
    .where(and(eq(federationMemberships.federationId, tenant.federationId), ne(users.tenantId, tenant.id)))
    .orderBy(asc(users.name), asc(users.email))
    .all();
  return {
    staff: staffRows.map((u) => ({ id: u.id, name: personName(u.name, u.email) })),
    federationName: await federationNameOf(db, tenant),
    federation: memberRows.map((u) => ({ id: u.id, name: personName(u.name, u.email) })),
  };
}

/** The name of the tenant's federation, which the queue names as the source of its other reviewers. */
export async function federationNameOf(db: DrizzleD1Database<any>, tenant: Tenant): Promise<string | null> {
  const fed = await db
    .select({ name: federations.name })
    .from(federations)
    .where(eq(federations.id, tenant.federationId))
    .get();
  return fed?.name ?? null;
}

/** A person as the screens show them: their name, or their email when they have none. */
export function personName(name: string | null, email: string): string {
  const trimmed = (name ?? "").trim();
  return trimmed.length > 0 ? trimmed : email;
}

// @version v0.8.0
