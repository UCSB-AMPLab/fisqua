/**
 * Media Pipeline — Dispatch
 *
 * This module deals with starting a pipeline run: checking that the
 * requested volumes may be processed, recording the run, publishing its
 * spec and asking GitHub to start the runner, one dispatch per chunk of
 * at most 256 jobs.
 *
 * `startPipelineRun` works through a fixed sequence. Every refusal is a
 * `StartRunRefusal` carrying a code the route returns, and every check
 * that can refuse runs before anything that belongs to the new run is
 * written:
 *
 *   1. The capability and federation-lead gate.
 *   2. The tenant's open runs whose token has expired are closed, so a
 *      volume they named is free again whether or not the scheduled
 *      handler runs.
 *   3. The settings a dispatch needs are present, the runner repository
 *      is named as `owner/name`, the GitHub App's private key imports
 *      (once per isolate), the deployment's
 *      environment is `production` or `staging` (it names the runner's
 *      key store in the spec), the runner image is pinned by digest, the
 *      tenant's storage destination is complete (its federation's
 *      columns and secrets; `tenant_destination_unset`
 *      otherwise, naming what is missing and never a value), and the
 *      request names at least one volume and no more than the run-size
 *      limit.
 *   4. Every volume belongs to the tenant, has the request's kind, is in
 *      Received, is held by no open run and has a reference code that
 *      can be a tile root. A published volume is refused separately,
 *      because regenerating one is not supported. A volume whose pages
 *      came from a Captua capture delivery is refused until every
 *      opening of that delivery is approved in capture QC
 *      (`capture_qc_pending`, `app/lib/capture/hold.server.ts`).
 *   5. Each volume's declaration family resolves to its latest version;
 *      a wave needs a gate pass for that exact row and the configured
 *      script version, and a sample run is limited in size.
 *   6. Page lists are read and checked against the cross-field rules,
 *      recipes are resolved, and each volume's description is read in
 *      the tenant; a volume whose description is not found there is
 *      refused, because its spec entry cannot be built. Each volume's
 *      manifest block is asked of the manifest resolver built for the
 *      tenant's manifest address (its federation's `manifest_base_url`
 *      and its slug), with the description, its
 *      repository and the tenant; a repository without
 *      manifest rights is refused (`repository_rights_unset`), and so is
 *      one with an attribution in one language only
 *      (`repository_attribution_incomplete`), each naming the
 *      repository. Each page's `rotate_deg` is read from its volume's
 *      registered delivery (`readPageRotateDegs`); a page that two of
 *      the delivery's page images match is refused as
 *      `invalid_page_list` with rule `page_image_ambiguous`; when any
 *      page has one
 *      and the runner's script version is below v1.2.0
 *      (`ROTATE_DEG_FROM`), whose schema refuses the field, the request
 *      is refused (`rotate_deg_unsupported`, naming the volumes). When
 *      the runner's script version is v1.1.0 or later
 *      (`ROTATE_AND_PURGE_FROM`), each volume's capture QC rotations are
 *      read (`readPageRotations`) with its decision set's revision, and,
 *      when the federation has a review-tiles bucket, the review prefixes
 *      still to purge (`readReviewPurges`). Volumes are then grouped into
 *      jobs.
 *   7. The token and spec URL lifetimes are computed; a run whose URL
 *      would outlive a presigned URL's seven-day ceiling is refused.
 *   8. Restriction: a volume whose restricted flag is set refuses the
 *      whole request. The flag is set per volume; the description's
 *      access conditions are not read for it. This check comes last.
 *   9. The token is minted and the spec built and validated. Its
 *      destination is the federation's tiles bucket and endpoint, with
 *      the tenant's slug as the tiles prefix, under `ocr/` in it as the
 *      OCR prefix, and after the federation's image address. A page
 *      whose image carries a rotation carries `rotate_deg`, 0 included.
 *      From v1.1.0, a page capture QC rotated carries `quarter_turns`; with a
 *      review-tiles bucket as well, the spec names it in a `review` block
 *      on the federation's delivery endpoint, and each volume lists in
 *      `review_purge` the prefix of every review run of its deliveries,
 *      earlier deliveries included, whose purge is not yet recorded. A
 *      volume with none lists nothing. A review row is used only when
 *      its delivery is one of that volume's and its prefix is exactly
 *      `{slug}/{delivery id}/`. Below v1.1.0 none of this is read or
 *      written, and the spec is the one v1.0.0 reads. A spec with review
 *      fields is held to the strict bucket and endpoint rules; a working
 *      store they refuse is refused as `dispatch_unconfigured`, and a
 *      destination or review store as `tenant_destination_unset`, and a
 *      volume's masters store as `volume_source_invalid` with the
 *      volumes' ids, each naming the setting or column (`invalid`) and
 *      never its value.
 *  10. One claim batch inserts the run and its chunks (in statements
 *      sized from a measured parameter count) and takes each
 *      volume's hold, re-checking the hold inside the batch, so of two
 *      concurrent requests for one volume only one can take it; the
 *      capture QC hold is re-checked there too, so a decision recorded
 *      since step 4 that leaves an opening unapproved wins. From v1.1.0
 *      each volume's decision set must also still be at the revision
 *      read with its rotations (no set at all, for a volume that had
 *      none), so a rotation changed on an approved set since step 6
 *      loses the claim as a replaced page list does. A run
 *      that took fewer volumes than it asked for closes itself in the
 *      same batch as an error with stage `claim`.
 *  11. A lost claim is refused as if the hold had been seen in step 4,
 *      or for the capture QC hold, a page list replaced, a decision set
 *      changed since its rotations were read (`volume_pages_changed`, as
 *      for a page list) or a restriction flagged since then, whichever
 *      lost it.
 *  12. The spec is published; a failure abandons the run.
 *  13. The run-volume rows are written, one per volume, in statements
 *      sized from a measured parameter count; a failure abandons the run.
 *  14. Each chunk is dispatched in turn, authenticated with an
 *      installation token of the GitHub App (`github-app.server.ts`),
 *      minted for the runner repository alone and cached in the
 *      isolate. A 204 marks the chunk and the
 *      run dispatched, but never moves a chunk that has already reported
 *      or a run a callback has already moved.
 *  15. A dispatch failure stops sending. A 4xx means GitHub refused the
 *      event and the chunk is `not_sent`; anything else leaves it unknown
 *      whether the chunk started, so it is `failed` and keeps the run
 *      open until its completion report or token expiry. The rows of the
 *      chunks not started are recorded as aborted, and the run closes now
 *      if no chunk is left that might report. A token that cannot be
 *      minted is a failure of the same kind: the chunk is `not_sent`,
 *      since no request went out, and its error and the run's name the
 *      step that failed (`app_token_step`, `unexpected` for an error the
 *      token module did not name) beside the HTTP status, never the
 *      error's message.
 *
 * Abandoning a run closes it as an error naming the stage and marks its
 * pending chunks `not_sent`; a closed run holds nothing.
 *
 * The run-size limits, the lifetime constants, the job grouping target
 * and the recipe presets are passed in as `config`; `DEFAULT_RUN_CONFIG`
 * is built from `run-config.ts`, and a start without a config is
 * refused with `pipeline_config_unset`. Every statement
 * keeps to D1's limits: id lists are read 90 at a time, claims take 85
 * ids per statement, and no batch passes 89 statements.
 *
 * The token leaves this module only inside the stored spec. It is never
 * written to D1, logged, or put in the dispatch request. The installation
 * token, the App's key and its JWT are never written or logged either.
 *
 * Step 3's settings check (`readDispatchSettings`) and step 14's
 * request for one chunk (`postChunkDispatch`) are exported, and the
 * review run (`app/lib/capture/review-run.server.ts`) starts with the
 * same two.
 *
 * `startRunAction` is the start-run route's body: it validates the JSON
 * request, calls `startPipelineRun` and maps refusals to responses.
 *
 * @version v0.8.0
 */

