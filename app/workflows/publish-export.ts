/**
 * Publish Export Workflow
 *
 * This workflow deals with driving the full publish run end-to-end as
 * a durable Cloudflare Workflow: load the requested fonds, write a
 * heartbeat row into
 * `export_runs`, invoke every pipeline step as its own Workflow step,
 * each bounded in the work it does, and close the
 * row out with a success or failure tombstone. The workflow instance
 * id is propagated into the row so an operator can match the admin
 * history against the Workflows dashboard.
 *
 * Step bodies in `app/lib/export/pipeline.server.ts` are idempotent
 * by construction — they re-upload the same R2 keys on retry — so
 * the recovery story for a transient failure is "retry the whole
 * workflow run", not "resume mid-step".
 *
 * The workflow resolves the EXPORT SCOPE once at start in
 * `load-config` (federation spec §9 step 8), whose body is
 * `loadPublishConfig`. The triggering tenant is the run row's own
 * `tenant_id` (migration 0115), the workspace the publish was started
 * in, never the triggering user's stored workspace;
 * `resolveExportScope` then decides whether this is a
 * federation publish (the lead aggregating every member tenant's rows)
 * or a single-tenant own-publish. Either way EVERY artefact is written
 * under ONE R2 prefix — the publish (lead) slug — so a federation run
 * reproduces the pre-partition single-tenant layout byte-for-byte
 * (publish-neutrality). Per-fonds steps receive a per-fonds tenant whose
 * `id`/`descriptiveStandard` are the fonds' OWNING member tenant (so the
 * right rows are read and the right EAD3 profile is picked) but whose
 * `slug` is the publish slug; per-type steps receive the publish tenant
 * plus the full member-tenant id list to aggregate their reads across.
 *
 * The link files (`entity_links.json`, `place_links.json`) are the one
 * artefact written across several steps: each is a multipart upload
 * that a step carries forward a bounded number of rows and hands on as
 * a small JSON state (`entity_links:0`, `entity_links:1`, ...) until
 * the file is complete. They run under the same authorities gate and
 * the same selected types as entities.json and places.json, because
 * they export the same authority junctions. The workflow keeps the
 * last state each link-file step returned; when the run fails, the
 * error handler passes those states to `abandonLinkExports`, which
 * deletes the staging objects and aborts the multipart upload of any
 * file left unfinished.
 *
 * The workflow writes no METS files. The site's engine writes each
 * description's METS file, at the address its `mets_url` gives. A run
 * started under the earlier plan, which had METS steps, is not resumed
 * by this code; a deploy happens only when no run is pending or running.
 *
 * The steps and their order are the plan of `planPublishSteps`
 * (`app/lib/export/publish-steps.ts`), which the workflow walks step by
 * step and the publish page's progress panel lists, so the panel shows
 * exactly the steps the run will take, in the order it takes them.
 *
 * The federation's `publisher.json` and `vocabulary.json` are written on
 * every publish, whatever types it includes, by an `institution` step
 * after the plan's last step and before `finalize`. Neither file belongs
 * to one type, so the step is not in the plan: like `load-config` and
 * `finalize` it records no step start or end, and `total_steps` and the
 * progress panel do not count it.
 *
 * Every step returns the count it records, and the workflow sets its
 * running counts from what `step.do` returns, not only inside the step
 * body. When Workflows replays `run()`, a completed step returns its
 * stored result without running its body, so counts set only in the
 * body would be lost, and the next step would write `record_counts`
 * without them.
 *
 * Each fonds descriptions step carries an explicit retry config
 * (`DESCRIPTIONS_STEP_CONFIG`): the step refuses to complete a file
 * when its fonds is edited during the step, and a later attempt reads
 * the fonds once it has settled.
 *
 * When the run fails, the write that marks its row `error` is a step of
 * its own, `record-failure`, retried with backoff
 * (`RECORD_FAILURE_STEP_CONFIG`). The failure is often D1 refusing
 * queries, and then the first attempt at that write is refused too; a
 * row left `running` would block the tenant's next publish until it
 * went stale.
 *
 * Each per-fonds step (descriptions, children, EAD3, Dublin Core) runs
 * through `runUnlessUnchanged` (`fingerprint.server.ts`): when nothing
 * its files are built from has changed since it last succeeded for the
 * fonds and its main object is in the bucket, it writes nothing and
 * returns the counts it recorded then. A skipped step still records its
 * start and end, so `steps_completed` and the progress panel count it,
 * and its id is listed under `skipped` in the run's record counts,
 * beside the numeric count each step id keeps. The list is rebuilt from
 * the steps' returns, as the counts are. A run started with
 * `force: true` in its parameters runs every per-fonds step and records
 * its fingerprints. The federation-wide steps always run.
 *
 * Before each fonds' descriptions step, the `manifests:{fonds}:{n}`
 * steps refresh the own manifests of the fonds' descriptions whose
 * records changed since the fonds' descriptions file was last written
 * (`refreshOwnManifests`, `own-manifests.server.ts`): the label, summary
 * and homepage label each manifest carries from its record are
 * rewritten when they differ, and nothing else in it. Each step takes
 * one batch and hands on a small state until the descriptions run out;
 * the number rewritten, when there is one, is counted under
 * `manifests:{fonds}`. They come
 * first so that a publish whose refresh fails records no fingerprint
 * for the fonds, and the next one reads the same records again. Like
 * `institution` they are not in the plan and record no step start or
 * end. A forced run reads every own manifest of the fonds. The manifest
 * bucket is reached through `manifestFetcher()`.
 *
 * The `descriptions:index` step writes `descriptions-index.json` for
 * every published fonds of the publishing tenant (a fonds whose root
 * description is published, in any member tenant), not only the fonds
 * the run selected, because zasqua.org builds only what the index
 * lists. `writeDescriptionsIndex` keeps the stored entries of the fonds
 * the run did not select, and fails the run when the stored index
 * cannot be read or leaves out a published fonds whose file is in
 * storage, unless the run selected every published fonds.
 *
 * @version v0.9.0
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { descriptions, exportRuns, tenants } from "../db/schema";
import { ExportStorage } from "../lib/export/r2-client.server";
import {
  exportFondsDescriptions,
  exportFondsChildren,
  exportFondsEad,
  exportFondsDc,
  exportRepositories,
  exportInstitutionFiles,
  exportEntities,
  exportPlaces,
  recordStepStart,
  recordStepEnd,
  perFondsMainKey,
} from "../lib/export/pipeline.server";
import {
  runUnlessUnchanged,
  type FingerprintKind,
} from "../lib/export/fingerprint.server";
import {
  exportEntityLinks,
  exportPlaceLinks,
  abandonLinkExports,
  type LinkExportState,
} from "../lib/export/link-files.server";
import {
  writeDescriptionsIndex,
  FondsBodyTooLargeError,
} from "../lib/export/combined.server";
import { resolveExportScope } from "../lib/export/federation-scope.server";
import { getFondsOwners } from "../lib/export/fonds-list.server";
import { planPublishSteps } from "../lib/export/publish-steps";
import { refreshOwnManifests, type OwnManifestState } from "../lib/export/own-manifests.server";
import type { ExportTenant } from "../lib/export/types";

/**
 * Cloudflare Workflow that runs the publish-export pipeline.
 *
 * Each `step.do(...)` is retried on its own and has its own CPU limit
 * and ten-minute timeout, but consecutive steps can run in one Worker
 * invocation, and subrequests (D1, R2) are counted per invocation:
 * a run's consecutive steps can together spend the default limit of
 * 10,000, at which point the step running fails, and retries made
 * seconds later have failed on their first query.
 * So every step bounds its own subrequests, and a whole run must stay
 * within the Worker's configured subrequest limit. The workflow
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

/**
 * Retries of a fonds descriptions step. The step throws
 * `FondsChangedDuringPublishError` when the fonds is edited while its
 * file is being written, leaving the previous file in place; it is
 * tried again 30 s, 60 s and 120 s later, and a fonds still changing
 * after the third retry fails the run. Other errors in the step are
 * retried the same way.
 */
