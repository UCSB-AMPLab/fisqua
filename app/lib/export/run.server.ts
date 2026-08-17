/**
 * Export runs — the lifecycle of one self-service export
 *
 * This module deals with what happens between pressing Export and
 * having a file: the ledger row, the stages, the artifact in R2, and
 * the two ways a run can stop that are not success. It owns no format
 * and renders nothing; the emitters produce bytes and the surface shows
 * progress.
 *
 * THE EXECUTION SHAPE IS THE IMPORTS PATTERN, and it is deliberate.
 * `startExportRun` inserts the row and hands back an `execute` the
 * ROUTE passes to `context.cloudflare.ctx.waitUntil(...)` — the shipped
 * idiom, and the reason this module never imports the Cloudflare
 * context: a library that reached for the request's execution context
 * could not be called from a test, a script, or a second route. The row
 * lands before the work starts, so the dialog and the history row have
 * something to poll from the first render, and a worker that dies
 * mid-run leaves a visible running row rather than nothing at all.
 *
 * No Workflow and no queue. A workspace export is a request-scoped
 * piece of work measured in seconds to minutes; the publish pipeline's
 * Workflow exists because it fans out across a federation and must
 * survive a deploy, neither of which is true here.
 *
 * CANCELLATION IS A FLAG, NOT AN INTERRUPT. A `cancel` sets the row's
 * status; the executor reads it at every checkpoint and stops between
 * units of work. Nothing is rolled back because nothing was written
 * until the artifact lands — a cancelled run leaves no object in R2 and
 * no half file to download.
 *
 * A FAILURE IS RECORDED AS A CODE AND ITS PARTICULARS, never as a
 * sentence. "Two records share the reference code CMD-SR-0441" is a
 * code plus a reference code plus two titles; storing the sentence
 * would freeze it in one language and make it unactionable when the
 * surface wants to link both records. `ExportRunFailure` is how an
 * emitter names one — the duplicate-reference-code case the EAD work
 * will raise is the motivating example, and its shape is fixed here so
 * that work has somewhere to put it.
 *
 * RETENTION IS SWEPT AT READ TIME. History says thirty days, and there
 * is no cron behind it, so the exports loader sweeps: objects older
 * than the window are deleted and their rows lose `r2_key` while
 * keeping everything else. A history row outliving its own file is the
 * honest end state — the workspace can still say what left and when.
 *
 * @version v0.7.0
 */

import { and, desc, eq, isNotNull, lt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { workspaceExportRuns } from "../../db/schema";
import type { Standard } from "../standards/types";
import type { Tenant, User } from "../../context";
import { EXPORT_EMITTERS } from "./emitters.server";
import type { ExportStage } from "./emitters.server";
import { assertCombinationLegal } from "./matrix";
import type { ExportForm, ExportFormat, ExportRecordClass } from "./matrix";
import { consumeCarriedScope, resolveExportScope } from "./scopes.server";
import type { ExportScopeDescriptor, ExportScopeRequest } from "./scopes.server";

/** The statuses a run can hold. Mirrors the column CHECK. */
export const EXPORT_RUN_STATUSES = [
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ExportRunStatus = (typeof EXPORT_RUN_STATUSES)[number];

/**
 * The working line's stages, in order: descriptions, then authorities,
 * then the serialisation. Machine codes — the dialog says "Writing
 * descriptions. Then authorities, then the encoded finding aid." in the
 * reader's own language, from these.
 */
export const EXPORT_RUN_STAGES = [
  "descriptions",
  "authorities",
  "serializing",
] as const;

/** How long an artifact is kept. The history line says the same number. */
export const EXPORT_RETENTION_DAYS = 30;

/** Rows swept per read, so a loader's sweep can never run unbounded. */
const SWEEP_BATCH = 50;

/** The R2 key an artifact lives at. Tenant-first, like every stored file. */
export function exportObjectKey(
  tenantId: string,
  runId: string,
  fileName: string,
): string {
  return `exports/${tenantId}/${runId}/${fileName}`;
}

/** A recorded failure: a machine code and whatever the surface needs. */
export interface ExportFailure {
  code: string;
  detail?: Record<string, unknown>;
}

/**
 * Thrown by an emitter to stop a run with a named, actionable reason.
 * The canonical case is a duplicate reference code under EAD, where the
 * detail carries the code and both titles so the failed row can offer
 * "Open the records".
 */
export class ExportRunFailure extends Error {
  readonly failure: ExportFailure;
  constructor(failure: ExportFailure) {
    super(failure.code);
    this.name = "ExportRunFailure";
    this.failure = failure;
  }
}

/** Raised by the checkpoint when the row has been cancelled. */
class ExportRunCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "ExportRunCancelled";
  }
}

