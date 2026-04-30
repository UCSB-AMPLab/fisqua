/**
 * Tests — entry ownership
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import { findCurrentEntry } from "../../app/lib/entry-ownership";
import type { Entry } from "../../app/lib/boundary-types";

/**
 * Build a minimal Entry fixture with just the fields `findCurrentEntry`
 * reads. All other Entry fields are zero-valued / null so TypeScript is
 * happy without ballooning each test.
 */
function makeEntry(overrides: {
  id: string;
  parentId?: string | null;
  position: number;
  startPage: number;
  startY: number;
  endPage?: number | null;
  endY?: number | null;
}): Entry {
  return {
    id: overrides.id,
    volumeId: "vol-1",
    parentId: overrides.parentId ?? null,
    position: overrides.position,
    startPage: overrides.startPage,
    startY: overrides.startY,
    endPage: overrides.endPage ?? null,
    endY: overrides.endY ?? null,
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
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("findCurrentEntry", () => {
  it("returns null for an empty entries array on any (page, y)", () => {
    expect(findCurrentEntry([], 1, 0, 10)).toBeNull();
    expect(findCurrentEntry([], 5, 0.5, 10)).toBeNull();
    expect(findCurrentEntry([], 100, 1, 10)).toBeNull();
  });

  it("matches a single top-level entry spanning (1, 0) to volume end for every in-range query", () => {
    // Note: startPage is 1-based (matches outline-panel.tsx convention). A
    // single last-sibling entry with no explicit endPage extends to the
    // volume end at (totalPages, 1).
    const entries: Entry[] = [
      makeEntry({ id: "a", position: 0, startPage: 1, startY: 0 }),
    ];
    expect(findCurrentEntry(entries, 1, 0, 10)).toBe("a");
    expect(findCurrentEntry(entries, 1, 0.5, 10)).toBe("a");
    expect(findCurrentEntry(entries, 5, 0.25, 10)).toBe("a");
    // beforeEnd is strict: pageNumber === totalPages AND y === 1 is OUT of
    // range (beyond volume end). We avoid that edge here.
    expect(findCurrentEntry(entries, 9, 0.99, 10)).toBe("a");
  });

  it("applies the earlier-sibling tie-breaker when two siblings share a page boundary", () => {
    // Entry A: starts at (1, 0). Entry B: starts at (2, 0). A extends
    // implicitly to just before B (endPage=2, endY=0). A query at (2, 0)
    // sits exactly on the boundary; per it belongs to the earlier
    // sibling A because `beforeEnd` is strict (`<`) so (2, 0) is NOT in
    // A's range... but A's range is [(1,0), (2,0)). So (2, 0) falls into
    // B, NOT A.
    //
    // Wait -- re-read comparePageY semantics: afterStart uses `>=` and
    // beforeEnd uses `<`. So A = [(1,0), (2,0)) -- half-open at the end.
    // A query at (2, 0) fails A's beforeEnd (2 !< 2 + y 0 !< 0) -> moves
    // to B. B's range is [(2,0), (totalPages,1)). (2, 0) satisfies B's
    // afterStart (>= 0) and beforeEnd -> B.
    //
    // The tie-breaker case is actually about y within a single page:
    // A ends at (p, 0.5) and B starts at (p, 0.5). A query at (p, 0.5)
    // fails A's beforeEnd AND satisfies B's afterStart -> B wins.
    //
    // So "earlier sibling wins" applies to a DIFFERENT shape: when two
    // entries could both be candidates because the iteration order picks
    // the first one reached in position order. That happens when the end
    // of A is EXPLICIT (endPage/endY set) and overlaps B's range. Test
    // that:
    const entries: Entry[] = [
      makeEntry({
        id: "a",
        position: 0,
        startPage: 1,
        startY: 0,
        endPage: 2,
        endY: 0.5,
      }),
      makeEntry({
        id: "b",
        position: 1,
        startPage: 2,
        startY: 0.4, // overlaps A's tail [0.4, 0.5] on page 2
      }),
    ];
    // Query at (2, 0.45) -- inside both A (ends at 0.5) and B (starts at
    // 0.4). Position-sorted iteration checks A first, so A wins (earlier
    // sibling wins).
    expect(findCurrentEntry(entries, 2, 0.45, 10)).toBe("a");
  });

  it("descends into nested children -- returns the deepest match", () => {
    // Parent A: (1, 0) .. volume end.
    // Child A1 (parentId=a): (3, 0.2) .. (4, 0.8).
    // Query inside A1 returns A1, not A.
    const entries: Entry[] = [
      makeEntry({ id: "a", position: 0, startPage: 1, startY: 0 }),
      makeEntry({
        id: "a1",
        parentId: "a",
        position: 0,
        startPage: 3,
        startY: 0.2,
        endPage: 4,
        endY: 0.8,
      }),
    ];
    expect(findCurrentEntry(entries, 3, 0.5, 10)).toBe("a1");
    // A query OUTSIDE A1's narrow range but inside A falls back to A.
    expect(findCurrentEntry(entries, 2, 0.5, 10)).toBe("a");
    expect(findCurrentEntry(entries, 5, 0.5, 10)).toBe("a");
  });

  it("returns null when the query is beyond any entry's range", () => {
    // Single entry spans (1, 0) .. end; totalPages=5. Query at (6, 0.5)
    // is past the volume end.
    const entries: Entry[] = [
      makeEntry({ id: "a", position: 0, startPage: 1, startY: 0 }),
    ];
    expect(findCurrentEntry(entries, 6, 0.5, 5)).toBeNull();
    // Query at (5, 1) is exactly the volume end -- beforeEnd is strict
    // so this is out of range too.
    expect(findCurrentEntry(entries, 5, 1, 5)).toBeNull();
  });

  it("treats the start boundary as inclusive (afterStart `>=`)", () => {
    // Parent with explicit start at (2, 0.5). Query at EXACTLY (2, 0.5)
    // must return the parent because `afterStart` is `>= 0`.
    const entries: Entry[] = [
      makeEntry({
        id: "p",
        position: 0,
        startPage: 1,
        startY: 0,
      }),
      makeEntry({
        id: "child",
        parentId: "p",
        position: 0,
        startPage: 2,
        startY: 0.5,
        endPage: 3,
        endY: 0.5,
      }),
    ];
    expect(findCurrentEntry(entries, 2, 0.5, 10)).toBe("child");
    // And just before 0.5, the parent wins.
    expect(findCurrentEntry(entries, 2, 0.49, 10)).toBe("p");
  });
});