import { and, asc, eq, getTableColumns, gt, gte, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";
import {
  captureDeliveries,
  captureImages,
  captureQcRotations,
  captureQcSets,
  captureReviewRuns,
  descriptions,
  pipelineGatePasses,
  pipelineRecipeDeclarations,
  pipelineRunChunks,
  pipelineRunVolumes,
  pipelineRuns,
  pipelineVolumePages,
  pipelineVolumes,
  repositories,
} from "../../db/schema";
import type { Tenant, User } from "../../context";
import { PIPELINE_RUN_KINDS, PIPELINE_RUN_PURPOSES } from "../validation/enums";
import { captureQcPendingSql, readCaptureQcPending } from "../capture/hold.server";
import { requireMediaPipelineAccess } from "./access.server";
import {
  GitHubAppTokenError,
  appPrivateKey,
  installationToken,
  type GitHubAppEnv,
  type GitHubAppTokenStep,
} from "./github-app.server";
import { pipelineEnvironmentOf, type PipelineEnvironment } from "./key-store";
import { groupJobs } from "./grouping";
import { RecipeError, resolveRecipe, type RecipePresets } from "./recipe";
import { isRestricted } from "./restriction";
import { closeRunIfChunksDone, expireRun, runHoldsVolumesSql } from "./run-state.server";
import {
  ManifestInputsError,
  RunSpecError,
  TILE_ROOT_PATTERN,
  buildRunSpec,
  checkVolumePages,
  specPages,
  specSource,
  type ManifestResolver,
  type RunSpec,
  type RunSpecRecipe,
} from "./run-spec";
import { RUN_LIFETIME_CONSTANTS, RUN_LIMITS, RUN_PRESETS } from "./run-config";
import { pipelineKey, publishRunSpec, type PipelineSpecStore } from "./store.server";
import {
  resolveTenantDestination,
  TenantDestinationError,
  type TenantDestination,
} from "./tenant-destination.server";
import {
  PRESIGN_MAX_SECONDS,
  mintRunToken,
  runLifetimes,
  type LifetimeConstants,
} from "./token.server";

// ---------------------------------------------------------------------------
// Configuration and limits
// ---------------------------------------------------------------------------

/** At most this many jobs go in one dispatch. */
export const JOBS_PER_CHUNK = 256;
/** Ids per read statement. */
export const READ_ID_CHUNK = 90;
/** Ids per claim statement, leaving room for the fixed values. */
export const CLAIM_ID_CHUNK = 85;
/** Statements per `db.batch`. */
export const BATCH_LIMIT = 89;
/** Bound parameters per statement. */
export const PARAM_LIMIT = 100;
/** How long one dispatch request may take before it counts as failed. */
export const DISPATCH_TIMEOUT_MS = 30_000;

/**
 * The runner release that reads `quarter_turns` and `review_purge`.
 * Below it, dispatch reads neither and the spec carries neither.
 */
export const ROTATE_AND_PURGE_FROM = [1, 1, 0] as const;

/**
 * The runner release that reads a page's `rotate_deg`. An older runner
 * refuses a page key its schema does not name, so a volume whose pages
 * carry one is refused below it (`rotate_deg_unsupported`) and never
 * sent.
 */
export const ROTATE_DEG_FROM = [1, 2, 0] as const;

const RUNNER_IMAGE_PATTERN = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
const DISPATCH_REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const DISPATCH_EVENT_TYPE = "fisqua-pipeline-run";

/** The values a run is sized and timed by. */
export interface PipelineRunConfig {
  maxRunVolumes: number;
  maxRunPages: number;
  maxSampleVolumes: number;
  targetImagesPerJob: number;
  lifetime: LifetimeConstants;
  presets: RecipePresets;
}

/** The configuration the start-run route uses. */
export const DEFAULT_RUN_CONFIG: PipelineRunConfig | null = {
  ...RUN_LIMITS,
  lifetime: RUN_LIFETIME_CONSTANTS,
  presets: RUN_PRESETS,
};

/** The settings this module reads. `Env` is assignable to it. */
export interface PipelineDispatchEnv extends GitHubAppEnv {
  PIPELINE_DISPATCH_REPO?: string;
  PIPELINE_CALLBACK_ORIGIN?: string;
  PIPELINE_SPEC_S3_ENDPOINT?: string;
  PIPELINE_SPEC_BUCKET?: string;
  PIPELINE_SPEC_KEY_ID?: string;
  PIPELINE_SPEC_SECRET_KEY?: string;
  PIPELINE_WORKING_S3_ENDPOINT?: string;
  PIPELINE_WORKING_BUCKET?: string;
  PIPELINE_RUNNER_IMAGE?: string;
  PIPELINE_SCRIPT_VERSION?: string;
  PIPELINE_ENVIRONMENT?: string;
}

const REQUIRED_SETTINGS = [
  "PIPELINE_GITHUB_APP_ID",
  "PIPELINE_GITHUB_APP_INSTALLATION_ID",
  "PIPELINE_GITHUB_APP_PRIVATE_KEY",
  "PIPELINE_DISPATCH_REPO",
  "PIPELINE_CALLBACK_ORIGIN",
  "PIPELINE_SPEC_S3_ENDPOINT",
  "PIPELINE_SPEC_BUCKET",
  "PIPELINE_SPEC_KEY_ID",
  "PIPELINE_SPEC_SECRET_KEY",
  "PIPELINE_WORKING_S3_ENDPOINT",
  "PIPELINE_WORKING_BUCKET",
  "PIPELINE_SCRIPT_VERSION",
  "PIPELINE_ENVIRONMENT",
] as const satisfies ReadonlyArray<keyof PipelineDispatchEnv>;

export interface StartRunDeps {
  db: DrizzleD1Database<any>;
  env: PipelineDispatchEnv;
  specStore: PipelineSpecStore;
  fetchImpl: typeof fetch;
  /** Builds the manifest resolver for the tenant's manifest base URL. */
  manifestResolverFor: (manifestBaseUrl: string) => ManifestResolver;
  config: PipelineRunConfig | null;
  now: () => number;
  newId: () => string;
}

export interface StartRunInput {
  tenant: Tenant;
  user: User;
  pipelineVolumeIds: string[];
  kind: "volume_run" | "item_pdf";
  purpose: "sample" | "wave";
  maxReviewFrac: number;
}

export type StartRunRefusalCode =
  | "pipeline_config_unset"
  | "dispatch_unconfigured"
  | "runner_image_invalid"
  | "tenant_destination_unset"
  | "invalid_request"
  | "run_too_large"
  | "volume_not_found"
  | "volume_kind"
  | "volume_state"
  | "regeneration_not_supported"
  | "volume_in_open_run"
  | "capture_qc_pending"
  | "volume_pages_changed"
  | "invalid_reference_code"
  | "no_declaration"
  | "gate_not_passed"
  | "invalid_page_list"
  | "recipe_invalid"
  | "manifest_inputs_unavailable"
  | "repository_rights_unset"
  | "repository_attribution_incomplete"
  | "run_too_long"
  | "description_not_found"
  | "restricted_material"
  | "volume_source_invalid"
  | "rotate_deg_unsupported";

/** A start-run request refused before anything of the new run was dispatched. */
export class StartRunRefusal extends Error {
  readonly code: StartRunRefusalCode;
  readonly detail: Record<string, unknown>;
  readonly status: 400 | 404;
  constructor(
    code: StartRunRefusalCode,
    detail: Record<string, unknown> = {},
    status: 400 | 404 = 400,
  ) {
    super(`Pipeline run refused: ${code}`);
    this.name = "StartRunRefusal";
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

type VolumeRow = typeof pipelineVolumes.$inferSelect;
type DeclarationRow = typeof pipelineRecipeDeclarations.$inferSelect;
type PageRow = typeof pipelineVolumePages.$inferSelect;
type DescriptionRow = typeof descriptions.$inferSelect;
type RepositoryRow = typeof repositories.$inferSelect;
type RunVolumeInsert = typeof pipelineRunVolumes.$inferInsert;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function runBatch(db: DrizzleD1Database<any>, statements: BatchItem<"sqlite">[]) {
  if (statements.length === 0) return;
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

// ---------------------------------------------------------------------------
// The run-volume insert, sized from a measured parameter count
// ---------------------------------------------------------------------------

// The tenant is stamped on every row here, so the statement carries it
// whatever the caller built.
function runVolumeInsert(
  db: DrizzleD1Database<any>,
  tenantId: string,
  rows: Omit<RunVolumeInsert, "tenantId">[],
) {
  return db.insert(pipelineRunVolumes).values(rows.map((row) => ({ tenantId, ...row })));
}

// A builder over a client that is never called, used only to render the
// statement and count its parameters.
const probeDb = drizzle({} as unknown as D1Database);

/** Parameters bound by a one-row run-volume insert. */
export const RUN_VOLUME_INSERT_PARAMS = runVolumeInsert(probeDb, "", [
  {
    id: "",
    runId: "",
    pipelineVolumeId: "",
    declarationId: "",
    jobIndex: 0,
    chunkIndex: 0,
    referenceCode: "",
    tileRoot: "",
    expectedCount: 1,
    resolvedRecipe: "{}",
    status: "dispatched",
    flagsTruncated: false,
    createdAt: 0,
  },
]).toSQL().params.length;

/** Rows per run-volume insert statement. */
export const RUN_VOLUME_ROWS_PER_STATEMENT = Math.floor(PARAM_LIMIT / RUN_VOLUME_INSERT_PARAMS);

/** Parameters bound by a one-row run-chunk insert. */
export const CHUNK_INSERT_PARAMS = probeDb
  .insert(pipelineRunChunks)
  .values([{ id: "", runId: "", tenantId: "", chunkIndex: 0, status: "pending", createdAt: 0 }])
  .toSQL().params.length;

/** Rows per run-chunk insert statement. */
export const CHUNK_ROWS_PER_STATEMENT = Math.floor(PARAM_LIMIT / CHUNK_INSERT_PARAMS);

// ---------------------------------------------------------------------------
// Statement builders
// ---------------------------------------------------------------------------

function runIsOpen(runId: string, tenantId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM pipeline_runs WHERE id = ${runId} AND tenant_id = ${tenantId} AND token_revoked_at IS NULL)`;
}

export interface ClaimArgs {
  run: typeof pipelineRuns.$inferInsert & { id: string; tenantId: string; volumeCount: number };
  chunkIds: string[];
  volumeIds: string[];
  /**
   * Each volume's `pages_revision` as read with the pages the spec was
   * built from. A volume is claimed only at that revision; absent, the
   * revision is not checked.
   */
  pagesRevisions?: Map<string, number>;
  /**
   * The revision of each volume's capture QC decision set, as read with
   * its rotations; a volume missing here had no set. A volume is claimed
   * only while its set is at that revision, or still absent. Absent, the
   * sets are not checked.
   */
  qcRevisions?: Map<string, number>;
  kind: StartRunInput["kind"];
  now: number;
}

/**
 * The claim batch of step 10, in order: the run, its chunks, the holds,
 * the lost-claim close, the chunks of a lost claim, and the restriction
 * record of a won claim. Pure: it builds, it does not run.
 */
export function buildClaimStatements(
  db: DrizzleD1Database<any>,
  args: ClaimArgs,
): BatchItem<"sqlite">[] {
  const { run, now } = args;
  const runId = run.id;
  const tenantId = run.tenantId;
  const statements: BatchItem<"sqlite">[] = [];

  // a. The run.
  statements.push(db.insert(pipelineRuns).values(run));

  // b. Its chunks, in as many statements as the parameter limit needs.
  const chunkRows = args.chunkIds.map((id, chunkIndex) => ({
    id,
    runId,
    tenantId,
    chunkIndex,
    status: "pending" as const,
    createdAt: now,
  }));
  for (const rows of chunked(chunkRows, CHUNK_ROWS_PER_STATEMENT)) {
    statements.push(db.insert(pipelineRunChunks).values(rows));
  }

  // c. The holds, re-checked here so a volume taken since step 4 is not
  // taken twice, and a volume flagged restricted since then is not taken.
  // A volume whose page list was replaced since the pages were read (its
  // revision moved on) is not taken, so the run never holds a volume its
  // spec describes with pages it no longer has, and nor is one capture QC
  // holds. The QC condition binds nothing. A volume whose decision set
  // was written since its rotations were read is not taken either, so
  // the spec never carries rotations its set no longer records.
  for (const ids of chunked(args.volumeIds, CLAIM_ID_CHUNK)) {
    const revisions = args.pagesRevisions
      ? JSON.stringify(ids.map((id) => [id, args.pagesRevisions?.get(id) ?? -1]))
      : null;
    const qcRevisions = args.qcRevisions
      ? JSON.stringify(ids.map((id) => [id, args.qcRevisions?.get(id) ?? -1]))
      : null;
    statements.push(
      db
        .update(pipelineVolumes)
        .set({ heldByRunId: runId, updatedAt: now })
        .where(
          and(
            eq(pipelineVolumes.tenantId, tenantId),
            inArray(pipelineVolumes.id, ids),
            eq(pipelineVolumes.state, "received"),
            eq(pipelineVolumes.kind, args.kind),
            eq(pipelineVolumes.restricted, false),
            sql`(${pipelineVolumes.heldByRunId} IS NULL OR NOT EXISTS (SELECT 1 FROM pipeline_runs r WHERE r.id = pipeline_volumes.held_by_run_id AND r.tenant_id = ${tenantId} AND (${runHoldsVolumesSql(now)})))`,
            revisions === null
              ? undefined
              : sql`EXISTS (SELECT 1 FROM json_each(${revisions}) j WHERE json_extract(j.value, '$[0]') = ${pipelineVolumes.id} AND json_extract(j.value, '$[1]') = ${pipelineVolumes.pagesRevision})`,
            sql`NOT ${captureQcPendingSql()}`,
            qcRevisions === null
              ? undefined
              : sql`COALESCE((SELECT qs.revision FROM capture_deliveries qd JOIN capture_qc_sets qs ON qs.tenant_id = qd.tenant_id AND qs.delivery_id = qd.id WHERE qd.tenant_id = pipeline_volumes.tenant_id AND qd.pipeline_volume_id = pipeline_volumes.id AND qd.state = 'registered'), -1) = (SELECT json_extract(j.value, '$[1]') FROM json_each(${qcRevisions}) j WHERE json_extract(j.value, '$[0]') = ${pipelineVolumes.id})`,
          ),
        ),
    );
  }

  // d. A run that took fewer volumes than it asked for closes itself.
  statements.push(
    db
      .update(pipelineRuns)
      .set({
        status: "error",
        error: JSON.stringify({ class: "dispatch", stage: "claim" }),
        tokenRevokedAt: now,
      })
      .where(
        and(
          eq(pipelineRuns.id, runId),
          eq(pipelineRuns.tenantId, tenantId),
          isNull(pipelineRuns.tokenRevokedAt),
          sql`(SELECT COUNT(*) FROM pipeline_volumes WHERE tenant_id = ${tenantId} AND held_by_run_id = ${runId}) < ${pipelineRuns.volumeCount}`,
        ),
      ),
  );

  // e. The chunks of a closed claim are never sent.
  statements.push(
    db
      .update(pipelineRunChunks)
      .set({ status: "not_sent" })
      .where(
        and(
          eq(pipelineRunChunks.runId, runId),
          eq(pipelineRunChunks.tenantId, tenantId),
          sql`EXISTS (SELECT 1 FROM pipeline_runs WHERE id = ${runId} AND tenant_id = ${tenantId} AND token_revoked_at IS NOT NULL)`,
        ),
      ),
  );

  // f. The restriction check is recorded on the volumes of a won claim.
  // The flag itself is never written here.
  statements.push(
    db
      .update(pipelineVolumes)
      .set({ restrictionCheckedAt: now })
      .where(
        and(
          eq(pipelineVolumes.tenantId, tenantId),
          eq(pipelineVolumes.heldByRunId, runId),
          runIsOpen(runId, tenantId),
        ),
      ),
  );

  return statements;
}

/** Closes a run that failed before any chunk was sent. */
export function buildAbandonStatements(
  db: DrizzleD1Database<any>,
  args: { runId: string; tenantId: string; stage: string; now: number },
): BatchItem<"sqlite">[] {
  return [
    db
      .update(pipelineRuns)
      .set({
        status: "error",
        error: JSON.stringify({ class: "dispatch", stage: args.stage }),
        tokenRevokedAt: args.now,
      })
      .where(
        and(
          eq(pipelineRuns.id, args.runId),
          eq(pipelineRuns.tenantId, args.tenantId),
          isNull(pipelineRuns.tokenRevokedAt),
        ),
      ),
    db
      .update(pipelineRunChunks)
      .set({ status: "not_sent" })
      .where(
        and(
          eq(pipelineRunChunks.runId, args.runId),
          eq(pipelineRunChunks.tenantId, args.tenantId),
          eq(pipelineRunChunks.status, "pending"),
        ),
      ),
  ];
}

/** The batch after a 204 for chunk `chunkIndex`. */
export function buildDispatchedStatements(
  db: DrizzleD1Database<any>,
  args: { runId: string; tenantId: string; chunkIndex: number; now: number },
): BatchItem<"sqlite">[] {
  return [
    db
      .update(pipelineRunChunks)
      .set({ status: "dispatched", dispatchedAt: args.now })
      .where(
        and(
          eq(pipelineRunChunks.runId, args.runId),
          eq(pipelineRunChunks.tenantId, args.tenantId),
          eq(pipelineRunChunks.chunkIndex, args.chunkIndex),
          eq(pipelineRunChunks.status, "pending"),
        ),
      ),
    db
      .update(pipelineRuns)
      .set({ status: "dispatched", dispatchedAt: args.now })
      .where(
        and(
          eq(pipelineRuns.id, args.runId),
          eq(pipelineRuns.tenantId, args.tenantId),
          eq(pipelineRuns.status, "pending"),
        ),
      ),
  ];
}

export interface DispatchFailure {
  runId: string;
  tenantId: string;
  chunkIndex: number;
  /** The HTTP status, or null for a timeout or a network error. */
  httpStatus: number | null;
  /**
   * Set when the installation token could not be minted: the step that
   * failed. The chunk was never sent, whatever the status.
   */
  appTokenStep?: GitHubAppTokenStep;
  failClaim: string;
  now: number;
}

/** The batch after chunk `chunkIndex` failed, statements a to g of step 15. */
export function buildDispatchFailureStatements(
  db: DrizzleD1Database<any>,
  f: DispatchFailure,
): BatchItem<"sqlite">[] {
  const { runId, tenantId, chunkIndex, now } = f;
  const refused =
    f.appTokenStep !== undefined ||
    (f.httpStatus !== null && f.httpStatus >= 400 && f.httpStatus < 500);
  // A token failure names its step, so the record tells it from GitHub
  // refusing the dispatch itself.
  const tokenFailure = f.appTokenStep === undefined ? {} : { app_token_step: f.appTokenStep };
  const open = runIsOpen(runId, tenantId);
  const statements: BatchItem<"sqlite">[] = [];

  // a. This chunk, and every later chunk still pending.
  statements.push(
    db
      .update(pipelineRunChunks)
      .set({
        status: refused ? "not_sent" : "failed",
        dispatchError: JSON.stringify({ ...tokenFailure, status: f.httpStatus }),
      })
      .where(
        and(
          eq(pipelineRunChunks.runId, runId),
          eq(pipelineRunChunks.tenantId, tenantId),
          eq(pipelineRunChunks.chunkIndex, chunkIndex),
          eq(pipelineRunChunks.status, "pending"),
          open,
        ),
      ),
  );
  statements.push(
    db
      .update(pipelineRunChunks)
      .set({ status: "not_sent" })
      .where(
        and(
          eq(pipelineRunChunks.runId, runId),
          eq(pipelineRunChunks.tenantId, tenantId),
          gt(pipelineRunChunks.chunkIndex, chunkIndex),
          eq(pipelineRunChunks.status, "pending"),
          open,
        ),
      ),
  );

  // b. The rows of this chunk and every later one, still unreported.
  statements.push(
    db
      .update(pipelineRunVolumes)
      .set({
        status: "aborted",
        error: sql`json_object('class', 'dispatch', 'chunk_index', ${pipelineRunVolumes.chunkIndex})`,
        claimId: f.failClaim,
        reportedAt: now,
      })
      .where(
        and(
          eq(pipelineRunVolumes.runId, runId),
          eq(pipelineRunVolumes.tenantId, tenantId),
          gte(pipelineRunVolumes.chunkIndex, chunkIndex),
          eq(pipelineRunVolumes.status, "dispatched"),
          open,
        ),
      ),
  );

  // c. Their volumes record the error; their state is unchanged.
  statements.push(
    db
      .update(pipelineVolumes)
      .set({
        lastError: sql`(SELECT rv.error FROM pipeline_run_volumes rv WHERE rv.run_id = ${runId} AND rv.tenant_id = ${tenantId} AND rv.pipeline_volume_id = pipeline_volumes.id AND rv.claim_id = ${f.failClaim})`,
        lastRunId: runId,
        updatedAt: now,
      })
      .where(
        and(
          eq(pipelineVolumes.tenantId, tenantId),
          eq(pipelineVolumes.heldByRunId, runId),
          sql`${pipelineVolumes.id} IN (SELECT pipeline_volume_id FROM pipeline_run_volumes WHERE run_id = ${runId} AND tenant_id = ${tenantId} AND claim_id = ${f.failClaim})`,
        ),
      ),
  );

  // d. They count as reported.
  statements.push(
    db
      .update(pipelineRuns)
      .set({
        volumesReported: sql`${pipelineRuns.volumesReported} + (SELECT COUNT(*) FROM pipeline_run_volumes WHERE run_id = ${runId} AND tenant_id = ${tenantId} AND claim_id = ${f.failClaim})`,
      })
      .where(
        and(
          eq(pipelineRuns.id, runId),
          eq(pipelineRuns.tenantId, tenantId),
          isNull(pipelineRuns.tokenRevokedAt),
        ),
      ),
  );

  // e. The run's error, unless one is recorded already.
  statements.push(
    db
      .update(pipelineRuns)
      .set({
        error: sql`COALESCE(${pipelineRuns.error}, ${JSON.stringify({
          class: "dispatch",
          ...tokenFailure,
          chunk_index: chunkIndex,
          status: f.httpStatus,
        })})`,
      })
      .where(
        and(
          eq(pipelineRuns.id, runId),
          eq(pipelineRuns.tenantId, tenantId),
          isNull(pipelineRuns.tokenRevokedAt),
        ),
      ),
  );

  // f. GitHub refused the first chunk, or no token could be minted for
  // it: nothing started, the run is over.
  if (refused && chunkIndex === 0) {
    statements.push(
      db
        .update(pipelineRuns)
        .set({ status: "error", tokenRevokedAt: now })
        .where(
          and(
            eq(pipelineRuns.id, runId),
            eq(pipelineRuns.tenantId, tenantId),
            eq(pipelineRuns.status, "pending"),
            isNull(pipelineRuns.tokenRevokedAt),
          ),
        ),
    );
  }

  // g. Close the run if no chunk is left that might report.
  statements.push(closeRunIfChunksDone(db, { runId, tenantId, now }));

  return statements;
}

// ---------------------------------------------------------------------------
// Settings and the dispatch request, shared with the review run
// ---------------------------------------------------------------------------

export interface DispatchSettings {
  environment: PipelineEnvironment;
  runnerImage: string;
  scriptVersion: string;
}

/**
 * Step 3's settings check: every setting a dispatch needs is present,
 * the runner repository is `owner/name`, the App's private key imports,
 * the environment is one the runner knows and the image is pinned by
 * digest. Throws a `StartRunRefusal` naming what is missing or invalid.
 */
export async function readDispatchSettings(env: PipelineDispatchEnv): Promise<DispatchSettings> {
  const missing = REQUIRED_SETTINGS.filter((name) => {
    const value = env[name];
    return typeof value !== "string" || value.trim() === "";
  });
  if (missing.length > 0) throw new StartRunRefusal("dispatch_unconfigured", { missing });
  if (!DISPATCH_REPO_PATTERN.test((env.PIPELINE_DISPATCH_REPO ?? "").trim())) {
    throw new StartRunRefusal("dispatch_unconfigured", { invalid: ["PIPELINE_DISPATCH_REPO"] });
  }
  try {
    await appPrivateKey(env.PIPELINE_GITHUB_APP_PRIVATE_KEY ?? "");
  } catch {
    throw new StartRunRefusal("dispatch_unconfigured", {
      invalid: ["PIPELINE_GITHUB_APP_PRIVATE_KEY"],
    });
  }
  const environment = pipelineEnvironmentOf(env.PIPELINE_ENVIRONMENT);
  if (environment === null) {
    throw new StartRunRefusal("dispatch_unconfigured", { invalid: ["PIPELINE_ENVIRONMENT"] });
  }
  const runnerImage = env.PIPELINE_RUNNER_IMAGE ?? "";
  if (!RUNNER_IMAGE_PATTERN.test(runnerImage)) throw new StartRunRefusal("runner_image_invalid");
  return { environment, runnerImage, scriptVersion: env.PIPELINE_SCRIPT_VERSION as string };
}

/** What became of one chunk's dispatch request. */
export type ChunkDispatchResult =
  | { sent: true; httpStatus: number | null }
  | { sent: false; httpStatus: number | null; appTokenStep: GitHubAppTokenStep };

/**
 * Step 14's request for one chunk: an installation token of the GitHub
 * App, then the `repository_dispatch` event naming the run, its spec
 * URL and the chunk. A token that cannot be minted is reported with the
 * step that failed and the request is not sent; a request that fails or
 * times out has a null status. Nothing is written.
 */
export async function postChunkDispatch(
  env: PipelineDispatchEnv,
  fetchImpl: typeof fetch,
  now: number,
  payload: { runId: string; specUrl: string; chunkIndex: number; chunkCount: number },
): Promise<ChunkDispatchResult> {
  let token: string;
  try {
    token = await installationToken(env, fetchImpl, now);
  } catch (err) {
    // Only the step and status are recorded, never the error's message.
    const named = err instanceof GitHubAppTokenError;
    return { sent: false, httpStatus: named ? err.status : null, appTokenStep: named ? err.step : "unexpected" };
  }
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${env.PIPELINE_DISPATCH_REPO}/dispatches`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "fisqua",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event_type: DISPATCH_EVENT_TYPE,
        client_payload: {
          spec_version: 1,
          run_id: payload.runId,
          spec_url: payload.specUrl,
          chunk_index: payload.chunkIndex,
          chunk_count: payload.chunkCount,
        },
      }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
    await res.body?.cancel();
    return { sent: true, httpStatus: res.status };
  } catch {
    return { sent: true, httpStatus: null };
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

type VolumeWithHold = VolumeRow & { held: number };

async function readVolumes(
  db: DrizzleD1Database<any>,
  tenantId: string,
  ids: string[],
  now: number,
): Promise<VolumeWithHold[]> {
  const out: VolumeWithHold[] = [];
  for (const chunk of chunked(ids, READ_ID_CHUNK)) {
    const rows = await db
      .select({
        ...getTableColumns(pipelineVolumes),
        held: sql<number>`EXISTS (SELECT 1 FROM pipeline_runs r WHERE r.id = pipeline_volumes.held_by_run_id AND r.tenant_id = pipeline_volumes.tenant_id AND (${runHoldsVolumesSql(now)}))`,
      })
      .from(pipelineVolumes)
      .where(and(eq(pipelineVolumes.tenantId, tenantId), inArray(pipelineVolumes.id, chunk)))
      .all();
    out.push(...(rows as VolumeWithHold[]));
  }
  return out;
}

/** The volume checks of step 4, in request order. */
function checkVolumes(
  ids: string[],
  rows: VolumeWithHold[],
  kind: StartRunInput["kind"],
): VolumeRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new StartRunRefusal("volume_not_found", { volume_ids: missing }, 404);
  }
  const ordered = ids.map((id) => byId.get(id) as VolumeWithHold);
  const wrongKind = ordered.filter((v) => v.kind !== kind);
  if (wrongKind.length > 0) {
    throw new StartRunRefusal("volume_kind", { volume_ids: wrongKind.map((v) => v.id) });
  }
  const published = ordered.filter((v) => v.state === "published");
  if (published.length > 0) {
    throw new StartRunRefusal("regeneration_not_supported", {
      volume_ids: published.map((v) => v.id),
    });
  }
  const notReceived = ordered.filter((v) => v.state !== "received");
  if (notReceived.length > 0) {
    throw new StartRunRefusal("volume_state", {
      volumes: notReceived.map((v) => ({ id: v.id, state: v.state })),
    });
  }
  const held = ordered.filter((v) => Number(v.held) === 1);
  if (held.length > 0) {
    throw new StartRunRefusal("volume_in_open_run", { volume_ids: held.map((v) => v.id) });
  }
  const badCodes = ordered.filter((v) => !TILE_ROOT_PATTERN.test(v.referenceCode));
  if (badCodes.length > 0) {
    throw new StartRunRefusal("invalid_reference_code", {
      reference_codes: badCodes.map((v) => v.referenceCode),
    });
  }
  return ordered.map(({ held: _held, ...v }) => v);
}

async function readLatestDeclarations(
  db: DrizzleD1Database<any>,
  tenantId: string,
  scopeIds: string[],
): Promise<Map<string, DeclarationRow>> {
  const out = new Map<string, DeclarationRow>();
  for (const chunk of chunked(scopeIds, READ_ID_CHUNK)) {
    const rows = await db
      .select()
      .from(pipelineRecipeDeclarations)
      .where(
        and(
          eq(pipelineRecipeDeclarations.tenantId, tenantId),
          inArray(pipelineRecipeDeclarations.scopeDescriptionId, chunk),
          sql`${pipelineRecipeDeclarations.version} = (SELECT MAX(d2.version) FROM pipeline_recipe_declarations d2 WHERE d2.tenant_id = ${tenantId} AND d2.scope_description_id = ${pipelineRecipeDeclarations.scopeDescriptionId})`,
        ),
      )
      .all();
    for (const row of rows) out.set(row.scopeDescriptionId, row);
  }
  return out;
}

async function readGatePassed(
  db: DrizzleD1Database<any>,
  tenantId: string,
  declarationIds: string[],
  scriptVersion: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const chunk of chunked(declarationIds, READ_ID_CHUNK)) {
    const rows = await db
      .select({ declarationId: pipelineGatePasses.declarationId })
      .from(pipelineGatePasses)
      .where(
        and(
          eq(pipelineGatePasses.tenantId, tenantId),
          inArray(pipelineGatePasses.declarationId, chunk),
          eq(pipelineGatePasses.scriptVersion, scriptVersion),
        ),
      )
      .all();
    for (const row of rows) out.add(row.declarationId);
  }
  return out;
}