export const DESCRIPTIONS_STEP_CONFIG = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
} satisfies WorkflowStepConfig;

/**
 * Retries of the `record-failure` step, which marks a failed run
 * `error`. Attempts follow at 10 s doubling to 1,280 s, about 42
 * minutes in all, so a D1 overload that also refused the first write
 * releases the publish lock once it passes, instead of after
 * `PUBLISH_STALE_AFTER_MS`.
 */
export const RECORD_FAILURE_STEP_CONFIG = {
  retries: { limit: 8, delay: "10 seconds", backoff: "exponential" },
} satisfies WorkflowStepConfig;

/**
 * Retries of a fonds' own-manifest step. A write refused because someone
 * else wrote the manifest after it was read, or storage failing past
 * its own retries, fails the step, and a later attempt reads afresh.
 */
export const MANIFESTS_STEP_CONFIG = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
} satisfies WorkflowStepConfig;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface PublishExportParams {
  exportId: string;
  /** Run every per-fonds step whatever its recorded fingerprint. */
  force?: boolean;
}

/**
 * The body of the workflow's `load-config` step: read the run, resolve
 * its tenant from the run row's `tenant_id`, resolve the export scope,
 * map each selected fonds to its owning member tenant, and mark the run
 * running. Exported so the tests can drive it without a workflow.
 */
