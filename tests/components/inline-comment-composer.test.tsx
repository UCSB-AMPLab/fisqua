/**
 * Tests — inline comment composerx
 *
 * @version v0.3.0
 */
import { describe, expect, it } from "vitest";
import {
  shouldEnableSubmit,
  buildCommentSubmitPayload,
} from "../../app/components/comments/inline-comment-composer";

describe("shouldEnableSubmit", () => {
  it("disables submit when the body is empty", () => {
    expect(shouldEnableSubmit("", false)).toBe(false);
  });

  it("disables submit when the body is whitespace only", () => {
    expect(shouldEnableSubmit("   \n\t ", false)).toBe(false);
  });

  it("disables submit when a request is in flight", () => {
    expect(shouldEnableSubmit("real content", true)).toBe(false);
  });

  it("enables submit for trimmed non-empty content and no in-flight request", () => {
    expect(shouldEnableSubmit("real content", false)).toBe(true);
  });
});

describe("buildCommentSubmitPayload", () => {
  it("composes a page+region payload when region is set", () => {
    const payload = buildCommentSubmitPayload({
      volumeId: "v1",
      text: "  damaged spot  ",
      entryId: "e1",
      region: {
        pageId: "p1",
        pageLabel: "1",
        region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      },
    });
    expect(payload).toEqual({
      volumeId: "v1",
      text: "damaged spot",
      pageId: "p1",
      region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    });
    expect(payload).not.toHaveProperty("entryId");
  });

  it("composes an entry payload when region is null", () => {
    const payload = buildCommentSubmitPayload({
      volumeId: "v1",
      text: "a general note",
      entryId: "e1",
      region: null,
    });
    expect(payload).toEqual({
      volumeId: "v1",
      text: "a general note",
      entryId: "e1",
    });
    expect(payload).not.toHaveProperty("pageId");
    expect(payload).not.toHaveProperty("region");
  });

  it("includes parentId for reply submissions (entry-level)", () => {
    const payload = buildCommentSubmitPayload({
      volumeId: "v1",
      text: "reply",
      entryId: "e1",
      region: null,
      parentId: "c-parent",
    });
    expect(payload).toEqual({
      volumeId: "v1",
      text: "reply",
      entryId: "e1",
      parentId: "c-parent",
    });
  });

  it("includes parentId for reply submissions (anchored)", () => {
    const payload = buildCommentSubmitPayload({
      volumeId: "v1",
      text: "reply to anchored",
      entryId: "e1",
      region: {
        pageId: "p1",
        region: { x: 0.1, y: 0.1, w: 0, h: 0 },
      },
      parentId: "c-parent",
    });
    expect(payload.parentId).toBe("c-parent");
    expect(payload.pageId).toBe("p1");
  });

  it("trims the body on every arm", () => {
    const entry = buildCommentSubmitPayload({
      volumeId: "v1",
      text: "   hi   ",
      entryId: "e1",
      region: null,
    });
    expect(entry.text).toBe("hi");
  });
});
