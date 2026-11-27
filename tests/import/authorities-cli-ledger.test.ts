/**
 * Tests — the split and separate ledger rows of the command line's authority changes
 *
 * This suite pins what `scripts/lib/authorities-cli/ledger.ts` writes to
 * `authority_operations`, driven end to end against an in-memory
 * `node:sqlite` database as `./authorities-cli-file-ops.test.ts` drives
 * it; nothing here reaches D1.
 *
 *   - a file that creates a record and moves links to it from an existing
 *     one writes one `split` row per pair, source the original and target
 *     the created record, its detail counting the links moved;
 *   - moves between two existing records write one `separate` row per
 *     pair; place moves write their own, of record type `place`;
 *   - a file that also merges the two is refused, since no other row may
 *     name a record a merge row names, so no separate row is reached;
 *   - every such row has an id made from the file, so a rerun of an
 *     applied file writes nothing, and a file applied before the moves
 *     wrote their rows reruns clean without them;
 *   - `record-split` and `record-separate` write one row each, read back
 *     as "already recorded" on a rerun, are "same" when a row of their
 *     operation is between the two already (either direction, any
 *     writer), and are refused for a missing, merged-away or repeated
 *     record, for a pair named twice, and for a pair the file's moves
 *     record; a backfilled split takes its target's creation time (epoch
 *     ms, seconds read as such) as its `created_at`, guarded as read, and
 *     a backfilled separate the run's clock.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AuthoritiesReport } from "../../scripts/lib/authorities-cli/run";
import { ledgerRowId } from "../../scripts/lib/authorities-cli/ledger";
import { D1_LIMITS, PLACES_DDL, runFile, type RunOptions } from "./authorities-cli-places-helpers";

const FED = "fed-1";
const TENANT = "t-1";
const FILE = "ledger-test.csv";
const NOW = 1_763_600_000_000;

const VOCABULARY: Array<[string, string, string | null]> = [
  ["entity_type", "person", null],
  ["entity_role", "witness", null], ["entity_role", "mentioned", null],
  ["place_role", "venue", null], ["place_type", "city", null],
];

const AA = { id: "e-a", code: "ne-aaaaaa", name: "Juana Díaz" };
const BB = { id: "e-b", code: "ne-bbbbbb", name: "Diego Díaz" };
const CC = { id: "e-c", code: "ne-cccccc", name: "Ana Ruiz" };
const DD = { id: "e-d", code: "ne-dddddd", name: "Pedro Ruiz" };
const TUNJA = { id: "p-t", code: "nl-tttttt", label: "Tunja" };
const LEIVA = { id: "p-l", code: "nl-llllll", label: "Villa de Leiva" };

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:", D1_LIMITS);
  db.exec(PLACES_DDL);
  db.exec(`INSERT INTO federations VALUES ('${FED}', 'neogranadina-fed', 'active', '${TENANT}', 1, 'ne', 'nl');`);
  db.exec(`INSERT INTO tenants VALUES ('${TENANT}', 'neogranadina', '${FED}', NULL, 1, 'ne', 'nl');`);
  db.exec(`INSERT INTO users (id, email, name, tenant_id, is_admin) VALUES ('user_001', 'admin@example.org', 'Admin', '${TENANT}', 1);`);
  db.exec(`INSERT INTO descriptions VALUES ('d1', '${TENANT}', 'co-test-001-d001'), ('d2', '${TENANT}', 'co-test-001-d002'), ('d3', '${TENANT}', 'co-test-001-d003');`);
  const v = db.prepare("INSERT INTO vocabulary_values (id, federation_id, list, code, created_at, updated_at, inverse_code) VALUES (?, ?, ?, ?, 1, 1, ?)");
  VOCABULARY.forEach(([list, code, inverse], i) => v.run(`v-${i}`, FED, list, code, inverse));
  const e = db.prepare(
    "INSERT INTO entities (id, federation_id, tenant_id, entity_code, display_name, sort_name, entity_type, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, 'person', 1, 5)",
  );
  for (const x of [AA, BB, CC, DD]) e.run(x.id, FED, x.code, x.name, x.name);
  const p = db.prepare(
    "INSERT INTO places (id, federation_id, tenant_id, place_code, label, display_name, place_type, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, 'city', 1, 7)",
  );
  for (const x of [TUNJA, LEIVA]) p.run(x.id, FED, x.code, x.label, x.label);
  const l = db.prepare("INSERT INTO description_entities (id, description_id, entity_id, role, sequence, created_at) VALUES (?, ?, ?, ?, 0, 3)");
  l.run("de-1", "d1", AA.id, "witness");
  l.run("de-2", "d2", AA.id, "witness");
  l.run("de-3", "d3", AA.id, "mentioned");
  l.run("de-4", "d1", CC.id, "witness");
  db.exec(`INSERT INTO description_places (id, description_id, place_id, role, created_at) VALUES ('dp-1', 'd1', '${TUNJA.id}', 'venue', 3);`);
  return db;
}

type Cells = Record<string, string>;

const HEADER = ["op", "authority_code", "authority_name", "description_code", "role", "target_codes", "label_to_keep", "new_key", "display_name", "sort_name",
  "entity_type", "label", "changelog_note"];

const run = (db: DatabaseSync, rows: Cells[], opts: RunOptions = {}) => runFile(db, rows, { header: HEADER, file: FILE, now: NOW, ...opts });
const all = (db: DatabaseSync, sql: string) => db.prepare(sql).all() as Array<Record<string, any>>;
const one = (db: DatabaseSync, sql: string) => all(db, sql)[0];
const reasons = (r: AuthoritiesReport) => r.refusals.map((f) => `${f.ref}: ${f.reason}`).join("\n");
const ledger = (db: DatabaseSync) => all(db, "SELECT * FROM authority_operations ORDER BY rowid");
const snapshot = (db: DatabaseSync) =>
  JSON.stringify(["places", "entities", "description_entities", "description_places", "changelog", "authority_operations"]
    .map((t) => all(db, `SELECT * FROM ${t} ORDER BY rowid`)));

/** Applies the file, then runs it again: the second run writes nothing and reports every row done. */
async function appliesAndReruns(db: DatabaseSync, rows: Cells[], expectDone: string[]) {
  const { report } = await run(db, rows, { apply: true });
  expect(reasons(report)).toBe("");
  expect(report.problems).toEqual([]);
  expect(report.outcome).toBe("verified");
  const after = snapshot(db);
  const again = await run(db, rows, { apply: true });
  expect(reasons(again.report)).toBe("");
  expect(again.report.outcome).toBe("nothing to write");
  expect(again.applied).toEqual([]);
  expect(again.report.rows.map((r) => r.status)).toEqual(expectDone);
  expect(again.report.totals.splitsRecorded + again.report.totals.separatesRecorded).toBe(0);
  expect(snapshot(db)).toBe(after);
  return report;
}

