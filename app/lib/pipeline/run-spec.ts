/**
 * Media Pipeline — Run Spec Validator
 *
 * This module deals with the run spec, the one document Fisqua publishes
 * for each pipeline run and the runner reads before it pulls anything:
 * which volumes to process, with which resolved recipe, where to write
 * and where to report.
 *
 * The contract itself is the JSON Schema committed beside this file,
 * `run-spec.schema.json`. The runner keeps a byte-identical copy and
 * validates every spec it fetches against it, and both sides pin the
 * file's SHA-256 so drift fails a test. `runSpecSchema` here is a Zod
 * mirror of that schema, constraint for constraint: closed objects
 * become `.strict()`, the image must be pinned by digest, the tile root
 * and page keys follow their patterns, a page is either a master file or
 * a PDF page and never both, a master page may carry the master's
 * SHA-256 (64 lowercase hex characters) for the runner to check when it
 * pulls the file, the clockwise degrees (0, 90, 180 or 270) that make
 * the master upright from its stored pixels with EXIF ignored
 * (`rotate_deg`), and the clockwise quarter-turns (1, 2 or 3) the runner
 * applies after that rotation, or after the master's EXIF orientation
 * where there is none (`quarter_turns`); a PDF page takes none of the
 * three, and a review run's page takes `rotate_deg` but no
 * `quarter_turns`. The working space is always B2. The
 * runtime validator is Zod rather than a JSON Schema engine because the
 * usual engines compile validators with `new Function`, which the
 * Workers runtime forbids. The schema's two conditionals are each a
 * `superRefine`. Tesseract OCR requires bilevel output: that one applies
 * when the OCR stage runs with engine `tesseract` or with no engine
 * named, as the schema's `if` does. On a volume run, an OCR stage that
 * runs must name a non-empty `params.lang`; an item PDF reads its text
 * layer and names no language.
 *
 * Some rules span several fields and the schema cannot state them.
 * `checkVolumePages` checks one volume's page list: the count equals
 * `expected_count`, `seq` runs 1..n in list order, page keys are unique,
 * a volume run lists master files under its source prefix and an item
 * PDF lists PDF pages from a single source object, and every per-page
 * override names a listed page. Each rule reports at most once per
 * volume, at its first offending element, so a caller can name the rule
 * in a refusal. The dispatcher runs it on each volume before it writes
 * anything. `checkRunSpecInvariants` runs it for every volume and adds
 * the job rules: volume ids and job indices are unique, every job names
 * known volumes, and every volume sits in exactly one job.
 *
 * `validateRunSpec` runs the Zod schema and then the invariants, and
 * throws a `RunSpecError` listing every offending path and rule. The
 * runner makes the same cross-field checks on read, so a spec that
 * passes here is one the runner accepts.
 *
 * `buildRunSpec` writes a spec from rows already read from D1, and
 * makes no query of its own. It derives nothing that has a recorded
 * source: each volume's tile root is its reference code copied
 * verbatim, page keys, master keys and master digests come from the
 * volume's page rows in `seq` order, and the source block from the
 * volume's masters columns. A reference code outside the tile-root
 * pattern is refused naming the volume rather than rewritten to fit,
 * and so is a volume flagged restricted; every entry it writes says
 * `restricted: false`, for the runner's own check. The callback URLs
 * sit on the configured callback origin; the destination's credentials
 * name is derived from the tenant and the deployment's environment
 * (`runnerKeyStoreName`:
 * `fisqua-pipeline-{tenantId}` in production,
 * `fisqua-pipeline-staging-{tenantId}` on staging), the only names the
 * runner accepts; tiles, OCR and image ids take the prefixes and image
 * address the caller passes (the tenant's, under its slug in its
 * federation's tiles bucket), with OCR in the tiles bucket; the working
 * space is B2 under the run's tenant-first prefix. It runs
 * `checkVolumePages` on each volume, so a page-list problem names its
 * volume, and ends with `validateRunSpec`, so every spec Fisqua writes
 * has passed the same checks the runner makes. It returns the object it
 * built, so the recipe the ledger stores and the recipe the spec
 * carries serialise to the same bytes.
 *
 * Three inputs are for runner v1.1.0 and later, and one for v1.2.0 and
 * later. A caller that passes none of them gets a spec with no
 * `rotate_deg`, `quarter_turns`, `review` or `review_purge`, which
 * runner v1.0.0 accepts. A volume's `rotateDegs` maps page keys to the
 * `rotate_deg` its capture images carry; `specPages` writes it on a
 * master page that has one, 0 included, and nothing on a page without
 * one, which the runner reads by its EXIF orientation. A volume's `rotations`
 * maps page keys to the quarter-turns capture QC recorded; `specPages`
 * writes `quarter_turns` on a master page only when its turn is 1, 2 or
 * 3, and nothing on an unrotated page. A volume's `reviewPurge` lists
 * the review prefixes the runner deletes once the volume's tiles are
 * verified, written as `review_purge` only when it names one. The run's `review` names the
 * review bucket those prefixes are in, written as the top-level `review`
 * block, on B2. With either review field the spec is held to the strict
 * bucket and endpoint rules above.
 *
 * The schema also describes two kinds Fisqua starts outside the run
 * form. A review run (`review_run`) tiles a capture delivery's images as
 * captured into the review bucket the top-level `review` block names,
 * under each volume entry's `review_prefix` (`{tenant}/{delivery}/`);
 * its pages carry digests and its entries no recipe or manifest. A
 * purge run (`review_purge`) deletes the prefixes its entries name;
 * Fisqua does not start one, and the kind is mirrored so the two
 * validators agree. A processing entry may name `review_purge`, the
 * prefixes the runner deletes once the volume's tiles are verified. A
 * spec with any of these review fields must also name every bucket as a
 * bare bucket name and every endpoint as its backend's S3 host, the
 * schema's `strict_destination` and `bucket_by_backend` rules; a spec
 * without them is checked as before. `runSpecSchema` is a union on
 * `kind` of the three shapes (`processingRunSpecSchema`,
 * `reviewRunSpecSchema`, `purgeRunSpecSchema`), with those rules in its
 * refinement. The cross-field checks add that a review run's pages
 * follow a volume run's page rules, that no review prefix is named
 * twice, that only a volume run names prefixes to purge, and that the
 * review bucket is no other bucket of the run. `validateAnyRunSpec`
 * accepts any kind; `validateRunSpec` accepts a processing spec only,
 * the kind dispatch builds and publishing reads.
 *
 * Each volume's manifest block comes from an injected
 * `ManifestResolver`, given the volume, its description, the
 * description's repository and the tenant. Dispatch uses the one in
 * `manifest-inputs.ts`. A resolver that cannot build a block throws a
 * `ManifestInputsError`, whose code names why: no inputs to build from
 * (`manifest_inputs_unavailable`), a repository without rights
 * (`repository_rights_unset`), or a repository with an attribution in
 * one language only (`repository_attribution_incomplete`).
 *
 * @version v0.8.0
 */

