/**
 * Tests — evidence on the merge rows of the command line's authority changes
 *
 * This suite pins the evidence on the merge rows of the command line's
 * authority changes. A `merge-entity` row of an authorities change file
 * carries its evidence: `facts`, one or more independent facts separated
 * by spaces, and `evidence_codes`, the reference codes of the acting
 * tenant's descriptions that show it, each linked to the row's authority
 * or its target and at least one to each. The plan refuses a row without
 * them, naming its line, and plans the file's other rows as they stand.
 * The merge's ledger row carries the evidence as description ids. A rerun
 * of an applied file finds the merge already made and does not check the
 * evidence again, and a `merge-place` row needs none. The run is driven
 * end to end against an in-memory `node:sqlite` database, as the other
 * suites of the command do; nothing here reaches D1.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AuthoritiesReport } from "../../scripts/lib/authorities-cli/run";
import { D1_LIMITS, PLACES_DDL, runFile, type RunOptions } from "./authorities-cli-places-helpers";

const FED = "fed-1";
const TENANT = "t-1";
const FILE = "merge-evidence-test.csv";
const NOW = 1_763_700_000_000;

const AA = { id: "e-a", code: "ne-aaaaaa", name: "Domingo Caicedo" };
const BB = { id: "e-b", code: "ne-bbbbbb", name: "Domingo Caycedo" };
const CC = { id: "e-c", code: "ne-cccccc", name: "Ana Ruiz" };
const DD = { id: "e-d", code: "ne-dddddd", name: "Ana Ruíz" };
const TUNJA = { id: "p-t", code: "nl-tttttt", label: "Tunja" };
const TUNJA2 = { id: "p-u", code: "nl-uuuuuu", label: "Tunxa" };

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:", D1_LIMITS);
  db.exec(PLACES_DDL);
  db.exec(`INSERT INTO federations VALUES ('${FED}', 'neogranadina-fed', 'active', '${TENANT}', 1, 'ne', 'nl');`);
  db.exec(`INSERT INTO tenants VALUES ('${TENANT}', 'neogranadina', '${FED}', NULL, 1, 'ne', 'nl'), ('t-2', 'other', '${FED}', NULL, 1, 'ot', 'op');`);
  db.exec(`INSERT INTO users (id, email, name, tenant_id, is_admin) VALUES ('user_001', 'admin@example.org', 'Admin', '${TENANT}', 1);`);
  db.exec(
    `INSERT INTO descriptions VALUES ('d1', '${TENANT}', 'co-ev-001'), ('d2', '${TENANT}', 'co-ev-002'), ('d3', '${TENANT}', 'co-ev-003'), ` +
      `('d4', '${TENANT}', 'co-ev-004'), ('d5', '${TENANT}', 'co-ev-005'), ('dx', 't-2', 'co-ot-001');`,
  );
  db.exec(
    "INSERT INTO vocabulary_values (id, federation_id, list, code, created_at, updated_at) VALUES " +
      `('v-1', '${FED}', 'entity_type', 'person', 1, 1), ('v-2', '${FED}', 'entity_role', 'creator', 1, 1), ('v-3', '${FED}', 'place_type', 'city', 1, 1)`,
  );
  const e = db.prepare(
    "INSERT INTO entities (id, federation_id, tenant_id, entity_code, display_name, sort_name, entity_type, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, 'person', 1, 5)",
  );
  for (const x of [AA, BB, CC, DD]) e.run(x.id, FED, x.code, x.name, x.name);
  const p = db.prepare(
    "INSERT INTO places (id, federation_id, tenant_id, place_code, label, display_name, place_type, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, 'city', 1, 7)",
  );
  for (const x of [TUNJA, TUNJA2]) p.run(x.id, FED, x.code, x.label, x.label);
  const l = db.prepare("INSERT INTO description_entities (id, description_id, entity_id, role, sequence, created_at) VALUES (?, ?, ?, 'creator', 0, 3)");
  l.run("de-a1", "d1", AA.id);
  l.run("de-b2", "d2", BB.id);
  l.run("de-c3", "d3", CC.id);
  l.run("de-d4", "d4", DD.id);
  l.run("de-ax", "dx", AA.id);
  return db;
}

type Cells = Record<string, string>;

const HEADER = ["op", "authority_code", "authority_name", "target_codes", "label_to_keep", "name_variants_add", "facts", "evidence_codes", "changelog_note"];

const run = (db: DatabaseSync, rows: Cells[], opts: RunOptions = {}) => runFile(db, rows, { header: HEADER, file: FILE, now: NOW, ...opts });
const all = (db: DatabaseSync, sql: string) => db.prepare(sql).all() as Array<Record<string, any>>;
const reasons = (r: AuthoritiesReport) => r.refusals.map((f) => `${f.ref}: ${f.reason}`);
const snapshot = (db: DatabaseSync) =>
  JSON.stringify(["entities", "description_entities", "changelog", "authority_operations"].map((t) => all(db, `SELECT * FROM ${t} ORDER BY rowid`)));

const merge = (loser: typeof AA, survivor: typeof AA, facts: string, codes: string): Cells => ({
  op: "merge-entity", authority_code: loser.code, authority_name: loser.name, target_codes: survivor.code, label_to_keep: survivor.name,
  name_variants_add: loser.name, facts, evidence_codes: codes, changelog_note: "Same case of 1835.",
});

async function refused(db: DatabaseSync, rows: Cells[]): Promise<string[]> {
  const before = snapshot(db);
  const { report, applied } = await run(db, rows, { apply: true });
  expect(report.outcome).toBe("refused");
  expect(applied).toEqual([]);
  expect(snapshot(db)).toBe(before);
  return reasons(report);
}

describe("merge-entity rows and their evidence", () => {
  it("merge-entity without facts is refused with its line", async () => {
    const db = database();
    const found = await refused(db, [merge(AA, BB, "", "co-ev-001 co-ev-002")]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/line 2/);
    expect(found[0]).toMatch(/facts "" must name one or more of dates, office, kin, place, matter/);
    // An unknown fact, and a name, are no facts either.
    expect((await refused(db, [merge(AA, BB, "name", "co-ev-001 co-ev-002")]))[0]).toMatch(/line 2.*facts "name"/);
  });

  it("merge-entity with evidence on one side only is refused", async () => {
    const db = database();
    expect((await refused(db, [merge(AA, BB, "dates", "co-ev-001")]))[0]).toMatch(/line 2.*evidence_codes cite no description linked to ne-bbbbbb/);
    expect((await refused(db, [merge(AA, BB, "dates", "co-ev-002")]))[0]).toMatch(/line 2.*evidence_codes cite no description linked to ne-aaaaaa/);
    expect((await refused(db, [merge(AA, BB, "dates", "co-ev-001 co-ev-002 co-ev-003")]))[0])
      .toMatch(/line 2.*evidence code co-ev-003 is linked to neither ne-aaaaaa nor ne-bbbbbb/);
    // Another workspace's description is not this one's to cite, though it is linked.
    expect((await refused(db, [merge(AA, BB, "dates", "co-ot-001 co-ev-002")]))[0])
      .toMatch(/line 2.*evidence code co-ot-001 is not a description of this workspace/);
  });

  it("two merge rows, one without evidence: only that row is refused", async () => {
    const db = database();
    const found = await refused(db, [merge(AA, BB, "dates matter", "co-ev-001 co-ev-002"), merge(CC, DD, "", "")]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/line 3/);
  });

  it("evidence lands in the merge ledger row as description ids", async () => {
    const db = database();
    const { report } = await run(db, [merge(AA, BB, "matter dates", "co-ev-002 co-ev-001"), merge(CC, DD, "kin", "co-ev-003 co-ev-004")], { apply: true });
    expect(reasons(report)).toEqual([]);
    expect(report.outcome).toBe("verified");
    const rows = all(db, "SELECT source_id, target_id, detail FROM authority_operations WHERE operation = 'merge' ORDER BY source_id");
    expect(rows.map((r) => [r.source_id, JSON.parse(r.detail).evidence])).toEqual([
      [AA.id, { facts: ["dates", "matter"], descriptions: { [AA.id]: ["d1"], [BB.id]: ["d2"] } }],
      [CC.id, { facts: ["kin"], descriptions: { [CC.id]: ["d3"], [DD.id]: ["d4"] } }],
    ]);
    expect(JSON.parse(rows[0].detail)).toMatchObject({ reason: "Same case of 1835.", file: FILE, line: 2 });
  });

  it("the file aborts whole when a cited link goes before it is applied", async () => {
    const db = database();
    let before = "";
    // The survivor's cited link goes and another takes its place, so its link count holds.
    await expect(run(db, [merge(AA, BB, "dates", "co-ev-001 co-ev-002")], {
      apply: true,
      beforeApply: (d) => {
        d.exec("DELETE FROM description_entities WHERE id = 'de-b2'");
        d.exec(`INSERT INTO description_entities (id, description_id, entity_id, role, sequence, created_at) VALUES ('de-b5', 'd5', '${BB.id}', 'creator', 0, 3)`);
        before = snapshot(d);
      },
    })).rejects.toThrow(/ABORT|malformed JSON/);
    expect(before).not.toBe("");
    expect(snapshot(db)).toBe(before);
  });

  it('a rerun of an applied merge file is "already merged" without re-checking evidence', async () => {
    const db = database();
    const rows = [merge(AA, BB, "dates", "co-ev-001 co-ev-002")];
    expect((await run(db, rows, { apply: true })).report.outcome).toBe("verified");
    // The links the file cited are gone, and the row names no evidence.
    db.exec("DELETE FROM description_entities WHERE description_id IN ('d1', 'd2')");
    const again = await run(db, [{ ...rows[0], facts: "", evidence_codes: "" }], { apply: true });
    expect(reasons(again.report)).toEqual([]);
    expect(again.report.outcome).toBe("nothing to write");
    expect(again.report.rows.map((r) => r.status)).toEqual(["already merged"]);
  });

  it("merge-place rows need no evidence", async () => {
    const db = database();
    const { report } = await run(db, [
      { op: "merge-place", authority_code: TUNJA2.code, authority_name: TUNJA2.label, target_codes: TUNJA.code, label_to_keep: TUNJA.label, name_variants_add: TUNJA2.label },
    ], { apply: true });
    expect(reasons(report)).toEqual([]);
    expect(report.outcome).toBe("verified");
    const [row] = all(db, "SELECT detail FROM authority_operations WHERE operation = 'merge' AND record_type = 'place'");
    expect(JSON.parse(row.detail).evidence).toBeUndefined();
    // A place merge row may not carry evidence columns either: they belong to merge-entity.
    const found = await refused(database(), [
      { op: "merge-place", authority_code: TUNJA2.code, authority_name: TUNJA2.label, target_codes: TUNJA.code, label_to_keep: TUNJA.label, facts: "place" },
    ]);
    expect(found[0]).toMatch(/merge-place carries no facts/);
  });
});

// @version v0.9.0
