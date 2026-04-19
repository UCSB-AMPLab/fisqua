/**
 * Tests — outline entryx
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import {
  shouldShowResegPill,
  computeCardClassName,
  shouldHideTitle,
  buildDeleteWarningLines,
} from "../../app/components/outline/outline-entry";
import type { ResegmentationCardFlag } from "../../app/components/outline/resegmentation-card";

describe("shouldShowResegPill", () => {
  it("returns false when openResegFlag is null -- pill hidden by default", () => {
    expect(shouldShowResegPill(null)).toBe(false);
  });

  it("returns false when openResegFlag is undefined", () => {
    expect(shouldShowResegPill(undefined)).toBe(false);
  });

  it("returns true when openResegFlag is supplied -- pill shown", () => {
    const flag: ResegmentationCardFlag = {
      id: "flag-1",
      reporterName: "Ada Lovelace",
      reportedAt: "2026-04-18T10:00:00Z",
      description: "Límites incorrectos en el folio 12.",
    };
    expect(shouldShowResegPill(flag)).toBe(true);
  });

  it("does not mutate the input", () => {
    const flag: ResegmentationCardFlag = {
      id: "flag-2",
      reporterName: "Grace Hopper",
      reportedAt: 1700000000000,
      description: "Faltan páginas.",
    };
    const before = JSON.stringify(flag);
    shouldShowResegPill(flag);
    expect(JSON.stringify(flag)).toBe(before);
  });
});

describe("computeCardClassName", () => {
  it("includes rounded-lg and border -- card pattern", () => {
    const cls = computeCardClassName({
      isReviewerModified: false,
      isHighlighted: false,
    });
    expect(cls).toContain("rounded-lg");
    expect(cls).toContain("border");
  });

  it("applies burgundy border on highlight -- accent", () => {
    const cls = computeCardClassName({
      isReviewerModified: false,
      isHighlighted: true,
    });
    expect(cls).toContain("border-[#8B2942]");
  });

  it("applies red border + bg on reviewer-modified state", () => {
    const cls = computeCardClassName({
      isReviewerModified: true,
      isHighlighted: false,
    });
    expect(cls).toContain("border-red-400");
    expect(cls).toContain("bg-red-50");
  });

  it("prefers reviewer-modified over highlight when both are true", () => {
    const cls = computeCardClassName({
      isReviewerModified: true,
      isHighlighted: true,
    });
    // Reviewer-modified red wins; the burgundy solid-border highlight
    // token does not appear (the hover token at /40 alpha is always
    // present regardless and is not a state indicator).
    expect(cls).toContain("border-red-400");
    const tokens = cls.split(/\s+/);
    expect(tokens).not.toContain("border-[#8B2942]");
  });

  it("defaults to stone-200 border when no state is active", () => {
    const cls = computeCardClassName({
      isReviewerModified: false,
      isHighlighted: false,
    });
    expect(cls).toContain("border-stone-200");
  });

  it("always includes the hover burgundy border token", () => {
    const cls = computeCardClassName({
      isReviewerModified: false,
      isHighlighted: false,
    });
    expect(cls).toContain("hover:border-[#8B2942]/40");
  });

  it("uses a white card background by default", () => {
    const cls = computeCardClassName({
      isReviewerModified: false,
      isHighlighted: false,
    });
    expect(cls).toContain("bg-white");
  });
});

describe("shouldHideTitle (post-Wave-2 header rule)", () => {
  it("hides null title", () => {
    expect(shouldHideTitle(null)).toBe(true);
  });
  it("hides undefined title", () => {
    expect(shouldHideTitle(undefined)).toBe(true);
  });
  it("hides empty-string title", () => {
    expect(shouldHideTitle("")).toBe(true);
  });
  it("hides whitespace-only title", () => {
    expect(shouldHideTitle("   ")).toBe(true);
  });
  it("hides the literal 'Untitled' sentinel", () => {
    expect(shouldHideTitle("Untitled")).toBe(true);
  });
  it("hides 'Untitled' after whitespace trim", () => {
    expect(shouldHideTitle("  Untitled  ")).toBe(true);
  });
  it("shows any real title", () => {
    expect(shouldHideTitle("Escritura de venta de una casa")).toBe(false);
  });
  it("shows a Spanish title with accented characters", () => {
    expect(shouldHideTitle("Concesión de poder")).toBe(false);
  });
  it("shows a title that merely contains the word 'Untitled'", () => {
    // Only an exact match triggers the hide rule, not substring matches.
    expect(shouldHideTitle("Draft: Untitled case against the estate")).toBe(
      false,
    );
  });
});

describe("buildDeleteWarningLines (Task 14.G /)", () => {
  it("returns an empty list when both counts are zero (no warning fires)", () => {
    expect(buildDeleteWarningLines(0, 0)).toEqual([]);
  });

  it("returns only the attached-warning line when only attached > 0", () => {
    const lines = buildDeleteWarningLines(3, 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      key: "viewer:outline.delete_with_attached_count",
      vars: { count: 3 },
    });
  });

  it("returns only the anchored-info line when only anchored > 0", () => {
    const lines = buildDeleteWarningLines(0, 2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      key: "viewer:outline.delete_with_anchored_remaining",
      vars: { count: 2 },
    });
  });

  it("returns both lines in order (attached first, anchored second)", () => {
    const lines = buildDeleteWarningLines(4, 1);
    expect(lines).toHaveLength(2);
    expect(lines[0].key).toBe("viewer:outline.delete_with_attached_count");
    expect(lines[0].vars).toEqual({ count: 4 });
    expect(lines[1].key).toBe("viewer:outline.delete_with_anchored_remaining");
    expect(lines[1].vars).toEqual({ count: 1 });
  });

  it("preserves count values verbatim (plural rules handled by i18n layer)", () => {
    const lines = buildDeleteWarningLines(1, 1);
    expect(lines[0].vars.count).toBe(1);
    expect(lines[1].vars.count).toBe(1);
  });
});