import { z } from "zod";
import type {
  descriptions,
  pipelineVolumePages,
  pipelineVolumes,
  repositories,
  tenants,
} from "../../db/schema";
import { pipelineKey } from "./store.server";
import { runnerKeyStoreName, type PipelineEnvironment } from "./key-store";
import {
  PIPELINE_BACKGROUNDS,
  PIPELINE_OUTPUT_CLASSES,
  PIPELINE_PAGE_KEY_PATTERN,
  PIPELINE_PLATENS,
  PIPELINE_RUN_KINDS,
  PIPELINE_STAGES,
  type PipelineRunKind,
} from "../validation/enums";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const RUNNER_IMAGE_PATTERN = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
/** A tile root, and so a reference code a run can carry. */
export const TILE_ROOT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const URL_TEMPLATE_PATTERN = /^https:\/\/.*\{volume_id\}/;
const HTTPS_PATTERN = /^https:\/\//;
/** A page master's digest: SHA-256, lowercase hex, as migration 0092 stores it. */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const jsonObject = z.record(z.string(), z.unknown());
const integer = z.number().int();
const dateTime = z.iso.datetime({ offset: true });
const backend = z.enum(["b2", "r2"]);
const pageKey = z.string().regex(PIPELINE_PAGE_KEY_PATTERN);

const stageOn = z.object({ run: z.literal(true), params: jsonObject }).strict();
const stageOff = z.object({ run: z.literal(false), reason: z.string().min(1) }).strict();
const stage = z.union([stageOn, stageOff]);

const pageOverride = z
  .object({
    page_key: pageKey,
    stage: z.enum(PIPELINE_STAGES),
    params: jsonObject,
    verdict_id: z.string(),
  })
  .strict();