/** A workspace with no descriptive standard set cannot name a form. */
export class ExportStandardUnsetError extends Error {
  readonly code = "workspace-standard-unset" as const;
  constructor() {
    super("This workspace has no descriptive standard set");
    this.name = "ExportStandardUnsetError";
  }
}

export interface ExportRunDeps {
  db: DrizzleD1Database<any>;
  /** Where artifacts land. The route passes `env.BUCKET`. */
  bucket: R2Bucket;
  tenant: Tenant;
  user: User;
  /**
   * The exporting member's language, from the route's i18next
   * middleware (`getLocale(context)`). Only artifacts with human
   * furniture read it — the finding aid's labels and colophon.
   */
  locale?: "en" | "es";
  /** Injectable clock, for tests and for a stable file-name date. */
  now?: () => number;
}

export interface StartExportRunInput {
  scope: ExportScopeRequest;
  form: ExportForm;
  format: ExportFormat;
  /**
   * Whether the linked authorities ride along. Ignored for an authority
   * scope, where the toggle is Not applicable.
   */
  includeAuthorities: boolean;
}

export interface StartedExportRun {
  runId: string;
  /**
   * The generation, ready for `context.cloudflare.ctx.waitUntil(...)`.
   * Never throws: every ending is written to the row instead, because
   * an unhandled rejection inside waitUntil would leave a run stuck at
   * "running" with nothing to say.
   */
  execute: () => Promise<void>;
}

/** A run as the dialog and the history row read it. */
export interface ExportRunView {
  id: string;
  userId: string;
  scopeKind: string;
  descriptor: ExportScopeDescriptor | null;
  recordClass: ExportRecordClass | null;
  includeAuthorities: boolean;
  form: ExportForm | null;
  format: ExportFormat | null;
  status: ExportRunStatus;
  stage: ExportStage | null;
  progressDone: number | null;
  progressTotal: number | null;
  counts: { records: number; entities: number; places: number };
  fileName: string | null;
  fileSize: number | null;
  /** Null once the retention sweep has taken the object. */
  r2Key: string | null;
  failure: ExportFailure | null;
  startedAt: number;
  finishedAt: number | null;
  createdAt: number;
}

/**
 * Start a run: resolve the scope, refuse an illegal or ungranted
 * combination, spend the carried scope if that is the door, insert the
 * ledger row, and hand back the work.
 *
 * Everything that can be refused is refused BEFORE the row exists. A
 * history littered with rows that failed on their own arguments would
 * teach the workspace nothing; a scope that cannot be resolved or a
 * pair the page never offered is an error the caller sees directly.
 */
export async function startExportRun(
  deps: ExportRunDeps,
  input: StartExportRunInput,
): Promise<StartedExportRun> {
  const { db, tenant, user } = deps;
  const clock = deps.now ?? (() => Date.now());

  const ownStandard = tenant.descriptiveStandard as Standard | null;
  if (ownStandard === null) throw new ExportStandardUnsetError();

  const scope = await resolveExportScope(db, tenant, user, input.scope, {
    includeAuthorities: input.includeAuthorities,
  });

  assertCombinationLegal(
    { recordClass: scope.recordClass, ownStandard, isAdmin: user.isAdmin },
    input.form,
    input.format,
  );

  const now = clock();
  const runId = crypto.randomUUID();

  await db.insert(workspaceExportRuns).values({
    id: runId,
    tenantId: tenant.id,
    userId: user.id,
    scopeKind: input.scope.kind,
    scopeDescriptor: JSON.stringify(scope.descriptor),
    recordClass: scope.recordClass,
    includeAuthorities: input.includeAuthorities,
    form: input.form,
    format: input.format,
    status: "running",
    stage: "descriptions",
    progressDone: 0,
    progressTotal:
      scope.recordClass === "records" ? scope.counts.records : scope.memberIds.length,
    countRecords: scope.counts.records,
    countEntities: scope.counts.entities,
    countPlaces: scope.counts.places,
    startedAt: now,
    createdAt: now,
  });

  // Spent when the RUN STARTS, not when the export page was opened:
  // arriving and changing your mind must leave the selection where it
  // was, and the recent-searches list is exactly the unspent ones.
  if (input.scope.kind === "carried") {
    await consumeCarriedScope(db, tenant, user, input.scope.carriedScopeId, now);
  }

  const execute = async (): Promise<void> => {
    try {
      const artifact = await EXPORT_EMITTERS[input.format](
        {
          db,
          tenant,
          scope,
          form: input.form,
          ownStandard,
          includeAuthorities: input.includeAuthorities,
          // The colophon signs with the run id, and the finding aid's
          // furniture speaks the exporting member's language.
          runId,
          locale: deps.locale,
        },
        { checkpoint: makeCheckpoint(db, tenant, runId) },
      );

      // One last look before anything is written: a cancel that landed
      // during the final stage must not leave an object behind.
      if (await isCancelled(db, tenant, runId)) return;

      const fileName = buildFileName(
        scope.descriptor,
        input.form,
        artifact.extension,
        clock(),
      );
      const key = exportObjectKey(tenant.id, runId, fileName);
      const body = new TextEncoder().encode(artifact.body);
      await deps.bucket.put(key, body, {
        httpMetadata: { contentType: artifact.contentType },
      });

      await db
        .update(workspaceExportRuns)
        .set({
          status: "completed",
          stage: null,
          progressDone: scope.counts.records || scope.memberIds.length,
          fileName,
          fileSize: body.byteLength,
          r2Key: key,
          finishedAt: clock(),
        })
        .where(
          and(
            eq(workspaceExportRuns.id, runId),
            eq(workspaceExportRuns.tenantId, tenant.id),
          ),
        );
    } catch (err) {
      if (err instanceof ExportRunCancelled) return;
      await recordFailure(db, tenant, runId, toFailure(err), clock());
    }
  };

  return { runId, execute };
}

