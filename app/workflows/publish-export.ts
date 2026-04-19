/**
 * Publish Export Workflow
 *
 * The durable Cloudflare Workflow that drives the full publish run
 * end-to-end: load the requested fonds, write a heartbeat row into
 * `export_runs`, invoke every pipeline step in its own Worker
 * invocation so each one gets a fresh runtime budget, and close the
 * row out with a success or failure tombstone. The workflow instance
 * id is propagated into the row so an operator can match the admin
 * history against the Workflows dashboard.
 *
 * Step bodies in `app/lib/export/pipeline.server.ts` are idempotent
 * by construction — they re-upload the same R2 keys on retry — so
 * the recovery story for a transient failure is "retry the whole
 * workflow run", not "resume mid-step".
 *
 * @version v0.3.0
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { exportRuns } from "../db/schema";
import { ExportStorage } from "../lib/export/r2-client.server";
import {
  exportFondsDescriptions,
  exportFondsChildren,
  exportRepositories,
  exportEntities,
  exportPlaces,
  recordStepStart,
  recordStepEnd,
} from "../lib/export/pipeline.server";
import {
  writeDescriptionsIndex,
  FondsBodyTooLargeError,
} from "../lib/export/combined.server";
import { exportFondsMets } from "../lib/export/mets-export.server";

/**
 * Cloudflare Workflow that runs the publish-export pipeline.
 *
 * Each `step.do(...)` runs in its own Worker invocation with a fresh
 * 1000-subrequest / 30s-CPU / 128 MB budget — the natural fit for an
 * export that has well-defined per-fonds boundaries. The workflow
 * instance id is propagated into export_runs.workflow_instance_id so
 * the operator can correlate the row with the workflow dashboard.
 *
 * Trade-off: we wrap the whole `run()` body in a coarse try/catch
 * rather than relying on Workflows' native step retries to surface
 * errors. This is simpler and gives us a single place to write a
 * human-readable error message into the row. The cost is that a
 * truly transient step failure is treated as fatal here. Step bodies
 * are idempotent (they re-upload the same R2 keys), so retrying the
 * whole workflow run is safe — that is the recovery story.
 */

export interface PublishExportParams {
  exportId: string;
}

export class PublishExportWorkflow extends WorkflowEntrypoint<
  Env,
  PublishExportParams
> {
  async run(event: WorkflowEvent<PublishExportParams>, step: WorkflowStep) {
    const { exportId } = event.payload;
    const db = drizzle(this.env.DB);
    const storage = new ExportStorage(this.env.EXPORT_BUCKET);

    try {
      // Step 1: load run config and mark running.
      const config = await step.do("load-config", async () => {
        const run = await db
          .select()
          .from(exportRuns)
          .where(eq(exportRuns.id, exportId))
          .get();
        if (!run) throw new Error(`exportRun ${exportId} not found`);

        await db
          .update(exportRuns)
          .set({
            status: "running",
            startedAt: Date.now(),
            workflowInstanceId: event.instanceId,
          })
          .where(eq(exportRuns.id, exportId));

        return {
          selectedFonds: JSON.parse(run.selectedFonds) as string[],
          selectedTypes: JSON.parse(run.selectedTypes) as string[],
        };
      });

      const counts: Record<string, number> = {};

      if (config.selectedTypes.includes("descriptions")) {
        // One step per fonds — each gets its own runtime budget.
        for (const fonds of config.selectedFonds) {
          const result = await step.do(`descriptions:${fonds}`, async () => {
            await recordStepStart(db, exportId, `descriptions:${fonds}`);
            const r = await exportFondsDescriptions(db, storage, fonds);
            counts[`descriptions:${fonds}`] = r.recordCount;
            await recordStepEnd(db, exportId, `descriptions:${fonds}`, counts);
            return r;
          });
          counts[`descriptions:${fonds}`] = result.recordCount;
        }

        // One step to write descriptions-index.json. The single combined
        // descriptions.json file was deliberately NOT produced by the worker
        // after Task 4 verification showed that R2 streaming put in
        // wrangler dev local deadlocks on large bodies AND production-scale
        // fonds exceed single-Worker memory even with a byte-level scanner.
        // zasqua-frontend reads the per-fonds files + this index at build
        // time to produce the concatenated descriptions.json for its static
        // site.
        await step.do("descriptions:index", async () => {
          await recordStepStart(db, exportId, "descriptions:index");
          const perFondsCounts: Record<string, number> = {};
          for (const fonds of config.selectedFonds) {
            perFondsCounts[fonds] = counts[`descriptions:${fonds}`] ?? 0;
          }
          const r = await writeDescriptionsIndex(
            storage,
            config.selectedFonds,
            perFondsCounts
          );
          counts["descriptions:index"] = r.totalRecordCount;
          await recordStepEnd(db, exportId, "descriptions:index", counts);
        });

        // One step PER FONDS for children — never tens of thousands of PUTs
        // in one Worker invocation.
        for (const fonds of config.selectedFonds) {
          await step.do(`children:${fonds}`, async () => {
            await recordStepStart(db, exportId, `children:${fonds}`);
            const r = await exportFondsChildren(db, storage, fonds);
            counts[`children:${fonds}`] = r.putCount;
            await recordStepEnd(db, exportId, `children:${fonds}`, counts);
          });
        }

        // METS XML generation — one step per fonds for dirty digitised items.
        // Runs after children so description data is current.
        for (const fonds of config.selectedFonds) {
          await step.do(`mets:${fonds}`, async () => {
            await recordStepStart(db, exportId, `mets:${fonds}`);
            const r = await exportFondsMets(db, this.env.METS_BUCKET, fonds);
            counts[`mets:${fonds}`] = r.generatedCount;
            await recordStepEnd(db, exportId, `mets:${fonds}`, counts);
          });
        }
      }

      if (config.selectedTypes.includes("repositories")) {
        await step.do("repositories", async () => {
          await recordStepStart(db, exportId, "repositories");
          const r = await exportRepositories(db, storage);
          counts.repositories = r.count;
          await recordStepEnd(db, exportId, "repositories", counts);
        });
      }

      if (config.selectedTypes.includes("entities")) {
        await step.do("entities", async () => {
          await recordStepStart(db, exportId, "entities");
          const r = await exportEntities(db, storage);
          counts.entities = r.count;
          await recordStepEnd(db, exportId, "entities", counts);
        });
      }

      if (config.selectedTypes.includes("places")) {
        await step.do("places", async () => {
          await recordStepStart(db, exportId, "places");
          const r = await exportPlaces(db, storage);
          counts.places = r.count;
          await recordStepEnd(db, exportId, "places", counts);
        });
      }

      await step.do("finalize", async () => {
        await db
          .update(exportRuns)
          .set({
            status: "complete",
            completedAt: Date.now(),
            recordCounts: JSON.stringify(counts),
          })
          .where(eq(exportRuns.id, exportId));
      });
    } catch (err) {
      const isGuard = err instanceof FondsBodyTooLargeError;
      const message = isGuard
        ? `FondsBodyTooLargeError: ${err.message}`
        : err instanceof Error
          ? err.message
          : "Unknown publish-export error";

      await db
        .update(exportRuns)
        .set({
          status: "error",
          errorMessage: message,
          completedAt: Date.now(),
        })
        .where(eq(exportRuns.id, exportId));

      // Re-throw so the Workflows runtime sees the failure and the dashboard
      // shows the run as errored too. Without re-throwing, Workflows would
      // mark the run as complete from its perspective.
      throw err;
    }
  }
}
