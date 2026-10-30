/**
 * Media Pipeline — Scheduled Sweep
 *
 * This module deals with the media pipeline's share of the scheduled
 * handler: the work that has to happen even when no runner calls back
 * and nobody starts a run. It runs with no request and no tenant, so
 * the statements that select its work are cross-tenant by design, and
 * every write that follows from them is scoped by the tenant read from
 * the row.
 *
 * `runPipelineSweep` does three things and returns their counts:
 *
 *   1. Token expiry. One statement closes every open run whose token
 *      has expired, in every tenant, with the same rule a late callback
 *      or a start-run request applies: a halted run keeps its status
 *      and halt error, a run whose volumes all reported with no error
 *      completes, any other run ends in error, keeping a dispatch error
 *      or recording `token_expired`. No volume row changes. A closed
 *      run holds nothing, but its volumes were already free once the
 *      token expired; the sweep records what happened.
 *   2. Truncated flags. Up to 20 run volumes whose flag list was too
 *      long for the callback and whose ingest has not finished are
 *      handed to `ingestTruncatedFlags`, oldest first, each under its
 *      own tenant, sharing one budget of 400 insert statements per tick.
 *      A retry that neither finishes nor stores a flag (the report is
 *      missing or unreadable) adds one to the row's
 *      `flags_ingest_attempts`; a row that reaches eight is no longer
 *      selected, so a report that will never be readable cannot keep
 *      the rows behind it waiting. The row keeps `flags_ingested_at`
 *      null, and its count records why it is no longer retried.
 *   3. Stalled publications. Up to 20 publications left in flight past
 *      their expiry, or failed because their copy was judged not made,
 *      across tenants, are handed to `resolveStalledPublication`, each
 *      with its own tenant's canonical store (`canonicalFor`): an
 *      expired claim is abandoned, and a copy is finished or failed by
 *      reading the canonical key; a failed copy whose own bytes turn
 *      out to be at the key is finished. Rows a person must decide, and
 *      rows visited eight times without a decision, are no longer
 *      selected. This step runs whatever happened
 *      in the first two, and its own failure is logged without touching
 *      their counts; a failure in the first two is still thrown, after
 *      it has run.
 *
 * The sweep is idempotent: a second run over the same state changes
 * nothing. Where no scheduled handler runs, expired runs close at the
 * first late callback or chunk report, or at the tenant's next
 * start-run request, and truncated flags rely on the request's own
 * background ingest.
 *
 * @version v0.8.0
 */

import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { pipelineRunVolumes } from "../../db/schema";
import { ingestTruncatedFlags } from "./flags-ingest.server";
import { expireRun } from "./run-state.server";
import type { MediaObjectReader } from "./store.server";
import type { CanonicalManifestStore } from "./canonical.server";
import { resolveStalledPublications } from "./publish.server";

/** Run volumes whose flag ingest one tick retries. */
export const SWEEP_FLAG_ROWS = 20;
/** Insert statements one tick may spend on flag ingest. */
export const SWEEP_FLAG_STATEMENTS = 400;
/** Retries without progress after which a row is no longer selected. */
export const SWEEP_FLAG_MAX_ATTEMPTS = 8;

export interface PipelineSweepDeps {
  db: DrizzleD1Database<any>;
  reader: MediaObjectReader;
  /** Epoch milliseconds. */
  now: number;
  workingBucket: string;
  /**
   * The canonical manifest store of a tenant, which its stalled
   * publications are checked against; null when the tenant's storage
   * destination is not set up.
   */
  canonicalFor: (tenantId: string) => Promise<CanonicalManifestStore | null>;
}

export interface PipelineSweepCounts {
  expired: number;
  flagsAttempted: number;
  flagsCompleted: number;
  publicationsResolved: number;
  publicationsUnresolved: number;
}

export async function runPipelineSweep(deps: PipelineSweepDeps): Promise<PipelineSweepCounts> {
  const { db, now } = deps;
  let expired = 0;
  let flagsAttempted = 0;
  let flagsCompleted = 0;
  let earlierFailure: unknown = null;
  try {
    ({ expired, flagsAttempted, flagsCompleted } = await expireAndIngestFlags(deps));
  } catch (err) {
    earlierFailure = err;
  }

  // 3. Stalled publications, whatever happened above.
  let publicationsResolved = 0;
  let publicationsUnresolved = 0;
  try {
    const out = await resolveStalledPublications({ db, canonicalFor: deps.canonicalFor }, now);
    publicationsResolved = out.resolved;
    publicationsUnresolved = out.unresolved;
  } catch (err) {
    console.error(`pipeline sweep: publications failed: ${err instanceof Error ? err.name : "error"}`);
  }

  if (earlierFailure !== null) throw earlierFailure;
  return { expired, flagsAttempted, flagsCompleted, publicationsResolved, publicationsUnresolved };
}

async function expireAndIngestFlags(
  deps: PipelineSweepDeps,
): Promise<{ expired: number; flagsAttempted: number; flagsCompleted: number }> {
  const { db, now } = deps;

  // 1. Token expiry, across tenants.
  const expiry = await expireRun(db, { allTenants: true }, now);
  const expired = Number((expiry as { meta?: { changes?: number } }).meta?.changes ?? 0);

  // 2. Truncated flags, across tenants, each ingested under its own.
  const pending = await db
    .select({ id: pipelineRunVolumes.id, tenantId: pipelineRunVolumes.tenantId })
    .from(pipelineRunVolumes)
    .where(
      and(
        eq(pipelineRunVolumes.flagsTruncated, true),
        isNull(pipelineRunVolumes.flagsIngestedAt),
        lt(pipelineRunVolumes.flagsIngestAttempts, SWEEP_FLAG_MAX_ATTEMPTS),
      ),
    )
    .orderBy(asc(pipelineRunVolumes.createdAt), asc(pipelineRunVolumes.id))
    .limit(SWEEP_FLAG_ROWS)
    .all();

  let budget = SWEEP_FLAG_STATEMENTS;
  let flagsAttempted = 0;
  let flagsCompleted = 0;
  for (const row of pending) {
    if (budget <= 0) break;
    flagsAttempted++;
    const result = await ingestTruncatedFlags(
      { db, reader: deps.reader, now: () => now, workingBucket: deps.workingBucket },
      { tenantId: row.tenantId, runVolumeId: row.id },
      { maxStatements: budget },
    );
    budget -= result.statements;
    if (result.complete) {
      flagsCompleted++;
    } else if (result.inserted === 0) {
      await db
        .update(pipelineRunVolumes)
        .set({ flagsIngestAttempts: sql`${pipelineRunVolumes.flagsIngestAttempts} + 1` })
        .where(
          and(
            eq(pipelineRunVolumes.id, row.id),
            eq(pipelineRunVolumes.tenantId, row.tenantId),
            isNull(pipelineRunVolumes.flagsIngestedAt),
          ),
        )
        .run();
    }
  }

  return { expired, flagsAttempted, flagsCompleted };
}

// @version v0.8.0
