/**
 * Tests — comment card region chip
 *
 * This suite pins the pure predicate `shouldRenderRegionChip` that
 * the comment-card component consults to decide whether to show the
 * small region-pin chip (e.g. "p. 12, region") next to a comment
 * body. The chip only renders when both a `pageId` is present (the
 * comment is anchored to a specific page) AND the loader resolved
 * the page to a human-readable `pageNumber`; missing either side
 * suppresses the chip entirely rather than rendering a half-broken
 * label like "p. ?, region".
 *
 * No React rendering — the helper is a pure boolean over
 * `(comment, pageNumber)` and the truth table is what this file
 * pins. The pattern mirrors `flag-badge.test.tsx` and the wider
 * `tests/components/*.test.tsx` convention of pure-function tests
 * under the Workers pool.
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import { shouldRenderRegionChip } from "../../app/components/comments/comment-card";

type PartialComment = {
  regionX: number | null;
  regionY: number | null;
  pageId: string | null;
};

const region = (overrides: Partial<PartialComment> = {}): PartialComment => ({
  regionX: 0.5,
  regionY: 0.5,
  pageId: "page-1",
  ...overrides,
});

describe("shouldRenderRegionChip", () => {
  it("returns false when pageNumber is undefined -- no label possible", () => {
    expect(shouldRenderRegionChip(region(), undefined)).toBe(false);
  });

  it("returns false when pageId is null -- not a page-anchored comment", () => {
    expect(shouldRenderRegionChip(region({ pageId: null }), 3)).toBe(false);
  });

  it("returns false when regionX is null -- comment is page-anchored but not region", () => {
    expect(shouldRenderRegionChip(region({ regionX: null }), 3)).toBe(false);
  });

  it("returns false when regionY is null -- point pin requires both X and Y", () => {
    expect(shouldRenderRegionChip(region({ regionY: null }), 3)).toBe(false);
  });

  it("returns true when region coords + pageId + pageNumber are all set --", () => {
    expect(shouldRenderRegionChip(region(), 3)).toBe(true);
  });

  it("accepts zero-valued region coords (top-left corner, not null)", () => {
    expect(
      shouldRenderRegionChip(region({ regionX: 0, regionY: 0 }), 1),
    ).toBe(true);
  });

  it("accepts pageNumber = 1 (no off-by-one gotcha)", () => {
    expect(shouldRenderRegionChip(region(), 1)).toBe(true);
  });

  it("returns false when pageNumber is null (explicit null, not just undefined)", () => {
    // @ts-expect-error -- defensive branch for runtime-only null values
    expect(shouldRenderRegionChip(region(), null)).toBe(false);
  });
});

