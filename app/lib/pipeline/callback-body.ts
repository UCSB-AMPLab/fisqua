/**
 * Media Pipeline — Callback Bodies
 *
 * This module deals with the two request bodies the media pipeline
 * runner posts back to Fisqua, and with nothing else: the handlers that
 * authenticate, store and act on them live in `callback.server.ts`.
 *
 * `volumeCallbackBodySchema` is the per-volume outcome report one job
 * sends after each volume: the outcome (`prepared`, `review_pending`,
 * `aborted` or `halted`), the outcome of each of the seven runner stages,
 * the write-point QC block, the transfer verification, the open review
 * flags and the output pointers. The top level, `outputs`, `error`, and
 * `qc` and `verification` when present are closed objects. Stage
 * `detail` blocks and the `runner` block are stored verbatim and
 * not interpreted, so they accept any keys; stage objects keep fields
 * this schema does not name for the same reason.
 *
 * The rules that span fields are checked together after the shape:
 *
 *   - `prepared` and `review_pending` carry `qc` and `verification`
 *     objects, every non-null QC flag true, and no `error`;
 *   - `aborted` and `halted` carry an `error` whose class pairs with the
 *     outcome: the systemic classes (`source_pull`, `destination`,
 *     `auth`) halt a run and come only with `halted`, and every other
 *     runner class, `fixity` among them, comes only with `aborted`. Their `qc` and
 *     `verification` may be null, because the runner sets each only when
 *     its step completes;
 *   - `prepared` has no flags; `review_pending` has at least one or a
 *     truncated list; a list holds at most 500 flags and is truncated
 *     only at 500;
 *   - each flag names a page, one of the four recipe stages, and a code
 *     and summary that are not empty, and no two flags share a page,
 *     stage and code. These are the review-item table's constraints, so
 *     the insert that copies flags into it never meets a row it refuses;
 *   - `verification.method` is the two-way check, `rclone-check`.
 *
 * A processing report may carry `review_purge`, when the spec named
 * review prefixes for the runner to delete once the volume's tiles were
 * verified: the purge's status (`purged`, `failed`, or `not_reached`
 * when the volume stopped first), the prefixes, and each failure with
 * its message. A purged report lists no failure and a failed one at
 * least one; a `prepared` or `review_pending` volume was verified, so
 * its purge was reached.
 *
 * `reviewCallbackBodySchema` is the report of a review run's volume
 * (kind `review_run`): the delivery's previews tiled as captured. It has
 * the processing report's shape with three differences: the outcome is
 * `review_ready`, `aborted` or `halted`; the QC block has no canvas
 * count, homepage check or OCR check (each null), since nothing was
 * rendered or manifested; and the outputs name the review prefix, the
 * bytes of tiles written and the report key. A review report carries no
 * flags. `review_ready` pairs with `qc` and `verification` and no
 * `error`, and `aborted` and `halted` with an error class as above.
 *
 * `chunkCompleteBodySchema` is the report a chunk's completion job sends
 * once every job in the chunk has ended: the GitHub conclusion, the
 * volumes whose callback never received a 200, and those of them that
 * halted. Both lists are free of duplicates, and every halted volume is
 * also unreported. `chunkIdempotencyKey` gives the `Idempotency-Key`
 * header value such a report must carry.
 *
 * @version v0.8.0
 */

import { z } from "zod";
import {
  PIPELINE_REVIEW_PURGE_STATUSES,
  PIPELINE_RUNNER_ERROR_CLASSES,
  PIPELINE_STAGES,
  PIPELINE_SYSTEMIC_ERROR_CLASSES,
} from "../validation/enums";

/** The most flags a callback body may carry. */
export const MAX_CALLBACK_FLAGS = 500;

const ATTEMPT_PATTERN = /^\d+\.\d+$/;
const RUNNER_STAGES = ["pull", "preprocess", "render", "ocr", "tile", "upload", "verify"] as const;
const SYSTEMIC = new Set<string>(PIPELINE_SYSTEMIC_ERROR_CLASSES);

const jsonObject = z.record(z.string(), z.unknown());
const count = z.number().int().min(0);
const seconds = z.number().min(0);
const attempt = z.string().regex(ATTEMPT_PATTERN);

