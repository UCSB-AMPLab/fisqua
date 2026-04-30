/**
 * Tests — reference codes
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import type { Entry } from "../../app/lib/boundary-types";
import {
  generateRefCode,
  computeAllRefCodes,
} from "../../app/lib/reference-codes";

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "entry-1",
    volumeId: "vol-1",
    parentId: null,
    position: 0,
    startPage: 1,
    startY: 0,
    endPage: null,
    endY: null,
    type: null,
    subtype: null,
    title: null,
    modifiedBy: null,
    translatedTitle: null,
    resourceType: null,
    dateExpression: null,
    dateStart: null,
    dateEnd: null,
    extent: null,
    scopeContent: null,
    language: null,
    descriptionNotes: null,
    internalNotes: null,
    descriptionLevel: null,
    descriptionStatus: null,
    assignedDescriber: null,
    assignedDescriptionReviewer: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("generateRefCode", () => {
  it("returns parentRef + /0001 for position 0 at depth 0", () => {
    expect(generateRefCode("co-ahr-gob-caj259-car005", 0, 0)).toBe(
      "co-ahr-gob-caj259-car005/0001"
    );
  });

  it("returns parentRef + /0003 for position 2 at depth 0", () => {
    expect(generateRefCode("co-ahr-gob-caj259-car005", 2, 0)).toBe(
      "co-ahr-gob-caj259-car005/0003"
    );
  });

  it("returns parentRef + .01 for position 0 at depth 1", () => {
    expect(generateRefCode("co-ahr-gob-caj259-car005/0001", 0, 1)).toBe(
      "co-ahr-gob-caj259-car005/0001.01"
    );
  });

  it("returns parentRef + .12 for position 11 at depth 1", () => {
    expect(generateRefCode("co-ahr-gob-caj259-car005/0003", 11, 1)).toBe(
      "co-ahr-gob-caj259-car005/0003.12"
    );
  });

  it("handles deeper nesting (depth 2+) with .NN notation", () => {
    expect(
      generateRefCode("co-ahr-gob-caj259-car005/0001.01", 0, 2)
    ).toBe("co-ahr-gob-caj259-car005/0001.01.01");
  });
});

describe("computeAllRefCodes", () => {
  const volumeRef = "co-ahr-gob-caj259-car005";

  it("returns empty map for empty entries array", () => {
    const result = computeAllRefCodes([], volumeRef);
    expect(result.size).toBe(0);
  });

  it("computes ref codes for top-level entries", () => {
    const entries: Entry[] = [
      makeEntry({ id: "a", position: 0, startPage: 1 }),
      makeEntry({ id: "b", position: 1, startPage: 5 }),
      makeEntry({ id: "c", position: 2, startPage: 10 }),
    ];

    const result = computeAllRefCodes(entries, volumeRef);
    expect(result.get("a")).toBe("co-ahr-gob-caj259-car005/0001");
    expect(result.get("b")).toBe("co-ahr-gob-caj259-car005/0002");
    expect(result.get("c")).toBe("co-ahr-gob-caj259-car005/0003");
  });

  it("computes ref codes for nested entries (children get parent ref + .NN)", () => {
    const entries: Entry[] = [
      makeEntry({ id: "parent", position: 0, startPage: 1 }),
      makeEntry({
        id: "child1",
        parentId: "parent",
        position: 0,
        startPage: 1,
        endPage: 3,
      }),
      makeEntry({
        id: "child2",
        parentId: "parent",
        position: 1,
        startPage: 4,
        endPage: 8,
      }),
    ];

    const result = computeAllRefCodes(entries, volumeRef);
    expect(result.get("parent")).toBe("co-ahr-gob-caj259-car005/0001");
    expect(result.get("child1")).toBe("co-ahr-gob-caj259-car005/0001.01");
    expect(result.get("child2")).toBe("co-ahr-gob-caj259-car005/0001.02");
  });

  it("handles deeply nested entries", () => {
    const entries: Entry[] = [
      makeEntry({ id: "top", position: 0, startPage: 1 }),
      makeEntry({
        id: "mid",
        parentId: "top",
        position: 0,
        startPage: 1,
        endPage: 5,
      }),
      makeEntry({
        id: "deep",
        parentId: "mid",
        position: 0,
        startPage: 1,
        endPage: 2,
      }),
    ];

    const result = computeAllRefCodes(entries, volumeRef);
    expect(result.get("top")).toBe("co-ahr-gob-caj259-car005/0001");
    expect(result.get("mid")).toBe("co-ahr-gob-caj259-car005/0001.01");
    expect(result.get("deep")).toBe("co-ahr-gob-caj259-car005/0001.01.01");
  });

  it("computes ref codes for multiple top-level entries with children", () => {
    const entries: Entry[] = [
      makeEntry({ id: "a", position: 0, startPage: 1 }),
      makeEntry({
        id: "a1",
        parentId: "a",
        position: 0,
        startPage: 1,
        endPage: 2,
      }),
      makeEntry({ id: "b", position: 1, startPage: 5 }),
      makeEntry({
        id: "b1",
        parentId: "b",
        position: 0,
        startPage: 5,
        endPage: 6,
      }),
      makeEntry({
        id: "b2",
        parentId: "b",
        position: 1,
        startPage: 7,
        endPage: 8,
      }),
    ];

    const result = computeAllRefCodes(entries, volumeRef);
    expect(result.get("a")).toBe("co-ahr-gob-caj259-car005/0001");
    expect(result.get("a1")).toBe("co-ahr-gob-caj259-car005/0001.01");
    expect(result.get("b")).toBe("co-ahr-gob-caj259-car005/0002");
    expect(result.get("b1")).toBe("co-ahr-gob-caj259-car005/0002.01");
    expect(result.get("b2")).toBe("co-ahr-gob-caj259-car005/0002.02");
  });
});