async function readPages(
  db: DrizzleD1Database<any>,
  tenantId: string,
  volumeIds: string[],
): Promise<Map<string, PageRow[]>> {
  const out = new Map<string, PageRow[]>(volumeIds.map((id) => [id, []]));
  for (const chunk of chunked(volumeIds, READ_ID_CHUNK)) {
    const rows = await db
      .select()
      .from(pipelineVolumePages)
      .where(
        and(
          eq(pipelineVolumePages.tenantId, tenantId),
          inArray(pipelineVolumePages.pipelineVolumeId, chunk),
        ),
      )
      .all();
    for (const row of rows) out.get(row.pipelineVolumeId)?.push(row);
  }
  return out;
}

/**
 * The record statuses whose images are pages: `in_review` and `approved`,
 * and `captured`, which a delivery holds only when a staging test
 * registered it with its captured records as pages. A `rejected`
 * record's image is never a page, though it may share a page's key and
 * master.
 */
export const PAGE_IMAGE_STATUSES_SQL = "('in_review','approved','captured')";

/** What `readPageRotateDegs` read. */
export interface PageRotateDegs {
  /** Per volume, the `rotate_deg` of each page whose image carries one, by page key. */
  degrees: Map<string, Map<string, number>>;
  /** Pages for which more than one image of the delivery's pages matches. */
  ambiguous: Array<{ volumeId: string; pageKey: string }>;
}

