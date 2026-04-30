/**
 * Miller Columns Explorer
 *
 * A left-to-right column view for browsing the description hierarchy.
 * Each column renders the children of the selection in the previous
 * column, so a cataloguer can drill from fonds into a specific item in
 * a fluid horizontal sweep. Uses `@tanstack/react-virtual` to keep
 * each column snappy even on a fonds with tens of thousands of
 * children. State lives in a reducer so history (back/forward) stays
 * consistent with what the user sees.
 *
 * @version v0.3.0
 */

import { useReducer, useEffect, useCallback, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { MillerColumn } from "./miller-column";
import { Loader2 } from "lucide-react";

// ---------------------------------------------------------------------------
// Types (exported for use by sibling components)
// ---------------------------------------------------------------------------

export interface TreeItem {
  id: string;
  title: string;
  referenceCode: string;
  descriptionLevel: string;
  dateExpression: string | null;
  scopeContent: string | null;
  childCount: number;
  isPublished: boolean;
  position: number;
  repositoryId: string;
  kind?: "repository" | "description";
}

interface Column {
  parentId: string; // "root" or parent description ID
  title: string;
  items: TreeItem[];
}

// ---------------------------------------------------------------------------
// State & actions
// ---------------------------------------------------------------------------

interface TreeState {
  columns: Column[];
  selectionPath: string[]; // IDs of selected items (one per column)
  cache: Map<string, TreeItem[]>; // parentId -> children
  loading: string | null; // ID currently loading
  filterQueries: string[]; // per-column filter text
}

type TreeAction =
  | { type: "SELECT_ITEM"; depth: number; item: TreeItem }
  | { type: "LOAD_CHILDREN_START"; parentId: string }
  | { type: "LOAD_CHILDREN_SUCCESS"; parentId: string; children: TreeItem[]; title: string }
  | { type: "FILTER_COLUMN"; depth: number; query: string }
  | { type: "RESTORE_STATE"; state: SerializedTreeState };

interface SerializedTreeState {
  columns: Column[];
  selectionPath: string[];
  filterQueries: string[];
  cache: Record<string, TreeItem[]>;
}

const SESSION_KEY = "descriptions-tree-state";

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function treeReducer(state: TreeState, action: TreeAction): TreeState {
  switch (action.type) {
    case "SELECT_ITEM": {
      // Collapse columns to the right of the selected depth
      const nextColumns = state.columns.slice(0, action.depth + 1);
      const nextPath = state.selectionPath.slice(0, action.depth);
      nextPath[action.depth] = action.item.id;
      const nextFilters = state.filterQueries.slice(0, action.depth + 1);
      return {
        ...state,
        columns: nextColumns,
        selectionPath: nextPath,
        filterQueries: nextFilters,
      };
    }

    case "LOAD_CHILDREN_START": {
      return { ...state, loading: action.parentId };
    }

    case "LOAD_CHILDREN_SUCCESS": {
      const newCache = new Map(state.cache);
      newCache.set(action.parentId, action.children);
      const newColumn: Column = {
        parentId: action.parentId,
        title: action.title,
        items: action.children,
      };
      return {
        ...state,
        columns: [...state.columns, newColumn],
        cache: newCache,
        loading: null,
        filterQueries: [...state.filterQueries, ""],
      };
    }

    case "FILTER_COLUMN": {
      const nextFilters = [...state.filterQueries];
      nextFilters[action.depth] = action.query;
      return { ...state, filterQueries: nextFilters };
    }

    case "RESTORE_STATE": {
      const restoredCache = new Map<string, TreeItem[]>();
      for (const [key, val] of Object.entries(action.state.cache)) {
        restoredCache.set(key, val);
      }
      return {
        columns: action.state.columns,
        selectionPath: action.state.selectionPath,
        cache: restoredCache,
        loading: null,
        filterQueries: action.state.filterQueries,
      };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const initialState: TreeState = {
  columns: [],
  selectionPath: [],
  cache: new Map(),
  loading: null,
  filterQueries: [],
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MillerColumnsProps {
  onSelectItem?: (item: TreeItem | null) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MillerColumns({ onSelectItem }: MillerColumnsProps) {
  const { t } = useTranslation("descriptions_admin");
  const [state, dispatch] = useReducer(treeReducer, initialState);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const initialised = useRef(false);

  // -----------------------------------------------------------------------
  // Fetch helper
  // -----------------------------------------------------------------------

  const fetchChildren = useCallback(async (parentId: string): Promise<TreeItem[]> => {
    const res = await fetch(
      `/admin/descriptions/api/children/${parentId}?_=${Date.now()}`,
      { cache: "no-store", headers: { Accept: "application/json" } }
    );
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  }, []);

  // -----------------------------------------------------------------------
  // Initialise: restore from sessionStorage or fetch root
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (initialised.current) return;
    initialised.current = true;

    const saved = sessionStorage.getItem(SESSION_KEY);
    if (saved) {
      try {
        const parsed: SerializedTreeState = JSON.parse(saved);
        if (parsed.columns && parsed.columns.length > 0) {
          dispatch({ type: "RESTORE_STATE", state: parsed });
          return;
        }
      } catch {
        // Ignore corrupt state
      }
    }

    // Fetch root items
    fetchChildren("root").then((items) => {
      dispatch({
        type: "LOAD_CHILDREN_SUCCESS",
        parentId: "root",
        children: items,
        title: t("root_column_title"),
      });
    });
  }, [fetchChildren, t]);

  // -----------------------------------------------------------------------
  // Report selected item to parent
  // -----------------------------------------------------------------------

  const selectedItem = useMemo(() => {
    if (state.selectionPath.length === 0) return null;
    const lastSelectedId = state.selectionPath[state.selectionPath.length - 1];
    for (const col of state.columns) {
      const found = col.items.find((item) => item.id === lastSelectedId);
      if (found) return found;
    }
    return null;
  }, [state.selectionPath, state.columns]);

  useEffect(() => {
    onSelectItem?.(selectedItem);
  }, [selectedItem, onSelectItem]);

  // -----------------------------------------------------------------------
  // Item click handler
  // -----------------------------------------------------------------------

  const handleItemClick = useCallback(
    async (depth: number, item: TreeItem) => {
      dispatch({ type: "SELECT_ITEM", depth, item });

      if (item.childCount > 0) {
        // Check cache first
        const cached = state.cache.get(item.id);
        if (cached) {
          dispatch({
            type: "LOAD_CHILDREN_SUCCESS",
            parentId: item.id,
            children: cached,
            title: item.title,
          });
        } else {
          dispatch({ type: "LOAD_CHILDREN_START", parentId: item.id });
          try {
            const children = await fetchChildren(item.id);
            dispatch({
              type: "LOAD_CHILDREN_SUCCESS",
              parentId: item.id,
              children,
              title: item.title,
            });
          } catch (error) {
            console.error("Error fetching children:", error);
            // Clear loading state on error
            dispatch({
              type: "LOAD_CHILDREN_SUCCESS",
              parentId: item.id,
              children: [],
              title: item.title,
            });
          }
        }

        // Scroll to show new column
        setTimeout(() => {
          scrollContainerRef.current?.scrollTo({
            left: scrollContainerRef.current.scrollWidth,
            behavior: "smooth",
          });
        }, 50);
      }
    },
    [state.cache, fetchChildren]
  );

  // -----------------------------------------------------------------------
  // Serialize state to sessionStorage before navigation
  // -----------------------------------------------------------------------

  const saveState = useCallback(() => {
    const serialized: SerializedTreeState = {
      columns: state.columns,
      selectionPath: state.selectionPath,
      filterQueries: state.filterQueries,
      cache: Object.fromEntries(state.cache),
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(serialized));
  }, [state]);

  // Save on visibility/unload only — never on cleanup, which races with state updates.
  // Use a ref so the listeners always read the latest state without being re-bound.
  const saveStateRef = useRef(saveState);
  useEffect(() => {
    saveStateRef.current = saveState;
  }, [saveState]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") saveStateRef.current();
    };
    const handleBeforeUnload = () => saveStateRef.current();
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  // Persist on every state change (debounce-light, fine for small state)
  useEffect(() => {
    if (state.columns.length > 0) saveState();
  }, [state, saveState]);

  // -----------------------------------------------------------------------
  // Compute ancestor IDs for styling
  // -----------------------------------------------------------------------

  const ancestorIds = useMemo(() => {
    const set = new Set<string>();
    // All items in selectionPath except the last one are ancestors
    for (let i = 0; i < state.selectionPath.length - 1; i++) {
      set.add(state.selectionPath[i]);
    }
    return set;
  }, [state.selectionPath]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (state.columns.length === 0 && !state.loading) {
    return null; // Not yet initialised
  }

  return (
    <div
      className="relative overflow-hidden rounded-lg border border-stone-200"
      style={{ minHeight: 400, maxHeight: 600 }}
    >
      <div
        ref={scrollContainerRef}
        className="flex h-full overflow-x-auto overflow-y-hidden"
        style={{ minHeight: 400, maxHeight: 600 }}
      >
        {state.columns.map((col, depth) => (
          <MillerColumn
            key={`${col.parentId}-${depth}`}
            title={col.title}
            items={col.items}
            filterQuery={state.filterQueries[depth] || ""}
            selectedId={state.selectionPath[depth] || null}
            ancestorIds={ancestorIds}
            onFilterChange={(query) =>
              dispatch({ type: "FILTER_COLUMN", depth, query })
            }
            onItemClick={(item) => handleItemClick(depth, item)}
          />
        ))}

        {/* Loading indicator */}
        {state.loading && (
          <div className="flex w-[340px] flex-none items-center justify-center border-r border-stone-200">
            <Loader2 className="h-5 w-5 animate-spin text-stone-500" />
          </div>
        )}
      </div>
    </div>
  );
}
