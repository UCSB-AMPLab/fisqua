/**
 * Tests — the run configuration the start-run route uses
 *
 * This suite checks the run configuration the start-run route uses. The
 * configuration must be accepted by the lifetime check, keep every run it
 * allows inside the seven days a presigned spec URL may last, time a small
 * sample run by the floors, and configure a preset for each output class
 * whose keys and enumerated values the runner accepts. The largest run is
 * checked in two shapes: the run-size limits spread over many jobs, and the
 * same pages in one volume, which is one job and the longest a run can
 * take.
 *
 * A review run is one job of a delivery's pages and is timed by its own
 * constants. The suite checks those constants pass the lifetime check,
 * time a 1,269-page and a 2,191-page review as computed by hand, time a
 * small review by the review floors, and keep the largest review the
 * start accepts inside a presigned URL's seven days, one page more being
 * outside them, so the start refuses it.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_RUN_CONFIG } from "../../app/lib/pipeline/dispatch.server";
import { groupJobs } from "../../app/lib/pipeline/grouping";
import {
  REVIEW_RUN_LIFETIME_CONSTANTS,
  RUN_LIFETIME_CONSTANTS,
  RUN_LIMITS,
  RUN_PRESETS,
} from "../../app/lib/pipeline/run-config";
import {
  PRESIGN_MAX_SECONDS,
  assertLifetimeConstants,
  runLifetimes,
} from "../../app/lib/pipeline/token.server";

const NOW = 1_800_000_000_000;

// The values the runner's stage scripts accept for each enumerated key
// (`CHOICES` in the runner's recipe_params.py).
const RUNNER_CHOICES: Record<"preprocess" | "render", Record<string, readonly string[]>> = {
  preprocess: {
    autolevel_mode: ["uniform", "per-channel", "off"],
    interp: ["linear", "cubic"],
    format: ["jpeg", "png"],
  },
  render: {
    binarise: ["none", "sauvola"],
    trim: ["on", "off"],
    mask: ["require", "optional"],
    format: ["png", "jpeg"],
  },
};

function lifetimeSeconds(jobImageCounts: number[], chunkCount: number) {
  const totalImages = jobImageCounts.reduce((a, b) => a + b, 0);
  const r = runLifetimes(NOW, { totalImages, jobImageCounts, chunkCount }, RUN_LIFETIME_CONSTANTS);
  return { url: (r.specUrlExpiresAt - NOW) / 1000, token: (r.tokenExpiresAt - NOW) / 1000 };
}

// A review run as the start times it: one job of every page, one chunk.
function reviewLifetimeSeconds(pages: number) {
  const r = runLifetimes(
    NOW,
    { totalImages: pages, jobImageCounts: [pages], chunkCount: 1 },
    REVIEW_RUN_LIFETIME_CONSTANTS,
  );
  return { url: (r.specUrlExpiresAt - NOW) / 1000, token: (r.tokenExpiresAt - NOW) / 1000 };
}

// The largest review whose spec URL fits in seven days:
// 2 * (6n + 300 + 60 + 1800) <= 604,800, so n <= 50,040.
const LARGEST_REVIEW_PAGES = 50_040;

describe("run configuration", () => {
  it("is set, and built from the run configuration module", () => {
    expect(DEFAULT_RUN_CONFIG).not.toBeNull();
    expect(DEFAULT_RUN_CONFIG).toMatchObject({
      ...RUN_LIMITS,
      lifetime: RUN_LIFETIME_CONSTANTS,
      reviewLifetime: REVIEW_RUN_LIFETIME_CONSTANTS,
      presets: RUN_PRESETS,
    });
  });

  it("keeps the volume-run lifetime constants as measured", () => {
    expect(RUN_LIFETIME_CONSTANTS).toEqual({
      secondsPerImage: 0.95,
      perJobOverheadSeconds: 300,
      lanes: 16,
      chunkSpacingSeconds: 60,
      queueAllowanceSeconds: 1_800,
      marginFactor: 2,
      tokenFloorSeconds: 10_800,
      urlFloorSeconds: 7_200,
      callbackTailSeconds: 900,
    });
  });

  it("passes the lifetime check", () => {
    expect(() => assertLifetimeConstants(RUN_LIFETIME_CONSTANTS)).not.toThrow();
  });

  it("keeps the largest run spread over many jobs well inside a presigned URL's lifetime", () => {
    const perVolume = RUN_LIMITS.maxRunPages / RUN_LIMITS.maxRunVolumes;
    const volumes = Array.from({ length: RUN_LIMITS.maxRunVolumes }, (_, i) => ({
      id: `v${i}`,
      referenceCode: `ref-${String(i).padStart(5, "0")}`,
      expectedCount: perVolume,
    }));
    const jobs = groupJobs(volumes, RUN_LIMITS.targetImagesPerJob);
    const counts = jobs.map((j) => j.volume_ids.length * perVolume);
    const { url, token } = lifetimeSeconds(counts, Math.ceil(jobs.length / 256));
    expect(url).toBeLessThan(24 * 3600);
    expect(token).toBeGreaterThan(url);
  });

  it("keeps the largest run in a single volume inside a presigned URL's lifetime", () => {
    const { url } = lifetimeSeconds([RUN_LIMITS.maxRunPages], 1);
    expect(url).toBeLessThan(PRESIGN_MAX_SECONDS);
  });

  it("times a two-image sample run by the floors", () => {
    const { url, token } = lifetimeSeconds([2], 1);
    expect(url).toBe(RUN_LIFETIME_CONSTANTS.urlFloorSeconds);
    expect(token).toBe(RUN_LIFETIME_CONSTANTS.tokenFloorSeconds);
  });

  it("passes the lifetime check for review runs", () => {
    expect(() => assertLifetimeConstants(REVIEW_RUN_LIFETIME_CONSTANTS)).not.toThrow();
  });

  it("times a review run as one job in one lane", () => {
    expect(REVIEW_RUN_LIFETIME_CONSTANTS).toEqual({
      secondsPerImage: 6,
      perJobOverheadSeconds: 300,
      lanes: 1,
      chunkSpacingSeconds: 60,
      queueAllowanceSeconds: 1_800,
      marginFactor: 2,
      urlFloorSeconds: 21_600,
      tokenFloorSeconds: 28_800,
      callbackTailSeconds: 900,
    });
  });

  it("times a 1,269-page review by the review URL floor", () => {
    // max(2 * (1269 * 6 + 300 + 60 + 1800), 21600) = max(19548, 21600)
    const { url, token } = reviewLifetimeSeconds(1_269);
    expect(url).toBe(21_600);
    // max(21600 + 1269 * 6 + 300 + 900, 28800) = max(30414, 28800)
    expect(token).toBe(30_414);
  });

  it("times a 2,191-page review from its estimate", () => {
    // 2 * (2191 * 6 + 300 + 60 + 1800) = 2 * (13146 + 2160)
    const { url, token } = reviewLifetimeSeconds(2_191);
    expect(url).toBe(30_612);
    // 30612 + 13146 + 300 + 900
    expect(token).toBe(44_958);
  });

  it("times a two-page review by the review floors", () => {
    const { url, token } = reviewLifetimeSeconds(2);
    expect(url).toBe(REVIEW_RUN_LIFETIME_CONSTANTS.urlFloorSeconds);
    expect(token).toBe(REVIEW_RUN_LIFETIME_CONSTANTS.tokenFloorSeconds);
  });

  it("keeps the largest review the start accepts inside a presigned URL's lifetime, and one page more outside it", () => {
    expect(reviewLifetimeSeconds(LARGEST_REVIEW_PAGES).url).toBeLessThanOrEqual(PRESIGN_MAX_SECONDS);
    expect(reviewLifetimeSeconds(LARGEST_REVIEW_PAGES + 1).url).toBeGreaterThan(PRESIGN_MAX_SECONDS);
  });

  it("configures the tonal and bilevel presets", () => {
    expect(Object.keys(RUN_PRESETS.byOutputClass).sort()).toEqual(["bilevel", "tonal"]);
  });

  it.each(["tonal", "bilevel"] as const)(
    "gives the %s preset only keys and enumerated values the runner accepts",
    (outputClass) => {
      const preset = RUN_PRESETS.byOutputClass[outputClass]!;
      for (const stage of ["preprocess", "render"] as const) {
        for (const [key, value] of Object.entries(preset[stage])) {
          expect(RUN_PRESETS.acceptedKeys[stage]).toContain(key);
          const choices = RUNNER_CHOICES[stage][key];
          if (choices) expect(choices).toContain(value);
        }
      }
    },
  );
});

// @version v0.9.0
