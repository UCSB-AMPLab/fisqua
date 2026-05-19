/**
 * Tests — QC flag card resolve gate
 *
 * This suite pins the pure predicate `shouldForwardResolve` that
 * gates the "Resolve" affordance on an expandable QC-flag card.
 * The gate is two-dimensional: the viewer must be a `lead` (only
 * leads close flags — cataloguer and reviewer roles see the
 * card without the resolve action), AND the flag must be in
 * `open` status (re-resolving a resolved or wontfix flag is a
 * no-op, so the affordance hides).
 *
 * No React rendering — the predicate is a boolean over
 * `(role, status)` and the truth table is what this file pins.
 * Same Workers-pool / pure-function pattern as the rest of
 * `tests/components/*.test.tsx`.
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import { shouldForwardResolve } from "../../app/components/qc-flags/qc-flag-card-expandable";

describe("shouldForwardResolve", () => {
  it("returns true for lead + open -- + happy path", () => {
    expect(shouldForwardResolve("lead", "open")).toBe(true);
  });

  it("returns false for lead + resolved -- open-only", () => {
    expect(shouldForwardResolve("lead", "resolved")).toBe(false);
  });

  it("returns false for lead + wontfix -- open-only", () => {
    expect(shouldForwardResolve("lead", "wontfix")).toBe(false);
  });

  it("returns false for cataloguer + open -- lead-only", () => {
    expect(shouldForwardResolve("cataloguer", "open")).toBe(false);
  });

  it("returns false for reviewer + open -- lead-only", () => {
    expect(shouldForwardResolve("reviewer", "open")).toBe(false);
  });

  it("returns false for cataloguer + resolved", () => {
    expect(shouldForwardResolve("cataloguer", "resolved")).toBe(false);
  });

  it("returns false for reviewer + wontfix", () => {
    expect(shouldForwardResolve("reviewer", "wontfix")).toBe(false);
  });
});