const stageReport = z
  .looseObject({
    status: z.enum(["ok", "skipped", "failed", "not_reached"]),
    reason: z.string().min(1).optional(),
    count: count.optional(),
    bytes: count.optional(),
    elapsed_s: seconds.optional(),
    flags: count.optional(),
    detail: jsonObject.optional(),
  })
  .superRefine((s, ctx) => {
    if (s.status === "skipped" && s.reason === undefined) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "a skipped stage needs a reason" });
    }
  });

const stages = z
  .object(Object.fromEntries(RUNNER_STAGES.map((name) => [name, stageReport])) as Record<
    (typeof RUNNER_STAGES)[number],
    typeof stageReport
  >)
  .strict();

const qc = z
  .object({
    expected_count: count,
    processed_count: count,
    canvas_count: count,
    info_json_complete: z.boolean().nullable(),
    homepage_conformant: z.boolean().nullable(),
    ocr_pairs_complete: z.boolean().nullable(),
  })
  .strict();

const verification = z
  .object({
    method: z.literal("rclone-check"),
    passed: z.boolean(),
    files_checked: count,
    differences: count,
  })
  .strict();

const runnerError = z
  .object({
    class: z.enum(PIPELINE_RUNNER_ERROR_CLASSES),
    stage: z.string(),
    message: z.string(),
    page_keys: z.array(z.string()),
  })
  .strict();

const flag = z
  .object({
    page_key: z.string().min(1),
    stage: z.enum(PIPELINE_STAGES),
    code: z.string().min(1),
    summary: z.string().min(1),
  })
  .strict();

const outputs = z
  .object({
    tile_root: z.string(),
    tiles_bytes: count,
    ocr_bytes: count,
    manifest_key: z.string(),
    report_key: z.string(),
  })
  .strict();

const reviewPurge = z
  .object({
    status: z.enum(PIPELINE_REVIEW_PURGE_STATUSES),
    prefixes: z.array(z.string()),
    failed: z.array(z.object({ prefix: z.string(), message: z.string() }).strict()),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.status === "failed" && p.failed.length === 0) {
      ctx.addIssue({ code: "custom", path: ["failed"], message: "a failed purge names a failure" });
    }
    if (p.status !== "failed" && p.failed.length > 0) {
      ctx.addIssue({ code: "custom", path: ["failed"], message: `a purge ${p.status} names no failure` });
    }
  });

export type ReviewPurgeReport = z.infer<typeof reviewPurge>;

export const volumeCallbackBodySchema = z
  .object({
    spec_version: z.literal(1),
    run_id: z.string().min(1),
    volume_id: z.string().min(1),
    attempt,
    outcome: z.enum(["prepared", "review_pending", "aborted", "halted"]),
    error: runnerError.nullable(),
    runner: jsonObject,
    stages,
    qc: qc.nullable(),
    verification: verification.nullable(),
    flags: z.array(flag).max(MAX_CALLBACK_FLAGS),
    flags_truncated: z.boolean(),
    outputs,
    elapsed_s: seconds,
    review_purge: reviewPurge.optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });

    if ((b.outcome === "prepared" || b.outcome === "review_pending") && b.review_purge?.status === "not_reached") {
      issue(["review_purge", "status"], `${b.outcome} reached the purge`);
    }

    if (b.outcome === "prepared" || b.outcome === "review_pending") {
      if (b.error !== null) issue(["error"], `${b.outcome} carries no error`);
      if (b.qc === null) issue(["qc"], `${b.outcome} needs a qc block`);
      if (b.verification === null) issue(["verification"], `${b.outcome} needs a verification`);
      if (b.qc) {
        for (const [key, value] of Object.entries(b.qc)) {
          if (value === false) issue(["qc", key], `${b.outcome} needs every qc check true`);
        }
      }
    } else if (b.error === null) {
      issue(["error"], `${b.outcome} needs an error`);
    } else {
      const systemic = SYSTEMIC.has(b.error.class);
      if (b.outcome === "halted" && !systemic) {
        issue(["error", "class"], "halted needs a systemic error class");
      }
      if (b.outcome === "aborted" && systemic) {
        issue(["error", "class"], "a systemic error class halts the run");
      }
    }

    if (b.outcome === "prepared" && (b.flags.length > 0 || b.flags_truncated)) {
      issue(["flags"], "prepared carries no flags");
    }
    if (b.outcome === "review_pending" && b.flags.length === 0 && !b.flags_truncated) {
      issue(["flags"], "review_pending needs a flag");
    }
    if (b.flags_truncated && b.flags.length !== MAX_CALLBACK_FLAGS) {
      issue(["flags_truncated"], `a truncated list holds ${MAX_CALLBACK_FLAGS} flags`);
    }

    const seen = new Set<string>();
    b.flags.forEach((f, i) => {
      const key = JSON.stringify([f.page_key, f.stage, f.code]);
      if (seen.has(key)) issue(["flags", i], "repeated page, stage and code");
      seen.add(key);
    });
  });