const recipe = z
  .object({
    declaration_id: z.string(),
    declaration_version: integer.min(1),
    capture: z
      .object({ platen: z.enum(PIPELINE_PLATENS), background: z.enum(PIPELINE_BACKGROUNDS) })
      .strict(),
    output_class: z.enum(PIPELINE_OUTPUT_CLASSES),
    tone_preset: z.string(),
    stages: z
      .object({ preprocess: stage, render: stage, ocr: stage, tile: stageOn })
      .strict(),
    page_overrides: z.array(pageOverride),
  })
  .strict()
  .superRefine((r, ctx) => {
    const ocr = r.stages.ocr;
    if (!ocr.run) return;
    const engine = ocr.params.engine;
    if ((engine === undefined || engine === "tesseract") && r.output_class !== "bilevel") {
      ctx.addIssue({
        code: "custom",
        path: ["output_class"],
        message: "Tesseract OCR requires bilevel output",
      });
    }
  });

/** A page's `rotate_deg`: clockwise degrees from the stored pixels, EXIF ignored. */
const rotateDeg = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);

const manifestMetadataEntry = z.object({ label: jsonObject, value: jsonObject }).strict();

const manifest = z
  .object({
    id: z.string(),
    label: jsonObject,
    homepage: z.array(z.unknown()).min(1).optional(),
    rights: z.string().nullable(),
    required_statement: jsonObject.nullable(),
    provider: z.array(z.unknown()),
    metadata: z.array(manifestMetadataEntry).optional(),
    summary: jsonObject.optional(),
    see_also: z.array(z.unknown()).optional(),
  })
  .strict();

const pageMaster = z
  .object({
    seq: integer.min(1),
    page_key: pageKey,
    master_key: z.string().min(1),
    sha256: z.string().regex(SHA256_PATTERN).optional(),
    rotate_deg: rotateDeg.optional(),
    quarter_turns: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  })
  .strict();
const pagePdf = z
  .object({ seq: integer.min(1), page_key: pageKey, pdf_page: integer.min(1) })
  .strict();

const storePrefix = z
  .object({
    backend,
    endpoint: z.string(),
    bucket: z.string(),
    prefix: z.string(),
    checksums_key: z.string().nullable().optional(),
  })
  .strict();
const storeKey = z
  .object({
    backend,
    endpoint: z.string(),
    bucket: z.string(),
    key: z.string(),
    checksums_key: z.string().nullable().optional(),
  })
  .strict();

// The bucket and endpoint rules a spec with review fields must meet,
// copied from the schema's `$defs` character for character.
const B2_BUCKET_PATTERN = /^[A-Za-z0-9-]{6,63}$/;
const R2_BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const B2_ENDPOINT_PATTERN =
  /^[hH][tT][tT][pP][sS]:\/\/[sS]3\.[A-Za-z0-9-]+\.[bB][aA][cC][kK][bB][lL][aA][zZ][eE][bB]2\.[cC][oO][mM](:443)?\/?$/;
const R2_ENDPOINT_PATTERN =
  /^[hH][tT][tT][pP][sS]:\/\/[A-Fa-f0-9]{32}\.(([eE][uU]|[fF][eE][dD][rR][aA][mM][pP])\.)?[rR]2\.[cC][lL][oO][uU][dD][fF][lL][aA][rR][eE][sS][tT][oO][rR][aA][gG][eE]\.[cC][oO][mM](:443)?\/?$/;
