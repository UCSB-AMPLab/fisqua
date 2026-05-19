/**
 * Tests — resolve QC flag dialog gate
 *
 * This suite pins the pure predicate `isValidResolve` that gates the
 * Confirm button on the resolve-QC-flag dialog. The gate refuses
 * submit unless: a target `status` is picked, a `resolutionAction`
 * is picked, and — when the action is `other` — a non-whitespace
 * `resolverNote` was supplied. The "other" branch is the only one
 * that requires a free-text note because the four canonical actions
 * (`fixed`, `wontfix`, `duplicate`, `retake_requested`) are
 * self-describing; `other` would otherwise close the flag without
 * any explanation in the audit trail.
 *
 * No React rendering — the predicate is a boolean over three
 * scalar inputs and the truth table is what this file pins. Same
 * Workers-pool / pure-function pattern as the rest of
 * `tests/components/*.test.tsx`.
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import { isValidResolve } from "../../app/components/qc-flags/resolve-qc-flag-dialog";

describe("isValidResolve", () => {
  it("returns false when status is null", () => {
    expect(isValidResolve(null, "retake_requested", "")).toBe(false);
  });

  it("returns false when resolutionAction is null", () => {
    expect(isValidResolve("resolved", null, "")).toBe(false);
  });

  it("returns false when action='other' and resolverNote is empty", () => {
    expect(isValidResolve("resolved", "other", "")).toBe(false);
  });

  it("returns false when action='other' and resolverNote is only whitespace", () => {
    expect(isValidResolve("resolved", "other", "   \t  \n")).toBe(false);
  });

  it("returns true when action='other' and resolverNote has non-whitespace text", () => {
    expect(
      isValidResolve("resolved", "other", "Duplicate of previous fol.")
    ).toBe(true);
  });

  it("returns true when action='retake_requested' regardless of note", () => {
    expect(isValidResolve("resolved", "retake_requested", "")).toBe(true);
    expect(isValidResolve("resolved", "retake_requested", "context")).toBe(
      true
    );
  });

  it("returns true when action='reordered' with empty note", () => {
    expect(isValidResolve("resolved", "reordered", "")).toBe(true);
  });

  it("returns true when action='marked_duplicate' with empty note", () => {
    expect(isValidResolve("resolved", "marked_duplicate", "")).toBe(true);
  });

  it("returns true when action='ignored' with empty note", () => {
    expect(isValidResolve("wontfix", "ignored", "")).toBe(true);
  });

  it("accepts status='wontfix' for every non-'other' action", () => {
    expect(isValidResolve("wontfix", "retake_requested", "")).toBe(true);
    expect(isValidResolve("wontfix", "reordered", "")).toBe(true);
    expect(isValidResolve("wontfix", "marked_duplicate", "")).toBe(true);
    expect(isValidResolve("wontfix", "ignored", "")).toBe(true);
  });

  it("requires the note even when status='wontfix' and action='other'", () => {
    expect(isValidResolve("wontfix", "other", "")).toBe(false);
    expect(isValidResolve("wontfix", "other", "reason")).toBe(true);
  });
});

