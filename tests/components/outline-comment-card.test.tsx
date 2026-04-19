/**
 * Tests — outline comment cardx
 *
 * @version v0.3.0
 */
import { describe, expect, it } from "vitest";
import {
  shouldShowRegionChip,
  computeReplyCountLabel,
  formatCommentHeader,
} from "../../app/components/outline/outline-comment-card";
import type { CommentWithAuthor } from "../../app/lib/description-types";

function makeComment(
  overrides: Partial<CommentWithAuthor> = {},
): CommentWithAuthor {
  return {
    id: "c1",
    volumeId: "v1",
    entryId: null,
    pageId: null,
    qcFlagId: null,
    regionX: null,
    regionY: null,
    regionW: null,
    regionH: null,
    parentId: null,
    authorId: "u1",
    authorRole: "cataloguer",
    text: "hello",
    createdAt: Date.now(),
    updatedAt: null,
    authorEmail: "u1@example.com",
    authorName: null,
    ...overrides,
  } as CommentWithAuthor;
}

describe("shouldShowRegionChip", () => {
  it("hides chip when card is collapsed even if region set", () => {
    const comment = makeComment({
      pageId: "p1",
      regionX: 0.1,
      regionY: 0.2,
    });
    expect(shouldShowRegionChip(comment, false, 3)).toBe(false);
  });

  it("shows chip when expanded + region + pageNumber", () => {
    const comment = makeComment({
      pageId: "p1",
      regionX: 0.1,
      regionY: 0.2,
    });
    expect(shouldShowRegionChip(comment, true, 3)).toBe(true);
  });

  it("hides chip when expanded but pageNumber missing", () => {
    const comment = makeComment({
      pageId: "p1",
      regionX: 0.1,
      regionY: 0.2,
    });
    expect(shouldShowRegionChip(comment, true, undefined)).toBe(false);
  });

  it("hides chip when expanded but regionX null", () => {
    const comment = makeComment({ pageId: "p1", regionY: 0.2 });
    expect(shouldShowRegionChip(comment, true, 3)).toBe(false);
  });

  it("hides chip when expanded but pageId null", () => {
    const comment = makeComment({ regionX: 0.1, regionY: 0.2 });
    expect(shouldShowRegionChip(comment, true, 3)).toBe(false);
  });
});

describe("computeReplyCountLabel", () => {
  it("returns null when there are no replies", () => {
    expect(computeReplyCountLabel([])).toBe(null);
  });

  it("returns total including parent (replies + 1)", () => {
    expect(computeReplyCountLabel([makeComment({ id: "r1" })])).toBe(2);
    expect(
      computeReplyCountLabel([
        makeComment({ id: "r1" }),
        makeComment({ id: "r2" }),
        makeComment({ id: "r3" }),
      ]),
    ).toBe(4);
  });
});

describe("formatCommentHeader (anchoring-based, 2026-04-18)", () => {
  it("returns comment_kind_annotation when the comment is region-anchored", () => {
    expect(formatCommentHeader(true)).toEqual({
      kindKey: "comment_kind_annotation",
    });
  });

  it("returns comment_kind_comment when the comment has no region", () => {
    expect(formatCommentHeader(false)).toEqual({
      kindKey: "comment_kind_comment",
    });
  });
});
