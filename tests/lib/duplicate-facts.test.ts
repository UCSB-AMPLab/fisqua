/**
 * Tests — duplicate pair facts
 *
 * This suite pins the pure computation behind the possible-duplicates
 * queue: deletion keys, function keys, the year gap between spans, which
 * pairs qualify (office, associate or document; a place never does), the
 * description-count limits, caps, and the ranking weight.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import {
  nameDeletions,
  functionKey,
  yearsApart,
  computePairFacts,
  pairWeight,
  nearPairAllowed,
  type PairInputs,
  type WorkspaceLinks,
  type FactRecord,
} from "../../app/lib/duplicate-facts";
import { normaliseName } from "../../app/lib/authority-duplicates.server";

const links = (p: Partial<WorkspaceLinks> = {}): WorkspaceLinks => ({
  descriptions: new Map(),
  associates: new Map(),
  places: new Map(),
  ...p,
});
const rec = (id: string, o: Partial<FactRecord> = {}): FactRecord => ({
  id,
  name: id,
  code: null,
  dateStart: null,
  dateEnd: null,
  dates: null,
  ...o,
});
const input = (o: Partial<PairInputs> = {}): PairInputs => ({
  a: rec("a"),
  b: rec("b"),
  related: false,
  separated: false,
  aFunctions: [],
  bFunctions: [],
  aLinks: links(),
  bLinks: links(),
  linkTotals: new Map(),
  ...o,
});
const assoc = (id: string) => new Map([[id, new Set(["d1"])]]);

describe("nameDeletions", () => {
  it("lists the key and each single deletion", () => {
    expect(nameDeletions("abc")).toEqual(["abc", "bc", "ac", "ab"]);
    expect(nameDeletions("")).toEqual([]);
  });
  it("shares a deletion between keys one edit apart", () => {
    for (const [x, y] of [["fortuni", "fortuny"], ["catala", "catalan"]]) {
      const dx = new Set(nameDeletions(x));
      expect(nameDeletions(y).some((d) => dx.has(d))).toBe(true);
    }
  });
  it("gives nothing for the key of a punctuation-only name", () => {
    expect(nameDeletions(normaliseName("--"))).toEqual([]);
  });
});

describe("functionKey", () => {
  it("trims, collapses and case-folds but keeps accents", () => {
    expect(functionKey("  Alcalde   Ordinario ")).toBe("alcalde ordinario");
    expect(functionKey("Alcalde")).not.toBe(functionKey("Álcalde"));
  });
  it("gives a decomposed accent the key of the composed one", () => {
    expect(functionKey("A\u0301lcalde")).toBe(functionKey("\u00C1lcalde"));
    expect(functionKey("Escriba\u0301n")).toBe("escrib\u00E1n");
  });
});

describe("yearsApart", () => {
  const d = (s: string | null, e: string | null) => ({ dateStart: s, dateEnd: e });
  it("measures the gap between spans", () => {
    expect(yearsApart(d("1700", "1710"), d("1715", "1720"))).toBe(5);
    expect(yearsApart(d("1700", "1710"), d("1716", "1720"))).toBe(6);
    expect(yearsApart(d("1700", "1710"), d("1705", "1720"))).toBe(0);
    expect(yearsApart(d("1700", "1710"), d("1710", "1720"))).toBe(0);
  });
  it("is null when either has no year", () => {
    expect(yearsApart(d(null, null), d("1700", "1710"))).toBeNull();
  });
  it("treats start-only and end-only as one-year spans", () => {
    expect(yearsApart(d("1700", null), d(null, "1706"))).toBe(6);
    expect(yearsApart(d("1700", null), d(null, "1705"))).toBe(5);
  });
  it("reads a reversed span from its earlier year to its later one", () => {
    expect(yearsApart(d("1750", "1700"), d("1710", "1712"))).toBe(0);
    expect(yearsApart(d("1710", "1712"), d("1750", "1700"))).toBe(0);
    expect(yearsApart(d("1700", "1690"), d("1706", "1720"))).toBe(6);
  });
  it("does not exclude a pair whose reversed span overlaps the other", () => {
    const f = computePairFacts(
      input({
        a: rec("a", { dateStart: "1750", dateEnd: "1700" }),
        b: rec("b", { dateStart: "1710", dateEnd: "1712" }),
        aFunctions: ["Escribano"],
        bFunctions: ["Escribano"],
      }),
      new Map(),
    );
    expect(f).not.toBeNull();
    expect(f!.dates.overlap).toBe(true);
  });
});

describe("computePairFacts", () => {
  it("is null for a name-only pair", () => {
    expect(computePairFacts(input(), new Map())).toBeNull();
  });
  it("qualifies on a shared office, shown as written on record a", () => {
    const f = computePairFacts(
      input({ aFunctions: ["Alcalde  Ordinario"], bFunctions: ["alcalde ordinario"] }),
      new Map()
    )!;
    expect(f.offices).toEqual(["Alcalde  Ordinario".trim()]);
    expect(f.warning).toBeNull();
  });
  it("counts an associate with 200 descriptions but not 201", () => {
    const mk = (n: number) =>
      computePairFacts(
        input({
          aLinks: links({ associates: assoc("x") }),
          bLinks: links({ associates: assoc("x") }),
          linkTotals: new Map([["x", n]]),
        }),
        new Map([["x", "X"]]),
        new Map([["x", "C1"]])
      );
    expect(mk(200)!.associates).toEqual([{ id: "x", name: "X", code: "C1" }]);
    expect(mk(201)).toBeNull();
  });
  it("excludes an associate and a place missing from linkTotals", () => {
    expect(
      computePairFacts(
        input({
          aLinks: links({ associates: assoc("x") }),
          bLinks: links({ associates: assoc("x") }),
        }),
        new Map()
      )
    ).toBeNull();
    const f = computePairFacts(
      input({
        aFunctions: ["alcalde"],
        bFunctions: ["alcalde"],
        aLinks: links({ places: assoc("p") }),
        bLinks: links({ places: assoc("p") }),
      }),
      new Map()
    )!;
    expect(f.places).toEqual([]);
  });
  it("never qualifies on a place alone, and drops a place over 2,000", () => {
    const places = (n: number) =>
      input({
        aLinks: links({ places: assoc("p") }),
        bLinks: links({ places: assoc("p") }),
        linkTotals: new Map([["p", n]]),
        aFunctions: ["alcalde"],
        bFunctions: ["alcalde"],
      });
    expect(
      computePairFacts(
        input({
          aLinks: links({ places: assoc("p") }),
          bLinks: links({ places: assoc("p") }),
          linkTotals: new Map([["p", 5]]),
        }),
        new Map()
      )
    ).toBeNull();
    expect(computePairFacts(places(2000), new Map([["p", "P"]]))!.places).toEqual([
      { id: "p", name: "P" },
    ]);
    expect(computePairFacts(places(2001), new Map())!.places).toEqual([]);
  });
  it("warns on a shared document", () => {
    const d = new Map([["d1", "Title"]]);
    const f = computePairFacts(
      input({ aLinks: links({ descriptions: d }), bLinks: links({ descriptions: d }) }),
      new Map()
    )!;
    expect(f.warning).toBe("same-document");
    expect(f.documents).toEqual([{ id: "d1", title: "Title" }]);
  });
  it("is null when the shared description was a relation side the job excluded", () => {
    // The job builds links without relation-side descriptions.
    expect(computePairFacts(input({ aLinks: links(), bLinks: links() }), new Map())).toBeNull();
  });
  it("applies the five-year date limit", () => {
    const base = { aFunctions: ["alcalde"], bFunctions: ["alcalde"] };
    const dated = (s: string | null, e: string | null, s2: string | null, e2: string | null) =>
      computePairFacts(
        input({
          ...base,
          a: rec("a", { dateStart: s, dateEnd: e }),
          b: rec("b", { dateStart: s2, dateEnd: e2 }),
        }),
        new Map()
      );
    expect(dated("1700", "1710", "1715", "1720")).not.toBeNull();
    expect(dated("1700", "1710", "1716", "1720")).toBeNull();
    expect(dated(null, null, "1716", "1720")).not.toBeNull();
    expect(dated("1700", null, null, "1705")).not.toBeNull();
    expect(dated("1700", null, null, "1706")).toBeNull();
    expect(dated("1700", "1710", "1705", "1720")!.dates.overlap).toBe(true);
  });
  it("is null when related or separated", () => {
    const base = { aFunctions: ["alcalde"], bFunctions: ["alcalde"] };
    expect(computePairFacts(input({ ...base, related: true }), new Map())).toBeNull();
    expect(computePairFacts(input({ ...base, separated: true }), new Map())).toBeNull();
  });
  it("caps lists at three and counts the rest", () => {
    const m = new Map<string, Set<string>>();
    for (const id of ["e1", "e2", "e3", "e4", "e5"]) m.set(id, new Set(["d"]));
    const f = computePairFacts(
      input({
        aLinks: links({ associates: m }),
        bLinks: links({ associates: m }),
        linkTotals: new Map([...m.keys()].map((k) => [k, 2])),
      }),
      new Map()
    )!;
    expect(f.associates).toHaveLength(3);
    expect(f.more.associates).toBe(2);
  });
  it("orders by shared descriptions, then id", () => {
    const a = new Map([["e1", new Set(["d"])], ["e2", new Set(["d", "e"])]]);
    const f = computePairFacts(
      input({
        aLinks: links({ associates: a }),
        bLinks: links({ associates: a }),
        linkTotals: new Map([["e1", 2], ["e2", 2]]),
      }),
      new Map()
    )!;
    expect(f.associates.map((x) => x.id)).toEqual(["e2", "e1"]);
  });
});

describe("nearPairAllowed", () => {
  it("refuses a near spelling between two one-word names", () => {
    expect(nearPairAllowed("juan", "juana")).toBe(false);
    expect(nearPairAllowed("maria", "marina")).toBe(false);
  });
  it("allows equal keys and keys where either has a space", () => {
    expect(nearPairAllowed("juan", "juan")).toBe(true);
    expect(nearPairAllowed("juan sanchez", "juana sanchez")).toBe(true);
    expect(nearPairAllowed("juan", "juan sanchez")).toBe(true);
  });
});

describe("pairWeight", () => {
  const facts = (o: Partial<Parameters<typeof pairWeight>[0]>) => ({
    warning: null,
    offices: [],
    associates: [],
    documents: [],
    dates: { a: null, b: null, overlap: false },
    places: [],
    more: { associates: 0, documents: 0, places: 0 },
    ...o,
  });
  it("ranks an office above a place with dates", () => {
    const office = pairWeight(facts({ offices: ["x"] }));
    const place = pairWeight(
      facts({ places: [{ id: "p", name: "P" }], dates: { a: "1", b: "1", overlap: true } })
    );
    expect(office).toBeGreaterThan(place);
  });
  it("counts at most five associates", () => {
    const ten = pairWeight(
      facts({
        associates: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }] as any,
        more: { associates: 7, documents: 0, places: 0 },
      })
    );
    expect(ten).toBe(15);
    expect(
      pairWeight(facts({ associates: [{ id: "a", name: "A" }, { id: "b", name: "B" }] as any }))
    ).toBe(6);
  });
  it("counts at most five shared places", () => {
    const pl = (k: number) =>
      Array.from({ length: k }, (_, i) => ({ id: `p${i}`, name: `P${i}` })) as any;
    expect(
      pairWeight(
        facts({ places: pl(3), more: { associates: 0, documents: 0, places: 58 } })
      )
    ).toBe(5);
    expect(pairWeight(facts({ places: pl(2) }))).toBe(2);
  });
  it("ranks overlapping dates above undated", () => {
    expect(pairWeight(facts({ dates: { a: "1", b: "1", overlap: true } }))).toBeGreaterThan(
      pairWeight(facts({}))
    );
    expect(Number.isInteger(pairWeight(facts({ offices: ["x"] })))).toBe(true);
  });
});

// @version v0.9.0
