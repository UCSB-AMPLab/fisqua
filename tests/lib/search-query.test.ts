/**
 * Tests — search query model
 *
 * Covers `app/lib/search-query.ts`, the pure module that defines the
 * search language: how the URL's repeatable `q` values parse into box
 * text, exclusions, and field-scoped refinements; how a refinement
 * encodes back to its wire form; and how the whole model compiles to
 * the two FTS5 MATCH expressions — the one that names what is wanted
 * and the one that names what is excluded — both valid by
 * construction. Everything here is a string-in/string-out contract
 * shared by the server (which compiles) and the surface (which builds
 * pills and URLs), so the pins are exact strings, not shapes — a
 * drifted space or a lost quote is a different query.
 *
 * The rules under test are Zasqua's search model with Fisqua's field
 * extension: implicit AND between terms, leading hyphen excludes,
 * opening double quote means verbatim phrase, duplicates on
 * (term, op, field) collapse to one — and, since the whole-word turn,
 * a term matches words rather than word beginnings unless the person
 * asks for a prefix with a trailing star. There is no length rule at
 * all: blankness is the only reason a term is dropped.
 *
 * The last section covers the ADVANCED grammar, the module's other
 * language: rows of operator, field and term that accumulate left to
 * right. Its pins are exact strings for the same reason — the paren
 * shape IS the associativity, so `a OR b NOT c` compiling to anything
 * but `((a OR b) NOT c)` is a different question — plus the degradation
 * rules a hand-edited URL runs into and the anchor that keeps every
 * surviving query positive.
 *
 * @version v0.7.0
 */
import { describe, it, expect } from "vitest";
import {
  SEARCH_FIELDS,
  parseSearch,
  encodeRefinement,
  hasFieldRefinements,
  hasPositive,
  isOnlyNot,
  isBlank,
  compileFtsExpression,
  compileExclusionExpression,
  sanitisedFallbackExpression,
  parseAdvancedRows,
  encodeAdvancedRow,
  hasAdvancedFieldRows,
  compileAdvancedExpression,
  MAX_ADVANCED_ROWS,
} from "../../app/lib/search-query";
import * as searchQuery from "../../app/lib/search-query";
import type {
  AdvancedOp,
  AdvancedRow,
  SearchRefinement,
} from "../../app/lib/search-query";

/** The three operators, for the loops that cover all of them. */
const ADVANCED_OPS: readonly AdvancedOp[] = ["and", "or", "not"];

/** A row, spelled out so the tests read as the form reads. */
function row(op: AdvancedOp, field: AdvancedRow["field"], term: string): AdvancedRow {
  return { op, field, term };
}

