/**
 * Miller Columns Explorer
 *
 * This component is the left-to-right column view for browsing the
 * description hierarchy. Each column renders the children of the selection
 * in the previous column, so a cataloguer can drill from fonds into a
 * specific item in a fluid horizontal sweep. Uses
 * `@tanstack/react-virtual` to keep each column snappy even on a fonds
 * with tens of thousands of children. State lives in a reducer so history
 * (back/forward) stays consistent with what the user sees.
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
  | { type: "RESTORE_STATE"; state: SerializedTreeState }
  | { type: "REVALIDATE_SUCCESS"; fresh: Map<string, TreeItem[]> };

/**
 * The sessionStorage payload. Note what is NOT here: the parentId ->
 * children cache. Persisting the whole cache is what let a branch that
 * was empty at save time stay empty for the rest of the browser
 * session, surviving reloads, because a cached empty list is
 * indistinguishable from a genuinely childless node. The visible
 * columns already carry everything needed to repaint, so the cache is
 * rebuilt from them on restore and every restored list is refetched in
 * the background.
 */
export interface SerializedTreeState {
  version: number;
  savedAt: number; // epoch ms, stamped at save time
  columns: Column[];
  selectionPath: string[];
  filterQueries: string[];
}

/**
 * Storage key. Deliberately NOT namespaced by tenant: every tenant is
 * served from its own origin (`<slug>.fisqua.org`, `<slug>.localhost`,
 * `<slug>.fisqua.test`, plus the legacy single-tenant host
 * `catalogacion.zasqua.org` — see `app/lib/tenant.ts`
 * `getTenantFromRequest`), and the workspace switcher navigates by
 * absolute cross-subdomain URL rather than swapping tenants in place.
 * sessionStorage is partitioned per origin, so the browser already
 * isolates one workspace's tree state from another's; a tenant prefix
 * would add a key the component has no way to derive client-side
 * without new prop plumbing, and would buy nothing.
 */
const SESSION_KEY = "descriptions-tree-state";

/**
 * Bump whenever `SerializedTreeState` changes shape. A payload written
 * by an older build is discarded rather than coerced — a half-understood
 * restore paints a tree that does not match the database.
 * v2 dropped the persisted children cache (see above).
 */
export const TREE_STATE_SCHEMA_VERSION = 2;

/**
 * How long a saved tree may be trusted for the instant repaint. Thirty
 * minutes is longer than the gap between two page views in one
 * cataloguing sitting, and short enough that a tab left open over lunch
 * repaints from the server instead of from a pre-import snapshot. The
 * TTL is a floor on staleness, not the correctness guarantee: every
 * restored column is revalidated against the API on mount regardless of
 * age.
 */
export const TREE_STATE_TTL_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Persistence helpers (pure — exported for tests)
// ---------------------------------------------------------------------------

/** The persisted slice of the reducer state. */
type PersistableTreeState = Pick<
  TreeState,
  "columns" | "selectionPath" | "filterQueries"
>;

export function serializeTreeState(
  state: PersistableTreeState,
  now: number,
): SerializedTreeState {
  return {
    version: TREE_STATE_SCHEMA_VERSION,
    savedAt: now,
    columns: state.columns,
    selectionPath: state.selectionPath,
    filterQueries: state.filterQueries,
  };
}

/**
 * Parse a sessionStorage payload, returning `null` for anything that
 * must not be trusted: absent, unparseable, written by another schema
 * version, missing or non-numeric `savedAt`, older than the TTL, or
 * carrying no columns to paint. A clock that moved backwards (savedAt
 * in the future) also fails — negative age is not evidence of freshness.
 */
export function parseSavedTreeState(
  raw: string | null,
  now: number,
): SerializedTreeState | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const candidate = parsed as Partial<SerializedTreeState>;
  if (candidate.version !== TREE_STATE_SCHEMA_VERSION) return null;
  if (typeof candidate.savedAt !== "number" || !Number.isFinite(candidate.savedAt)) {
    return null;
  }

  const age = now - candidate.savedAt;
  if (age < 0 || age > TREE_STATE_TTL_MS) return null;

  if (!Array.isArray(candidate.columns) || candidate.columns.length === 0) return null;

  return {
    version: candidate.version,
    savedAt: candidate.savedAt,
    columns: candidate.columns,
    selectionPath: Array.isArray(candidate.selectionPath) ? candidate.selectionPath : [],
    filterQueries: Array.isArray(candidate.filterQueries) ? candidate.filterQueries : [],
  };
}

