/**
 * Tests — a record holds each function once
 *
 * This suite pins the rule in `app/lib/function-duplicates.ts` that the
 * write paths share:
 *
 *   - two rows are the same function when their texts are equal after
 *     trimming, collapsing internal whitespace and case-folding; accents
 *     and the honorific do not join two rows;
 *   - a held row takes the fields it lacks from an incoming row of the
 *     same function and keeps every field it has, reporting a field
 *     both hold with different values;
 *   - arrivals fold into a held row or an earlier arrival, fills
 *     accumulating, and the record's rows afterwards are given;
 *   - the editor's lines keep every line that keeps a row, and drop a
 *     line that would add a function the record keeps or adds already.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import {
  distinctFunctionLines,
  fillFunctionFields,
  foldFunctionRows,
  functionIdentity,
  type FunctionFields,
} from "../../app/lib/function-duplicates";

describe("functionIdentity", () => {
  it("joins texts that differ in case and spacing, not in accents", () => {
    expect(functionIdentity("  Cura ")).toBe(functionIdentity("cura"));
    expect(functionIdentity("Alcalde\t ordinario")).toBe(functionIdentity("alcalde ordinario"));
    expect(functionIdentity("Alférez")).not.toBe(functionIdentity("alferez"));
    // A decomposed accent is the same text as a composed one.
    expect(functionIdentity("Alférez")).toBe(functionIdentity("Alférez"));
  });
});

describe("fillFunctionFields", () => {
  it("fills empty fields only and reports differing ones", () => {
    const fill = fillFunctionFields(
      { honorific: null, dateStart: "1650", source: " ", notes: "propia" },
      { honorific: "don", dateStart: "1651", source: "AGN", notes: "propia ", dateNote: null }
    );
    expect(fill.set).toEqual({ honorific: "don", source: "AGN" });
    expect(fill.conflicts).toEqual([{ field: "dateStart", held: "1650", incoming: "1651" }]);
  });
});

describe("certainty", () => {
  it("is never filled, and a different certainty is reported as a conflict", () => {
    const fill = fillFunctionFields({ certainty: "probable", source: null }, { certainty: "certain", source: "AGN" });
    expect(fill.set).toEqual({ source: "AGN" });
    expect(fill.conflicts).toEqual([{ field: "certainty", held: "probable", incoming: "certain" }]);
    expect(fillFunctionFields({ certainty: null }, { certainty: "certain" }).conflicts).toEqual([]);
  });
});

describe("foldFunctionRows", () => {
  it("moves new functions, folds held ones and earlier arrivals, and accumulates fills", () => {
    const held: FunctionFields[] = [{ id: "h1", function: "Cura", source: null, notes: "x" }];
    const incoming: FunctionFields[] = [
      { id: "i1", function: "cura", source: "AGN", notes: "y" },
      { id: "i2", function: "Regidor", dateStart: null },
      { id: "i3", function: " regidor", dateStart: "1700" },
      { id: "i4", function: "CURA", source: "AHRB", dateEnd: "1720" },
    ];
    const { arrive, folded, after } = foldFunctionRows(held, incoming);
    expect(arrive.map((r) => r.id)).toEqual(["i2"]);
    expect(folded.map((f) => [f.row.id, f.into, f.set, f.conflicts.map((c) => c.field)])).toEqual([
      ["i1", "h1", { source: "AGN" }, ["notes"]],
      ["i3", "i2", { dateStart: "1700" }, []],
      ["i4", "h1", { dateEnd: "1720" }, ["source"]],
    ]);
    expect(after).toEqual([
      { id: "h1", function: "Cura", source: "AGN", notes: "x", dateEnd: "1720" },
      { id: "i2", function: "Regidor", dateStart: "1700" },
    ]);
    // The rows given are not changed.
    expect(held[0].source).toBeNull();
    expect(incoming[1].dateStart).toBeNull();
  });

  it("leaves a record's own duplicates and folds into the first of them", () => {
    const held: FunctionFields[] = [
      { id: "h1", function: "Cura" },
      { id: "h2", function: "cura" },
    ];
    const { arrive, folded, after } = foldFunctionRows(held, [{ id: "i1", function: "Cura", notes: "n" }]);
    expect(arrive).toEqual([]);
    expect(folded.map((f) => f.into)).toEqual(["h1"]);
    expect(after.map((r) => r.id)).toEqual(["h1", "h2"]);
  });
});

describe("distinctFunctionLines", () => {
  it("keeps the lines that keep a row and drops those that add a held or repeated function", () => {
    const existing = [{ function: " Cura " }, { function: "Cura" }, { function: "Regidor" }];
    expect(distinctFunctionLines(["Cura", "Cura", "cura", "Alcalde", "ALCALDE", "Regidor"], existing)).toEqual([
      "Cura",
      "Cura",
      "Alcalde",
      "Regidor",
    ]);
    // A new spelling of a kept line is dropped even when it comes first.
    expect(distinctFunctionLines(["regidor", "Regidor"], existing)).toEqual(["Regidor"]);
    expect(distinctFunctionLines(["Escribano", "escribano "], [])).toEqual(["Escribano"]);
  });
});

// @version v0.9.0