/**
 * Each volume's `rotate_deg` by page key, for the pages whose image
 * carries one: the volume's `registered` delivery, the image of one of
 * its page records (`PAGE_IMAGE_STATUSES_SQL`) with the page's key, and
 * that image the page's master (its preview where it has one, otherwise
 * its capture). Images are counted per page, so a page that two such
 * images match is reported in `ambiguous` rather than given either
 * one's rotation. A volume with no delivery, or no rotation, gets an
 * empty map. The value is the delivery's, and a delivery's images never
 * change: a new delivery replaces the page list and raises
 * `pages_revision`, which the claim checks.
 */
export async function readPageRotateDegs(
  db: DrizzleD1Database<any>,
  tenantId: string,
  volumeIds: string[],
): Promise<PageRotateDegs> {
  const degrees = new Map<string, Map<string, number>>(volumeIds.map((id) => [id, new Map()]));
  const ambiguous: PageRotateDegs["ambiguous"] = [];
  for (const chunk of chunked(volumeIds, READ_ID_CHUNK)) {
    const images = sql<number>`COUNT(*)`;
    const turned = sql<number>`COUNT(${captureImages.rotateDeg})`;
    const rows = await db
      .select({
        volumeId: pipelineVolumePages.pipelineVolumeId,
        pageKey: pipelineVolumePages.pageKey,
        images,
        turned,
        rotateDeg: sql<number | null>`MAX(${captureImages.rotateDeg})`,
      })
      .from(captureDeliveries)
      .innerJoin(
        captureImages,
        and(
          eq(captureImages.tenantId, captureDeliveries.tenantId),
          eq(captureImages.deliveryId, captureDeliveries.id),
        ),
      )
      .innerJoin(
        pipelineVolumePages,
        and(
          eq(pipelineVolumePages.tenantId, captureDeliveries.tenantId),
          sql`${pipelineVolumePages.pipelineVolumeId} = ${captureDeliveries.pipelineVolumeId}`,
          eq(pipelineVolumePages.pageKey, captureImages.pageKey),
          sql`${pipelineVolumePages.masterKey} = COALESCE(${captureImages.previewKey}, ${captureImages.captureKey})`,
        ),
      )
      .where(
        and(
          eq(captureDeliveries.tenantId, tenantId),
          inArray(captureDeliveries.pipelineVolumeId, chunk),
          sql`${captureDeliveries.state} = 'registered'`,
          sql`${captureImages.recordStatus} IN ${sql.raw(PAGE_IMAGE_STATUSES_SQL)}`,
        ),
      )
      .groupBy(pipelineVolumePages.pipelineVolumeId, pipelineVolumePages.pageKey)
      .having(sql`${images} > 1 OR ${turned} > 0`)
      .all();
    for (const row of rows) {
      if (Number(row.images) > 1) ambiguous.push({ volumeId: row.volumeId, pageKey: row.pageKey });
      else if (row.rotateDeg !== null) degrees.get(row.volumeId)?.set(row.pageKey, Number(row.rotateDeg));
    }
  }
  return { degrees, ambiguous };
}

