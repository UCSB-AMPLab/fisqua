/**
 * Tests — comment partition
 *
 * @version v0.3.0
 */
import { describe, expect, it } from "vitest";
import { partitionComments } from "../../app/lib/comment-partition";
import type { Entry } from "../../app/lib/boundary-types";

function makeEntry(overrides: Partial<Entry> & Pick<Entry, "id">): Entry {
  return {
    volumeId: "vol-1",
    parentId: null,
    position: 0,
    startPage: 1,
    startY: 0,
    endPage: null,
    endY: null,
    type: "item",
    subtype: null,
    title: null,
    referenceCode: null,
    ...overrides,
  } as Entry;
}

const pages = [
  { id: "page-1", position: 0 },
  { id: "page-2", position: 1 },
  { id: "page-3", position: 2 },
];

function makeComment(overrides: {
  id: string;
  entryId?: string | null;
  pageId?: string | null;
  qcFlagId?: string | null;
  regionX?: number | null;
  regionY?: number | null;
  regionW?: number | null;
  regionH?: number | null;
  authorId?: string;
}) {
  return {
    id: overrides.id,
    entryId: overrides.entryId ?? null,
    pageId: overrides.pageId ?? null,
    qcFlagId: overrides.qcFlagId ?? null,
    regionX: overrides.regionX ?? null,
    regionY: overrides.regionY ?? null,
    regionW: overrides.regionW ?? null,
    regionH: overrides.regionH ?? null,
    authorId: overrides.authorId ?? "test-author",
  };
}

