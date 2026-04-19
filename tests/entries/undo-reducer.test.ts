/**
 * Tests — undo reducer
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import type { Entry, BoundaryState, BoundaryAction } from "../../app/lib/boundary-types";
import {
  boundaryReducer,
  createInitialState,
} from "../../app/lib/boundary-reducer";
import { createUndoableDispatch } from "../../app/lib/use-undoable-reducer";

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
    title: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

/**
 * Helper: create a testable undo/redo state machine.
 * Uses the pure logic function (not the React hook) for direct testing.
 */
function createTestUndoable(initialState: BoundaryState, maxHistory = 100) {
  let history = {
    past: [] as BoundaryState[],
    present: initialState,
    future: [] as BoundaryState[],
  };

  const getState = () => history;

  const dispatch = (action: BoundaryAction | { type: "UNDO" } | { type: "REDO" }) => {
    history = createUndoableDispatch(boundaryReducer, maxHistory)(history, action);
  };

  return { getState, dispatch };
}

describe("undo/redo reducer wrapper", () => {
  it("dispatch(ADD_BOUNDARY) then dispatch(UNDO) restores previous state", () => {
    const initial = createInitialState([
      makeEntry({ id: "a", position: 0, startPage: 1 }),
    ]);
    const { getState, dispatch } = createTestUndoable(initial);

    dispatch({ type: "ADD_BOUNDARY", startPage: 5, id: "b" });
    expect(getState().present.entries).toHaveLength(2);

    dispatch({ type: "UNDO" });
    expect(getState().present.entries).toHaveLength(1);
    expect(getState().present.entries[0].id).toBe("a");
  });

  it("dispatch(UNDO) then dispatch(REDO) restores the undone state", () => {
    const initial = createInitialState([
      makeEntry({ id: "a", position: 0, startPage: 1 }),
    ]);
    const { getState, dispatch } = createTestUndoable(initial);

    dispatch({ type: "ADD_BOUNDARY", startPage: 5, id: "b" });
    dispatch({ type: "UNDO" });
    dispatch({ type: "REDO" });

    expect(getState().present.entries).toHaveLength(2);
    expect(getState().present.entries.find((e) => e.id === "b")).toBeDefined();
  });

  it("canUndo is false initially, true after a structural action", () => {
    const initial = createInitialState([
      makeEntry({ id: "a", position: 0, startPage: 1 }),
    ]);
    const { getState, dispatch } = createTestUndoable(initial);

    expect(getState().past.length).toBe(0); // canUndo = false

    dispatch({ type: "ADD_BOUNDARY", startPage: 5, id: "b" });
    expect(getState().past.length).toBeGreaterThan(0); // canUndo = true
  });

  it("canRedo is false initially, true after an undo", () => {
    const initial = createInitialState([
      makeEntry({ id: "a", position: 0, startPage: 1 }),
    ]);
    const { getState, dispatch } = createTestUndoable(initial);

    expect(getState().future.length).toBe(0); // canRedo = false

    dispatch({ type: "ADD_BOUNDARY", startPage: 5, id: "b" });
    dispatch({ type: "UNDO" });
    expect(getState().future.length).toBeGreaterThan(0); // canRedo = true
  });

  it("MARK_SAVED, MARK_SAVING, MARK_DIRTY do NOT enter undo history", () => {
    const initial = createInitialState([
      makeEntry({ id: "a", position: 0, startPage: 1 }),
    ]);
    const { getState, dispatch } = createTestUndoable(initial);

    dispatch({ type: "MARK_DIRTY" });
    expect(getState().past.length).toBe(0); // canUndo stays false

    dispatch({ type: "MARK_SAVING" });
    expect(getState().past.length).toBe(0);

    dispatch({ type: "MARK_SAVED" });
    expect(getState().past.length).toBe(0);
  });

  it("INIT does not enter undo history", () => {
    const initial = createInitialState([
      makeEntry({ id: "a", position: 0, startPage: 1 }),
    ]);
    const { getState, dispatch } = createTestUndoable(initial);

    dispatch({
      type: "INIT",
      entries: [
        makeEntry({ id: "x", position: 0, startPage: 1 }),
        makeEntry({ id: "y", position: 1, startPage: 5 }),
      ],
    });

    expect(getState().past.length).toBe(0);
    expect(getState().present.entries).toHaveLength(2);
  });

  it("new action after undo clears the redo stack", () => {
    const initial = createInitialState([
      makeEntry({ id: "a", position: 0, startPage: 1 }),
    ]);
    const { getState, dispatch } = createTestUndoable(initial);

    dispatch({ type: "ADD_BOUNDARY", startPage: 5, id: "b" });
    dispatch({ type: "UNDO" });
    expect(getState().future.length).toBe(1);

    // New action should clear redo
    dispatch({ type: "ADD_BOUNDARY", startPage: 8, id: "c" });
    expect(getState().future.length).toBe(0);
  });

  it("history capped at maxHistory -- 101st action drops oldest", () => {
    const initial = createInitialState([
      makeEntry({ id: "a", position: 0, startPage: 1 }),
    ]);
    const { getState, dispatch } = createTestUndoable(initial, 100);

    // Dispatch 101 actions
    for (let i = 0; i < 101; i++) {
      dispatch({ type: "ADD_BOUNDARY", startPage: i + 2, id: `entry-${i}` });
    }

    // Past should be capped at 100
    expect(getState().past.length).toBe(100);
  });

  it("no-op actions (reducer returns same reference) don't push to history", () => {
    const initial = createInitialState([
      makeEntry({ id: "a", position: 0, startPage: 1 }),
    ]);
    const { getState, dispatch } = createTestUndoable(initial);

    // DELETE on the first (protected) entry is a no-op
    dispatch({ type: "DELETE_BOUNDARY", entryId: "a" });
    expect(getState().past.length).toBe(0);
  });

  it("multiple undos walk back through history correctly", () => {
    const initial = createInitialState([
      makeEntry({ id: "a", position: 0, startPage: 1 }),
    ]);
    const { getState, dispatch } = createTestUndoable(initial);

    dispatch({ type: "ADD_BOUNDARY", startPage: 5, id: "b" });
    dispatch({ type: "ADD_BOUNDARY", startPage: 10, id: "c" });
    dispatch({ type: "ADD_BOUNDARY", startPage: 15, id: "d" });

    expect(getState().present.entries).toHaveLength(4);

    dispatch({ type: "UNDO" });
    expect(getState().present.entries).toHaveLength(3);

    dispatch({ type: "UNDO" });
    expect(getState().present.entries).toHaveLength(2);

    dispatch({ type: "UNDO" });
    expect(getState().present.entries).toHaveLength(1);
    expect(getState().present.entries[0].id).toBe("a");

    // Can't undo further
    dispatch({ type: "UNDO" });
    expect(getState().present.entries).toHaveLength(1);
  });

  it("UNDO with empty past is a no-op", () => {
    const initial = createInitialState([
      makeEntry({ id: "a", position: 0, startPage: 1 }),
    ]);
    const { getState, dispatch } = createTestUndoable(initial);

    const before = getState().present;
    dispatch({ type: "UNDO" });
    expect(getState().present).toBe(before);
  });

  it("REDO with empty future is a no-op", () => {
    const initial = createInitialState([
      makeEntry({ id: "a", position: 0, startPage: 1 }),
    ]);
    const { getState, dispatch } = createTestUndoable(initial);

    const before = getState().present;
    dispatch({ type: "REDO" });
    expect(getState().present).toBe(before);
  });
});