/** A review prefix: exactly `{tenant}/{delivery}/`, with no `..`. */
export const REVIEW_PREFIX_PATTERN =
  /^(?!.*\.\.)[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*\/$/;

const reviewPrefix = z.string().regex(REVIEW_PREFIX_PATTERN);
const purgePrefixes = z.array(reviewPrefix).min(1);

const volume = z
  .object({
    volume_id: z.string(),
    reference_code: z.string().min(1),
    description_id: z.string(),
    tile_root: z.string().regex(TILE_ROOT_PATTERN),
    restricted: z.boolean(),
    expected_count: integer.min(1),
    pages: z.array(z.union([pageMaster, pagePdf])).min(1),
    source: z.union([storePrefix, storeKey]),
    recipe,
    manifest,
    review_purge: purgePrefixes.optional(),
  })
  .strict();

const reviewPage = z
  .object({
    seq: integer.min(1),
    page_key: pageKey,
    master_key: z.string().min(1),
    sha256: z.string().regex(SHA256_PATTERN),
    rotate_deg: rotateDeg.optional(),
  })
  .strict();

const reviewVolume = z
  .object({
    volume_id: z.string(),
    reference_code: z.string().min(1),
    restricted: z.boolean(),
    expected_count: integer.min(1),
    review_prefix: reviewPrefix,
    pages: z.array(reviewPage).min(1),
    source: storePrefix,
  })
  .strict();

const purgeVolume = z
  .object({
    volume_id: z.string(),
    review_purge: purgePrefixes,
  })
  .strict();

const reviewStore = z
  .object({
    backend: z.literal("b2"),
    endpoint: z.string().regex(B2_ENDPOINT_PATTERN),
    bucket: z.string().regex(B2_BUCKET_PATTERN),
    image_base_url: z.string().regex(HTTPS_PATTERN).optional(),
  })
  .strict();

const specFields = {
  spec_version: z.literal(1),
  run_id: z.string().min(1),
  tenant_id: z.string().min(1),
  created_at: dateTime,
  regenerates_run_id: z.string().nullable().optional(),
  runner: z
    .object({
      image: z.string().regex(RUNNER_IMAGE_PATTERN),
      script_version: z.string().min(1),
      arch: z.literal("x64"),
    })
    .strict(),
  callback: z
    .object({
      url_template: z.string().regex(URL_TEMPLATE_PATTERN),
      complete_url: z.string().regex(HTTPS_PATTERN),
      token_expires_at: dateTime,
      token: z.string().min(1),
    })
    .strict(),
  max_review_frac: z.number().min(0).max(1),
  destination: z
    .object({
      backend,
      endpoint: z.string(),
      tiles_bucket: z.string(),
      tiles_prefix: z.string(),
      image_base_url: z.string(),
      ocr_bucket: z.string(),
      ocr_prefix: z.string(),
      credentials_ref: z.string(),
    })
    .strict(),
  working: z
    .object({
      backend: z.literal("b2"),
      endpoint: z.string(),
      bucket: z.string(),
      prefix: z.string(),
    })
    .strict(),
  jobs: z
    .array(
      z
        .object({
          job_index: integer.min(0),
          volume_ids: z.array(z.string()).min(1),
        })
        .strict(),
    )
    .min(1),
};

/** A processing run's spec: a volume run or an item PDF. */
export const processingRunSpecSchema = z
  .object({
    ...specFields,
    kind: z.enum(PIPELINE_RUN_KINDS),
    review: reviewStore.optional(),
    volumes: z.array(volume).min(1),
  })
  .strict();

/** A review run's spec: the review bucket, with its download address, and the pages to tile. */
export const reviewRunSpecSchema = z
  .object({
    ...specFields,
    kind: z.literal("review_run"),
    review: reviewStore.required({ image_base_url: true }),
    volumes: z.array(reviewVolume).min(1),
  })
  .strict();

/**
 * A purge run's spec. Fisqua does not start purge runs; the kind is
 * mirrored so this validator and the schema agree on every document.
 */
export const purgeRunSpecSchema = z
  .object({
    ...specFields,
    kind: z.literal("review_purge"),
    review: reviewStore,
    volumes: z.array(purgeVolume).min(1),
  })
  .strict();

type AnySpecShape = z.infer<typeof processingRunSpecSchema> | z.infer<typeof reviewRunSpecSchema> | z.infer<typeof purgeRunSpecSchema>;

/** Whether a spec uses anything added for review runs (the schema's first `allOf` branch). */
export function hasReviewFields(spec: { kind: string; review?: unknown; volumes: unknown[] }): boolean {
  return (
    spec.review !== undefined ||
    spec.kind === "review_run" ||
    spec.kind === "review_purge" ||
    spec.volumes.some((v) => typeof v === "object" && v !== null && "review_purge" in v)
  );
}

// The schema's `strict_destination`, `working` and `bucket_by_backend`
// rules, which apply only to a spec with review fields.
function checkStrictStores(spec: AnySpecShape, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });
  const bucketOk = (b: string, value: string) =>
    (b === "r2" ? R2_BUCKET_PATTERN : B2_BUCKET_PATTERN).test(value);
  const endpointOk = (b: string, value: string) =>
    (b === "r2" ? R2_ENDPOINT_PATTERN : B2_ENDPOINT_PATTERN).test(value);

  const d = spec.destination;
  if (!endpointOk(d.backend, d.endpoint)) issue(["destination", "endpoint"], "not the backend's S3 host");
  if (!bucketOk(d.backend, d.tiles_bucket)) issue(["destination", "tiles_bucket"], "not a bare bucket name");
  if (!bucketOk(d.backend, d.ocr_bucket)) issue(["destination", "ocr_bucket"], "not a bare bucket name");
  if (!B2_ENDPOINT_PATTERN.test(spec.working.endpoint)) issue(["working", "endpoint"], "not a B2 S3 host");
  if (!B2_BUCKET_PATTERN.test(spec.working.bucket)) issue(["working", "bucket"], "not a bare B2 bucket name");
  spec.volumes.forEach((v, i) => {
    if (!("source" in v)) return;
    const src = v.source;
    if (!endpointOk(src.backend, src.endpoint)) issue(["volumes", i, "source", "endpoint"], "not the backend's S3 host");
    if (!bucketOk(src.backend, src.bucket)) issue(["volumes", i, "source", "bucket"], "not a bare bucket name");
  });
}