/** What `readPageRotations` read of the volumes' capture QC. */
export interface PageRotations {
  /** Per volume, the clockwise quarter-turns of each rotated page, by page key. */
  rotations: Map<string, Map<string, number>>;
  /** Per volume with a decision set on its registered delivery, the set's revision. */
  qcRevisions: Map<string, number>;
}

/**
 * Each volume's capture QC rotations, by page key, and its decision
 * set's revision, 90 volumes to a batch so the two agree. A rotation
 * reaches a page through the volume's `registered` delivery, the
 * delivery's image with the page's key, and the rotation recorded for
 * that image's record, capture id and role; the two images of a spread
 * share a capture id and are told apart by role. A carried approval's
 * rotations were copied to the new delivery when it was registered, so
 * they are read the same way. A volume with no delivery, or no rotation,
 * gets an empty map.
 */
export async function readPageRotations(
  db: DrizzleD1Database<any>,
  tenantId: string,
  volumeIds: string[],
): Promise<PageRotations> {
  const rotations = new Map<string, Map<string, number>>(volumeIds.map((id) => [id, new Map()]));
  const qcRevisions = new Map<string, number>();
  const registered = sql`${captureDeliveries.state} = 'registered'`;
  for (const chunk of chunked(volumeIds, READ_ID_CHUNK)) {
    const [turns, sets] = await db.batch([
      db
        .select({
          volumeId: captureDeliveries.pipelineVolumeId,
          pageKey: captureImages.pageKey,
          quarterTurns: captureQcRotations.quarterTurns,
        })
        .from(captureDeliveries)
        .innerJoin(
          captureImages,
          and(
            eq(captureImages.tenantId, captureDeliveries.tenantId),
            eq(captureImages.deliveryId, captureDeliveries.id),
          ),
        )
        .innerJoin(
          captureQcRotations,
          and(
            eq(captureQcRotations.tenantId, captureImages.tenantId),
            eq(captureQcRotations.deliveryId, captureImages.deliveryId),
            eq(captureQcRotations.captuaRecordId, captureImages.captuaRecordId),
            eq(captureQcRotations.captureId, captureImages.captureId),
            eq(captureQcRotations.role, captureImages.role),
          ),
        )
        .where(
          and(
            eq(captureDeliveries.tenantId, tenantId),
            inArray(captureDeliveries.pipelineVolumeId, chunk),
            registered,
          ),
        ),
      db
        .select({ volumeId: captureDeliveries.pipelineVolumeId, revision: captureQcSets.revision })
        .from(captureDeliveries)
        .innerJoin(
          captureQcSets,
          and(
            eq(captureQcSets.tenantId, captureDeliveries.tenantId),
            eq(captureQcSets.deliveryId, captureDeliveries.id),
          ),
        )
        .where(
          and(
            eq(captureDeliveries.tenantId, tenantId),
            inArray(captureDeliveries.pipelineVolumeId, chunk),
            registered,
          ),
        ),
    ]);
    for (const row of turns) {
      if (row.volumeId !== null) rotations.get(row.volumeId)?.set(row.pageKey, row.quarterTurns);
    }
    for (const row of sets) {
      if (row.volumeId !== null) qcRevisions.set(row.volumeId, row.revision);
    }
  }
  return { rotations, qcRevisions };
}