export type VolumeCallbackBody = z.infer<typeof volumeCallbackBodySchema>;

const reviewQc = z
  .object({
    expected_count: count,
    processed_count: count,
    canvas_count: z.null(),
    info_json_complete: z.boolean().nullable(),
    homepage_conformant: z.null(),
    ocr_pairs_complete: z.null(),
  })
  .strict();

const reviewOutputs = z
  .object({
    review_prefix: z.string(),
    tiles_bytes: count,
    report_key: z.string(),
  })
  .strict();

export const reviewCallbackBodySchema = z
  .object({
    spec_version: z.literal(1),
    run_id: z.string().min(1),
    volume_id: z.string().min(1),
    attempt,
    outcome: z.enum(["review_ready", "aborted", "halted"]),
    error: runnerError.nullable(),
    runner: jsonObject,
    stages,
    qc: reviewQc.nullable(),
    verification: verification.nullable(),
    flags: z.array(flag).max(0),
    flags_truncated: z.literal(false),
    outputs: reviewOutputs,
    elapsed_s: seconds,
  })
  .strict()
  .superRefine((b, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });

    if (b.outcome === "review_ready") {
      if (b.error !== null) issue(["error"], "review_ready carries no error");
      if (b.qc === null) issue(["qc"], "review_ready needs a qc block");
      if (b.verification === null) issue(["verification"], "review_ready needs a verification");
      if (b.qc?.info_json_complete === false) issue(["qc", "info_json_complete"], "review_ready needs every qc check true");
    } else if (b.error === null) {
      issue(["error"], `${b.outcome} needs an error`);
    } else {
      const systemic = SYSTEMIC.has(b.error.class);
      if (b.outcome === "halted" && !systemic) {
        issue(["error", "class"], "halted needs a systemic error class");
      }
      if (b.outcome === "aborted" && systemic) {
        issue(["error", "class"], "a systemic error class halts the run");
      }
    }
  });

export type ReviewCallbackBody = z.infer<typeof reviewCallbackBodySchema>;

function uniqueIds(list: string[], path: string, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  list.forEach((id, i) => {
    if (seen.has(id)) ctx.addIssue({ code: "custom", path: [path, i], message: "repeated id" });
    seen.add(id);
  });
}

export const chunkCompleteBodySchema = z
  .object({
    spec_version: z.literal(1),
    run_id: z.string().min(1),
    chunk_index: z.number().int().min(0),
    attempt,
    conclusion: z.enum(["success", "failure", "cancelled"]),
    unreported_volume_ids: z.array(z.string().min(1)),
    halted_volume_ids: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((b, ctx) => {
    uniqueIds(b.unreported_volume_ids, "unreported_volume_ids", ctx);
    uniqueIds(b.halted_volume_ids, "halted_volume_ids", ctx);
    const unreported = new Set(b.unreported_volume_ids);
    b.halted_volume_ids.forEach((id, i) => {
      if (!unreported.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["halted_volume_ids", i],
          message: "a halted volume is also unreported",
        });
      }
    });
  });

export type ChunkCompleteBody = z.infer<typeof chunkCompleteBodySchema>;

/** The `Idempotency-Key` a chunk-complete report carries. */
export function chunkIdempotencyKey(
  body: Pick<ChunkCompleteBody, "run_id" | "chunk_index" | "attempt">,
): string {
  return `${body.run_id}:chunk:${body.chunk_index}:${body.attempt}`;
}

// @version v0.8.0
