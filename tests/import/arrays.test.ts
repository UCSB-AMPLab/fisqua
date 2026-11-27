/**
 * Tests — appending to and measuring large arrays
 *
 * This suite pins `scripts/lib/arrays.ts`: `appendAll` keeps the order
 * `push(...items)` gives and returns the target, and `maxOf` gives what
 * `Math.max(...items)` gives, -Infinity for no items and NaN when any
 * item is NaN. Both take 500,000 items, more than a spread into one call
 * can pass.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { appendAll, maxOf } from "../../scripts/lib/arrays";

const LARGE = 500_000;

describe("appendAll", () => {
  it("appends in order and returns the target", () => {
    const target = ["a"];
    expect(appendAll(target, ["b", "c"])).toBe(target);
    expect(target).toEqual(["a", "b", "c"]);
    expect(appendAll(target, new Set(["d"]))).toEqual(["a", "b", "c", "d"]);
  });

  it("appends more items than a spread can pass", () => {
    const items = Array.from({ length: LARGE }, (_, i) => i);
    expect(() => [0].push(...items)).toThrow(RangeError);
    const target = appendAll([-1], items);
    expect(target.length).toBe(LARGE + 1);
    expect(target[LARGE]).toBe(LARGE - 1);
  });
});

describe("maxOf", () => {
  it("gives what Math.max gives", () => {
    expect(maxOf([])).toBe(Math.max());
    expect(maxOf([3, 9, 1])).toBe(9);
    expect(maxOf([0, -4])).toBe(0);
    expect(maxOf([1, NaN, 2])).toBeNaN();
    expect(Object.is(maxOf([-0, +0]), Math.max(-0, +0))).toBe(true);
    expect(Object.is(maxOf([+0, -0]), Math.max(+0, -0))).toBe(true);
  });

  it("takes more items than a spread can pass", () => {
    const items = Array.from({ length: LARGE }, (_, i) => i);
    expect(maxOf(items)).toBe(LARGE - 1);
  });
});

// @version v0.9.0