describe("search query model", () => {
  describe("the retired length rule", () => {
    it("exports no minimum and no searchable-term predicate", () => {
      // The three-character floor was a mitigation for a different
      // search engine; whole-word matching removes its justification,
      // and nothing may reach for it again.
      expect("MIN_QUERY_TERM_LENGTH" in searchQuery).toBe(false);
      expect("isSearchableTerm" in searchQuery).toBe(false);
    });

    it("searches any non-blank term, however short", () => {
      expect(parseSearch(["a"]).q).toBe("a");
      expect(parseSearch(["ab"]).q).toBe("ab");
      expect(parseSearch(["ab cd"]).q).toBe("ab cd");
      expect(parseSearch(["xxx", "a"]).refinements).toEqual([
        { term: "a", op: "AND", field: null },
      ]);
      expect(parseSearch(["xxx", "title:a"]).refinements).toEqual([
        { term: "a", op: "AND", field: "title" },
      ]);
      expect(parseSearch(["cacique -x"]).refinements).toEqual([
        { term: "x", op: "NOT", field: null },
      ]);
    });

    it("still drops what is blank", () => {
      expect(parseSearch([""])).toEqual({ q: "", phrase: false, refinements: [] });
      expect(parseSearch(["   "])).toEqual({ q: "", phrase: false, refinements: [] });
      expect(parseSearch(["xxx", ""]).refinements).toEqual([]);
      expect(parseSearch(["xxx", "   "]).refinements).toEqual([]);
    });
  });

  describe("parsing the main box", () => {
    it("keeps a plain multi-token query as joined positive text", () => {
      const p = parseSearch(["libro bautismos"]);
      expect(p).toEqual({ q: "libro bautismos", phrase: false, refinements: [] });
    });

    it("collapses stray whitespace between tokens", () => {
      expect(parseSearch(["  libro   de  "]).q).toBe("libro de");
    });

    it("extracts a leading-hyphen token as an exclusion", () => {
      const p = parseSearch(["cacique -tunja"]);
      expect(p.q).toBe("cacique");
      expect(p.refinements).toEqual([{ term: "tunja", op: "NOT", field: null }]);
    });

    it("treats a bare hyphen as ordinary text, not an operator", () => {
      // "-" is length 1, so it is a positive token, in the box and on
      // its own alike.
      const p = parseSearch(["cacique -"]);
      expect(p.q).toBe("cacique -");
      expect(p.refinements).toEqual([]);
      expect(parseSearch(["-"])).toEqual({ q: "-", phrase: false, refinements: [] });
    });

    it("strips exactly one leading hyphen, keeping the rest verbatim", () => {
      const p = parseSearch(["--foo"]);
      expect(p.q).toBe("");
      expect(p.refinements).toEqual([{ term: "-foo", op: "NOT", field: null }]);
    });

    it("keeps mid-word hyphens as part of the term on both sides", () => {
      const positive = parseSearch(["sub-fondo"]);
      expect(positive.q).toBe("sub-fondo");
      expect(positive.refinements).toEqual([]);
      const excluded = parseSearch(["cacique -sub-fondo"]);
      expect(excluded.refinements).toEqual([
        { term: "sub-fondo", op: "NOT", field: null },
      ]);
    });

    it("passes a phrase-mode box through verbatim with no extraction", () => {
      const p = parseSearch(['"libro de bautismos" -cacique']);
      expect(p.q).toBe('"libro de bautismos" -cacique');
      expect(p.phrase).toBe(true);
      expect(p.refinements).toEqual([]);
    });

    it("keeps a one-character phrase-mode box", () => {
      const p = parseSearch(['"a']);
      expect(p.q).toBe('"a');
      expect(p.phrase).toBe(true);
    });
  });

  describe("parsing refinements", () => {
    it("reads a plain value as an all-fields AND term", () => {
      expect(parseSearch(["xxx", "tunja"]).refinements).toEqual([
        { term: "tunja", op: "AND", field: null },
      ]);
    });

    it("reads a leading hyphen as NOT", () => {
      expect(parseSearch(["xxx", "-tunja"]).refinements).toEqual([
        { term: "tunja", op: "NOT", field: null },
      ]);
    });

    it("recognises every field prefix", () => {
      for (const field of SEARCH_FIELDS) {
        expect(parseSearch(["xxx", `${field}:tunja`]).refinements).toEqual([
          { term: "tunja", op: "AND", field },
        ]);
        expect(parseSearch(["xxx", `-${field}:tunja`]).refinements).toEqual([
          { term: "tunja", op: "NOT", field },
        ]);
      }
    });

    it("matches the field prefix case-insensitively", () => {
      expect(parseSearch(["xxx", "TITLE:tunja"]).refinements).toEqual([
        { term: "tunja", op: "AND", field: "title" },
      ]);
      expect(parseSearch(["xxx", "-Scope:tunja"]).refinements).toEqual([
        { term: "tunja", op: "NOT", field: "scope" },
      ]);
    });

    it("keeps an unknown prefix as part of the term", () => {
      expect(parseSearch(["xxx", "foo:bar"]).refinements).toEqual([
        { term: "foo:bar", op: "AND", field: null },
      ]);
    });

    it("keeps a multi-word refinement as one unit", () => {
      expect(parseSearch(["xxx", "santa fe"]).refinements).toEqual([
        { term: "santa fe", op: "AND", field: null },
      ]);
      expect(parseSearch(["xxx", "title:santa fe"]).refinements).toEqual([
        { term: "santa fe", op: "AND", field: "title" },
      ]);
    });

    it("reads a lone hyphen refinement as the term it looks like", () => {
      // Length 1, so the hyphen is not the exclude operator; there is
      // no length rule left to drop it either, so it survives as text
      // and compiles to a unit that simply finds nothing.
      expect(parseSearch(["xxx", "-"]).refinements).toEqual([
        { term: "-", op: "AND", field: null },
      ]);
    });

    it("collapses duplicates on (term, op, field)", () => {
      const p = parseSearch(["xxx", "title:tunja", "title:tunja", "-tunja", "-tunja"]);
      expect(p.refinements).toEqual([
        { term: "tunja", op: "AND", field: "title" },
        { term: "tunja", op: "NOT", field: null },
      ]);
    });

    it("collapses a box-extracted exclusion with its pill duplicate", () => {
      const p = parseSearch(["cacique -tunja", "-tunja"]);
      expect(p.refinements).toEqual([{ term: "tunja", op: "NOT", field: null }]);
    });

    it("keeps same-term refinements that differ on op or field", () => {
      const p = parseSearch(["xxx", "tunja", "-tunja", "title:tunja"]);
      expect(p.refinements).toHaveLength(3);
    });
  });

  describe("encodeRefinement", () => {
    it("round-trips through parseSearch for every op and field", () => {
      const fields = [null, ...SEARCH_FIELDS] as const;
      for (const op of ["AND", "NOT"] as const) {
        for (const field of fields) {
          const r: SearchRefinement = { term: "tunja", op, field };
          const p = parseSearch(["xxx", encodeRefinement(r)]);
          expect(p.refinements).toEqual([r]);
        }
      }
    });

    it("round-trips a multi-word term", () => {
      const r: SearchRefinement = { term: "santa fe", op: "NOT", field: "scope" };
      expect(encodeRefinement(r)).toBe("-scope:santa fe");
      expect(parseSearch(["xxx", encodeRefinement(r)]).refinements).toEqual([r]);
    });

    it("round-trips a prefix-star term", () => {
      const r: SearchRefinement = { term: "casa*", op: "AND", field: null };
      expect(encodeRefinement(r)).toBe("casa*");
      expect(parseSearch(["xxx", encodeRefinement(r)]).refinements).toEqual([r]);
    });
  });

  describe("the predicates", () => {
    it("tells blank, only-not, and positive states apart", () => {
      const blank = parseSearch([""]);
      expect(isBlank(blank)).toBe(true);
      expect(hasPositive(blank)).toBe(false);
      expect(isOnlyNot(blank)).toBe(false);

      const onlyNot = parseSearch(["-tunja"]);
      expect(isBlank(onlyNot)).toBe(false);
      expect(hasPositive(onlyNot)).toBe(false);
      expect(isOnlyNot(onlyNot)).toBe(true);

      const boxPositive = parseSearch(["cacique"]);
      expect(isBlank(boxPositive)).toBe(false);
      expect(hasPositive(boxPositive)).toBe(true);
      expect(isOnlyNot(boxPositive)).toBe(false);

      // An AND refinement alone is positive, even with an empty box.
      const pillPositive = parseSearch(["", "cacique"]);
      expect(hasPositive(pillPositive)).toBe(true);
      expect(isOnlyNot(pillPositive)).toBe(false);
      expect(isBlank(pillPositive)).toBe(false);

      // A box that dissolves entirely into an exclusion is only-not.
      const dissolved = parseSearch(["-tunja -muzo"]);
      expect(isOnlyNot(dissolved)).toBe(true);
    });

    it("detects field refinements regardless of operator", () => {
      expect(hasFieldRefinements(parseSearch(["cacique"]))).toBe(false);
      expect(hasFieldRefinements(parseSearch(["cacique", "tunja"]))).toBe(false);
      expect(hasFieldRefinements(parseSearch(["cacique", "title:tunja"]))).toBe(true);
      expect(hasFieldRefinements(parseSearch(["cacique", "-legacy:tunja"]))).toBe(true);
    });
  });

  describe("compileFtsExpression", () => {
    it("emits one quoted WHOLE-WORD unit per box token", () => {
      // No star: `casa` is the word casa, not the start of Casarín.
      expect(compileFtsExpression(parseSearch(["libro bautismos"]))).toBe(
        '("libro" AND "bautismos")',
      );
      expect(compileFtsExpression(parseSearch(["casa"]))).toBe('("casa")');
    });

    it("keeps prefix matching for a term the person starred", () => {
      // The star comes off the text and goes back on outside the
      // quotes, where FTS5 reads it as the prefix operator.
      expect(compileFtsExpression(parseSearch(["casa*"]))).toBe('("casa"*)');
      expect(compileFtsExpression(parseSearch(["libro casa*"]))).toBe(
        '("libro" AND "casa"*)',
      );
      expect(compileFtsExpression(parseSearch(["", "casa*"]))).toBe('("casa"*)');
      expect(compileFtsExpression(parseSearch(["", "title:casa*"]))).toBe(
        '(title: "casa"*)',
      );
    });

    it("puts the star after the quotes on a phrase's last word", () => {
      expect(compileFtsExpression(parseSearch(["", "santa fe*"]))).toBe(
        '("santa fe"*)',
      );
      expect(compileFtsExpression(parseSearch(["", "santa fe"]))).toBe(
        '("santa fe")',
      );
    });

    it("compiles the full shape: box, field refinement, exclusion", () => {
      const p = parseSearch(["cacique", "title:tunja", "-muzo"]);
      expect(compileFtsExpression(p)).toBe(
        '("cacique" AND title: "tunja") NOT "muzo"',
      );
    });

    it("maps every field to its index column", () => {
      const columns: Record<string, string> = {
        title: "title",
        scope: "scope_content",
        notes: "notes",
        ref: "reference_code",
        legacy: "legacy_ids",
      };
      for (const field of SEARCH_FIELDS) {
        expect(compileFtsExpression(parseSearch(["", `${field}:tunja`]))).toBe(
          `(${columns[field]}: "tunja")`,
        );
      }
    });

    it("emits a multi-word refinement as one phrase", () => {
      expect(compileFtsExpression(parseSearch(["registro", "santa fe"]))).toBe(
        '("registro" AND "santa fe")',
      );
    });

    it("doubles inner quotes so the unit cannot break out of its string", () => {
      expect(compileFtsExpression(parseSearch(["", 'o"campo']))).toBe(
        '("o""campo")',
      );
    });

    it("neutralises hyphens, colons, and boolean keywords by quoting", () => {
      expect(compileFtsExpression(parseSearch(["sub-fondo"]))).toBe('("sub-fondo")');
      expect(compileFtsExpression(parseSearch(["", "foo:bar"]))).toBe('("foo:bar")');
      expect(compileFtsExpression(parseSearch(["AND"]))).toBe('("AND")');
    });

    it("chains multiple exclusions with binary NOTs", () => {
      expect(compileFtsExpression(parseSearch(["cacique -tunja -muzo"]))).toBe(
        '("cacique") NOT "tunja" NOT "muzo"',
      );
    });

    it("keeps a field on an excluded refinement's unit", () => {
      expect(compileFtsExpression(parseSearch(["cacique", "-title:tunja"]))).toBe(
        '("cacique") NOT title: "tunja"',
      );
    });

    it("passes the phrase-mode box through verbatim in its own parens", () => {
      expect(compileFtsExpression(parseSearch(['"libro de bautismos"']))).toBe(
        '(("libro de bautismos"))',
      );
    });

    it("returns null when nothing positive exists", () => {
      expect(compileFtsExpression(parseSearch([""]))).toBeNull();
      expect(compileFtsExpression(parseSearch(["-tunja"]))).toBeNull();
      expect(compileFtsExpression(parseSearch(["", "-tunja", "-muzo"]))).toBeNull();
    });
  });

  describe("compileExclusionExpression", () => {
    it("emits the one excluded unit", () => {
      expect(compileExclusionExpression(parseSearch(["", "-tunja"]))).toBe('"tunja"');
      expect(compileExclusionExpression(parseSearch(["-tunja"]))).toBe('"tunja"');
    });

    it("joins several exclusions with OR, because any of them excludes", () => {
      expect(compileExclusionExpression(parseSearch(["-tunja -muzo"]))).toBe(
        '"tunja" OR "muzo"',
      );
    });

    it("keeps a field scope on the unit it belongs to", () => {
      expect(compileExclusionExpression(parseSearch(["", "-title:tunja"]))).toBe(
        'title: "tunja"',
      );
      // A column filter binds to the unit that follows it and no
      // further, so the second unit here stays all-fields.
      expect(
        compileExclusionExpression(parseSearch(["", "-title:tunja", "-muzo"])),
      ).toBe('title: "tunja" OR "muzo"');
    });

    it("honours a starred exclusion the same way the positive side does", () => {
      expect(compileExclusionExpression(parseSearch(["-casa*"]))).toBe('"casa"*');
    });

    it("ignores the positive side entirely", () => {
      expect(
        compileExclusionExpression(parseSearch(["cacique -tunja", "santa fe"])),
      ).toBe('"tunja"');
    });

    it("returns null when the query excludes nothing", () => {
      expect(compileExclusionExpression(parseSearch(["cacique"]))).toBeNull();
      expect(compileExclusionExpression(parseSearch([""]))).toBeNull();
      expect(compileExclusionExpression(parseSearch(["", "tunja"]))).toBeNull();
    });
  });

  describe("sanitisedFallbackExpression", () => {
    it("strips FTS syntax from box tokens and keeps the whole-word AND form", () => {
      expect(sanitisedFallbackExpression(parseSearch(['"bautismos']))).toBe(
        '"bautismos"',
      );
      expect(sanitisedFallbackExpression(parseSearch(["a:bcd"]))).toBe('"abcd"');
      // The star is syntax too: a salvaged query asks the plainest
      // possible question.
      expect(sanitisedFallbackExpression(parseSearch(['"casa*']))).toBe('"casa"');
    });

    it("includes AND refinements word by word and drops exclusions", () => {
      const p = parseSearch(["cacique -muzo", "santa fe", "-tunja"]);
      expect(sanitisedFallbackExpression(p)).toBe('"cacique" "santa" "fe"');
    });

    it("returns null when nothing survives the stripping", () => {
      // A phrase-mode box of pure syntax dissolves entirely.
      expect(sanitisedFallbackExpression(parseSearch(['"()']))).toBeNull();
      expect(sanitisedFallbackExpression(parseSearch([""]))).toBeNull();
    });
  });

  describe("parseAdvancedRows", () => {
    it("round-trips every operator and every field through the wire form", () => {
      const fields = [null, ...SEARCH_FIELDS] as const;
      for (const op of ADVANCED_OPS) {
        for (const field of fields) {
          const later = row(op, field, "tunja");
          // A second row keeps its own operator; the anchor before it
          // is what the forcing rule applies to.
          const parsed = parseAdvancedRows([
            encodeAdvancedRow(row("and", null, "cacique")),
            encodeAdvancedRow(later),
          ]);
          expect(parsed).toEqual([row("and", null, "cacique"), later]);
        }
      }
    });

    it("encodes the wire form as op:field:term, with an empty field for all-fields", () => {
      expect(encodeAdvancedRow(row("and", null, "tunja"))).toBe("and::tunja");
      expect(encodeAdvancedRow(row("or", "scope", "santa fe"))).toBe(
        "or:scope:santa fe",
      );
      expect(encodeAdvancedRow(row("not", "legacy", "geiger-155"))).toBe(
        "not:legacy:geiger-155",
      );
    });

    it("splits on the first two colons only, so a term may carry its own", () => {
      expect(parseAdvancedRows(["and::a:b:c"])).toEqual([
        row("and", null, "a:b:c"),
      ]);
      expect(parseAdvancedRows(["and::cacique", "or:title:foo:bar"])).toEqual([
        row("and", null, "cacique"),
        row("or", "title", "foo:bar"),
      ]);
      // And a term that is nothing but colons survives as that term.
      expect(parseAdvancedRows(["and:::"])).toEqual([row("and", null, ":")]);
    });

    it("reads an empty field name as all fields", () => {
      expect(parseAdvancedRows(["and::tunja"])).toEqual([
        row("and", null, "tunja"),
      ]);
    });

    it("matches operator and field case-insensitively", () => {
      // Both travel as SELECT values, so casing is never a person's
      // choice; accepting it costs nothing and errors on nothing.
      expect(parseAdvancedRows(["AND::cacique", "OR:Title:tunja"])).toEqual([
        row("and", null, "cacique"),
        row("or", "title", "tunja"),
      ]);
    });

    it("drops a row whose operator is not one of the three", () => {
      expect(parseAdvancedRows(["xor::tunja"])).toEqual([]);
      expect(parseAdvancedRows(["and::cacique", "maybe::tunja"])).toEqual([
        row("and", null, "cacique"),
      ]);
      expect(parseAdvancedRows(["::tunja"])).toEqual([]);
    });

    it("drops a row naming a field the index does not have", () => {
      expect(parseAdvancedRows(["and:creator:tunja"])).toEqual([]);
      expect(parseAdvancedRows(["and::cacique", "or:creator:tunja"])).toEqual([
        row("and", null, "cacique"),
      ]);
    });

    it("drops a row whose term is blank once trimmed", () => {
      expect(parseAdvancedRows(["and::"])).toEqual([]);
      expect(parseAdvancedRows(["and::   "])).toEqual([]);
      expect(parseAdvancedRows(["and:title:  "])).toEqual([]);
    });

    it("trims the term but leaves its insides alone", () => {
      expect(parseAdvancedRows(["and::  santa fe  "])).toEqual([
        row("and", null, "santa fe"),
      ]);
    });

    it("drops a value that is not the three-part wire form at all", () => {
      expect(parseAdvancedRows([""])).toEqual([]);
      expect(parseAdvancedRows(["tunja"])).toEqual([]);
      // One colon is not two: there is no term half to read.
      expect(parseAdvancedRows(["and:tunja"])).toEqual([]);
    });

    it("drops a leading exclusion instead of inverting it", () => {
      // Flipping "not" to "and" would search FOR what the row asked to
      // exclude; the row is dropped, and the anchor falls to the next
      // positive row. A leading "or" means the same as "and" with
      // nothing before it, so it normalises rather than dropping.
      expect(parseAdvancedRows(["not::tunja"])).toEqual([]);
      expect(parseAdvancedRows(["not::tunja", "and::muzo"])).toEqual([
        row("and", null, "muzo"),
      ]);
      expect(parseAdvancedRows(["or:title:tunja", "not::muzo"])).toEqual([
        row("and", "title", "tunja"),
        row("not", null, "muzo"),
      ]);
    });

    it("forces the anchor onto whichever positive row survives first", () => {
      // The rows that would have anchored fall away one by one — an
      // unknown field, a blank term, a bad operator, a leading
      // exclusion — and the first positive row that lands is the
      // anchor.
      const rows = parseAdvancedRows([
        "and:creator:tunja",
        "or::   ",
        "nope::muzo",
        "not::cacique",
        "or::guasca",
        "not::soata",
      ]);
      expect(rows).toEqual([
        row("and", null, "guasca"),
        row("not", null, "soata"),
      ]);
    });

    it("ignores rows past the parser-protecting cap", () => {
      const values = Array.from(
        { length: MAX_ADVANCED_ROWS + 10 },
        (_, i) => `and::term${i}`,
      );
      expect(parseAdvancedRows(values)).toHaveLength(MAX_ADVANCED_ROWS);
    });

    it("keeps duplicate rows, because a form line is not a pill", () => {
      // Pills collapse on (term, op, field); advanced rows do not —
      // what the person built is what the URL says and what comes back.
      expect(parseAdvancedRows(["and::tunja", "and::tunja"])).toEqual([
        row("and", null, "tunja"),
        row("and", null, "tunja"),
      ]);
    });
  });

  describe("hasAdvancedFieldRows", () => {
    it("is true only when some row carries a field", () => {
      expect(hasAdvancedFieldRows([])).toBe(false);
      expect(hasAdvancedFieldRows([row("and", null, "tunja")])).toBe(false);
      expect(
        hasAdvancedFieldRows([row("and", null, "tunja"), row("or", "notes", "muzo")]),
      ).toBe(true);
      // The operator is irrelevant: a scoped exclusion still needs the
      // record index's columns.
      expect(hasAdvancedFieldRows([row("and", "legacy", "geiger")])).toBe(true);
    });
  });

  describe("compileAdvancedExpression", () => {
    it("returns null when there are no rows", () => {
      expect(compileAdvancedExpression([])).toBeNull();
    });

    it("wraps a lone anchor in its own parens", () => {
      expect(compileAdvancedExpression([row("and", null, "tunja")])).toBe('("tunja")');
      // The anchor's operator is already forced by the parser; a caller
      // that hands one over anyway still gets a positive expression.
      expect(compileAdvancedExpression([row("not", null, "tunja")])).toBe('("tunja")');
    });

    it("emits one paren layer per operator, in the form's own order", () => {
      expect(
        compileAdvancedExpression([row("and", null, "a"), row("and", null, "b")]),
      ).toBe('(("a") AND "b")');
      expect(
        compileAdvancedExpression([row("and", null, "a"), row("or", null, "b")]),
      ).toBe('(("a") OR "b")');
      expect(
        compileAdvancedExpression([row("and", null, "a"), row("not", null, "b")]),
      ).toBe('(("a") NOT "b")');
    });

    it("accumulates LEFT-associatively: a OR b NOT c is (a OR b) NOT c", () => {
      expect(
        compileAdvancedExpression([
          row("and", null, "a"),
          row("or", null, "b"),
          row("not", null, "c"),
        ]),
      ).toBe('((("a") OR "b") NOT "c")');
      // The right-associative reading — a OR (b NOT c) — is a different
      // set, so the shape is pinned rather than merely described.
      expect(
        compileAdvancedExpression([
          row("and", null, "a"),
          row("not", null, "b"),
          row("or", null, "c"),
        ]),
      ).toBe('((("a") NOT "b") OR "c")');
    });

    it("keeps stacking through a long mixed chain", () => {
      expect(
        compileAdvancedExpression([
          row("and", null, "a"),
          row("not", null, "b"),
          row("or", null, "c"),
          row("and", null, "d"),
        ]),
      ).toBe('(((("a") NOT "b") OR "c") AND "d")');
    });

    it("maps every field to its index column", () => {
      const columns: Record<string, string> = {
        title: "title",
        scope: "scope_content",
        notes: "notes",
        ref: "reference_code",
        legacy: "legacy_ids",
      };
      for (const field of SEARCH_FIELDS) {
        expect(compileAdvancedExpression([row("and", field, "tunja")])).toBe(
          `(${columns[field]}: "tunja")`,
        );
      }
    });

    it("scopes each row's own unit and no other", () => {
      expect(
        compileAdvancedExpression([
          row("and", "title", "cacique"),
          row("or", null, "tunja"),
          row("not", "scope", "muzo"),
        ]),
      ).toBe('(((title: "cacique") OR "tunja") NOT scope_content: "muzo")');
    });

    it("emits the same units the pills grammar does", () => {
      // Star outside the quotes, multi-word term as one phrase, inner
      // quotes doubled — one unit emitter, so the two grammars cannot
      // drift apart.
      expect(compileAdvancedExpression([row("and", null, "casa*")])).toBe('("casa"*)');
      expect(compileAdvancedExpression([row("and", null, "santa fe")])).toBe(
        '("santa fe")',
      );
      expect(compileAdvancedExpression([row("and", null, "santa fe*")])).toBe(
        '("santa fe"*)',
      );
      expect(compileAdvancedExpression([row("and", "title", "casa*")])).toBe(
        '(title: "casa"*)',
      );
      expect(compileAdvancedExpression([row("and", null, 'o"campo')])).toBe(
        '("o""campo")',
      );
      // Hyphens, colons and the boolean words are ordinary text here too.
      expect(compileAdvancedExpression([row("and", null, "sub-fondo")])).toBe(
        '("sub-fondo")',
      );
      expect(
        compileAdvancedExpression([row("and", null, "AND"), row("or", null, "foo:bar")]),
      ).toBe('(("AND") OR "foo:bar")');
    });

    it("compiles what the URL parsed, end to end", () => {
      // The leading exclusion is dropped at parse, so the phrase row
      // anchors and the compiled chain starts from it.
      const rows = parseAdvancedRows([
        "not:title:cacique",
        "or::santa fe",
        "not:legacy:geiger-155",
      ]);
      expect(compileAdvancedExpression(rows)).toBe(
        '(("santa fe") NOT legacy_ids: "geiger-155")',
      );
    });
  });
});
