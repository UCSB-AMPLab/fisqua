/**
 * Media Pipeline — Truncated-Flag Ingest
 *
 * This module deals with the review flags a pipeline volume raised
 * beyond the 500 its callback can carry. The callback stores the first
 * 500 as review items and says the list was truncated; the complete
 * list is in the volume's run report, which the runner writes to the
 * working bucket before it calls back. `ingestTruncatedFlags` reads that
 * report and stores the rest. The callback starts it in the background,
 * and the scheduled sweep retries any volume it has not finished.
 *
 * One call works on one run volume:
 *
 *   1. It loads the run-volume row, scoped to the tenant, and does
 *      nothing unless the row's flags were truncated and are not yet
 *      ingested.
 *   2. It reads the report through the media object reader. A missing
 *      or unreadable report leaves the row as it was and returns
 *      `complete: false`; the log line names the run and the volume,
 *      never an object key.
 *   3. It keeps the report's open flags — those the runner did not
 *      resolve by corroboration — and drops the ones already stored as
 *      review items for this run and volume, so every call makes
 *      progress and a retry never repeats work.
 *   4. It inserts the remainder with `INSERT ... ON CONFLICT DO
 *      NOTHING`, carrying the recipe the run applied: the run volume's
 *      declaration row, the version recorded in its resolved recipe and
 *      the run's script version. Rows per statement are worked out from
 *      the parameter count of a one-row insert built by the same
 *      function, so no statement passes D1's 100-parameter limit;
 *      batches hold at most 89 statements, and one call runs at most
 *      `maxStatements` inserts (400 by default), well inside one
 *      invocation's query budget.
 *   5. When every open flag is stored, one batch recomputes the
 *      volume's open review count and marks the row ingested.
 *      Otherwise the call returns `complete: false` and the next call
 *      carries on.
 *
 * The result also counts the insert statements the call ran, so the
 * scheduled sweep can share one budget across several volumes.
 *
 * @version v0.8.0
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { BatchItem } from "drizzle-orm/batch";
import {
  pipelineReviewItems,
  pipelineRunVolumes,
  pipelineRuns,
  pipelineVolumes,
} from "../../db/schema";
import { PIPELINE_STAGES } from "../validation/enums";
import type { MediaObjectReader } from "../ocr/ingest.server";

const MAX_PARAMS = 100;
const MAX_BATCH = 89;
const DEFAULT_MAX_STATEMENTS = 400;
const STAGES = new Set<string>(PIPELINE_STAGES);

type ReviewItemRow = Omit<typeof pipelineReviewItems.$inferInsert, "tenantId">;

export interface FlagsIngestDeps {
  db: DrizzleD1Database<any>;
  reader: MediaObjectReader;
  now: () => number;
  /** The working bucket the run reports sit in. */
  workingBucket: string;
}

interface ReportFlag {
  page_key: string;
  stage: string;
  code: string;
  summary: string;
  corroboration?: unknown;
}

// Every row of one statement belongs to the one tenant passed in.
function insertStatement(db: DrizzleD1Database<any>, tenantId: string, rows: ReviewItemRow[]) {
  return db
    .insert(pipelineReviewItems)
    .values(rows.map((r) => ({ tenantId, ...r })))
    .onConflictDoNothing();
}

let rowsPerStatement: number | null = null;

// Measured, not counted by hand: a schema change that adds a bound
// column changes the answer.
function measuredRowsPerStatement(db: DrizzleD1Database<any>): number {
  if (rowsPerStatement === null) {
    const probe: ReviewItemRow = {
      id: "probe",
      pipelineVolumeId: "probe",
      runId: "probe",
      pageKey: "probe",
      stage: "render",
      code: "probe",
      summary: "probe",
      declarationId: "probe",
      declarationVersion: 1,
      scriptVersion: "probe",
      createdAt: 0,
    };
    const params = insertStatement(db, "probe", [probe]).toSQL().params.length;
    rowsPerStatement = Math.max(1, Math.floor(MAX_PARAMS / params));
  }
  return rowsPerStatement;
}

/** The insert statements for `rows`, each within the parameter limit. */
export function buildFlagInsertStatements(
  db: DrizzleD1Database<any>,
  tenantId: string,
  rows: ReviewItemRow[],
) {
  const per = measuredRowsPerStatement(db);
  const statements = [];
  for (let i = 0; i < rows.length; i += per) {
    statements.push(insertStatement(db, tenantId, rows.slice(i, i + per)));
  }
  return statements;
}

function openFlags(reportText: string): ReportFlag[] | null {
  let report: unknown;
  try {
    report = JSON.parse(reportText);
  } catch {
    return null;
  }
  const flags = (report as { flags?: unknown })?.flags;
  if (!Array.isArray(flags)) return null;
  return flags.filter(
    (f): f is ReportFlag =>
      typeof f === "object" &&
      f !== null &&
      (f as ReportFlag).corroboration == null &&
      typeof (f as ReportFlag).page_key === "string" &&
      typeof (f as ReportFlag).code === "string" &&
      typeof (f as ReportFlag).summary === "string" &&
      STAGES.has((f as ReportFlag).stage),
  );
}