/**
 * Per volume, the prefix of every review run of its deliveries whose
 * purge is not yet recorded (`purge_status` null), earlier deliveries
 * included, oldest first and each once. A volume with none is absent.
 *
 * The runner deletes what these prefixes name, so a row is used only
 * when its delivery is one of the tenant's deliveries of that same
 * volume and its prefix is exactly `{tenant slug}/{delivery id}/`, built
 * here from D1 and compared byte for byte. Any other row is left out
 * and logged by its ids, never its prefix.
 */
export async function readReviewPurges(
  db: DrizzleD1Database<any>,
  tenant: { id: string; slug: string },
  volumeIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const chunk of chunked(volumeIds, READ_ID_CHUNK)) {
    const rows = await db
      .select({
        runId: captureReviewRuns.runId,
        volumeId: captureReviewRuns.pipelineVolumeId,
        deliveryId: captureReviewRuns.deliveryId,
        prefix: captureReviewRuns.reviewPrefix,
        deliveryVolumeId: captureDeliveries.pipelineVolumeId,
      })
      .from(captureReviewRuns)
      .leftJoin(
        captureDeliveries,
        and(
          eq(captureDeliveries.tenantId, captureReviewRuns.tenantId),
          eq(captureDeliveries.id, captureReviewRuns.deliveryId),
        ),
      )
      .where(
        and(
          eq(captureReviewRuns.tenantId, tenant.id),
          inArray(captureReviewRuns.pipelineVolumeId, chunk),
          isNull(captureReviewRuns.purgeStatus),
        ),
      )
      .orderBy(asc(captureReviewRuns.createdAt), asc(captureReviewRuns.reviewPrefix))
      .all();
    for (const row of rows) {
      if (row.deliveryVolumeId !== row.volumeId || row.prefix !== `${tenant.slug}/${row.deliveryId}/`) {
        console.warn(
          `pipeline dispatch: review row left out of review_purge (tenant ${tenant.id}, run ${row.runId}, volume ${row.volumeId}, delivery ${row.deliveryId})`,
        );
        continue;
      }
      const list = out.get(row.volumeId) ?? [];
      if (!list.includes(row.prefix)) list.push(row.prefix);
      out.set(row.volumeId, list);
    }
  }
  return out;
}

async function readDescriptions(
  db: DrizzleD1Database<any>,
  tenantId: string,
  ids: string[],
): Promise<Map<string, DescriptionRow>> {
  const out = new Map<string, DescriptionRow>();
  for (const chunk of chunked(ids, READ_ID_CHUNK)) {
    const rows = await db
      .select()
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, tenantId), inArray(descriptions.id, chunk)))
      .all();
    for (const row of rows) out.set(row.id, row);
  }
  return out;
}

async function readRepositories(
  db: DrizzleD1Database<any>,
  tenantId: string,
  ids: string[],
): Promise<Map<string, RepositoryRow>> {
  const out = new Map<string, RepositoryRow>();
  for (const chunk of chunked(ids, READ_ID_CHUNK)) {
    const rows = await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.tenantId, tenantId), inArray(repositories.id, chunk)))
      .all();
    for (const row of rows) out.set(row.id, row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// startPipelineRun
// ---------------------------------------------------------------------------

// Where each store the strict rules check comes from: the federation's
// destination columns, or the deployment's working-space settings.
const STRICT_DESTINATION_PATHS: Record<string, string> = {
  "destination.endpoint": "pipeline_delivery_endpoint",
  "destination.tiles_bucket": "pipeline_tiles_bucket",
  "destination.ocr_bucket": "pipeline_tiles_bucket",
  "review.endpoint": "pipeline_delivery_endpoint",
  "review.bucket": "pipeline_review_tiles_bucket",
};
const STRICT_SETTING_PATHS: Record<string, string> = {
  "working.endpoint": "PIPELINE_WORKING_S3_ENDPOINT",
  "working.bucket": "PIPELINE_WORKING_BUCKET",
};

/**
 * The refusal for a spec the strict bucket and endpoint rules refused,
 * or null when any of its problems is something else. A working store
 * is the deployment's settings (`dispatch_unconfigured`); the tiles,
 * OCR and review stores are the federation's destination columns
 * (`tenant_destination_unset`). A review bucket that is also another
 * bucket of the run is the review bucket's column. A volume's source is
 * its masters columns (`volume_source_invalid`), named with the ids of
 * the volumes, which `volumeIds` gives in spec order. Each names the
 * invalid settings or columns, never a value. When problems of several
 * kinds are found, the settings are named first, then the destination,
 * then the volumes, the order the start checks them in. The validator
 * stops at a schema problem before it compares buckets, so the caller
 * says whether the review bucket is another bucket of the run
 * (`reviewCollides`); a collision is the destination's, and is named
 * before any volume's source.
 */
function strictStoreRefusal(
  err: unknown,
  volumeIds: string[],
  reviewCollides: boolean,
): StartRunRefusal | null {
  if (!(err instanceof RunSpecError) || err.problems.length === 0) return null;
  const settings = new Set<string>();
  const columns = new Set<string>(reviewCollides ? ["pipeline_review_tiles_bucket"] : []);
  const sourceVolumes = new Set<string>();
  const sourceColumns = new Set<string>();
  for (const p of err.problems) {
    const source = /^volumes\.(\d+)\.source\.(endpoint|bucket)$/.exec(p.path);
    if (p.rule === "review_bucket_distinct") columns.add("pipeline_review_tiles_bucket");
    else if (p.path in STRICT_SETTING_PATHS) settings.add(STRICT_SETTING_PATHS[p.path]);
    else if (p.path in STRICT_DESTINATION_PATHS) columns.add(STRICT_DESTINATION_PATHS[p.path]);
    else if (source && volumeIds[Number(source[1])] !== undefined) {
      sourceVolumes.add(volumeIds[Number(source[1])]);
      sourceColumns.add(source[2] === "endpoint" ? "masters_endpoint" : "masters_bucket");
    } else return null;
  }
  if (settings.size > 0) return new StartRunRefusal("dispatch_unconfigured", { invalid: [...settings] });
  if (columns.size > 0) return new StartRunRefusal("tenant_destination_unset", { invalid: [...columns] });
  return new StartRunRefusal("volume_source_invalid", {
    volume_ids: [...sourceVolumes],
    invalid: [...sourceColumns].sort(),
  });
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/** Whether `version` (`vX.Y.Z`) is at least `from`; any other form is not. */
function scriptVersionAtLeast(version: string, from: readonly [number, number, number]): boolean {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) return false;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== from[i]) return parts[i] > from[i];
  }
  return true;
}