describe("partitionComments", () => {
  describe("entry-anchored comments", () => {
    it("routes attached rows into commentsByEntry and the attached count map", () => {
      const entries = [makeEntry({ id: "e1", position: 0 })];
      const raw = [
        makeComment({ id: "c1", entryId: "e1" }),
        makeComment({ id: "c2", entryId: "e1" }),
      ];

      const r = partitionComments(raw, pages, entries);

      expect(r.commentsByEntry["e1"]).toHaveLength(2);
      expect(r.commentCountByEntry_attached["e1"]).toBe(2);
      expect(r.commentCountByEntry_anchored["e1"]).toBeUndefined();
    });

    it("routes entry-anchored rows WITH a region into the anchored count map", () => {
      // Defensive: current createComment doesn't emit this shape, but a
      // future entry-region server arm should classify correctly without
      // a partition change.
      const entries = [makeEntry({ id: "e1", position: 0 })];
      const raw = [
        makeComment({
          id: "c1",
          entryId: "e1",
          regionX: 0.2,
          regionY: 0.3,
          regionW: 0.1,
          regionH: 0.1,
        }),
      ];

      const r = partitionComments(raw, pages, entries);

      expect(r.commentCountByEntry_attached["e1"]).toBeUndefined();
      expect(r.commentCountByEntry_anchored["e1"]).toBe(1);
    });
  });

  describe("page-anchored comments with regions", () => {
    it("resolves to the owning entry and counts as anchored", () => {
      // Two entries share the volume; entry e1 covers pages 1-2, entry e2
      // covers page 3. A region on page 2 y=0.5 resolves to e1.
      const entries = [
        makeEntry({ id: "e1", position: 0, startPage: 1, startY: 0 }),
        makeEntry({ id: "e2", position: 1, startPage: 3, startY: 0 }),
      ];
      const raw = [
        makeComment({
          id: "c1",
          pageId: "page-2",
          regionX: 0.1,
          regionY: 0.5,
          regionW: 0.2,
          regionH: 0.2,
        }),
      ];

      const r = partitionComments(raw, pages, entries);

      // commentsByPage preserved for legacy consumers
      expect(r.commentsByPage["page-2"]).toHaveLength(1);
      // Re-parented into commentsByEntry under e1
      expect(r.commentsByEntry["e1"]).toHaveLength(1);
      expect(r.commentCountByEntry_anchored["e1"]).toBe(1);
      expect(r.commentCountByEntry_attached["e1"]).toBeUndefined();
      // regionsByPage populated for the viewer overlay
      expect(r.regionsByPage["page-2"]).toHaveLength(1);
    });

    it("re-parents to the later entry when the region sits past the boundary", () => {
      const entries = [
        makeEntry({ id: "e1", position: 0, startPage: 1, startY: 0 }),
        makeEntry({ id: "e2", position: 1, startPage: 2, startY: 0.5 }),
      ];
      // Region at page 2, y=0.7 is past e2's start — belongs to e2
      const raw = [
        makeComment({
          id: "c1",
          pageId: "page-2",
          regionX: 0.2,
          regionY: 0.7,
        }),
      ];

      const r = partitionComments(raw, pages, entries);

      expect(r.commentsByEntry["e2"]).toHaveLength(1);
      expect(r.commentsByEntry["e1"]).toBeUndefined();
      expect(r.commentCountByEntry_anchored["e2"]).toBe(1);
    });

    it("skips silently when no entry covers the region (volume-edge)", () => {
      // Empty outline — no entry can claim the region.
      const entries: Entry[] = [];
      const raw = [
        makeComment({
          id: "c1",
          pageId: "page-1",
          regionX: 0.2,
          regionY: 0.3,
        }),
      ];

      const r = partitionComments(raw, pages, entries);

      // Page bucket still holds the row for legacy consumers
      expect(r.commentsByPage["page-1"]).toHaveLength(1);
      // No entry bucket gets the row and no anchored count is created
      expect(Object.keys(r.commentsByEntry)).toHaveLength(0);
      expect(Object.keys(r.commentCountByEntry_anchored)).toHaveLength(0);
    });

    it("earlier-sibling tie-breaker on exact boundary", () => {
      // Two entries; e2 starts exactly at page 2, y=0.5. A region placed
      // at page 2, y=0.5 should belong to e1 (inclusive start means >=,
      // but the `beforeEnd < nextStart` strictness on e1 means e1's span
      // is [1,0 .. 2,0.5) — the boundary belongs to e2 by the strict-end
      // rule. The findCurrentEntry spec says:
      //   afterStart uses `>=` (inclusive) -> point ON the start belongs
      //     to THIS entry
      //   beforeEnd uses `<` (strict) -> point ON the end goes to the
      //     NEXT entry
      // So page=2 y=0.5 is the END of e1 (exclusive) AND the START of e2
      // (inclusive). e2 wins. That's the "earlier-sibling" note in
      // the original spec applies to AMBIGUOUS cases, not exact boundary
      // — exact boundary deterministically goes to the later sibling.
      // This test pins that behaviour so a future refactor doesn't flip.
      const entries = [
        makeEntry({ id: "e1", position: 0, startPage: 1, startY: 0 }),
        makeEntry({ id: "e2", position: 1, startPage: 2, startY: 0.5 }),
      ];
      const raw = [
        makeComment({
          id: "c1",
          pageId: "page-2",
          regionX: 0.1,
          regionY: 0.5,
        }),
      ];

      const r = partitionComments(raw, pages, entries);

      expect(r.commentsByEntry["e2"]).toHaveLength(1);
      expect(r.commentsByEntry["e1"]).toBeUndefined();
    });
  });

  describe("page-anchored comments without region (legacy data)", () => {
    it("stays in commentsByPage only, never in commentsByEntry", () => {
      const entries = [makeEntry({ id: "e1", position: 0 })];
      const raw = [makeComment({ id: "c1", pageId: "page-1" })];

      const r = partitionComments(raw, pages, entries);

      expect(r.commentsByPage["page-1"]).toHaveLength(1);
      expect(r.commentsByEntry["e1"]).toBeUndefined();
      expect(r.commentCountByEntry_anchored["e1"]).toBeUndefined();
      expect(r.commentCountByEntry_attached["e1"]).toBeUndefined();
    });
  });

  describe("qc-flag-anchored comments", () => {
    it("routes into commentsByQcFlag and nowhere else", () => {
      const entries = [makeEntry({ id: "e1", position: 0 })];
      const raw = [makeComment({ id: "c1", qcFlagId: "qc-1" })];

      const r = partitionComments(raw, pages, entries);

      expect(r.commentsByQcFlag["qc-1"]).toHaveLength(1);
      expect(Object.keys(r.commentsByEntry)).toHaveLength(0);
      expect(Object.keys(r.commentsByPage)).toHaveLength(0);
      expect(Object.keys(r.commentCountByEntry_attached)).toHaveLength(0);
    });
  });

  describe("mixed realistic volume", () => {
    it("partitions a mix of all kinds correctly", () => {
      const entries = [
        makeEntry({ id: "e1", position: 0, startPage: 1, startY: 0 }),
        makeEntry({ id: "e2", position: 1, startPage: 3, startY: 0 }),
      ];
      const raw = [
        // e1: two attached, one anchored-via-page (page-2 y=0.5)
        makeComment({ id: "c1", entryId: "e1" }),
        makeComment({ id: "c2", entryId: "e1" }),
        makeComment({
          id: "c3",
          pageId: "page-2",
          regionX: 0.1,
          regionY: 0.5,
        }),
        // e2: one attached
        makeComment({ id: "c4", entryId: "e2" }),
        // qc flag
        makeComment({ id: "c5", qcFlagId: "qc-1" }),
        // orphaned page comment (no region)
        makeComment({ id: "c6", pageId: "page-1" }),
      ];

      const r = partitionComments(raw, pages, entries);

      expect(r.commentsByEntry["e1"]).toHaveLength(3); // 2 attached + 1 anchored
      expect(r.commentsByEntry["e2"]).toHaveLength(1);
      expect(r.commentCountByEntry_attached["e1"]).toBe(2);
      expect(r.commentCountByEntry_anchored["e1"]).toBe(1);
      expect(r.commentCountByEntry_attached["e2"]).toBe(1);
      expect(r.commentCountByEntry_anchored["e2"]).toBeUndefined();
      expect(r.commentsByQcFlag["qc-1"]).toHaveLength(1);
      expect(r.commentsByPage["page-1"]).toHaveLength(1);
      expect(r.commentsByPage["page-2"]).toHaveLength(1);
      expect(r.regionsByPage["page-2"]).toHaveLength(1);
    });
  });
});