async function runBatches(db: DrizzleD1Database<any>, statements: BatchItem<"sqlite">[]) {
  for (let i = 0; i < statements.length; i += MAX_BATCH) {
    const slice = statements.slice(i, i + MAX_BATCH);
    await db.batch(slice as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }
}

export async function ingestTruncatedFlags(
  deps: FlagsIngestDeps,
  target: { tenantId: string; runVolumeId: string },
  budget: { maxStatements: number } = { maxStatements: DEFAULT_MAX_STATEMENTS },
): Promise<{ inserted: number; complete: boolean; statements: number }> {
  const { db } = deps;
  const row = await db
    .select()
    .from(pipelineRunVolumes)
    .where(
      and(
        eq(pipelineRunVolumes.id, target.runVolumeId),
        eq(pipelineRunVolumes.tenantId, target.tenantId),
      ),
    )
    .get();
  if (!row || !row.flagsTruncated || row.flagsIngestedAt !== null) {
    return { inserted: 0, complete: true, statements: 0 };
  }

  const where = `run ${row.runId}, volume ${row.pipelineVolumeId}`;
  let text: string | null = null;
  try {
    text = row.reportKey ? await deps.reader.getText(deps.workingBucket, row.reportKey) : null;
  } catch {
    text = null;
  }
  const flags = text === null ? null : openFlags(text);
  if (flags === null) {
    console.warn(`pipeline flags ingest: the run report could not be read (${where})`);
    return { inserted: 0, complete: false, statements: 0 };
  }

  const run = await db
    .select({ scriptVersion: pipelineRuns.scriptVersion })
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.id, row.runId), eq(pipelineRuns.tenantId, target.tenantId)))
    .get();
  if (!run) return { inserted: 0, complete: false, statements: 0 };
  const declarationVersion = Number(
    (JSON.parse(row.resolvedRecipe) as { declaration_version?: unknown }).declaration_version,
  );

  const existing = await db
    .select({
      pageKey: pipelineReviewItems.pageKey,
      stage: pipelineReviewItems.stage,
      code: pipelineReviewItems.code,
    })
    .from(pipelineReviewItems)
    .where(
      and(
        eq(pipelineReviewItems.tenantId, target.tenantId),
        eq(pipelineReviewItems.runId, row.runId),
        eq(pipelineReviewItems.pipelineVolumeId, row.pipelineVolumeId),
      ),
    )
    .all();
  const keyOf = (f: { pageKey: string; stage: string; code: string }) =>
    JSON.stringify([f.pageKey, f.stage, f.code]);
  const seen = new Set(existing.map(keyOf));

  const now = deps.now();
  const pending: ReviewItemRow[] = [];
  for (const f of flags) {
    const candidate = { pageKey: f.page_key, stage: f.stage, code: f.code };
    const key = keyOf(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push({
      id: crypto.randomUUID(),
      pipelineVolumeId: row.pipelineVolumeId,
      runId: row.runId,
      pageKey: f.page_key,
      stage: f.stage as ReviewItemRow["stage"],
      code: f.code,
      summary: f.summary,
      declarationId: row.declarationId,
      declarationVersion,
      scriptVersion: run.scriptVersion,
      createdAt: now,
    });
  }

  const per = measuredRowsPerStatement(db);
  const take = pending.slice(0, Math.max(0, budget.maxStatements) * per);
  const inserts = buildFlagInsertStatements(db, target.tenantId, take);
  await runBatches(db, inserts);
  if (take.length < pending.length) {
    return { inserted: take.length, complete: false, statements: inserts.length };
  }

  await db.batch([
    db
      .update(pipelineVolumes)
      .set({
        openReviewCount: sql`(SELECT COUNT(*) FROM pipeline_review_items WHERE pipeline_volume_id = ${row.pipelineVolumeId} AND tenant_id = ${target.tenantId} AND verdict IS NULL)`,
        updatedAt: now,
      })
      .where(
        and(
          eq(pipelineVolumes.id, row.pipelineVolumeId),
          eq(pipelineVolumes.tenantId, target.tenantId),
        ),
      ),
    db
      .update(pipelineRunVolumes)
      .set({ flagsIngestedAt: now })
      .where(
        and(
          eq(pipelineRunVolumes.id, row.id),
          eq(pipelineRunVolumes.tenantId, target.tenantId),
          isNull(pipelineRunVolumes.flagsIngestedAt),
        ),
      ),
  ]);
  return { inserted: take.length, complete: true, statements: inserts.length };
}

// @version v0.8.0
