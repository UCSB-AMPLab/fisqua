/**
 * Tests — outline items
 *
 * @version v0.3.0
 */
import { describe, expect, it } from "vitest";
import {
  buildOutlineItems,
  findOutlineItemIndex,
  outlineItemKey,
  type FlatEntryNode,
} from "../../app/lib/outline-items";
import type { Entry } from "../../app/lib/boundary-types";
import type { CommentWithAuthor } from "../../app/lib/description-types";

function makeFlatNode(
  entryOverrides: Partial<Entry> & Pick<Entry, "id">,
): FlatEntryNode {
  return {
    entry: {
      volumeId: "v1",
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
      ...entryOverrides,
    } as Entry,
    depth: 0,
    isLast: false,
    hasChildren: false,
  };
}

function makeComment(
  overrides: Partial<CommentWithAuthor> & Pick<CommentWithAuthor, "id">,
): CommentWithAuthor {
  return {
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
    createdAt: 1000,
    updatedAt: null,
    authorEmail: "u1@example.com",
    authorName: null,
    ...overrides,
  } as CommentWithAuthor;
}

describe("buildOutlineItems", () => {
  it("emits only entry items when no comments exist", () => {
    const flat = [
      makeFlatNode({ id: "e1", position: 0 }),
      makeFlatNode({ id: "e2", position: 1 }),
    ];
    const items = buildOutlineItems(flat, {});
    expect(items).toHaveLength(2);
    expect(items[0].kind).toBe("entry");
    expect(items[1].kind).toBe("entry");
  });

  it("interleaves comments after their entry, in createdAt ASC order", () => {
    const flat = [makeFlatNode({ id: "e1", position: 0 })];
    const commentsByEntry = {
      e1: [
        makeComment({ id: "c2", createdAt: 2000 }),
        makeComment({ id: "c1", createdAt: 1000 }),
        makeComment({ id: "c3", createdAt: 3000 }),
      ],
    };
    const items = buildOutlineItems(flat, commentsByEntry);
    expect(items).toHaveLength(4);
    expect(items[0].kind).toBe("entry");
    // Ordered by createdAt ASC: c1, c2, c3
    expect(items[1].kind).toBe("comment");
    expect(items[2].kind).toBe("comment");
    expect(items[3].kind).toBe("comment");
    const ids = items.slice(1).map((i) => (i as { comment: CommentWithAuthor }).comment.id);
    expect(ids).toEqual(["c1", "c2", "c3"]);
  });

  it("groups replies with their parent comment (replies never become items)", () => {
    const flat = [makeFlatNode({ id: "e1", position: 0 })];
    const commentsByEntry = {
      e1: [
        makeComment({ id: "c1", createdAt: 1000 }),
        makeComment({ id: "r1", parentId: "c1", createdAt: 2000 }),
        makeComment({ id: "r2", parentId: "c1", createdAt: 3000 }),
        makeComment({ id: "c2", createdAt: 4000 }),
      ],
    };
    const items = buildOutlineItems(flat, commentsByEntry);
    // Entry + 2 top-level comments = 3 items (replies don't get their
    // own row).
    expect(items).toHaveLength(3);
    const topLevel = items[1] as {
      kind: "comment";
      comment: CommentWithAuthor;
      replies: CommentWithAuthor[];
    };
    expect(topLevel.comment.id).toBe("c1");
    expect(topLevel.replies.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("records entrySequence as entry.position + 1 (matches the Doc N header label)", () => {
    const flat = [makeFlatNode({ id: "e1", position: 4 })];
    const commentsByEntry = {
      e1: [makeComment({ id: "c1" })],
    };
    const items = buildOutlineItems(flat, commentsByEntry);
    const commentItem = items[1] as { entrySequence: number };
    expect(commentItem.entrySequence).toBe(5);
  });

  it("preserves entry ordering from flatNodes (does not re-sort)", () => {
    const flat = [
      makeFlatNode({ id: "e2", position: 1 }),
      makeFlatNode({ id: "e1", position: 0 }),
    ];
    const items = buildOutlineItems(flat, {});
    expect((items[0] as { kind: "entry"; node: FlatEntryNode }).node.entry.id).toBe("e2");
    expect((items[1] as { kind: "entry"; node: FlatEntryNode }).node.entry.id).toBe("e1");
  });
});

describe("findOutlineItemIndex", () => {
  it("finds an entry by id", () => {
    const flat = [
      makeFlatNode({ id: "e1", position: 0 }),
      makeFlatNode({ id: "e2", position: 1 }),
    ];
    const items = buildOutlineItems(flat, {});
    expect(findOutlineItemIndex(items, { kind: "entry", entryId: "e2" })).toBe(1);
  });

  it("finds a comment by id", () => {
    const flat = [makeFlatNode({ id: "e1", position: 0 })];
    const items = buildOutlineItems(flat, {
      e1: [
        makeComment({ id: "c1", createdAt: 1000 }),
        makeComment({ id: "c2", createdAt: 2000 }),
      ],
    });
    expect(findOutlineItemIndex(items, { kind: "comment", commentId: "c2" })).toBe(2);
  });

  it("returns -1 for a missing target (stale URL)", () => {
    const flat = [makeFlatNode({ id: "e1", position: 0 })];
    const items = buildOutlineItems(flat, {});
    expect(findOutlineItemIndex(items, { kind: "comment", commentId: "gone" })).toBe(-1);
    expect(findOutlineItemIndex(items, { kind: "entry", entryId: "gone" })).toBe(-1);
  });
});

describe("outlineItemKey", () => {
  it("prefixes entry ids to prevent collisions with comment ids", () => {
    const flat = [makeFlatNode({ id: "x", position: 0 })];
    const items = buildOutlineItems(flat, {
      x: [makeComment({ id: "x" })], // same literal id as the entry
    });
    const keys = items.map(outlineItemKey);
    expect(keys).toEqual(["entry:x", "comment:x"]);
    expect(new Set(keys).size).toBe(2);
  });

  it("prefixes draft rows with draft:<entryId>", () => {
    const flat = [makeFlatNode({ id: "e1", position: 0 })];
    const items = buildOutlineItems(flat, {}, { entryId: "e1", region: null });
    const keys = items.map(outlineItemKey);
    expect(keys).toEqual(["entry:e1", "draft:e1"]);
  });
});

describe("buildOutlineItems — draft insertion (Task 14 follow-up)", () => {
  it("appends a draft-comment row under the target entry when no comments exist", () => {
    const flat = [makeFlatNode({ id: "e1", position: 0 })];
    const items = buildOutlineItems(flat, {}, { entryId: "e1", region: null });
    expect(items).toHaveLength(2);
    expect(items[0].kind).toBe("entry");
    expect(items[1].kind).toBe("draft-comment");
  });

  it("appends a draft-comment row AFTER existing top-level comments", () => {
    const flat = [makeFlatNode({ id: "e1", position: 0 })];
    const items = buildOutlineItems(
      flat,
      {
        e1: [
          makeComment({ id: "c1", createdAt: 1000 }),
          makeComment({ id: "c2", createdAt: 2000 }),
        ],
      },
      { entryId: "e1", region: null },
    );
    // Entry + 2 comments + 1 draft = 4 items
    expect(items).toHaveLength(4);
    expect(items[1].kind).toBe("comment");
    expect(items[2].kind).toBe("comment");
    expect(items[3].kind).toBe("draft-comment");
  });

  it("only inserts a draft for the targeted entry, not for others", () => {
    const flat = [
      makeFlatNode({ id: "e1", position: 0 }),
      makeFlatNode({ id: "e2", position: 1 }),
    ];
    const items = buildOutlineItems(flat, {}, { entryId: "e2", region: null });
    expect(items).toHaveLength(3);
    expect((items[0] as { kind: "entry" }).kind).toBe("entry");
    expect((items[1] as { kind: "entry" }).kind).toBe("entry");
    expect((items[2] as { kind: "draft-comment" }).kind).toBe("draft-comment");
  });

  it("carries region metadata through to the draft item when anchored", () => {
    const flat = [makeFlatNode({ id: "e1", position: 0 })];
    const items = buildOutlineItems(
      flat,
      {},
      {
        entryId: "e1",
        region: {
          pageId: "p1",
          pageLabel: "1",
          region: { x: 0.2, y: 0.3, w: 0.1, h: 0.1 },
        },
      },
    );
    const draft = items[1] as {
      kind: "draft-comment";
      region: { pageId: string } | null;
    };
    expect(draft.region?.pageId).toBe("p1");
  });
});
