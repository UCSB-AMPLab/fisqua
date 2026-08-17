/**
 * Tests — region chip i18n + class helpers
 *
 * This suite pins the two pure helpers that back the region-chip
 * display: `computeChipLabelArgs` (builds the `t(...)` invocation
 * shape — key + vars) and `computeChipClassName` (the Tailwind class
 * composition that carries the chip's status variant). The label key
 * lives in the registered `viewer` namespace
 * (`viewer:regions.chip_label`, "Región · p. {{page}}" with the
 * U+00B7 middle dot); the old Spanish `defaultValue` is gone — a
 * prose defaultValue is how a missing key hides in one language, and
 * the i18n-keys guard now bans the pattern outright.
 *
 * No React rendering — the helpers are pure functions returning
 * scalars or struct args, and the i18n contract (key + vars) is
 * exactly what's pinned here so a future refactor cannot silently
 * change the page interpolation contract.
 *
 * @version v0.7.0
 */
import { describe, it, expect } from "vitest";
import {
  computeChipLabelArgs,
  computeChipClassName,
} from "../../app/components/comments/region-chip";

describe("computeChipLabelArgs", () => {
  it("returns the registered 'viewer:regions.chip_label' key with the page interpolation var", () => {
    const args = computeChipLabelArgs(3);
    expect(args.key).toBe("viewer:regions.chip_label");
    expect(args.vars).toEqual({ page: 3 });
  });

  it("carries no defaultValue — the key resolves from the bundles in both languages", () => {
    const args = computeChipLabelArgs(7);
    expect("defaultValue" in args).toBe(false);
  });

  it("uses the raw pageNumber for the page var (no conversion)", () => {
    expect(computeChipLabelArgs(1).vars.page).toBe(1);
    expect(computeChipLabelArgs(42).vars.page).toBe(42);
  });
});

describe("computeChipClassName", () => {
  it("uses stone-100 background and stone-200 border tokens", () => {
    const cls = computeChipClassName();
    expect(cls).toContain("bg-stone-100");
    expect(cls).toContain("border-stone-200");
  });

  it("uses stone-600 text at sans 10px bold --,", () => {
    const cls = computeChipClassName();
    expect(cls).toContain("text-stone-600");
    expect(cls).toContain("text-10");
    expect(cls).toContain("font-bold");
    expect(cls).toContain("font-sans");
  });

  it("renders as an inline-flex with gap-1 and small padding", () => {
    const cls = computeChipClassName();
    expect(cls).toContain("inline-flex");
    expect(cls).toContain("items-center");
    expect(cls).toContain("gap-1");
    expect(cls).toContain("px-2");
    expect(cls).toContain("py-1");
    expect(cls).toContain("rounded");
  });

  it("includes a focus ring tied to the indigo accent --", () => {
    const cls = computeChipClassName();
    expect(cls).toContain("focus:ring-indigo/40");
  });
});