/**
 * The stage/progress writer the emitters call. It is also the
 * cancellation check: the two live together because the safe moments to
 * report progress and the safe moments to stop are the same moments.
 */
function makeCheckpoint(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  runId: string,
): (stage: ExportStage, done: number, total: number) => Promise<void> {
  let lastStage: ExportStage | null = null;
  let lastDone = -1;

  return async (stage, done, total) => {
    const row = await db
      .select({ status: workspaceExportRuns.status })
      .from(workspaceExportRuns)
      .where(
        and(
          eq(workspaceExportRuns.id, runId),
          eq(workspaceExportRuns.tenantId, tenant.id),
        ),
      )
      .get();
    // A row that has gone is a row someone deleted under us; stopping
    // is the only sane reading, and it is the same stop as a cancel.
    if (!row || row.status === "cancelled") throw new ExportRunCancelled();

    if (stage === lastStage && done === lastDone) return;
    lastStage = stage;
    lastDone = done;

    await db
      .update(workspaceExportRuns)
      .set({ stage, progressDone: done, progressTotal: total })
      .where(
        and(
          eq(workspaceExportRuns.id, runId),
          eq(workspaceExportRuns.tenantId, tenant.id),
        ),
      );
  };
}

async function isCancelled(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  runId: string,
): Promise<boolean> {
  const row = await db
    .select({ status: workspaceExportRuns.status })
    .from(workspaceExportRuns)
    .where(
      and(
        eq(workspaceExportRuns.id, runId),
        eq(workspaceExportRuns.tenantId, tenant.id),
      ),
    )
    .get();
  return !row || row.status === "cancelled";
}

/**
 * Whatever went wrong, as a code and its particulars. A named
 * `ExportRunFailure` passes through untouched; anything else is
 * `unexpected` with its message, because an unlabelled crash is still
 * something the history row must be able to say.
 */
function toFailure(err: unknown): ExportFailure {
  if (err instanceof ExportRunFailure) return err.failure;
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = String((err as { code: unknown }).code);
    const detail = "detail" in err ? (err as { detail: unknown }).detail : undefined;
    return {
      code,
      detail: (detail as Record<string, unknown> | undefined) ?? undefined,
    };
  }
  return {
    code: "unexpected",
    detail: { message: err instanceof Error ? err.message : String(err) },
  };
}

async function recordFailure(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  runId: string,
  failure: ExportFailure,
  now: number,
): Promise<void> {
  await db
    .update(workspaceExportRuns)
    .set({
      status: "failed",
      failure: JSON.stringify(failure),
      finishedAt: now,
    })
    .where(
      and(
        eq(workspaceExportRuns.id, runId),
        eq(workspaceExportRuns.tenantId, tenant.id),
      ),
    );
}

/**
 * `<slugified-scope>-<form>-<date>.<ext>` — the card's naming. The
 * scope half is the ledger row's own words about the scope, so a file
 * on a desktop a week later still says which export it was.
 */
export function buildFileName(
  descriptor: ExportScopeDescriptor,
  form: ExportForm,
  extension: string,
  now: number,
): string {
  const date = new Date(now).toISOString().slice(0, 10);
  return `${slugify(scopeLabel(descriptor))}-${form}-${date}.${extension}`;
}

/** The scope in a few words, for the file name. */
function scopeLabel(descriptor: ExportScopeDescriptor): string {
  switch (descriptor.kind) {
    case "workspace":
      return "workspace";
    case "branch":
      return descriptor.title || descriptor.referenceCode;
    case "carried":
      return descriptor.pills.join(" ") || "selection";
    case "handlist":
      return descriptor.name;
  }
}

