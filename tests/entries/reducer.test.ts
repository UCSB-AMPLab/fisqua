/**
 * Tests — reducer
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import type { Entry, BoundaryState } from "../../app/lib/boundary-types";
import {
  boundaryReducer,
  createInitialState,
} from "../../app/lib/boundary-reducer";

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

function makeState(overrides: Partial<BoundaryState> = {}): BoundaryState {
  return {
    entries: [],
    isDirty: false,
    saveStatus: "saved",
    version: 0,
    ...overrides,
  };
}

describe("createInitialState", () => {
  it("creates initial state from entries array", () => {
    const entries = [makeEntry({ id: "a" }), makeEntry({ id: "b", position: 1, startPage: 5 })];
    const state = createInitialState(entries);
    expect(state.entries).toHaveLength(2);
    expect(state.isDirty).toBe(false);
    expect(state.saveStatus).toBe("saved");
    expect(state.version).toBe(0);
  });

  it("creates initial state with empty entries", () => {
    const state = createInitialState([]);
    expect(state.entries).toHaveLength(0);
    expect(state.isDirty).toBe(false);
  });
});

describe("INIT action", () => {
  it("loads entries and resets state", () => {
    const entries = [makeEntry({ id: "a" }), makeEntry({ id: "b", position: 1, startPage: 5 })];
    const state = makeState({ isDirty: true, saveStatus: "unsaved", version: 5 });
    const result = boundaryReducer(state, { type: "INIT", entries });

    expect(result.entries).toHaveLength(2);
    expect(result.isDirty).toBe(false);
    expect(result.saveStatus).toBe("saved");
  });
});

describe("ADD_BOUNDARY", () => {
  it("creates a new entry at the specified page", () => {
    const state = makeState({
      entries: [makeEntry({ id: "first", position: 0, startPage: 1 })],
    });

    const result = boundaryReducer(state, {
      type: "ADD_BOUNDARY",
      startPage: 5,
      id: "new-entry",
    });

    expect(result.entries).toHaveLength(2);
    const newEntry = result.entries.find((e) => e.id === "new-entry");
    expect(newEntry).toBeDefined();
    expect(newEntry!.startPage).toBe(5);
    expect(newEntry!.startY).toBe(0);
  });

  it("creates a new entry with startY when provided", () => {
    const state = makeState({
      entries: [makeEntry({ id: "first", position: 0, startPage: 1 })],
    });

    const result = boundaryReducer(state, {
      type: "ADD_BOUNDARY",
      startPage: 3,
      startY: 0.5,
      id: "mid-page",
    });

    const newEntry = result.entries.find((e) => e.id === "mid-page");
    expect(newEntry).toBeDefined();
    expect(newEntry!.startPage).toBe(3);
    expect(newEntry!.startY).toBe(0.5);
  });

  it("defaults startY to 0 when not provided", () => {
    const state = makeState({
      entries: [makeEntry({ id: "first", position: 0, startPage: 1 })],
    });

    const result = boundaryReducer(state, {
      type: "ADD_BOUNDARY",
      startPage: 5,
      id: "new-entry",
    });

    const newEntry = result.entries.find((e) => e.id === "new-entry");
    expect(newEntry!.startY).toBe(0);
  });

  it("marks state as dirty and increments version", () => {
    const state = makeState({
      entries: [makeEntry({ id: "first", position: 0, startPage: 1 })],
    });

    const result = boundaryReducer(state, {
      type: "ADD_BOUNDARY",
      startPage: 5,
      id: "new-entry",
    });

    expect(result.isDirty).toBe(true);
    expect(result.saveStatus).toBe("unsaved");
    expect(result.version).toBe(1);
  });

  it("auto-renumbers siblings by startPage order after insert", () => {
    const state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
        makeEntry({ id: "c", position: 1, startPage: 10 }),
      ],
    });

    const result = boundaryReducer(state, {
      type: "ADD_BOUNDARY",
      startPage: 5,
      id: "b",
    });

    // Should be sorted by startPage: a(1), b(5), c(10) -> positions 0, 1, 2
    const sorted = [...result.entries].sort((a, b) => a.position - b.position);
    expect(sorted[0].id).toBe("a");
    expect(sorted[0].position).toBe(0);
    expect(sorted[1].id).toBe("b");
    expect(sorted[1].position).toBe(1);
    expect(sorted[2].id).toBe("c");
    expect(sorted[2].position).toBe(2);
  });

  it("sorts two entries on same page by startY", () => {
    const state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
        makeEntry({ id: "b", position: 1, startPage: 3, startY: 0.7 }),
      ],
    });

    const result = boundaryReducer(state, {
      type: "ADD_BOUNDARY",
      startPage: 3,
      startY: 0.2,
      id: "c",
    });

    // Page 3 entries: c(y=0.2) should be before b(y=0.7)
    const sorted = [...result.entries].sort((a, b) => a.position - b.position);
    expect(sorted[0].id).toBe("a"); // page 1
    expect(sorted[1].id).toBe("c"); // page 3, y=0.2
    expect(sorted[2].id).toBe("b"); // page 3, y=0.7
  });

  it("rejects ADD_BOUNDARY when too close to existing boundary (min gap)", () => {
    const state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
        makeEntry({ id: "b", position: 1, startPage: 3, startY: 0.50 }),
      ],
    });

    const result = boundaryReducer(state, {
      type: "ADD_BOUNDARY",
      startPage: 3,
      startY: 0.51,
      id: "too-close",
    });

    // Should be no-op: gap is 0.01 < MIN_Y_GAP (0.02)
    expect(result.entries).toHaveLength(2);
    expect(result.entries.find((e) => e.id === "too-close")).toBeUndefined();
  });
});

describe("MOVE_BOUNDARY", () => {
  it("updates startPage and re-sorts siblings", () => {
    const state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
        makeEntry({ id: "b", position: 1, startPage: 5 }),
        makeEntry({ id: "c", position: 2, startPage: 10 }),
      ],
    });

    // Move b from page 5 to page 12 (after c)
    const result = boundaryReducer(state, {
      type: "MOVE_BOUNDARY",
      entryId: "b",
      startPage: 12,
    });

    const moved = result.entries.find((e) => e.id === "b")!;
    expect(moved.startPage).toBe(12);

    // After renumber: a(1)->0, c(10)->1, b(12)->2
    const sorted = [...result.entries].sort((a, b) => a.position - b.position);
    expect(sorted[0].id).toBe("a");
    expect(sorted[1].id).toBe("c");
    expect(sorted[2].id).toBe("b");
  });

  it("updates startY when toY is provided", () => {
    const state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
        makeEntry({ id: "b", position: 1, startPage: 5, startY: 0.3 }),
      ],
    });

    const result = boundaryReducer(state, {
      type: "MOVE_BOUNDARY",
      entryId: "b",
      startPage: 5,
      toY: 0.7,
    });

    const moved = result.entries.find((e) => e.id === "b")!;
    expect(moved.startY).toBe(0.7);
  });

  it("increments version on move", () => {
    const state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
        makeEntry({ id: "b", position: 1, startPage: 5 }),
      ],
    });

    const result = boundaryReducer(state, {
      type: "MOVE_BOUNDARY",
      entryId: "b",
      startPage: 3,
    });

    expect(result.version).toBe(1);
    expect(result.isDirty).toBe(true);
  });

  it("rejects move if toPage would violate parent containment for child entry", () => {
    // Parent a: pages 1-9, child c: startPage 3, endPage 5
    const state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
        makeEntry({ id: "b", position: 1, startPage: 10 }),
        makeEntry({
          id: "c",
          parentId: "a",
          position: 0,
          startPage: 3,
          endPage: 5,
        }),
      ],
    });

    // Try to move child c to page 15 (outside parent's range 1-9)
    const result = boundaryReducer(state, {
      type: "MOVE_BOUNDARY",
      entryId: "c",
      startPage: 15,
    });

    // Should be a no-op -- child stays at page 3
    const child = result.entries.find((e) => e.id === "c")!;
    expect(child.startPage).toBe(3);
  });

  it("rejects move with y-aware containment -- child cannot move above parent on same page", () => {
    // Parent at page 5, y=0.3. Child at page 5, y=0.8.
    const state = makeState({
      entries: [
        makeEntry({ id: "parent", position: 0, startPage: 5, startY: 0.3 }),
        makeEntry({ id: "next-sibling", position: 1, startPage: 10 }),
        makeEntry({
          id: "child",
          parentId: "parent",
          position: 0,
          startPage: 5,
          startY: 0.8,
          endPage: 6,
        }),
      ],
    });

    // Try to move child to page 5, y=0.1 (above parent's y=0.3)
    const result = boundaryReducer(state, {
      type: "MOVE_BOUNDARY",
      entryId: "child",
      startPage: 5,
      toY: 0.1,
    });

    // Should be a no-op
    const child = result.entries.find((e) => e.id === "child")!;
    expect(child.startPage).toBe(5);
    expect(child.startY).toBe(0.8);
  });

  it("rejects move when target is too close to existing boundary (min gap)", () => {
    const state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
        makeEntry({ id: "b", position: 1, startPage: 3, startY: 0.5 }),
        makeEntry({ id: "c", position: 2, startPage: 5 }),
      ],
    });

    const result = boundaryReducer(state, {
      type: "MOVE_BOUNDARY",
      entryId: "c",
      startPage: 3,
      toY: 0.51,
    });

    // Should be a no-op: gap 0.01 < MIN_Y_GAP
    const moved = result.entries.find((e) => e.id === "c")!;
    expect(moved.startPage).toBe(5);
  });
});

describe("DELETE_BOUNDARY", () => {
  it("removes entry and renumbers remaining siblings", () => {
    const state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
        makeEntry({ id: "b", position: 1, startPage: 5 }),
        makeEntry({ id: "c", position: 2, startPage: 10 }),
      ],
    });

    const result = boundaryReducer(state, {
      type: "DELETE_BOUNDARY",
      entryId: "b",
    });

    expect(result.entries).toHaveLength(2);
    expect(result.entries.find((e) => e.id === "b")).toBeUndefined();

    // a(1)->0, c(10)->1
    const sorted = [...result.entries].sort((a, b) => a.position - b.position);
    expect(sorted[0].id).toBe("a");
    expect(sorted[0].position).toBe(0);
    expect(sorted[1].id).toBe("c");
    expect(sorted[1].position).toBe(1);
  });

  it("first entry (page 1, y=0, position 0, top-level) cannot be deleted", () => {
    const state = makeState({
      entries: [
        makeEntry({ id: "first", position: 0, startPage: 1, startY: 0 }),
        makeEntry({ id: "second", position: 1, startPage: 5 }),
      ],
    });

    const result = boundaryReducer(state, {
      type: "DELETE_BOUNDARY",
      entryId: "first",
    });

    // No-op -- entry still exists
    expect(result.entries).toHaveLength(2);
    expect(result.entries.find((e) => e.id === "first")).toBeDefined();
  });

  it("also removes all children of the deleted entry", () => {
    const state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
        makeEntry({ id: "b", position: 1, startPage: 5 }),
        makeEntry({
          id: "b-child",
          parentId: "b",
          position: 0,
          startPage: 5,
          endPage: 7,
        }),
      ],
    });

    const result = boundaryReducer(state, {
      type: "DELETE_BOUNDARY",
      entryId: "b",
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe("a");
  });

  it("increments version and marks dirty", () => {
    const state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
        makeEntry({ id: "b", position: 1, startPage: 5 }),
      ],
    });

    const result = boundaryReducer(state, {
      type: "DELETE_BOUNDARY",
      entryId: "b",
    });

    expect(result.version).toBe(1);
    expect(result.isDirty).toBe(true);
  });
});

describe("INDENT", () => {
  it("nests entry under its previous sibling", () => {
    const state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
        makeEntry({ id: "b", position: 1, startPage: 5 }),
        makeEntry({ id: "c", position: 2, startPage: 10 }),
      ],
    });

    const result = boundaryReducer(state, {
      type: "INDENT",
      entryId: "b",
    });

    const indented = result.entries.find((e) => e.id === "b")!;
    expect(indented.parentId).toBe("a");
  });

  it("is a no-op on first sibling (no previous sibling)", () => {
    const state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
        makeEntry({ id: "b", position: 1, startPage: 5 }),
      ],
    });

    const result = boundaryReducer(state, {
      type: "INDENT",
      entryId: "a",
    });

    const entry = result.entries.find((e) => e.id === "a")!;
    expect(entry.parentId).toBeNull();
  });

  it("increments version on successful indent", () => {
    const state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
        makeEntry({ id: "b", position: 1, startPage: 5 }),
      ],
    });

    const result = boundaryReducer(state, {
      type: "INDENT",
      entryId: "b",
    });

    expect(result.version).toBe(1);
  });

  it("does not increment version on no-op indent", () => {
    const state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
      ],
    });

    const result = boundaryReducer(state, {
      type: "INDENT",
      entryId: "a",
    });

    expect(result.version).toBe(0);
  });
});

describe("OUTDENT", () => {
  it("promotes a child to its parent's level", () => {
    const state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
        makeEntry({
          id: "b",
          parentId: "a",
          position: 0,
          startPage: 3,
          endPage: 5,
        }),
        makeEntry({ id: "c", position: 1, startPage: 10 }),
      ],
    });

    const result = boundaryReducer(state, {
      type: "OUTDENT",
      entryId: "b",
    });

    const outdented = result.entries.find((e) => e.id === "b")!;
    expect(outdented.parentId).toBeNull();
  });

  it("inserts after parent in parent's sibling list", () => {
    const state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
        makeEntry({
          id: "b",
          parentId: "a",
          position: 0,
          startPage: 3,
          endPage: 5,
        }),
        makeEntry({ id: "c", position: 1, startPage: 10 }),
      ],
    });

    const result = boundaryReducer(state, {
      type: "OUTDENT",
      entryId: "b",
    });

    // After outdent, top-level entries sorted by startPage: a(1), b(3), c(10)
    const topLevel = result.entries
      .filter((e) => e.parentId === null)
      .sort((a, b) => a.position - b.position);

    expect(topLevel[0].id).toBe("a");
    expect(topLevel[1].id).toBe("b");
    expect(topLevel[2].id).toBe("c");
  });

  it("is a no-op on top-level entry", () => {
    const state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
      ],
    });

    const result = boundaryReducer(state, {
      type: "OUTDENT",
      entryId: "a",
    });

    const entry = result.entries.find((e) => e.id === "a")!;
    expect(entry.parentId).toBeNull();
    expect(result.version).toBe(0);
  });

  it("increments version on successful outdent", () => {
    const state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
        makeEntry({
          id: "b",
          parentId: "a",
          position: 0,
          startPage: 3,
          endPage: 5,
        }),
      ],
    });

    const result = boundaryReducer(state, {
      type: "OUTDENT",
      entryId: "b",
    });

    expect(result.version).toBe(1);
  });
});

describe("SET_TYPE", () => {
  it("updates entry type and marks dirty", () => {
    const state = makeState({
      entries: [makeEntry({ id: "a", position: 0, startPage: 1 })],
    });

    const result = boundaryReducer(state, {
      type: "SET_TYPE",
      entryId: "a",
      entryType: "item",
    });

    const entry = result.entries.find((e) => e.id === "a")!;
    expect(entry.type).toBe("item");
    expect(result.isDirty).toBe(true);
    expect(result.saveStatus).toBe("unsaved");
  });

  it("can set type to null (unset)", () => {
    const state = makeState({
      entries: [makeEntry({ id: "a", position: 0, startPage: 1, type: "item" })],
    });

    const result = boundaryReducer(state, {
      type: "SET_TYPE",
      entryId: "a",
      entryType: null,
    });

    const entry = result.entries.find((e) => e.id === "a")!;
    expect(entry.type).toBeNull();
  });
});

describe("SET_TITLE", () => {
  it("updates entry title and marks dirty", () => {
    const state = makeState({
      entries: [makeEntry({ id: "a", position: 0, startPage: 1 })],
    });

    const result = boundaryReducer(state, {
      type: "SET_TITLE",
      entryId: "a",
      title: "Folio 1",
    });

    const entry = result.entries.find((e) => e.id === "a")!;
    expect(entry.title).toBe("Folio 1");
    expect(result.isDirty).toBe(true);
    expect(result.saveStatus).toBe("unsaved");
  });
});

describe("SET_END_PAGE", () => {
  it("updates endPage for entry", () => {
    const state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
        makeEntry({
          id: "child",
          parentId: "a",
          position: 0,
          startPage: 1,
          endPage: 3,
        }),
      ],
    });

    const result = boundaryReducer(state, {
      type: "SET_END_PAGE",
      entryId: "child",
      endPage: 5,
    });

    const entry = result.entries.find((e) => e.id === "child")!;
    expect(entry.endPage).toBe(5);
    expect(result.isDirty).toBe(true);
  });
});

describe("SET_END_Y", () => {
  it("updates endY for entry", () => {
    const state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
        makeEntry({
          id: "child",
          parentId: "a",
          position: 0,
          startPage: 1,
          endPage: 3,
          endY: null,
        }),
      ],
    });

    const result = boundaryReducer(state, {
      type: "SET_END_Y",
      entryId: "child",
      endY: 0.75,
    });

    const entry = result.entries.find((e) => e.id === "child")!;
    expect(entry.endY).toBe(0.75);
    expect(result.isDirty).toBe(true);
  });
});

describe("MARK_SAVED", () => {
  it("sets isDirty to false and saveStatus to saved", () => {
    const state = makeState({ isDirty: true, saveStatus: "saving" });
    const result = boundaryReducer(state, { type: "MARK_SAVED" });

    expect(result.isDirty).toBe(false);
    expect(result.saveStatus).toBe("saved");
  });
});

describe("MARK_SAVING", () => {
  it("sets saveStatus to saving", () => {
    const state = makeState({ isDirty: true, saveStatus: "unsaved" });
    const result = boundaryReducer(state, { type: "MARK_SAVING" });

    expect(result.saveStatus).toBe("saving");
  });
});

describe("MARK_DIRTY", () => {
  it("sets isDirty to true and saveStatus to unsaved", () => {
    const state = makeState({ isDirty: false, saveStatus: "saved" });
    const result = boundaryReducer(state, { type: "MARK_DIRTY" });

    expect(result.isDirty).toBe(true);
    expect(result.saveStatus).toBe("unsaved");
  });
});

describe("version increments", () => {
  it("structural changes (ADD, DELETE, MOVE, INDENT, OUTDENT) increment version", () => {
    let state = makeState({
      entries: [
        makeEntry({ id: "a", position: 0, startPage: 1 }),
        makeEntry({ id: "b", position: 1, startPage: 5 }),
      ],
    });

    // ADD increments
    state = boundaryReducer(state, { type: "ADD_BOUNDARY", startPage: 8, id: "c" });
    expect(state.version).toBe(1);

    // MOVE increments
    state = boundaryReducer(state, { type: "MOVE_BOUNDARY", entryId: "c", startPage: 3 });
    expect(state.version).toBe(2);

    // DELETE increments
    state = boundaryReducer(state, { type: "DELETE_BOUNDARY", entryId: "c" });
    expect(state.version).toBe(3);

    // INDENT increments
    state = boundaryReducer(state, { type: "INDENT", entryId: "b" });
    expect(state.version).toBe(4);

    // OUTDENT increments
    state = boundaryReducer(state, { type: "OUTDENT", entryId: "b" });
    expect(state.version).toBe(5);
  });

  it("metadata changes (SET_TYPE, SET_TITLE, SET_END_PAGE) do not increment version", () => {
    const state = makeState({
      entries: [makeEntry({ id: "a", position: 0, startPage: 1 })],
      version: 0,
    });

    let result = boundaryReducer(state, { type: "SET_TYPE", entryId: "a", entryType: "item" });
    expect(result.version).toBe(0);

    result = boundaryReducer(result, { type: "SET_TITLE", entryId: "a", title: "Test" });
    expect(result.version).toBe(0);

    result = boundaryReducer(result, { type: "SET_END_PAGE", entryId: "a", endPage: 5 });
    expect(result.version).toBe(0);
  });
});

describe("getEffectiveEndPage handles y-positions", () => {
  it("child containment respects parent y-position range", () => {
    // Parent at page 5, y=0.3. Next sibling at page 10.
    // Child should be movable to page 5 y=0.5 (within parent's range)
    const state = makeState({
      entries: [
        makeEntry({ id: "parent", position: 0, startPage: 5, startY: 0.3 }),
        makeEntry({ id: "next-sibling", position: 1, startPage: 10 }),
        makeEntry({
          id: "child",
          parentId: "parent",
          position: 0,
          startPage: 6,
          endPage: 7,
        }),
      ],
    });

    // Move child to page 5, y=0.5 (after parent's y=0.3 on same page)
    const result = boundaryReducer(state, {
      type: "MOVE_BOUNDARY",
      entryId: "child",
      startPage: 5,
      toY: 0.5,
    });

    const child = result.entries.find((e) => e.id === "child")!;
    expect(child.startPage).toBe(5);
    expect(child.startY).toBe(0.5);
  });
});
