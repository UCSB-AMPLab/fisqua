/**
 * Tests — the capture QC list
 *
 * This suite pins the part of `fisqua capture qc-decisions` that needs
 * no database: how it reads a list. The verb's arguments are pinned in
 * `tests/import/capture-cli.test.ts`; the rows' outcomes and what the
 * verb writes are pinned against D1 in
 * `tests/capture/record-qc-decisions.test.ts`.
 *
 *   - the list: a TSV file with a header row, or a JSON array, read
 *     into rows; quoted fields with tabs, line breaks and doubled quotes,
 *     and a quoted field never closed refusing the whole list with the
 *     line it opens on;
 *     `single` or an empty side for an opening with one image; the
 *     optional columns empty or left out; the `decision` column,
 *     `rejected` when absent or empty, `approved` with no side,
 *     reason or note, or `excluded` with no side or reason and an
 *     optional note;
 *   - the shape refusals, each refusing the whole list and naming every
 *     problem: a missing or unknown column, a wrong field count, a side
 *     or reason the contract does not allow, a decision other than
 *     `rejected`, `approved` or `excluded`, an approval with a side,
 *     reason or note, an exclusion with a side or reason,
 *     a rejection without a reason, `other` without a note, a
 *     note past 2,000 characters, a sequence or record id that is not an
 *     integer, an empty pair id on a row without a record id, two rows
 *     naming one stem and pair id, and two pair-less rows naming one
 *     stem and record id;
 *   - a row with an empty pair id read when it gives the record id, and
 *     a JSON row by record id read without a pairId key.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { parseQcList, QcDecisionStop, tsvRows } from "../../scripts/lib/qc-decisions";

const HEADER = "stem\tpairId\tsequence\tside\treason\tnote\tcaptua_record_id";

function refusal(text: string, format: "tsv" | "json" = "tsv"): QcDecisionStop {
  try {
    parseQcList(text, format);
  } catch (err) {
    expect(err).toBeInstanceOf(QcDecisionStop);
    return err as QcDecisionStop;
  }
  throw new Error("the list was accepted");
}

describe("the list", () => {
  it("reads a TSV list, quoted fields included", () => {
    const text = [
      HEADER,
      "co-x-001\tco-x-001-img_0002\t2\tleft\tother\tff. 3v-4r\t12",
      'co-x-001\tco-x-001-img_0001\t\tsingle\tother\t"f. 1r\tsee ""the sheet""\nsecond line"\t',
      "",
      "co-x-001\tco-x-001-img_0004\t\t\tblur\t\t",
    ].join("\r\n");
    expect(parseQcList(text, "tsv")).toEqual([
      { line: 2, stem: "co-x-001", pairId: "co-x-001-img_0002", sequence: 2, decision: "rejected", side: "left", reason: "other", note: "ff. 3v-4r", captuaRecordId: 12 },
      {
        line: 3,
        stem: "co-x-001",
        pairId: "co-x-001-img_0001",
        sequence: null,
        decision: "rejected",
        side: null,
        reason: "other",
        note: 'f. 1r\tsee "the sheet"\nsecond line',
        captuaRecordId: null,
      },
      { line: 6, stem: "co-x-001", pairId: "co-x-001-img_0004", sequence: null, decision: "rejected", side: null, reason: "blur", note: null, captuaRecordId: null },
    ]);
  });

  it("takes the optional columns left out, and other names for them", () => {
    const text = "stem\tpair_id\tside\treason\tnote\trecord_sequence\n" + "co-x-001\tp1\tboth\tother\tn\t4\n";
    expect(parseQcList(text, "tsv")).toEqual([
      { line: 2, stem: "co-x-001", pairId: "p1", sequence: 4, decision: "rejected", side: "both", reason: "other", note: "n", captuaRecordId: null },
    ]);
  });

  it("reads a JSON list", () => {
    const rows = [
      { stem: "co-x-001", pairId: "p1", side: "right", reason: "other", note: "n", captua_record_id: 7, sequence: 3 },
      { stem: "co-x-001", pairId: "p2", side: null, reason: "glare" },
    ];
    expect(parseQcList(JSON.stringify(rows), "json")).toEqual([
      { line: 1, stem: "co-x-001", pairId: "p1", sequence: 3, decision: "rejected", side: "right", reason: "other", note: "n", captuaRecordId: 7 },
      { line: 2, stem: "co-x-001", pairId: "p2", sequence: null, decision: "rejected", side: null, reason: "glare", note: null, captuaRecordId: null },
    ]);
  });

  it("refuses the whole list, naming every problem", () => {
    expect(refusal("stem\tpairId\tside\treason\n").problems).toEqual(["the header has no note column"]);
    expect(refusal(HEADER + "\tfolios\n").problems).toEqual(['the header names an unknown column "folios"']);
    const stop = refusal(
      [
        HEADER,
        "co-x-001\tp1\t\tleft\tother\tn",
        "co-x-001\tp2\t\tupper\tother\tn\t",
        "co-x-001\tp3\t\tleft\tsmudge\tn\t",
        "co-x-001\tp4\t\tleft\tother\t \t",
        `co-x-001\tp5\t\tleft\tother\t${"x".repeat(2001)}\t`,
        "co-x-001\tp6\tfour\tleft\tother\tn\t1.5",
        "\tp7\t\tleft\tother\tn\t",
        "co-x-001\tp8\t\tleft\tother\tn\t",
        "co-x-001\tp8\t\tright\tother\tn\t",
      ].join("\n"),
    );
    expect(stop.message).toMatch(/^The list is refused whole:/);
    expect(stop.problems).toEqual([
      "line 2: 6 fields where the header has 7",
      'line 3: side "upper" is not left, right, both, single or empty',
      'line 4: reason "smudge" is not one of blur, glare, shadow, focus, exposure, dirt, framing, obstruction, other',
      "line 5: a rejection for other needs a note",
      "line 6: the note is longer than 2000 characters",
      'line 7: sequence "four" is not an integer',
      'line 7: captua_record_id "1.5" is not an integer',
      "line 8: stem is empty",
      "row at 10 names co-x-001 p8 again (first at 9)",
    ]);
    expect(refusal(HEADER + "\n").problems).toEqual(["the list has no rows"]);
    expect(refusal("{}", "json").message).toMatch(/an array of rows/);
    expect(refusal(JSON.stringify([{ stem: "s", pairId: "p", reason: "other", folio: 3 }]), "json").problems).toEqual([
      'row 1: unknown key "folio"',
      "row 1: a rejection for other needs a note",
    ]);
  });

  it("reads a decision column: rejected by default or when empty, approved with no side, reason or note", () => {
    const text = [
      "stem\tpairId\tdecision\tside\treason\tnote",
      "co-x-001\tp1\tapproved\t\t\t",
      "co-x-001\tp2\trejected\tleft\tblur\t",
      "co-x-001\tp3\t\tboth\tglare\tn",
    ].join("\n");
    expect(parseQcList(text, "tsv")).toEqual([
      { line: 2, stem: "co-x-001", pairId: "p1", sequence: null, decision: "approved", side: null, reason: null, note: null, captuaRecordId: null },
      { line: 3, stem: "co-x-001", pairId: "p2", sequence: null, decision: "rejected", side: "left", reason: "blur", note: null, captuaRecordId: null },
      { line: 4, stem: "co-x-001", pairId: "p3", sequence: null, decision: "rejected", side: "both", reason: "glare", note: "n", captuaRecordId: null },
    ]);
    const json = [{ stem: "co-x-001", pairId: "p1", decision: "approved" }];
    expect(parseQcList(JSON.stringify(json), "json")).toEqual([
      { line: 1, stem: "co-x-001", pairId: "p1", sequence: null, decision: "approved", side: null, reason: null, note: null, captuaRecordId: null },
    ]);
  });

  it("refuses an approval with a side, a reason or a note, and a decision it does not know", () => {
    const stop = refusal(
      [
        "stem\tpairId\tdecision\tside\treason\tnote",
        "co-x-001\tp1\tapproved\tleft\t\t",
        "co-x-001\tp2\tapproved\t\tblur\t",
        "co-x-001\tp3\tapproved\t\t\tf. 3r",
        "co-x-001\tp4\tapproved\tsingle\t\t",
        "co-x-001\tp5\tdeferred\t\t\t",
        "co-x-001\tp6\trejected\tleft\t\t",
      ].join("\n"),
    );
    expect(stop.problems).toEqual([
      "line 2: an approval takes no side",
      "line 3: an approval takes no reason",
      "line 4: an approval takes no note",
      "line 5: an approval takes no side",
      'line 6: decision "deferred" is not rejected, approved or excluded',
      'line 7: reason "" is not one of blur, glare, shadow, focus, exposure, dirt, framing, obstruction, other',
    ]);
  });

  it("reads an exclusion: no side or reason, and a note when the row gives one", () => {
    const text = [
      "stem\tpairId\tdecision\tside\treason\tnote",
      "co-x-001\tp1\texcluded\t\t\t",
      "co-x-001\tp2\texcluded\t\t\tcolor chart, not a page",
    ].join("\n");
    expect(parseQcList(text, "tsv")).toEqual([
      { line: 2, stem: "co-x-001", pairId: "p1", sequence: null, decision: "excluded", side: null, reason: null, note: null, captuaRecordId: null },
      {
        line: 3,
        stem: "co-x-001",
        pairId: "p2",
        sequence: null,
        decision: "excluded",
        side: null,
        reason: null,
        note: "color chart, not a page",
        captuaRecordId: null,
      },
    ]);
    // A JSON row of an exclusion needs no reason key.
    const json = [{ stem: "co-x-001", pairId: "p1", decision: "excluded" }];
    expect(parseQcList(JSON.stringify(json), "json")).toEqual([
      { line: 1, stem: "co-x-001", pairId: "p1", sequence: null, decision: "excluded", side: null, reason: null, note: null, captuaRecordId: null },
    ]);
  });

  it("refuses an exclusion with a side or a reason, and a note past 2,000 characters", () => {
    const stop = refusal(
      [
        "stem\tpairId\tdecision\tside\treason\tnote",
        "co-x-001\tp1\texcluded\tleft\t\t",
        "co-x-001\tp2\texcluded\tsingle\t\t",
        "co-x-001\tp3\texcluded\t\tblur\t",
        `co-x-001\tp4\texcluded\t\t\t${"x".repeat(2001)}`,
      ].join("\n"),
    );
    expect(stop.problems).toEqual([
      "line 2: an exclusion takes no side",
      "line 3: an exclusion takes no side",
      "line 4: an exclusion takes no reason",
      "line 5: the note is longer than 2000 characters",
    ]);
  });

  it("reads a row with no pair id when it gives the record id", () => {
    const text = [
      "stem\tpairId\tdecision\tside\treason\tnote\tcaptua_record_id",
      "co-x-001\t\texcluded\t\t\t\t56940",
      "co-x-002\t\t\tsingle\tblur\t\t56940",
    ].join("\n");
    expect(parseQcList(text, "tsv")).toEqual([
      { line: 2, stem: "co-x-001", pairId: "", sequence: null, decision: "excluded", side: null, reason: null, note: null, captuaRecordId: 56940 },
      { line: 3, stem: "co-x-002", pairId: "", sequence: null, decision: "rejected", side: null, reason: "blur", note: null, captuaRecordId: 56940 },
    ]);
    // A JSON row by record id may leave the pairId key out.
    const json = [{ stem: "co-x-001", captua_record_id: 56940, decision: "excluded" }];
    expect(parseQcList(JSON.stringify(json), "json")).toEqual([
      { line: 1, stem: "co-x-001", pairId: "", sequence: null, decision: "excluded", side: null, reason: null, note: null, captuaRecordId: 56940 },
    ]);
  });

  it("refuses an empty pair id without a record id, and two rows naming one record id", () => {
    const stop = refusal(
      [
        "stem\tpairId\tdecision\tside\treason\tnote\tcaptua_record_id",
        "co-x-001\t\texcluded\t\t\t\t",
        "co-x-001\t\texcluded\t\t\t\t56940",
        "co-x-001\t\trejected\t\tblur\t\t56940",
        "co-x-002\t\texcluded\t\t\t\t56940",
      ].join("\n"),
    );
    expect(stop.problems).toEqual([
      "line 2: pairId is empty and the row gives no captua_record_id",
      "row at 4 names co-x-001 record 56940 again (first at 3)",
    ]);
    expect(refusal(JSON.stringify([{ stem: "co-x-001", decision: "excluded" }]), "json").problems).toEqual([
      "row 1: pairId is empty and the row gives no captua_record_id",
    ]);
  });

  it("refuses the whole list when a quoted field is never closed, naming the line it opens on", () => {
    const text = [
      HEADER,
      "co-x-001\tp1\t\tleft\tother\tf. 1r\t",
      'co-x-001\tp2\t\tleft\tother\t"f. 2r, see the sheet\t',
      "co-x-001\tp3\t\tright\tother\tf. 3r\t",
    ].join("\n");
    const stop = refusal(text);
    expect(stop.message).toMatch(/^The list is refused whole:/);
    expect(stop.problems).toEqual(["line 3: a quoted field is never closed"]);
    expect(() => tsvRows('a\t"b\nc\n')).toThrow("line 1: a quoted field is never closed");
  });

  it("splits TSV text into rows with the line each starts on", () => {
    expect(tsvRows('a\tb\n"c\nd"\te\n')).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: ["c\nd", "e"] },
    ]);
  });
});

// @version v0.9.0
