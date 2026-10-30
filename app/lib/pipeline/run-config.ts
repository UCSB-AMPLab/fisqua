/**
 * Media Pipeline — Run Configuration
 *
 * This module holds the values a pipeline run is sized and timed by:
 * the run-size limits, the job grouping target, the token and spec-URL
 * lifetime constants, and the recipe presets with the parameter keys
 * the pinned runner version accepts.
 *
 * The lifetime constants come from one measurement: a 734-image volume
 * took 11.6 minutes on an eight-vCPU x64 runner, all stages included,
 * about 0.95 seconds per image, with 16 such runners available at once.
 * Everything else is an allowance on top of that measurement:
 *
 * - `perJobOverheadSeconds` (five minutes) covers a job's start-up and
 *   transfers. It has not been measured for jobs made of many small
 *   volumes; the acceptance runs measure it.
 * - `chunkSpacingSeconds` (one minute) separates the dispatch chunks.
 * - `queueAllowanceSeconds` (30 minutes) covers waiting for a runner.
 * - `marginFactor` (2) doubles the estimate before the spec URL is
 *   timed from it.
 * - `urlFloorSeconds` (two hours) and `tokenFloorSeconds` (three hours)
 *   keep a small run, such as a sample, from being timed by its tiny
 *   estimate.
 * - `callbackTailSeconds` (15 minutes) covers the runner's callback
 *   retries, about ten minutes, after a job's last stage.
 *
 * At these values the largest run allowed (250,000 pages in 2,000
 * volumes) needs a spec URL of about 13 hours, far inside the seven
 * days a presigned URL may last.
 *
 * `targetImagesPerJob` is the measured volume's size, so a job of small
 * volumes takes about as long as one large volume. `maxRunVolumes` and
 * `maxRunPages` are the sizes the dispatch path is tested at against
 * D1's statement and parameter limits; a larger campaign is several
 * runs. `maxSampleVolumes` is the number of runners, so a sample run of
 * single-job volumes finishes in one wave.
 *
 * Both output classes have a preset: the tonal default and the bilevel
 * default. The accepted keys are the runner's published list
 * (`schema/recipe-params.json`) for the pinned script version.
 *
 * @version v0.8.0
 */

import { BILEVEL_DEFAULT_PRESET, TONAL_DEFAULT_PRESET, type RecipePresets } from "./recipe";
import type { LifetimeConstants } from "./token.server";

export const RUN_LIFETIME_CONSTANTS: LifetimeConstants = {
  secondsPerImage: 0.95,
  perJobOverheadSeconds: 300,
  lanes: 16,
  chunkSpacingSeconds: 60,
  queueAllowanceSeconds: 1_800,
  marginFactor: 2,
  tokenFloorSeconds: 10_800,
  urlFloorSeconds: 7_200,
  callbackTailSeconds: 900,
};

export const RUN_PRESETS: RecipePresets = {
  byOutputClass: { tonal: TONAL_DEFAULT_PRESET, bilevel: BILEVEL_DEFAULT_PRESET },
  acceptedKeys: {
    preprocess: [
      "autolevel_hi",
      "autolevel_lo",
      "autolevel_mode",
      "clahe_clip",
      "detect_max_px",
      "format",
      "interp",
      "max_fallback_frac",
      "pad",
      "pad_frac",
    ],
    render: [
      "binarise",
      "format",
      "margin_frac",
      "mask",
      "sauvola_k",
      "sauvola_window",
      "trim",
      "width_tol",
    ],
  },
};

export const RUN_LIMITS = {
  maxRunVolumes: 2_000,
  maxRunPages: 250_000,
  maxSampleVolumes: 16,
  targetImagesPerJob: 734,
} as const;
