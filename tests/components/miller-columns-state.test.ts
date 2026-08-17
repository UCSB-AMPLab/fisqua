/**
 * Tests — Miller columns saved-state guards
 *
 * Pins the sessionStorage contract of `app/components/descriptions/
 * miller-columns.tsx` after the production defect where a tab that had
 * opened the descriptions tree before an import kept showing an empty
 * tree indefinitely: the persisted payload carried the parentId ->
 * children cache, and a cached empty list was trusted forever, across
 * hard reloads.
 *
 * The three pure guards that close that hole are covered here:
 * `parseSavedTreeState` (discard on corrupt payload, schema-version
 * mismatch, missing or nonsensical timestamp, and age past the TTL),
 * `serializeTreeState` (stamps version + savedAt, and persists no
 * cache), and `reconcileRevalidatedColumns` (fresh lists replace
 * painted ones, failed levels keep what they had, and a selection that
 * no longer exists takes its subtree with it).
 *
 * Pure-contract suite — no DOM, no fetch, no storage; the Workers pool
 * runs these as plain function calls.
 *
 * @version v0.6.1
 */
import { describe, it, expect } from "vitest";
import {
  TREE_STATE_SCHEMA_VERSION,
  TREE_STATE_TTL_MS,
  parseSavedTreeState,
  serializeTreeState,
  reconcileRevalidatedColumns,
  type SerializedTreeState,
  type TreeItem,
} from "../../app/components/descriptions/miller-columns";

const NOW = 1_800_000_000_000;

function item(id: string, overrides: Partial<TreeItem> = {}): TreeItem {
  return {
    id,
    title: `Title ${id}`,
    referenceCode: id.toUpperCase(),
    descriptionLevel: "fonds",
    dateExpression: null,
    scopeContent: null,
    childCount: 0,
    isPublished: true,
    position: 0,
    repositoryId: "repo-1",
    ...overrides,
  };
}

function savedState(overrides: Partial<SerializedTreeState> = {}): SerializedTreeState {
  return {
    version: TREE_STATE_SCHEMA_VERSION,
    savedAt: NOW,
    columns: [{ parentId: "root", title: "Repositories", items: [item("a")] }],
    selectionPath: [],
    filterQueries: [""],
    ...overrides,
  };
}

describe("serializeTreeState", () => {
  it("stamps the schema version and the save time", () => {
    const serialized = serializeTreeState(
      {
        columns: [{ parentId: "root", title: "Repositories", items: [item("a")] }],
        selectionPath: ["a"],
        filterQueries: [""],
      },
      NOW,
    );

    expect(serialized.version).toBe(TREE_STATE_SCHEMA_VERSION);
    expect(serialized.savedAt).toBe(NOW);
    expect(serialized.selectionPath).toEqual(["a"]);
  });

  it("persists no children cache — the defect that made empty branches permanent", () => {
    const serialized = serializeTreeState(
      { columns: [], selectionPath: [], filterQueries: [] },
      NOW,
    );

    expect(Object.keys(serialized)).not.toContain("cache");
  });

  it("round-trips through JSON back into a usable state", () => {
    const raw = JSON.stringify(serializeTreeState(savedState(), NOW));
    expect(parseSavedTreeState(raw, NOW)).not.toBeNull();
  });
});

