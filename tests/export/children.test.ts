/**
 * Tests — children
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import { generateChildrenMap } from "../../app/lib/export/children.server";

// ---------------------------------------------------------------------------
// Fixtures: small hierarchy fonds > series > file
// ---------------------------------------------------------------------------

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "desc-001",
    parentId: null as string | null,
    referenceCode: "co-ahr-gob",
    title: "Gobernacion",
    descriptionLevel: "fonds",
    dateExpression: null as string | null,
    childCount: 2,
    hasDigital: false,
    position: 0,
    ...overrides,
  };
}

const fonds = makeRow({
  id: "fonds-001",
  parentId: null,
  referenceCode: "co-ahr-gob",
  title: "Gobernacion",
  descriptionLevel: "fonds",
  childCount: 2,
  position: 0,
});

const series1 = makeRow({
  id: "series-001",
  parentId: "fonds-001",
  referenceCode: "co-ahr-gob-caj001",
  title: "Caja 1",
  descriptionLevel: "series",
  childCount: 1,
  position: 1,
});

const series2 = makeRow({
  id: "series-002",
  parentId: "fonds-001",
  referenceCode: "co-ahr-gob-caj002",
  title: "Caja 2",
  descriptionLevel: "series",
  childCount: 0,
  hasDigital: true,
  position: 0,
});

const file1 = makeRow({
  id: "file-001",
  parentId: "series-001",
  referenceCode: "co-ahr-gob-caj001-car001",
  title: "Carpeta 1",
  descriptionLevel: "file",
  childCount: 0,
  hasDigital: true,
  dateExpression: "1810",
  position: 0,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateChildrenMap", () => {
  it("produces Map keyed by parent reference code", () => {
    const map = generateChildrenMap([fonds, series1, series2, file1]);
    expect(map.has("co-ahr-gob")).toBe(true);
    expect(map.has("co-ahr-gob-caj001")).toBe(true);
  });

  it("each entry is an array of ExportChildEntry objects", () => {
    const map = generateChildrenMap([fonds, series1, series2, file1]);
    const children = map.get("co-ahr-gob");
    expect(children).toBeDefined();
    expect(children!.length).toBe(2);
    expect(children![0]).toHaveProperty("id");
    expect(children![0]).toHaveProperty("reference_code");
    expect(children![0]).toHaveProperty("title");
    expect(children![0]).toHaveProperty("description_level");
    expect(children![0]).toHaveProperty("date_expression");
    expect(children![0]).toHaveProperty("has_children");
    expect(children![0]).toHaveProperty("child_count");
    expect(children![0]).toHaveProperty("has_digital");
  });

  it("descriptions with no children produce no entry in the map", () => {
    const map = generateChildrenMap([fonds, series1, series2, file1]);
    // series2 has childCount=0 and no actual children
    expect(map.has("co-ahr-gob-caj002")).toBe(false);
    // file1 has childCount=0 and no actual children
    expect(map.has("co-ahr-gob-caj001-car001")).toBe(false);
  });

  it("root descriptions (parentId=null) are not children of anything", () => {
    const map = generateChildrenMap([fonds, series1, series2, file1]);
    // No parent has fonds as a child
    for (const [, children] of map) {
      const fondsChild = children.find((c) => c.id === "fonds-001");
      expect(fondsChild).toBeUndefined();
    }
  });

  it("children contain correct field values", () => {
    const map = generateChildrenMap([fonds, series1, series2, file1]);
    const seriesChildren = map.get("co-ahr-gob-caj001");
    expect(seriesChildren).toBeDefined();
    expect(seriesChildren!).toHaveLength(1);

    const child = seriesChildren![0];
    expect(child.id).toBe("file-001");
    expect(child.reference_code).toBe("co-ahr-gob-caj001-car001");
    expect(child.title).toBe("Carpeta 1");
    expect(child.description_level).toBe("file");
    expect(child.date_expression).toBe("1810");
    expect(child.has_children).toBe(false);
    expect(child.child_count).toBe(0);
    expect(child.has_digital).toBe(true);
  });

  it("children are sorted by position ascending", () => {
    const map = generateChildrenMap([fonds, series1, series2, file1]);
    const fondsChildren = map.get("co-ahr-gob");
    expect(fondsChildren).toBeDefined();
    // series2 has position=0, series1 has position=1
    expect(fondsChildren![0].id).toBe("series-002");
    expect(fondsChildren![1].id).toBe("series-001");
  });

  it("returns empty map when given no descriptions", () => {
    const map = generateChildrenMap([]);
    expect(map.size).toBe(0);
  });

  it("handles single root with no children", () => {
    const root = makeRow({ childCount: 0 });
    const map = generateChildrenMap([root]);
    expect(map.size).toBe(0);
  });
});
