/**
 * Tests — enum drift guard
 *
 * This suite is the structural backstop for the bug class behind the
 * `test_images` autosave hang: an enum value that is settable in the UI
 * and valid in the DB schema, yet rejected by a hand-copied validator
 * literal that drifted from the schema. The fix hoisted every such
 * vocabulary into `app/lib/validation/enums.ts` as the single source of
 * truth, consumed by the Drizzle column hint, the Zod validators, and
 * the derived TypeScript types.
 *
 * These assertions pin each Drizzle enum column's `enumValues` to (a) the
 * canonical constant it must equal and (b) an explicit expected set. (a)
 * fails if anyone reintroduces a divergent literal in the schema; (b)
 * fails if anyone edits the canonical constant without updating this
 * checkpoint — forcing a deliberate review rather than a silent change.
 * Because the validators now reference the same constants directly, a
 * passing schema↔constant assertion means the validator cannot reject a
 * value the schema accepts.
 *
 * Scope note: `resegmentationFlags.problemType` is intentionally NOT
 * pinned here — it has no second app-level allow-list to drift against
 * (the create route trusts the value and the DB enum is the sole gate),
 * so it was deliberately left out of the hoist.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import {
  tenants,
  projectMembers,
  entries,
  qcFlags,
  comments,
  places,
  volumes,
  pipelineRecipeDeclarations,
  pipelineVolumes,
  pipelineRuns,
  pipelineRunChunks,
  pipelineRunVolumes,
  pipelineReviewItems,
  pipelinePublications,
  captureDeliveries,
  captureQcSets,
  captureQcDecisions,
  captureQcRotations,
  captureReviewRuns,
} from "../../app/db/schema";
import {
  ENTRY_TYPES,
  RESOURCE_TYPES_ES,
  PROJECT_ROLES,
  COMMENT_AUTHOR_ROLES,
  DESCRIPTIVE_STANDARDS,
  QC_PROBLEM_TYPES,
  QC_RESOLUTION_ACTIONS,
  GEONAMES_FCLASSES,
  VOLUME_STATUSES,
  PIPELINE_RUN_KINDS,
  PIPELINE_LEDGER_RUN_KINDS,
  PIPELINE_RUN_PURPOSES,
  PIPELINE_RUN_STATUSES,
  PIPELINE_ACTIVE_RUN_STATUSES,
  PIPELINE_RUN_CHUNK_STATUSES,
  PIPELINE_VOLUME_STATES,
  PIPELINE_RUN_VOLUME_STATUSES,
  PIPELINE_OUTPUT_CLASSES,
  PIPELINE_PLATENS,
  PIPELINE_BACKGROUNDS,
  PIPELINE_STAGES,
  PIPELINE_VERDICTS,
  PIPELINE_RUNNER_ERROR_CLASSES,
  PIPELINE_SYSTEMIC_ERROR_CLASSES,
  PIPELINE_FISQUA_ERROR_CLASSES,
  PIPELINE_PAGE_KEY_PATTERN,
  PIPELINE_PUBLICATION_STATUSES,
  PIPELINE_RETIREMENT_STATUSES,
  CAPTURE_DELIVERY_ROUTES,
  CAPTURE_DELIVERY_STATES,
  CAPTURE_IMAGE_ROLES,
  CAPTURE_QC_DECISIONS,
  CAPTURE_QC_REASONS,
  CAPTURE_QC_SET_STATES,
  CAPTURE_QC_SIDES,
  CAPTURE_QC_STATES,
  CAPTURE_REVIEW_RUN_STATUSES,
  CAPTURE_REVIEW_PURGE_STATUSES,
} from "../../app/lib/validation/enums";

const sorted = (xs: readonly string[]) => [...xs].sort();

// [schema column .enumValues, canonical constant, explicit expected set]
const CASES: [string, readonly string[], readonly string[], readonly string[]][] = [
  ["entries.type", entries.type.enumValues, ENTRY_TYPES,
    ["item", "blank", "front_matter", "back_matter", "test_images"]],
  ["entries.resourceType", entries.resourceType.enumValues, RESOURCE_TYPES_ES,
    ["texto", "imagen", "cartografico", "mixto"]],
  ["projectMembers.role", projectMembers.role.enumValues, PROJECT_ROLES,
    ["lead", "cataloguer", "reviewer"]],
  ["comments.authorRole", comments.authorRole.enumValues, COMMENT_AUTHOR_ROLES,
    ["lead", "cataloguer", "reviewer", "admin"]],
  ["tenants.descriptiveStandard", tenants.descriptiveStandard.enumValues, DESCRIPTIVE_STANDARDS,
    ["isadg", "dacs", "rad"]],
  ["qcFlags.problemType", qcFlags.problemType.enumValues, QC_PROBLEM_TYPES,
    ["damaged", "repeated", "out_of_order", "missing", "blank", "other"]],
  ["qcFlags.resolutionAction", qcFlags.resolutionAction.enumValues, QC_RESOLUTION_ACTIONS,
    ["retake_requested", "reordered", "marked_duplicate", "ignored", "other"]],
  ["places.fclass", places.fclass.enumValues, GEONAMES_FCLASSES,
    ["P", "H", "A", "T", "S"]],
  ["volumes.status", volumes.status.enumValues, VOLUME_STATUSES,
    ["unstarted", "in_progress", "segmented", "sent_back", "reviewed", "approved"]],
  ["pipelineRecipeDeclarations.platen", pipelineRecipeDeclarations.platen.enumValues,
    PIPELINE_PLATENS, ["v", "none"]],
  ["pipelineRecipeDeclarations.background", pipelineRecipeDeclarations.background.enumValues,
    PIPELINE_BACKGROUNDS, ["dark", "light"]],
  ["pipelineRecipeDeclarations.outputClass", pipelineRecipeDeclarations.outputClass.enumValues,
    PIPELINE_OUTPUT_CLASSES, ["tonal", "bilevel"]],
  ["pipelineVolumes.kind", pipelineVolumes.kind.enumValues, PIPELINE_RUN_KINDS,
    ["volume_run", "item_pdf"]],
  ["pipelineVolumes.state", pipelineVolumes.state.enumValues, PIPELINE_VOLUME_STATES,
    ["received", "prepared", "ready", "published"]],
  ["pipelineRuns.kind", pipelineRuns.kind.enumValues, PIPELINE_LEDGER_RUN_KINDS,
    ["volume_run", "item_pdf", "review_run"]],
  ["pipelineRuns.purpose", pipelineRuns.purpose.enumValues, PIPELINE_RUN_PURPOSES,
    ["sample", "wave"]],
  ["pipelineRuns.status", pipelineRuns.status.enumValues, PIPELINE_RUN_STATUSES,
    ["pending", "dispatched", "running", "completed", "halted", "error", "cancelled"]],
  ["pipelineRunChunks.status", pipelineRunChunks.status.enumValues, PIPELINE_RUN_CHUNK_STATUSES,
    ["pending", "dispatched", "failed", "not_sent", "completed"]],
  ["pipelineRunVolumes.status", pipelineRunVolumes.status.enumValues, PIPELINE_RUN_VOLUME_STATUSES,
    ["dispatched", "prepared", "review_pending", "aborted", "halted"]],
  ["pipelineReviewItems.stage", pipelineReviewItems.stage.enumValues, PIPELINE_STAGES,
    ["preprocess", "render", "ocr", "tile"]],
  ["pipelineReviewItems.verdict", pipelineReviewItems.verdict.enumValues, PIPELINE_VERDICTS,
    ["accept", "amend", "accept_with_record"]],
  ["pipelinePublications.status", pipelinePublications.status.enumValues,
    PIPELINE_PUBLICATION_STATUSES, ["claimed", "copying", "published", "failed", "abandoned"]],
  ["pipelinePublications.retirementStatus", pipelinePublications.retirementStatus.enumValues,
    PIPELINE_RETIREMENT_STATUSES, ["none", "pending"]],
  ["captureDeliveries.state", captureDeliveries.state.enumValues,
    CAPTURE_DELIVERY_STATES, ["received", "registered", "refused", "superseded"]],
  ["captureDeliveries.route", captureDeliveries.route.enumValues,
    CAPTURE_DELIVERY_ROUTES, ["link", "file"]],
  ["captureQcSets.state", captureQcSets.state.enumValues,
    CAPTURE_QC_SET_STATES, ["in_capture_qc", "retakes_requested", "approved"]],
  ["captureQcDecisions.decision", captureQcDecisions.decision.enumValues,
    CAPTURE_QC_DECISIONS, ["approved", "rejected"]],
  ["captureQcDecisions.reason", captureQcDecisions.reason.enumValues,
    CAPTURE_QC_REASONS,
    ["blur", "glare", "shadow", "focus", "exposure", "dirt", "framing", "obstruction", "other"]],
  ["captureQcDecisions.side", captureQcDecisions.side.enumValues,
    CAPTURE_QC_SIDES, ["left", "right", "both"]],
  ["captureQcRotations.role", captureQcRotations.role.enumValues,
    CAPTURE_IMAGE_ROLES, ["left", "right", "single"]],
  ["captureReviewRuns.status", captureReviewRuns.status.enumValues,
    CAPTURE_REVIEW_RUN_STATUSES, ["dispatched", "review_ready", "aborted", "halted"]],
  ["captureReviewRuns.purgeStatus", captureReviewRuns.purgeStatus.enumValues,
    CAPTURE_REVIEW_PURGE_STATUSES, ["purged", "failed"]],
];

describe("capture QC vocabularies", () => {
  it("the states a decision set produces are capture QC states", () => {
    for (const s of CAPTURE_QC_SET_STATES) {
      expect(CAPTURE_QC_STATES as readonly string[]).toContain(s);
    }
  });
});

describe("enum drift guard (schema column === canonical constant)", () => {
  for (const [label, columnValues, constant, expected] of CASES) {
    it(`${label} matches its canonical constant and expected set`, () => {
      // Schema column and the validation constant agree.
      expect(sorted(columnValues)).toEqual(sorted(constant));
      // Both agree with the explicit checkpoint set.
      expect(sorted(constant)).toEqual(sorted(expected));
    });
  }
});

// The media pipeline vocabularies. The ones with a column of their own
// are pinned to it in CASES above; the rest (the active run statuses,
// the error classes) have no column and are pinned here alone, so an
// edit to any of them is deliberate.
const PIPELINE_CASES: [string, readonly string[], readonly string[]][] = [
  ["PIPELINE_RUN_KINDS", PIPELINE_RUN_KINDS, ["volume_run", "item_pdf"]],
  ["PIPELINE_RUN_PURPOSES", PIPELINE_RUN_PURPOSES, ["sample", "wave"]],
  ["PIPELINE_RUN_STATUSES", PIPELINE_RUN_STATUSES,
    ["pending", "dispatched", "running", "completed", "halted", "error", "cancelled"]],
  ["PIPELINE_ACTIVE_RUN_STATUSES", PIPELINE_ACTIVE_RUN_STATUSES,
    ["pending", "dispatched", "running"]],
  ["PIPELINE_RUN_CHUNK_STATUSES", PIPELINE_RUN_CHUNK_STATUSES,
    ["pending", "dispatched", "failed", "not_sent", "completed"]],
  ["PIPELINE_VOLUME_STATES", PIPELINE_VOLUME_STATES,
    ["received", "prepared", "ready", "published"]],
  ["PIPELINE_RUN_VOLUME_STATUSES", PIPELINE_RUN_VOLUME_STATUSES,
    ["dispatched", "prepared", "review_pending", "aborted", "halted"]],
  ["PIPELINE_OUTPUT_CLASSES", PIPELINE_OUTPUT_CLASSES, ["tonal", "bilevel"]],
  ["PIPELINE_PLATENS", PIPELINE_PLATENS, ["v", "none"]],
  ["PIPELINE_BACKGROUNDS", PIPELINE_BACKGROUNDS, ["dark", "light"]],
  ["PIPELINE_STAGES", PIPELINE_STAGES, ["preprocess", "render", "ocr", "tile"]],
  ["PIPELINE_VERDICTS", PIPELINE_VERDICTS, ["accept", "amend", "accept_with_record"]],
  ["PIPELINE_RUNNER_ERROR_CLASSES", PIPELINE_RUNNER_ERROR_CLASSES,
    ["image", "qc", "source_pull", "fixity", "spec", "destination", "auth", "internal"]],
  ["PIPELINE_SYSTEMIC_ERROR_CLASSES", PIPELINE_SYSTEMIC_ERROR_CLASSES,
    ["source_pull", "destination", "auth"]],
  ["PIPELINE_FISQUA_ERROR_CLASSES", PIPELINE_FISQUA_ERROR_CLASSES,
    ["token_expired", "dispatch", "max_review_frac", "unreported_halt"]],
];

describe("media pipeline vocabularies (constant === checkpoint)", () => {
  for (const [label, constant, expected] of PIPELINE_CASES) {
    it(`${label} matches its expected set`, () => {
      expect(sorted(constant)).toEqual(sorted(expected));
    });
  }

  it("the active run statuses are a subset of the run statuses", () => {
    for (const s of PIPELINE_ACTIVE_RUN_STATUSES) {
      expect(PIPELINE_RUN_STATUSES as readonly string[]).toContain(s);
    }
  });

  it("the systemic error classes are a subset of the runner error classes", () => {
    for (const c of PIPELINE_SYSTEMIC_ERROR_CLASSES) {
      expect(PIPELINE_RUNNER_ERROR_CLASSES as readonly string[]).toContain(c);
    }
  });

  it("the Fisqua error classes do not overlap the runner error classes", () => {
    for (const c of PIPELINE_FISQUA_ERROR_CLASSES) {
      expect(PIPELINE_RUNNER_ERROR_CLASSES as readonly string[]).not.toContain(c);
    }
  });

  it("the page key pattern is the agreed one", () => {
    expect(PIPELINE_PAGE_KEY_PATTERN.source).toBe("^[A-Za-z0-9_-][A-Za-z0-9._-]*$");
    expect(PIPELINE_PAGE_KEY_PATTERN.flags).toBe("");
  });

  it("the page key pattern accepts keys of the agreed form and refuses others", () => {
    for (const ok of ["0001", "f001r", "p_12-b", "a.b", "_x", "-x"]) {
      expect(PIPELINE_PAGE_KEY_PATTERN.test(ok)).toBe(true);
    }
    for (const bad of ["", ".hidden", "a/b", "../x", "a b", "páge", "a\nb"]) {
      expect(PIPELINE_PAGE_KEY_PATTERN.test(bad)).toBe(false);
    }
  });
});