/**
 * A file-name-safe slug: accents folded, everything else collapsed to
 * hyphens, capped so a long handlist name cannot produce a name an
 * operating system refuses.
 */
export function slugify(value: string): string {
  const folded = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return folded === "" ? "export" : folded;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

type RunRow = typeof workspaceExportRuns.$inferSelect;

function toView(row: RunRow): ExportRunView {
  return {
    id: row.id,
    userId: row.userId,
    scopeKind: row.scopeKind,
    descriptor: parseJson<ExportScopeDescriptor>(row.scopeDescriptor),
    recordClass: row.recordClass as ExportRecordClass | null,
    includeAuthorities: row.includeAuthorities,
    form: row.form as ExportForm | null,
    format: row.format as ExportFormat | null,
    status: row.status,
    stage: row.stage as ExportStage | null,
    progressDone: row.progressDone,
    progressTotal: row.progressTotal,
    counts: {
      records: row.countRecords ?? 0,
      entities: row.countEntities ?? 0,
      places: row.countPlaces ?? 0,
    },
    fileName: row.fileName,
    fileSize: row.fileSize,
    r2Key: row.r2Key,
    failure: parseJson<ExportFailure>(row.failure),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Stored JSON, read defensively. These columns are written by this
 * module alone, so malformed content means a bad migration or a
 * hand-edited row — neither of which should take the history page down
 * with a parse error where a null will do.
 */
function parseJson<T>(raw: string | null): T | null {
  if (raw === null || raw === "") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * One run, tenant-scoped. Another workspace's run is indistinguishable
 * from one that never existed — the same null, which is what makes the
 * download route's 404 honest.
 */
export async function getExportRun(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  runId: string,
): Promise<ExportRunView | null> {
  const row = await db
    .select()
    .from(workspaceExportRuns)
    .where(
      and(
        eq(workspaceExportRuns.id, runId),
        eq(workspaceExportRuns.tenantId, tenant.id),
      ),
    )
    .get();
  return row ? toView(row) : null;
}

/**
 * The workspace's export history, newest first. Day grouping is the
 * caller's to do — the rows carry `createdAt` and the page knows what
 * "today" means in the reader's timezone, which a server query does
 * not.
 */
export async function listExportRuns(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  limit = 50,
): Promise<ExportRunView[]> {
  const rows = await db
    .select()
    .from(workspaceExportRuns)
    .where(eq(workspaceExportRuns.tenantId, tenant.id))
    .orderBy(desc(workspaceExportRuns.createdAt))
    .limit(limit)
    .all();
  return rows.map(toView);
}

/**
 * Cancel a running export. Tenant-scoped and status-guarded, so a
 * completed run cannot be retroactively cancelled and a second cancel
 * is a no-op. Who may press it is the route's decision.
 */
export async function cancelExportRun(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  runId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const result = await db
    .update(workspaceExportRuns)
    .set({ status: "cancelled", stage: null, finishedAt: now })
    .where(
      and(
        eq(workspaceExportRuns.id, runId),
        eq(workspaceExportRuns.tenantId, tenant.id),
        eq(workspaceExportRuns.status, "running"),
      ),
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * The thirty-day sweep, run from the exports loader. Objects past the
 * window are deleted and their rows lose `r2_key`; everything else the
 * row says survives, because the history's promise is that the
 * workspace can always say what left, not that it can always download
 * it again.
 *
 * Bounded per call. A workspace returning after a long absence sweeps
 * over several page loads rather than blocking one, which is the same
 * bargain the handlist integrity read makes.
 */
export async function sweepExpiredExports(
  db: DrizzleD1Database<any>,
  bucket: R2Bucket,
  tenant: Tenant,
  now: number = Date.now(),
): Promise<number> {
  const cutoff = now - EXPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const stale = await db
    .select({ id: workspaceExportRuns.id, r2Key: workspaceExportRuns.r2Key })
    .from(workspaceExportRuns)
    .where(
      and(
        eq(workspaceExportRuns.tenantId, tenant.id),
        isNotNull(workspaceExportRuns.r2Key),
        lt(workspaceExportRuns.createdAt, cutoff),
      ),
    )
    .limit(SWEEP_BATCH)
    .all();

  for (const row of stale) {
    if (row.r2Key) await bucket.delete(row.r2Key);
    await db
      .update(workspaceExportRuns)
      .set({ r2Key: null })
      .where(
        and(
          eq(workspaceExportRuns.id, row.id),
          eq(workspaceExportRuns.tenantId, tenant.id),
        ),
      );
  }
  return stale.length;
}

/* @version v0.7.0 */
