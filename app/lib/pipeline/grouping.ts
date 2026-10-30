/**
 * Media Pipeline — Job Grouping
 *
 * This module deals with which volumes of a run share a runner job.
 * Each job pays a start-up cost (pulling the image, starting the
 * runner), so a collection of very small volumes — two images each is
 * common — would spend most of its time starting jobs if each volume
 * had its own. Fisqua groups volumes when it writes the run spec, and
 * the runner executes the grouping as given.
 *
 * `groupJobs(volumes, targetImagesPerJob)` sorts the volumes by
 * reference code, then packs them in that order into a job until the
 * job's summed expected image count reaches the target. A volume whose
 * own count is at or above the target closes the open job and gets a
 * job to itself. Every volume lands in exactly one job, and job indices
 * run from 0 without gaps. The function is pure; the target is a
 * deployment constant the caller passes in.
 *
 * @version v0.8.0
 */

export interface GroupableVolume {
  id: string;
  referenceCode: string;
  expectedCount: number;
}

export interface GroupedJob {
  job_index: number;
  volume_ids: string[];
}

export function groupJobs(volumes: GroupableVolume[], targetImagesPerJob: number): GroupedJob[] {
  const ordered = [...volumes].sort((a, b) =>
    a.referenceCode < b.referenceCode ? -1 : a.referenceCode > b.referenceCode ? 1 : 0,
  );
  const groups: string[][] = [];
  let open: string[] = [];
  let openCount = 0;
  const close = () => {
    if (open.length > 0) groups.push(open);
    open = [];
    openCount = 0;
  };
  for (const v of ordered) {
    if (v.expectedCount >= targetImagesPerJob) {
      close();
      groups.push([v.id]);
      continue;
    }
    open.push(v.id);
    openCount += v.expectedCount;
    if (openCount >= targetImagesPerJob) close();
  }
  close();
  return groups.map((volume_ids, job_index) => ({ job_index, volume_ids }));
}

// @version v0.8.0