/**
 * Fold freshly-fetched children back into the painted columns. Each
 * column whose parent was successfully refetched takes the fresh list;
 * a column whose fetch failed keeps what it had, so a network blip
 * blanks nothing. Where the item selected in a column is no longer in
 * that column's fresh list, the branch below it is gone: the selection
 * and every deeper column are dropped rather than left pointing at
 * records that no longer exist.
 */
export function reconcileRevalidatedColumns(
  state: PersistableTreeState,
  fresh: Map<string, TreeItem[]>,
): PersistableTreeState {
  const columns: Column[] = [];
  const selectionPath: string[] = [];
  const filterQueries: string[] = [];

  for (let depth = 0; depth < state.columns.length; depth++) {
    const column = state.columns[depth];
    const freshItems = fresh.get(column.parentId);
    const items = freshItems ?? column.items;

    columns.push(freshItems ? { ...column, items: freshItems } : column);
    filterQueries.push(state.filterQueries[depth] ?? "");

    const selectedId = state.selectionPath[depth];
    if (selectedId === undefined) break;
    if (!items.some((item) => item.id === selectedId)) break;
    selectionPath.push(selectedId);
  }

  return { columns, selectionPath, filterQueries };
}

/** Children cache derived from the columns currently on screen. */
function cacheFromColumns(columns: Column[]): Map<string, TreeItem[]> {
  const cache = new Map<string, TreeItem[]>();
  for (const column of columns) {
    cache.set(column.parentId, column.items);
  }
  return cache;
}

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
      return {
        columns: action.state.columns,
        selectionPath: action.state.selectionPath,
        // Rebuilt from the painted columns only. Nothing off the visible
        // path survives a reload, so a collapsed branch cannot serve a
        // list captured before an import.
        cache: cacheFromColumns(action.state.columns),
        loading: null,
        filterQueries: action.state.filterQueries,
      };
    }

    case "REVALIDATE_SUCCESS": {
      const reconciled = reconcileRevalidatedColumns(state, action.fresh);
      const nextCache = new Map(state.cache);
      for (const [parentId, children] of action.fresh) {
        nextCache.set(parentId, children);
      }
      return { ...state, ...reconciled, cache: nextCache };
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
  // Initialise: stale-while-revalidate.
  //
  // A usable saved state paints immediately so the columns do not flash
  // empty, but it is treated as a picture of the tree rather than as
  // the tree: the root level and every expanded node are refetched in
  // the background and the fresh lists replace what was painted. This
  // is what makes the tree recover on its own after an import, where
  // the saved snapshot predates the new records.
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (initialised.current) return;
    initialised.current = true;

    const loadRoot = () => {
      fetchChildren("root")
        .then((items) => {
          dispatch({
            type: "LOAD_CHILDREN_SUCCESS",
            parentId: "root",
            children: items,
            title: t("root_column_title"),
          });
        })
        .catch((error) => {
          console.error("Error fetching root items:", error);
        });
    };

    const saved = parseSavedTreeState(sessionStorage.getItem(SESSION_KEY), Date.now());
    if (!saved) {
      // Drop the rejected payload so a stale or foreign-version blob is
      // not re-examined on every mount for the rest of the session.
      sessionStorage.removeItem(SESSION_KEY);
      loadRoot();
      return;
    }

    dispatch({ type: "RESTORE_STATE", state: saved });

    // Revalidate the whole visible chain at once. `allSettled`, not
    // `all`: one failed level must not discard the levels that did come
    // back, and a column with no fresh list keeps the one it painted.
    const parentIds = [...new Set(saved.columns.map((col) => col.parentId))];
    Promise.allSettled(
      parentIds.map(async (parentId) => {
        const children = await fetchChildren(parentId);
        return [parentId, children] as const;
      }),
    ).then((results) => {
      const fresh = new Map<string, TreeItem[]>();
      for (const result of results) {
        if (result.status === "fulfilled") {
          fresh.set(result.value[0], result.value[1]);
        }
      }
      if (fresh.size > 0) {
        dispatch({ type: "REVALIDATE_SUCCESS", fresh });
      }
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
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify(serializeTreeState(state, Date.now())),
    );
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
