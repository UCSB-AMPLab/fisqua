/**
 * Tests — media pipeline job grouping
 *
 * Fisqua decides which volumes share a runner job when it writes a run
 * spec, so a collection of very small volumes does not pay a job's
 * start-up cost once per two-image volume. This suite pins the rule:
 * volumes in reference-code order are packed into a job until its image
 * count reaches the target; a volume at or above the target gets a job
 * of its own; every volume lands in exactly one job; job indices run
 * from 0 without gaps.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { groupJobs, type GroupableVolume } from "../../app/lib/pipeline/grouping";

function vol(id: string, referenceCode: string, expectedCount: number): GroupableVolume {
  return { id, referenceCode, expectedCount };
}

function everyVolumeOnce(volumes: GroupableVolume[], jobs: { volume_ids: string[] }[]) {
  const placed = jobs.flatMap((j) => j.volume_ids);
  expect(placed.slice().sort()).toEqual(volumes.map((v) => v.id).sort());
  expect(new Set(placed).size).toBe(placed.length);
}

describe("job grouping", () => {
  it("packs small volumes together and gives a large one a job of its own", () => {
    const volumes = [
      vol("a", "co-x-001", 2),
      vol("big", "co-x-004", 900),
      vol("b", "co-x-002", 2),
      vol("c", "co-x-003", 2),
    ];
    const jobs = groupJobs(volumes, 734);
    expect(jobs).toEqual([
      { job_index: 0, volume_ids: ["a", "b", "c"] },
      { job_index: 1, volume_ids: ["big"] },
    ]);
    everyVolumeOnce(volumes, jobs);
  });

  it("closes the open job before a volume at or above the target", () => {
    const volumes = [vol("a", "a", 10), vol("b", "b", 734), vol("c", "c", 10)];
    const jobs = groupJobs(volumes, 734);
    expect(jobs.map((j) => j.volume_ids)).toEqual([["a"], ["b"], ["c"]]);
  });

  it("closes a job once its image count reaches the target", () => {
    const volumes = [vol("a", "a", 400), vol("b", "b", 400), vol("c", "c", 10)];
    expect(groupJobs(volumes, 734).map((j) => j.volume_ids)).toEqual([["a", "b"], ["c"]]);
  });

  it("orders volumes by reference code before packing", () => {
    const volumes = [vol("z", "co-b", 1), vol("y", "co-a", 1)];
    expect(groupJobs(volumes, 734)[0].volume_ids).toEqual(["y", "z"]);
  });

  it("puts 14,211 two-image volumes into 39 contiguous jobs", () => {
    const volumes = Array.from({ length: 14_211 }, (_, i) =>
      vol(`v${i}`, `pe-bn-cdip-${String(i).padStart(5, "0")}`, 2),
    );
    const jobs = groupJobs(volumes, 734);
    expect(jobs).toHaveLength(39);
    expect(jobs.map((j) => j.job_index)).toEqual(Array.from({ length: 39 }, (_, i) => i));
    everyVolumeOnce(volumes, jobs);
  });

  it("returns no jobs for no volumes", () => {
    expect(groupJobs([], 734)).toEqual([]);
  });
});

// @version v0.8.0
