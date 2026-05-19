/**
 * Tests — flag badge predicate
 *
 * This suite pins the pure predicate `shouldRenderFlagBadge` that
 * decides whether the QC-flag-count badge appears on a description
 * card or outline row. The contract: any positive integer renders
 * the badge (NO `count > 1` gate — even a single flag should
 * surface), zero hides it, and defensive cases (negative, NaN —
 * symptoms of a loader bug) hide it rather than rendering garbage.
 *
 * No React rendering, no jsdom — the predicate is a single boolean
 * and the truth table is what this file pins. Pure-function pattern
 * shared across the `tests/components/*.test.tsx` suite under the
 * Workers pool.
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import { shouldRenderFlagBadge } from "../../app/components/viewer/flag-badge";

describe("shouldRenderFlagBadge", () => {
  it("returns false for count === 0 -- hides the badge on zero", () => {
    expect(shouldRenderFlagBadge(0)).toBe(false);
  });

  it("returns true for count === 1 -- NO 'count > 1' gate allowed", () => {
    expect(shouldRenderFlagBadge(1)).toBe(true);
  });

  it("returns true for count === 5", () => {
    expect(shouldRenderFlagBadge(5)).toBe(true);
  });

  it("returns true for count === 42 (no upper bound)", () => {
    expect(shouldRenderFlagBadge(42)).toBe(true);
  });

  it("returns false defensively for a negative count (loader bug)", () => {
    expect(shouldRenderFlagBadge(-1)).toBe(false);
  });

  it("returns false defensively for NaN (loader bug)", () => {
    expect(shouldRenderFlagBadge(NaN)).toBe(false);
  });

  it("returns false defensively for Infinity (loader bug)", () => {
    expect(shouldRenderFlagBadge(Infinity)).toBe(false);
  });
});

