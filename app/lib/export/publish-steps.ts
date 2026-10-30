/**
 * Publish Step Count
 *
 * This module deals with the number of steps a publish run will mark
 * complete, which `api.publish` stores as the run's `total_steps` so
 * the progress panel can show how far the run has come. It has to
 * count exactly the steps `PublishExportWorkflow` records: five per
 * fonds (descriptions, children, mets, ead, dc) and the index when
 * descriptions are selected, one for each other selected type, and one
 * more for each link file (`entity_links.json`, `place_links.json`)
 * that entities and places bring with them. A link file may take
 * several workflow steps, but only its last one counts.
 *
 * Entities, places and their link files run only when the triggering
 * tenant has the authorities capability, under the same
 * `authoritiesEnabled` flag of the export scope that the workflow
 * reads, so without it none of the four is counted. The workflow's
 * load-config and finalize steps record nothing and are not counted.
 *
 * @version v0.8.0
 */

/** Steps per fonds: descriptions, children, mets, ead, dc. */
const PER_FONDS_STEP_COUNT = 5;
/** The descriptions:index step. */
const INDEX_STEPS = 1;
/** The types gated by the authorities capability; each also writes a link file. */
const AUTHORITY_TYPES = ["entities", "places"];

export function countPublishSteps(options: {
  selectedFonds: readonly string[];
  selectedTypes: readonly string[];
  authoritiesEnabled: boolean;
}): number {
  const { selectedFonds, selectedTypes, authoritiesEnabled } = options;
  const runs = (t: string) => authoritiesEnabled || !AUTHORITY_TYPES.includes(t);
  const descriptionSteps = selectedTypes.includes("descriptions")
    ? selectedFonds.length * PER_FONDS_STEP_COUNT + INDEX_STEPS
    : 0;
  const nonDescTypes = selectedTypes.filter((t) => t !== "descriptions" && runs(t));
  const linkFileSteps = selectedTypes.filter(
    (t) => AUTHORITY_TYPES.includes(t) && runs(t)
  ).length;
  return descriptionSteps + nonDescTypes.length + linkFileSteps;
}

// @version v0.8.0
