/**
 * Manifest Attribution Refresh Workflow
 *
 * This workflow refreshes the attribution of every published manifest of
 * one federation as a durable Cloudflare Workflow: it rewrites the
 * `requiredStatement`, `provider` and `rights` of each manifest from the
 * rows Fisqua holds now, and leaves the rest of the manifest as it is.
 * A dry run reads and reports and writes no manifest. The work itself is
 * in `app/lib/pipeline/manifest-refresh-run.server.ts`; this file only
 * walks it a step at a time.
 *
 * The run's parameters are the federation's id, the mode (`dry_run` or
 * `apply`), the id of the person who started it, and a limit on the
 * number of descriptions, the first by reference code, from 1 to
 * `REFRESH_MAX_LIMIT`; a run without one fails before its first step.
 * Optionally they name a repository code and a description to start
 * after (`after`, its reference code and id). The report's `next_after`
 * is where the next instance starts, so a federation larger than one
 * instance is refreshed by instances started one after another.
 * `load-config` reads the federation's manifest destination and hosting
 * statement and fails the run when the destination is incomplete;
 * `check-urls` fails it when two of the federation's descriptions share
 * a manifest URL, listing up to 50 of them (`duplicate_manifest_url`).
 * Either failure, and a missing limit, writes a report with status
 * `failed` before any batch runs. An apply run holds its federation's
 * lock, taken by the route; every `write-report`, on success or failure,
 * releases it after writing the report. Each
 * `batch:{n}` step then reads the next `REFRESH_BATCH_SIZE` descriptions
 * after the last one the previous step read, and handles their
 * manifests; a step that reads fewer than it asked for, or reaches the
 * limit, is the last.
 * A failing step is retried on its own (`REFRESH_STEP_CONFIG`), and a
 * retried batch reads its manifests again, so a manifest it wrote before
 * failing is found current the second time and is not written twice.
 *
 * The keys are never part of a step's result: each batch reads the
 * federation's manifest write key from the Worker's environment. The
 * report is built in `run()` from what each step returns, so a replayed
 * run, whose completed steps return their stored results without
 * running, builds the same report. `write-report` puts it in `BUCKET`
 * under `reports/manifest-refresh/`; when a batch fails for good, the
 * report so far is written with status `failed` before the run fails,
 * and in an apply run every write record the report does not yet hold
 * is folded into it (`foldRefreshRecords`), so writes made by attempts
 * whose results were lost are counted.
 * The run returns the report's key, its counts and `next_after`.
 *
 * Every manifest a batch reads or writes, and every write record an
 * apply run keeps, is a subrequest, and a Workflow instance has 10,000
 * by default: at most five per manifest written, so an instance held to
 * `REFRESH_MAX_LIMIT` (1,500) descriptions takes at most 7,500 in an
 * apply run and 1,500 in a dry run, leaving room for retries.
 *
 * In an apply run each batch is given the run's write records in
 * `BUCKET` (`refreshRecords`), so a batch retried after it wrote
 * reports those writes, with the fields as they were before them.
 *
 * The class is bound in `wrangler.jsonc` as `MANIFEST_REFRESH` and
 * exported from `workers/app.ts` so the Workflows runtime can find it.
 *
 * @version v0.9.0
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { drizzle } from "drizzle-orm/d1";
import {
  REFRESH_BATCH_SIZE,
  REFRESH_MAX_LIMIT,
  addRefreshBatch,
  duplicateManifestUrls,
  releaseRefreshLock,
  refreshLockHeld,
  RefreshPreconditionError,
  writeRefreshFailure,
  foldRefreshRecords,
  loadRefreshConfig,
  newRefreshReport,
  refreshBatch,
  refreshRecords,
  refreshTargetOf,
  s3ManifestObjectStore,
  writeRefreshReport,
  type RefreshBatchResult,
  type RefreshCounts,
  type RefreshCursor,
  type RefreshMode,
  type RefreshPosition,
} from "../lib/pipeline/manifest-refresh-run.server";

export interface ManifestRefreshParams {
  federationId: string;
  /** Names the federation's lock and report keys. */
  federationSlug: string;
  mode: RefreshMode;
  /** The person who started the run. */
  requestedBy?: string;
  /** At most this many descriptions, the first by reference code; 1 to `REFRESH_MAX_LIMIT`. */
  limit: number;
  /** Only this repository's descriptions, by code. */
  repository?: string;
  /** Only the descriptions after this one. */
  after?: RefreshPosition;
  /** Descriptions per batch; `REFRESH_BATCH_SIZE` unless given. */
  batchSize?: number;
}

export interface ManifestRefreshOutput {
  report_key: string;
  mode: RefreshMode;
  federation: { id: string; slug: string };
  counts: RefreshCounts;
  next_after: RefreshPosition | null;
}