export async function loadPublishConfig(
  db: DrizzleD1Database<any>,
  exportId: string,
  instanceId: string,
) {
  const run = await db
    .select()
    .from(exportRuns)
    .where(eq(exportRuns.id, exportId))
    .get();
  if (!run) throw new Error(`exportRun ${exportId} not found`);

  // Resolve the triggering tenant, then the export SCOPE. The route
  // gates publish on superadmin + requireCapability(tenant,
  // 'publish_pipeline') and records the request tenant on the run, so
  // the run's tenant is the tenant the route's authMiddleware resolved
  // against the request host.
  if (!run.tenantId) {
    throw new Error(`exportRun ${exportId} has no tenant_id`);
  }
  const tenantRow = await db
    .select({
      id: tenants.id,
      federationId: tenants.federationId,
      slug: tenants.slug,
      descriptiveStandard: tenants.descriptiveStandard,
    })
    .from(tenants)
    .where(eq(tenants.id, run.tenantId))
    .get();
  if (!tenantRow) {
    throw new Error(
      `Tenant ${run.tenantId} of exportRun ${exportId} not found`
    );
  }
  if (!tenantRow.descriptiveStandard) {
    throw new Error(
      `Tenant ${tenantRow.slug} has no descriptive_standard (kind=platform tenants cannot publish)`
    );
  }

  const triggerTenant: ExportTenant = {
    id: tenantRow.id,
    federationId: tenantRow.federationId,
    slug: tenantRow.slug,
    descriptiveStandard: tenantRow.descriptiveStandard,
  };

  // Federation publish vs single-tenant own-publish (spec §9 step
  // 8). resolveExportScope is the ONE decision point shared with
  // the route + api.publish validator.
  const scope = await resolveExportScope(db, triggerTenant);

  // Map each selected fonds to the member tenant that OWNS it, so
  // per-fonds steps read from the right tenant. All writes still
  // land under scope.publishSlug (the lead slug) — see below.
  const ownerByFonds = await getFondsOwners(db, scope.memberTenantIds);
  const memberById = new Map(scope.members.map((m) => [m.id, m]));
  const selectedFonds = JSON.parse(run.selectedFonds) as string[];

  // Plain serialisable Record (Workflows persist step returns as
  // JSON — a Map would not survive the step boundary). Each value
  // has the owning tenant's id + descriptiveStandard but the
  // publish (lead) slug, so reads hit the owner while keys stay
  // under one prefix.
  const fondsTenants: Record<string, ExportTenant> = {};
  for (const fonds of selectedFonds) {
    const ownerId = ownerByFonds.get(fonds) ?? scope.publishTenant.id;
    const owner = memberById.get(ownerId) ?? scope.publishTenant;
    fondsTenants[fonds] = {
      id: owner.id,
      federationId: scope.federationId,
      slug: scope.publishSlug,
      descriptiveStandard: owner.descriptiveStandard,
    };
  }

  await db
    .update(exportRuns)
    .set({
      status: "running",
      startedAt: Date.now(),
      workflowInstanceId: instanceId,
      // Record which federation this run published (idempotent —
      // api.publish already set it; a workflow-only trigger path
      // still gets it right).
      federationId: scope.federationId,
    })
    .where(eq(exportRuns.id, exportId));

  return {
    selectedFonds,
    selectedTypes: JSON.parse(run.selectedTypes) as string[],
    publishTenant: scope.publishTenant,
    memberTenantIds: scope.memberTenantIds,
    fondsTenants,
    authoritiesEnabled: scope.authoritiesEnabled,
  };
}

