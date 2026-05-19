/**
 * Tests — save-status pure helpers
 *
 * This suite is the pure-function regression guard for the four-state
 * save-status indicator. An earlier bug had two states (`saving` and `unsaved`)
 * mapping to the same Tailwind class (`bg-saffron`); the four-
 * distinct-classes assertion in this file is the regression net that
 * catches a future merge of any two states.
 *
 * No React rendering. No `@testing-library/react` import. Imports the
 * pure `statusColorClass` and `shouldShowRetryAffordance` helpers from
 * the shared component module and asserts on their return values
 * directly, mirroring the existing `tests/components/*.test.tsx`
 * pattern (`flag-badge.test.tsx`, `outline-entry.test.tsx`).
 *
 * @version v0.4.1
 */
import { describe, it, expect } from "vitest";
import {
  statusColorClass,
  shouldShowRetryAffordance,
  type SaveStatusValue,
} from "../../app/components/viewer/save-status";

const ALL_STATES: SaveStatusValue[] = ["saved", "saving", "unsaved", "error"];

describe("statusColorClass", () => {
  it("returns the verdigris class for saved", () => {
    expect(statusColorClass("saved")).toBe("bg-verdigris");
  });

  it("returns the stone class for saving (distinct from saffron and verdigris)", () => {
    const cls = statusColorClass("saving");
    expect(cls).toBe("bg-stone-400");
    expect(cls).not.toBe(statusColorClass("unsaved"));
    expect(cls).not.toBe(statusColorClass("saved"));
  });

  it("returns the saffron class for unsaved", () => {
    expect(statusColorClass("unsaved")).toBe("bg-saffron");
  });

  it("returns the madder class for error (distinct from saffron, verdigris, stone)", () => {
    const cls = statusColorClass("error");
    expect(cls).toBe("bg-madder");
    expect(cls).not.toBe(statusColorClass("saved"));
    expect(cls).not.toBe(statusColorClass("saving"));
    expect(cls).not.toBe(statusColorClass("unsaved"));
  });

  it("all four states map to distinct colour classes (B2 regression)", () => {
    // The original B2 bug was `saving` and `unsaved` both mapping to
    // `bg-saffron`. A Set of all four return values must have size 4
    // for the indicator to be visually unambiguous.
    const classes = new Set(ALL_STATES.map(statusColorClass));
    expect(classes.size).toBe(4);
  });

  it("returns a non-empty Tailwind class for every member of the union", () => {
    // Exhaustiveness guard: if a future state is added to the
    // SaveStatusValue union without a matching switch arm, this loop
    // would surface an undefined/empty return.
    for (const s of ALL_STATES) {
      const cls = statusColorClass(s);
      expect(typeof cls).toBe("string");
      expect(cls.length).toBeGreaterThan(0);
    }
  });
});

describe("shouldShowRetryAffordance", () => {
  it("returns true only for the error state", () => {
    expect(shouldShowRetryAffordance("error")).toBe(true);
  });

  it("returns false for saved", () => {
    expect(shouldShowRetryAffordance("saved")).toBe(false);
  });

  it("returns false for saving", () => {
    expect(shouldShowRetryAffordance("saving")).toBe(false);
  });

  it("returns false for unsaved", () => {
    expect(shouldShowRetryAffordance("unsaved")).toBe(false);
  });

  it("exactly one of the four states surfaces the retry affordance", () => {
    const showing = ALL_STATES.filter(shouldShowRetryAffordance);
    expect(showing).toEqual(["error"]);
  });
});

/* @version v0.4.1 */
