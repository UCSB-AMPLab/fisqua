/**
 * Publish Step Plan
 *
 * This module deals with the ordered list of the steps a publish run
 * will mark complete. `PublishExportWorkflow` runs its steps by walking
 * this list, the publish page's progress panel lists it before the
 * first step starts and ticks each step off as it completes, and
 * `api.publish` stores its length as the run's `total_steps`; all
 * three read the one function, so they cannot disagree. The plan holds
 * exactly the steps the workflow records: four per
 * fonds (descriptions, children, ead, dc) and the index when
 * descriptions are selected, one for each other selected type, and one
 * more for each link file (`entity_links.json`, `place_links.json`)
 * that entities and places bring with them. A link file may take
 * several workflow steps, but only its last one counts. Fisqua writes
 * no METS files: the site's engine writes them, and each description's
 * `mets_url` points there.
 *
 * Entities, places and their link files run only when the triggering
 * tenant has the authorities capability, under the same
 * `authoritiesEnabled` flag of the export scope that the workflow
 * reads, so without it none of the four is counted. The workflow's
 * load-config, institution and finalize steps record nothing and are
 * not counted; the institution step writes the federation's publisher
 * and vocabulary files on every publish.
 *
 * The order is the workflow's: descriptions of every fonds, the
 * descriptions index, then children, EAD3 and Dublin Core, each for
 * every fonds in turn, then repositories, entities, places and the
 * entity and place link files. A plan step's id is the workflow's step
 * name, except that a link file's steps share its name; `planStepIdOf`
 * maps a step name recorded in `export_runs.current_step` to its plan
 * step.
 *
 * `planLegacyPublishSteps` is the plan of the code that ran METS steps:
 * a METS step per fonds between children and EAD3, the same order and
 * counting otherwise. Only the progress panel reads it, to list the
 * runs that code recorded; the workflow walks the current plan alone.
 * That code's METS step names (`mets:<fonds>:<n>`) map to
 * `mets:<fonds>`.
 *
 * @version v0.9.0
 */

/** The kinds of step, one per artefact, in the order the workflow runs them. */
export const PUBLISH_STEP_KINDS = [
  "descriptions",
  "index",
  "children",
  "ead",
  "dc",
  "repositories",
  "entities",
  "places",
  "entity_links",
  "place_links",
] as const;

export type PublishStepKind = (typeof PUBLISH_STEP_KINDS)[number];

/** The kind of step only the legacy plan holds. */
export type LegacyPublishStepKind = "mets";

/** One step of the plan; `fonds` is set on the per-fonds kinds. */
export interface PublishPlanStep {
  id: string;
  kind: PublishStepKind | LegacyPublishStepKind;
  fonds?: string;
}

export interface PublishPlanOptions {
  selectedFonds: readonly string[];
  selectedTypes: readonly string[];
  authoritiesEnabled: boolean;
}

/** The per-fonds kinds after the index, in the order the workflow runs them. */
const PER_FONDS_AFTER_INDEX = ["children", "ead", "dc"] as const;
/** The same in the legacy plan. */
const LEGACY_PER_FONDS_AFTER_INDEX = ["children", "mets", "ead", "dc"] as const;

/** The link file each authority type writes. */
const LINK_FILES = [
  { type: "entities", kind: "entity_links" },
  { type: "places", kind: "place_links" },
] as const;

/** The ordered steps a publish run of these fonds and types marks complete. */
export function planPublishSteps(options: PublishPlanOptions): PublishPlanStep[] {
  return buildPlan(options, PER_FONDS_AFTER_INDEX);
}

/** The plan as it was when it held a METS step per fonds. */
export function planLegacyPublishSteps(options: PublishPlanOptions): PublishPlanStep[] {
  return buildPlan(options, LEGACY_PER_FONDS_AFTER_INDEX);
}

function buildPlan(
  options: PublishPlanOptions,
  perFondsAfterIndex: readonly PublishPlanStep["kind"][]
): PublishPlanStep[] {
  const { selectedFonds, selectedTypes, authoritiesEnabled } = options;
  const plan: PublishPlanStep[] = [];
  const perFonds = (kind: PublishPlanStep["kind"]) => {
    for (const fonds of selectedFonds) plan.push({ id: `${kind}:${fonds}`, kind, fonds });
  };
  if (selectedTypes.includes("descriptions")) {
    perFonds("descriptions");
    plan.push({ id: "descriptions:index", kind: "index" });
    for (const kind of perFondsAfterIndex) perFonds(kind);
  }
  if (selectedTypes.includes("repositories")) {
    plan.push({ id: "repositories", kind: "repositories" });
  }
  // Entities and places export the authority junctions; the workflow
  // runs them, and their link files, only with the capability.
  for (const type of ["entities", "places"] as const) {
    if (authoritiesEnabled && selectedTypes.includes(type)) plan.push({ id: type, kind: type });
  }
  for (const file of LINK_FILES) {
    if (authoritiesEnabled && selectedTypes.includes(file.type)) {
      plan.push({ id: file.kind, kind: file.kind });
    }
  }
  return plan;
}

/** The number of steps a publish run marks complete: the plan's length. */
export function countPublishSteps(options: PublishPlanOptions): number {
  return planPublishSteps(options).length;
}

/**
 * The plan step id of a workflow step name: `entity_links:<n>` and
 * `place_links:<n>` are the link file, a recorded METS batch
 * (`mets:<fonds>:<n>`) is `mets:<fonds>`; every other name is its own
 * id.
 */
export function planStepIdOf(stepName: string): string {
  const mets = /^(mets:.+):\d+$/.exec(stepName);
  if (mets) return mets[1];
  const link = /^(entity_links|place_links):\d+$/.exec(stepName);
  if (link) return link[1];
  return stepName;
}

// @version v0.9.0