export class PublishExportWorkflow extends WorkflowEntrypoint<
  Env,
  PublishExportParams
> {
  /** The fetch the federation's manifest bucket is reached through. */
  protected manifestFetcher(): typeof fetch {
    return (input, init) => fetch(input, init);
  }

  async run(event: WorkflowEvent<PublishExportParams>, step: WorkflowStep) {
    const { exportId } = event.payload;
    const db = drizzle(this.env.DB);
    const storage = new ExportStorage(this.env.EXPORT_BUCKET);
    // The last state each link file's steps returned, kept here so the
    // failure path can clean up an unfinished upload. A replayed run
    // rebuilds it from the cached step results.
    const linkStates: Record<string, LinkExportState> = {};

    try {
      // Step 1: load run config and mark running.
      const config = await step.do("load-config", async () =>
        loadPublishConfig(db, exportId, event.instanceId)
      );

      const counts: Record<string, number> = {};
      // The per-fonds steps that wrote nothing, as their returns say.
      const skipped: string[] = [];
      // What the run records: the counts, and the skipped steps when any.
      const recorded = (): Record<string, number | string[]> =>
        skipped.length > 0 ? { ...counts, skipped: [...skipped] } : { ...counts };
      const noteSkipped = (stepName: string, result: { skipped?: boolean }) => {
        const at = skipped.indexOf(stepName);
        if (result.skipped && at < 0) skipped.push(stepName);
        // A retried step that ran keeps no entry from an earlier attempt.
        if (!result.skipped && at >= 0) skipped.splice(at, 1);
      };

      const force = event.payload.force === true;
      // A per-fonds step body, skipped when its fonds is unchanged.
      const perFonds = <R extends object>(kind: FingerprintKind, fonds: string, run: () => Promise<R>) =>
        runUnlessUnchanged(
          {
            db,
            storage,
            tenant: config.fondsTenants[fonds],
            fondsCode: fonds,
            kind,
            exportId,
            mainKey: perFondsMainKey(kind, config.fondsTenants[fonds].slug, fonds),
            force,
            memberTenantIds: config.memberTenantIds,
          },
          run
        );

      // The link files' step bodies, by plan step kind.
      const linkFileRunners = {
        entity_links: exportEntityLinks,
        place_links: exportPlaceLinks,
      } as const;

      // Walk the plan: the same list the progress panel shows and
      // `total_steps` counts, so the three cannot disagree on the steps
      // or their order. Entities, places and their link files are in it
      // only when the tenant has the authorities capability (spec §6).
      const plan = planPublishSteps(config);
      for (const planStep of plan) {
        const fonds = planStep.fonds as string;
        switch (planStep.kind) {
          case "descriptions": {
            // The fonds' own manifests first, a batch per step, so a
            // failure here leaves the fonds' fingerprint unrecorded.
            let manifests: OwnManifestState | undefined;
            for (let i = 0; ; i++) {
              const prior = manifests;
              manifests = await step.do(`manifests:${fonds}:${i}`, MANIFESTS_STEP_CONFIG, async () =>
                refreshOwnManifests(
                  { db, env: this.env, storage, fetchImpl: this.manifestFetcher(), sleep },
                  config.fondsTenants[fonds],
                  fonds,
                  { force, state: prior }
                )
              );
              if (!manifests || manifests.done) break;
            }
            const rewritten = manifests?.counts.written ?? 0;
            if (rewritten > 0) counts[`manifests:${fonds}`] = rewritten;

            // One step per fonds — each gets its own runtime budget.
            const result = await step.do(`descriptions:${fonds}`, DESCRIPTIONS_STEP_CONFIG, async () => {
              await recordStepStart(db, exportId, `descriptions:${fonds}`);
              const r = await perFonds("descriptions", fonds, () =>
                exportFondsDescriptions(
                  db,
                  storage,
                  fonds,
                  config.fondsTenants[fonds],
                  config.memberTenantIds
                )
              );
              counts[`descriptions:${fonds}`] = r.recordCount;
              noteSkipped(`descriptions:${fonds}`, r);
              await recordStepEnd(db, exportId, `descriptions:${fonds}`, recorded());
              return r;
            });
            counts[`descriptions:${fonds}`] = result.recordCount;
            noteSkipped(`descriptions:${fonds}`, result);
            break;
          }

          case "index":
            // One step to write descriptions-index.json. The single combined
            // descriptions.json file was deliberately NOT produced by the worker
            // after Task 4 verification showed that R2 streaming put in
            // wrangler dev local deadlocks on large bodies AND production-scale
            // fonds exceed single-Worker memory even with a byte-level scanner.
            // zasqua reads the per-fonds files + this index at build
            // time to produce the concatenated descriptions.json for its static
            // site, and builds only the fonds the index lists.
            counts["descriptions:index"] = await step.do("descriptions:index", async () => {
              await recordStepStart(db, exportId, "descriptions:index");
              const perFondsCounts: Record<string, number> = {};
              for (const f of config.selectedFonds) {
                perFondsCounts[f] = counts[`descriptions:${f}`] ?? 0;
              }
              // The index lists every published fonds of the publishing
              // tenant, not only this run's: a fonds is published when its
              // root description, in any member tenant, is published.
              // The writer keeps the stored entries of the fonds this run
              // did not select, and fails the run when it cannot read them
              // or the stored index leaves out a published fonds with a file.
              const publishedRoots = await db
                .select({ referenceCode: descriptions.referenceCode })
                .from(descriptions)
                .where(
                  and(
                    inArray(descriptions.tenantId, config.memberTenantIds),
                    isNull(descriptions.parentId),
                    eq(descriptions.isPublished, true)
                  )
                )
                .orderBy(descriptions.referenceCode)
                .all();
              const publishedFonds = [
                ...new Set(publishedRoots.flatMap((r) => (r.referenceCode ? [r.referenceCode] : []))),
              ];
              const r = await writeDescriptionsIndex(
                storage,
                config.selectedFonds,
                perFondsCounts,
                config.publishTenant,
                publishedFonds
              );
              counts["descriptions:index"] = r.totalRecordCount;
              await recordStepEnd(db, exportId, "descriptions:index", recorded());
              return r.totalRecordCount;
            });
            break;

          case "children":
            // One step PER FONDS for children — never tens of thousands of PUTs
            // in one Worker invocation.
            {
              const result = await step.do(`children:${fonds}`, async () => {
                await recordStepStart(db, exportId, `children:${fonds}`);
                const r = await perFonds("children", fonds, () =>
                  exportFondsChildren(db, storage, fonds, config.fondsTenants[fonds])
                );
                counts[`children:${fonds}`] = r.putCount;
                noteSkipped(`children:${fonds}`, r);
                await recordStepEnd(db, exportId, `children:${fonds}`, recorded());
                return r;
              });
              counts[`children:${fonds}`] = result.putCount;
              noteSkipped(`children:${fonds}`, result);
            }
            break;

          case "ead":
            // EAD3 finding aid per fonds. Profile picked from
            // tenant.descriptiveStandard inside exportFondsEad. R2 key:
            // ${tenant.slug}/ead/<sanitisedRef>.xml.
            {
              const result = await step.do(`ead:${fonds}`, async () => {
                await recordStepStart(db, exportId, `ead:${fonds}`);
                const r = await perFonds("ead", fonds, () =>
                  exportFondsEad(db, storage, fonds, config.fondsTenants[fonds])
                );
                counts[`ead:${fonds}`] = r.recordCount;
                noteSkipped(`ead:${fonds}`, r);
                await recordStepEnd(db, exportId, `ead:${fonds}`, recorded());
                return r;
              });
              counts[`ead:${fonds}`] = result.recordCount;
              noteSkipped(`ead:${fonds}`, result);
            }
            break;

          case "dc":
            // Dublin Core bulk file per fonds. OAI-PMH 2.0 ListRecords
            // envelope; one <record> per published description. R2 key:
            // ${tenant.slug}/dc/<sanitisedRef>.xml.
            {
              const result = await step.do(`dc:${fonds}`, async () => {
                await recordStepStart(db, exportId, `dc:${fonds}`);
                const r = await perFonds("dc", fonds, () =>
                  exportFondsDc(db, storage, fonds, config.fondsTenants[fonds])
                );
                counts[`dc:${fonds}`] = r.recordCount;
                noteSkipped(`dc:${fonds}`, r);
                await recordStepEnd(db, exportId, `dc:${fonds}`, recorded());
                return r;
              });
              counts[`dc:${fonds}`] = result.recordCount;
              noteSkipped(`dc:${fonds}`, result);
            }
            break;

          case "repositories":
            counts.repositories = await step.do("repositories", async () => {
              await recordStepStart(db, exportId, "repositories");
              const r = await exportRepositories(db, storage, config.publishTenant, config.memberTenantIds);
              counts.repositories = r.count;
              await recordStepEnd(db, exportId, "repositories", recorded());
              return r.count;
            });
            break;

          // Entities/places export the authority junctions; the plan
          // leaves both out when the triggering tenant lacks the
          // authorities capability (spec §6).
          case "entities":
            counts.entities = await step.do("entities", async () => {
              await recordStepStart(db, exportId, "entities");
              const r = await exportEntities(db, storage, config.publishTenant, config.memberTenantIds);
              counts.entities = r.count;
              await recordStepEnd(db, exportId, "entities", recorded());
              return r.count;
            });
            break;

          case "places":
            counts.places = await step.do("places", async () => {
              await recordStepStart(db, exportId, "places");
              const r = await exportPlaces(db, storage, config.publishTenant, config.memberTenantIds);
              counts.places = r.count;
              await recordStepEnd(db, exportId, "places", recorded());
              return r.count;
            });
            break;

          case "entity_links":
          case "place_links": {
            // Link files: one multipart upload each, carried across as many
            // steps as the rows need. Each step's name is its index, and its
            // input is the state the previous step returned, so a replayed
            // workflow re-enters at the same point.
            const name = planStep.kind;
            const runLinkFile = linkFileRunners[name];
            let state: LinkExportState | undefined;
            for (let i = 0; !state?.done; i++) {
              const stepName = `${name}:${i}`;
              const prior = state;
              state = await step.do(stepName, async () => {
                await recordStepStart(db, exportId, stepName);
                const r = await runLinkFile(
                  db,
                  storage,
                  config.publishTenant,
                  config.memberTenantIds,
                  { state: prior }
                );
                // Only the step that completes the file counts as a
                // completed step; the plan holds one per link file.
                if (r.done) {
                  counts[name] = r.count;
                  await recordStepEnd(db, exportId, stepName, recorded());
                }
                return r;
              });
              linkStates[name] = state;
              counts[name] = state.count;
            }
            break;
          }
        }
      }

      // The federation's publisher.json and vocabulary.json, on every
      // publish whatever its types. Not a plan step: like load-config and
      // finalize it records nothing, so total_steps and the progress
      // panel are unchanged.
      await step.do("institution", async () => {
        await exportInstitutionFiles(db, storage, config.publishTenant);
      });

      await step.do("finalize", async () => {
        await db
          .update(exportRuns)
          .set({
            status: "complete",
            completedAt: Date.now(),
            recordCounts: JSON.stringify(recorded()),
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

      // Marking the run failed is its own step, retried with backoff:
      // the failure may be D1 refusing queries or the invocation's
      // subrequest limit, and a later attempt runs in a new invocation.
      // A run left `running` blocks the next publish until it goes
      // stale. The write sets the same status and message on every attempt,
      // so a refused attempt that was applied after all does no harm. The
      // error that ended the run must still be the one re-thrown below.
      try {
        await step.do("record-failure", RECORD_FAILURE_STEP_CONFIG, async () => {
          await db
            .update(exportRuns)
            .set({
              status: "error",
              errorMessage: message,
              completedAt: Date.now(),
            })
            .where(eq(exportRuns.id, exportId));
        });
      } catch (writeErr) {
        console.warn("Could not record the failed publish on its run:", writeErr);
      }

      // Remove the staging objects and open multipart upload of any link
      // file left unfinished; the next publish uses a new token and would
      // never reuse them. Cleanup is best-effort and must not replace the
      // error that ended the run.
      try {
        await step.do("cleanup-link-files", async () => {
          await abandonLinkExports(storage, Object.values(linkStates));
        });
      } catch (cleanupErr) {
        console.warn("Link-file cleanup after a failed publish did not complete:", cleanupErr);
      }

      // Re-throw so the Workflows runtime sees the failure and the dashboard
      // shows the run as errored too. Without re-throwing, Workflows would
      // mark the run as complete from its perspective.
      throw err;
    }
  }
}

// @version v0.9.0
