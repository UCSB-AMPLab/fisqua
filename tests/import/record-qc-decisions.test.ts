/**
 * Tests — the bulk capture QC command's arguments and list
 *
 * This suite pins the parts of the bulk rejection command that need no
 * database: its arguments and how it reads a list. The rows' outcomes
 * and what the command writes are pinned against D1 in
 * `tests/capture/record-qc-decisions.test.ts`.
 *
 *   - the arguments: `--list`, `--tenant` and `--decided-by` are
 *     required, `--source-record` is production (the default) or
 *     staging, and `--apply` against production also needs
 *     `--confirm-production`;
 *   - the list: a TSV file with a header row, or a JSON array, read
 *     into rows; quoted fields with tabs, line breaks and doubled quotes,
 *     and a quoted field never closed refusing the whole list with the
 *     line it opens on;
 *     `single` or an empty side for an opening with one image; the
 *     optional columns empty or left out;
 *   - the shape refusals, each refusing the whole list and naming every
 *     problem: a missing or unknown column, a wrong field count, a side
 *     or reason the contract does not allow, `other` without a note, a
 *     note past 2,000 characters, a sequence or record id that is not an
 *     integer, and two rows naming one stem and pair id.
 *
 * Every value here is a test value.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { parseArgs } from "../../scripts/commands/record-qc-decisions";
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

describe("arguments", () => {
  const base = ["--list", "l.tsv", "--tenant", "ahr", "--decided-by", "someone@example.com"];

  it("reads the options, production and a dry run by default", () => {
    expect(parseArgs(base)).toEqual({
      list: "l.tsv",
      tenant: "ahr",
      decidedBy: "someone@example.com",
      sourceRecord: "production",
      apply: false,
      confirmProduction: false,
    });
    expect(parseArgs([...base, "--source-record", "staging", "--apply"]).sourceRecord).toBe("staging");
  });

  it("refuses missing options, another database and --apply on production without confirmation", () => {
    expect(() => parseArgs(["--tenant", "ahr", "--decided-by", "x@example.com"])).toThrow("--list is required");
    expect(() => parseArgs(["--list", "l.tsv", "--decided-by", "x@example.com"])).toThrow("--tenant is required");
    expect(() => parseArgs(["--list", "l.tsv", "--tenant", "ahr"])).toThrow("--decided-by is required");
    expect(() => parseArgs([...base, "--source-record", "local"])).toThrow("--source-record is production or staging");
    expect(() => parseArgs([...base, "--apply"])).toThrow("--apply against production also needs --confirm-production");
    expect(parseArgs([...base, "--apply", "--confirm-production"]).apply).toBe(true);
    expect(() => parseArgs([...base, "--force"])).toThrow("Unknown argument: --force");
  });
});

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
      { line: 2, stem: "co-x-001", pairId: "co-x-001-img_0002", sequence: 2, side: "left", reason: "other", note: "ff. 3v-4r", captuaRecordId: 12 },
      {
        line: 3,
        stem: "co-x-001",
        pairId: "co-x-001-img_0001",
        sequence: null,
        side: null,
        reason: "other",
        note: 'f. 1r\tsee "the sheet"\nsecond line',
        captuaRecordId: null,
      },
      { line: 6, stem: "co-x-001", pairId: "co-x-001-img_0004", sequence: null, side: null, reason: "blur", note: null, captuaRecordId: null },
    ]);
  });

  it("takes the optional columns left out, and other names for them", () => {
    const text = "stem\tpair_id\tside\treason\tnote\trecord_sequence\n" + "co-x-001\tp1\tboth\tother\tn\t4\n";
    expect(parseQcList(text, "tsv")).toEqual([
      { line: 2, stem: "co-x-001", pairId: "p1", sequence: 4, side: "both", reason: "other", note: "n", captuaRecordId: null },
    ]);
  });

  it("reads a JSON list", () => {
    const rows = [
      { stem: "co-x-001", pairId: "p1", side: "right", reason: "other", note: "n", captua_record_id: 7, sequence: 3 },
      { stem: "co-x-001", pairId: "p2", side: null, reason: "glare" },
    ];
    expect(parseQcList(JSON.stringify(rows), "json")).toEqual([
      { line: 1, stem: "co-x-001", pairId: "p1", sequence: 3, side: "right", reason: "other", note: "n", captuaRecordId: 7 },
      { line: 2, stem: "co-x-001", pairId: "p2", sequence: null, side: null, reason: "glare", note: null, captuaRecordId: null },
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

// @version v0.8.0
