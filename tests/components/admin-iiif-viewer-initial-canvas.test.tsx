/**
 * Tests — the admin viewer opens at a given page
 *
 * This suite covers the two pure helpers behind the admin IIIF viewer's
 * `initialCanvas` prop: `parsePageParam`, which reads the description
 * page's `?page=` value as a 1-based canvas number or nothing, and
 * `initialCanvasIndex`, which turns that number into the canvas the
 * viewer shows once the manifest has loaded. A number past the last
 * canvas opens the last one; no number opens the first.
 *
 * No React rendering, no jsdom: the viewer sets its page from
 * `initialCanvasIndex` when the manifest loads, so the helper's result
 * is the page indicator's value.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import {
  initialCanvasIndex,
  parsePageParam,
} from "../../app/components/descriptions/admin-iiif-viewer";

describe("initialCanvasIndex", () => {
  it("opens the third canvas of three at initialCanvas 3", () => {
    expect(initialCanvasIndex(3, 3)).toBe(2);
  });

  it("clamps a canvas past the end to the last canvas", () => {
    expect(initialCanvasIndex(99, 3)).toBe(2);
  });

  it("starts at the first canvas with no initialCanvas", () => {
    expect(initialCanvasIndex(undefined, 3)).toBe(0);
  });

  it("starts at the first canvas for zero, negative or non-finite values", () => {
    expect(initialCanvasIndex(0, 3)).toBe(0);
    expect(initialCanvasIndex(-4, 3)).toBe(0);
    expect(initialCanvasIndex(Number.NaN, 3)).toBe(0);
  });

  it("returns 0 for an empty manifest", () => {
    expect(initialCanvasIndex(5, 0)).toBe(0);
  });
});

describe("parsePageParam", () => {
  it("reads a positive integer", () => {
    expect(parsePageParam("3")).toBe(3);
  });

  it("ignores a missing, empty, zero, negative or non-numeric value", () => {
    expect(parsePageParam(null)).toBeUndefined();
    expect(parsePageParam("")).toBeUndefined();
    expect(parsePageParam("0")).toBeUndefined();
    expect(parsePageParam("-2")).toBeUndefined();
    expect(parsePageParam("abc")).toBeUndefined();
    expect(parsePageParam("2.5")).toBeUndefined();
  });
});