/** A refused file: the reasons given, and nothing written by a run with apply. */
async function refused(db: DatabaseSync, rows: Cells[]): Promise<string> {
  const before = snapshot(db);
  const { report, applied } = await run(db, rows, { apply: true });
  expect(report.outcome).toBe("refused");
  expect(applied).toEqual([]);
  expect(snapshot(db)).toBe(before);
  return reasons(report);
}

const moveLink = (from: { code: string; name: string }, description: string, role: string, to: string, over: Cells = {}): Cells => ({
  op: "move-link", authority_code: from.code, authority_name: from.name, description_code: description, role, target_codes: to, ...over,
});
const createEntity = (key: string, name: string): Cells => ({ op: "create-entity", new_key: key, display_name: name, sort_name: name, entity_type: "person" });
const record = (op: "record-split" | "record-separate", a: { code: string; name: string }, targets: string, over: Cells = {}): Cells => ({
  op, authority_code: a.code, authority_name: a.name, target_codes: targets, ...over,
});

// ---------------------------------------------------------------------------
// The link moves
// ---------------------------------------------------------------------------

describe("the ledger rows of the link moves", () => {
  it("writes one split row for links moved to a record the file creates, and a rerun writes nothing", async () => {
    const db = database();
    const rows = [
      createEntity("k-menor", "Juana Díaz la menor"),
      moveLink(AA, "co-test-001-d001", "witness", "new:k-menor", { changelog_note: "Two Juanas" }),
      moveLink(AA, "co-test-001-d002", "witness", "new:k-menor"),
    ];
    const report = await appliesAndReruns(db, rows, ["already created", "already moved link", "already moved link"]);
    expect(report.totals.splitsRecorded).toBe(1);
    expect(report.totals.separatesRecorded).toBe(0);
    const menor = one(db, "SELECT id FROM entities WHERE display_name = 'Juana Díaz la menor'");
    const rowsOf = ledger(db);
    expect(rowsOf).toHaveLength(1);
    expect(rowsOf[0]).toMatchObject({
      id: await ledgerRowId(FED, TENANT, FILE, "split", "entity", AA.id, menor.id),
      federation_id: FED, record_type: "entity", operation: "split", source_id: AA.id, target_id: menor.id, user_id: "user_001", created_at: NOW,
    });
    expect(JSON.parse(rowsOf[0].detail)).toEqual({ reason: "Two Juanas", movedLinks: 2, linkIds: ["de-1", "de-2"], file: FILE });
  });

  it("writes one split row per original when links of two records move to one created record", async () => {
    const db = database();
    const rows = [
      createEntity("k-nueva", "Juana Ruiz"),
      moveLink(AA, "co-test-001-d003", "mentioned", "new:k-nueva"),
      moveLink(CC, "co-test-001-d001", "witness", "new:k-nueva"),
    ];
    await appliesAndReruns(db, rows, ["already created", "already moved link", "already moved link"]);
    const nueva = one(db, "SELECT id FROM entities WHERE display_name = 'Juana Ruiz'");
    expect(ledger(db).map((x) => [x.operation, x.source_id, x.target_id, JSON.parse(x.detail).movedLinks])).toEqual([
      ["split", AA.id, nueva.id, 1], ["split", CC.id, nueva.id, 1],
    ]);
  });

  it("writes one separate row per pair of existing records the moves move links between", async () => {
    const db = database();
    const rows = [
      moveLink(AA, "co-test-001-d001", "witness", BB.code),
      moveLink(AA, "co-test-001-d002", "witness", BB.code),
      moveLink(AA, "co-test-001-d003", "mentioned", DD.code),
    ];
    const report = await appliesAndReruns(db, rows, ["already moved link", "already moved link", "already moved link"]);
    expect(report.totals.separatesRecorded).toBe(2);
    const rowsOf = ledger(db);
    expect(rowsOf.map((x) => [x.id, x.record_type, x.operation, x.source_id, x.target_id])).toEqual([
      [await ledgerRowId(FED, TENANT, FILE, "separate", "entity", AA.id, BB.id), "entity", "separate", AA.id, BB.id],
      [await ledgerRowId(FED, TENANT, FILE, "separate", "entity", AA.id, DD.id), "entity", "separate", AA.id, DD.id],
    ]);
    expect(JSON.parse(rowsOf[0].detail)).toEqual({ reason: `Authorities change file ${FILE}, line 2`, movedLinks: 2, linkIds: ["de-1", "de-2"], file: FILE });
  });

  it("writes a separate row of record type place for a place link moved between existing places", async () => {
    const db = database();
    const rows = [{ op: "move-place-link", authority_code: TUNJA.code, authority_name: TUNJA.label, description_code: "co-test-001-d001", role: "venue", target_codes: LEIVA.code }];
    await appliesAndReruns(db, rows, ["already moved link"]);
    expect(ledger(db).map((x) => [x.record_type, x.operation, x.source_id, x.target_id])).toEqual([["place", "separate", TUNJA.id, LEIVA.id]]);
  });

  it("writes no ledger row for a link added to a created record", async () => {
    const db = database();
    const rows = [createEntity("k-sola", "Isabel Ruiz"), { op: "add-link", description_code: "co-test-001-d002", entity: "new:k-sola", role: "witness" }];
    const header = [...HEADER, "entity"];
    const { report } = await runFile(db, rows, { header, file: FILE, now: NOW, apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    expect(ledger(db)).toEqual([]);
  });

  it("refuses a file that also merges the two records, so no separate row is written", async () => {
    const db = database();
    const r = await refused(db, [
      moveLink(AA, "co-test-001-d001", "witness", BB.code),
      { op: "merge-entity", authority_code: AA.code, authority_name: AA.name, target_codes: BB.code, label_to_keep: BB.name },
    ]);
    expect(r).toMatch(/line 2: .*merged by line 3/);
  });

  it("reruns clean a file applied before the moves wrote their ledger rows", async () => {
    const db = database();
    const rows = [moveLink(AA, "co-test-001-d001", "witness", BB.code)];
    await run(db, rows, { apply: true });
    db.exec("DELETE FROM authority_operations");
    const again = await run(db, rows, { apply: true });
    expect(reasons(again.report)).toBe("");
    expect(again.report.outcome).toBe("nothing to write");
    expect(ledger(db)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// record-split and record-separate
// ---------------------------------------------------------------------------

describe("record-split and record-separate", () => {
  it("writes one row each, reads back, and a rerun finds them recorded", async () => {
    const db = database();
    const rows = [record("record-split", AA, BB.code, { changelog_note: "Split by an earlier file" }), record("record-separate", CC, DD.code)];
    const report = await appliesAndReruns(db, rows, ["already recorded split", "already recorded separate"]);
    expect(report.totals.recordSplit).toBe(1);
    expect(report.totals.recordSeparate).toBe(1);
    expect(report.totals.splitsRecorded).toBe(1);
    expect(report.totals.separatesRecorded).toBe(1);
    const rowsOf = ledger(db);
    expect(rowsOf.map((x) => [x.id, x.operation, x.source_id, x.target_id])).toEqual([
      [await ledgerRowId(FED, TENANT, FILE, "split", "entity", AA.id, BB.id), "split", AA.id, BB.id],
      [await ledgerRowId(FED, TENANT, FILE, "separate", "entity", CC.id, DD.id), "separate", CC.id, DD.id],
    ]);
    expect(JSON.parse(rowsOf[0].detail)).toEqual({ reason: "Split by an earlier file", movedLinks: 0, backfill: true, file: FILE });
    // Nothing else is written: no record takes a new version, no changelog row.
    expect(all(db, "SELECT count(*) AS n FROM changelog")[0].n).toBe(0);
    expect(all(db, "SELECT DISTINCT updated_at FROM entities")).toEqual([{ updated_at: 5 }]);
  });

  it("stamps a backfilled split with its target's creation time, in ms, and a separate with the run's clock", async () => {
    const db = database();
    const BORN = 1_700_000_123_456;
    db.exec(`UPDATE entities SET created_at = ${BORN} WHERE id = '${BB.id}'`);
    db.exec(`UPDATE entities SET created_at = 1700000500 WHERE id = '${DD.id}'`);
    await appliesAndReruns(db, [record("record-split", AA, BB.code), record("record-split", CC, DD.code), record("record-separate", AA, CC.code)],
      ["already recorded split", "already recorded split", "already recorded separate"]);
    expect(ledger(db).map((x) => [x.operation, x.target_id, x.created_at])).toEqual([
      ["split", BB.id, BORN], ["split", DD.id, 1_700_000_500_000], ["separate", CC.id, NOW],
    ]);
  });

  it("aborts the file when the target's creation time changes between the plan and the apply", async () => {
    const db = database();
    let before = "";
    await expect(run(db, [record("record-split", AA, BB.code)], {
      apply: true,
      beforeApply: (x) => {
        x.exec(`UPDATE entities SET created_at = 99 WHERE id = '${BB.id}'`);
        before = snapshot(x);
      },
    })).rejects.toThrow(/ABORT|malformed JSON/);
    expect(before).not.toBe("");
    expect(snapshot(db)).toBe(before);
  });

  it("is same when a row of its operation is already between the two, in either direction, of another writer", async () => {
    const db = database();
    db.exec(`INSERT INTO authority_operations VALUES ('op-app', '${FED}', 'entity', 'split', '${BB.id}', '${AA.id}', 'user_001', NULL, 1)`);
    const { report } = await run(db, [record("record-split", AA, BB.code)], { apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("nothing to write");
    expect(report.rows.map((r) => r.status)).toEqual(["same"]);
    // A separate is another operation: it is written beside the split.
    const sep = await run(db, [record("record-separate", AA, BB.code)], { apply: true, file: "other.csv" });
    expect(sep.report.outcome).toBe("verified");
    expect(ledger(db).map((x) => x.operation)).toEqual(["split", "separate"]);
  });

  it("is refused for a missing, merged-away or repeated record, two targets, a pair named twice, and a pair the moves record", async () => {
    const db = database();
    db.exec(`UPDATE entities SET merged_into = '${BB.id}' WHERE id = '${DD.id}'`);
    const r = await refused(db, [
      record("record-split", AA, "ne-zzzzzz"),
      record("record-split", AA, DD.code),
      record("record-separate", AA, AA.code),
      record("record-separate", AA, `${BB.code} ${CC.code}`),
      record("record-separate", BB, CC.code),
      record("record-separate", CC, BB.code),
      moveLink(AA, "co-test-001-d001", "witness", BB.code),
      record("record-separate", BB, AA.code),
      record("record-split", { code: "ne-yyyyyy", name: "Nadie" }, BB.code),
    ]);
    expect(r).toMatch(/line 2: no entity has the code ne-zzzzzz/);
    expect(r).toMatch(/line 3: the target ne-dddddd is merged into e-b/);
    expect(r).toMatch(/line 4: target ne-aaaaaa is the row's own authority/);
    expect(r).toMatch(/line 5: record-separate names exactly one target code/);
    expect(r).toMatch(/line 7: the separate of ne-cccccc and ne-bbbbbb is recorded by line 6 as well/);
    expect(r).toMatch(/line 9: the separate of ne-bbbbbb and ne-aaaaaa is recorded by the moves of line 8 as well/);
    expect(r).toMatch(/line 10: no entity has the code ne-yyyyyy/);
  });

  it("is refused from a workspace record to a shared one when the actor is not a steward, in either direction", async () => {
    const db = database();
    db.exec(`UPDATE users SET is_admin = 0, is_authorities_admin = 1, is_records_admin = 1 WHERE id = 'user_001'`);
    db.exec(`UPDATE entities SET tenant_id = '${TENANT}' WHERE id = '${AA.id}'`);
    const before = snapshot(db);
    for (const rows of [
      [record("record-split", AA, BB.code)],
      [record("record-separate", BB, AA.code)],
    ]) {
      await expect(run(db, rows, { apply: true })).rejects.toThrow(/is not a steward of neogranadina-fed, whose shared records the file changes/);
    }
    expect(snapshot(db)).toBe(before);
    // Between two of the workspace's own records, no steward is needed.
    db.exec(`UPDATE entities SET tenant_id = '${TENANT}' WHERE id = '${BB.id}'`);
    await appliesAndReruns(db, [record("record-split", AA, BB.code)], ["already recorded split"]);
  });

  it("refuses a file whose ledger row exists while its moves would still write", async () => {
    const db = database();
    const id = await ledgerRowId(FED, TENANT, FILE, "separate", "entity", AA.id, BB.id);
    db.exec(`INSERT INTO authority_operations VALUES ('${id}', '${FED}', 'entity', 'separate', '${AA.id}', '${BB.id}', 'user_001', NULL, 1)`);
    const r = await refused(db, [moveLink(AA, "co-test-001-d001", "witness", BB.code)]);
    expect(r).toMatch(/line 2 was applied before and has changed since: .*separate ledger row/);
  });
});

// @version v0.9.0
