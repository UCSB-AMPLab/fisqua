/**
 * Tests — the skip reasons on the digitization queue
 *
 * This suite pins the list of reasons a Captua unit gives for skipping a
 * queue item, as Captua's code defines them, and checks that every one
 * has words in both locales under `dqueue.skip_reason`. A value outside
 * the list is not a known reason, so the screen shows it as received.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { SKIP_REASONS, knownSkipReason } from "../../app/lib/capture/queue";
import enCapture from "../../app/locales/en/capture";
import esCapture from "../../app/locales/es/capture";

const CAPTUA_REASONS = [
  "item_not_an_object", "missing_reference_code", "invalid_reference_code",
  "reference_code_padded", "reference_code_duplicated_in_list", "missing_filename_stem",
  "filename_stem_not_a_slug", "filename_stem_too_long", "filename_stem_differs_from_reference_code",
  "filename_stem_duplicated_in_list", "missing_title", "invalid_title", "invalid_dates",
  "end_date_before_start", "invalid_sequence", "invalid_assignee", "invalid_retakes",
  "reference_code_on_unit", "filename_stem_on_unit", "filename_stem_is_project_directory",
  "filename_stem_directory_occupied", "filename_stem_held_offsite", "kept_on_unit",
  "withdrawn_not_on_unit", "list_name_refused", "mode_changed", "refused_by_database",
  "reference_code_reserved", "filename_stem_reserved", "title_reserved", "testing_space_refused",
];

describe("skip reasons", () => {
  it("knows every reason Captua sends", () => {
    expect([...SKIP_REASONS].sort()).toEqual([...CAPTUA_REASONS].sort());
  });

  it("reads a known code as itself", () => {
    expect(knownSkipReason("kept_on_unit")).toBe("kept_on_unit");
  });

  it("does not take anything else for a known code", () => {
    expect(knownSkipReason("Kept_on_unit")).toBeNull();
    expect(knownSkipReason(" kept_on_unit")).toBeNull();
    expect(knownSkipReason("constructor")).toBeNull();
    expect(knownSkipReason("dqueue.state.skipped")).toBeNull();
    expect(knownSkipReason("")).toBeNull();
  });

  it("has words for every reason in English and Spanish", () => {
    const en = (enCapture as any).dqueue.skip_reason ?? {};
    const es = (esCapture as any).dqueue.skip_reason ?? {};
    for (const code of CAPTUA_REASONS) {
      expect(typeof en[code], `en ${code}`).toBe("string");
      expect(typeof es[code], `es ${code}`).toBe("string");
    }
    expect(Object.keys(en).sort()).toEqual([...CAPTUA_REASONS].sort());
    expect(Object.keys(es).sort()).toEqual([...CAPTUA_REASONS].sort());
  });
});

// @version v0.9.0