export async function startPipelineRun(
  deps: StartRunDeps,
  input: StartRunInput,
): Promise<{ runId: string; chunkCount: number }> {
  const { db, env } = deps;
  const { tenant, kind } = input;
  const tenantId = tenant.id;
  const now = deps.now();

  // 1. Gate.
  await requireMediaPipelineAccess(db, tenant, input.user);

  // 2. Expire the tenant's runs whose token has run out.
  await expireRun(db, { tenantId }, now);

  // 3. Configuration and size.
  const config = deps.config;
  if (config === null) throw new StartRunRefusal("pipeline_config_unset");
  const { environment, runnerImage } = await readDispatchSettings(env);
  let destination: TenantDestination;
  try {
    destination = await resolveTenantDestination(db, tenant, env);
  } catch (err) {
    if (!(err instanceof TenantDestinationError)) throw err;
    throw new StartRunRefusal("tenant_destination_unset", { missing: err.missing });
  }
  const manifestResolver = deps.manifestResolverFor(destination.manifestBaseUrl);
  if (
    !(PIPELINE_RUN_KINDS as readonly string[]).includes(kind) ||
    !(PIPELINE_RUN_PURPOSES as readonly string[]).includes(input.purpose) ||
    !(input.maxReviewFrac >= 0 && input.maxReviewFrac <= 1)
  ) {
    throw new StartRunRefusal("invalid_request");
  }
  const ids = unique(input.pipelineVolumeIds);
  if (ids.length === 0) throw new StartRunRefusal("invalid_request", { detail: "no_volumes" });
  if (ids.length > config.maxRunVolumes) {
    throw new StartRunRefusal("run_too_large", { limit: "volumes", max: config.maxRunVolumes });
  }
  const scriptVersion = env.PIPELINE_SCRIPT_VERSION as string;

  // 4. Volumes, and the capture QC hold.
  const volumes = checkVolumes(ids, await readVolumes(db, tenantId, ids, now), kind);
  const qcPending = await readCaptureQcPending(db, tenantId, ids);
  if (qcPending.length > 0) {
    throw new StartRunRefusal("capture_qc_pending", { volume_ids: qcPending });
  }

  // 5. Declarations and gate.
  const declarations = await readLatestDeclarations(
    db,
    tenantId,
    unique(volumes.map((v) => v.recipeScopeDescriptionId)),
  );
  const undeclared = volumes.filter((v) => !declarations.has(v.recipeScopeDescriptionId));
  if (undeclared.length > 0) {
    throw new StartRunRefusal("no_declaration", { volume_ids: undeclared.map((v) => v.id) });
  }
  const declarationOf = (v: VolumeRow) => declarations.get(v.recipeScopeDescriptionId) as DeclarationRow;
  if (input.purpose === "wave") {
    const declarationIds = unique(volumes.map((v) => declarationOf(v).id));
    const passed = await readGatePassed(db, tenantId, declarationIds, scriptVersion);
    const notPassed = declarationIds.filter((id) => !passed.has(id));
    if (notPassed.length > 0) {
      throw new StartRunRefusal("gate_not_passed", { declaration_ids: notPassed });
    }
  } else if (volumes.length > config.maxSampleVolumes) {
    throw new StartRunRefusal("run_too_large", {
      limit: "sample_volumes",
      max: config.maxSampleVolumes,
    });
  }

  // 6. Pages, rotations and review prefixes, recipes, manifests, jobs.
  const pages = await readPages(db, tenantId, ids);
  const { degrees: rotateDegs, ambiguous } = await readPageRotateDegs(db, tenantId, ids);
  if (ambiguous.length > 0) {
    const first = ambiguous[0];
    throw new StartRunRefusal("invalid_page_list", {
      volume_id: first.volumeId,
      reference_code: volumes.find((v) => v.id === first.volumeId)?.referenceCode,
      rules: ["page_image_ambiguous"],
      page_keys: ambiguous.filter((a) => a.volumeId === first.volumeId).map((a) => a.pageKey),
    });
  }
  const turned = ids.filter((id) => (rotateDegs.get(id)?.size ?? 0) > 0);
  if (turned.length > 0 && !scriptVersionAtLeast(scriptVersion, ROTATE_DEG_FROM)) {
    throw new StartRunRefusal("rotate_deg_unsupported", {
      volume_ids: turned,
      runner_from: `v${ROTATE_DEG_FROM.join(".")}`,
    });
  }
  const rotatesAndPurges = scriptVersionAtLeast(scriptVersion, ROTATE_AND_PURGE_FROM);
  const qc = rotatesAndPurges ? await readPageRotations(db, tenantId, ids) : null;
  const review =
    rotatesAndPurges && destination.reviewTilesBucket !== null
      ? { endpoint: destination.deliveryEndpoint, bucket: destination.reviewTilesBucket }
      : undefined;
  const purges = review !== undefined ? await readReviewPurges(db, tenant, ids) : null;
  let pageTotal = 0;
  for (const rows of pages.values()) pageTotal += rows.length;
  if (pageTotal > config.maxRunPages) {
    throw new StartRunRefusal("run_too_large", { limit: "pages", max: config.maxRunPages });
  }
  volumes.forEach((v, i) => {
    let problems: { rule: string; path: string }[];
    try {
      problems = checkVolumePages(kind, {
        expected_count: v.expectedCount,
        pages: specPages(pages.get(v.id) ?? []),
        source: specSource(kind, v, i),
      });
    } catch (err) {
      if (!(err instanceof RunSpecError)) throw err;
      problems = err.problems;
    }
    if (problems.length > 0) {
      throw new StartRunRefusal("invalid_page_list", {
        volume_id: v.id,
        reference_code: v.referenceCode,
        rules: problems.map((p) => p.rule),
      });
    }
  });

  const recipes = new Map<string, RunSpecRecipe>();
  for (const v of volumes) {
    try {
      recipes.set(v.id, resolveRecipe(kind, declarationOf(v), config.presets, []));
    } catch (err) {
      if (!(err instanceof RecipeError)) throw err;
      throw new StartRunRefusal("recipe_invalid", { volume_id: v.id, rule: err.code });
    }
  }

  const descriptionRows = await readDescriptions(
    db,
    tenantId,
    unique(volumes.map((v) => v.descriptionId)),
  );
  // Each volume's spec entry and manifest block are built from its
  // description in this tenant. A volume whose description is not found
  // there is refused rather than sent without one.
  const undescribed = volumes.filter((v) => !descriptionRows.has(v.descriptionId));
  if (undescribed.length > 0) {
    throw new StartRunRefusal("description_not_found", {
      reference_codes: undescribed.map((v) => v.referenceCode),
    });
  }
  const repositoryRows = await readRepositories(
    db,
    tenantId,
    unique([...descriptionRows.values()].map((d) => d.repositoryId)),
  );
  const manifestOf = new Map<string, ReturnType<ManifestResolver>>();
  for (const v of volumes) {
    const description = descriptionRows.get(v.descriptionId) ?? null;
    const repository = description ? (repositoryRows.get(description.repositoryId) ?? null) : null;
    try {
      manifestOf.set(v.id, manifestResolver(v, description, repository, input.tenant));
    } catch (err) {
      if (!(err instanceof ManifestInputsError)) throw err;
      throw new StartRunRefusal(err.code, { volume_id: v.id, ...err.detail });
    }
  }

  const jobs = groupJobs(
    volumes.map((v) => ({ id: v.id, referenceCode: v.referenceCode, expectedCount: v.expectedCount })),
    config.targetImagesPerJob,
  );
  const chunkCount = Math.ceil(jobs.length / JOBS_PER_CHUNK);
  const placement = new Map<string, { jobIndex: number; chunkIndex: number }>();
  for (const job of jobs) {
    for (const id of job.volume_ids) {
      placement.set(id, {
        jobIndex: job.job_index,
        chunkIndex: Math.floor(job.job_index / JOBS_PER_CHUNK),
      });
    }
  }
  const countOf = new Map(volumes.map((v) => [v.id, v.expectedCount]));

  // 7. Lifetimes.
  const lifetimes = runLifetimes(
    now,
    {
      totalImages: volumes.reduce((a, v) => a + v.expectedCount, 0),
      jobImageCounts: jobs.map((j) => j.volume_ids.reduce((a, id) => a + (countOf.get(id) ?? 0), 0)),
      chunkCount,
    },
    config.lifetime,
  );
  if (Math.ceil((lifetimes.specUrlExpiresAt - now) / 1000) > PRESIGN_MAX_SECONDS) {
    throw new StartRunRefusal("run_too_long", { max_seconds: PRESIGN_MAX_SECONDS });
  }

  // 8. Restriction, from each volume's own flag.
  const restricted = volumes.filter((v) => isRestricted(v));
  if (restricted.length > 0) {
    throw new StartRunRefusal("restricted_material", {
      reference_codes: restricted.map((v) => v.referenceCode),
    });
  }

  // 9. Token and spec. Any other failure here is a defect: step 6
  // checked each volume.
  const runId = deps.newId();
  const minted = await mintRunToken();
  // A store the strict bucket and endpoint rules refuse, which only a
  // spec with review fields is held to, is refused naming the setting
  // or destination column it came from.
  let spec: RunSpec;
  try {
    spec = buildRunSpec({
      runId,
      tenantId,
      environment,
      kind,
      createdAt: now,
      runner: { image: runnerImage, scriptVersion },
      callback: {
        origin: env.PIPELINE_CALLBACK_ORIGIN as string,
        token: minted.token,
        tokenExpiresAt: lifetimes.tokenExpiresAt,
      },
      maxReviewFrac: input.maxReviewFrac,
      destination: {
        endpoint: destination.deliveryEndpoint,
        tilesBucket: destination.tilesBucket,
        tilesPrefix: destination.tilesPrefix,
        imageBaseUrl: destination.imageBaseUrl,
        ocrPrefix: destination.ocrPrefix,
      },
      working: {
        endpoint: env.PIPELINE_WORKING_S3_ENDPOINT as string,
        bucket: env.PIPELINE_WORKING_BUCKET as string,
      },
      review,
      jobs,
      volumes: volumes.map((v) => ({
        // Step 8 found no restriction; the claim records that.
        volume: { ...v, restricted: false },
        pages: pages.get(v.id) ?? [],
        recipe: recipes.get(v.id) as RunSpecRecipe,
        description: descriptionRows.get(v.descriptionId) ?? null,
        repository: null,
        rotations: qc?.rotations.get(v.id),
        rotateDegs: rotateDegs.get(v.id),
        reviewPurge: purges?.get(v.id),
      })),
      tenant: input.tenant,
      manifestResolver: (v) => manifestOf.get(v.id) as ReturnType<ManifestResolver>,
    });
  } catch (err) {
    // The review bucket against every other bucket of the run, without
    // regard to case, as the validator's `review_bucket_distinct` rule.
    const reviewBucket = review?.bucket.toLowerCase();
    const reviewCollides =
      reviewBucket !== undefined &&
      [destination.tilesBucket, env.PIPELINE_WORKING_BUCKET as string, ...volumes.map((v) => v.mastersBucket)].some(
        (bucket) => bucket.toLowerCase() === reviewBucket,
      );
    throw strictStoreRefusal(err, volumes.map((v) => v.id), reviewCollides) ?? err;
  }
  const specJson = JSON.stringify(spec);
  const specSha256 = await sha256Hex(specJson);

  // 10. Claim.
  const chunkIds = Array.from({ length: chunkCount }, () => deps.newId());
  await runBatch(
    db,
    buildClaimStatements(db, {
      run: {
        id: runId,
        tenantId,
        federationId: tenant.federationId ?? null,
        userId: input.user.id,
        kind,
        purpose: input.purpose,
        regeneratesRunId: null,
        status: "pending",
        runnerImage,
        scriptVersion,
        arch: "x64",
        maxReviewFrac: input.maxReviewFrac,
        specKey: pipelineKey.spec(tenantId, runId),
        specSha256,
        specUrlExpiresAt: lifetimes.specUrlExpiresAt,
        chunkCount,
        volumeCount: volumes.length,
        volumesReported: 0,
        callbackTokenHash: minted.hash,
        tokenExpiresAt: lifetimes.tokenExpiresAt,
        createdAt: now,
      },
      chunkIds,
      volumeIds: ids,
      pagesRevisions: new Map(volumes.map((v) => [v.id, v.pagesRevision])),
      qcRevisions: qc?.qcRevisions,
      kind,
      now,
    }),
  );

  // 11. A lost claim is refused.
  const claimed = await db
    .select({ tokenRevokedAt: pipelineRuns.tokenRevokedAt })
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.tenantId, tenantId)))
    .get();
  if (!claimed || claimed.tokenRevokedAt !== null) {
    const refreshed = await readVolumes(db, tenantId, ids, deps.now());
    checkVolumes(ids, refreshed, kind);
    // A volume whose page list was replaced since step 4 is why the claim
    // was lost: the spec was built from pages it no longer has. Starting
    // the run again reads the current pages.
    const readRevision = new Map(volumes.map((v) => [v.id, v.pagesRevision]));
    const replaced = refreshed.filter((v) => v.pagesRevision !== readRevision.get(v.id));
    if (replaced.length > 0) {
      throw new StartRunRefusal("volume_pages_changed", { volume_ids: replaced.map((v) => v.id) });
    }
    // A decision recorded since step 4 left an opening unapproved.
    const nowPending = await readCaptureQcPending(db, tenantId, ids);
    if (nowPending.length > 0) {
      throw new StartRunRefusal("capture_qc_pending", { volume_ids: nowPending });
    }
    // A decision set written since its rotations were read is why the
    // claim was lost: the spec may carry rotations the set no longer
    // records. Starting the run again reads them afresh.
    if (qc !== null) {
      const nowRevisions = (await readPageRotations(db, tenantId, ids)).qcRevisions;
      const rewritten = ids.filter((id) => nowRevisions.get(id) !== qc.qcRevisions.get(id));
      if (rewritten.length > 0) {
        throw new StartRunRefusal("volume_pages_changed", { volume_ids: rewritten });
      }
    }
    // A volume flagged restricted since step 8 is why the claim was lost;
    // a missing row counts as restricted, as in step 8.
    const byId = new Map(refreshed.map((v) => [v.id, v]));
    const nowRestricted = ids.filter((id) => isRestricted(byId.get(id)));
    if (nowRestricted.length > 0) {
      throw new StartRunRefusal("restricted_material", {
        reference_codes: nowRestricted.map((id) => byId.get(id)?.referenceCode ?? id),
      });
    }
    throw new StartRunRefusal("volume_in_open_run", { volume_ids: ids });
  }

  const abandon = async (stage: string) => {
    await runBatch(db, buildAbandonStatements(db, { runId, tenantId, stage, now: deps.now() }));
  };

  // 12. Publish the spec.
  let specUrl: string;
  try {
    const published = await publishRunSpec(
      deps.specStore,
      tenantId,
      runId,
      specJson,
      lifetimes.specUrlExpiresAt,
      now,
    );
    if (published.sha256 !== specSha256) {
      throw new Error("The stored spec's SHA-256 does not match the spec built");
    }
    specUrl = published.url;
  } catch (err) {
    await abandon("spec_store");
    throw err;
  }

  // 13. Run-volume rows.
  const rows = volumes.map((v) => {
    const place = placement.get(v.id) as { jobIndex: number; chunkIndex: number };
    return {
      id: deps.newId(),
      runId,
      pipelineVolumeId: v.id,
      declarationId: declarationOf(v).id,
      jobIndex: place.jobIndex,
      chunkIndex: place.chunkIndex,
      referenceCode: v.referenceCode,
      tileRoot: v.referenceCode,
      expectedCount: v.expectedCount,
      resolvedRecipe: JSON.stringify(recipes.get(v.id)),
      status: "dispatched" as const,
      flagsTruncated: false,
      createdAt: now,
    };
  });
  const inserts = chunked(rows, RUN_VOLUME_ROWS_PER_STATEMENT).map((group) =>
    runVolumeInsert(db, tenantId, group),
  );
  try {
    for (const batch of chunked(inserts, BATCH_LIMIT)) await runBatch(db, batch);
  } catch (err) {
    await abandon("ledger");
    throw err;
  }

  // 14 and 15. Dispatch each chunk in turn.
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
    const result = await postChunkDispatch(env, deps.fetchImpl, deps.now(), {
      runId,
      specUrl,
      chunkIndex,
      chunkCount,
    });
    if (result.sent && result.httpStatus === 204) {
      await runBatch(
        db,
        buildDispatchedStatements(db, { runId, tenantId, chunkIndex, now: deps.now() }),
      );
      continue;
    }
    await runBatch(
      db,
      buildDispatchFailureStatements(db, {
        runId,
        tenantId,
        chunkIndex,
        httpStatus: result.httpStatus,
        ...(result.sent ? {} : { appTokenStep: result.appTokenStep }),
        failClaim: deps.newId(),
        now: deps.now(),
      }),
    );
    break;
  }

  // 16.
  return { runId, chunkCount };
}

