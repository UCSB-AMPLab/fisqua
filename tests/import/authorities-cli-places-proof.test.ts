/**
 * Tests — the 24 October place merge list through `merge-place`
 *
 * This suite proves the command line's `merge-place` against what the
 * reviewed place merge command applied on 24 October: the list's rows,
 * re-expressed as `merge-place` rows by `./place-merges-proof.ts`, are
 * applied to the places and links as that run read them, and what the
 * command line leaves must be what the run left: every place's label,
 * display name, variants, ids, coordinates, `merged_into` and version;
 * every link, on every column, moved to its survivor or dropped; each ledger row's moved
 * and dropped links and carried values; and every changelog row's
 * record, kind and diff. A second run must write nothing and report
 * every row already merged.
 *
 * The committed slice (`fixtures/place-merges-2026-10-24-slice.json`)
 * holds a few survivors: one whose label changes and which takes ids
 * and coordinates, one taking coordinates only, one where a collision
 * drops a link, and one with several losers. The full list is checked
 * when `PLACE_MERGES_PROOF_DIR` names the folder holding the run's
 * artefacts (`authority-review/place-merges-final.csv` and
 * `place-merges_production_2026-10-24T23-29-09Z.json` and `.sql`); the
 * artefacts are read and never written.
 *
 * @version v0.9.0
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { STATEMENT_BUDGET } from "../../scripts/lib/authority-merges";
import { runFile } from "./authorities-cli-places-helpers";
import { PROOF_HEADER, canonical, database, proofFixture, seed, stateOf, type ProofFixture } from "./place-merges-proof";

const DIR = process.env.PLACE_MERGES_PROOF_DIR;
const RUN = "place-merges_production_2026-10-24T23-29-09Z";

async function prove(f: ProofFixture) {
  const db = database();
  seed(db, f);
  const opts = { header: PROOF_HEADER, file: "place-merges-final-as-merge-place.csv", now: f.now };
  const { report, applied } = await runFile(db, f.rows, { ...opts, apply: true });
  expect(report.refusals).toEqual([]);
  expect(report.problems).toEqual([]);
  expect(report.outcome).toBe("verified");
  expect(canonical(stateOf(db, f))).toEqual(canonical(f.expected));
  const again = await runFile(db, f.rows, { ...opts, apply: true });
  expect(again.report.outcome).toBe("nothing to write");
  expect(new Set(again.report.rows.map((r) => r.status))).toEqual(new Set(["already merged"]));
  const sizes = applied[0].map((s) => Buffer.byteLength(s));
  return { totals: report.totals, statements: applied[0].length, bytes: sizes.reduce((a, b) => a + b + 1, 0), largest: Math.max(...sizes) };
}

describe("the 24 October place merge list as merge-place rows", () => {
  it("does on the slice what the reviewed command did", async () => {
    const f = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "place-merges-2026-10-24-slice.json"), "utf8")) as ProofFixture;
    // Two links dropped as collisions, a label changed with ids and coordinates carried, a group of four losers.
    expect(f.expected.links.filter((l) => l.place_id === null)).toHaveLength(2);
    const r = await prove(f);
    expect(r.totals.merge).toBe(f.rows.length);
    expect(r.largest).toBeLessThanOrEqual(STATEMENT_BUDGET);
  });

  it.skipIf(!DIR)("does on the whole list what the reviewed command did", async () => {
    const report = JSON.parse(fs.readFileSync(path.join(DIR!, `${RUN}.json`), "utf8"));
    const f = proofFixture(
      fs.readFileSync(path.join(DIR!, `${RUN}.sql`), "utf8"),
      report,
      fs.readFileSync(path.join(DIR!, "authority-review", "place-merges-final.csv")),
    );
    // The derivation holds what the run's report counts.
    expect(f.rows).toHaveLength(report.counts.merges);
    expect(f.expected.ledger).toHaveLength(report.counts.merges);
    expect(f.expected.links.filter((l) => l.place_id === null)).toHaveLength(report.counts.linksDropped);
    const r = await prove(f);
    expect(r.totals.placeLinksMovedByMerges).toBe(report.counts.linksMoved);
    expect(r.totals.placeLinksDroppedByMerges).toBe(report.counts.linksDropped);
    console.log(`place merge proof: ${f.rows.length} rows, ${r.totals.placeLinksMovedByMerges} links moved, ${r.totals.placeLinksDroppedByMerges} dropped; ` +
      `${r.statements} statements, ${r.bytes} bytes, largest ${r.largest} (budget ${STATEMENT_BUDGET})`);
    expect(r.largest).toBeLessThanOrEqual(STATEMENT_BUDGET);
  }, 120_000);
});