export const runSpecSchema = z
  .discriminatedUnion("kind", [processingRunSpecSchema, reviewRunSpecSchema, purgeRunSpecSchema])
  .superRefine((spec, ctx) => {
    if (hasReviewFields(spec)) {
      if (spec.review === undefined) {
        ctx.addIssue({ code: "custom", path: ["review"], message: "review_purge needs a review block" });
      }
      checkStrictStores(spec, ctx);
    }
    if (spec.kind !== "volume_run") return;
    spec.volumes.forEach((v, i) => {
      const ocr = v.recipe.stages.ocr;
      if (!ocr.run) return;
      const lang = ocr.params.lang;
      if (typeof lang !== "string" || lang.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["volumes", i, "recipe", "stages", "ocr", "params", "lang"],
          message: "OCR on a volume run requires a language",
        });
      }
    });
  });

/** The recipe block of one volume entry, on its own. */
export const runSpecRecipeSchema = recipe;

/** Any spec the schema accepts. */
export type AnyRunSpec = z.infer<typeof runSpecSchema>;
/** A processing run's spec, the one dispatch builds and publishing reads. */
export type RunSpec = z.infer<typeof processingRunSpecSchema>;
export type ReviewRunSpec = z.infer<typeof reviewRunSpecSchema>;
export type RunSpecVolume = RunSpec["volumes"][number];
export type RunSpecPage = RunSpecVolume["pages"][number];
export type RunSpecSource = RunSpecVolume["source"];
export type RunSpecRecipe = RunSpecVolume["recipe"];
export type RunSpecJob = RunSpec["jobs"][number];
export type ReviewRunSpecVolume = ReviewRunSpec["volumes"][number];
export type RunSpecReviewStore = z.infer<typeof reviewStore>;

// ---------------------------------------------------------------------------
// Cross-field checks
// ---------------------------------------------------------------------------

export interface RunSpecProblem {
  /** Dotted path, e.g. `volumes.0.pages.2.seq`. */
  path: string;
  rule: string;
  /** The volume the problem belongs to, when the builder knows it. */
  volumeId?: string;
}

/** The part of a volume entry the page checks read. */
export interface VolumePagesInput {
  expected_count: number;
  pages: RunSpecPage[];
  source: RunSpecSource;
  recipe?: { page_overrides: { page_key: string }[] };
}

export function checkVolumePages(
  kind: PipelineRunKind,
  volume: VolumePagesInput,
): RunSpecProblem[] {
  const problems: RunSpecProblem[] = [];
  const once = new Set<string>();
  const report = (path: string, rule: string) => {
    if (once.has(rule)) return;
    once.add(rule);
    problems.push({ path, rule });
  };

  const { pages, source } = volume;
  if (pages.length !== volume.expected_count) report("pages", "page_count");

  const keys = new Set<string>();
  pages.forEach((page, i) => {
    if (page.seq !== i + 1) report(`pages.${i}.seq`, "seq_contiguous");
    if (keys.has(page.page_key)) report(`pages.${i}.page_key`, "page_key_unique");
    keys.add(page.page_key);
  });

  if (kind === "volume_run") {
    const prefix = "prefix" in source ? source.prefix : null;
    if (prefix === null) report("source", "source_prefix_required");
    pages.forEach((page, i) => {
      if (!("master_key" in page)) {
        report(`pages.${i}`, "master_key_required");
      } else if (
        prefix !== null &&
        !(page.master_key.startsWith(prefix) && page.master_key.length > prefix.length)
      ) {
        report(`pages.${i}.master_key`, "master_key_under_prefix");
      }
    });
  } else {
    if (!("key" in source)) report("source", "source_key_required");
    pages.forEach((page, i) => {
      if (!("pdf_page" in page)) report(`pages.${i}`, "pdf_page_required");
    });
  }

  (volume.recipe?.page_overrides ?? []).forEach((override, i) => {
    if (!keys.has(override.page_key)) {
      report(`recipe.page_overrides.${i}.page_key`, "override_page_listed");
    }
  });

  return problems;
}

