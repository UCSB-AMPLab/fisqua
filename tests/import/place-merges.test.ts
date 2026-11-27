/**
 * Tests — applying the reviewed list of place merges
 *
 * This suite pins `scripts/lib/place-merges.ts`, the planning and SQL
 * behind `scripts/commands/place-merges.ts`. Lists and places are built
 * here; the SQL runs against an in-memory `node:sqlite` database holding
 * the columns the statements touch. Nothing here reaches D1.
 *
 *   - the list: MATCH rows and AUTO rows not pulled back merge;
 *     NOT-MATCH, DOUBTFUL and pulled-back rows are counted and skipped;
 *     the Zipaquira pair is added when the list lacks it;
 *   - refusals: a code not found, a loser twice, a loser already merged,
 *     a survivor itself merged, a chain that does not end at
 *     `final_survivor_code`, a carried value that differs from the
 *     loser's record, and two losers carrying different values into one
 *     field each refuse the run;
 *   - labels: the article test, a named outcome standing over it, and
 *     the note when the new label's TGN is not carried;
 *   - carries: "[verify before carrying]", B099's tgn and B019's point
 *     are reported and not carried;
 *   - the SQL: the statements `pair-merge.server.ts` composes, run
 *     through Drizzle against one database, and the rendered SQL file
 *     run against another, leave identical tables; links move or drop
 *     per the collision rule across losers sharing a survivor; the loser
 *     is merged, names fold, the relabelled survivor keeps its old
 *     label as a variant and takes the carried ids; each pair has a
 *     ledger row; another tenant's links stay on the loser and its link
 *     counts do not trip the guards; and a record changed after the
 *     read fails the file,
 *     including a survivor link a collision relied on, a loser link whose
 *     role or description changed, a survivor whose updated_at moved, a
 *     loser whose names or ids changed, coordinates partly filled since
 *     the read (a longitude-only survivor is refused), a field a carry
 *     fills; a survivor whose stored name_variants is NULL, and places
 *     whose stored precision is an empty string, pass; and 150 merges
 *     apply under D1's expression depth limit of 100, which every
 *     database here enforces.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolveCommandActor } from "../../scripts/lib/authority-links";
import { reader, seedActing, stewardMembership } from "./acting-tables";
import { drizzle } from "drizzle-orm/d1";
import {
  ZIPAQUIRA,
  articleRule,
  buildStatements,
  planMerges,
  readMergeList,
  storedOf,
  STATEMENT_BUDGET,
  type MergeRow,
  type PlaceRow,
  type StoredPlace,
} from "../../scripts/lib/place-merges";
import type { JunctionRow } from "../../app/lib/pair-merge.server";

const FED = "fed-1";
/** D1 caps expression depth at 100 (SQLite defaults to 1000); the Node typings in use do not list `limits`. */
const D1_LIMITS = { limits: { exprDepth: 100 } } as unknown as ConstructorParameters<typeof DatabaseSync>[1];
const HEADER =
  "decision,original_decision,review_no,review_class,bucket,survivor_code,survivor_label,loser_code,loser_label," +
  "final_survivor_code,label_current,label_final,label_basis,external_ids_keep,loser_ids_not_carried," +
  "carry_over_ids_coords,carry_over_name_variants,links_moving,distance_km,auto_flag,reason,evidence_summary";

function csv(lines: string[]): Uint8Array {
  return new TextEncoder().encode([HEADER, ...lines].join("\n") + "\n");
}