// ---------------------------------------------------------------------------
// The start-run route's body
// ---------------------------------------------------------------------------

export const startRunBodySchema = z
  .object({
    pipelineVolumeIds: z.array(z.string().min(1)).min(1),
    kind: z.enum(PIPELINE_RUN_KINDS),
    purpose: z.enum(PIPELINE_RUN_PURPOSES),
    maxReviewFrac: z.number().min(0).max(1),
  })
  .strict();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Validates a start-run request, starts the run and answers. The gate's
 * bare 404 and 403 are thrown on unchanged; other refusals answer with
 * their code.
 */
export async function startRunAction(
  deps: StartRunDeps,
  request: Request,
  tenant: Tenant,
  user: User,
): Promise<Response> {
  // The gate runs first, so a tenant without the capability learns
  // nothing about the request's shape.
  await requireMediaPipelineAccess(deps.db, tenant, user);
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid_request", detail: "malformed_json" });
  }
  const body = startRunBodySchema.safeParse(parsed);
  if (!body.success) {
    return jsonResponse(400, {
      error: "invalid_request",
      detail: [...new Set(body.error.issues.map((i) => i.path.join(".") || "(body)"))].join(", "),
    });
  }
  try {
    const result = await startPipelineRun(deps, { tenant, user, ...body.data });
    return jsonResponse(200, result);
  } catch (err) {
    if (err instanceof StartRunRefusal) {
      return jsonResponse(err.status, { error: err.code, ...err.detail });
    }
    throw err;
  }
}

// @version v0.8.0
