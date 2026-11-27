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
 * A review run, which makes a capture delivery's review images, is
 * timed by its own constants. They come from the review runs of 30 and
 * 31 October 2026: 168 runs over 111,871 pages took a median 5.0
 * seconds per page and at most 11.0, the longest run 206 minutes. The
 * volume-run constants timed those runs at under a second per image, so
 * 24 of them outlived their spec URL and two outlived the callback
 * token and lost their results.
 *
 * - `secondsPerImage` (6) is just above the median; `marginFactor` (2)
 *   doubles it to 12 seconds, which covers the observed maximum.
 * - `lanes` is 1, because a review run is one job of every page.
 * - `urlFloorSeconds` (six hours) and `tokenFloorSeconds` (eight hours)
 *   are longer than the longest run observed.
 * - The overhead, chunk spacing, queue and callback allowances are the
 *   volume run's.
 *
 * At these values a review of up to 50,040 pages has a spec URL inside
 * seven days; the start refuses a larger one as too long to run.
 *
 * `REVIEW_ACTIVE_RUN_CAP` (4) is the most review runs that may be active
 * at once, across every tenant and federation: runs whose results may
 * still arrive. The same runs of 30 and 31 October were started about 40
 * an hour, and with 20 to 37 at once each page took 7 to 9 seconds
 * against about 2.3 with few, because they read and wrote the same B2
 * storage; the runner minutes billed roughly tripled. The sweep's limit
 * per tick bounds how fast runs start, not how many run, so the cap is
 * separate from it. It is global because the storage and the runners are
 * shared. The Volumes screen names it in the message for a start the cap
 * refused, so it lives here, where a client module can read it.
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
 * @version v0.9.0
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

export const REVIEW_RUN_LIFETIME_CONSTANTS: LifetimeConstants = {
  secondsPerImage: 6,
  perJobOverheadSeconds: 300,
  lanes: 1,
  chunkSpacingSeconds: 60,
  queueAllowanceSeconds: 1_800,
  marginFactor: 2,
  tokenFloorSeconds: 28_800,
  urlFloorSeconds: 21_600,
  callbackTailSeconds: 900,
};

/** The most review runs active at once, across all tenants and federations. */
export const REVIEW_ACTIVE_RUN_CAP = 4;

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

// @version v0.9.0
