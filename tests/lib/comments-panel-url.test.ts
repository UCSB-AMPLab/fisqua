/**
 * Tests — comments panel url
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import {
  parseCommentsParam,
  encodeCommentsParam,
  type CommentsPanelSelection,
} from "../../app/lib/comments-panel-url";

describe("parseCommentsParam ()", () => {
  it('parses "entry:abc123" as an entry selection', () => {
    expect(parseCommentsParam("entry:abc123")).toEqual({
      kind: "entry",
      entryId: "abc123",
    });
  });

  it('parses "page:vp-1" as a page selection', () => {
    expect(parseCommentsParam("page:vp-1")).toEqual({
      kind: "page",
      pageId: "vp-1",
    });
  });

  it('parses "region:c-42" as a region selection keyed by commentId', () => {
    expect(parseCommentsParam("region:c-42")).toEqual({
      kind: "region",
      commentId: "c-42",
    });
  });

  it('parses "comment:c-88" as a plain-comment selection keyed by commentId (Task 14.C)', () => {
    expect(parseCommentsParam("comment:c-88")).toEqual({
      kind: "comment",
      commentId: "c-88",
    });
  });

  it('parses "flag:f-7" as a QC-flag selection', () => {
    expect(parseCommentsParam("flag:f-7")).toEqual({
      kind: "flag",
      qcFlagId: "f-7",
    });
  });

  it('parses "reseg:r-9" as a resegmentation-flag selection', () => {
    expect(parseCommentsParam("reseg:r-9")).toEqual({
      kind: "reseg",
      resegFlagId: "r-9",
    });
  });

  it("returns null for null input", () => {
    expect(parseCommentsParam(null)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseCommentsParam("")).toBeNull();
  });

  it('returns null for unknown prefix "unknown:xyz"', () => {
    expect(parseCommentsParam("unknown:xyz")).toBeNull();
  });

  it('returns null when the id is missing (e.g. "entry:")', () => {
    expect(parseCommentsParam("entry:")).toBeNull();
  });

  it('returns null when the kind is missing (e.g. ":abc")', () => {
    expect(parseCommentsParam(":abc")).toBeNull();
  });

  it("preserves embedded colons in ids by splitting on the first colon only", () => {
    expect(parseCommentsParam("entry:abc:def")).toEqual({
      kind: "entry",
      entryId: "abc:def",
    });
  });
});

describe("encodeCommentsParam ()", () => {
  it('encodes an entry selection as "entry:<id>"', () => {
    expect(encodeCommentsParam({ kind: "entry", entryId: "abc" })).toBe(
      "entry:abc"
    );
  });

  it('encodes a flag selection as "flag:<id>"', () => {
    expect(encodeCommentsParam({ kind: "flag", qcFlagId: "f-7" })).toBe(
      "flag:f-7"
    );
  });

  it("returns null when the selection is itself null", () => {
    expect(encodeCommentsParam(null)).toBeNull();
  });
});

describe("parseCommentsParam / encodeCommentsParam round-trip ()", () => {
  it("round-trips every valid selection kind to the same structured value", () => {
    const cases: CommentsPanelSelection[] = [
      { kind: "entry", entryId: "e-1" },
      { kind: "page", pageId: "vp-123" },
      { kind: "region", commentId: "c-xyz" },
      { kind: "comment", commentId: "c-abc" },
      { kind: "flag", qcFlagId: "qf-7" },
      { kind: "reseg", resegFlagId: "rf-9" },
    ];
    for (const selection of cases) {
      const encoded = encodeCommentsParam(selection);
      expect(encoded).not.toBeNull();
      const roundTripped = parseCommentsParam(encoded);
      expect(roundTripped).toEqual(selection);
    }
  });
});

