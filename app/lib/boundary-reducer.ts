import type { Entry, BoundaryAction, BoundaryState } from "./boundary-types";

/**
 * Create the initial boundary state from a list of entries loaded from the server.
 */
export function createInitialState(entries: Entry[]): BoundaryState {
  return {
    entries: [...entries],
    isDirty: false,
    saveStatus: "saved",
    version: 0,
  };
}

/**
 * Pure reducer for all boundary/entry state management.
 * No side effects -- ID generation for ADD_BOUNDARY uses the optional `id` field
 * on the action, falling back to crypto.randomUUID().
 */
export function boundaryReducer(
  state: BoundaryState,
  action: BoundaryAction
): BoundaryState {
  switch (action.type) {
    case "INIT": {
      return {
        entries: [...action.entries],
        isDirty: false,
        saveStatus: "saved",
        version: state.version,
      };
    }

    case "ADD_BOUNDARY": {
      const now = Date.now();
      const newEntry: Entry = {
        id: action.id ?? crypto.randomUUID(),
        volumeId: state.entries[0]?.volumeId ?? "",
        parentId: null,
        position: 0, // will be renumbered
        startPage: action.afterPage,
        endPage: null,
        type: null,
        title: null,
        createdAt: now,
        updatedAt: now,
      };

      const entries = [...state.entries, newEntry];
      return {
        entries: renumberSiblings(entries),
        isDirty: true,
        saveStatus: "unsaved",
        version: state.version + 1,
      };
    }

    case "MOVE_BOUNDARY": {
      const entry = state.entries.find((e) => e.id === action.entryId);
      if (!entry) return state;

      // Validate containment for child entries
      if (entry.parentId !== null) {
        const parent = state.entries.find((e) => e.id === entry.parentId);
        if (parent) {
          const parentEnd = getEffectiveEndPage(parent, state.entries);
          if (action.toPage < parent.startPage || action.toPage > parentEnd) {
            return state; // no-op: would violate containment
          }
        }
      }

      const entries = state.entries.map((e) =>
        e.id === action.entryId
          ? { ...e, startPage: action.toPage, updatedAt: Date.now() }
          : e
      );

      return {
        entries: renumberSiblings(entries),
        isDirty: true,
        saveStatus: "unsaved",
        version: state.version + 1,
      };
    }

    case "DELETE_BOUNDARY": {
      const entry = state.entries.find((e) => e.id === action.entryId);
      if (!entry) return state;

      // First entry protection: cannot delete the first top-level entry
      if (entry.parentId === null && entry.position === 0) {
        // Check if this is truly the first top-level entry by startPage
        const topLevel = state.entries
          .filter((e) => e.parentId === null)
          .sort((a, b) => a.startPage - b.startPage);
        if (topLevel.length > 0 && topLevel[0].id === entry.id) {
          return state; // no-op
        }
      }

      // Collect all descendants to remove
      const idsToRemove = new Set<string>();
      idsToRemove.add(action.entryId);
      collectDescendants(action.entryId, state.entries, idsToRemove);

      const entries = state.entries.filter((e) => !idsToRemove.has(e.id));

      return {
        entries: renumberSiblings(entries),
        isDirty: true,
        saveStatus: "unsaved",
        version: state.version + 1,
      };
    }

    case "INDENT": {
      const entry = state.entries.find((e) => e.id === action.entryId);
      if (!entry) return state;

      // Find the previous sibling at the same level
      const siblings = state.entries
        .filter((e) => e.parentId === entry.parentId)
        .sort((a, b) => a.startPage - b.startPage);

      const siblingIndex = siblings.findIndex((s) => s.id === entry.id);
      if (siblingIndex <= 0) return state; // no-op: first sibling

      const previousSibling = siblings[siblingIndex - 1];

      // Indent: set parentId to previous sibling
      const entries = state.entries.map((e) =>
        e.id === action.entryId
          ? { ...e, parentId: previousSibling.id, updatedAt: Date.now() }
          : e
      );

      return {
        entries: renumberSiblings(entries),
        isDirty: true,
        saveStatus: "unsaved",
        version: state.version + 1,
      };
    }

    case "OUTDENT": {
      const entry = state.entries.find((e) => e.id === action.entryId);
      if (!entry || entry.parentId === null) return state; // no-op: already top-level

      const parent = state.entries.find((e) => e.id === entry.parentId);
      if (!parent) return state;

      // Promote to parent's level
      const entries = state.entries.map((e) =>
        e.id === action.entryId
          ? {
              ...e,
              parentId: parent.parentId,
              endPage: null, // clear endPage when becoming top-level
              updatedAt: Date.now(),
            }
          : e
      );

      return {
        entries: renumberSiblings(entries),
        isDirty: true,
        saveStatus: "unsaved",
        version: state.version + 1,
      };
    }

    case "SET_TYPE": {
      const entries = state.entries.map((e) =>
        e.id === action.entryId
          ? { ...e, type: action.entryType, updatedAt: Date.now() }
          : e
      );

      return {
        ...state,
        entries,
        isDirty: true,
        saveStatus: "unsaved",
      };
    }

    case "SET_TITLE": {
      const entries = state.entries.map((e) =>
        e.id === action.entryId
          ? { ...e, title: action.title, updatedAt: Date.now() }
          : e
      );

      return {
        ...state,
        entries,
        isDirty: true,
        saveStatus: "unsaved",
      };
    }

    case "SET_END_PAGE": {
      const entries = state.entries.map((e) =>
        e.id === action.entryId
          ? { ...e, endPage: action.endPage, updatedAt: Date.now() }
          : e
      );

      return {
        ...state,
        entries,
        isDirty: true,
        saveStatus: "unsaved",
      };
    }

    case "MARK_SAVED":
      return { ...state, isDirty: false, saveStatus: "saved" };

    case "MARK_SAVING":
      return { ...state, saveStatus: "saving" };

    case "MARK_DIRTY":
      return { ...state, isDirty: true, saveStatus: "unsaved" };

    default:
      return state;
  }
}