export function checkRunSpecInvariants(spec: AnyRunSpec): RunSpecProblem[] {
  const problems: RunSpecProblem[] = [];

  const volumeIds = new Set<string>();
  const prefixes = new Set<string>();
  const prefixOnce = (prefix: string, path: string) => {
    if (prefixes.has(prefix)) problems.push({ path, rule: "review_prefix_unique" });
    prefixes.add(prefix);
  };
  spec.volumes.forEach((volume, v) => {
    if (spec.kind === "review_run") {
      // A review run's pages follow a volume run's page rules.
      const entry = volume as ReviewRunSpecVolume;
      for (const p of checkVolumePages("volume_run", entry)) {
        problems.push({ path: `volumes.${v}.${p.path}`, rule: p.rule });
      }
      prefixOnce(entry.review_prefix, `volumes.${v}.review_prefix`);
    } else if (spec.kind === "review_purge") {
      const entry = volume as { review_purge: string[] };
      entry.review_purge.forEach((prefix, k) => prefixOnce(prefix, `volumes.${v}.review_purge.${k}`));
    } else {
      const entry = volume as RunSpecVolume;
      for (const p of checkVolumePages(spec.kind, entry)) {
        problems.push({ path: `volumes.${v}.${p.path}`, rule: p.rule });
      }
      if (entry.review_purge !== undefined) {
        if (spec.kind !== "volume_run") {
          problems.push({ path: `volumes.${v}.review_purge`, rule: "review_purge_kind" });
        }
        const own = new Set<string>();
        entry.review_purge.forEach((prefix, k) => {
          if (own.has(prefix)) problems.push({ path: `volumes.${v}.review_purge.${k}`, rule: "review_prefix_unique" });
          own.add(prefix);
        });
      }
    }
    if (volumeIds.has(volume.volume_id)) {
      problems.push({ path: `volumes.${v}.volume_id`, rule: "volume_id_unique" });
    }
    volumeIds.add(volume.volume_id);
  });

  const jobIndices = new Set<number>();
  const placed = new Set<string>();
  spec.jobs.forEach((job, j) => {
    if (jobIndices.has(job.job_index)) {
      problems.push({ path: `jobs.${j}.job_index`, rule: "job_index_unique" });
    }
    jobIndices.add(job.job_index);
    job.volume_ids.forEach((id, k) => {
      if (!volumeIds.has(id)) {
        problems.push({ path: `jobs.${j}.volume_ids.${k}`, rule: "job_volume_known" });
      } else if (placed.has(id)) {
        problems.push({ path: `jobs.${j}.volume_ids.${k}`, rule: "volume_in_one_job" });
      }
      placed.add(id);
    });
  });

  spec.volumes.forEach((volume, v) => {
    if (!placed.has(volume.volume_id)) {
      problems.push({ path: `volumes.${v}`, rule: "volume_in_one_job" });
    }
  });

  // The review keys must reach no other bucket of the run. B2 bucket
  // names are unique across B2, and the review bucket is always on B2,
  // so any other store with the same name, compared without regard to
  // case, is the same bucket.
  if (spec.review !== undefined) {
    const review = spec.review.bucket.toLowerCase();
    const others: Array<[string, string]> = [
      ["destination.tiles_bucket", spec.destination.tiles_bucket],
      ["destination.ocr_bucket", spec.destination.ocr_bucket],
      ["working.bucket", spec.working.bucket],
    ];
    spec.volumes.forEach((volume, v) => {
      if ("source" in volume) others.push([`volumes.${v}.source.bucket`, volume.source.bucket]);
    });
    for (const [path, bucket] of others) {
      if (bucket.toLowerCase() === review) problems.push({ path, rule: "review_bucket_distinct" });
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class RunSpecError extends Error {
  readonly problems: RunSpecProblem[];
  constructor(problems: RunSpecProblem[]) {
    super(
      `Invalid run spec: ${problems
        .map((p) => `${p.volumeId ? `volume ${p.volumeId} ` : ""}${p.path || "(root)"}: ${p.rule}`)
        .join("; ")}`,
    );
    this.name = "RunSpecError";
    this.problems = problems;
  }
}

function issueProblems(issues: z.core.$ZodIssue[]): RunSpecProblem[] {
  const out: RunSpecProblem[] = [];
  for (const issue of issues) {
    const base = issue.path.map(String).join(".");
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        out.push({ path: base ? `${base}.${key}` : key, rule: issue.code });
      }
    } else {
      out.push({ path: base, rule: issue.code });
    }
  }
  return out;
}

/** Validates a spec of any kind: the schema, then the cross-field checks. */
export function validateAnyRunSpec(x: unknown): AnyRunSpec {
  const parsed = runSpecSchema.safeParse(x);
  if (!parsed.success) throw new RunSpecError(issueProblems(parsed.error.issues));
  const problems = checkRunSpecInvariants(parsed.data);
  if (problems.length > 0) throw new RunSpecError(problems);
  return parsed.data;
}

/**
 * Validates a processing run's spec (a volume run or an item PDF), the
 * only kind dispatch builds and publishing reads; a valid spec of
 * another kind is refused with rule `processing_kind`.
 */
export function validateRunSpec(x: unknown): RunSpec {
  const spec = validateAnyRunSpec(x);
  if (spec.kind !== "volume_run" && spec.kind !== "item_pdf") {
    throw new RunSpecError([{ path: "kind", rule: "processing_kind" }]);
  }
  return spec;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

type PipelineVolumeRow = typeof pipelineVolumes.$inferSelect;
type PipelineVolumePageRow = typeof pipelineVolumePages.$inferSelect;
type DescriptionRow = typeof descriptions.$inferSelect;
type RepositoryRow = typeof repositories.$inferSelect;
type TenantRow = typeof tenants.$inferSelect;

export type RunSpecManifest = RunSpecVolume["manifest"];

export type ManifestResolver = (
  volume: PipelineVolumeRow,
  description: DescriptionRow | null,
  repository: RepositoryRow | null,
  tenant: TenantRow,
) => RunSpecManifest;

export type ManifestInputsCode =
  | "manifest_inputs_unavailable"
  | "repository_rights_unset"
  | "repository_attribution_incomplete";

export class ManifestInputsError extends Error {
  readonly code: ManifestInputsCode;
  /** What the refusal names, e.g. the repository's id and code. */
  readonly detail: Record<string, unknown>;
  constructor(
    message: string,
    code: ManifestInputsCode = "manifest_inputs_unavailable",
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ManifestInputsError";
    this.code = code;
    this.detail = detail;
  }
}

export interface BuildRunSpecVolume {
  volume: PipelineVolumeRow;
  pages: PipelineVolumePageRow[];
  recipe: RunSpecRecipe;
  description: DescriptionRow | null;
  repository: RepositoryRow | null;
  /** Clockwise quarter-turns by page key, from capture QC (runner v1.1.0 and later). */
  rotations?: Map<string, number>;
  /** `rotate_deg` by page key, from the capture images (runner v1.2.0 and later). */
  rotateDegs?: Map<string, number>;
  /** The review prefixes to delete once the volume's tiles are verified (runner v1.1.0 and later). */
  reviewPurge?: string[];
}

export interface BuildRunSpecInput {
  runId: string;
  tenantId: string;
  /** The deployment's environment, which names the runner's key store. */
  environment: PipelineEnvironment;
  kind: PipelineRunKind;
  /** Epoch milliseconds. */
  createdAt: number;
  regeneratesRunId?: string | null;
  runner: { image: string; scriptVersion: string };
  callback: { origin: string; token: string; tokenExpiresAt: number };
  maxReviewFrac: number;
  /**
   * Where the tenant's output goes: its federation's tiles bucket and
   * endpoint, with the tenant's prefixes and image address in it.
   */
  destination: {
    endpoint: string;
    tilesBucket: string;
    tilesPrefix: string;
    imageBaseUrl: string;
    ocrPrefix: string;
  };
  working: { endpoint: string; bucket: string };
  /** The federation's review-tiles bucket on B2, which `review_purge` prefixes are in. */
  review?: { endpoint: string; bucket: string };
  jobs: RunSpecJob[];
  volumes: BuildRunSpecVolume[];
  /** The tenant the run belongs to, passed to the manifest resolver. */
  tenant: TenantRow;
  manifestResolver: ManifestResolver;
}

/** A volume entry's `source` block, from the volume's masters columns. */
export function specSource(kind: PipelineRunKind, v: PipelineVolumeRow, index: number): RunSpecSource {
  const base = {
    backend: v.mastersBackend,
    endpoint: v.mastersEndpoint,
    bucket: v.mastersBucket,
  };
  if (kind === "volume_run") {
    if (v.mastersPrefix === null) {
      throw new RunSpecError([
        { path: `volumes.${index}.source`, rule: "source_prefix_required", volumeId: v.id },
      ]);
    }
    return { ...base, prefix: v.mastersPrefix, checksums_key: v.checksumsKey };
  }
  if (v.mastersKey === null) {
    throw new RunSpecError([
      { path: `volumes.${index}.source`, rule: "source_key_required", volumeId: v.id },
    ]);
  }
  return { ...base, key: v.mastersKey, checksums_key: v.checksumsKey };
}

/**
 * A volume entry's `pages`, from its page rows in `seq` order. A master
 * page carries `sha256` when its row has one and omits the field
 * otherwise, `rotate_deg` when `rotateDegs` gives its page key 0, 90,
 * 180 or 270 and omits it otherwise, and `quarter_turns` when
 * `rotations` gives its page key a turn of 1, 2 or 3 and omits it
 * otherwise; a PDF page carries none of them.
 */
export function specPages(
  rows: PipelineVolumePageRow[],
  rotations?: Map<string, number>,
  rotateDegs?: Map<string, number>,
): RunSpecPage[] {
  return [...rows]
    .sort((a, b) => a.seq - b.seq)
    .map((p) => {
      if (p.masterKey === null) {
        return { seq: p.seq, page_key: p.pageKey, pdf_page: p.pdfPage as number };
      }
      const turns = rotations?.get(p.pageKey);
      const degrees = rotateDegs?.get(p.pageKey);
      return {
        seq: p.seq,
        page_key: p.pageKey,
        master_key: p.masterKey,
        ...(p.sha256 !== null ? { sha256: p.sha256 } : {}),
        ...(degrees === 0 || degrees === 90 || degrees === 180 || degrees === 270 ? { rotate_deg: degrees } : {}),
        ...(turns === 1 || turns === 2 || turns === 3 ? { quarter_turns: turns } : {}),
      };
    });
}

export function buildRunSpec(input: BuildRunSpecInput): RunSpec {
  const origin = input.callback.origin.replace(/\/+$/, "");
  const runBase = `${origin}/api/pipeline/runs/${input.runId}`;

  const volumes: RunSpecVolume[] = input.volumes.map((entry, i) => {
    const v = entry.volume;
    if (v.restricted) {
      throw new RunSpecError([{ path: `volumes.${i}`, rule: "restricted", volumeId: v.id }]);
    }
    if (!TILE_ROOT_PATTERN.test(v.referenceCode)) {
      throw new RunSpecError([
        { path: `volumes.${i}.reference_code`, rule: "invalid_reference_code", volumeId: v.id },
      ]);
    }
    const built: RunSpecVolume = {
      volume_id: v.id,
      reference_code: v.referenceCode,
      description_id: v.descriptionId,
      tile_root: v.referenceCode,
      restricted: false,
      expected_count: v.expectedCount,
      pages: specPages(entry.pages, entry.rotations, entry.rotateDegs),
      source: specSource(input.kind, v, i),
      recipe: entry.recipe,
      manifest: input.manifestResolver(v, entry.description, entry.repository, input.tenant),
      ...(entry.reviewPurge !== undefined && entry.reviewPurge.length > 0
        ? { review_purge: entry.reviewPurge }
        : {}),
    };
    const problems = checkVolumePages(input.kind, built);
    if (problems.length > 0) {
      throw new RunSpecError(
        problems.map((p) => ({ path: `volumes.${i}.${p.path}`, rule: p.rule, volumeId: v.id })),
      );
    }
    return built;
  });

  const spec: RunSpec = {
    spec_version: 1,
    run_id: input.runId,
    tenant_id: input.tenantId,
    kind: input.kind,
    created_at: new Date(input.createdAt).toISOString(),
    regenerates_run_id: input.regeneratesRunId ?? null,
    runner: { image: input.runner.image, script_version: input.runner.scriptVersion, arch: "x64" },
    callback: {
      url_template: `${runBase}/volumes/{volume_id}/callback`,
      complete_url: `${runBase}/complete`,
      token_expires_at: new Date(input.callback.tokenExpiresAt).toISOString(),
      token: input.callback.token,
    },
    max_review_frac: input.maxReviewFrac,
    destination: {
      backend: "b2",
      endpoint: input.destination.endpoint,
      tiles_bucket: input.destination.tilesBucket,
      tiles_prefix: input.destination.tilesPrefix,
      image_base_url: input.destination.imageBaseUrl,
      ocr_bucket: input.destination.tilesBucket,
      ocr_prefix: input.destination.ocrPrefix,
      credentials_ref: runnerKeyStoreName(input.tenantId, input.environment),
    },
    working: {
      backend: "b2",
      endpoint: input.working.endpoint,
      bucket: input.working.bucket,
      prefix: pipelineKey.workingPrefix(input.tenantId, input.runId),
    },
    jobs: input.jobs,
    ...(input.review !== undefined
      ? { review: { backend: "b2" as const, endpoint: input.review.endpoint, bucket: input.review.bucket } }
      : {}),
    volumes,
  };
  validateRunSpec(spec);
  return spec;
}

// @version v0.8.0