function csvRow(f: Partial<Record<string, string>>): string {
  const cols = HEADER.split(",");
  return cols.map((c) => {
    const v = f[c] ?? "";
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(",");
}

function place(code: string, label: string, over: Partial<PlaceRow> = {}): PlaceRow {
  return {
    id: `id-${code}`, federationId: FED, tenantId: null, code, label, displayName: label, nameVariants: "[]",
    mergedInto: null, tgnId: null, hgisId: null, whgId: null, latitude: null, longitude: null,
    coordinatePrecision: null, legacyIds: "[]", updatedAt: 1, ...over,
  };
}

function row(over: Partial<MergeRow>): MergeRow {
  return {
    ref: "B001", decision: "AUTO", survivorCode: "", loserCode: "", finalSurvivorCode: "", labelCurrent: "",
    labelFinal: "", labelBasis: "most-linked", carry: "", idsNotCarried: "", autoFlag: "", ...over,
  };
}

const index = (list: PlaceRow[]) => {
  const m = new Map<string, PlaceRow[]>();
  for (const p of list) m.set(p.code, [...(m.get(p.code) ?? []), p]);
  return m;
};

function link(id: string, placeId: string, descriptionId: string, role = "mentioned"): JunctionRow {
  return { id, descriptionId, placeId, role, roleNote: null, roleRaw: null, createdAt: 1000 };
}

// ---------------------------------------------------------------------------
// A fixture: Guachipa takes Huachipa (relabelled, ids carried); Cuchillas takes
// Cuchilla and, through the chain, La Cuchilla.
// ---------------------------------------------------------------------------

const guachipa = place("nl-guach1", "Guachipa", { nameVariants: '["Guachipas"]' });
const huachipa = place("nl-huach1", "Huachipa", {
  nameVariants: '["Huachipas"]', tgnId: "1024512", latitude: -12.018079, longitude: -76.94768,
});
const cuchillas = place("nl-cuchs1", "Cuchillas", { nameVariants: '["Las Cuchillas"]' });
const cuchilla = place("nl-cuch01", "Cuchilla");
const laCuchilla = place("nl-lacu01", "La Cuchilla");
const fixturePlaces = [guachipa, huachipa, cuchillas, cuchilla, laCuchilla];

const fixtureRows: MergeRow[] = [
  row({
    ref: "B011", survivorCode: guachipa.code, loserCode: huachipa.code, finalSurvivorCode: guachipa.code,
    labelCurrent: "Guachipa", labelFinal: "Huachipa", labelBasis: "tgn-record",
    carry: "tgn_id=1024512; coords=-12.018079,-76.94768 (no precision)",
  }),
  row({ ref: "row 233", decision: "MATCH", survivorCode: cuchillas.code, loserCode: cuchilla.code, finalSurvivorCode: cuchillas.code, labelCurrent: "Cuchillas", labelFinal: "Cuchillas" }),
  row({ ref: "row 234", decision: "MATCH", survivorCode: cuchilla.code, loserCode: laCuchilla.code, finalSurvivorCode: cuchillas.code, labelCurrent: "Cuchilla", labelFinal: "Cuchillas" }),
];

const fixtureLinks = [
  link("dp-1", huachipa.id, "d1"),
  link("dp-2", huachipa.id, "d2"),
  link("dp-3", guachipa.id, "d2"), // Guachipa already holds d2 as mentioned: dp-2 drops
  link("dp-4", cuchilla.id, "d3"),
  link("dp-5", laCuchilla.id, "d3"), // moved by Cuchilla first, so La Cuchilla's drops
  link("dp-6", laCuchilla.id, "d3", "subject"), // a different role moves
];

function linksByPlace(links: JunctionRow[]): Map<string, JunctionRow[]> {
  const m = new Map<string, JunctionRow[]>();
  for (const l of links) m.set(l.placeId as string, [...(m.get(l.placeId as string) ?? []), l]);
  return m;
}

const DDL = `
CREATE TABLE places (id TEXT PRIMARY KEY, federation_id TEXT NOT NULL, tenant_id TEXT, place_code TEXT, label TEXT NOT NULL,
  display_name TEXT NOT NULL, name_variants TEXT DEFAULT '[]', merged_into TEXT, tgn_id TEXT, hgis_id TEXT, whg_id TEXT,
  latitude REAL, longitude REAL, coordinate_precision TEXT, legacy_ids TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
CREATE TABLE description_places (id TEXT PRIMARY KEY, description_id TEXT NOT NULL, place_id TEXT NOT NULL, role TEXT NOT NULL,
  role_note TEXT, role_raw TEXT, created_at INTEGER NOT NULL, UNIQUE (description_id, place_id, role));
CREATE TABLE changelog (id TEXT PRIMARY KEY, record_id TEXT NOT NULL, record_type TEXT NOT NULL, user_id TEXT NOT NULL,
  note TEXT, diff TEXT NOT NULL, run_id TEXT, kind TEXT NOT NULL DEFAULT 'update', created_at INTEGER NOT NULL, acted_as TEXT);
CREATE TABLE authority_operations (id TEXT PRIMARY KEY, federation_id TEXT NOT NULL, record_type TEXT NOT NULL,
  operation TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT, user_id TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
CREATE TABLE descriptions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);
-- Every description a link names belongs to TENANT unless a test seeds it
-- under another tenant first.
CREATE TRIGGER link_description AFTER INSERT ON description_places BEGIN
  INSERT OR IGNORE INTO descriptions (id, tenant_id) VALUES (NEW.description_id, 't-1');
END;
`;

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:", D1_LIMITS);
  db.exec(DDL);
  const ins = db.prepare(
    "INSERT INTO places (id, federation_id, place_code, label, display_name, name_variants, tgn_id, latitude, longitude, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)",
  );
  for (const p of fixturePlaces) ins.run(p.id, p.federationId, p.code, p.label, p.displayName, p.nameVariants, p.tgnId, p.latitude, p.longitude);
  const l = db.prepare("INSERT INTO description_places (id, description_id, place_id, role, created_at) VALUES (?, ?, ?, ?, 1000)");
  for (const x of fixtureLinks) l.run(x.id, x.descriptionId, x.placeId as string, x.role);
  return db;
}

/** A D1 binding over node:sqlite, enough for Drizzle to run one statement at a time. */
function d1(db: DatabaseSync): any {
  const statement = (sql: string, params: unknown[] = []): any => ({
    bind: (...p: unknown[]) => statement(sql, p),
    run: async () => {
      const r = db.prepare(sql).run(...(params as any[]));
      return { success: true, results: [], meta: { changes: Number(r.changes) } };
    },
    all: async () => ({ success: true, results: db.prepare(sql).all(...(params as any[])), meta: {} }),
  });
  return { prepare: (sql: string) => statement(sql) };
}

const dump = (db: DatabaseSync) =>
  Object.fromEntries(
    ["places", "description_places", "changelog", "authority_operations"].map((t) => [
      t, db.prepare(`SELECT * FROM ${t} ORDER BY id`).all(),
    ]),
  );

describe("the list", () => {
  it("merges MATCH and AUTO rows not pulled back, counts the rest, and adds the Zipaquira pair", () => {
    const s = readMergeList(csv([
      csvRow({ decision: "AUTO", bucket: "B001", survivor_code: "nl-a", loser_code: "nl-b", final_survivor_code: "nl-a" }),
      csvRow({ decision: "AUTO", bucket: "B064", survivor_code: "nl-c", loser_code: "nl-d", auto_flag: "PULL BACK: two places" }),
      csvRow({ decision: "AUTO", bucket: "B099", survivor_code: "nl-e", loser_code: "nl-f", final_survivor_code: "nl-e", auto_flag: "CARRY-OVER CHECK: hold" }),
      csvRow({ decision: "MATCH", review_no: "24", survivor_code: "nl-g", loser_code: "nl-h", final_survivor_code: "nl-g" }),
      csvRow({ decision: "NOT-MATCH", review_no: "10", survivor_code: "nl-i", loser_code: "nl-j" }),
      csvRow({ decision: "DOUBTFUL", review_no: "121", survivor_code: "nl-k", loser_code: "nl-l" }),
    ]));
    expect(s.rows.map((r) => r.ref)).toEqual(["B001", "B099", "row 24", "Zipaquira (ruling)"]);
    expect(s.skipped).toEqual({ "AUTO (PULL BACK)": 1, "NOT-MATCH": 1, DOUBTFUL: 1 });
    expect(s.pulledBack).toEqual(["B064"]);
    expect(s.zipaquiraAdded).toBe(true);
    expect(s.rows[3]).toMatchObject({ loserCode: "nl-nstfgb", finalSurvivorCode: "nl-s9z5px" });
  });

  it("does not add the Zipaquira pair twice", () => {
    const s = readMergeList(csv([
      csvRow({ decision: "AUTO", bucket: "B329", survivor_code: "nl-s9z5px", loser_code: "nl-nstfgb", final_survivor_code: "nl-s9z5px" }),
    ]));
    expect(s.rows).toHaveLength(1);
    expect(s.zipaquiraAdded).toBe(false);
  });
});

describe("refusals", () => {
  const plan = (rows: MergeRow[], list: PlaceRow[]) => planMerges(rows, index(list), []).refusals.map((r) => r.reason);

  it("passes the fixture", () => {
    expect(plan(fixtureRows, fixturePlaces)).toEqual([]);
  });

  it("refuses a code not found", () => {
    expect(plan([row({ survivorCode: "nl-a", loserCode: "nl-x", finalSurvivorCode: "nl-a" })], [place("nl-a", "A")]))
      .toContain("loser nl-x not found");
  });

  it("refuses a loser listed twice", () => {
    const list = [place("nl-a", "A"), place("nl-b", "B"), place("nl-c", "C")];
    expect(plan([
      row({ survivorCode: "nl-a", loserCode: "nl-b", finalSurvivorCode: "nl-a" }),
      row({ ref: "B002", survivorCode: "nl-c", loserCode: "nl-b", finalSurvivorCode: "nl-c" }),
    ], list).some((r) => r.startsWith("loser nl-b appears twice"))).toBe(true);
  });

  it("refuses a loser already merged and a survivor that is itself merged", () => {
    const reasons = plan(
      [row({ survivorCode: "nl-a", loserCode: "nl-b", finalSurvivorCode: "nl-a" })],
      [place("nl-a", "A", { mergedInto: "id-z" }), place("nl-b", "B", { mergedInto: "id-y" })],
    );
    expect(reasons).toContain("loser nl-b is already merged (into id-y)");
    expect(reasons).toContain("survivor nl-a is itself merged (into id-z)");
  });

  it("refuses a chain that does not end at final_survivor_code", () => {
    const rows = fixtureRows.map((r) => (r.ref === "row 234" ? { ...r, finalSurvivorCode: cuchilla.code } : r));
    const reasons = plan(rows, fixturePlaces);
    expect(reasons).toContain(`chain from ${laCuchilla.code} ends at ${cuchillas.code}, not at final_survivor_code ${cuchilla.code}`);
  });

  it("refuses a carried value that differs from the loser's record", () => {
    const rows = fixtureRows.map((r) => (r.ref === "B011" ? { ...r, carry: "tgn_id=999" } : r));
    expect(plan(rows, fixturePlaces)).toContain(`listed tgnId 999 differs from ${huachipa.code}'s 1024512`);
  });

  it("refuses two losers carrying different values into one field", () => {
    const list = [place("nl-a", "A"), place("nl-b", "B", { tgnId: "1" }), place("nl-c", "C", { tgnId: "2" })];
    const reasons = plan([
      row({ survivorCode: "nl-a", loserCode: "nl-b", finalSurvivorCode: "nl-a", carry: "tgn_id=1" }),
      row({ ref: "B002", survivorCode: "nl-a", loserCode: "nl-c", finalSurvivorCode: "nl-a", carry: "tgn_id=2" }),
    ], list);
    expect(reasons).toContain("nl-b and nl-c would both carry tgnId into nl-a (1 / 2)");
  });

  it("refuses when the exception groups are not the ones the ruling lists", () => {
    expect(planMerges(fixtureRows, index(fixturePlaces)).refusals.map((r) => r.ref)).toEqual(["labels"]);
  });
});

describe("labels and carries", () => {
  it("takes the TGN spelling only when it adds a leading article", () => {
    expect(articleRule("Habana", "La Habana")).toBe("La Habana");
    expect(articleRule("Londres", "London")).toBe("Londres");
    expect(articleRule("La Palma", "Palma")).toBe("La Palma");
    expect(articleRule("Socorro", "Los Socorro")).toBe("Los Socorro");
  });

  it("lets an outcome named in the ruling stand over the article test", () => {
    const list = [
      place("nl-p", "Pereira"), place("nl-lp", "La Pereira", { tgnId: "1023915" }),
      place("nl-v", "Victoria"), place("nl-lv", "La Victoria", { tgnId: "1024579" }),
    ];
    const plan = planMerges([
      row({ ref: "row 96", decision: "MATCH", survivorCode: "nl-p", loserCode: "nl-lp", finalSurvivorCode: "nl-p", labelCurrent: "Pereira", labelFinal: "Pereira", labelBasis: 'most-linked (tgn record "La Pereira" differs only by article/qualifier)', carry: "tgn_id=1023915" }),
      row({ ref: "B099", survivorCode: "nl-v", loserCode: "nl-lv", finalSurvivorCode: "nl-v", labelCurrent: "Victoria", labelFinal: "Victoria", labelBasis: 'most-linked (tgn record "La Victoria" differs only by article/qualifier)', carry: "tgn_id=1024579" }),
    ], index(list), ["Pereira", "Victoria"]);
    expect(plan.refusals).toEqual([]);
    const [pereira, victoria] = plan.labelDecisions;
    expect(pereira).toMatchObject({ ruleGives: "La Pereira", named: "Pereira", applied: "Pereira" });
    expect(victoria).toMatchObject({ ruleGives: "La Victoria", named: "Victoria", applied: "Victoria" });
    expect(plan.notCarried).toContainEqual(expect.objectContaining({ ref: "B099", why: "withheld by the ruling" }));
    expect(plan.groups.find((g) => g.survivor.code === "nl-p")!.carried.map((c) => c.value)).toEqual(["1023915"]);
  });

  it("carries nothing marked for verification or from Huaycho", () => {
    const list = [
      place("nl-a", "A"), place("nl-b", "B", { tgnId: "6003281", whgId: "5" }),
      place("nl-c", "Guaycho"), place("nl-d", "Huaycho", { latitude: -11.17, longitude: -76.99, hgisId: "h" }),
    ];
    const plan = planMerges([
      row({ ref: "row 95", survivorCode: "nl-a", loserCode: "nl-b", finalSurvivorCode: "nl-a", carry: "tgn_id=6003281 [verify before carrying]; whg_id=5" }),
      row({ ref: "B019", survivorCode: "nl-c", loserCode: "nl-d", finalSurvivorCode: "nl-c" }),
    ], index(list), []);
    expect(plan.refusals).toEqual([]);
    expect(plan.groups.flatMap((g) => g.carried).map((c) => `${c.field}=${c.value}`)).toEqual(["whgId=5"]);
    expect(plan.notCarried.map((n) => n.ref)).toEqual(["row 95", "B019"]);
  });
});

describe("the SQL", () => {
  const plan = planMerges(fixtureRows, index(fixturePlaces), []);
  const opts = { userId: "user_001", now: 1_761_336_000_000, tenantId: "t-1" };

  it("leaves the same tables through Drizzle and through the rendered file", async () => {
    const viaDrizzle = database();
    const viaFile = database();
    const built = buildStatements(plan, linksByPlace(fixtureLinks), opts, drizzle(d1(viaDrizzle)));
    for (const s of built.composed) await s.run();
    viaFile.exec(built.sql.join("\n"));
    expect(dump(viaFile)).toEqual(dump(viaDrizzle));
  });

  it("leaves another tenant's links on the loser, and its guards count only this tenant's", () => {
    const db = database();
    // A second tenant's description links a loser, and the survivor
    // already holds the same description and role.
    db.exec("INSERT INTO descriptions (id, tenant_id) VALUES ('other-1', 't-2')");
    db.exec(
      "INSERT INTO description_places (id, description_id, place_id, role, created_at) VALUES " +
        `('dp-x', 'other-1', '${huachipa.id}', 'mentioned', 1000), ('dp-y', 'other-1', '${guachipa.id}', 'mentioned', 1000)`,
    );
    const built = buildStatements(plan, linksByPlace(fixtureLinks), opts);
    db.exec(built.sql.join("\n"));
    expect(db.prepare("SELECT id, place_id FROM description_places WHERE id IN ('dp-x', 'dp-y') ORDER BY id").all()).toEqual([
      { id: "dp-x", place_id: huachipa.id },
      { id: "dp-y", place_id: guachipa.id },
    ]);
    expect(db.prepare("SELECT merged_into FROM places WHERE id = ?").get(huachipa.id)).toEqual({ merged_into: guachipa.id });
  });

  it("moves, drops, folds, merges, relabels and carries as planned", () => {
    const db = database();
    const built = buildStatements(plan, linksByPlace(fixtureLinks), opts);
    db.exec(built.sql.join("\n"));
    expect(built.movedLinks).toBe(3);
    expect(built.droppedLinks).toBe(2);

    const links = db.prepare("SELECT id, place_id, role FROM description_places ORDER BY id").all();
    expect(links).toEqual([
      { id: "dp-1", place_id: guachipa.id, role: "mentioned" },
      { id: "dp-3", place_id: guachipa.id, role: "mentioned" },
      { id: "dp-4", place_id: cuchillas.id, role: "mentioned" },
      { id: "dp-6", place_id: cuchillas.id, role: "subject" },
    ]);

    const rows = Object.fromEntries(
      (db.prepare("SELECT place_code, label, display_name, name_variants, merged_into, tgn_id, latitude FROM places").all() as any[])
        .map((r) => [r.place_code, r]),
    );
    expect(rows[huachipa.code].merged_into).toBe(guachipa.id);
    expect(rows[cuchilla.code].merged_into).toBe(cuchillas.id);
    expect(rows[laCuchilla.code].merged_into).toBe(cuchillas.id);
    expect(rows[guachipa.code]).toMatchObject({ label: "Huachipa", display_name: "Huachipa", tgn_id: "1024512", latitude: -12.018079 });
    expect(JSON.parse(rows[guachipa.code].name_variants)).toEqual(["Guachipas", "Huachipas", "Guachipa"]);
    expect(JSON.parse(rows[cuchillas.code].name_variants)).toEqual(["Las Cuchillas", "Cuchilla", "La Cuchilla"]);
    expect(rows[cuchillas.code].label).toBe("Cuchillas");

    const ledger = db.prepare("SELECT source_id, target_id, detail FROM authority_operations ORDER BY source_id").all() as any[];
    expect(ledger.map((l) => [l.source_id, l.target_id])).toEqual([
      [cuchilla.id, cuchillas.id], [huachipa.id, guachipa.id], [laCuchilla.id, cuchillas.id],
    ]);
    const huachipaDetail = JSON.parse(ledger[1].detail);
    expect(huachipaDetail).toMatchObject({ movedLinks: 1, addVariants: true, leftBehind: 0, listRef: "B011" });
    expect(huachipaDetail.droppedLinks).toEqual([fixtureLinks[1]]);
    expect(huachipaDetail.carried).toEqual({ tgnId: "1024512", coords: "-12.018079,-76.94768 (no precision)" });

    const kinds = db.prepare("SELECT kind, count(*) AS n FROM changelog GROUP BY kind ORDER BY kind").all();
    // 3 moves (unlink + link each), 2 drops (unlink), 3 loser and 3 survivor
    // updates from the merges, and Guachipa's relabel.
    expect(kinds).toEqual([{ kind: "link", n: 3 }, { kind: "unlink", n: 5 }, { kind: "update", n: 7 }]);
    const relabel = db.prepare(`SELECT diff FROM changelog WHERE record_id = ? AND diff LIKE '%"label"%'`).get(guachipa.id) as any;
    expect(JSON.parse(relabel.diff)).toMatchObject({ label: { old: "Guachipa", new: "Huachipa" }, tgnId: { old: null, new: "1024512" } });
  });

  it("fails the file when a record changed after it was read", () => {
    const db = database();
    db.prepare("UPDATE places SET name_variants = '[\"Guachipá\"]' WHERE id = ?").run(guachipa.id);
    const built = buildStatements(plan, linksByPlace(fixtureLinks), opts);
    expect(() => db.exec(built.sql.join("\n"))).toThrow();
  });

  /** Run the file as D1 does, as one unit: a failing guard leaves nothing written. */
  function applyAsOneUnit(db: DatabaseSync, sql: string[]): void {
    db.exec("BEGIN");
    try {
      db.exec(sql.join("\n"));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  it("fails the file when the survivor's colliding link changed after the read, and keeps the loser's link", () => {
    const db = database();
    const built = buildStatements(plan, linksByPlace(fixtureLinks), opts);
    // Guachipa's d2 link (the one Huachipa's dp-2 collides with) now points at
    // another description; the link counts are unchanged.
    db.prepare("UPDATE description_places SET description_id = 'd9' WHERE id = 'dp-3'").run();
    expect(() => applyAsOneUnit(db, built.sql)).toThrow(/malformed JSON/);
    expect(db.prepare("SELECT place_id FROM description_places WHERE id = 'dp-2'").get()).toEqual({ place_id: huachipa.id });
  });

  it("fails the file when a field a carry fills was filled after the read", () => {
    const db = database();
    const built = buildStatements(plan, linksByPlace(fixtureLinks), opts);
    db.prepare("UPDATE places SET tgn_id = '999' WHERE id = ?").run(guachipa.id);
    expect(() => applyAsOneUnit(db, built.sql)).toThrow(/malformed JSON/);
    expect(db.prepare("SELECT tgn_id FROM places WHERE id = ?").get(guachipa.id)).toEqual({ tgn_id: "999" });
  });

  /** Apply the fixture plan after `change` runs, and expect the file to fail with nothing written. */
  function failsAfter(change: (db: DatabaseSync) => void): DatabaseSync {
    const db = database();
    const built = buildStatements(plan, linksByPlace(fixtureLinks), opts);
    change(db);
    const before = dump(db);
    expect(() => applyAsOneUnit(db, built.sql)).toThrow(/malformed JSON/);
    expect(dump(db)).toEqual(before);
    return db;
  }

  it("fails the file when a loser link's role changed after the read", () => {
    // dp-2 was planned as a collision with Guachipa's d2 'mentioned'; as
    // 'subject' it is a distinct link the drop would destroy.
    failsAfter((db) => db.prepare("UPDATE description_places SET role = 'subject' WHERE id = 'dp-2'").run());
  });

  it("fails the file when a loser link's description changed after the read", () => {
    failsAfter((db) => db.prepare("UPDATE description_places SET description_id = 'd9' WHERE id = 'dp-2'").run());
  });

  it("fails the file when a survivor's updated_at changed after the read", () => {
    failsAfter((db) => db.prepare("UPDATE places SET updated_at = 2 WHERE id = ?").run(cuchillas.id));
  });

  it("fails the file when a loser's names or ids changed after the read, whatever its updated_at", () => {
    failsAfter((db) => db.prepare(`UPDATE places SET name_variants = '["Huachipá"]' WHERE id = ?`).run(huachipa.id));
    failsAfter((db) => db.prepare("UPDATE places SET tgn_id = '1024513' WHERE id = ?").run(huachipa.id));
  });

  it("fails the file when a survivor gained a longitude or a precision after the read", () => {
    failsAfter((db) => db.prepare("UPDATE places SET longitude = -76.9 WHERE id = ?").run(guachipa.id));
    failsAfter((db) => db.prepare("UPDATE places SET coordinate_precision = 'approximate' WHERE id = ?").run(guachipa.id));
  });

  it("refuses a coordinate carry into a survivor holding only a longitude", () => {
    const partial = { ...guachipa, longitude: -76.9 };
    const refusals = planMerges(fixtureRows, index(fixturePlaces.map((p) => (p.code === guachipa.code ? partial : p))), []).refusals;
    expect(refusals.map((r) => r.reason)).toContain(
      `${guachipa.code} already holds coords null,-76.9 (no precision); the list carries -12.018079,-76.94768 (no precision)`,
    );
  });

  it("applies over an empty-string precision, compared as stored and carried into as empty", () => {
    // Guachipa (survivor, no coordinates) and Huachipa (loser) store '' as
    // their precision; the planner reads it as empty and the guard as ''.
    const withEmpty = (p: PlaceRow): PlaceRow => ({ ...p, stored: { ...storedOf(p), coordinate_precision: "" } });
    const list = fixturePlaces.map((p) => (p === guachipa || p === huachipa ? withEmpty(p) : p));
    const emptyPlan = planMerges(fixtureRows, index(list), []);
    expect(emptyPlan.refusals).toEqual([]);
    const db = database();
    db.prepare("UPDATE places SET coordinate_precision = '' WHERE id IN (?, ?)").run(guachipa.id, huachipa.id);
    applyAsOneUnit(db, buildStatements(emptyPlan, linksByPlace(fixtureLinks), opts).sql);
    expect(db.prepare("SELECT latitude, longitude FROM places WHERE id = ?").get(guachipa.id))
      .toEqual({ latitude: -12.018079, longitude: -76.94768 });
    // Without the stored values the guard would compare IS NULL and stop the file.
    const db2 = database();
    db2.prepare("UPDATE places SET coordinate_precision = '' WHERE id IN (?, ?)").run(guachipa.id, huachipa.id);
    expect(() => applyAsOneUnit(db2, buildStatements(plan, linksByPlace(fixtureLinks), opts).sql)).toThrow(/malformed JSON/);
  });

  it("applies 150 merges under D1's expression depth limit of 100", () => {
    const survivorsBulk = Array.from({ length: 150 }, (_, i) => place(`nl-s${i}`, `S${i}`));
    const losersBulk = Array.from({ length: 150 }, (_, i) => place(`nl-l${i}`, `L${i}`));
    const rows = losersBulk.map((l, i) =>
      row({ ref: `B${i}`, survivorCode: `nl-s${i}`, loserCode: l.code, finalSurvivorCode: `nl-s${i}`, labelCurrent: `S${i}`, labelFinal: `S${i}` }),
    );
    const bulkPlan = planMerges(rows, index([...survivorsBulk, ...losersBulk]), []);
    expect(bulkPlan.refusals).toEqual([]);
    const links = losersBulk.map((l, i) => link(`dp-l${i}`, l.id, `d${i}`));
    const db = new DatabaseSync(":memory:", D1_LIMITS);
    db.exec(DDL);
    const ins = db.prepare("INSERT INTO places (id, federation_id, place_code, label, display_name, name_variants, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '[]', 1, 1)");
    for (const p of [...survivorsBulk, ...losersBulk]) ins.run(p.id, FED, p.code, p.label, p.displayName);
    const l = db.prepare("INSERT INTO description_places (id, description_id, place_id, role, created_at) VALUES (?, ?, ?, 'mentioned', 1000)");
    for (const x of links) l.run(x.id, x.descriptionId, x.placeId as string);
    applyAsOneUnit(db, buildStatements(bulkPlan, linksByPlace(links), opts).sql);
    expect(db.prepare("SELECT count(*) AS n FROM places WHERE merged_into IS NOT NULL").get()).toEqual({ n: 150 });
  });

  it("fails the file when a survivor's federation changed after the read, even when the fold changes nothing", () => {
    // The updates are scoped by federation. A survivor that already holds its
    // loser's name gains nothing from the fold, so only the opening guard can
    // see it leave: otherwise its update matches no row and the loser points
    // across federations.
    const survivor = place("nl-surv01", "Tunja", { nameVariants: '["Tunxa"]' });
    const loser = place("nl-lose01", "Tunxa");
    const rows = [row({ survivorCode: survivor.code, loserCode: loser.code, finalSurvivorCode: survivor.code, labelCurrent: "Tunja", labelFinal: "Tunja" })];
    const quiet = planMerges(rows, index([survivor, loser]), []);
    expect(quiet.refusals).toEqual([]);
    const db = new DatabaseSync(":memory:", D1_LIMITS);
    db.exec(DDL);
    const ins = db.prepare("INSERT INTO places (id, federation_id, place_code, label, display_name, name_variants, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)");
    for (const p of [survivor, loser]) ins.run(p.id, FED, p.code, p.label, p.displayName, p.nameVariants);
    const built = buildStatements(quiet, new Map(), opts);
    db.prepare("UPDATE places SET federation_id = 'fed-2' WHERE id = ?").run(survivor.id);
    expect(() => applyAsOneUnit(db, built.sql)).toThrow(/malformed JSON/);
    expect(db.prepare("SELECT merged_into FROM places WHERE id = ?").get(loser.id)).toEqual({ merged_into: null });
  });

  it("fails the file when the Zipaquira loser's Django id or a place code changed after the read", () => {
    // The plan allows the Zipaquira pair only while the records hold Django
    // places 99306 and 96418; legacy_ids and place_code are guarded as stored.
    const survivor = place(ZIPAQUIRA.survivorCode, "Zipaquirá", { legacyIds: '[{"provider":"django-zasqua","id":96418}]' });
    const loser = place(ZIPAQUIRA.loserCode, "Zipaquira", { legacyIds: '[{"provider":"django-zasqua","id":99306}]' });
    const rows = [row({ ref: "B329", survivorCode: survivor.code, loserCode: loser.code, finalSurvivorCode: survivor.code, labelCurrent: "Zipaquirá", labelFinal: "Zipaquirá" })];
    const zip = planMerges(rows, index([survivor, loser]), []);
    expect(zip.refusals).toEqual([]);
    const run = (change: string) => {
      const db = new DatabaseSync(":memory:", D1_LIMITS);
      db.exec(DDL);
      const ins = db.prepare("INSERT INTO places (id, federation_id, place_code, label, display_name, name_variants, legacy_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)");
      for (const p of [survivor, loser]) ins.run(p.id, FED, p.code, p.label, p.displayName, p.nameVariants, p.legacyIds);
      const built = buildStatements(zip, new Map(), opts);
      if (change) db.exec(change);
      applyAsOneUnit(db, built.sql);
      return db.prepare("SELECT merged_into FROM places WHERE id = ?").get(loser.id);
    };
    expect(run("")).toEqual({ merged_into: survivor.id });
    expect(() => run(`UPDATE places SET legacy_ids = '[]' WHERE id = '${loser.id}'`)).toThrow(/malformed JSON/);
    expect(() => run(`UPDATE places SET place_code = 'nl-other1' WHERE id = '${survivor.id}'`)).toThrow(/malformed JSON/);
  });

  it("fails the file when an UPDATE in it touches no row", () => {
    // A trigger that silently skips one write stands in for any update whose
    // WHERE no longer matches: the closing guards notice either way.
    failsAfter((db) => db.exec(`CREATE TRIGGER skip_link BEFORE UPDATE ON description_places WHEN OLD.id = 'dp-1' BEGIN SELECT RAISE(IGNORE); END;`));
    failsAfter((db) => db.exec(`CREATE TRIGGER skip_drop BEFORE DELETE ON description_places WHEN OLD.id = 'dp-2' BEGIN SELECT RAISE(IGNORE); END;`));
    failsAfter((db) => db.exec(`CREATE TRIGGER skip_loser BEFORE UPDATE ON places WHEN OLD.id = '${cuchilla.id}' BEGIN SELECT RAISE(IGNORE); END;`));
    failsAfter((db) => db.exec(`CREATE TRIGGER skip_survivor BEFORE UPDATE ON places WHEN OLD.id = '${cuchillas.id}' BEGIN SELECT RAISE(IGNORE); END;`));
  });

  it("fails the file when a place's owner changed after the read", () => {
    // A tenant claim sets tenant_id without moving updated_at.
    failsAfter((db) => db.prepare("UPDATE places SET tenant_id = 'tenant-a' WHERE id = ?").run(huachipa.id));
    failsAfter((db) => db.prepare("UPDATE places SET tenant_id = 'tenant-a' WHERE id = ?").run(guachipa.id));
  });

  it("journals stored NULL and empty-string values as they were, not as normalised", () => {
    // Guachipa stores NULL variants and '' for its tgn and precision; the
    // planner reads them as [] and empty, and the journal must keep them raw.
    const raw = (p: PlaceRow, over: Partial<StoredPlace>): PlaceRow => ({ ...p, stored: { ...storedOf(p), ...over } });
    const list = fixturePlaces.map((p) =>
      p === guachipa ? raw({ ...p, nameVariants: "[]" }, { name_variants: null, tgn_id: "", coordinate_precision: "" })
        : p === huachipa ? raw(p, { merged_into: "" })
        : p,
    );
    const rawPlan = planMerges(fixtureRows, index(list), []);
    expect(rawPlan.refusals).toEqual([]);
    const db = database();
    db.prepare("UPDATE places SET name_variants = NULL, tgn_id = '', coordinate_precision = '' WHERE id = ?").run(guachipa.id);
    db.prepare("UPDATE places SET merged_into = '' WHERE id = ?").run(huachipa.id);
    applyAsOneUnit(db, buildStatements(rawPlan, linksByPlace(fixtureLinks), opts).sql);
    const diffs = (db.prepare("SELECT record_id, diff FROM changelog WHERE kind = 'update' ORDER BY rowid").all() as any[])
      .map((r) => ({ id: r.record_id, diff: JSON.parse(r.diff) }));
    const fold = diffs.find((d) => d.id === guachipa.id && d.diff.nameVariants && !d.diff.label)!;
    expect(fold.diff.nameVariants.old).toBeNull();
    const relabel = diffs.find((d) => d.id === guachipa.id && d.diff.label)!;
    expect(relabel.diff).toMatchObject({ tgnId: { old: "", new: "1024512" }, coordinatePrecision: { old: "" } });
    expect(diffs.find((d) => d.id === huachipa.id)!.diff.mergedInto).toEqual({ old: "", new: guachipa.id });
  });

  it("reads and guards a stored NULL name_variants as []", () => {
    const bare: PlaceRow = { ...cuchillas, nameVariants: "[]" };
    bare.stored = { ...storedOf(bare), name_variants: null };
    const places = fixturePlaces.map((p) => (p.code === cuchillas.code ? bare : p));
    const nullPlan = planMerges(fixtureRows, index(places), []);
    const db = database();
    db.prepare("UPDATE places SET name_variants = NULL WHERE id = ?").run(cuchillas.id);
    applyAsOneUnit(db, buildStatements(nullPlan, linksByPlace(fixtureLinks), opts).sql);
    const row = db.prepare("SELECT name_variants FROM places WHERE id = ?").get(cuchillas.id) as { name_variants: string };
    expect(JSON.parse(row.name_variants)).toEqual(["Cuchilla", "La Cuchilla"]);
  });

  it("keeps every statement within the byte budget", () => {
    const built = buildStatements(plan, linksByPlace(fixtureLinks), opts);
    expect(Math.max(...built.sql.map((s) => Buffer.byteLength(s)))).toBeLessThanOrEqual(STATEMENT_BUDGET);
    expect(built.oversized).toEqual([]);
  });

  it("packs guards by size when links carry long role notes and places long variants, and the file applies", () => {
    // 100 loser links with 1,000-character role notes (two bytes a character)
    // and 60 places with 4,000-character variants: one fixed-count batch of
    // either would run past 100 KB.
    const note = "é".repeat(1000);
    const variants = JSON.stringify(["ñ".repeat(4000)]);
    const survivorsLong = Array.from({ length: 30 }, (_, i) => place(`nl-s${i}`, `S${i}`, { nameVariants: variants }));
    const losersLong = Array.from({ length: 30 }, (_, i) => place(`nl-l${i}`, `L${i}`, { nameVariants: variants }));
    const rows = losersLong.map((l, i) =>
      row({ ref: `B${i}`, survivorCode: `nl-s${i}`, loserCode: l.code, finalSurvivorCode: `nl-s${i}`, labelCurrent: `S${i}`, labelFinal: `S${i}` }),
    );
    const longPlan = planMerges(rows, index([...survivorsLong, ...losersLong]), []);
    const links: JunctionRow[] = Array.from({ length: 100 }, (_, i) => ({ ...link(`dp-${i}`, losersLong[i % 30].id, `d${i}`), roleNote: note }));
    const built = buildStatements(longPlan, linksByPlace(links), opts);
    const sizes = built.sql.map((s) => Buffer.byteLength(s));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(STATEMENT_BUDGET);
    expect(built.oversized).toEqual([]);
    expect(built.sql.filter((s) => s.includes("a link has changed since it was read")).length).toBeGreaterThan(1);
    expect(built.sql.filter((s) => s.includes("a place in the list has changed since it was read")).length).toBeGreaterThan(1);

    const db = new DatabaseSync(":memory:", D1_LIMITS);
    db.exec(DDL);
    const ins = db.prepare("INSERT INTO places (id, federation_id, place_code, label, display_name, name_variants, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)");
    for (const p of [...survivorsLong, ...losersLong]) ins.run(p.id, FED, p.code, p.label, p.displayName, p.nameVariants);
    const l = db.prepare("INSERT INTO description_places (id, description_id, place_id, role, role_note, created_at) VALUES (?, ?, ?, 'mentioned', ?, 1000)");
    for (const x of links) l.run(x.id, x.descriptionId, x.placeId as string, note);
    applyAsOneUnit(db, built.sql);
    expect(db.prepare("SELECT count(*) AS n FROM places WHERE merged_into IS NOT NULL").get()).toEqual({ n: 30 });
  });

  it("reports a statement no batching can bring under the budget", () => {
    // A survivor whose variants alone exceed the budget: its guard row and its
    // name fold cannot be split, so the command refuses the run.
    const huge = JSON.stringify(["x".repeat(STATEMENT_BUDGET)]);
    const list = fixturePlaces.map((p) => (p === cuchillas ? { ...p, nameVariants: huge } : p));
    const built = buildStatements(planMerges(fixtureRows, index(list), []), linksByPlace(fixtureLinks), opts);
    expect(built.oversized.length).toBeGreaterThan(0);
    expect(built.oversized.every((o) => o.bytes > STATEMENT_BUDGET)).toBe(true);
  });
});

describe("who merges, on a member workspace", () => {
  const plan = planMerges(fixtureRows, index(fixturePlaces), []);
  const opts = { userId: "user_001", now: 1_761_336_000_000, tenantId: "t-1" };
  const apply = (db: DatabaseSync, sql: string[]) => {
    db.exec("BEGIN");
    try {
      db.exec(sql.join("\n"));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
  const actingDb = () => {
    const db = database();
    seedActing(db);
    stewardMembership(db);
    return db;
  };

  it("writes acted_as lead-admin on every changelog row of the lead's admin's merges on a member", async () => {
    const db = actingDb();
    const acting = await resolveCommandActor(reader(db), "user_001", "ahr", { shared: true });
    const built = buildStatements(plan, linksByPlace(fixtureLinks), { ...opts, actedAs: acting.actedAs });
    apply(db, [...acting.guards, ...built.sql]);
    const rows = db.prepare("SELECT acted_as FROM changelog").all() as Array<{ acted_as: string | null }>;
    expect(rows.length).toBeGreaterThan(3);
    expect(new Set(rows.map((r) => r.acted_as))).toEqual(new Set(["lead-admin"]));
  });

  it("aborts the file when the basis changes between the plan and the apply", async () => {
    const db = actingDb();
    const acting = await resolveCommandActor(reader(db), "user_001", "ahr", { shared: true });
    const built = buildStatements(plan, linksByPlace(fixtureLinks), { ...opts, actedAs: acting.actedAs });
    db.exec("UPDATE users SET is_admin = 0 WHERE id = 'user_001'");
    expect(() => apply(db, [...acting.guards, ...built.sql])).toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM changelog").get()).toEqual({ n: 0 });
  });
});

// @version v0.9.0