// --- Helper functions ---

/**
 * Renumber siblings by startPage within each parent group.
 * Assigns position values 0, 1, 2... based on startPage order.
 */
function renumberSiblings(entries: Entry[]): Entry[] {
  // Group by parentId
  const groups = new Map<string | null, Entry[]>();
  for (const entry of entries) {
    const key = entry.parentId;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(entry);
  }

  // Sort each group by startPage and assign positions
  const positionMap = new Map<string, number>();
  for (const children of groups.values()) {
    children.sort((a, b) => a.startPage - b.startPage);
    children.forEach((child, index) => {
      positionMap.set(child.id, index);
    });
  }

  return entries.map((e) => ({
    ...e,
    position: positionMap.get(e.id) ?? e.position,
  }));
}

/**
 * Recursively collect all descendant IDs of a given entry.
 */
function collectDescendants(
  parentId: string,
  entries: Entry[],
  result: Set<string>
): void {
  const children = entries.filter((e) => e.parentId === parentId);
  for (const child of children) {
    result.add(child.id);
    collectDescendants(child.id, entries, result);
  }
}

/**
 * Get the effective end page for an entry.
 * For entries with an explicit endPage, return that.
 * For top-level entries, the end is the next sibling's startPage - 1.
 */
function getEffectiveEndPage(entry: Entry, entries: Entry[]): number {
  if (entry.endPage !== null) return entry.endPage;

  // Find next sibling
  const siblings = entries
    .filter((e) => e.parentId === entry.parentId && e.id !== entry.id)
    .sort((a, b) => a.startPage - b.startPage);

  const nextSibling = siblings.find((s) => s.startPage > entry.startPage);
  if (nextSibling) return nextSibling.startPage - 1;

  // No next sibling -- return a very large number (effectively end of volume)
  return Number.MAX_SAFE_INTEGER;
}
