/**
 * Media Pipeline — Run Lifecycle
 *
 * This module deals with when a pipeline run is open and how it closes,
 * written once so that dispatch, the two callback handlers and the
 * scheduled sweep all close a run the same way.
 *
 * A run is open while `token_revoked_at` is null and closed once it is
 * set. Status records what happened; `token_revoked_at` decides whether
 * anything new is accepted. Every statement that ends a run sets both
 * together, which the table's CHECK requires: pending, dispatched and
 * running runs are open, completed, error and cancelled runs are
 * closed, and a halted run may be either, because it keeps recording
 * the volumes its in-flight jobs finish until it closes.
 *
 * `runHoldsVolumesSql(now)` is the hold predicate over a run aliased
 * `r`: a run holds the volumes that name it while it is open and its
 * token has not expired. A run whose token has expired therefore holds
 * nothing even before anything has closed it.
 *
 * `expireRun` closes an open run whose token has expired. It is one
 * update on the run row, conditional on the run still being open and
 * the token having expired, so it happens at most once whatever the
 * number of callers. A halted run keeps its status and its halt error.
 * A run whose volumes have all reported and that recorded no error —
 * only the chunks' completion reports are missing — becomes
 * `completed`. Any other run becomes `error`, keeping an error recorded
 * earlier (a dispatch failure) or recording `{ class: "token_expired" }`.
 * It takes one of three scopes: one run of one tenant (a callback or
 * chunk report that meets an expired token), every expired open run of
 * one tenant (a start-run request, before it reads any hold), or every
 * expired open run of every tenant (the scheduled sweep, which runs with
 * no tenant). All three use the same `SET` clause.
 *
 * `closeRunIfChunksDone` closes an open run once none of its dispatch
 * chunks is pending, dispatched or failed. A pending, dispatched or
 * running run becomes `completed`; a halted run stays `halted`; both
 * get `token_revoked_at` and `completed_at`. A `failed` chunk keeps the
 * run open, because GitHub may have started it. An optional `guard`
 * fragment lets a caller tie the closure to a claim made in the same
 * batch. A per-volume callback never closes a run.
 *
 * Both closing functions return a builder statement, so a caller can
 * run it on its own or put it inside a batch.
 *
 * @version v0.8.0
 */

import { and, eq, isNull, lte, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { pipelineRuns } from "../../db/schema";

/** The hold predicate over a run aliased `r`. */
export function runHoldsVolumesSql(now: number): SQL {
  return sql`r.token_revoked_at IS NULL AND r.token_expires_at > ${now}`;
}

/**
 * The scope of an expiry: one run of one tenant, every expired open run
 * of one tenant, or every expired open run of every tenant.
 */
export type ExpireRunScope =
  | { runId: string; tenantId: string }
  | { tenantId: string; runId?: undefined }
  | { allTenants: true };

// The close-at-expiry assignments, shared by every scope.
function expirySet(now: number) {
  const everyVolumeReported = sql`(volumes_reported >= volume_count AND error IS NULL)`;
  return {
    tokenRevokedAt: now,
    status: sql`CASE WHEN status = 'halted' THEN 'halted' WHEN ${everyVolumeReported} THEN 'completed' ELSE 'error' END`,
    completedAt: sql`CASE WHEN status <> 'halted' AND ${everyVolumeReported} THEN ${now} ELSE completed_at END`,
    error: sql`CASE WHEN status = 'halted' OR ${everyVolumeReported} THEN error ELSE COALESCE(error, json_object('class', 'token_expired')) END`,
  };
}

export function expireRun(db: DrizzleD1Database<any>, scope: ExpireRunScope, now: number) {
  if ("allTenants" in scope) {
    // The scheduled sweep runs with no tenant: every tenant's expired
    // open runs close here.
    return db
      .update(pipelineRuns)
      .set(expirySet(now))
      .where(and(isNull(pipelineRuns.tokenRevokedAt), lte(pipelineRuns.tokenExpiresAt, now)));
  }
  const conditions: SQL[] = [
    eq(pipelineRuns.tenantId, scope.tenantId),
    isNull(pipelineRuns.tokenRevokedAt),
    lte(pipelineRuns.tokenExpiresAt, now),
  ];
  if (scope.runId !== undefined) conditions.unshift(eq(pipelineRuns.id, scope.runId));
  return db
    .update(pipelineRuns)
    .set(expirySet(now))
    .where(and(...conditions));
}

export function closeRunIfChunksDone(
  db: DrizzleD1Database<any>,
  args: { runId: string; tenantId: string; now: number; guard?: SQL },
) {
  const conditions = [
    eq(pipelineRuns.id, args.runId),
    eq(pipelineRuns.tenantId, args.tenantId),
    isNull(pipelineRuns.tokenRevokedAt),
    sql`NOT EXISTS (SELECT 1 FROM pipeline_run_chunks WHERE run_id = ${args.runId} AND tenant_id = ${args.tenantId} AND status IN ('pending', 'dispatched', 'failed'))`,
  ];
  if (args.guard) conditions.push(args.guard);
  return db
    .update(pipelineRuns)
    .set({
      status: sql`CASE WHEN status IN ('pending', 'dispatched', 'running') THEN 'completed' ELSE status END`,
      completedAt: args.now,
      tokenRevokedAt: args.now,
    })
    .where(and(...conditions));
}

// @version v0.8.0