describe("parseSavedTreeState", () => {
  it("returns null for an absent payload", () => {
    expect(parseSavedTreeState(null, NOW)).toBeNull();
    expect(parseSavedTreeState("", NOW)).toBeNull();
  });

  it("returns null for a payload that is not JSON", () => {
    expect(parseSavedTreeState("{not json", NOW)).toBeNull();
  });

  it("returns null for JSON that is not an object", () => {
    expect(parseSavedTreeState("42", NOW)).toBeNull();
    expect(parseSavedTreeState("null", NOW)).toBeNull();
  });

  it("discards a payload written by an older schema version", () => {
    const legacy = JSON.stringify({
      columns: [{ parentId: "root", title: "Repositories", items: [item("a")] }],
      selectionPath: [],
      filterQueries: [""],
      cache: { root: [] },
    });

    expect(parseSavedTreeState(legacy, NOW)).toBeNull();
  });

  it("discards a payload from a future schema version", () => {
    const raw = JSON.stringify(
      savedState({ version: TREE_STATE_SCHEMA_VERSION + 1 }),
    );

    expect(parseSavedTreeState(raw, NOW)).toBeNull();
  });

  it("discards a payload with a missing or non-numeric savedAt", () => {
    const missing = JSON.stringify({ ...savedState(), savedAt: undefined });
    const wrongType = JSON.stringify({ ...savedState(), savedAt: "recently" });
    const notFinite = JSON.stringify({ ...savedState(), savedAt: null });

    expect(parseSavedTreeState(missing, NOW)).toBeNull();
    expect(parseSavedTreeState(wrongType, NOW)).toBeNull();
    expect(parseSavedTreeState(notFinite, NOW)).toBeNull();
  });

  it("accepts a payload inside the TTL", () => {
    const raw = JSON.stringify(savedState({ savedAt: NOW - (TREE_STATE_TTL_MS - 1) }));

    const parsed = parseSavedTreeState(raw, NOW);
    expect(parsed).not.toBeNull();
    expect(parsed?.columns).toHaveLength(1);
  });

  it("accepts a payload exactly at the TTL boundary", () => {
    const raw = JSON.stringify(savedState({ savedAt: NOW - TREE_STATE_TTL_MS }));

    expect(parseSavedTreeState(raw, NOW)).not.toBeNull();
  });

  it("discards a payload older than the TTL", () => {
    const raw = JSON.stringify(savedState({ savedAt: NOW - TREE_STATE_TTL_MS - 1 }));

    expect(parseSavedTreeState(raw, NOW)).toBeNull();
  });

  it("discards a payload stamped in the future — a backwards clock is not freshness", () => {
    const raw = JSON.stringify(savedState({ savedAt: NOW + 1 }));

    expect(parseSavedTreeState(raw, NOW)).toBeNull();
  });

  it("discards a payload with nothing to paint", () => {
    const noColumns = JSON.stringify(savedState({ columns: [] }));
    const badColumns = JSON.stringify({ ...savedState(), columns: "root" });

    expect(parseSavedTreeState(noColumns, NOW)).toBeNull();
    expect(parseSavedTreeState(badColumns, NOW)).toBeNull();
  });

  it("defaults the selection and filter arrays when they are missing", () => {
    const raw = JSON.stringify({
      version: TREE_STATE_SCHEMA_VERSION,
      savedAt: NOW,
      columns: [{ parentId: "root", title: "Repositories", items: [item("a")] }],
    });

    const parsed = parseSavedTreeState(raw, NOW);
    expect(parsed?.selectionPath).toEqual([]);
    expect(parsed?.filterQueries).toEqual([]);
  });
});

describe("reconcileRevalidatedColumns", () => {
  const painted = {
    columns: [
      { parentId: "root", title: "Repositories", items: [item("repo__1")] },
      { parentId: "repo__1", title: "Archive", items: [item("a"), item("b")] },
    ],
    selectionPath: ["repo__1", "a"],
    filterQueries: ["", "que"],
  };

  it("replaces painted lists with the fresh ones", () => {
    const fresh = new Map<string, TreeItem[]>([
      ["root", [item("repo__1")]],
      ["repo__1", [item("a"), item("b"), item("c")]],
    ]);

    const next = reconcileRevalidatedColumns(painted, fresh);
    expect(next.columns[1].items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(next.selectionPath).toEqual(["repo__1", "a"]);
    expect(next.filterQueries).toEqual(["", "que"]);
  });

  it("keeps a column whose level failed to refetch", () => {
    const fresh = new Map<string, TreeItem[]>([["root", [item("repo__1")]]]);

    const next = reconcileRevalidatedColumns(painted, fresh);
    expect(next.columns).toHaveLength(2);
    expect(next.columns[1].items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(next.selectionPath).toEqual(["repo__1", "a"]);
  });

  it("drops the selection and every deeper column when the selected item is gone", () => {
    const fresh = new Map<string, TreeItem[]>([
      ["root", [item("repo__1")]],
      ["repo__1", [item("b")]],
    ]);

    const next = reconcileRevalidatedColumns(painted, fresh);
    expect(next.columns).toHaveLength(2);
    expect(next.selectionPath).toEqual(["repo__1"]);
  });

  it("collapses to the root column when the whole tree came back empty", () => {
    const fresh = new Map<string, TreeItem[]>([
      ["root", []],
      ["repo__1", []],
    ]);

    const next = reconcileRevalidatedColumns(painted, fresh);
    expect(next.columns).toHaveLength(1);
    expect(next.columns[0].items).toEqual([]);
    expect(next.selectionPath).toEqual([]);
    expect(next.filterQueries).toEqual([""]);
  });

  it("repopulates a root that had been cached empty — the reported defect", () => {
    const emptied = {
      columns: [{ parentId: "root", title: "Repositories", items: [] }],
      selectionPath: [],
      filterQueries: [""],
    };
    const fresh = new Map<string, TreeItem[]>([["root", [item("repo__1")]]]);

    const next = reconcileRevalidatedColumns(emptied, fresh);
    expect(next.columns[0].items.map((i) => i.id)).toEqual(["repo__1"]);
  });

  it("keeps the deepest column when nothing is selected in it", () => {
    const noLeafSelection = {
      columns: painted.columns,
      selectionPath: ["repo__1"],
      filterQueries: ["", ""],
    };
    const fresh = new Map<string, TreeItem[]>([
      ["root", [item("repo__1")]],
      ["repo__1", [item("a")]],
    ]);

    const next = reconcileRevalidatedColumns(noLeafSelection, fresh);
    expect(next.columns).toHaveLength(2);
    expect(next.selectionPath).toEqual(["repo__1"]);
  });
});
