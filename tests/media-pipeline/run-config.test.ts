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
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_RUN_CONFIG } from "../../app/lib/pipeline/dispatch.server";
import { groupJobs } from "../../app/lib/pipeline/grouping";
import { RUN_LIFETIME_CONSTANTS, RUN_LIMITS, RUN_PRESETS } from "../../app/lib/pipeline/run-config";
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

describe("run configuration", () => {
  it("is set, and built from the run configuration module", () => {
    expect(DEFAULT_RUN_CONFIG).not.toBeNull();
    expect(DEFAULT_RUN_CONFIG).toMatchObject({ ...RUN_LIMITS, lifetime: RUN_LIFETIME_CONSTANTS, presets: RUN_PRESETS });
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