/** Retries of a batch step: 30 s, 60 s and 120 s after a failure. */
export const REFRESH_STEP_CONFIG = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
} satisfies WorkflowStepConfig;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ManifestRefreshWorkflow extends WorkflowEntrypoint<Env, ManifestRefreshParams> {
  /** The fetch the manifest bucket is reached through. */
  protected fetcher(): typeof fetch {
    return (input, init) => fetch(input, init);
  }

  async run(event: WorkflowEvent<ManifestRefreshParams>, step: WorkflowStep): Promise<ManifestRefreshOutput> {
    const { federationId, mode } = event.payload;
    const size = event.payload.batchSize ?? REFRESH_BATCH_SIZE;
    const db = drizzle(this.env.DB);

    const federation = { id: federationId, slug: event.payload.federationSlug };
    // Only an apply run holds the federation's lock; releasing is a no-op
    // for a lock another instance holds.
    const release = async () => {
      if (mode === "apply") await releaseRefreshLock(this.env.BUCKET, federation.slug, event.instanceId);
    };
    const failEarly = async (error: string, extra: Record<string, unknown> = {}) => {
      await step.do("write-report", async () => {
        const key = await writeRefreshFailure(this.env.BUCKET, federation, event.instanceId, mode, error, extra);
        await release();
        return key;
      });
    };

    const { limit } = event.payload;
    let config: Awaited<ReturnType<typeof loadRefreshConfig>>;
    try {
      if (!Number.isInteger(limit) || limit < 1 || limit > REFRESH_MAX_LIMIT) {
        throw new Error(`A refresh instance takes a limit from 1 to ${REFRESH_MAX_LIMIT}`);
      }
      config = await step.do("load-config", () =>
        loadRefreshConfig(db, this.env, federationId, mode, {
          limit,
          repository: event.payload.repository,
          after: event.payload.after,
        }),
      );
    } catch (err) {
      await failEarly(err instanceof Error ? `${err.name}: ${err.message}` : "error");
      throw err;
    }
    // Every manifest URL must name one description, or two descriptions
    // would decide one object's fields. Checked over the whole federation.
    const duplicates = await step.do("check-urls", () => duplicateManifestUrls(db, federationId));
    if (duplicates.length > 0) {
      await failEarly("duplicate_manifest_url", { duplicate_manifest_urls: duplicates });
      throw new Error(`duplicate_manifest_url: ${duplicates.length} shared manifest URL(s)`);
    }
    let report = newRefreshReport(config, event.instanceId, new Date(event.timestamp).getTime());

    try {
      let cursor: RefreshCursor | null = null;
      for (let n = 1; ; n++) {
        const from: RefreshCursor | null = cursor;
        // A batch result is plain JSON (the three fields are values read
        // from or built as JSON), which the step type cannot see through
        // `unknown`, so it is stored as an opaque object and read back.
        const stored = await step.do(`batch:${n}`, REFRESH_STEP_CONFIG, async () => {
          const batch = await refreshBatch(
            {
              db,
              store: s3ManifestObjectStore(refreshTargetOf(config, this.env), this.fetcher()),
              sleep,
              records:
                config.mode === "apply"
                  ? refreshRecords(this.env.BUCKET, config.federationSlug, event.instanceId)
                  : null,
              lock:
                config.mode === "apply"
                  ? () => refreshLockHeld(this.env.BUCKET, config.federationSlug, event.instanceId)
                  : null,
            },
            config,
            from,
            size,
          ).catch((err) => {
            // A failed precondition does not pass on a retry.
            if (err instanceof RefreshPreconditionError) throw new NonRetryableError(err.message, err.code);
            throw err;
          });
          return batch as unknown as Record<string, never>;
        });
        const result = stored as unknown as RefreshBatchResult;
        report = addRefreshBatch(report, result);
        if (result.done) break;
        cursor = result.cursor;
      }
    } catch (err) {
      const failed = {
        ...report,
        status: "failed" as const,
        error: err instanceof Error ? `${err.name}: ${err.message}` : "error",
      };
      await step.do("write-report", async () => {
        const key = await writeRefreshReport(
          this.env.BUCKET,
          config.mode === "apply"
            ? await foldRefreshRecords(failed, refreshRecords(this.env.BUCKET, config.federationSlug, event.instanceId))
            : failed,
          Date.now(),
        );
        await release();
        return key;
      });
      throw err;
    }

    const complete = { ...report, status: "complete" as const };
    const key = await step.do("write-report", async () => {
      const written = await writeRefreshReport(this.env.BUCKET, complete, Date.now());
      await release();
      return written;
    });
    return {
      report_key: key,
      mode,
      federation: complete.federation,
      counts: complete.counts,
      next_after: complete.next_after,
    };
  }
}

// @version v0.9.0
