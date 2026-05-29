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
 * @version v0.4.1
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
} from "../../app/db/schema";
import {
  ENTRY_TYPES,
  RESOURCE_TYPES_ES,
  PROJECT_ROLES,
  DESCRIPTIVE_STANDARDS,
  QC_PROBLEM_TYPES,
  QC_RESOLUTION_ACTIONS,
  GEONAMES_FCLASSES,
  VOLUME_STATUSES,
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
  ["comments.authorRole", comments.authorRole.enumValues, PROJECT_ROLES,
    ["lead", "cataloguer", "reviewer"]],
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
];

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
