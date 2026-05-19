/**
 * Tests — navigation blocker predicate
 *
 * This suite is the pure-helper regression net for `shouldBlockNavigation`, the function React
 * Router 7's `useBlocker` callback in both editor routes consults to
 * decide whether to interrupt an outgoing navigation with a confirm
 * dialog when unsaved changes would be lost.
 *
 * No RTL, no jsdom, no router stub — the predicate is a pair of
 * boolean comparisons, and the test surface is the truth table.
 *
 * @version v0.4.1
 */
import { describe, it, expect } from "vitest";
import { shouldBlockNavigation } from "../../app/lib/blocker-condition";

describe("shouldBlockNavigation", () => {
  it("blocks while saving even with no unsaved edits", () => {
    expect(shouldBlockNavigation("saving", false)).toBe(true);
  });

  it("blocks while in error state even with no unsaved edits", () => {
    expect(shouldBlockNavigation("error", false)).toBe(true);
  });

  it("blocks while dirty even if the pill still reads saved", () => {
    // This is the genuine race between an optimistic edit and the
    // 1.5 s debounce: the user has typed, hasUnsaved is true, but
    // saveStatus has not yet flipped from "saved" to "unsaved".
    // The predicate must still block.
    expect(shouldBlockNavigation("saved", true)).toBe(true);
  });

  it("blocks while dirty AND a save is in flight", () => {
    expect(shouldBlockNavigation("saving", true)).toBe(true);
  });

  it("does not block on saved + clean", () => {
    expect(shouldBlockNavigation("saved", false)).toBe(false);
  });

  it("does not block on unsaved status alone without hasUnsaved", () => {
    // Defensive: this state combination should not occur in practice
    // (the unsaved pill implies the hasUnsaved flag is true), but the
    // predicate's contract is to be driven by hasUnsaved for the
    // dirty case — not by the pill state alone — so this stays
    // documented as a non-blocking input.
    expect(shouldBlockNavigation("unsaved", false)).toBe(false);
  });
});

/* @version v0.4.1 */
